import { randomBytes, randomUUID } from "node:crypto";
import { AccessToken } from "livekit-server-sdk";

const TOKEN_TTL = "10m";
const TOKEN_TTL_MS = 10 * 60 * 1000;
const REFRESH_BEFORE_MS = 60 * 1000;

interface CachedToken {
  token: string;
  expiresAt: number;
}

const cache = new Map<string, CachedToken>();

export interface ParticipantCredentials {
  apiKey?: string;
  apiSecret?: string;
}

export function newSessionId(): string {
  return randomUUID();
}

export function newJoinToken(): string {
  return randomBytes(18).toString("base64url");
}

export function roomNameFor(sessionId: string): string {
  return `vkyc-${sessionId}`;
}

export function placeholderParticipantToken(role: "agent" | "customer", roomName: string): string {
  return `lk-stub-${role}-${roomName}`;
}

function credentialsFromEnv(): ParticipantCredentials {
  return {
    apiKey: process.env.LIVEKIT_API_KEY?.trim() || undefined,
    apiSecret: process.env.LIVEKIT_API_SECRET?.trim() || undefined,
  };
}

/**
 * LiveKit participant JWT for `role` in `roomName`.
 *
 * Identity is `agent` or `customer`. Grants are roomJoin, canPublish, and
 * canSubscribe. TTL is 10 minutes. The same token is reused until it is close
 * to expiry so the customer poll does not reconnect the room.
 *
 * When LIVEKIT_API_KEY or LIVEKIT_API_SECRET is missing, or minting throws,
 * returns a non-connecting placeholder. Callers still complete accept and join.
 */
export async function participantToken(
  role: "agent" | "customer",
  roomName: string,
  credentials: ParticipantCredentials = credentialsFromEnv(),
): Promise<string> {
  const apiKey = credentials.apiKey?.trim();
  const apiSecret = credentials.apiSecret?.trim();
  if (!apiKey || !apiSecret) {
    return placeholderParticipantToken(role, roomName);
  }

  const cacheKey = `${apiKey}:${apiSecret}:${role}:${roomName}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt - Date.now() > REFRESH_BEFORE_MS) {
    return cached.token;
  }

  try {
    const accessToken = new AccessToken(apiKey, apiSecret, {
      identity: role,
      ttl: TOKEN_TTL,
    });
    accessToken.addGrant({
      roomJoin: true,
      room: roomName,
      canPublish: true,
      canSubscribe: true,
    });
    const token = await accessToken.toJwt();
    cache.set(cacheKey, { token, expiresAt: Date.now() + TOKEN_TTL_MS });
    return token;
  } catch (error) {
    console.error("[vkyc] LiveKit token mint failed; continuing without media", error);
    return placeholderParticipantToken(role, roomName);
  }
}
