import { randomBytes } from "node:crypto";
import { DEFAULT_CHECKLIST } from "./checklist.js";
import { CAPTURE_MAX_COUNT, type SessionPatch } from "./kyc.js";
import { newJoinToken, newSessionId, roomNameFor } from "./tokens.js";
import type {
  CaptureKind,
  CaptureRecord,
  ImageContentType,
  OnboardingPayload,
  Session,
  SessionStatus,
} from "./types.js";

export class SessionStore {
  private readonly sessions = new Map<string, Session>();
  private readonly byToken = new Map<string, string>();
  private readonly blobs = new Map<string, Buffer>();

  create(createdBy: string, onboarding: OnboardingPayload, now = new Date()): Session {
    const id = newSessionId();
    const joinToken = newJoinToken();
    const session: Session = {
      id,
      joinToken,
      status: "waiting",
      roomName: roomNameFor(id),
      createdAt: now.toISOString(),
      createdBy,
      onboardingPayload: { ...onboarding },
      checklist: DEFAULT_CHECKLIST.map((item) => ({ ...item })),
      acwNotes: "",
      disposition: null,
      captureGuide: null,
      captures: [],
    };
    this.sessions.set(id, session);
    this.byToken.set(joinToken, id);
    return session;
  }

  list(status?: SessionStatus): Session[] {
    const all = [...this.sessions.values()];
    const filtered = status ? all.filter((session) => session.status === status) : all;
    return filtered.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  getByToken(token: string): Session | undefined {
    const id = this.byToken.get(token);
    return id ? this.sessions.get(id) : undefined;
  }

  accept(
    id: string,
    now = new Date(),
  ):
    | { ok: true; session: Session }
    | { ok: false; error: "not_found" | "conflict"; session?: Session } {
    const session = this.sessions.get(id);
    if (!session) return { ok: false, error: "not_found" };
    if (session.status !== "waiting") return { ok: false, error: "conflict", session };
    session.status = "in_call";
    session.acceptedAt = now.toISOString();
    return { ok: true, session };
  }

  end(id: string, now = new Date()): { ok: true; session: Session } | { ok: false; error: "not_found" } {
    const session = this.sessions.get(id);
    if (!session) return { ok: false, error: "not_found" };
    if (session.status !== "ended") {
      session.status = "ended";
      session.endedAt = now.toISOString();
    }
    return { ok: true, session };
  }

  update(
    id: string,
    patch: SessionPatch,
  ):
    | { ok: true; session: Session }
    | { ok: false; error: "not_found" | "bad_request" | "conflict" | "capture_required"; message: string } {
    const session = this.sessions.get(id);
    if (!session) return { ok: false, error: "not_found", message: "Session not found" };

    if (patch.checklist) {
      for (const item of patch.checklist) {
        const found = session.checklist.some((entry) => entry.id === item.id);
        if (!found) {
          return { ok: false, error: "bad_request", message: `Unknown checklist item: ${item.id}` };
        }
      }
    }

    if (patch.disposition) {
      if (session.status !== "ended") {
        return {
          ok: false,
          error: "conflict",
          message: "Disposition is saved in after-call work, once the session has ended",
        };
      }
      if (session.captures.length === 0) {
        return {
          ok: false,
          error: "capture_required",
          message: "Add at least one still before setting a disposition",
        };
      }
    }

    if (patch.checklist) {
      for (const item of patch.checklist) {
        const found = session.checklist.find((entry) => entry.id === item.id);
        if (found) found.checked = item.checked;
      }
    }
    if (patch.acwNotes !== undefined) session.acwNotes = patch.acwNotes;
    if (patch.disposition !== undefined) session.disposition = patch.disposition;
    if (patch.captureGuide !== undefined) session.captureGuide = patch.captureGuide;
    return { ok: true, session };
  }

  addCapture(
    id: string,
    input: {
      bytes: Buffer;
      contentType: ImageContentType;
      kind: CaptureKind;
      capturedAt: string;
      now?: Date;
    },
  ):
    | { ok: true; session: Session; capture: CaptureRecord }
    | { ok: false; error: "not_found" | "limit"; message: string } {
    const session = this.sessions.get(id);
    if (!session) return { ok: false, error: "not_found", message: "Session not found" };
    if (session.captures.length >= CAPTURE_MAX_COUNT) {
      return { ok: false, error: "limit", message: `A session can store ${CAPTURE_MAX_COUNT} stills` };
    }

    const capture: CaptureRecord = {
      id: `cap_${randomBytes(9).toString("base64url")}`,
      kind: input.kind,
      contentType: input.contentType,
      createdAt: (input.now ?? new Date()).toISOString(),
      capturedAt: input.capturedAt,
    };
    this.blobs.set(capture.id, input.bytes);
    session.captures.push(capture);
    return { ok: true, session, capture };
  }

  getCapture(sessionId: string, captureId: string): { capture: CaptureRecord; bytes: Buffer } | undefined {
    const session = this.sessions.get(sessionId);
    const capture = session?.captures.find((item) => item.id === captureId);
    if (!capture) return undefined;
    const bytes = this.blobs.get(capture.id);
    if (!bytes) return undefined;
    return { capture, bytes };
  }
}
