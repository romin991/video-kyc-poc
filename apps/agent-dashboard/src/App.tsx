import { useEffect, useRef, useState, type Ref } from "react";
import {
  acceptSession,
  createSession,
  endSession,
  getHealth,
  listSessions,
  patchSession,
  type CaptureKind,
  type Disposition,
  type Session,
  type SessionStatus,
} from "./api";
import { captureVideoStill } from "./captureStill";
import { blobFromVideoFrame, useCaptureUpload } from "./captures";
import { KycWorkspace, OnboardingFacts } from "./kyc";
import { useLiveKit } from "./livekit";

const POLL_MS = 2000;
const NAME_KEY = "vkyc.agentName";
const CALL_KEY = "vkyc.agentCall";
const SPOTLIGHT_KEY = "vkyc.spotlight";
const ACW_KEY = "vkyc.acw";

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

function dispositionLabel(value: Disposition | null): string {
  if (value === "approve") return "Approve";
  if (value === "reject") return "Reject";
  if (value === "utv") return "UTV";
  return "No disposition";
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
  const [acwId, setAcwId] = useState<string | null>(() => (readCall() ? null : readStorage(ACW_KEY)));
  const [apiUp, setApiUp] = useState<boolean | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [notesDraft, setNotesDraft] = useState("");
  const [notesSessionId, setNotesSessionId] = useState<string | null>(null);
  const remoteRef = useRef<HTMLVideoElement>(null);
  const nameRef = useRef("Demo agent");
  const savedNotes = useRef("");
  const mutationEpoch = useRef(0);
  const inflight = useRef(0);
  const tail = useRef<Promise<void>>(Promise.resolve());
  nameRef.current = name.trim() || "Demo agent";

  const focusId = call?.sessionId ?? acwId;
  const captures = useCaptureUpload(focusId, nameRef.current);
  const media = useLiveKit(call?.roomName ?? null, call?.agentToken ?? null);
  const spotlight = sessions.find((session) => session.id === spotlightId) ?? null;
  const focusSession = sessions.find((session) => session.id === focusId) ?? null;
  const openSessions = sessions.filter((session) => session.status !== "ended");
  const endedSessions = sessions.filter((session) => session.status === "ended").slice(0, 6);
  const waitingCount = openSessions.filter((session) => session.status === "waiting").length;

  function enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = tail.current.then(work, work);
    tail.current = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  function mutate(work: () => Promise<void>): Promise<void> {
    mutationEpoch.current += 1;
    inflight.current += 1;
    return enqueue(work).finally(() => {
      inflight.current -= 1;
      mutationEpoch.current += 1;
    });
  }

  function replaceSession(updated: Session): void {
    setSessions((current) => current.map((item) => (item.id === updated.id ? updated : item)));
  }

  useEffect(() => {
    writeStorage(NAME_KEY, nameRef.current);
  }, [name]);

  useEffect(() => {
    if (!focusSession || notesSessionId === focusSession.id) return;
    setNotesSessionId(focusSession.id);
    setNotesDraft(focusSession.acwNotes);
    savedNotes.current = focusSession.acwNotes;
  }, [focusSession, notesSessionId]);

  useEffect(() => {
    if (!focusId || notesSessionId !== focusId) return;
    if (notesDraft === savedNotes.current) return;
    const sessionId = focusId;
    const value = notesDraft;
    const handle = window.setTimeout(() => {
      if (value === savedNotes.current) return;
      void mutate(async () => {
        if (value === savedNotes.current) return;
        const updated = await patchSession(sessionId, nameRef.current, { acwNotes: value });
        savedNotes.current = value;
        replaceSession(updated);
      }).catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "Could not save notes.");
      });
    }, 450);
    return () => window.clearTimeout(handle);
  }, [notesDraft, focusId, notesSessionId]);

  useEffect(() => {
    let cancelled = false;
    let timer = 0;

    const loop = async () => {
      if (cancelled) return;
      if (inflight.current > 0) {
        timer = window.setTimeout(loop, POLL_MS);
        return;
      }
      const epochAtStart = mutationEpoch.current;
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
          if (inflight.current === 0 && epochAtStart === mutationEpoch.current) {
            setSessions(body.sessions);
            setLoadError(null);
          }
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
      const sessionId = call.sessionId;
      setCall(null);
      writeStorage(CALL_KEY, null);
      if (match?.status === "ended") {
        setAcwId(sessionId);
        writeStorage(ACW_KEY, sessionId);
        setNotice("Session ended. Finish after-call work: notes, stills, and a disposition.");
      }
    }
  }, [loaded, apiUp, loadError, call, sessions]);

  function openAcw(sessionId: string) {
    setAcwId(sessionId);
    writeStorage(ACW_KEY, sessionId);
    setNotice(null);
  }

  function closeAcw() {
    setAcwId(null);
    writeStorage(ACW_KEY, null);
  }

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
      await mutate(async () => {
        const session = await createSession(nameRef.current);
        setSessions((current) => [session, ...current.filter((item) => item.id !== session.id)]);
        setSpotlightId(session.id);
        writeStorage(SPOTLIGHT_KEY, session.id);
      });
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
      await mutate(async () => {
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
        setAcwId(null);
        writeStorage(ACW_KEY, null);
        setSessions((current) =>
          current.map((item) => (item.id === session.id ? { ...item, status: "in_call" } : item)),
        );
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not accept the session.");
    } finally {
      setBusy(null);
    }
  }

  async function flushNotes(): Promise<void> {
    if (!focusId || notesDraft === savedNotes.current) return;
    const sessionId = focusId;
    const value = notesDraft;
    await mutate(async () => {
      if (value === savedNotes.current) return;
      const updated = await patchSession(sessionId, nameRef.current, { acwNotes: value });
      savedNotes.current = value;
      replaceSession(updated);
    });
  }

  async function onEnd(sessionId: string) {
    setBusy(sessionId);
    setError(null);
    try {
      await flushNotes();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save notes.");
    }
    try {
      await mutate(async () => {
        await endSession(sessionId, nameRef.current);
        setSessions((current) =>
          current.map((item) => (item.id === sessionId ? { ...item, status: "ended" } : item)),
        );
        if (call?.sessionId === sessionId) {
          setCall(null);
          writeStorage(CALL_KEY, null);
        }
        setAcwId(sessionId);
        writeStorage(ACW_KEY, sessionId);
        setNotice("Session ended. Finish after-call work: notes, stills, and a disposition.");
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not end the session.");
    } finally {
      setBusy(null);
    }
  }

  async function onToggle(itemId: string, checked: boolean) {
    if (!focusId) return;
    const sessionId = focusId;
    setSessions((current) =>
      current.map((item) =>
        item.id === sessionId
          ? {
              ...item,
              checklist: item.checklist.map((entry) => (entry.id === itemId ? { ...entry, checked } : entry)),
            }
          : item,
      ),
    );
    try {
      await mutate(async () => {
        const updated = await patchSession(sessionId, nameRef.current, {
          checklist: [{ id: itemId, checked }],
        });
        replaceSession(updated);
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update the checklist.");
    }
  }

  async function onUpload(file: Blob | File, kind: CaptureKind) {
    if (!focusId) return;
    const sessionId = focusId;
    setError(null);
    try {
      await mutate(async () => {
        const capture = await captures.submit(file, { kind, capturedAt: new Date().toISOString() });
        setSessions((current) =>
          current.map((item) =>
            item.id === sessionId && !item.captures.some((existing) => existing.id === capture.id)
              ? { ...item, captures: [...item.captures, capture] }
              : item,
          ),
        );
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the still.");
    }
  }

  async function onCaptureVideo(kind: CaptureKind) {
    const video = remoteRef.current;
    const track = media?.remoteVideoTrack;
    const liveTrack = track && track.readyState === "live" ? track : null;
    if (!liveTrack && !video) {
      setError("Customer video is not on screen.");
      return;
    }
    try {
      const blob = liveTrack
        ? await captureVideoStill(liveTrack, { video, mimeType: "image/jpeg" })
        : await blobFromVideoFrame(video!);
      await onUpload(blob, kind);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not capture the video frame.");
    }
  }

  async function onDisposition(value: Disposition) {
    if (!focusId) return;
    const sessionId = focusId;
    setError(null);
    try {
      await flushNotes();
      await mutate(async () => {
        const updated = await patchSession(sessionId, nameRef.current, { disposition: value });
        replaceSession(updated);
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the disposition.");
    }
  }

  const phase = call ? "call" : acwId ? "acw" : null;
  const workspace =
    phase && focusSession ? (
      <KycWorkspace
        phase={phase}
        onboarding={focusSession.onboardingPayload}
        checklist={focusSession.checklist}
        captures={focusSession.captures}
        notes={notesSessionId === focusSession.id ? notesDraft : focusSession.acwNotes}
        disposition={focusSession.disposition}
        busy={busy !== null}
        capturePending={captures.pending}
        onToggle={(itemId, checked) => void onToggle(itemId, checked)}
        onNotes={setNotesDraft}
        onNotesBlur={() => void flushNotes().catch((err: unknown) => {
          setError(err instanceof Error ? err.message : "Could not save notes.");
        })}
        onUpload={(file, kind) => void onUpload(file, kind)}
        onCaptureVideo={phase === "call" ? (kind) => void onCaptureVideo(kind) : undefined}
        onDisposition={(value) => void onDisposition(value)}
      />
    ) : null;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="mark" aria-hidden="true" />
          <div>
            <p className="eyebrow">Superbank · Video KYC</p>
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
              <h2>In call{focusSession ? ` · ${focusSession.onboardingPayload.fullName}` : ""}</h2>
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

      {call ? workspace : null}

      {!call && acwId ? (
        <section className="acw-wrap" aria-label="After-call work">
          <div className="panel acw-head">
            <div>
              <h2>After-call work{focusSession ? ` · ${focusSession.onboardingPayload.fullName}` : ""}</h2>
              <p className="muted">
                {focusSession
                  ? `${focusSession.onboardingPayload.applicationId} · ${dispositionLabel(focusSession.disposition)}`
                  : "Loading the session…"}
              </p>
            </div>
            <button type="button" className="ghost" onClick={closeAcw}>
              Close
            </button>
          </div>
          {focusSession ? workspace : loaded ? (
            <p className="banner bad" role="status">
              That session is gone. The API keeps sessions in memory, and a restart clears them.
            </p>
          ) : (
            <p className="muted">Loading after-call work…</p>
          )}
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
              <OnboardingFacts payload={spotlight.onboardingPayload} />
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
            <span className="count">{waitingCount} waiting</span>
          </div>
          {openSessions.length === 0 ? (
            <p className="muted">No open sessions. New ones show up here within a couple of seconds.</p>
          ) : (
            <ul className="queue">
              {openSessions.map((session) => (
                <li key={session.id} className="queue-item">
                  <div className="queue-id">
                    <StatusPill status={session.status} />
                    <strong>{session.onboardingPayload.fullName}</strong>
                    <span className="muted">
                      {shortId(session.id)} · {session.createdBy} · {formatWhen(session.createdAt)}
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
          {endedSessions.length > 0 ? (
            <div className="ended-list">
              <h3>After-call</h3>
              <ul className="queue">
                {endedSessions.map((session) => (
                  <li key={session.id} className="queue-item">
                    <div className="queue-id">
                      <span className={`pill pill-${session.disposition ?? "ended"}`}>
                        {dispositionLabel(session.disposition)}
                      </span>
                      <strong>{session.onboardingPayload.fullName}</strong>
                      <span className="muted">
                        {session.captures.length} stills · {formatWhen(session.createdAt)}
                      </span>
                    </div>
                    <button
                      type="button"
                      className="ghost"
                      disabled={call !== null}
                      onClick={() => openAcw(session.id)}
                    >
                      Open ACW
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </section>
      </div>
    </div>
  );
}
