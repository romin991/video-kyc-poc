import { randomBytes } from "node:crypto";
import { captureShowsDocs, DEFAULT_CHECKLIST, setChecklist, tickChecklist } from "./checklist.js";
import { CAPTURE_MAX_COUNT, digitChallengePrompt, type CustomerReply, type SessionPatch } from "./kyc.js";
import { newJoinToken, newSessionId, roomNameFor } from "./tokens.js";
import type {
  CaptureKind,
  CaptureRecord,
  ImageContentType,
  OnboardingPayload,
  Session,
  SessionStatus,
} from "./types.js";

export type AcceptResult =
  | { ok: true; session: Session }
  | { ok: false; error: "not_found" | "conflict"; session?: Session };

export type ClaimResult =
  | { ok: true; session: Session }
  | { ok: false; error: "empty" }
  | { ok: false; error: "not_found" | "conflict"; session?: Session };

export type EndResult = { ok: true; session: Session } | { ok: false; error: "not_found" };

export type UpdateResult =
  | { ok: true; session: Session }
  | { ok: false; error: "not_found" | "bad_request" | "conflict" | "capture_required"; message: string };

export type ReplyResult =
  | { ok: true; session: Session }
  | { ok: false; error: "not_found" | "conflict" | "bad_request"; message: string };

export type RecordingResult =
  | { ok: true; session: Session }
  | { ok: false; error: "not_found"; message: string };

export type CaptureResult =
  | { ok: true; session: Session; capture: CaptureRecord }
  | { ok: false; error: "not_found" | "limit"; message: string };

export interface CaptureInput {
  bytes: Buffer;
  contentType: ImageContentType;
  kind: CaptureKind;
  capturedAt: string;
  now?: Date;
}

/**
 * Shared session API. The in-memory store and the Upstash store both implement
 * this. Methods return promises so HTTP handlers can await either one.
 */
export interface SessionStoreApi {
  create(createdBy: string, onboarding: OnboardingPayload, now?: Date): Promise<Session>;
  list(status?: SessionStatus): Promise<Session[]>;
  queuePosition(id: string): Promise<number | null>;
  get(id: string): Promise<Session | undefined>;
  getByToken(token: string): Promise<Session | undefined>;
  accept(id: string, claimedBy: string, now?: Date): Promise<AcceptResult>;
  claimNext(claimedBy: string, now?: Date): Promise<ClaimResult>;
  end(id: string, now?: Date): Promise<EndResult>;
  update(id: string, patch: SessionPatch, now?: Date): Promise<UpdateResult>;
  recordReply(id: string, input: CustomerReply, now?: Date): Promise<ReplyResult>;
  attachRecording(
    id: string,
    input: { recordingUrl?: string; recordingId?: string },
    now?: Date,
  ): Promise<RecordingResult>;
  addCapture(id: string, input: CaptureInput): Promise<CaptureResult>;
  getCapture(sessionId: string, captureId: string): Promise<{ capture: CaptureRecord; bytes: Buffer } | undefined>;
}

export function compareWaiting(a: Session, b: Session): number {
  const created = a.createdAt.localeCompare(b.createdAt);
  if (created !== 0) return created;
  return a.arrival - b.arrival;
}

export function compareRecent(a: Session, b: Session): number {
  return b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id);
}

export function newCaptureId(): string {
  return `cap_${randomBytes(9).toString("base64url")}`;
}

export function blankSession(input: {
  id: string;
  joinToken: string;
  createdBy: string;
  onboarding: OnboardingPayload;
  arrival: number;
  now: Date;
}): Session {
  return {
    id: input.id,
    joinToken: input.joinToken,
    status: "waiting",
    roomName: roomNameFor(input.id),
    createdAt: input.now.toISOString(),
    createdBy: input.createdBy,
    arrival: input.arrival,
    onboardingPayload: { ...input.onboarding },
    checklist: DEFAULT_CHECKLIST.map((item) => ({ ...item })),
    acwNotes: "",
    disposition: null,
    captureGuide: null,
    maPrompt: null,
    maAnswers: [],
    digitChallenge: null,
    digitResponse: null,
    digitRespondedAt: null,
    maMatch: null,
    digitMatch: null,
    captures: [],
    claimedBy: null,
    recordingUrl: null,
    recordingId: null,
    recordingAttachedAt: null,
  };
}

export function applyAccept(session: Session, claimedBy: string, now: Date): AcceptResult {
  if (session.status !== "waiting") return { ok: false, error: "conflict", session };
  session.status = "in_call";
  session.acceptedAt = now.toISOString();
  session.claimedBy = claimedBy;
  return { ok: true, session };
}

export function applyEnd(session: Session, now: Date): EndResult {
  if (session.status !== "ended") {
    session.status = "ended";
    session.endedAt = now.toISOString();
  }
  return { ok: true, session };
}

export function applyUpdate(session: Session, patch: SessionPatch, now: Date): UpdateResult {
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
  if (patch.maPrompt !== undefined) {
    session.maPrompt = patch.maPrompt
      ? { field: patch.maPrompt.field, prompt: patch.maPrompt.prompt, sentAt: now.toISOString() }
      : null;
  }
  if (patch.digitChallenge !== undefined) {
    if (patch.digitChallenge) {
      session.digitChallenge = {
        digits: patch.digitChallenge.digits,
        prompt: digitChallengePrompt(patch.digitChallenge.digits),
        sentAt: now.toISOString(),
      };
      session.digitResponse = null;
      session.digitRespondedAt = null;
    } else {
      session.digitChallenge = null;
    }
  }
  if (patch.maMatch !== undefined) session.maMatch = patch.maMatch;
  if (patch.digitMatch !== undefined) session.digitMatch = patch.digitMatch;
  if (patch.maMatch === true || patch.maMatch === false) {
    setChecklist(session.checklist, "identity_match", patch.maMatch);
  }
  if (patch.digitMatch === true) tickChecklist(session.checklist, "liveness_digits");
  return { ok: true, session };
}

export function applyReply(session: Session, input: CustomerReply, now: Date): ReplyResult {
  if (session.status !== "in_call") {
    return { ok: false, error: "conflict", message: "Replies are accepted while the call is open" };
  }
  if (input.answer !== undefined && !session.maPrompt) {
    return { ok: false, error: "conflict", message: "No manual authentication question is waiting" };
  }
  if (input.digitResponse !== undefined && !session.digitChallenge) {
    return { ok: false, error: "conflict", message: "No digit prompt is waiting" };
  }

  if (input.answer !== undefined && session.maPrompt) {
    const next = {
      field: session.maPrompt.field,
      prompt: session.maPrompt.prompt,
      answer: input.answer,
      answeredAt: now.toISOString(),
    };
    const index = session.maAnswers.findIndex((item) => item.field === next.field);
    if (index === -1) {
      session.maAnswers.push(next);
      if (session.maAnswers.length > 20) {
        session.maAnswers.splice(0, session.maAnswers.length - 20);
      }
    } else {
      session.maAnswers[index] = next;
      for (let i = session.maAnswers.length - 1; i > index; i -= 1) {
        if (session.maAnswers[i]?.field === next.field) session.maAnswers.splice(i, 1);
      }
    }
    session.maPrompt = null;
  }

  if (input.digitResponse !== undefined && session.digitChallenge) {
    session.digitResponse = input.digitResponse;
    session.digitRespondedAt = now.toISOString();
    session.digitChallenge = null;
    tickChecklist(session.checklist, "liveness_digits");
  }

  return { ok: true, session };
}

export function applyRecording(
  session: Session,
  input: { recordingUrl?: string; recordingId?: string },
  now: Date,
): RecordingResult {
  if (input.recordingUrl !== undefined) session.recordingUrl = input.recordingUrl;
  if (input.recordingId !== undefined) session.recordingId = input.recordingId;
  session.recordingAttachedAt = now.toISOString();
  return { ok: true, session };
}

export function appendCapture(
  session: Session,
  input: {
    id: string;
    contentType: ImageContentType;
    kind: CaptureKind;
    capturedAt: string;
    now?: Date;
  },
): CaptureResult {
  if (session.captures.length >= CAPTURE_MAX_COUNT) {
    return { ok: false, error: "limit", message: `A session can store ${CAPTURE_MAX_COUNT} stills` };
  }
  const capture: CaptureRecord = {
    id: input.id,
    kind: input.kind,
    contentType: input.contentType,
    createdAt: (input.now ?? new Date()).toISOString(),
    capturedAt: input.capturedAt,
  };
  session.captures.push(capture);
  if (captureShowsDocs(capture.kind)) tickChecklist(session.checklist, "docs_shown");
  return { ok: true, session, capture };
}

/**
 * Process-local session store. Used when Upstash env vars are unset, including
 * local `pnpm dev`. One Node process sees every session it creates.
 */
export class SessionStore implements SessionStoreApi {
  private readonly sessions = new Map<string, Session>();
  private readonly byToken = new Map<string, string>();
  private readonly blobs = new Map<string, Buffer>();
  private arrival = 0;

  async create(createdBy: string, onboarding: OnboardingPayload, now = new Date()): Promise<Session> {
    const id = newSessionId();
    const joinToken = newJoinToken();
    const session = blankSession({
      id,
      joinToken,
      createdBy,
      onboarding,
      arrival: ++this.arrival,
      now,
    });
    this.sessions.set(id, session);
    this.byToken.set(joinToken, id);
    return session;
  }

  async list(status?: SessionStatus): Promise<Session[]> {
    const all = [...this.sessions.values()];
    const filtered = status ? all.filter((session) => session.status === status) : all;
    if (status === "waiting") return filtered.sort(compareWaiting);
    return filtered.sort(compareRecent);
  }

  /** 1-based FIFO place. Null when the session is not waiting. */
  async queuePosition(id: string): Promise<number | null> {
    const index = (await this.list("waiting")).findIndex((session) => session.id === id);
    return index === -1 ? null : index + 1;
  }

  async get(id: string): Promise<Session | undefined> {
    return this.sessions.get(id);
  }

  async getByToken(token: string): Promise<Session | undefined> {
    const id = this.byToken.get(token);
    return id ? this.sessions.get(id) : undefined;
  }

  async accept(id: string, claimedBy: string, now = new Date()): Promise<AcceptResult> {
    const session = this.sessions.get(id);
    if (!session) return { ok: false, error: "not_found" };
    return applyAccept(session, claimedBy, now);
  }

  /**
   * Claim the oldest waiting session. One claim moves one session to in_call.
   * Everyone else stays waiting.
   */
  async claimNext(claimedBy: string, now = new Date()): Promise<ClaimResult> {
    const next = (await this.list("waiting"))[0];
    if (!next) return { ok: false, error: "empty" };
    return this.accept(next.id, claimedBy, now);
  }

  async end(id: string, now = new Date()): Promise<EndResult> {
    const session = this.sessions.get(id);
    if (!session) return { ok: false, error: "not_found" };
    return applyEnd(session, now);
  }

  async update(id: string, patch: SessionPatch, now = new Date()): Promise<UpdateResult> {
    const session = this.sessions.get(id);
    if (!session) return { ok: false, error: "not_found", message: "Session not found" };
    return applyUpdate(session, patch, now);
  }

  /**
   * Store a customer reply against the active prompt.
   * An answer clears `maPrompt`. A digit reply clears `digitChallenge`
   * and keeps the text on `digitResponse` for the desk.
   */
  async recordReply(id: string, input: CustomerReply, now = new Date()): Promise<ReplyResult> {
    const session = this.sessions.get(id);
    if (!session) return { ok: false, error: "not_found", message: "Session not found" };
    return applyReply(session, input, now);
  }

  /**
   * Attach a recording URL and/or id. Omitted fields stay as they are.
   * Any session status is valid: egress often finishes as the call ends.
   */
  async attachRecording(
    id: string,
    input: { recordingUrl?: string; recordingId?: string },
    now = new Date(),
  ): Promise<RecordingResult> {
    const session = this.sessions.get(id);
    if (!session) return { ok: false, error: "not_found", message: "Session not found" };
    return applyRecording(session, input, now);
  }

  async addCapture(id: string, input: CaptureInput): Promise<CaptureResult> {
    const session = this.sessions.get(id);
    if (!session) return { ok: false, error: "not_found", message: "Session not found" };
    const captureId = newCaptureId();
    const result = appendCapture(session, { ...input, id: captureId });
    if (!result.ok) return result;
    this.blobs.set(captureId, input.bytes);
    return result;
  }

  async getCapture(
    sessionId: string,
    captureId: string,
  ): Promise<{ capture: CaptureRecord; bytes: Buffer } | undefined> {
    const session = this.sessions.get(sessionId);
    const capture = session?.captures.find((item) => item.id === captureId);
    if (!capture) return undefined;
    const bytes = this.blobs.get(capture.id);
    if (!bytes) return undefined;
    return { capture, bytes };
  }
}
