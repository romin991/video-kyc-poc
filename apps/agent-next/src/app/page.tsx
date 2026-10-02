"use client";

import { useCallMedia } from "@vkyc/livekit";
import { useEffect, useState } from "react";
import {
  acceptSession,
  claimNextSession,
  createSession,
  endSession,
  getHealth,
  listSessions,
  serverUrlFor,
  type ClaimResult,
  type Session,
} from "@/lib/api";

const POLL_MS = 2000;
const NAME_KEY = "vkyc.agentName";

function readName(): string {
  try {
    return sessionStorage.getItem(NAME_KEY) || "Demo agent";
  } catch {
    return "Demo agent";
  }
}

function shortId(id: string): string {
  return id.slice(0, 8);
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

function CallStage({ call, onEnd, busy }: { call: ClaimResult; onEnd: () => void; busy: boolean }) {
  const serverUrl = serverUrlFor(call.livekitUrl);
  const media = useCallMedia({
    serverUrl: serverUrl || null,
    token: call.agentToken,
    roomName: call.roomName,
  });

  return (
    <section className="panel" data-call="active" data-room-name={call.roomName} data-call-phase={media.phase}>
      <div className="call-head">
        <div>
          <p className="eyebrow">In call</p>
          <h2>Session {shortId(call.sessionId)}</h2>
          <p className="meta">Room {call.roomName}</p>
        </div>
        <button type="button" className="danger" data-action="end" disabled={busy} onClick={onEnd}>
          {busy ? "Ending…" : "End session"}
        </button>
      </div>
      <div className="stage">
        <VideoTile label="Customer" slot="remote" />
        <VideoTile label="You" slot="local" />
      </div>
      <p className="media-note" data-media-detail={media.detail}>
        {media.detail || "Preparing the LiveKit connect point."}
      </p>
    </section>
  );
}

export default function DeskPage() {
  const [name, setName] = useState("Demo agent");
  const [sessions, setSessions] = useState<Session[]>([]);
  const [call, setCall] = useState<ClaimResult | null>(null);
  const [apiUp, setApiUp] = useState<boolean | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    setName(readName());
  }, []);

  useEffect(() => {
    try {
      sessionStorage.setItem(NAME_KEY, name);
    } catch {
      /* The desk still sends the name on each request. */
    }
  }, [name]);

  useEffect(() => {
    let timer = 0;
    let gone = false;

    const tick = async () => {
      const up = await getHealth();
      if (gone) return;
      setApiUp(up);
      if (up) {
        try {
          const body = await listSessions(name.trim() || "Demo agent");
          if (!gone) setSessions(body.sessions);
        } catch (err) {
          if (!gone) setError(err instanceof Error ? err.message : "Could not load sessions.");
        }
      }
      if (!gone) timer = window.setTimeout(() => void tick(), POLL_MS);
    };

    void tick();
    return () => {
      gone = true;
      window.clearTimeout(timer);
    };
  }, [name]);

  useEffect(() => {
    if (!call) return;
    const row = sessions.find((session) => session.id === call.sessionId);
    if (row?.status === "ended") {
      setCall(null);
      setNotice(`Session ${shortId(call.sessionId)} ended.`);
    }
  }, [sessions, call]);

  const agent = name.trim() || "Demo agent";
  const waiting = sessions
    .filter((session) => session.status === "waiting")
    .sort((a, b) => (a.queuePosition ?? 99) - (b.queuePosition ?? 99));

  async function run(key: string, work: () => Promise<void>) {
    setBusy(key);
    setError(null);
    try {
      await work();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed.");
    } finally {
      setBusy(null);
    }
  }

  async function refresh() {
    const body = await listSessions(agent);
    setSessions(body.sessions);
  }

  return (
    <main className="desk">
      <header className="top">
        <div>
          <p className="eyebrow">Superbank</p>
          <h1>Agent desk</h1>
        </div>
        <label className="name">
          Desk name
          <input
            value={name}
            maxLength={80}
            spellCheck={false}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
      </header>

      {apiUp === false ? <p className="banner">API is not reachable at the configured base URL.</p> : null}
      {notice ? <p className="notice">{notice}</p> : null}
      {error ? <p className="problem">{error}</p> : null}

      {call ? (
        <CallStage
          call={call}
          busy={busy === "end"}
          onEnd={() =>
            void run("end", async () => {
              await endSession(call.sessionId, agent);
              setCall(null);
              setNotice(`Session ${shortId(call.sessionId)} ended.`);
              await refresh();
            })
          }
        />
      ) : (
        <div className="actions">
          <button
            type="button"
            className="primary"
            data-action="create"
            disabled={busy !== null}
            onClick={() =>
              void run("create", async () => {
                const created = await createSession(agent);
                setNotice(`Session ${shortId(created.id)} is waiting.`);
                await refresh();
              })
            }
          >
            {busy === "create" ? "Creating…" : "Create session"}
          </button>
          <button
            type="button"
            className="ghost"
            data-action="claim-next"
            disabled={busy !== null || waiting.length === 0}
            onClick={() =>
              void run("claim", async () => {
                const claimed = await claimNextSession(agent);
                setCall(claimed);
                setNotice(null);
                await refresh();
              })
            }
          >
            {busy === "claim" ? "Claiming…" : "Claim next"}
          </button>
        </div>
      )}

      <section className="panel">
        <h2>Waiting</h2>
        {waiting.length === 0 ? <p className="meta">No session is waiting.</p> : null}
        <div className="rows">
          {waiting.map((session) => (
            <article className="row" key={session.id} data-session-id={session.id}>
              <div>
                <strong>#{session.queuePosition ?? "–"} · {shortId(session.id)}</strong>
                <p className="meta">Created by {session.createdBy}</p>
                <a className="link" href={session.joinUrl} data-join-url={session.joinUrl}>
                  {session.joinUrl}
                </a>
              </div>
              <div className="actions">
                <button
                  type="button"
                  className="ghost"
                  data-action="copy"
                  onClick={() =>
                    void navigator.clipboard.writeText(session.joinUrl).then(
                      () => setCopied(session.id),
                      () => setCopied(null),
                    )
                  }
                >
                  {copied === session.id ? "Copied" : "Copy link"}
                </button>
                <button
                  type="button"
                  className="primary"
                  data-action="accept"
                  disabled={busy !== null || call !== null}
                  onClick={() =>
                    void run(`accept:${session.id}`, async () => {
                      const claimed = await acceptSession(session.id, agent);
                      setCall(claimed);
                      setNotice(null);
                      await refresh();
                    })
                  }
                >
                  {busy === `accept:${session.id}` ? "Accepting…" : "Accept"}
                </button>
              </div>
            </article>
          ))}
        </div>
      </section>
    </main>
  );
}
