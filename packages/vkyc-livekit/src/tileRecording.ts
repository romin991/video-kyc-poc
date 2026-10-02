import { createCallTape, type CallTape } from "./callTape";

const REMOTE_TILE = '[data-livekit="remote"]';
const LOCAL_TILE = '[data-livekit="local"]';
const VIDEO_BITS_PER_SECOND = 450_000;
const AUDIO_BITS_PER_SECOND = 64_000;

export interface RunningTape {
  stop: () => Promise<Blob>;
  state: () => string;
  rebind: () => void;
}

interface OwnedStream {
  stream: MediaStream;
  rebind: () => void;
  close: () => void;
}

/**
 * Records the customer tile plus both microphones.
 * The recorded stream is one the desk owns, so a LiveKit track swap does
 * not stop MediaRecorder. The original tracks stay up until the room releases.
 */
export function startTileRecording(): RunningTape | null {
  if (typeof document === "undefined") return null;
  const remote = document.querySelector<HTMLVideoElement>(REMOTE_TILE);
  const remoteStream = mediaStreamOf(remote);
  const liveVideo = remoteStream?.getVideoTracks().some((track) => track.readyState !== "ended") === true;
  if (!remote || !remoteStream || !liveVideo) return null;

  const owned = openOwnedStream(remote) ?? openDirectStream(remoteStream);
  if (!owned) return null;

  try {
    const recorder = openRecorder(owned.stream);
    const chunks: Blob[] = [];
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };
    owned.rebind();
    recorder.start(1000);
    const tape: CallTape = createCallTape({
      recorder,
      chunks,
      close: () => {
        recorder.ondataavailable = null;
        owned.close();
      },
    });
    return {
      stop: () => tape.stop(),
      state: () => recorder.state,
      rebind: () => owned.rebind(),
    };
  } catch (error) {
    owned.close();
    console.error("[vkyc] browser call recorder failed to start", error);
    return null;
  }
}

function openOwnedStream(remote: HTMLVideoElement): OwnedStream | null {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context || typeof canvas.captureStream !== "function") return null;

  const size = frameSize(remote);
  canvas.width = size.width;
  canvas.height = size.height;
  canvas.setAttribute("aria-hidden", "true");
  canvas.style.cssText = "position:fixed;left:-10000px;top:0;pointer-events:none";
  document.body.appendChild(canvas);
  drawTile(context, canvas);

  let canvasStream: MediaStream;
  try {
    canvasStream = canvas.captureStream(15);
  } catch (error) {
    canvas.remove();
    console.error("[vkyc] canvas capture failed", error);
    return null;
  }
  const videoTrack = canvasStream.getVideoTracks()[0];
  if (!videoTrack) {
    canvas.remove();
    return null;
  }

  const mix = openAudioMix();
  const tracks = mix ? [videoTrack, mix.track] : [videoTrack];
  let closed = false;

  const paint = () => {
    if (closed) return;
    drawTile(context, canvas);
    mix?.rebind();
  };
  // A timer keeps frames moving if the desk tab is in the background, where
  // requestAnimationFrame is paused and the canvas track would stay muted.
  const timer = window.setInterval(paint, 66);
  paint();

  return {
    stream: new MediaStream(tracks),
    rebind: () => {
      mix?.rebind();
    },
    close: () => {
      if (closed) return;
      closed = true;
      window.clearInterval(timer);
      canvas.remove();
      mix?.close();
      try {
        videoTrack.stop();
      } catch {
        // The canvas track already ended.
      }
    },
  };
}

function drawTile(context: CanvasRenderingContext2D, canvas: HTMLCanvasElement): void {
  const video = document.querySelector<HTMLVideoElement>(REMOTE_TILE);
  if (!video || video.videoWidth < 2 || video.videoHeight < 2) return;
  const scale = Math.min(canvas.width / video.videoWidth, canvas.height / video.videoHeight);
  const width = video.videoWidth * scale;
  const height = video.videoHeight * scale;
  const x = (canvas.width - width) / 2;
  const y = (canvas.height - height) / 2;
  context.fillStyle = "#000";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(video, x, y, width, height);
}

function frameSize(video: HTMLVideoElement): { width: number; height: number } {
  const stream = mediaStreamOf(video);
  const track = stream?.getVideoTracks().find((item) => item.readyState !== "ended");
  const settings = track?.getSettings() ?? {};
  const width = video.videoWidth || settings.width || 720;
  const height = video.videoHeight || settings.height || 1280;
  return { width: even(width), height: even(height) };
}

function even(value: number): number {
  const rounded = Math.max(2, Math.round(value));
  return rounded % 2 === 0 ? rounded : rounded - 1;
}

function openDirectStream(remoteStream: MediaStream): OwnedStream | null {
  const video = remoteStream.getVideoTracks().find((track) => track.readyState !== "ended");
  if (!video) return null;
  const cloned = video.clone();
  const mix = openAudioMix();
  return {
    stream: new MediaStream(mix ? [cloned, mix.track] : [cloned]),
    rebind: () => {
      mix?.rebind();
    },
    close: () => {
      mix?.close();
      try {
        cloned.stop();
      } catch {
        // The cloned customer track already ended.
      }
    },
  };
}

function openAudioMix(): { track: MediaStreamTrack; rebind: () => void; close: () => void } | null {
  try {
    const context = new AudioContext();
    void context.resume().catch(() => undefined);
    if (context.state === "suspended") {
      void context.close().catch(() => undefined);
      console.error("[vkyc] call audio mix is blocked; recording the customer tile only");
      return null;
    }
    const destination = context.createMediaStreamDestination();
    // A silent clock keeps the mix track producing samples. With no source,
    // MediaRecorder stays "recording" but writes an empty webm.
    const silence = context.createGain();
    silence.gain.value = 0;
    const clock = context.createOscillator();
    clock.connect(silence);
    silence.connect(destination);
    clock.start();
    const connected = new Map<string, MediaStreamAudioSourceNode>();
    let signature = "";
    let closed = false;
    const track = destination.stream.getAudioTracks()[0];
    if (!track) {
      try {
        clock.stop();
      } catch {
        // The silent clock already stopped.
      }
      void context.close().catch(() => undefined);
      return null;
    }

    const rebind = () => {
      if (closed || context.state === "closed") return;
      void context.resume().catch(() => undefined);
      const live = liveAudioTracks();
      const next = live.map((item) => item.key).join("|");
      if (next === signature) return;
      signature = next;
      for (const node of connected.values()) {
        try {
          node.disconnect();
        } catch {
          // The node is already disconnected.
        }
      }
      connected.clear();
      for (const item of live) {
        try {
          const node = context.createMediaStreamSource(new MediaStream([item.track]));
          node.connect(destination);
          connected.set(item.key, node);
        } catch (error) {
          console.error("[vkyc] call audio mix skipped a track", error);
        }
      }
    };

    return {
      track,
      rebind,
      close: () => {
        if (closed) return;
        closed = true;
        signature = "\0";
        for (const node of connected.values()) {
          try {
            node.disconnect();
          } catch {
            // The node is already disconnected.
          }
        }
        connected.clear();
        try {
          clock.stop();
        } catch {
          // The silent clock already stopped.
        }
        try {
          track.stop();
        } catch {
          // The mix track already ended.
        }
        void context.close().catch(() => undefined);
      },
    };
  } catch (error) {
    console.error("[vkyc] call audio mix failed; recording the customer tile only", error);
    return null;
  }
}

function liveAudioTracks(): Array<{ key: string; track: MediaStreamTrack }> {
  const found: Array<{ key: string; track: MediaStreamTrack }> = [];
  for (const source of ["remote", "local"] as const) {
    const stream = mediaStreamOf(document.querySelector<HTMLVideoElement>(source === "remote" ? REMOTE_TILE : LOCAL_TILE));
    if (!stream) continue;
    for (const track of stream.getAudioTracks()) {
      if (track.readyState !== "live") continue;
      found.push({ key: `${source}:${track.id}`, track });
    }
  }
  return found;
}

function mediaStreamOf(element: HTMLVideoElement | null): MediaStream | null {
  return element?.srcObject instanceof MediaStream ? element.srcObject : null;
}

function openRecorder(stream: MediaStream): MediaRecorder {
  const mimeType = pickMime();
  const rated: MediaRecorderOptions = {
    videoBitsPerSecond: VIDEO_BITS_PER_SECOND,
    audioBitsPerSecond: AUDIO_BITS_PER_SECOND,
  };
  if (mimeType) rated.mimeType = mimeType;
  try {
    return new MediaRecorder(stream, rated);
  } catch {
    // This browser rejected the bitrate or the mime type.
  }
  if (mimeType) {
    try {
      return new MediaRecorder(stream, { mimeType });
    } catch {
      // Fall through to the default type.
    }
  }
  return new MediaRecorder(stream);
}

function pickMime(): string | undefined {
  if (typeof MediaRecorder === "undefined" || typeof MediaRecorder.isTypeSupported !== "function") return undefined;
  if (MediaRecorder.isTypeSupported("video/webm;codecs=vp8,opus")) return "video/webm;codecs=vp8,opus";
  if (MediaRecorder.isTypeSupported("video/webm")) return "video/webm";
  return undefined;
}
