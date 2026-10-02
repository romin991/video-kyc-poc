"use client";

import { useCallMedia, useCallRecording } from "@vkyc/livekit";
import { useEffect, useState } from "react";
import { KycDesk } from "@/app/kyc-desk";
import {
  acceptSession,
  claimNextSession,
  createSession,
  endSession,
  getHealth,
  listSessions,
  serverUrlFor,
  uploadCallRecording,
  type ClaimResult,
  type Session,
} from "@/lib/api";

const POLL_MS = 2000;
const NAME_KEY = "vkyc.agentName";
const ACW_KEY = "vkyc.acw";

function readName(): string {
  try {
    return sessionStorage.getItem(NAME_KEY) || "Demo agent";
  } catch {
    return "Demo agent";
  }
}

function writeAcw(id: string | null) {
  try {
    if (id) sessionStorage.setItem(ACW_KEY, id);
    else sessionStorage.removeItem(ACW_KEY);
  } catch {
    /* The desk still keeps the id in memory. */
  }
}

function dispositionLabel(value: Session["disposition"]): string {
  if (value === "approve") return "Approve";
  if (value === "reject") return "Reject";
  if (value === "utv") return "UTV";
  return "No disposition";
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

function statusLabel(status: Session["status"]): string {
  if (status === "in_call") return "In call";
  if (status === "ended") return "Ended";
  return "Waiting";
}

function sessionLabel(session: { id: string; displayName: string | null }): string {
  const name = session.displayName?.trim();
  if (name) return name;
  return `Session ${shortId(session.id)}`;
}

function StatusPill({ status }: { status: Session["status"] }) {
  return (
    <span className={`pill pill-${status}`} data-status={status}>
      {statusLabel(status)}
    </span>
  );
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

function CallStage({
  call,
  label,
  agentName,
  onEnd,
  onUploadFailed,
  busy,
}: {
  call: ClaimResult;
  label: string;
  agentName: string;
  onEnd: () => Promise<void>;
  onUploadFailed: (message: string) => void;
  busy: boolean;
}) {
  const serverUrl = serverUrlFor(call.livekitUrl);
  const media = useCallMedia({
    serverUrl: serverUrl || null,
    token: call.agentToken,
    roomName: call.roomName,
  });
  const recording = useCallRecording(call.sessionId, media.phase === "connected", (sessionId, blob) =>
    uploadCallRecording(sessionId, agentName, blob).then(() => undefined),
  );
  const [ending, setEnding] = useState(false);
  const showRecorder = media.phase === "connected" || media.phase === "connecting";

  async function finish() {
    setEnding(true);
    let uploadError: string | null = null;
    try {
      await recording.stopAndUpload(call.sessionId);
    } catch (err) {
      uploadError = err instanceof Error ? err.message : "Could not upload the call recording.";
    }
    try {
      await onEnd();
      if (uploadError) onUploadFailed(uploadError);
    } finally {
      setEnding(false);
    }
  }

  return (
    <section
      className="panel"
      data-call="active"
      data-status="in_call"
      data-room-name={call.roomName}
      data-call-phase={media.phase}
      data-call-recording={recording.capturing ? "on" : "off"}
    >
      <div className="call-head">
        <div>
          <StatusPill status="in_call" />
          <h2>{label}</h2>
          <p className="meta">Room {call.roomName}</p>
        </div>
        <button type="button" className="danger" data-action="end" disabled={busy || ending} onClick={() => void finish()}>
          {busy || ending ? "Ending…" : "End session"}
        </button>
      </div>
      <div className="stage">
        <VideoTile label="Customer" slot="remote" />
        <VideoTile label="You" slot="local" />
      </div>
      <p className="media-note" data-media-detail={media.detail}>
        {media.detail || "Preparing the LiveKit connect point."}
      </p>
      {showRecorder ? (
        <p className="meta" data-call-recording-state={recording.capturing ? "on" : "waiting"}>
          {recording.capturing
            ? "Recording this call in the browser."
            : "Browser recording starts when the customer camera is live."}
        </p>
      ) : null}
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
  const [acwId, setAcwId] = useState<string | null>(null);

  useEffect(() => {
    setName(readName());
    try {
      const stored = sessionStorage.getItem(ACW_KEY);
      if (stored) setAcwId(stored);
    } catch {
      /* Refresh still loads the queue. */
    }
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
      const sessionId = call.sessionId;
      setCall(null);
      setAcwId(sessionId);
      writeAcw(sessionId);
      setNotice("Session ended. Finish after-call work: notes, stills, and a disposition.");
    }
  }, [sessions, call]);

  const agent = name.trim() || "Demo agent";
  const waiting = sessions
    .filter((session) => session.status === "waiting")
    .sort((a, b) => (a.queuePosition ?? 99) - (b.queuePosition ?? 99));
  const ended = sessions.filter((session) => session.status === "ended").slice(0, 6);

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
        <>
        <CallStage
          call={call}
          agentName={agent}
          label={sessionLabel(
            sessions.find((session) => session.id === call.sessionId) ?? {
              id: call.sessionId,
              displayName: null,
            },
          )}
          busy={busy === "end"}
          onUploadFailed={setError}
          onEnd={async () => {
            setBusy("end");
            try {
              const sessionId = call.sessionId;
              await endSession(sessionId, agent);
              setCall(null);
              setAcwId(sessionId);
              writeAcw(sessionId);
              setNotice("Session ended. Finish after-call work: notes, stills, and a disposition.");
              await refresh();
            } catch (err) {
              setError(err instanceof Error ? err.message : "Request failed.");
            } finally {
              setBusy(null);
            }
          }}
        />
        <KycDesk sessionId={call.sessionId} agentName={agent} phase="call" />
        </>
      ) : null}

      {acwId && !call ? (
        <section className="acw-shell" data-acw={acwId}>
          <div className="panel">
          <div className="call-head">
            <div>
              <h2>After-call work</h2>
              <p className="meta">
                {sessionLabel(
                  sessions.find((session) => session.id === acwId) ?? { id: acwId, displayName: null },
                )}
              </p>
            </div>
            <button
              type="button"
              className="ghost"
              data-action="close-acw"
              onClick={() => {
                setAcwId(null);
                writeAcw(null);
                setNotice(null);
              }}
            >
              Back to queue
            </button>
          </div>
          </div>
          <KycDesk sessionId={acwId} agentName={agent} phase="acw" />
        </section>
      ) : null}

      <section className="panel" aria-labelledby="queue-heading">
        <div className="panel-head">
          <h2 id="queue-heading">Waiting queue</h2>
          <div className="actions">
            <span className="count" data-queue-count={waiting.length}>
              {waiting.length} waiting
            </span>
            <button
              type="button"
              className="primary"
              data-action="create"
              disabled={busy !== null}
              onClick={() =>
                void run("create", async () => {
                  const created = await createSession(agent);
                  setNotice(`${sessionLabel(created)} is waiting.`);
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
              disabled={busy !== null || call !== null || waiting.length === 0}
              onClick={() =>
                void run("claim", async () => {
                  const claimed = await claimNextSession(agent);
                  setCall(claimed);
                  setAcwId(null);
                  writeAcw(null);
                  setNotice(null);
                  await refresh();
                })
              }
            >
              {busy === "claim" ? "Claiming…" : "Claim next"}
            </button>
          </div>
        </div>
        <p className="meta queue-note">
          New sessions wait here. Claim takes one into the call. Everyone else stays in the queue.
        </p>
        {waiting.length === 0 ? (
          <p className="meta">No one is waiting. A new session shows up here within a couple of seconds.</p>
        ) : (
          <ul className="queue" data-queue="waiting">
            {waiting.map((session) => (
              <li className="row" key={session.id} data-session-id={session.id} data-status="waiting">
                <div>
                  <div className="queue-lead">
                    <span className="queue-pos">#{session.queuePosition ?? "–"}</span>
                    <StatusPill status="waiting" />
                    <strong data-display-name={session.displayName ?? ""}>{sessionLabel(session)}</strong>
                  </div>
                  <p className="meta">
                    {shortId(session.id)} · {session.createdBy}
                  </p>
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
                        setAcwId(null);
                        writeAcw(null);
                        setNotice(null);
                        await refresh();
                      })
                    }
                  >
                    {busy === `accept:${session.id}` ? "Claiming…" : "Claim"}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
        {ended.length > 0 ? (
          <div className="ended-list">
            <h3>Ended</h3>
            <ul className="queue" data-queue="ended">
              {ended.map((session) => (
                <li className="row" key={session.id} data-session-id={session.id} data-status="ended">
                  <div className="queue-lead">
                    <StatusPill status="ended" />
                    {session.disposition ? (
                      <span className={`pill pill-${session.disposition}`}>{dispositionLabel(session.disposition)}</span>
                    ) : null}
                    <strong>{sessionLabel(session)}</strong>
                    <span className="meta">{shortId(session.id)}</span>
                  </div>
                  <button
                    type="button"
                    className="ghost"
                    data-action="open-acw"
                    onClick={() => {
                      setAcwId(session.id);
                      writeAcw(session.id);
                      setNotice(null);
                    }}
                  >
                    Open ACW
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>
    </main>
  );
}
