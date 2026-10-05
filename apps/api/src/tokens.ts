import { createHash, randomBytes, randomUUID } from "node:crypto";
import { AccessToken } from "livekit-server-sdk";

const TOKEN_TTL = "10m";
const TOKEN_TTL_MS = 10 * 60 * 1000;
const REFRESH_BEFORE_MS = 60 * 1000;

export interface CachedToken {
  token: string;
  expiresAt: number;
}

/** Process-local by default. index.ts installs a Redis cache when Upstash is configured. */
export interface TokenCache {
  get(key: string): Promise<CachedToken | undefined>;
  set(key: string, value: CachedToken): Promise<void>;
}

const memoryTokens = new Map<string, CachedToken>();

const memoryTokenCache: TokenCache = {
  async get(key) {
    return memoryTokens.get(key);
  },
  async set(key, value) {
    memoryTokens.set(key, value);
  },
};

let activeTokenCache: TokenCache = memoryTokenCache;

export function useParticipantTokenCache(cache: TokenCache): void {
  activeTokenCache = cache;
}

function tokenCacheKey(apiKey: string, apiSecret: string, role: string, roomName: string): string {
  const digest = createHash("sha256").update(`${apiKey}\0${apiSecret}`).digest("base64url").slice(0, 22);
  return `${digest}:${role}:${roomName}`;
}

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
 *
 * The reuse cache is in-process unless `cache` is passed or index.ts has
 * installed the Upstash cache. Grants, identity, and TTL stay the same.
 */
export async function participantToken(
  role: "agent" | "customer",
  roomName: string,
  credentials: ParticipantCredentials = credentialsFromEnv(),
  cache: TokenCache = activeTokenCache,
): Promise<string> {
  const apiKey = credentials.apiKey?.trim();
  const apiSecret = credentials.apiSecret?.trim();
  if (!apiKey || !apiSecret) {
    return placeholderParticipantToken(role, roomName);
  }

  const cacheKey = tokenCacheKey(apiKey, apiSecret, role, roomName);
  const cached = await cache.get(cacheKey);
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
    const minted = await accessToken.toJwt();
    const expiresAt = Date.now() + TOKEN_TTL_MS;
    const latest = await cache.get(cacheKey);
    if (latest && latest.expiresAt - Date.now() > REFRESH_BEFORE_MS) {
      return latest.token;
    }
    await cache.set(cacheKey, { token: minted, expiresAt });
    return minted;
  } catch (error) {
    console.error("[vkyc] LiveKit token mint failed; continuing without media", error);
    return placeholderParticipantToken(role, roomName);
  }
}
