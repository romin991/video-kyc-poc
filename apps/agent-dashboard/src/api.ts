export type SessionStatus = "waiting" | "in_call" | "ended";

export type Disposition = "approve" | "reject" | "utv";

export type CaptureKind = "face" | "id" | "other";

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

export interface CaptureSummary {
  id: string;
  url: string;
  path: string;
  kind: CaptureKind;
  contentType: "image/jpeg" | "image/png";
  createdAt: string;
  capturedAt: string;
}

export interface Session {
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
}

export interface AcceptResult {
  sessionId: string;
  roomName: string;
  agentToken: string;
  status: "in_call";
}

export interface EndResult {
  status: "ended";
  sessionId: string;
}

export interface SessionPatch {
  checklist?: { id: string; checked: boolean }[];
  acwNotes?: string;
  disposition?: Disposition | null;
  captureGuide?: CaptureKind | null;
}

const API_BASE = (import.meta.env.VITE_API_BASE || "http://localhost:3001").replace(/\/$/, "");

export function captureSrc(capture: CaptureSummary): string {
  return `${API_BASE}${capture.path}`;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function request<T>(path: string, agentName: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set("X-Demo-Agent", agentName);
  if (init?.body && !(init.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, { ...init, headers, cache: "no-store" });
  } catch {
    throw new ApiError("Cannot reach the API. Start it with pnpm dev:api.", 0);
  }

  const text = await response.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text) as unknown;
    } catch {
      throw new ApiError("API returned a non-JSON response", response.status);
    }
  }

  if (!response.ok) {
    const message =
      data && typeof data === "object" && "message" in data && typeof data.message === "string"
        ? data.message
        : response.statusText;
    throw new ApiError(message, response.status);
  }

  return data as T;
}

export function listSessions(agentName: string): Promise<{ sessions: Session[] }> {
  return request("/sessions", agentName);
}

export function createSession(agentName: string, onboarding?: Partial<OnboardingPayload>): Promise<Session> {
  const body = onboarding ? JSON.stringify({ onboarding }) : "{}";
  return request("/sessions", agentName, { method: "POST", body });
}

export function patchSession(id: string, agentName: string, patch: SessionPatch): Promise<Session> {
  return request(`/sessions/${id}`, agentName, { method: "PATCH", body: JSON.stringify(patch) });
}

export function acceptSession(id: string, agentName: string): Promise<AcceptResult> {
  return request(`/sessions/${id}/accept`, agentName, { method: "POST" });
}

export function endSession(id: string, agentName: string): Promise<EndResult> {
  return request(`/sessions/${id}/end`, agentName, { method: "POST" });
}

export interface CaptureUploadOptions {
  kind?: CaptureKind;
  capturedAt?: string;
  filename?: string;
}

export function uploadSessionCapture(
  sessionId: string,
  agentName: string,
  image: Blob | File | string,
  options: CaptureUploadOptions = {},
): Promise<CaptureSummary> {
  if (typeof image === "string") {
    return request(`/sessions/${sessionId}/captures`, agentName, {
      method: "POST",
      body: JSON.stringify({
        image,
        kind: options.kind,
        capturedAt: options.capturedAt,
      }),
    });
  }

  const form = new FormData();
  const file =
    image instanceof File
      ? image
      : new File([image], options.filename ?? "capture.jpg", { type: image.type || "image/jpeg" });
  form.append("image", file);
  if (options.kind) form.append("kind", options.kind);
  if (options.capturedAt) form.append("capturedAt", options.capturedAt);
  return request(`/sessions/${sessionId}/captures`, agentName, { method: "POST", body: form });
}

export async function getHealth(): Promise<boolean> {
  try {
    const response = await fetch(`${API_BASE}/health`, { cache: "no-store" });
    if (!response.ok) return false;
    const data = (await response.json()) as { ok?: boolean };
    return data.ok === true;
  } catch {
    return false;
  }
}
