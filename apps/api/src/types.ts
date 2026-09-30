export type SessionStatus = "waiting" | "in_call" | "ended";

export type Disposition = "approve" | "reject" | "utv";

export type CaptureKind = "face" | "id" | "other";

export type ImageContentType = "image/jpeg" | "image/png";

export interface OnboardingPayload {
  fullName: string;
  phone: string;
  productId: string;
  applicationId: string;
  reason: string;
}

export interface ChecklistItem {
  id: string;
  label: string;
  checked: boolean;
}

export interface CaptureRecord {
  id: string;
  kind: CaptureKind;
  contentType: ImageContentType;
  createdAt: string;
  capturedAt: string;
}

export interface CaptureSummary extends CaptureRecord {
  url: string;
  path: string;
}

export interface Session {
  id: string;
  joinToken: string;
  status: SessionStatus;
  roomName: string;
  createdAt: string;
  createdBy: string;
  /** Store-only FIFO tie-break. Not part of the HTTP session body. */
  arrival: number;
  acceptedAt?: string;
  endedAt?: string;
  /** Demo agent name that claimed this session. Null until claim or accept. */
  claimedBy: string | null;
  onboardingPayload: OnboardingPayload;
  checklist: ChecklistItem[];
  acwNotes: string;
  disposition: Disposition | null;
  /**
   * Kind the desk is capturing right now. `id` turns the customer ID
   * wireframe on. `face`, `other`, and `null` leave it off.
   */
  captureGuide: CaptureKind | null;
  captures: CaptureRecord[];
}

export interface SessionResponse {
  id: string;
  joinUrl: string;
  joinToken: string;
  status: SessionStatus;
  roomName: string;
  createdAt: string;
  createdBy: string;
  onboardingPayload: OnboardingPayload;
  checklist: ChecklistItem[];
  acwNotes: string;
  disposition: Disposition | null;
  captureGuide: CaptureKind | null;
  captures: CaptureSummary[];
  claimedBy: string | null;
  /** 1-based place among waiting sessions. Null once the session is in call or ended. */
  queuePosition: number | null;
}
