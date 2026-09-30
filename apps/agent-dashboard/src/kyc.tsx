import { useState } from "react";
import { captureSrc, type CaptureKind, type CaptureSummary, type ChecklistItem, type Disposition, type OnboardingPayload } from "./api";

const KINDS: { value: CaptureKind; label: string }[] = [
  { value: "face", label: "Face" },
  { value: "id", label: "ID" },
  { value: "other", label: "Other" },
];

const DISPOSITIONS: { value: Disposition; label: string }[] = [
  { value: "approve", label: "Approve" },
  { value: "reject", label: "Reject" },
  { value: "utv", label: "UTV" },
];

function kindLabel(kind: CaptureKind): string {
  return KINDS.find((item) => item.value === kind)?.label ?? kind;
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
  busy,
  capturePending,
  onToggle,
  onNotes,
  onNotesBlur,
  onUpload,
  onCaptureVideo,
  onDisposition,
}: {
  phase: "call" | "acw";
  onboarding: OnboardingPayload;
  checklist: ChecklistItem[];
  captures: CaptureSummary[];
  notes: string;
  disposition: Disposition | null;
  busy: boolean;
  capturePending: boolean;
  onToggle: (id: string, checked: boolean) => void;
  onNotes: (value: string) => void;
  onNotesBlur?: () => void;
  onUpload: (file: File, kind: CaptureKind) => void;
  onCaptureVideo?: (kind: CaptureKind) => void;
  onDisposition: (value: Disposition) => void;
}) {
  const [kind, setKind] = useState<CaptureKind>("face");
  const needsStill = captures.length === 0;

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
              <select value={kind} onChange={(event) => setKind(event.target.value as CaptureKind)}>
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
