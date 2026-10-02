"use client";

import { useCallMedia } from "@vkyc/livekit";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ApiError, endSession, fetchJoin, serverUrlFor, type JoinInfo } from "@/lib/api";

const POLL_MS = 1500;

function placeLabel(position: number): string {
  const mod100 = position % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${position}th`;
  switch (position % 10) {
    case 1:
      return `${position}st`;
    case 2:
      return `${position}nd`;
    case 3:
      return `${position}rd`;
    default:
      return `${position}th`;
  }
}

function VideoTile({ label, slot }: { label: string; slot: "local" | "remote" }) {
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

function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="frame">
      <div className="device">
        <header className="device-bar">
          <span className="mark" aria-hidden="true" />
          <div>
            <p>Superbank</p>
            <strong>Video verification</strong>
          </div>
        </header>
        <div className="device-body">{children}</div>
      </div>
    </div>
  );
}

function InCall({ info, onEnded }: { info: JoinInfo; onEnded: () => void }) {
  const serverUrl = serverUrlFor(info.livekitUrl);
  const media = useCallMedia({
    serverUrl: serverUrl || null,
    token: info.customerToken,
    roomName: info.roomName,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="call" data-call="active" data-room-name={info.roomName} data-call-phase={media.phase}>
      <div className="call-head">
        <div>
          <p className="eyebrow">In call</p>
          <h1>Connected</h1>
        </div>
        <button
          type="button"
          className="danger"
          data-action="end"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            setError(null);
            void endSession(info.sessionId)
              .then(() => onEnded())
              .catch((err: unknown) => {
                setError(err instanceof Error ? err.message : "Could not end the session.");
                setBusy(false);
              });
          }}
        >
          {busy ? "Ending…" : "End session"}
        </button>
      </div>
      <div className="stage">
        <VideoTile label="Agent" slot="remote" />
        <VideoTile label="You" slot="local" />
      </div>
      <p className="media-note">{media.detail || "Preparing the LiveKit connect point."}</p>
      {error ? <p className="problem">{error}</p> : null}
    </div>
  );
}

export function JoinScreen({ token }: { token: string }) {
  const [info, setInfo] = useState<JoinInfo | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const closed = useRef(false);

  useEffect(() => {
    closed.current = false;
    let generation = 0;
    let timer = 0;
    const stop = () => {
      generation += 1;
      window.clearTimeout(timer);
    };

    const loop = async () => {
      const ticket = generation;
      try {
        const next = await fetchJoin(token);
        if (ticket !== generation || closed.current) return;
        setInfo(next);
        setProblem(null);
        if (next.status === "ended") {
          stop();
          return;
        }
      } catch (err) {
        if (ticket !== generation) return;
        if (err instanceof ApiError && err.status === 404) {
          stop();
          setFatal(err.message);
          return;
        }
        setProblem(err instanceof Error ? err.message : "Could not reach the verification service.");
      }
      if (ticket === generation) timer = window.setTimeout(() => void loop(), POLL_MS);
    };

    void loop();
    return () => stop();
  }, [token]);

  let body: ReactNode;
  if (fatal) {
    body = (
      <div className="stack">
        <h1>Link not valid</h1>
        <p>{fatal}</p>
      </div>
    );
  } else if (!info) {
    body = (
      <div className="stack">
        <h1>Checking your link</h1>
        <p>{problem ?? "Contacting the verification service…"}</p>
      </div>
    );
  } else if (info.status === "ended") {
    body = (
      <div className="stack" data-status="ended">
        <p className="eyebrow">Session {info.sessionId.slice(0, 8)}</p>
        <h1>Session ended</h1>
        <p>This verification is closed. You can close the window.</p>
      </div>
    );
  } else if (info.status === "waiting") {
    const place = info.queuePosition && info.queuePosition > 0 ? placeLabel(info.queuePosition) : null;
    body = (
      <div className="stack" data-status="waiting">
        <span className="pulse" aria-hidden="true" />
        <h1>Waiting for an agent</h1>
        <p>
          {place
            ? `You are ${place} in line. Keep this window open. The call starts when an agent accepts you.`
            : "Keep this window open. The call starts when an agent accepts you."}
        </p>
        <p className="mono">Session {info.sessionId.slice(0, 8)}</p>
        {problem ? <p className="problem">{problem} Retrying…</p> : null}
      </div>
    );
  } else {
    body = (
      <InCall
        info={info}
        onEnded={() => {
          closed.current = true;
          setInfo({ ...info, status: "ended", queuePosition: null });
        }}
      />
    );
  }

  return <Shell>{body}</Shell>;
}
