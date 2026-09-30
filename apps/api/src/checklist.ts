import type { ChecklistItem } from "./types.js";

export const DEFAULT_CHECKLIST: readonly ChecklistItem[] = [
  { id: "identity_match", label: "Identity match", checked: false },
  { id: "liveness_digits", label: "Liveness digits spoken", checked: false },
  { id: "docs_shown", label: "Documents shown", checked: false },
];
