import { useEffect, useRef, useState, type Ref } from "react";
import {
  acceptSession,
  createSession,
  endSession,
  getHealth,
  listSessions,
  type Session,
  type SessionStatus,
} from "./api";
import { useLiveKit } from "./livekit";

const POLL_MS = 2000;
const NAME_KEY = "vkyc.agentName";
const CALL_KEY = "vkyc.agentCall";
const SPOTLIGHT_KEY = "vkyc.spotlight";

interface ActiveCall {
  sessionId: string;
  roomName: string;
  agentToken: string;
  joinUrl: string;
}

function readStorage(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string | null): void {
  try {
    if (value === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, value);
  } catch {
    /* Ignore private-mode storage failures. The desk still works in memory. */
  }
}

function readCall(): ActiveCall | null {
  const raw = readStorage(CALL_KEY);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<ActiveCall>;
    if (!value.sessionId || !value.roomName || !value.agentToken || !value.joinUrl) return null;
    return {
      sessionId: value.sessionId,
      roomName: value.roomName,
      agentToken: value.agentToken,
      joinUrl: value.joinUrl,
    };
  } catch {
    return null;
  }
}

function statusLabel(status: SessionStatus): string {
  if (status === "in_call") return "In call";
  if (status === "ended") return "Ended";
  return "Waiting";
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

function formatWhen(iso: string): string {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function StatusPill({ status }: { status: SessionStatus }) {
  return <span className={`pill pill-${status}`}>{statusLabel(status)}</span>;
}

function VideoTile({
  label,
  slot,
  videoRef,
}: {
  label: string;
  slot: "local" | "remote";
  videoRef?: Ref<HTMLVideoElement>;
}) {
  return (
    <section className={`tile tile-${slot}`} aria-label={label}>
      <video ref={videoRef} data-livekit={slot} autoPlay muted={slot === "local"} playsInline />
      <div className="tile-fallback">
        <span className="avatar" aria-hidden="true">
          {label.slice(0, 1)}
        </span>
        <p>{label}</p>
        <small>{slot === "local" ? "Your camera" : "Their camera"}</small>
      </div>
    </section>
  );
}

export function App() {
  const [name, setName] = useState(() => readStorage(NAME_KEY) || "Demo agent");
  const [sessions, setSessions] = useState<Session[]>([]);
  const [spotlightId, setSpotlightId] = useState<string | null>(() => readStorage(SPOTLIGHT_KEY));
  const [call, setCall] = useState<ActiveCall | null>(() => readCall());
  const [apiUp, setApiUp] = useState<boolean | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const remoteRef = useRef<HTMLVideoElement>(null);
  const nameRef = useRef("Demo agent");
  nameRef.current = name.trim() || "Demo agent";

  const media = useLiveKit(call?.roomName ?? null, call?.agentToken ?? null);
  const spotlight = sessions.find((session) => session.id === spotlightId) ?? null;
  const openSessions = sessions.filter((session) => session.status !== "ended");
  const waitingCount = openSessions.filter((session) => session.status === "waiting").length;

  useEffect(() => {
    writeStorage(NAME_KEY, nameRef.current);
  }, [name]);

  useEffect(() => {
    let cancelled = false;
    let timer = 0;

    const loop = async () => {
      const health = await getHealth();
      if (cancelled) return;
      setApiUp(health);
      if (!health) {
        setLoaded(true);
        setLoadError("API is not responding on port 3001.");
      } else {
        try {
          const body = await listSessions(nameRef.current);
          if (cancelled) return;
          setSessions(body.sessions);
          setLoadError(null);
        } catch (err) {
          if (cancelled) return;
          setLoadError(err instanceof Error ? err.message : "Could not load the queue.");
        } finally {
          if (!cancelled) setLoaded(true);
        }
      }
      if (!cancelled) timer = window.setTimeout(loop, POLL_MS);
    };

    void loop();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    if (!loaded || !apiUp || loadError || !call) return;
    const match = sessions.find((session) => session.id === call.sessionId);
    if (!match || match.status === "ended") {
      setCall(null);
      writeStorage(CALL_KEY, null);
      if (match?.status === "ended") setNotice("Session ended. The customer leaves on their next check.");
    }
  }, [loaded, apiUp, loadError, call, sessions]);

  async function copyLink(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(url);
      window.setTimeout(() => {
        setCopied((current) => (current === url ? null : current));
      }, 2000);
    } catch {
      setError("Clipboard blocked. Select the join link and copy it manually.");
    }
  }

  async function onCreate() {
    setBusy("create");
    setError(null);
    setNotice(null);
    try {
      const session = await createSession(nameRef.current);
      setSessions((current) => [session, ...current.filter((item) => item.id !== session.id)]);
      setSpotlightId(session.id);
      writeStorage(SPOTLIGHT_KEY, session.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create a session.");
    } finally {
      setBusy(null);
    }
  }

  async function onAccept(session: Session) {
    setBusy(session.id);
    setError(null);
    setNotice(null);
    try {
      const result = await acceptSession(session.id, nameRef.current);
      const next: ActiveCall = {
        sessionId: result.sessionId,
        roomName: result.roomName,
        agentToken: result.agentToken,
        joinUrl: session.joinUrl,
      };
      setCall(next);
      writeStorage(CALL_KEY, JSON.stringify(next));
      setSpotlightId(session.id);
      writeStorage(SPOTLIGHT_KEY, session.id);
      setSessions((current) =>
        current.map((item) => (item.id === session.id ? { ...item, status: "in_call" } : item)),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not accept the session.");
    } finally {
      setBusy(null);
    }
  }

  async function onEnd(sessionId: string) {
    setBusy(sessionId);
    setError(null);
    try {
      await endSession(sessionId, nameRef.current);
      setSessions((current) =>
        current.map((item) => (item.id === sessionId ? { ...item, status: "ended" } : item)),
      );
      if (call?.sessionId === sessionId) {
        setCall(null);
        writeStorage(CALL_KEY, null);
      }
      setNotice("Session ended. The customer leaves on their next check.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not end the session.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="mark" aria-hidden="true" />
          <div>
            <p className="eyebrow">Superbank · P0 shell</p>
            <h1>Video KYC desk</h1>
          </div>
        </div>
        <div className="top-meta">
          <p className={`api-dot${apiUp ? " up" : apiUp === false ? " down" : ""}`}>
            {apiUp ? "API online" : apiUp === false ? "API offline" : "Checking API"}
          </p>
          <label className="identity">
            <span>Demo agent</span>
            <input
              value={name}
              maxLength={80}
              spellCheck={false}
              aria-describedby="identity-hint"
              onChange={(event) => setName(event.target.value)}
            />
          </label>
        </div>
      </header>
      <p id="identity-hint" className="identity-hint">
        Display name only. Sent as the X-Demo-Agent header. This is not a login.
      </p>

      {error ? (
        <p className="banner bad" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="banner" role="status">
          {notice}
        </p>
      ) : null}
      {loadError ? (
        <p className="banner bad" role="status">
          {loadError}
        </p>
      ) : null}

      {call ? (
        <section className="panel stage-wrap" aria-label="Active call">
          <div className="panel-head">
            <div>
              <h2>In call</h2>
              <p className="mono">{call.roomName}</p>
            </div>
            <button
              type="button"
              className="danger"
              disabled={busy !== null}
              onClick={() => void onEnd(call.sessionId)}
            >
              {busy === call.sessionId ? "Ending…" : "End session"}
            </button>
          </div>
          <div className="stage">
            <VideoTile label="Customer" slot="remote" videoRef={remoteRef} />
            <VideoTile label="You" slot="local" />
          </div>
          <div className="media-note">
            <p>
              {media?.mediaConnected
                ? "LiveKit connected."
                : media?.mediaError
                  ? media.mediaError
                  : media?.serverUrl
                    ? "Connecting to LiveKit…"
                    : "VITE_LIVEKIT_URL is empty. Cameras stay off. The session shell still works."}
            </p>
            <button type="button" className="ghost" onClick={() => void remoteRef.current?.play()}>
              Enable remote audio
            </button>
          </div>
        </section>
      ) : null}

      <div className="desk">
        <section className="panel" aria-labelledby="new-session-heading">
          <div className="panel-head">
            <h2 id="new-session-heading">New session</h2>
            <button
              type="button"
              className="primary"
              disabled={busy !== null || call !== null}
              onClick={() => void onCreate()}
            >
              {busy === "create" ? "Creating…" : "Create session"}
            </button>
          </div>
          {call ? <p className="muted">End the current call before creating another session.</p> : null}
          {spotlight ? (
            <div className="spotlight">
              <div className="spotlight-row">
                <StatusPill status={spotlight.status} />
                <span className="mono">{shortId(spotlight.id)}</span>
                <span className="muted">{spotlight.createdBy}</span>
              </div>
              <label className="link-field">
                <span>Customer join link</span>
                <input
                  readOnly
                  value={spotlight.joinUrl}
                  spellCheck={false}
                  onFocus={(event) => event.currentTarget.select()}
                />
              </label>
              <button type="button" className="ghost" onClick={() => void copyLink(spotlight.joinUrl)}>
                {copied === spotlight.joinUrl ? "Copied" : "Copy link"}
              </button>
            </div>
          ) : (
            <p className="muted">Create a session, then open the join link in a second browser window.</p>
          )}
        </section>

        <section className="panel" aria-labelledby="queue-heading">
          <div className="panel-head">
            <h2 id="queue-heading">Queue</h2>
            <span className="count">
              {waitingCount} waiting
            </span>
          </div>
          {openSessions.length === 0 ? (
            <p className="muted">No open sessions. New ones show up here within a couple of seconds.</p>
          ) : (
            <ul className="queue">
              {openSessions.map((session) => (
                <li key={session.id} className="queue-item">
                  <div className="queue-id">
                    <StatusPill status={session.status} />
                    <strong className="mono">{shortId(session.id)}</strong>
                    <span className="muted">
                      {session.createdBy} · {formatWhen(session.createdAt)}
                    </span>
                  </div>
                  <div className="queue-actions">
                    <button type="button" className="ghost" onClick={() => void copyLink(session.joinUrl)}>
                      {copied === session.joinUrl ? "Copied" : "Copy link"}
                    </button>
                    {session.status === "waiting" ? (
                      <button
                        type="button"
                        className="primary"
                        disabled={call !== null || busy !== null}
                        onClick={() => void onAccept(session)}
                      >
                        {busy === session.id ? "Accepting…" : "Accept"}
                      </button>
                    ) : null}
                    {session.status === "in_call" && call?.sessionId === session.id ? (
                      <span className="muted">On this desk</span>
                    ) : null}
                    {session.status === "in_call" && call?.sessionId !== session.id ? (
                      <button
                        type="button"
                        className="danger"
                        disabled={busy !== null}
                        onClick={() => void onEnd(session.id)}
                      >
                        {busy === session.id ? "Ending…" : "End"}
                      </button>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
