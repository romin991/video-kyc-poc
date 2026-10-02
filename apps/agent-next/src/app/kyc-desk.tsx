"use client";

import { useEffect, useRef, useState } from "react";
import { blobToDataURL, captureRemoteStill } from "@/lib/captureStill";
import {
  getSession,
  patchSession,
  uploadCapture,
  type CaptureKind,
  type Disposition,
  type MaField,
  type Session,
} from "@/lib/api";

const KINDS: { value: CaptureKind; label: string }[] = [
  { value: "face", label: "Face" },
  { value: "id", label: "ID" },
  { value: "selfie_ktp", label: "Selfie + KTP" },
  { value: "other", label: "Extra doc" },
];

const DISPOSITIONS: { value: Disposition; label: string }[] = [
  { value: "approve", label: "Approve" },
  { value: "reject", label: "Reject" },
  { value: "utv", label: "UTV" },
];

const MA_FIELDS: { field: MaField; ask: string; label: string }[] = [
  { field: "full_name", ask: "Ask full name", label: "Full name" },
  { field: "dob", ask: "Ask date of birth", label: "Date of birth" },
  { field: "mothers_maiden_name", ask: "Ask mother's maiden name", label: "Mother's maiden name" },
];

function kindLabel(kind: CaptureKind): string {
  return KINDS.find((item) => item.value === kind)?.label ?? kind;
}

function fieldLabel(field: MaField): string {
  return MA_FIELDS.find((item) => item.field === field)?.label ?? field;
}

function playbackKind(url: string): "video" | "audio" | null {
  let pathname = url;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return null;
  }
  const ext = pathname.slice(pathname.lastIndexOf(".") + 1).toLowerCase();
  if (ext === "mp4" || ext === "webm" || ext === "mov" || ext === "m4v" || ext === "ogv") return "video";
  if (ext === "mp3" || ext === "wav" || ext === "ogg" || ext === "m4a") return "audio";
  return null;
}

function MatchToggle({
  label,
  value,
  testId,
  disabled,
  onChange,
}: {
  label: string;
  value: boolean | null;
  testId: string;
  disabled: boolean;
  onChange: (value: boolean | null) => void;
}) {
  return (
    <div className="match" role="group" aria-label={label} data-kyc={testId}>
      <button
        type="button"
        className="ghost choice"
        aria-pressed={value === true}
        disabled={disabled}
        onClick={() => onChange(value === true ? null : true)}
      >
        Pass
      </button>
      <button
        type="button"
        className="ghost choice choice-fail"
        aria-pressed={value === false}
        disabled={disabled}
        onClick={() => onChange(value === false ? null : false)}
      >
        Fail
      </button>
    </div>
  );
}

export function KycDesk({
  sessionId,
  agentName,
  phase = "call",
}: {
  sessionId: string;
  agentName: string;
  phase?: "call" | "acw";
}) {
  const [session, setSession] = useState<Session | null>(null);
  const [kind, setKind] = useState<CaptureKind>("face");
  const [digits, setDigits] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [savingStill, setSavingStill] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const writeGen = useRef(0);
  const kindSynced = useRef(false);
  const notesTouched = useRef(false);
  const savedNotes = useRef("");

  useEffect(() => {
    if (!session || kindSynced.current) return;
    kindSynced.current = true;
    if (session.captureGuide) setKind(session.captureGuide);
  }, [session]);

  useEffect(() => {
    if (!session || notesTouched.current) return;
    setNotes(session.acwNotes);
    savedNotes.current = session.acwNotes;
  }, [session]);

  useEffect(() => {
    let gone = false;
    let timer = 0;
    const tick = async () => {
      const seen = writeGen.current;
      try {
        const next = await getSession(sessionId, agentName);
        if (!gone && writeGen.current === seen) setSession(next);
      } catch (err) {
        if (!gone && writeGen.current === seen) {
          setError(err instanceof Error ? err.message : "Could not load the session.");
        }
      }
      if (!gone) timer = window.setTimeout(() => void tick(), 2000);
    };
    void tick();
    return () => {
      gone = true;
      window.clearTimeout(timer);
    };
  }, [sessionId, agentName]);

  async function mutate(work: () => Promise<Session>) {
    const gen = ++writeGen.current;
    setBusy(true);
    setError(null);
    try {
      const next = await work();
      if (writeGen.current === gen) setSession(next);
    } catch (err) {
      if (writeGen.current === gen) setError(err instanceof Error ? err.message : "Request failed.");
    } finally {
      if (writeGen.current === gen) setBusy(false);
    }
  }

  async function saveStill(image: string) {
    setSavingStill(true);
    setError(null);
    const gen = ++writeGen.current;
    try {
      await uploadCapture(sessionId, agentName, image, kind);
      const next = await getSession(sessionId, agentName);
      if (writeGen.current === gen) setSession(next);
    } catch (err) {
      if (writeGen.current === gen) setError(err instanceof Error ? err.message : "Could not save the still.");
    } finally {
      if (writeGen.current === gen) setSavingStill(false);
    }
  }

  async function flushNotes() {
    const value = notes;
    if (value === savedNotes.current) return;
    const gen = ++writeGen.current;
    setError(null);
    try {
      const next = await patchSession(sessionId, agentName, { acwNotes: value });
      if (writeGen.current !== gen) return;
      savedNotes.current = value;
      notesTouched.current = false;
      setSession(next);
    } catch (err) {
      if (writeGen.current === gen) {
        setError(err instanceof Error ? err.message : "Could not save notes.");
      }
    }
  }

  const cleaned = digits.replace(/\s+/g, "");
  const digitsReady = /^\d{4,6}$/.test(cleaned);
  const locked = busy || savingStill;
  const needsStill = (session?.captures.length ?? 0) === 0;
  const playback = session?.recordingUrl ? playbackKind(session.recordingUrl) : null;
  const savedLabel = DISPOSITIONS.find((item) => item.value === session?.disposition)?.label;

  return (
    <div className="kyc" data-kyc={phase === "acw" ? "acw" : "desk"}>
      {error ? <p className="problem">{error}</p> : null}
      {!session ? <p className="meta">Loading the session…</p> : null}

      <section className="panel" aria-labelledby="kyc-checklist-heading">
        <h2 id="kyc-checklist-heading">Checklist</h2>
        <ul className="checklist" data-kyc="checklist">
          {(session?.checklist ?? []).map((item) => (
            <li key={item.id}>
              <label>
                <input
                  type="checkbox"
                  checked={item.checked}
                  disabled={!session || locked}
                  onChange={(event) =>
                    void mutate(() =>
                      patchSession(sessionId, agentName, {
                        checklist: [{ id: item.id, checked: event.target.checked }],
                      }),
                    )
                  }
                />
                <span>{item.label}</span>
              </label>
            </li>
          ))}
        </ul>
        <p className="meta">Thin ticks only. Pass and fail are stub toggles, not a bureau result.</p>
      </section>

      <section className="panel" aria-labelledby="kyc-stills-heading">
        <h2 id="kyc-stills-heading">Stills</h2>
        <div className="capture-actions">
          <label className="kind-field">
            <span>Kind</span>
            <select
              data-kyc="capture-kind"
              value={kind}
              disabled={locked}
              onChange={(event) => {
                const next = event.target.value as CaptureKind;
                setKind(next);
                void mutate(() => patchSession(sessionId, agentName, { captureGuide: next }));
              }}
            >
              {KINDS.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          {phase === "call" ? (
            <button
              type="button"
              className="primary"
              data-kyc="capture-still"
              disabled={!session || locked}
              onClick={() =>
                void (async () => {
                  try {
                    const blob = await captureRemoteStill();
                    await saveStill(await blobToDataURL(blob));
                  } catch (err) {
                    setError(err instanceof Error ? err.message : "Could not capture the customer video.");
                  }
                })()
              }
            >
              {savingStill ? "Saving…" : "Capture still"}
            </button>
          ) : null}
          <label className="ghost file-btn">
            {savingStill ? "Saving…" : "Add still"}
            <input
              type="file"
              accept="image/jpeg,image/png,.jpg,.jpeg,.png"
              disabled={!session || locked}
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (!file) return;
                const reader = new FileReader();
                reader.onload = () => void saveStill(String(reader.result));
                reader.onerror = () => setError("Could not read the still.");
                reader.readAsDataURL(file);
              }}
            />
          </label>
        </div>
        {kind === "id" ? (
          <p className="meta" data-kyc="id-guide">
            ID guide is on. The customer is asked to align ID inside the box.
          </p>
        ) : null}
        {kind === "selfie_ktp" ? (
          <p className="meta" data-kyc="selfie-ktp-kind">
            Selfie + KTP still. The card outline stays off.
          </p>
        ) : null}
        {(session?.captures.length ?? 0) === 0 ? (
          <p className="meta">No stills yet. Capture the customer video, or add a JPEG or PNG.</p>
        ) : (
          <ul className="capture-grid" data-kyc="captures">
            {session?.captures.map((capture) => (
              <li key={capture.id}>
                <figure>
                  <img src={capture.url} alt={`${kindLabel(capture.kind)} still`} />
                  <figcaption>{kindLabel(capture.kind)}</figcaption>
                </figure>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel" aria-labelledby="kyc-ma-heading" data-kyc="manual-auth">
        <h2 id="kyc-ma-heading">Manual authentication</h2>
        <div className="ma-grid">
          <div>
            <h3>Questions</h3>
            {phase === "call" ? (
              <div className="ma-actions">
                {MA_FIELDS.map((item) => (
                  <button
                    key={item.field}
                    type="button"
                    className="ghost"
                    data-ma-field={item.field}
                    disabled={!session || locked}
                    onClick={() => void mutate(() => patchSession(sessionId, agentName, { maPrompt: { field: item.field } }))}
                  >
                    {item.ask}
                  </button>
                ))}
                {session?.maPrompt ? (
                  <button
                    type="button"
                    className="ghost"
                    disabled={locked}
                    onClick={() => void mutate(() => patchSession(sessionId, agentName, { maPrompt: null }))}
                  >
                    Clear question
                  </button>
                ) : null}
              </div>
            ) : (
              <p className="meta">Questions close when the call ends. Answers stay on this session.</p>
            )}
            {session?.maPrompt ? (
              <p data-kyc="ma-waiting">Waiting for an answer: {session.maPrompt.prompt}</p>
            ) : (
              <p className="meta">No question on the customer screen.</p>
            )}
            {(session?.maAnswers.length ?? 0) === 0 ? (
              <p className="meta">No answers yet.</p>
            ) : (
              <ul className="ma-log" data-kyc="ma-answers">
                {session?.maAnswers.map((item) => (
                  <li key={item.field}>
                    <span>{fieldLabel(item.field)}</span>
                    <strong>{item.answer}</strong>
                  </li>
                ))}
              </ul>
            )}
            <MatchToggle
              label="Stub identity match"
              value={session?.maMatch ?? null}
              testId="ma-match"
              disabled={!session || locked}
              onChange={(value) => void mutate(() => patchSession(sessionId, agentName, { maMatch: value }))}
            />
            <p className="meta">Stub only. Pass checks Identity match. Nothing is sent to a bureau.</p>
          </div>
          <div>
            <h3>Digit liveness</h3>
            {phase === "call" ? (
              <form
                className="digit-ask"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (!digitsReady) return;
                  const value = cleaned;
                  setDigits("");
                  void mutate(() => patchSession(sessionId, agentName, { digitChallenge: { digits: value } }));
                }}
              >
                <label className="kind-field">
                  <span>Digits</span>
                  <input
                    value={digits}
                    inputMode="numeric"
                    autoComplete="off"
                    maxLength={11}
                    placeholder="4 to 6 digits"
                    data-kyc="digit-input"
                    onChange={(event) => setDigits(event.target.value)}
                  />
                </label>
                <button
                  type="button"
                  className="ghost"
                  disabled={locked}
                  onClick={() => setDigits(Array.from({ length: 4 }, () => Math.floor(Math.random() * 10)).join(""))}
                >
                  Random
                </button>
                <button type="submit" className="primary" disabled={!session || locked || !digitsReady}>
                  Ask digits
                </button>
              </form>
            ) : null}
            {phase === "call" && session?.digitChallenge ? (
              <button
                type="button"
                className="ghost"
                disabled={locked}
                onClick={() => void mutate(() => patchSession(sessionId, agentName, { digitChallenge: null }))}
              >
                Clear digits
              </button>
            ) : null}
            {session?.digitChallenge ? (
              <p data-kyc="digit-waiting">
                Waiting for digits <span className="digit-readout">{session.digitChallenge.digits}</span>
              </p>
            ) : (
              <p className="meta">No digit prompt on the customer screen.</p>
            )}
            <p data-kyc="digit-response">
              {session?.digitResponse ? (
                <>
                  Customer typed <strong>{session.digitResponse}</strong>
                </>
              ) : (
                <span className="meta">No digit reply yet.</span>
              )}
            </p>
            <MatchToggle
              label="Stub digit match"
              value={session?.digitMatch ?? null}
              testId="digit-match"
              disabled={!session || locked}
              onChange={(value) => void mutate(() => patchSession(sessionId, agentName, { digitMatch: value }))}
            />
            <p className="meta">Stub only. A reply checks Liveness digits spoken. Pass does not score a model.</p>
          </div>
        </div>
      </section>

      {phase === "acw" ? (
        <section className="panel" aria-labelledby="kyc-recording-heading" data-kyc="recording">
          <h2 id="kyc-recording-heading">Call recording</h2>
          {session?.recordingUrl ? (
            <div className="recording">
              <a href={session.recordingUrl} target="_blank" rel="noopener noreferrer" data-kyc="recording-link">
                Play or download recording
              </a>
              {playback === "video" ? (
                <video controls playsInline src={session.recordingUrl} data-kyc="recording-player" />
              ) : null}
              {playback === "audio" ? <audio controls src={session.recordingUrl} data-kyc="recording-player" /> : null}
              <p className="mono recording-url">{session.recordingUrl}</p>
              {session.recordingId ? (
                <p className="meta" data-kyc="recording-id">
                  Recording id {session.recordingId}
                </p>
              ) : null}
            </div>
          ) : (
            <p className="meta" data-kyc="recording-empty">
              {session?.recordingId
                ? `Recording id ${session.recordingId}. No playback URL yet.`
                : "No recording attached yet. LiveKit egress can attach a URL after the call."}
            </p>
          )}
        </section>
      ) : null}

      <section className="panel" aria-labelledby="kyc-notes-heading">
        <h2 id="kyc-notes-heading">ACW notes</h2>
        <textarea
          id="acw-notes"
          value={notes}
          maxLength={4000}
          disabled={!session || locked}
          placeholder="What happened on the call, and anything ops should know."
          onChange={(event) => {
            notesTouched.current = true;
            setNotes(event.target.value);
          }}
          onBlur={() => void flushNotes()}
        />
        {phase === "call" ? (
          <p className="meta">Notes save on the session. Disposition waits until after-call work.</p>
        ) : null}
      </section>

      {phase === "acw" ? (
        <section className="panel" aria-labelledby="kyc-disposition-heading">
          <h2 id="kyc-disposition-heading">Disposition</h2>
          <div className="disposition" role="group" aria-label="Disposition" data-kyc="disposition">
            {DISPOSITIONS.map((item) => (
              <button
                key={item.value}
                type="button"
                className={`choice choice-${item.value}`}
                data-disposition={item.value}
                aria-pressed={session?.disposition === item.value}
                disabled={!session || locked || needsStill}
                onClick={() => void mutate(() => patchSession(sessionId, agentName, { disposition: item.value }))}
              >
                {item.label}
              </button>
            ))}
          </div>
          {needsStill ? (
            <p className="meta">Add at least one still before confirming Approve, Reject, or UTV.</p>
          ) : (
            <p className="meta">
              {savedLabel
                ? `Saved: ${savedLabel}.`
                : "Choose a disposition. It is saved on this session."}{" "}
              Each choice is stored on the session and sent to the CRM and datalake stubs.
            </p>
          )}
        </section>
      ) : null}
    </div>
  );
}
