/**
 * Browser media teardown shared by the agent desk and the customer webview.
 *
 * LiveKit's Room.disconnect(true) stops tracks that are already published.
 * A getUserMedia track that is still being published, a fallback MediaRecorder,
 * and a blob: URL on a tile can all outlive that call. These helpers finish
 * that work and are safe to run twice.
 */

export interface StoppableTrack {
  stop: () => void;
  readyState?: string;
  detach?: () => unknown;
  mediaStreamTrack?: StoppableTrack | null;
}

export interface LiveKitPublication {
  track?: StoppableTrack | null;
  setSubscribed?: (subscribed: boolean) => void;
}

export interface LiveKitRoomRelease {
  localParticipant: {
    trackPublications: { values(): Iterable<LiveKitPublication> };
    unpublishTrack: (track: StoppableTrack, stopOnUnpublish?: boolean) => Promise<unknown>;
  };
  remoteParticipants: {
    values(): Iterable<{
      trackPublications: { values(): Iterable<LiveKitPublication> };
    }>;
  };
  disconnect: (stopTracks?: boolean) => Promise<void> | void;
  removeAllListeners?: () => void;
}

export interface LiveKitTileElement {
  src: string;
  srcObject: unknown;
  removeAttribute: (name: string) => void;
  dataset: { active?: string };
}

export interface FallbackRecorder {
  state: string;
  mimeType: string;
  stop: () => void;
  onstop: unknown;
  onerror: unknown;
}

export interface CallTape {
  stop: () => Promise<Blob>;
}

/**
 * While Cloud egress is down, the desk keeps one fallback recorder for the
 * whole call. A stopped recorder must be started again. End session sets
 * `ending` so the poll does not arm another recorder during upload.
 */
export function fallbackRecorderAction(input: {
  mode: string;
  mediaConnected: boolean;
  ending: boolean;
  recorderState: string | null;
}): "start" | "restart" | "keep" {
  if (input.ending || !input.mediaConnected || input.mode !== "fallback") return "keep";
  if (input.recorderState == null) return "start";
  if (input.recorderState === "recording" || input.recorderState === "paused") return "keep";
  return "restart";
}

/** Keep the larger fallback blob. A later 1–3s stub must not replace the call. */
export function selectLongerRecording<T extends { readonly size: number }>(current: T | null, next: T | null): T | null {
  if (!next || next.size <= 0) return current;
  if (!current || next.size > current.size) return next;
  return current;
}

export interface LiveKitReleaseGate {
  /** Resolves when every release scheduled so far has finished. */
  afterReleased: () => Promise<void>;
  schedule: (release: () => Promise<void>) => void;
}

export function createLiveKitReleaseGate(): LiveKitReleaseGate {
  let pending: Promise<void> = Promise.resolve();
  return {
    afterReleased: () => pending,
    schedule: (release) => {
      pending = pending.then(release, release).then(
        () => undefined,
        () => undefined,
      );
    },
  };
}

/** One gate per page, so the next Room.connect waits out the previous disconnect. */
const pageGate = createLiveKitReleaseGate();

export function afterLiveKitReleased(): Promise<void> {
  return pageGate.afterReleased();
}

export function scheduleLiveKitRelease(release: () => Promise<void>): void {
  pageGate.schedule(release);
}

export function stopTrack(track: StoppableTrack | null | undefined): void {
  if (!track || track.readyState === "ended") return;
  try {
    track.stop();
  } catch {
    // The track already ended.
  }
}

/**
 * Unpublish local camera and mic, unsubscribe remote tracks, detach every
 * element, stop owned getUserMedia tracks, disconnect, then drop listeners.
 * Tracks pushed onto `ownedTracks` while this is in flight are stopped too.
 */
export async function releaseLiveKitRoom(
  room: LiveKitRoomRelease,
  ownedTracks: StoppableTrack[],
): Promise<void> {
  stopOwned(ownedTracks);

  const locals = [...room.localParticipant.trackPublications.values()];
  for (const publication of locals) {
    detachTrack(publication.track);
    if (publication.track) {
      try {
        await room.localParticipant.unpublishTrack(publication.track, true);
      } catch {
        // Already unpublished, or the socket closed mid-publish.
      }
    }
    stopTrack(publication.track);
    stopNested(publication.track);
  }

  stopOwned(ownedTracks);

  for (const participant of room.remoteParticipants.values()) {
    for (const publication of participant.trackPublications.values()) {
      detachTrack(publication.track);
      try {
        publication.setSubscribed?.(false);
      } catch {
        // The subscription is already closed.
      }
    }
  }

  try {
    await room.disconnect(true);
  } catch {
    // Disconnect is idempotent; a failed socket should not keep the camera.
  }
  try {
    room.removeAllListeners?.();
  } catch {
    // The emitter is already shut down.
  }

  stopOwned(ownedTracks);
}

export function clearLiveKitTiles(
  elements: Iterable<LiveKitTileElement>,
  revokeObjectURL: (url: string) => void,
): void {
  for (const element of elements) {
    if (element.src.startsWith("blob:")) {
      try {
        revokeObjectURL(element.src);
      } catch {
        // The URL was already revoked.
      }
      element.removeAttribute("src");
    }
    element.srcObject = null;
    delete element.dataset.active;
  }
}

/**
 * Stop a fallback MediaRecorder, close its audio graph, and revoke blob: URLs.
 * A second stop returns the same blob and does not close or revoke again.
 */
export function createCallTape(options: {
  recorder: FallbackRecorder;
  chunks: Blob[];
  close: () => void;
  objectUrls?: readonly string[];
  revokeObjectURL?: (url: string) => void;
}): CallTape {
  const recorder = options.recorder as FallbackRecorder & {
    onstop: (() => void) | null;
    onerror: (() => void) | null;
  };
  let stopping: Promise<Blob> | null = null;
  let released = false;

  const releaseResources = () => {
    if (released) return;
    released = true;
    try {
      options.close();
    } catch {
      // The audio graph is already closed.
    }
    const revoke = options.revokeObjectURL;
    if (!revoke) return;
    for (const url of options.objectUrls ?? []) {
      if (!url.startsWith("blob:")) continue;
      try {
        revoke(url);
      } catch {
        // The URL was already revoked.
      }
    }
  };

  return {
    stop: () => {
      if (stopping) return stopping;
      const blobType = recorder.mimeType || "video/webm";
      stopping = new Promise((resolve, reject) => {
        const finish = () => {
          releaseResources();
          resolve(new Blob(options.chunks, { type: blobType }));
        };
        recorder.onerror = () => {
          releaseResources();
          reject(new Error("call recorder failed"));
        };
        recorder.onstop = finish;
        if (recorder.state === "inactive") {
          finish();
          return;
        }
        try {
          recorder.stop();
        } catch (error) {
          releaseResources();
          reject(error instanceof Error ? error : new Error("call recorder failed"));
        }
      });
      return stopping;
    },
  };
}

function detachTrack(track: StoppableTrack | null | undefined): void {
  if (!track?.detach) return;
  try {
    track.detach();
  } catch {
    // The element was already removed.
  }
}

function stopNested(track: StoppableTrack | null | undefined): void {
  const nested = track?.mediaStreamTrack;
  if (!nested || nested === track) return;
  stopTrack(nested);
}

function stopOwned(tracks: StoppableTrack[]): void {
  const seen = new Set<StoppableTrack>();
  for (let index = 0; index < tracks.length; index += 1) {
    const track = tracks[index];
    if (!track || seen.has(track)) continue;
    seen.add(track);
    stopTrack(track);
    stopNested(track);
  }
}
