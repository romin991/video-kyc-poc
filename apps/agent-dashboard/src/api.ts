export type SessionStatus = "waiting" | "in_call" | "ended";

export interface Session {
  id: string;
  joinUrl: string;
  joinToken: string;
  status: SessionStatus;
  roomName: string;
  createdAt: string;
  createdBy: string;
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

const API_BASE = (import.meta.env.VITE_API_BASE || "http://localhost:3001").replace(/\/$/, "");

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
  if (init?.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");

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

export function createSession(agentName: string): Promise<Session> {
  return request("/sessions", agentName, { method: "POST", body: "{}" });
}

export function acceptSession(id: string, agentName: string): Promise<AcceptResult> {
  return request(`/sessions/${id}/accept`, agentName, { method: "POST" });
}

export function endSession(id: string, agentName: string): Promise<EndResult> {
  return request(`/sessions/${id}/end`, agentName, { method: "POST" });
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
