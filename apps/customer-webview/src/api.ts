export type SessionStatus = "waiting" | "in_call" | "ended";

export type CaptureKind = "face" | "id" | "other";

export interface JoinInfo {
  sessionId: string;
  roomName: string;
  customerToken: string;
  status: SessionStatus;
  /** `id` shows the card wireframe. Any other value hides it. */
  captureGuide: CaptureKind | null;
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

export async function fetchJoin(token: string): Promise<JoinInfo> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}/join/${encodeURIComponent(token)}`, { cache: "no-store" });
  } catch {
    throw new ApiError("Cannot reach the verification service.", 0);
  }

  const text = await response.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text) as unknown;
    } catch {
      throw new ApiError("Unexpected response from the verification service.", response.status);
    }
  }

  if (!response.ok) {
    const message =
      data && typeof data === "object" && "message" in data && typeof data.message === "string"
        ? data.message
        : response.statusText;
    throw new ApiError(message, response.status);
  }

  return data as JoinInfo;
}
