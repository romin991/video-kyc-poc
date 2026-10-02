"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { roomNameFor } from "@vkyc/media";
import { useLiveKit } from "./livekit";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE || "http://127.0.0.1:8080";

interface MintedMedia {
  sessionId: string;
  roomName: string;
  role: string;
  token: string;
  serverUrl: string;
  livekitConfigured: boolean;
  error?: string;
}

/**
 * Customer call shell. Pass `roomName` and `token` from the join response
 * (query string until that response is wired). Without them, Join asks the
 * Go mint stand-in `POST /media/tokens` for this session id.
 * End drops the token so the LiveKit effect disconnects and stops tracks.
 */
export function CallStage() {
  const params = useSearchParams();
  const [sessionId, setSessionId] = useState(params.get("sessionId") ?? "");
  const [roomName, setRoomName] = useState<string | null>(params.get("roomName"));
  const [token, setToken] = useState<string | null>(params.get("token"));
  const [busy, setBusy] = useState(false);
  const [ended, setEnded] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);
  const media = useLiveKit(roomName, token);
  const inCall = Boolean(roomName && token);

  async function join(event: React.FormEvent) {
    event.preventDefault();
    const id = sessionId.trim();
    if (!id) {
      setJoinError("Enter a session id. Use the same id in the agent app.");
      return;
    }
    setBusy(true);
    setJoinError(null);
    setEnded(false);
    try {
      const response = await fetch(`${API_BASE}/media/tokens`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: id, role: "customer" }),
      });
      const body = (await response.json()) as MintedMedia;
      if (!response.ok) {
        setJoinError(body.error || `Mint failed (${response.status})`);
        return;
      }
      setRoomName(body.roomName || roomNameFor(id));
      setToken(body.token);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Mint request failed";
      setJoinError(`${message}. Start the Go API at ${API_BASE}, or open this page with roomName and token from the join response.`);
    } finally {
      setBusy(false);
    }
  }

  function end() {
    setToken(null);
    setRoomName(null);
    setEnded(true);
  }

  const state = mediaState(inCall, ended, media);

  return (
    <main className="shell">
      <header>
        <p className="eyebrow">Video KYC · Customer</p>
        <h1>Call</h1>
      </header>

      <form className="join" onSubmit={join}>
        <label>
          Session id
          <input
            name="sessionId"
            value={sessionId}
            onChange={(event) => setSessionId(event.target.value)}
            autoComplete="off"
            spellCheck={false}
            disabled={inCall}
          />
        </label>
        <button type="submit" data-action="join-call" disabled={inCall || busy}>
          {busy ? "Joining…" : "Join call"}
        </button>
        <button type="button" data-action="end-call" onClick={end} disabled={!inCall}>
          End
        </button>
      </form>

      <p className="status" data-media-state={state} role="status">
        {statusCopy(state, media?.roomName ?? roomName, media?.mediaError ?? joinError)}
      </p>

      <div className="tiles">
        <Tile label="Agent" slot="remote" />
        <Tile label="You" slot="local" />
      </div>
    </main>
  );
}

function Tile({ label, slot }: { label: string; slot: "local" | "remote" }) {
  return (
    <section className={`tile tile-${slot}`} aria-label={label}>
      <video data-livekit={slot} autoPlay muted={slot === "local"} playsInline />
      <div className="tile-fallback">
        <p>{label}</p>
        <small>{slot === "local" ? "Your camera" : "Their camera"}</small>
      </div>
    </section>
  );
}

function mediaState(
  inCall: boolean,
  ended: boolean,
  media: { serverUrl: string | null; mediaConnected: boolean; mediaError: string | null } | null,
): string {
  if (!inCall) return ended ? "ended" : "idle";
  if (media?.mediaError) return "error";
  if (!media?.serverUrl) return "off";
  if (media.mediaConnected) return "connected";
  return "connecting";
}

function statusCopy(state: string, roomName: string | null, error: string | null): string {
  if (state === "ended") return "Call ended. The room is disconnected and the camera and microphone are stopped.";
  if (state === "error") return error || "LiveKit connection failed.";
  if (state === "off") {
    return `${roomName ?? "This room"} is ready. NEXT_PUBLIC_LIVEKIT_URL is empty, so the camera stays off.`;
  }
  if (state === "connecting") return `Connecting to ${roomName}…`;
  if (state === "connected") return `Connected to ${roomName}. Use headphones if both apps are on one machine.`;
  if (error) return error;
  return "Enter the same session id as the agent, then join. End leaves the room.";
}
