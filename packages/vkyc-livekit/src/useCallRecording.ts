"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { fallbackRecorderAction, selectLongerRecording } from "./callTape";
import { startTileRecording, type RunningTape } from "./tileRecording";

const FALLBACK_MODE = "fallback";

export interface CallRecording {
  /** True while a MediaRecorder is taking the customer tile. */
  capturing: boolean;
  /** Stop the tape and POST it. Safe to call twice. */
  stopAndUpload: (endingSessionId: string) => Promise<void>;
}

/**
 * Records the customer tile for the whole call, then hands the WebM to `upload`.
 *
 * The layout cleanup stops the recorder before `useCallMedia` disconnects the
 * room, so End from the other side still keeps the tape. `upload` is
 * `POST /sessions/:id/call-recording`. Cloud egress is not started here.
 */
export function useCallRecording(
  sessionId: string | null,
  mediaConnected: boolean,
  upload: (sessionId: string, blob: Blob) => Promise<void>,
): CallRecording {
  const [capturing, setCapturing] = useState(false);
  const active = useRef<RunningTape | null>(null);
  const retained = useRef<Blob | null>(null);
  const ending = useRef(false);
  const timerRef = useRef(0);
  const chain = useRef<Promise<void>>(Promise.resolve());
  const sent = useRef<{ id: string; bytes: number }>({ id: "", bytes: 0 });
  const sessionRef = useRef(sessionId);
  const mediaRef = useRef(mediaConnected);
  const uploadRef = useRef(upload);
  sessionRef.current = sessionId;
  mediaRef.current = mediaConnected;
  uploadRef.current = upload;

  const enqueue = (task: () => Promise<void>): Promise<void> => {
    const run = chain.current.then(task, task);
    chain.current = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  const uploadBlob = async (targetSessionId: string, blob: Blob): Promise<void> => {
    if (blob.size === 0) return;
    if (sent.current.id === targetSessionId && blob.size <= sent.current.bytes) {
      console.warn(
        `[vkyc] skipped shorter call recording (${blob.size} bytes <= ${sent.current.bytes} bytes)`,
      );
      return;
    }
    await uploadRef.current(targetSessionId, blob);
    if (sent.current.id !== targetSessionId || blob.size > sent.current.bytes) {
      sent.current = { id: targetSessionId, bytes: blob.size };
    }
  };

  const longestBlob = async (running: RunningTape | null, kept: Blob | null): Promise<Blob | null> => {
    let best = kept;
    if (running) {
      try {
        best = selectLongerRecording(best, await running.stop());
      } catch (error) {
        console.error("[vkyc] call recorder stop failed", error);
      }
    }
    return best && best.size > 0 ? best : null;
  };

  const releaseTape = async (targetSessionId: string): Promise<void> => {
    const running = active.current;
    const kept = retained.current;
    active.current = null;
    retained.current = null;
    setCapturing(false);
    const blob = await longestBlob(running, kept);
    if (!blob) return;
    await uploadBlob(targetSessionId, blob);
  };

  useLayoutEffect(() => {
    ending.current = false;
    const endingSessionId = sessionId;
    return () => {
      ending.current = true;
      window.clearInterval(timerRef.current);
      timerRef.current = 0;
      if (!endingSessionId) return;
      const running = active.current;
      // Stop before useCallMedia's effect disconnects the room.
      const stopping = running ? running.stop().catch(() => null) : Promise.resolve(null);
      void enqueue(async () => {
        if (active.current === running) active.current = null;
        const kept = retained.current;
        retained.current = null;
        setCapturing(false);
        let blob = kept;
        try {
          blob = selectLongerRecording(blob, await stopping);
        } catch (error) {
          console.error("[vkyc] call recorder stop failed", error);
        }
        if (!blob || blob.size === 0) return;
        try {
          await uploadBlob(endingSessionId, blob);
        } catch (error) {
          console.error("[vkyc] call recorder teardown failed", error);
        }
      });
    };
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId) {
      setCapturing(false);
      return;
    }
    if (ending.current) return;
    let cancelled = false;
    let ticking = false;
    const tick = () => {
      if (ticking || cancelled || ending.current) return;
      ticking = true;
      void enqueue(async () => {
        try {
          if (cancelled || ending.current || sessionRef.current !== sessionId) return;
          const action = fallbackRecorderAction({
            mode: FALLBACK_MODE,
            mediaConnected: mediaRef.current,
            ending: ending.current,
            recorderState: active.current?.state() ?? null,
          });
          if (action === "keep") {
            active.current?.rebind();
            return;
          }
          if (action === "restart") {
            console.warn("[vkyc] browser call recorder stopped during the call; starting again");
          }
          if (active.current) {
            const running = active.current;
            active.current = null;
            setCapturing(false);
            try {
              const blob = await running.stop();
              if (!cancelled && sessionRef.current === sessionId) {
                retained.current = selectLongerRecording(retained.current, blob);
              }
            } catch (error) {
              console.error("[vkyc] call recorder stop failed", error);
            }
          }
          if (cancelled || ending.current || sessionRef.current !== sessionId || !mediaRef.current) return;
          const started = startTileRecording();
          if (!started) return;
          if (cancelled || ending.current || sessionRef.current !== sessionId) {
            void started.stop();
            return;
          }
          active.current = started;
          setCapturing(true);
        } finally {
          ticking = false;
        }
      });
    };
    tick();
    const timer = window.setInterval(tick, 1000);
    timerRef.current = timer;
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      if (timerRef.current === timer) timerRef.current = 0;
    };
  }, [sessionId, mediaConnected]);

  const stopAndUpload = useCallback(async (endingSessionId: string): Promise<void> => {
    if (sessionRef.current !== endingSessionId) return;
    ending.current = true;
    window.clearInterval(timerRef.current);
    timerRef.current = 0;
    await enqueue(async () => {
      if (sessionRef.current !== endingSessionId) return;
      await releaseTape(endingSessionId);
    });
  }, []);

  return { capturing, stopAndUpload };
}
