export type SessionStatus = "waiting" | "in_call" | "ended";

export interface Session {
  id: string;
  joinToken: string;
  status: SessionStatus;
  roomName: string;
  createdAt: string;
  createdBy: string;
  acceptedAt?: string;
  endedAt?: string;
}

export interface SessionResponse {
  id: string;
  joinUrl: string;
  joinToken: string;
  status: SessionStatus;
  roomName: string;
  createdAt: string;
  createdBy: string;
}
