import { useState } from "react";
import {
  captureSrc,
  type CaptureKind,
  type CaptureSummary,
  type ChecklistItem,
  type DigitChallenge,
  type Disposition,
  type MaAnswer,
  type MaField,
  type MaPrompt,
  type OnboardingPayload,
} from "./api";

const KINDS: { value: CaptureKind; label: string }[] = [
  { value: "face", label: "Face" },
  { value: "id", label: "ID" },
  { value: "selfie_ktp", label: "Selfie + KTP" },
  { value: "other", label: "Extra doc" },
];

const MA_FIELDS: { field: MaField; label: string; ask: string }[] = [
  { field: "full_name", label: "Full name", ask: "Ask full name" },
  { field: "dob", label: "Date of birth", ask: "Ask date of birth" },
  { field: "mothers_maiden_name", label: "Mother's maiden name", ask: "Ask mother's maiden name" },
];

const DISPOSITIONS: { value: Disposition; label: string }[] = [
  { value: "approve", label: "Approve" },
  { value: "reject", label: "Reject" },
  { value: "utv", label: "UTV" },
];

function kindLabel(kind: CaptureKind): string {
  return KINDS.find((item) => item.value === kind)?.label ?? kind;
}

function fieldLabel(field: MaField): string {
  return MA_FIELDS.find((item) => item.field === field)?.label ?? field;
}

function MatchToggle({
  label,
  value,
  busy,
  testId,
  onChange,
}: {
  label: string;
  value: boolean | null;
  busy: boolean;
  testId: string;
  onChange: (value: boolean | null) => void;
}) {
  return (
    <div className="disposition" role="group" aria-label={label} data-kyc={testId}>
      <button
        type="button"
        className="choice"
        aria-pressed={value === true}
        disabled={busy}
        onClick={() => onChange(value === true ? null : true)}
      >
        Pass
      </button>
      <button
        type="button"
        className="choice choice-reject"
        aria-pressed={value === false}
        disabled={busy}
        onClick={() => onChange(value === false ? null : false)}
      >
        Fail
      </button>
    </div>
  );
}

function DigitAsk({ busy, onAsk }: { busy: boolean; onAsk: (digits: string) => void }) {
  const [digits, setDigits] = useState("");
  const cleaned = digits.replace(/\s+/g, "");
  const ready = /^\d{4,6}$/.test(cleaned);

  return (
    <form
      className="digit-ask"
      onSubmit={(event) => {
        event.preventDefault();
        if (!ready) return;
        onAsk(cleaned);
        setDigits("");
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
        disabled={busy}
        onClick={() => setDigits(Array.from({ length: 4 }, () => Math.floor(Math.random() * 10)).join(""))}
      >
        Random
      </button>
      <button type="submit" className="primary" disabled={busy || !ready}>
        Ask digits
      </button>
    </form>
  );
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

export function OnboardingFacts({ payload }: { payload: OnboardingPayload }) {
  const rows: [string, string][] = [
    ["Name", payload.fullName],
    ["Phone", payload.phone],
    ["Product", payload.productId],
    ["Application", payload.applicationId],
    ["Reason", payload.reason],
  ];
  return (
    <dl className="facts" data-kyc="onboarding">
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function KycWorkspace({
  phase,
  onboarding,
  checklist,
  captures,
  notes,
  disposition,
  recordingUrl,
  recordingId,
  kind,
  busy,
  capturePending,
  onToggle,
  onNotes,
  onNotesBlur,
  onKind,
  onUpload,
  onCaptureVideo,
  onDisposition,
  maPrompt,
  maAnswers,
  digitChallenge,
  digitResponse,
  maMatch,
  digitMatch,
  onAskMa,
  onClearMa,
  onAskDigits,
  onClearDigits,
  onMaMatch,
  onDigitMatch,
}: {
  phase: "call" | "acw";
  onboarding: OnboardingPayload;
  checklist: ChecklistItem[];
  captures: CaptureSummary[];
  notes: string;
  disposition: Disposition | null;
  recordingUrl: string | null;
  recordingId: string | null;
  kind: CaptureKind;
  busy: boolean;
  capturePending: boolean;
  onToggle: (id: string, checked: boolean) => void;
  onNotes: (value: string) => void;
  onNotesBlur?: () => void;
  onKind: (kind: CaptureKind) => void;
  onUpload: (file: File, kind: CaptureKind) => void;
  onCaptureVideo?: (kind: CaptureKind) => void;
  onDisposition: (value: Disposition) => void;
  maPrompt: MaPrompt | null;
  maAnswers: MaAnswer[];
  digitChallenge: DigitChallenge | null;
  digitResponse: string | null;
  maMatch: boolean | null;
  digitMatch: boolean | null;
  onAskMa: (field: MaField) => void;
  onClearMa: () => void;
  onAskDigits: (digits: string) => void;
  onClearDigits: () => void;
  onMaMatch: (value: boolean | null) => void;
  onDigitMatch: (value: boolean | null) => void;
}) {
  const needsStill = captures.length === 0;
  const playback = recordingUrl ? playbackKind(recordingUrl) : null;

  return (
    <div className="kyc-stack" data-kyc={phase === "acw" ? "acw" : "desk"}>
      <div className="kyc-grid">
        <section className="panel" aria-labelledby="kyc-customer-heading">
          <div className="panel-head">
            <h2 id="kyc-customer-heading">Customer</h2>
          </div>
          <OnboardingFacts payload={onboarding} />
        </section>

        <section className="panel" aria-labelledby="kyc-checklist-heading">
          <div className="panel-head">
            <h2 id="kyc-checklist-heading">Checklist</h2>
          </div>
          <ul className="checklist" data-kyc="checklist">
            {checklist.map((item) => (
              <li key={item.id}>
                <label>
                  <input
                    type="checkbox"
                    checked={item.checked}
                    disabled={busy}
                    onChange={(event) => onToggle(item.id, event.target.checked)}
                  />
                  <span>{item.label}</span>
                </label>
              </li>
            ))}
          </ul>
        </section>

        <section className="panel" aria-labelledby="kyc-stills-heading">
          <div className="panel-head">
            <h2 id="kyc-stills-heading">Stills</h2>
            <span className="count">{captures.length}</span>
          </div>
          <div className="capture-actions">
            <label className="kind-field">
              <span>Kind</span>
              <select
                data-kyc="capture-kind"
                value={kind}
                onChange={(event) => onKind(event.target.value as CaptureKind)}
              >
                {KINDS.map((item) => (
                  <option key={item.value} value={item.value}>
                    {item.label}
                  </option>
                ))}
              </select>
            </label>
            {onCaptureVideo ? (
              <button type="button" className="primary" disabled={busy || capturePending} onClick={() => onCaptureVideo(kind)}>
                {capturePending ? "Saving…" : "Capture still"}
              </button>
            ) : null}
            <label className="ghost file-btn">
              {capturePending ? "Saving…" : "Add still"}
              <input
                id="capture-file"
                type="file"
                accept="image/jpeg,image/png,.jpg,.jpeg,.png"
                disabled={busy || capturePending}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (file) onUpload(file, kind);
                }}
              />
            </label>
          </div>
          {phase === "call" && kind === "id" ? (
            <p className="muted" data-kyc="id-guide">
              ID guide is on. The customer is asked to align ID inside the box.
            </p>
          ) : null}
          {phase === "call" && kind === "selfie_ktp" ? (
            <p className="muted" data-kyc="selfie-ktp-kind">
              Selfie + KTP still. The card outline stays off.
            </p>
          ) : null}
          {captures.length === 0 ? (
            <p className="muted">No stills yet. Capture the customer video, or add a JPEG or PNG.</p>
          ) : (
            <ul className="capture-grid" data-kyc="captures">
              {captures.map((capture) => (
                <li key={capture.id}>
                  <figure>
                    <img src={captureSrc(capture)} alt={`${kindLabel(capture.kind)} still`} />
                    <figcaption>{kindLabel(capture.kind)}</figcaption>
                  </figure>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <section className="panel" aria-labelledby="kyc-ma-heading" data-kyc="manual-auth">
        <div className="panel-head">
          <h2 id="kyc-ma-heading">Manual authentication</h2>
        </div>
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
                    disabled={busy}
                    onClick={() => onAskMa(item.field)}
                  >
                    {item.ask}
                  </button>
                ))}
                {maPrompt ? (
                  <button type="button" className="ghost" disabled={busy} onClick={onClearMa}>
                    Clear question
                  </button>
                ) : null}
              </div>
            ) : (
              <p className="muted">Questions close when the call ends. Answers stay on this session.</p>
            )}
            {maPrompt ? (
              <p data-kyc="ma-waiting">Waiting for an answer: {maPrompt.prompt}</p>
            ) : (
              <p className="muted">No question on the customer screen.</p>
            )}
            {maAnswers.length === 0 ? (
              <p className="muted">No answers yet.</p>
            ) : (
              <ul className="ma-log" data-kyc="ma-answers">
                {maAnswers.map((item) => (
                  <li key={`${item.field}-${item.answeredAt}`}>
                    <span>{fieldLabel(item.field)}</span>
                    <strong>{item.answer}</strong>
                  </li>
                ))}
              </ul>
            )}
            <MatchToggle label="Stub identity match" value={maMatch} busy={busy} testId="ma-match" onChange={onMaMatch} />
            <p className="muted">Stub only. Pass checks Identity match. Nothing is sent to a bureau.</p>
          </div>
          <div>
            <h3>Digit liveness</h3>
            {phase === "call" ? (
              <>
                <DigitAsk busy={busy} onAsk={onAskDigits} />
                {digitChallenge ? (
                  <button type="button" className="ghost" disabled={busy} onClick={onClearDigits}>
                    Clear digits
                  </button>
                ) : null}
              </>
            ) : null}
            {digitChallenge ? (
              <p data-kyc="digit-waiting">
                Waiting for digits <span className="digit-readout">{digitChallenge.digits}</span>
              </p>
            ) : (
              <p className="muted">No digit prompt on the customer screen.</p>
            )}
            <p data-kyc="digit-response">
              {digitResponse ? (
                <>
                  Customer typed <strong>{digitResponse}</strong>
                </>
              ) : (
                <span className="muted">No digit reply yet.</span>
              )}
            </p>
            <MatchToggle
              label="Stub digit match"
              value={digitMatch}
              busy={busy}
              testId="digit-match"
              onChange={onDigitMatch}
            />
            <p className="muted">Stub only. A reply checks Liveness digits spoken. Pass does not score a model.</p>
          </div>
        </div>
      </section>

      {phase === "acw" ? (
        <section className="panel" aria-labelledby="kyc-recording-heading" data-kyc="recording">
          <div className="panel-head">
            <h2 id="kyc-recording-heading">Call recording</h2>
          </div>
          {recordingUrl ? (
            <div className="recording">
              <a
                href={recordingUrl}
                target="_blank"
                rel="noopener noreferrer"
                data-kyc="recording-link"
              >
                Play or download recording
              </a>
              {playback === "video" ? (
                <video controls playsInline src={recordingUrl} data-kyc="recording-player" />
              ) : null}
              {playback === "audio" ? <audio controls src={recordingUrl} data-kyc="recording-player" /> : null}
              <p className="mono recording-url">{recordingUrl}</p>
              {recordingId ? (
                <p className="muted" data-kyc="recording-id">
                  Recording id {recordingId}
                </p>
              ) : null}
            </div>
          ) : (
            <p className="muted" data-kyc="recording-empty">
              {recordingId
                ? `Recording id ${recordingId}. No playback URL yet.`
                : "No recording attached yet. LiveKit egress can attach a URL after the call."}
            </p>
          )}
        </section>
      ) : null}

      <section className="panel" aria-labelledby="kyc-notes-heading">
        <div className="panel-head">
          <h2 id="kyc-notes-heading">ACW notes</h2>
        </div>
        <textarea
          id="acw-notes"
          value={notes}
          maxLength={4000}
          disabled={busy}
          placeholder="What happened on the call, and anything ops should know."
          onChange={(event) => onNotes(event.target.value)}
          onBlur={() => onNotesBlur?.()}
        />
        {phase === "call" ? (
          <p className="muted">Notes save on the session. Disposition waits until after-call work.</p>
        ) : null}
      </section>

      {phase === "acw" ? (
        <section className="panel" aria-labelledby="kyc-disposition-heading">
          <div className="panel-head">
            <h2 id="kyc-disposition-heading">Disposition</h2>
          </div>
          <div className="disposition" role="group" aria-label="Disposition" data-kyc="disposition">
            {DISPOSITIONS.map((item) => (
              <button
                key={item.value}
                type="button"
                className={`choice choice-${item.value}`}
                aria-pressed={disposition === item.value}
                disabled={busy || needsStill}
                onClick={() => onDisposition(item.value)}
              >
                {item.label}
              </button>
            ))}
          </div>
          {needsStill ? (
            <p className="muted">Add at least one still before confirming Approve, Reject, or UTV.</p>
          ) : (
            <p className="muted">
              {disposition
                ? `Saved: ${DISPOSITIONS.find((item) => item.value === disposition)?.label}.`
                : "Choose a disposition. It is saved on this session."}
            </p>
          )}
        </section>
      ) : null}
    </div>
  );
}
