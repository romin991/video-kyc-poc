/**
 * Browser media connect helpers shared by the Next agent and customer apps.
 *
 * Matches the Vite call: getUserMedia({ audio: true, video: true }) then
 * publishTrack. LiveKit setCameraEnabled(true) exact-matches deviceId
 * "default", which Chrome fake-AV often lacks for video.
 *
 * Teardown unpublishes, unsubscribes, stops owned tracks (including a
 * getUserMedia that has not finished publishing), disconnects, and revokes
 * blob: URLs. It is safe to run twice.
 */

export interface StoppableTrack {
  stop: () => void;
  readyState?: string;
  detach?: () => unknown;
  mediaStreamTrack?: StoppableTrack | null;
  label?: string;
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

export interface PublishedTrack {
  attach?: (element: HTMLMediaElement) => void;
}

export interface TrackPublisher {
  publishTrack: (
    track: StoppableTrack,
    options: { source: "microphone" | "camera"; name: string },
  ) => Promise<{ track?: PublishedTrack | null }>;
}

export const NO_MEDIA_INPUTS =
  "No audio/video inputs. Allow a camera and microphone, or launch Chrome with --use-fake-device-for-media-stream.";

export function roomNameFor(sessionId: string): string {
  return `vkyc-${sessionId}`;
}

export function isJoinableToken(token: string): boolean {
  const parts = token.split(".");
  return parts.length === 3 && parts.every((part) => part.length > 0);
}

export interface LiveKitReleaseGate {
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

export async function publishLocalAv(input: {
  publisher: TrackPublisher;
  ownedTracks: StoppableTrack[];
  isCancelled: () => boolean;
  devices: MediaDeviceSource;
  onCameraPublished?: (track: PublishedTrack) => void;
  logDevices?: (devices: DeviceListing[]) => void;
}): Promise<void> {
  const listed = await input.devices.enumerateDevices();
  if (input.isCancelled()) return;
  const inputs = listed.filter((device) => device.kind === "audioinput" || device.kind === "videoinput");
  input.logDevices?.(
    inputs.map((device) => ({
      kind: device.kind,
      label: device.label || "(empty)",
      deviceId: device.deviceId.slice(0, 12),
    })),
  );
  if (inputs.length === 0) {
    throw new Error(NO_MEDIA_INPUTS);
  }

  const stream = await input.devices.getUserMedia({ audio: true, video: true });
  const tracks = stream.getTracks();
  for (const track of tracks) input.ownedTracks.push(track);
  if (input.isCancelled()) {
    for (const track of tracks) stopTrack(track);
    return;
  }

  try {
    for (const mediaTrack of stream.getAudioTracks()) {
      if (input.isCancelled()) break;
      await input.publisher.publishTrack(mediaTrack, {
        source: "microphone",
        name: mediaTrack.label || "microphone",
      });
    }
    for (const mediaTrack of stream.getVideoTracks()) {
      if (input.isCancelled()) break;
      const publication = await input.publisher.publishTrack(mediaTrack, {
        source: "camera",
        name: mediaTrack.label || "camera",
      });
      if (publication.track && !input.isCancelled()) input.onCameraPublished?.(publication.track);
    }
  } catch (error) {
    for (const track of tracks) stopTrack(track);
    throw error;
  }
  if (input.isCancelled()) {
    for (const track of tracks) stopTrack(track);
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
