import type { CaptureKind, ChecklistItem } from "./types.js";

export const DEFAULT_CHECKLIST: readonly ChecklistItem[] = [
  { id: "identity_match", label: "Identity match", checked: false },
  { id: "liveness_digits", label: "Liveness digits spoken", checked: false },
  { id: "docs_shown", label: "Documents shown", checked: false },
];

const DOC_KINDS = new Set<CaptureKind>(["id", "selfie_ktp", "other"]);

export function setChecklist(checklist: ChecklistItem[], id: string, checked: boolean): void {
  const item = checklist.find((entry) => entry.id === id);
  if (item) item.checked = checked;
}

export function tickChecklist(checklist: ChecklistItem[], id: string): void {
  setChecklist(checklist, id, true);
}

/** ID, selfie+KTP, and extra-doc stills count as documents. A face still does not. */
export function captureShowsDocs(kind: CaptureKind): boolean {
  return DOC_KINDS.has(kind);
}
