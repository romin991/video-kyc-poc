import assert from "node:assert/strict";
import test from "node:test";
import type { StoppableTrack } from "./mediaSession";
import { PUBLISH_ATTEMPTS, createSessionGate, startMediaSession, type MediaRoom } from "./roomSession";

const quiet = { info: () => undefined, error: () => undefined, warn: () => undefined };

interface FakeRoom extends MediaRoom {
  connects: number;
  disconnects: number;
  publishAttempts: number;
  published: string[];
  publishedTracks: StoppableTrack[];
  finishConnect(): void;
  dropFromServer(reason: string): void;
}

interface FakeRoomOptions {
  manualConnect?: boolean;
  /**
   * The first N publishes are rejected the way livekit-client does when it
   * fully reconnects mid-publish. The room is reconnecting for a moment and
   * then connected again.
   */
  reconnectDuringPublishes?: number;
}

/**
 * One LiveKit identity per role: a second connect in the same room kicks the
 * first, as LiveKit Cloud does with DUPLICATE_IDENTITY.
 */
function fakeServer() {
  const joined: FakeRoom[] = [];
  const created: FakeRoom[] = [];

  function createRoom(options: FakeRoomOptions = {}): FakeRoom {
    const publications = new Map<string, { track: StoppableTrack }>();
    let disconnectListener: ((reason: string) => void) | null = null;
    let pendingConnect: (() => void) | null = null;
    let connected = false;
    let reconnecting = false;
    let reconnectsLeft = options.reconnectDuringPublishes ?? 0;
    const waiters: Array<() => void> = [];
    let pendingPublish: { reject: (error: Error) => void } | null = null;

    const kick = (reason: string) => {
      if (!connected) return;
      connected = false;
      pendingPublish?.reject(new Error("Cancelled publication by calling unpublish"));
      disconnectListener?.(reason);
    };

    const room: FakeRoom = {
      connects: 0,
      disconnects: 0,
      publishAttempts: 0,
      published: [],
      publishedTracks: [],
      localParticipant: {
        trackPublications: publications,
        unpublishTrack: async (track) => {
          for (const [key, publication] of publications) {
            if (publication.track === track) publications.delete(key);
          }
        },
      },
      remoteParticipants: new Map(),
      async disconnect() {
        room.disconnects += 1;
        connected = false;
        pendingConnect?.();
        pendingConnect = null;
      },
      removeAllListeners() {
        disconnectListener = null;
      },
      connect() {
        room.connects += 1;
        const join = () => {
          for (const other of joined.splice(0)) other.dropFromServer("DUPLICATE_IDENTITY");
          connected = true;
          joined.push(room);
        };
        if (!options.manualConnect) {
          join();
          return Promise.resolve();
        }
        return new Promise<void>((resolve) => {
          pendingConnect = () => resolve();
          room.finishConnect = () => {
            pendingConnect = null;
            join();
            resolve();
          };
        });
      },
      async publish(track, source) {
        room.publishAttempts += 1;
        if (!connected || reconnecting) throw new Error("publishing rejected as engine not connected");
        if (reconnectsLeft > 0) {
          reconnectsLeft -= 1;
          reconnecting = true;
          setTimeout(() => {
            reconnecting = false;
            for (const resolve of waiters.splice(0)) resolve();
          }, 10);
          throw new Error("Cancelled publication by calling unpublish");
        }
        await new Promise<void>((resolve, reject) => {
          pendingPublish = { reject };
          setTimeout(() => {
            pendingPublish = null;
            resolve();
          }, 5);
        });
        room.published.push(source);
        room.publishedTracks.push(track);
        publications.set(source, { track });
        return { track };
      },
      remoteTracks: () => [],
      onRemoteTrack: () => () => undefined,
      onDisconnected(listener) {
        disconnectListener = listener;
        return () => {
          disconnectListener = null;
        };
      },
      whenConnected(signal) {
        return new Promise<void>((resolve, reject) => {
          const onAbort = () => reject(new DOMException("The call ended.", "AbortError"));
          if (signal.aborted) return onAbort();
          if (connected && !reconnecting) return resolve();
          signal.addEventListener("abort", onAbort, { once: true });
          waiters.push(() => {
            signal.removeEventListener("abort", onAbort);
            resolve();
          });
        });
      },
      finishConnect: () => undefined,
      dropFromServer: (reason) => kick(reason),
    };
    created.push(room);
    return room;
  }

  return { createRoom, created, joined };
}

function devices() {
  const made: StoppableTrack[] = [];
  return {
    made,
    source: {
      enumerateDevices: async () => [
        { kind: "audioinput", label: "Fake mic", deviceId: "mic-1" },
        { kind: "videoinput", label: "Fake cam", deviceId: "cam-1" },
      ],
      getUserMedia: async () => {
        const mic = liveTrack("audio", "Fake mic");
        const cam = liveTrack("video", "Fake cam");
        made.push(mic, cam);
        return {
          getTracks: () => [mic, cam],
          getAudioTracks: () => [mic],
          getVideoTracks: () => [cam],
        };
      },
    },
  };
}

function liveTrack(kind: "audio" | "video", label: string): StoppableTrack {
  const track: StoppableTrack = {
    kind,
    label,
    readyState: "live",
    stop() {
      track.readyState = "ended";
    },
  };
  return track;
}

const input = (signal: AbortSignal, onUnexpectedDisconnect?: (reason: string) => void) => ({
  serverUrl: "wss://example.livekit.cloud",
  token: "a.b.c",
  roomName: "vkyc-daaaccaf",
  signal,
  onUnexpectedDisconnect,
});

test("Strict Mode remount: the aborted first mount never connects and the second publishes", async () => {
  const server = fakeServer();
  const gate = createSessionGate();
  const media = devices();
  const deps = { gate, devices: media.source, createRoom: async () => server.createRoom(), log: quiet };

  const first = new AbortController();
  const firstRun = startMediaSession(input(first.signal), deps);
  first.abort();
  const second = new AbortController();
  const drops: string[] = [];
  const secondRun = startMediaSession(input(second.signal, (reason) => drops.push(reason)), deps);

  await assert.rejects(firstRun, { name: "AbortError" });
  const session = await secondRun;

  assert.equal(server.created.length, 1);
  assert.equal(server.created[0]?.connects, 1);
  assert.deepEqual(session.room === server.created[0], true);
  assert.deepEqual(server.created[0]?.published, ["microphone", "camera"]);
  assert.equal(session.publishError, null);
  assert.deepEqual(drops, []);
  assert.ok(media.made.every((track) => track.readyState === "live"));

  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(drops, [], "the live room stays connected for the call");

  second.abort();
  await session.disconnect();
  assert.ok(media.made.every((track) => track.readyState === "ended"));
});

test("a mount aborted mid-connect releases before the next Room.connect starts", async () => {
  const server = fakeServer();
  const gate = createSessionGate();
  const media = devices();
  let manual = true;
  const deps = {
    gate,
    devices: media.source,
    createRoom: async () => {
      const room = server.createRoom({ manualConnect: manual });
      manual = false;
      return room;
    },
    log: quiet,
  };

  const first = new AbortController();
  const firstRun = startMediaSession(input(first.signal), deps);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(server.created[0]?.connects, 1, "first connect is in flight");

  first.abort();
  const second = new AbortController();
  const drops: string[] = [];
  const secondRun = startMediaSession(input(second.signal, (reason) => drops.push(reason)), deps);

  await assert.rejects(firstRun, { name: "AbortError" });
  const session = await secondRun;

  assert.equal(server.created[0]?.disconnects, 1);
  assert.deepEqual(server.created[0]?.published, []);
  assert.deepEqual(server.created[1]?.published, ["microphone", "camera"]);
  assert.equal(session.publishError, null);
  assert.deepEqual(drops, []);
  second.abort();
  await session.disconnect();
});

test("a duplicate-identity kick mid-publish is reported as a disconnect, not a cancel", async () => {
  const server = fakeServer();
  const media = devices();
  let manual = true;
  const ungated = () => ({
    gate: createSessionGate(),
    devices: media.source,
    createRoom: async () => {
      const room = server.createRoom({ manualConnect: manual });
      manual = false;
      return room;
    },
    log: quiet,
  });

  // The pre-fix desk: a stale Room that was never aborted joins after the live one.
  const staleRun = startMediaSession(input(new AbortController().signal), ungated());
  await new Promise((resolve) => setTimeout(resolve, 0));
  const live = new AbortController();
  const drops: string[] = [];
  const liveRun = startMediaSession(input(live.signal, (reason) => drops.push(reason)), ungated());
  await new Promise((resolve) => setTimeout(resolve, 1));
  server.created[0]?.finishConnect();

  await assert.rejects(liveRun, (error: Error) => {
    assert.notEqual(error.name, "AbortError");
    assert.match(error.message, /DUPLICATE_IDENTITY/);
    return true;
  });
  assert.deepEqual(drops, ["DUPLICATE_IDENTITY"]);
  assert.deepEqual(server.created[1]?.published, [], "the live room lost its publish");
  const staleSession = await staleRun;
  await staleSession.disconnect();
});

test("End stops local tracks and disconnects once", async () => {
  const server = fakeServer();
  const media = devices();
  const abort = new AbortController();
  const session = await startMediaSession(input(abort.signal), {
    gate: createSessionGate(),
    devices: media.source,
    createRoom: async () => server.createRoom(),
    log: quiet,
  });

  abort.abort();
  await session.disconnect();
  await session.disconnect();

  assert.equal(server.created[0]?.disconnects, 1);
  assert.ok(media.made.length === 2);
  assert.ok(media.made.every((track) => track.readyState === "ended"));
});

test("QA daaaccaf: a publish cancelled by a reconnect is retried and the camera stays live", async () => {
  const server = fakeServer();
  const media = devices();
  const abort = new AbortController();
  const session = await startMediaSession(input(abort.signal), {
    gate: createSessionGate(),
    devices: media.source,
    createRoom: async () => server.createRoom({ reconnectDuringPublishes: 1 }),
    log: quiet,
    retryBackoffMs: 0,
  });

  const room = server.created[0]!;
  assert.equal(session.publishError, null);
  assert.deepEqual(room.published, ["microphone", "camera"]);
  assert.equal(room.publishAttempts, 3, "microphone retried once, then camera");
  assert.ok(media.made.every((track) => track.readyState === "live"), "captured tracks were not stopped");

  abort.abort();
  await session.disconnect();
  assert.ok(media.made.every((track) => track.readyState === "ended"));
});

test("a reconnect on both tracks is retried for each", async () => {
  const server = fakeServer();
  const media = devices();
  const abort = new AbortController();
  let reconnectBeforeCamera = true;
  const session = await startMediaSession(input(abort.signal), {
    gate: createSessionGate(),
    devices: media.source,
    createRoom: async () => {
      const room = server.createRoom({ reconnectDuringPublishes: 1 });
      const publish = room.publish.bind(room);
      room.publish = async (track, source, name) => {
        if (source === "camera" && reconnectBeforeCamera) {
          reconnectBeforeCamera = false;
          throw new Error("Cancelled publication by calling unpublish");
        }
        return publish(track, source, name);
      };
      return room;
    },
    log: quiet,
    retryBackoffMs: 0,
  });
  assert.equal(session.publishError, null);
  assert.deepEqual(server.created[0]?.published, ["microphone", "camera"]);
  abort.abort();
  await session.disconnect();
});

test("publish gives up after the retry budget and stops the tracks", async () => {
  const server = fakeServer();
  const media = devices();
  const abort = new AbortController();
  const session = await startMediaSession(input(abort.signal), {
    gate: createSessionGate(),
    devices: media.source,
    createRoom: async () => server.createRoom({ reconnectDuringPublishes: 99 }),
    log: quiet,
    retryBackoffMs: 0,
  });
  assert.equal(session.publishError, "Cancelled publication by calling unpublish");
  assert.equal(server.created[0]?.publishAttempts, PUBLISH_ATTEMPTS);
  assert.ok(media.made.every((track) => track.readyState === "ended"));
  abort.abort();
  await session.disconnect();
});

test("End while a publish retry waits stops the tracks and does not publish again", async () => {
  const server = fakeServer();
  const media = devices();
  const abort = new AbortController();
  const run = startMediaSession(input(abort.signal), {
    gate: createSessionGate(),
    devices: media.source,
    createRoom: async () => server.createRoom({ reconnectDuringPublishes: 1 }),
    log: quiet,
    retryBackoffMs: 50,
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const attemptsAtEnd = server.created[0]?.publishAttempts;
  abort.abort();

  await assert.rejects(run, { name: "AbortError" });
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(server.created[0]?.publishAttempts, attemptsAtEnd);
  assert.deepEqual(server.created[0]?.published, []);
  assert.equal(server.created[0]?.disconnects, 1);
  assert.ok(media.made.every((track) => track.readyState === "ended"));
});

test("a failed getUserMedia on a live mount is a publish error, not a cancel", async () => {
  const server = fakeServer();
  const abort = new AbortController();
  const session = await startMediaSession(input(abort.signal), {
    gate: createSessionGate(),
    devices: {
      enumerateDevices: async () => [{ kind: "videoinput", label: "cam", deviceId: "cam" }],
      getUserMedia: async () => {
        throw new DOMException("Device busy", "AbortError");
      },
    },
    createRoom: async () => server.createRoom(),
    log: quiet,
  });
  assert.equal(session.publishError, "Device busy");
  abort.abort();
  await session.disconnect();
});
