"use client";

import { useEffect, useState } from "react";
import { connectRoom } from "./connectRoom";

export type CallPhase = "idle" | "stub" | "connecting" | "connected" | "error";

export interface CallMediaInput {
  serverUrl: string | null;
  token: string | null;
  roomName: string | null;
}

export interface CallMedia {
  phase: CallPhase;
  detail: string;
  error: string | null;
  serverUrl: string | null;
  roomName: string | null;
}

const STUB_TOKEN =
  "Participant token is a placeholder. Set LIVEKIT_API_KEY and LIVEKIT_API_SECRET on the API, then start a new session.";
const MISSING_URL = "LIVEKIT_URL is empty, so Room.connect is skipped. The call shell stays up.";

/**
 * Connects this participant when the Go API has minted a JWT and a LiveKit
 * WebSocket URL is available. The room publishes this camera and microphone
 * and subscribes to the remote participant. Stub tokens and a missing URL
 * leave the shell up.
 *
 * Cleanup is End: the call stage unmounts, this effect aborts, and the room
 * disconnects and stops local tracks. A Strict Mode remount aborts the first
 * effect before it connects, so only one Room joins per participant.
 */
export function useCallMedia(input: CallMediaInput): CallMedia {
  const serverUrl = input.serverUrl?.trim() || "";
  const token = input.token?.trim() || "";
  const roomName = input.roomName?.trim() || "";
  const [phase, setPhase] = useState<CallPhase>("idle");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!roomName || !token) {
      setPhase("idle");
      setError(null);
      return;
    }
    if (token.startsWith("lk-stub-") || !serverUrl) {
      setPhase("stub");
      setError(null);
      return;
    }

    const abort = new AbortController();
    setPhase("connecting");
    setError(null);

    connectRoom({
      serverUrl,
      token,
      roomName,
      signal: abort.signal,
      onUnexpectedDisconnect: (reason) => {
        if (abort.signal.aborted) return;
        setPhase("error");
        setError(`LiveKit disconnected (${reason}).`);
      },
    })
      .then((next) => {
        if (abort.signal.aborted) return;
        setPhase("connected");
        setError(next.publishError);
      })
      .catch((err: unknown) => {
        if (abort.signal.aborted) return;
        setPhase("error");
        setError(err instanceof Error ? err.message : "LiveKit connect failed");
      });

    return () => {
      abort.abort();
    };
  }, [serverUrl, token, roomName]);

  let detail = "";
  if (phase === "stub") detail = token.startsWith("lk-stub-") ? STUB_TOKEN : MISSING_URL;
  if (phase === "connecting") detail = `Connecting to ${roomName}…`;
  if (phase === "connected" && error) detail = `Connected to ${roomName}. ${error}`;
  else if (phase === "connected") detail = `Connected to ${roomName}. Camera and microphone are live.`;
  if (phase === "error") detail = error ?? "LiveKit connect failed";

  return {
    phase,
    detail,
    error,
    serverUrl: serverUrl || null,
    roomName: roomName || null,
  };
}
