import { useEffect, useRef, useState, type ReactNode, type Ref } from "react";
import { ApiError, createCustomerSession, fetchJoin, postJoinReply, type JoinInfo } from "./api";
import { useLiveKit } from "./livekit";

const POLL_MS = 1500;

type Route = { kind: "home" } | { kind: "bad" } | { kind: "join"; token: string };

function readRoute(): Route {
  const path = window.location.pathname.replace(/\/+$/, "") || "/";
  if (path === "/") return { kind: "home" };
  const match = path.match(/^\/join\/([^/]+)$/);
  if (!match?.[1]) return { kind: "bad" };
  try {
    const token = decodeURIComponent(match[1]);
    return token ? { kind: "join", token } : { kind: "bad" };
  } catch {
    return { kind: "bad" };
  }
}

function queuePlace(position: number): string {
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

function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="frame">
      <div className="device">
        <header className="device-bar">
          <span className="mark" aria-hidden="true" />
          <div>
            <p className="eyebrow">Superbank</p>
            <strong>Video verification</strong>
          </div>
        </header>
        <div className="device-body">{children}</div>
      </div>
    </div>
  );
}

function IdCaptureGuide() {
  return (
    <div className="id-guide" data-capture-guide="id" role="status">
      <p className="id-guide-copy">align ID inside the box</p>
      <div className="id-frame" aria-hidden="true">
        <span />
        <span />
        <span />
        <span />
      </div>
    </div>
  );
}

function VideoTile({
  label,
  slot,
  videoRef,
  idGuide = false,
  notice,
}: {
  label: string;
  slot: "local" | "remote";
  videoRef?: Ref<HTMLVideoElement>;
  idGuide?: boolean;
  notice?: string | null;
}) {
  return (
    <section className={`tile tile-${slot}${notice ? " tile-error" : ""}`} aria-label={label}>
      <video ref={videoRef} data-livekit={slot} autoPlay muted={slot === "local"} playsInline />
      {slot === "local" && idGuide && !notice ? <IdCaptureGuide /> : null}
      <div className="tile-fallback">
        {notice ? (
          <p className="tile-error-copy" role="alert" data-local-av-message="">
            {notice}
          </p>
        ) : (
          <>
            <span className="avatar" aria-hidden="true">
              {label.slice(0, 1)}
            </span>
            <p>{label}</p>
            <small>{slot === "local" ? "Your camera" : "Their camera"}</small>
          </>
        )}
      </div>
    </section>
  );
}

function JoinScreen({ token }: { token: string }) {
  const [info, setInfo] = useState<JoinInfo | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [maDraft, setMaDraft] = useState("");
  const [digitDraft, setDigitDraft] = useState("");
  const [sending, setSending] = useState<"ma" | "digit" | null>(null);
  const [replyNote, setReplyNote] = useState<string | null>(null);
  const [replyError, setReplyError] = useState<string | null>(null);
  const [hideMaSentAt, setHideMaSentAt] = useState<string | null>(null);
  const [hideDigitSentAt, setHideDigitSentAt] = useState<string | null>(null);
  const remoteRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    let generation = 0;
    let timer = 0;

    const stop = () => {
      generation += 1;
      window.clearTimeout(timer);
      timer = 0;
    };

    const loop = async () => {
      const ticket = generation;
      try {
        const next = await fetchJoin(token);
        if (ticket !== generation) return;
        setInfo(next);
        setHideMaSentAt((hidden) => (next.maPrompt?.sentAt === hidden ? hidden : null));
        setHideDigitSentAt((hidden) => (next.digitChallenge?.sentAt === hidden ? hidden : null));
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
    return () => {
      stop();
    };
  }, [token]);

  const maPrompt = info?.maPrompt && info.maPrompt.sentAt !== hideMaSentAt ? info.maPrompt : null;
  const digitChallenge =
    info?.digitChallenge && info.digitChallenge.sentAt !== hideDigitSentAt ? info.digitChallenge : null;

  useEffect(() => {
    if (maPrompt || digitChallenge) setReplyNote(null);
  }, [maPrompt, digitChallenge]);

  const media = useLiveKit(
    info?.status === "in_call" ? info.roomName : null,
    info?.status === "in_call" ? info.customerToken : null,
  );

  if (fatal) {
    return (
      <div className="stack">
        <h1>Link not valid</h1>
        <p>{fatal}</p>
      </div>
    );
  }

  if (!info) {
    return (
      <div className="stack">
        <h1>Checking your link</h1>
        <p>{problem ?? "Contacting the verification service…"}</p>
      </div>
    );
  }

  if (info.status === "ended") {
    return (
      <div className="stack">
        <p className="eyebrow">Session {info.sessionId.slice(0, 8)}</p>
        <h1>Session ended</h1>
        <p>The agent closed this verification. You can close the window.</p>
      </div>
    );
  }

  if (info.status === "waiting") {
    const place = info.queuePosition && info.queuePosition > 0 ? queuePlace(info.queuePosition) : null;
    return (
      <div className="stack">
        <span className="pulse" aria-hidden="true" />
        <h1>Waiting for an agent</h1>
        <p>
          {place
            ? `You are ${place} in the queue. Keep this window open. The call starts when an agent claims you.`
            : "Keep this window open. The call starts when an agent claims you from the queue."}
        </p>
        <p className="mono">Session {info.sessionId.slice(0, 8)}</p>
        {problem ? <p className="problem">{problem} Retrying…</p> : null}
      </div>
    );
  }

  const idGuide = info.captureGuide === "id";

  return (
    <div className="call">
      <div className="call-head">
        <div>
          <p className="eyebrow">In call</p>
          <h1>Connected</h1>
        </div>
        <span className="live">Live</span>
      </div>
      <div className="prompts" aria-live="polite">
        {maPrompt ? (
          <form
            className="prompt-card"
            data-kyc="ma-prompt"
            onSubmit={(event) => {
              event.preventDefault();
              const answer = maDraft.trim();
              if (!answer) return;
              const sentAt = maPrompt.sentAt;
              setSending("ma");
              setReplyError(null);
              void postJoinReply(token, { answer })
                .then(() => {
                  setMaDraft("");
                  setHideMaSentAt(sentAt);
                  setReplyNote("Answer sent.");
                  setInfo((current) => (current ? { ...current, maPrompt: null } : current));
                })
                .catch((err: unknown) => {
                  setReplyError(err instanceof Error ? err.message : "Could not send the answer.");
                })
                .finally(() => setSending((current) => (current === "ma" ? null : current)));
            }}
          >
            <p className="eyebrow">Agent question</p>
            <p className="prompt-copy">{maPrompt.prompt}</p>
            <label className="name-field">
              <span>Your answer</span>
              <input
                value={maDraft}
                maxLength={200}
                autoComplete="off"
                data-kyc="ma-answer"
                onChange={(event) => setMaDraft(event.target.value)}
              />
            </label>
            <button type="submit" className="primary" disabled={sending !== null || maDraft.trim().length === 0}>
              {sending === "ma" ? "Sending…" : "Send answer"}
            </button>
          </form>
        ) : null}
        {digitChallenge ? (
          <form
            className="prompt-card"
            data-kyc="digit-prompt"
            onSubmit={(event) => {
              event.preventDefault();
              const digitResponse = digitDraft.trim();
              if (!digitResponse) return;
              const sentAt = digitChallenge.sentAt;
              setSending("digit");
              setReplyError(null);
              void postJoinReply(token, { digitResponse })
                .then(() => {
                  setDigitDraft("");
                  setHideDigitSentAt(sentAt);
                  setReplyNote("Digits sent.");
                  setInfo((current) => (current ? { ...current, digitChallenge: null } : current));
                })
                .catch((err: unknown) => {
                  setReplyError(err instanceof Error ? err.message : "Could not send the digits.");
                })
                .finally(() => setSending((current) => (current === "digit" ? null : current)));
            }}
          >
            <p className="eyebrow">Read these digits</p>
            <p className="digit-readout" data-kyc="digit-readout">
              {digitChallenge.digits}
            </p>
            <p className="prompt-copy">{digitChallenge.prompt}</p>
            <label className="name-field">
              <span>Type the digits</span>
              <input
                value={digitDraft}
                inputMode="numeric"
                autoComplete="off"
                maxLength={16}
                data-kyc="digit-answer"
                onChange={(event) => setDigitDraft(event.target.value)}
              />
            </label>
            <button type="submit" className="primary" disabled={sending !== null || digitDraft.trim().length === 0}>
              {sending === "digit" ? "Sending…" : "Send digits"}
            </button>
          </form>
        ) : null}
        {replyNote && !maPrompt && !digitChallenge ? <p className="sent-note">{replyNote}</p> : null}
        {replyError ? <p className="problem">{replyError}</p> : null}
      </div>
      <div
        className={idGuide ? "stage stage-id-guide" : "stage"}
        data-capture-guide={idGuide ? "id" : "off"}
        data-local-av={media?.localPublishError ? "error" : undefined}
      >
        <VideoTile label="Agent" slot="remote" videoRef={remoteRef} />
        <VideoTile label="You" slot="local" idGuide={idGuide} notice={media?.localPublishError} />
      </div>
      <div className="media-note">
        {media?.localPublishError ? <p className="problem">{media.localPublishError}</p> : null}
        <p>
          {media?.mediaConnected
            ? "LiveKit connected."
            : media?.mediaError
              ? media.mediaError
              : media?.serverUrl
                ? "Connecting to LiveKit…"
                : "Camera and microphone stay off until VITE_LIVEKIT_URL is set. You can keep this window open."}
        </p>
        {problem ? <p className="problem">{problem} Retrying…</p> : null}
        <button type="button" className="ghost" onClick={() => void remoteRef.current?.play()}>
          Enable sound
        </button>
      </div>
    </div>
  );
}

function HomeScreen() {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onEnter() {
    setBusy(true);
    setError(null);
    try {
      const session = await createCustomerSession(name);
      window.location.assign(`/join/${encodeURIComponent(session.joinToken)}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not enter the queue.");
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <h1>Join the queue</h1>
      <p>Enter your name if you want the agent to see it. You will wait until an agent claims the session.</p>
      <label className="name-field">
        <span>Your name</span>
        <input
          value={name}
          maxLength={120}
          spellCheck={false}
          placeholder="Optional"
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <button type="button" className="primary" disabled={busy} onClick={() => void onEnter()}>
        {busy ? "Joining…" : "Enter the queue"}
      </button>
      {error ? <p className="problem">{error}</p> : null}
      <p>Or open the join link the desk copied. It looks like this:</p>
      <p className="mono example">/join/…</p>
    </div>
  );
}

export function App() {
  const route = readRoute();

  return (
    <Shell>
      {route.kind === "home" ? <HomeScreen /> : null}
      {route.kind === "bad" ? (
        <div className="stack">
          <h1>This is not a join link</h1>
          <p>Ask the agent to copy a fresh link from the desk. It should include /join/ and a token.</p>
        </div>
      ) : null}
      {route.kind === "join" ? <JoinScreen token={route.token} /> : null}
    </Shell>
  );
}
