export interface CaptureVideoStillOptions {
  /** JPEG unless you need a lossless PNG. */
  mimeType?: "image/jpeg" | "image/png";
  /** JPEG quality from 0 to 1. Ignored for PNG. */
  quality?: number;
  /**
   * Playing element that already shows this track. The desk passes the remote
   * customer tile so the grab uses the frame the agent is looking at.
   */
  video?: HTMLVideoElement | null;
}

/** A raw camera track, or a LiveKit Track (local or remote) that wraps one. */
export type VideoStillSource = MediaStreamTrack | { mediaStreamTrack?: MediaStreamTrack | null; attachedElements?: HTMLMediaElement[] };

const FRAME_TIMEOUT_MS = 4000;

/**
 * Grab one still from a customer video track.
 *
 * Prefers a video element that is already playing the track (the remote tile,
 * or LiveKit's attachedElements). Otherwise attaches the track to a detached
 * element long enough to draw a single frame. Does not stop the track.
 */
export async function captureVideoStill(
  source: VideoStillSource,
  options: CaptureVideoStillOptions = {},
): Promise<Blob> {
  const track = resolveVideoTrack(source);
  if (track.kind !== "video") {
    throw new Error("Capture still needs a video track.");
  }
  if (track.readyState === "ended") {
    throw new Error("Customer video track has ended.");
  }

  const playing = playingElement(source, track, options.video);
  if (playing) {
    await waitForVideoFrame(playing);
    return blobFromVideo(playing, options);
  }

  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.autoplay = true;
  video.setAttribute("aria-hidden", "true");
  video.style.position = "fixed";
  video.style.left = "-9999px";
  video.style.width = "2px";
  video.style.height = "2px";
  video.srcObject = new MediaStream([track]);
  document.body.appendChild(video);
  try {
    await video.play();
    await waitForVideoFrame(video);
    return await blobFromVideo(video, options);
  } finally {
    video.pause();
    video.srcObject = null;
    video.remove();
  }
}

function resolveVideoTrack(source: VideoStillSource): MediaStreamTrack {
  if (typeof MediaStreamTrack !== "undefined" && source instanceof MediaStreamTrack) return source;
  if (source && typeof source === "object" && "mediaStreamTrack" in source && source.mediaStreamTrack) {
    return source.mediaStreamTrack;
  }
  throw new Error("No customer video track to capture.");
}

function playingElement(
  source: VideoStillSource,
  track: MediaStreamTrack,
  hinted: HTMLVideoElement | null | undefined,
): HTMLVideoElement | null {
  if (hinted && elementPlaysTrack(hinted, track)) return hinted;
  const attached =
    source && typeof source === "object" && "attachedElements" in source ? source.attachedElements : undefined;
  const fromTrack = attached?.find(
    (element): element is HTMLVideoElement => element instanceof HTMLVideoElement && elementPlaysTrack(element, track),
  );
  if (fromTrack) return fromTrack;
  return findPlayingElement(track);
}

function elementPlaysTrack(video: HTMLVideoElement, track: MediaStreamTrack): boolean {
  const src = video.srcObject;
  if (!(src instanceof MediaStream)) return false;
  return src.getVideoTracks().some((item) => item.id === track.id);
}

function findPlayingElement(track: MediaStreamTrack): HTMLVideoElement | null {
  const videos = document.querySelectorAll("video");
  for (const video of videos) {
    if (elementPlaysTrack(video, track)) return video;
  }
  return null;
}

function waitForVideoFrame(video: HTMLVideoElement): Promise<void> {
  if (hasFrame(video)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for a frame from the customer video."));
    }, FRAME_TIMEOUT_MS);

    const done = () => {
      if (!hasFrame(video)) return;
      cleanup();
      resolve();
    };

    const cleanup = () => {
      window.clearTimeout(timer);
      video.removeEventListener("loadeddata", done);
      video.removeEventListener("resize", done);
    };

    video.addEventListener("loadeddata", done);
    video.addEventListener("resize", done);
    if (typeof video.requestVideoFrameCallback === "function") {
      video.requestVideoFrameCallback(() => done());
    }
  });
}

function hasFrame(video: HTMLVideoElement): boolean {
  return video.videoWidth > 0 && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA;
}

function blobFromVideo(video: HTMLVideoElement, options: CaptureVideoStillOptions): Promise<Blob> {
  const width = video.videoWidth;
  const height = video.videoHeight;
  if (!width || !height) throw new Error("Customer video has no frame yet.");

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Could not draw the customer video frame.");
  context.drawImage(video, 0, 0, width, height);

  const mimeType = options.mimeType ?? "image/jpeg";
  const quality = clampQuality(options.quality);
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error("Could not encode the customer video frame."));
          return;
        }
        resolve(blob);
      },
      mimeType,
      quality,
    );
  });
}

function clampQuality(quality: number | undefined): number {
  if (quality === undefined || Number.isNaN(quality)) return 0.92;
  return Math.min(1, Math.max(0, quality));
}
