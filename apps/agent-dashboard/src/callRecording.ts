import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createCallTape, type CallTape } from "../../api/src/callMediaRelease";
import { getCallRecording, uploadCallRecording, type CallRecordingMode } from "./api";

/**
 * Records the customer tile plus both microphones when Cloud egress cannot
 * start. The original LiveKit tracks are left running until the room releases.
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
    return createCallTape({
      recorder,
      chunks,
      close: () => {
        recorder.ondataavailable = null;
        closeMix();
      },
    });
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
  const mixedAudio = destination.stream.getAudioTracks();
  const stream = new MediaStream([video, ...mixedAudio]);
  let closed = false;
  return {
    stream,
    close: () => {
      if (closed) return;
      closed = true;
      nodes.forEach((node) => {
        try {
          node.disconnect();
        } catch {
          // The node is already disconnected.
        }
      });
      for (const track of mixedAudio) {
        try {
          track.stop();
        } catch {
          // The mix track already ended.
        }
      }
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
  const timerRef = useRef(0);
  const sessionRef = useRef(sessionId);
  const agentRef = useRef(agentName);
  sessionRef.current = sessionId;
  agentRef.current = agentName;

  const takeTape = (): CallTape | null => {
    const current = tape.current;
    tape.current = null;
    return current;
  };

  // Layout so the recorder and its poll stop before useLiveKit's passive
  // cleanup disconnects the room and stops the camera tracks.
  useLayoutEffect(() => {
    const endingSessionId = sessionId;
    return () => {
      window.clearInterval(timerRef.current);
      timerRef.current = 0;
      const current = takeTape();
      if (!current) return;
      void current.stop().then(async (blob) => {
        if (!endingSessionId || blob.size === 0) return;
        try {
          await uploadCallRecording(endingSessionId, agentRef.current, blob);
        } catch (error) {
          console.error("[vkyc] call recorder teardown failed", error);
        }
      }).catch((error: unknown) => {
        console.error("[vkyc] call recorder teardown failed", error);
      });
    };
  }, [sessionId]);

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
          const started = startTileRecording();
          if (cancelled || sessionRef.current !== sessionId) {
            void started?.stop();
            return;
          }
          tape.current = started;
        }
      } catch {
        if (!cancelled) setMode("unknown");
      }
    };
    void tick();
    const timer = window.setInterval(() => void tick(), 1000);
    timerRef.current = timer;
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      if (timerRef.current === timer) timerRef.current = 0;
    };
  }, [sessionId, mediaConnected]);

  async function stopAndUpload(endingSessionId: string): Promise<void> {
    if (sessionRef.current !== endingSessionId) return;
    const current = takeTape();
    if (!current) return;
    const blob = await current.stop();
    if (blob.size === 0) return;
    await uploadCallRecording(endingSessionId, agentRef.current, blob);
  }

  return { mode, stopAndUpload };
}
