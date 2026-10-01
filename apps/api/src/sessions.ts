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

export class SessionStore {
  private readonly sessions = new Map<string, Session>();
  private readonly byToken = new Map<string, string>();
  private readonly blobs = new Map<string, Buffer>();
  private arrival = 0;

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
      arrival: ++this.arrival,
      onboardingPayload: { ...onboarding },
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
    this.sessions.set(id, session);
    this.byToken.set(joinToken, id);
    return session;
  }

  list(status?: SessionStatus): Session[] {
    const all = [...this.sessions.values()];
    const filtered = status ? all.filter((session) => session.status === status) : all;
    if (status === "waiting") return filtered.sort(byArrival);
    return filtered.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  }

  /** 1-based FIFO place. Null when the session is not waiting. */
  queuePosition(id: string): number | null {
    const index = this.list("waiting").findIndex((session) => session.id === id);
    return index === -1 ? null : index + 1;
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
    claimedBy: string,
    now = new Date(),
  ):
    | { ok: true; session: Session }
    | { ok: false; error: "not_found" | "conflict"; session?: Session } {
    const session = this.sessions.get(id);
    if (!session) return { ok: false, error: "not_found" };
    if (session.status !== "waiting") return { ok: false, error: "conflict", session };
    session.status = "in_call";
    session.acceptedAt = now.toISOString();
    session.claimedBy = claimedBy;
    return { ok: true, session };
  }

  /**
   * Claim the oldest waiting session. One claim moves one session to in_call.
   * Everyone else stays waiting.
   */
  claimNext(
    claimedBy: string,
    now = new Date(),
  ):
    | { ok: true; session: Session }
    | { ok: false; error: "empty" }
    | { ok: false; error: "not_found" | "conflict"; session?: Session } {
    const next = this.list("waiting")[0];
    if (!next) return { ok: false, error: "empty" };
    return this.accept(next.id, claimedBy, now);
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
    now = new Date(),
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

  /**
   * Store a customer reply against the active prompt.
   * An answer clears `maPrompt`. A digit reply clears `digitChallenge`
   * and keeps the text on `digitResponse` for the desk.
   */
  recordReply(
    id: string,
    input: CustomerReply,
    now = new Date(),
  ):
    | { ok: true; session: Session }
    | { ok: false; error: "not_found" | "conflict" | "bad_request"; message: string } {
    const session = this.sessions.get(id);
    if (!session) return { ok: false, error: "not_found", message: "Session not found" };
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
      session.maAnswers.push({
        field: session.maPrompt.field,
        prompt: session.maPrompt.prompt,
        answer: input.answer,
        answeredAt: now.toISOString(),
      });
      if (session.maAnswers.length > 20) {
        session.maAnswers.splice(0, session.maAnswers.length - 20);
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

  /**
   * Attach a recording URL and/or id. Omitted fields stay as they are.
   * Any session status is valid: egress often finishes as the call ends.
   */
  attachRecording(
    id: string,
    input: { recordingUrl?: string; recordingId?: string },
    now = new Date(),
  ): { ok: true; session: Session } | { ok: false; error: "not_found"; message: string } {
    const session = this.sessions.get(id);
    if (!session) return { ok: false, error: "not_found", message: "Session not found" };
    if (input.recordingUrl !== undefined) session.recordingUrl = input.recordingUrl;
    if (input.recordingId !== undefined) session.recordingId = input.recordingId;
    session.recordingAttachedAt = now.toISOString();
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
    if (captureShowsDocs(capture.kind)) tickChecklist(session.checklist, "docs_shown");
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

function byArrival(a: Session, b: Session): number {
  const created = a.createdAt.localeCompare(b.createdAt);
  if (created !== 0) return created;
  return a.arrival - b.arrival;
}
