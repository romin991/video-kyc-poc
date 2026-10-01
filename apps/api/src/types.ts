export type SessionStatus = "waiting" | "in_call" | "ended";

export type Disposition = "approve" | "reject" | "utv";

export type CaptureKind = "face" | "id" | "selfie_ktp" | "other";

/** Manual-auth question the agent can put on the customer screen. */
export type MaField = "full_name" | "dob" | "mothers_maiden_name";

export interface MaPrompt {
  field: MaField;
  prompt: string;
  sentAt: string;
}

export interface MaAnswer {
  field: MaField;
  prompt: string;
  answer: string;
  answeredAt: string;
}

export interface DigitChallenge {
  digits: string;
  prompt: string;
  sentAt: string;
}

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
   * wireframe on. `face`, `selfie_ktp`, `other`, and `null` leave it off.
   */
  captureGuide: CaptureKind | null;
  /** Question currently on the customer screen. Null when nothing is waiting. */
  maPrompt: MaPrompt | null;
  /** Customer replies, oldest first. The desk reads this log. */
  maAnswers: MaAnswer[];
  /** Digit prompt currently on the customer screen. Null when nothing is waiting. */
  digitChallenge: DigitChallenge | null;
  /** Latest digits the customer typed. Cleared when a new challenge is sent. */
  digitResponse: string | null;
  digitRespondedAt: string | null;
  /** Stub pass/fail for the manual-auth answers. Not a bureau result. */
  maMatch: boolean | null;
  /** Stub pass/fail for the digit prompt. Not a liveness-model result. */
  digitMatch: boolean | null;
  captures: CaptureRecord[];
  /** LiveKit egress artifact. Webrtc attaches this; the API does not start egress. */
  recordingUrl: string | null;
  recordingId: string | null;
  recordingAttachedAt: string | null;
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
  maPrompt: MaPrompt | null;
  maAnswers: MaAnswer[];
  digitChallenge: DigitChallenge | null;
  digitResponse: string | null;
  digitRespondedAt: string | null;
  maMatch: boolean | null;
  digitMatch: boolean | null;
  captures: CaptureSummary[];
  claimedBy: string | null;
  /** 1-based place among waiting sessions. Null once the session is in call or ended. */
  queuePosition: number | null;
  recordingUrl: string | null;
  recordingId: string | null;
  recordingAttachedAt: string | null;
}
