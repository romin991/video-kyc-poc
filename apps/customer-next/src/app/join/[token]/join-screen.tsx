"use client";

import { useCallMedia } from "@vkyc/livekit";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ApiError, endSession, fetchJoin, postJoinReply, serverUrlFor, type DigitChallenge, type JoinInfo, type MaPrompt } from "@/lib/api";
import { postCustomerEvent } from "@/lib/wk-bridge";

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

function VideoTile({ label, slot, idGuide = false }: { label: string; slot: "local" | "remote"; idGuide?: boolean }) {
  return (
    <section className={`tile tile-${slot}`} aria-label={label}>
      <video data-livekit={slot} autoPlay muted={slot === "local"} playsInline />
      {idGuide ? <IdCaptureGuide /> : null}
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

function InCall({ info, token, onEnded }: { info: JoinInfo; token: string; onEnded: () => void }) {
  const serverUrl = serverUrlFor(info.livekitUrl);
  const media = useCallMedia({
    serverUrl: serverUrl || null,
    token: info.customerToken,
    roomName: info.roomName,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [maDraft, setMaDraft] = useState("");
  const [digitDraft, setDigitDraft] = useState("");
  const [sending, setSending] = useState<"ma" | "digit" | null>(null);
  const [replyNote, setReplyNote] = useState<string | null>(null);
  const [replyError, setReplyError] = useState<string | null>(null);
  const [hideMaSentAt, setHideMaSentAt] = useState<string | null>(null);
  const [hideDigitSentAt, setHideDigitSentAt] = useState<string | null>(null);

  const maPrompt: MaPrompt | null = info.maPrompt && info.maPrompt.sentAt !== hideMaSentAt ? info.maPrompt : null;
  const digitChallenge: DigitChallenge | null =
    info.digitChallenge && info.digitChallenge.sentAt !== hideDigitSentAt ? info.digitChallenge : null;
  const idGuide = info.captureGuide === "id";

  useEffect(() => {
    if (maPrompt || digitChallenge) setReplyNote(null);
  }, [maPrompt, digitChallenge]);

  useEffect(() => {
    if (media.phase === "connected") {
      postCustomerEvent("connected");
      if (media.error) postCustomerEvent("error", media.error);
    } else if (media.phase === "error") {
      postCustomerEvent("error", media.error ?? (media.detail || "LiveKit connect failed"));
    }
  }, [media.phase, media.error, media.detail]);

  return (
      <div className="call" data-call="active" data-status="in_call" data-room-name={info.roomName} data-call-phase={media.phase}>
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
                const message = err instanceof Error ? err.message : "Could not end the session.";
                setError(message);
                setBusy(false);
                postCustomerEvent("error", message);
              });
          }}
        >
          {busy ? "Ending…" : "End session"}
        </button>
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
      <div className={idGuide ? "stage stage-id" : "stage"} data-capture-guide={idGuide ? "id" : "off"}>
        <VideoTile label="Agent" slot="remote" />
        <VideoTile label="You" slot="local" idGuide={idGuide} />
      </div>
      <p className="media-note" data-media-detail={media.detail}>
        {media.detail || "Preparing the LiveKit connect point."}
      </p>
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

  useEffect(() => {
    if (fatal) postCustomerEvent("error", fatal);
  }, [fatal]);

  useEffect(() => {
    if (info?.status === "ended") postCustomerEvent("ended");
  }, [info?.status]);

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
        {info.displayName ? <p data-display-name={info.displayName}>{info.displayName}</p> : null}
        <p>
          {place
            ? `You are ${place} in line. Keep this window open. The call starts when an agent claims you.`
            : "Keep this window open. The call starts when an agent claims you."}
        </p>
        <p className="mono">Session {info.sessionId.slice(0, 8)}</p>
        {problem ? <p className="problem">{problem} Retrying…</p> : null}
      </div>
    );
  } else {
    body = (
      <InCall
        info={info}
        token={token}
        onEnded={() => {
          closed.current = true;
          setInfo({ ...info, status: "ended", queuePosition: null });
        }}
      />
    );
  }

  return <Shell>{body}</Shell>;
}
