export type SessionStatus = "waiting" | "in_call" | "ended";

export interface Session {
  id: string;
  joinUrl: string;
  joinToken: string;
  status: SessionStatus;
  roomName: string;
  createdAt: string;
  createdBy: string;
  claimedBy: string | null;
  queuePosition: number | null;
  acceptedAt?: string;
  endedAt?: string;
  livekitUrl: string;
}

export interface ClaimResult {
  sessionId: string;
  roomName: string;
  agentToken: string;
  joinUrl: string;
  status: "in_call";
  claimedBy: string | null;
  livekitUrl: string;
}

export interface EndResult {
  status: "ended";
  sessionId: string;
}

const API_BASE = (process.env.NEXT_PUBLIC_API_BASE || "http://127.0.0.1:3001").replace(/\/$/, "");

export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function request<T>(path: string, agentName: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set("X-Demo-Agent", agentName);
  if (init?.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, { ...init, headers, cache: "no-store" });
  } catch {
    throw new ApiError("Cannot reach the API. Start it with go run ./cmd/vkyc-api from apps/go-api.", 0);
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

export function createSession(agentName: string): Promise<Session> {
  return request("/sessions", agentName, { method: "POST", body: "{}" });
}

export function acceptSession(id: string, agentName: string): Promise<ClaimResult> {
  return request(`/sessions/${encodeURIComponent(id)}/accept`, agentName, { method: "POST" });
}

export function claimNextSession(agentName: string): Promise<ClaimResult> {
  return request("/sessions/claim", agentName, { method: "POST" });
}

export function endSession(id: string, agentName: string): Promise<EndResult> {
  return request(`/sessions/${encodeURIComponent(id)}/end`, agentName, { method: "POST" });
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

export function serverUrlFor(fromApi: string): string {
  const api = fromApi.trim();
  if (api) return api;
  return (process.env.NEXT_PUBLIC_LIVEKIT_URL || "").trim();
}
