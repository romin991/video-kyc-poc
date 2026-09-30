import { randomBytes, randomUUID } from "node:crypto";

export function newSessionId(): string {
  return randomUUID();
}

export function newJoinToken(): string {
  return randomBytes(18).toString("base64url");
}

export function roomNameFor(sessionId: string): string {
  return `vkyc-${sessionId}`;
}

/**
 * Placeholder LiveKit participant credential.
 *
 * TODO(livekit): mint a real JWT with `livekit-server-sdk` instead of this string.
 *   import { AccessToken } from "livekit-server-sdk";
 *   const token = new AccessToken(apiKey, apiSecret, { identity, ttl: "10m" });
 *   token.addGrant({
 *     roomJoin: true,
 *     room: roomName,
 *     canPublish: true,
 *     canSubscribe: true,
 *   });
 *   return await token.toJwt();
 *
 * Stub tokens are deterministic and do not expire. Real tokens must be short-lived.
 */
export function stubParticipantToken(role: "agent" | "customer", roomName: string): string {
  return `lk-stub-${role}-${roomName}`;
}
