import {
  attachRemote,
  publishLocalAv,
  releaseLiveKitRoom,
  type MediaDeviceSource,
  type ReleasableRoom,
  type StoppableTrack,
} from "./mediaSession";

/**
 * Connect, publish, and teardown for one call participant, independent of
 * livekit-client so the ordering can be tested.
 *
 * Both desks mint one identity per role (`agent`, `customer`). A second Room
 * for the same identity makes LiveKit drop the first one (duplicate
 * identity), which cancels any publish in flight on it. React Strict Mode and
 * fast remounts start a second session before the first is gone, so:
 *
 * - a session aborted before Room.connect never connects;
 * - aborting mid-connect disconnects right away;
 * - the next session on the page waits until the previous one has released.
 *
 * A publish rejected while the room reconnects is retried once the room is
 * connected again, so the camera and microphone are not dropped for the call.
 */

export interface MediaRoom extends ReleasableRoom {
  connect(serverUrl: string, token: string): Promise<void>;
  publish(track: StoppableTrack, source: "microphone" | "camera", name: string): Promise<{ track?: StoppableTrack | null }>;
  /** Camera and microphone tracks already subscribed. Screen share excluded. */
  remoteTracks(): StoppableTrack[];
  onRemoteTrack(listener: (track: StoppableTrack) => void): () => void;
  onDisconnected(listener: (reason: string) => void): () => void;
  /** Resolves once the room is connected (again). Rejects when `signal` aborts. */
  whenConnected(signal: AbortSignal): Promise<void>;
}

/** Tries per track before the desk reports that publish failed. */
export const PUBLISH_ATTEMPTS = 4;
const RETRY_BACKOFF_MS = 400;

export interface SessionLock {
  ready: Promise<void>;
  unlock(): void;
}

export interface SessionGate {
  acquire(): SessionLock;
}

/** Each session holds the lock until its room is released. */
export function createSessionGate(): SessionGate {
  let tail: Promise<void> = Promise.resolve();
  return {
    acquire() {
      const previous = tail;
      let unlock: () => void = () => undefined;
      const mine = new Promise<void>((resolve) => {
        unlock = resolve;
      });
      tail = previous.then(() => mine);
      let done = false;
      return {
        ready: previous,
        unlock() {
          if (done) return;
          done = true;
          unlock();
        },
      };
    },
  };
}

export interface MediaSessionInput {
  serverUrl: string;
  token: string;
  roomName: string;
  signal: AbortSignal;
  /** LiveKit dropped the room without End, for example a duplicate identity. */
  onUnexpectedDisconnect?: (reason: string) => void;
}

export interface MediaSessionDeps {
  createRoom(): Promise<MediaRoom>;
  devices: MediaDeviceSource;
  gate: SessionGate;
  log?: Pick<Console, "info" | "error" | "warn">;
  /** Backoff before a publish retry. Tests pass 0. */
  retryBackoffMs?: number;
}

export interface MediaSession {
  room: MediaRoom;
  publishError: string | null;
  disconnect(): Promise<void>;
}

export function abortError(): DOMException {
  return new DOMException("The call ended before media connected.", "AbortError");
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export async function startMediaSession(input: MediaSessionInput, deps: MediaSessionDeps): Promise<MediaSession> {
  const log = deps.log ?? console;
  const lock = deps.gate.acquire();
  await lock.ready;
  if (input.signal.aborted) {
    lock.unlock();
    throw abortError();
  }

  let room: MediaRoom;
  try {
    room = await deps.createRoom();
  } catch (error) {
    lock.unlock();
    throw error;
  }
  if (input.signal.aborted) {
    lock.unlock();
    throw abortError();
  }

  const ownedTracks: StoppableTrack[] = [];
  const stopListening: Array<() => void> = [];
  const ended = new AbortController();
  let released: Promise<void> | null = null;
  let droppedReason: string | null = null;

  const release = (): Promise<void> => {
    if (released) return released;
    ended.abort();
    released = (async () => {
      input.signal.removeEventListener("abort", onAbort);
      for (const off of stopListening.splice(0)) off();
      try {
        await releaseLiveKitRoom(room, ownedTracks);
      } finally {
        lock.unlock();
      }
    })();
    return released;
  };
  const onAbort = () => {
    void release();
  };
  input.signal.addEventListener("abort", onAbort);

  stopListening.push(
    room.onDisconnected((reason) => {
      if (released) return;
      droppedReason = reason;
      log.error(`[vkyc] LiveKit room ${input.roomName} disconnected: ${reason}`);
      input.onUnexpectedDisconnect?.(reason);
      void release();
    }),
  );

  const isCancelled = () => released !== null || input.signal.aborted;
  const cancelled = () =>
    droppedReason !== null && !input.signal.aborted ? new Error(`LiveKit disconnected (${droppedReason}).`) : abortError();

  try {
    log.info(`[vkyc] Room.connect ${input.roomName}`);
    await room.connect(input.serverUrl, input.token);
    if (isCancelled()) throw cancelled();

    stopListening.push(
      room.onRemoteTrack((track) => {
        if (!isCancelled()) attachRemote(track);
      }),
    );

    const backoffMs = deps.retryBackoffMs ?? RETRY_BACKOFF_MS;
    let publishError: string | null = null;
    try {
      await publishLocalAv({
        publisher: {
          publishTrack: (track, options) => room.publish(track, options.source, options.name),
        },
        ownedTracks,
        isCancelled,
        devices: deps.devices,
        retry: {
          attempts: PUBLISH_ATTEMPTS,
          async beforeRetry(attempt, error) {
            const message = error instanceof Error ? error.message : String(error);
            log.warn(`[vkyc] publish retry ${attempt + 1}/${PUBLISH_ATTEMPTS} on ${input.roomName}: ${message}`);
            await sleep(backoffMs * attempt, ended.signal);
            await room.whenConnected(ended.signal);
          },
        },
      });
    } catch (error) {
      if (isCancelled()) throw cancelled();
      publishError = error instanceof Error ? error.message : "Camera and microphone publish failed";
      log.error("[vkyc] local A/V publish failed", error);
    }

    if (isCancelled()) throw cancelled();
    for (const track of room.remoteTracks()) attachRemote(track);

    return { room, publishError, disconnect: release };
  } catch (error) {
    await release();
    if (input.signal.aborted) throw abortError();
    throw error;
  }
}
