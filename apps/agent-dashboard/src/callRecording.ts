import { useEffect, useRef, useState } from "react";
import { getCallRecording, uploadCallRecording, type CallRecordingMode } from "./api";

export interface CallTape {
  stop: () => Promise<Blob>;
}

/**
 * Records the customer tile plus both microphones when Cloud egress cannot
 * start. The original LiveKit tracks are left running.
 */
export function startTileRecording(): CallTape | null {
  const remote = document.querySelector<HTMLVideoElement>('[data-livekit="remote"]');
  const local = document.querySelector<HTMLVideoElement>('[data-livekit="local"]');
  const remoteStream = remote?.srcObject instanceof MediaStream ? remote.srcObject : null;
  if (!remoteStream || remoteStream.getVideoTracks().length === 0) return null;
  const localStream = local?.srcObject instanceof MediaStream ? local.srcObject : null;

  let closeMix: () => void = () => undefined;
  let stream = remoteStream;
  try {
    const mixed = mixCallAudio(remoteStream, localStream);
    stream = mixed.stream;
    closeMix = mixed.close;
  } catch (error) {
    console.error("[vkyc] call audio mix failed; recording the customer tile only", error);
  }

  try {
    const mimeType = pickMime();
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    const chunks: Blob[] = [];
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };
    recorder.start(1000);
    return {
      stop: () =>
        new Promise((resolve, reject) => {
          recorder.onerror = () => {
            closeMix();
            reject(new Error("call recorder failed"));
          };
          recorder.onstop = () => {
            closeMix();
            resolve(new Blob(chunks, { type: recorder.mimeType || "video/webm" }));
          };
          if (recorder.state === "inactive") {
            closeMix();
            resolve(new Blob(chunks, { type: "video/webm" }));
            return;
          }
          recorder.stop();
        }),
    };
  } catch (error) {
    closeMix();
    console.error("[vkyc] browser call recorder failed to start", error);
    return null;
  }
}

function mixCallAudio(
  remote: MediaStream,
  local: MediaStream | null,
): { stream: MediaStream; close: () => void } {
  const audioSources = [remote, local].filter((item): item is MediaStream => item !== null && item.getAudioTracks().length > 0);
  const video = remote.getVideoTracks()[0];
  if (!video || audioSources.length < 2) {
    return { stream: remote, close: () => undefined };
  }
  const context = new AudioContext();
  void context.resume().catch(() => undefined);
  const destination = context.createMediaStreamDestination();
  const nodes = audioSources.map((source) => {
    const node = context.createMediaStreamSource(source);
    node.connect(destination);
    return node;
  });
  const stream = new MediaStream([video, ...destination.stream.getAudioTracks()]);
  return {
    stream,
    close: () => {
      nodes.forEach((node) => node.disconnect());
      void context.close().catch(() => undefined);
    },
  };
}

function pickMime(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  if (MediaRecorder.isTypeSupported("video/webm;codecs=vp8,opus")) return "video/webm;codecs=vp8,opus";
  if (MediaRecorder.isTypeSupported("video/webm")) return "video/webm";
  return undefined;
}

export function useCallRecording(sessionId: string | null, agentName: string, mediaConnected: boolean): {
  mode: CallRecordingMode | "unknown";
  stopAndUpload: (endingSessionId: string) => Promise<void>;
} {
  const [mode, setMode] = useState<CallRecordingMode | "unknown">("unknown");
  const tape = useRef<CallTape | null>(null);
  const sessionRef = useRef(sessionId);
  const agentRef = useRef(agentName);
  sessionRef.current = sessionId;
  agentRef.current = agentName;

  useEffect(() => {
    if (!sessionId) {
      setMode("unknown");
      return;
    }
    let cancelled = false;
    const tick = async () => {
      try {
        const status = await getCallRecording(sessionId, agentRef.current);
        if (cancelled || sessionRef.current !== sessionId) return;
        setMode(status.mode);
        if (status.mode === "fallback" && mediaConnected && !tape.current) {
          tape.current = startTileRecording();
        }
      } catch {
        if (!cancelled) setMode("unknown");
      }
    };
    void tick();
    const timer = window.setInterval(() => void tick(), 1000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [sessionId, mediaConnected]);

  async function stopAndUpload(endingSessionId: string): Promise<void> {
    if (sessionRef.current !== endingSessionId) return;
    const current = tape.current;
    tape.current = null;
    if (!current) return;
    const id = endingSessionId;
    const blob = await current.stop();
    if (blob.size === 0) return;
    await uploadCallRecording(id, agentRef.current, blob);
  }

  return { mode, stopAndUpload };
}
