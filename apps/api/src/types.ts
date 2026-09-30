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
  acceptedAt?: string;
  endedAt?: string;
  onboardingPayload: OnboardingPayload;
  checklist: ChecklistItem[];
  acwNotes: string;
  disposition: Disposition | null;
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
  captures: CaptureSummary[];
}
