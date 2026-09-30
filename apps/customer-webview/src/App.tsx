import { useEffect, useRef, useState, type ReactNode, type Ref } from "react";
import { ApiError, createCustomerSession, fetchJoin, type JoinInfo } from "./api";
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
}: {
  label: string;
  slot: "local" | "remote";
  videoRef?: Ref<HTMLVideoElement>;
  idGuide?: boolean;
}) {
  return (
    <section className={`tile tile-${slot}`} aria-label={label}>
      <video ref={videoRef} data-livekit={slot} autoPlay muted={slot === "local"} playsInline />
      {slot === "local" && idGuide ? <IdCaptureGuide /> : null}
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

function JoinScreen({ token }: { token: string }) {
  const [info, setInfo] = useState<JoinInfo | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
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
      <div className={idGuide ? "stage stage-id-guide" : "stage"} data-capture-guide={idGuide ? "id" : "off"}>
        <VideoTile label="Agent" slot="remote" videoRef={remoteRef} />
        <VideoTile label="You" slot="local" idGuide={idGuide} />
      </div>
      <div className="media-note">
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
