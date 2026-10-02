/**
 * Camera and microphone publish, remote subscribe attach, and End teardown.
 *
 * getUserMedia({ audio: true, video: true }) then publishTrack. LiveKit
 * setCameraEnabled(true) exact-matches deviceId "default", which Chrome
 * fake-AV often lacks for video.
 */

export interface StoppableTrack {
  stop: () => void;
  readyState?: string;
  detach?: () => unknown;
  mediaStreamTrack?: StoppableTrack | null;
  label?: string;
  kind?: string;
  source?: string;
  attach?: (element: HTMLMediaElement) => void;
}

export interface LiveKitPublication {
  track?: StoppableTrack | null;
  source?: string;
  setSubscribed?: (subscribed: boolean) => void;
}

export interface ReleasableRoom {
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

export interface DeviceListing {
  kind: string;
  label: string;
  deviceId: string;
}

export interface CapturedStream {
  getTracks(): StoppableTrack[];
  getAudioTracks(): StoppableTrack[];
  getVideoTracks(): StoppableTrack[];
}

export interface MediaDeviceSource {
  enumerateDevices(): Promise<DeviceListing[]>;
  getUserMedia(constraints: { audio: boolean; video: boolean }): Promise<CapturedStream>;
}

export interface TrackPublisher {
  publishTrack: (
    track: StoppableTrack,
    options: { source: "microphone" | "camera"; name: string },
  ) => Promise<{ track?: StoppableTrack | null }>;
}

export const NO_MEDIA_INPUTS =
  "No audio/video inputs. Allow a camera and microphone, or launch Chrome with --use-fake-device-for-media-stream.";

const LOCAL_VIDEO = '[data-livekit="local"]';
const REMOTE_VIDEO = '[data-livekit="remote"]';

export interface PublishRetry {
  /** Total tries per track, including the first. */
  attempts: number;
  /** Resolves when the room can take another publish. Rejects if the call ended. */
  beforeRetry(attempt: number, error: unknown): Promise<void>;
}

/**
 * Captures once and publishes the microphone, then the camera.
 *
 * A publish can be rejected while the room is still up: livekit-client
 * rejects in-flight publishes with "Cancelled publication by calling
 * unpublish" when it fully reconnects the signal connection. With `retry`, those tracks stay
 * live and are published again after the room reconnects. Tracks are stopped
 * only when the call ends or every retry fails.
 */
export async function publishLocalAv(input: {
  publisher: TrackPublisher;
  ownedTracks: StoppableTrack[];
  isCancelled: () => boolean;
  devices: MediaDeviceSource;
  retry?: PublishRetry;
}): Promise<void> {
  const listed = await input.devices.enumerateDevices();
  if (input.isCancelled()) return;
  const inputs = listed.filter((device) => device.kind === "audioinput" || device.kind === "videoinput");
  if (inputs.length === 0) throw new Error(NO_MEDIA_INPUTS);

  const stream = await input.devices.getUserMedia({ audio: true, video: true });
  const tracks = stream.getTracks();
  for (const track of tracks) input.ownedTracks.push(track);
  if (input.isCancelled()) {
    for (const track of tracks) stopTrack(track);
    return;
  }

  const publish = async (track: StoppableTrack, source: "microphone" | "camera") => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await input.publisher.publishTrack(track, { source, name: track.label || source });
      } catch (error) {
        if (input.isCancelled() || !input.retry || attempt >= input.retry.attempts) throw error;
        await input.retry.beforeRetry(attempt, error);
        if (input.isCancelled()) throw error;
      }
    }
  };

  try {
    for (const mediaTrack of stream.getAudioTracks()) {
      if (input.isCancelled()) break;
      await publish(mediaTrack, "microphone");
    }
    for (const mediaTrack of stream.getVideoTracks()) {
      if (input.isCancelled()) break;
      const publication = await publish(mediaTrack, "camera");
      if (publication.track && !input.isCancelled()) attachLocal(publication.track);
    }
  } catch (error) {
    for (const track of tracks) stopTrack(track);
    throw error;
  }
  if (input.isCancelled()) {
    for (const track of tracks) stopTrack(track);
  }
}

export function attachLocal(track: StoppableTrack): void {
  if (typeof document === "undefined") return;
  const element = document.querySelector<HTMLVideoElement>(LOCAL_VIDEO);
  if (!element || !track.attach) return;
  track.attach(element);
  element.muted = true;
  element.dataset.active = "true";
  void element.play().catch(() => undefined);
}

/** Attaches a remote camera or microphone. Screen share is left off the tile. */
export function attachRemote(track: StoppableTrack): void {
  if (typeof document === "undefined") return;
  if (track.source === "screen_share") return;
  if (track.kind !== "video" && track.kind !== "audio") return;
  const element = document.querySelector<HTMLVideoElement>(REMOTE_VIDEO);
  if (!element || !track.attach) return;
  track.attach(element);
  if (track.kind === "video") element.dataset.active = "true";
  if (track.kind === "audio") element.muted = false;
  void element.play().catch(() => undefined);
}

export async function releaseLiveKitRoom(room: ReleasableRoom, ownedTracks: StoppableTrack[]): Promise<void> {
  stopOwned(ownedTracks);

  for (const publication of [...room.localParticipant.trackPublications.values()]) {
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
    // Disconnect is idempotent.
  }
  try {
    room.removeAllListeners?.();
  } catch {
    // The emitter is already shut down.
  }

  stopOwned(ownedTracks);
  clearTiles();
}

export function clearTiles(): void {
  if (typeof document === "undefined") return;
  document.querySelectorAll<HTMLVideoElement>("[data-livekit]").forEach((element) => {
    if (element.src.startsWith("blob:")) {
      try {
        URL.revokeObjectURL(element.src);
      } catch {
        // The URL was already revoked.
      }
      element.removeAttribute("src");
    }
    element.srcObject = null;
    delete element.dataset.active;
  });
}

export function stopTrack(track: StoppableTrack | null | undefined): void {
  if (!track || track.readyState === "ended") return;
  try {
    track.stop();
  } catch {
    // The track already ended.
  }
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
