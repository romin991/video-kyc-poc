export type SessionStatus = "waiting" | "in_call" | "ended";

export interface JoinInfo {
  sessionId: string;
  roomName: string;
  customerToken: string;
  status: SessionStatus;
  queuePosition: number | null;
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

async function read(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ApiError("Unexpected response from the verification service.", response.status);
  }
}

function messageOf(data: unknown, fallback: string): string {
  if (data && typeof data === "object" && "message" in data && typeof data.message === "string") {
    return data.message;
  }
  return fallback;
}

export async function fetchJoin(token: string): Promise<JoinInfo> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}/join/${encodeURIComponent(token)}`, { cache: "no-store" });
  } catch {
    throw new ApiError("Cannot reach the verification service.", 0);
  }
  const data = await read(response);
  if (!response.ok) throw new ApiError(messageOf(data, response.statusText), response.status);
  return data as JoinInfo;
}

export async function endSession(sessionId: string): Promise<EndResult> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}/sessions/${encodeURIComponent(sessionId)}/end`, {
      method: "POST",
      cache: "no-store",
    });
  } catch {
    throw new ApiError("Cannot reach the verification service.", 0);
  }
  const data = await read(response);
  if (!response.ok) throw new ApiError(messageOf(data, response.statusText), response.status);
  return data as EndResult;
}

export function serverUrlFor(fromApi: string): string {
  const api = fromApi.trim();
  if (api) return api;
  return (process.env.NEXT_PUBLIC_LIVEKIT_URL || "").trim();
}
