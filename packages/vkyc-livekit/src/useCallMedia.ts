"use client";

import { useEffect, useState } from "react";
import { connectRoom, type ConnectHandle } from "./connectRoom";

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
const CONNECTED =
  "LiveKit room connected. Camera and microphone publish is left for the LiveKit client PR.";

/**
 * Connects this participant when the Go API has minted a JWT and a LiveKit
 * WebSocket URL is available. Stub tokens and a missing URL leave the shell up.
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

    let cancelled = false;
    let handle: ConnectHandle | null = null;
    setPhase("connecting");
    setError(null);

    connectRoom({ serverUrl, token, roomName })
      .then((next) => {
        if (cancelled) {
          void next.disconnect();
          return;
        }
        handle = next;
        setPhase("connected");
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setPhase("error");
        setError(err instanceof Error ? err.message : "LiveKit connect failed");
      });

    return () => {
      cancelled = true;
      if (handle) void handle.disconnect();
    };
  }, [serverUrl, token, roomName]);

  let detail = "";
  if (phase === "stub") detail = token.startsWith("lk-stub-") ? STUB_TOKEN : MISSING_URL;
  if (phase === "connecting") detail = `Connecting to ${roomName}…`;
  if (phase === "connected") detail = CONNECTED;
  if (phase === "error") detail = error ?? "LiveKit connect failed";

  return {
    phase,
    detail,
    error,
    serverUrl: serverUrl || null,
    roomName: roomName || null,
  };
}
