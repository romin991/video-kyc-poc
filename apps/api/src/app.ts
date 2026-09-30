import express, { type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import { decodeImage, parseCaptureMeta, parseOnboarding, parsePatch, parseRecordingAttach } from "./kyc.js";
import type { CallRecorder } from "./recording.js";
import { SessionStore } from "./sessions.js";
import { deliverDispositionStubs, resolveStubConfig, type DispositionStubBody, type StubOverrides } from "./stubs.js";
import { participantToken } from "./tokens.js";
import type { CaptureRecord, Disposition, Session, SessionResponse, SessionStatus } from "./types.js";

const STATUSES: readonly SessionStatus[] = ["waiting", "in_call", "ended"];

const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 4 * 1024 * 1024, files: 1 },
});

const RECORDING_MAX_BYTES = 40 * 1024 * 1024;
const videoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: RECORDING_MAX_BYTES, files: 1 },
});

export interface AppOptions {
  customerAppOrigin?: string;
  corsOrigins?: string[];
  log?: boolean;
  /**
   * When set, replaces CRM/datalake env for this process. Unset webhook
   * fields log instead, even if CRM_STUB_WEBHOOK_URL is present in the environment.
   */
  stubs?: StubOverrides;
  /** LiveKit egress for the in-call room. Omitted when LiveKit credentials are unset. */
  recording?: CallRecorder;
}

const DEFAULT_CORS = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:5174",
  "http://127.0.0.1:5174",
];

function readList(value: string | undefined, fallback: string[]): string[] {
  if (!value) return fallback;
  const parsed = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return parsed.length > 0 ? parsed : fallback;
}

function demoAgent(req: Request): string {
  const raw = req.header("x-demo-agent")?.replace(/[\r\n]+/g, " ").trim() ?? "";
  return raw.slice(0, 80) || "Demo agent";
}

function joinUrlFor(origin: string, token: string): string {
  return `${origin.replace(/\/$/, "")}/join/${token}`;
}

function capturePath(sessionId: string, captureId: string): string {
  return `/sessions/${sessionId}/captures/${captureId}`;
}

function captureUrl(req: Request, sessionId: string, captureId: string): string {
  const host = req.get("host") ?? "localhost:3001";
  return `${req.protocol}://${host}${capturePath(sessionId, captureId)}`;
}

function toCapture(req: Request, sessionId: string, capture: CaptureRecord) {
  return {
    id: capture.id,
    url: captureUrl(req, sessionId, capture.id),
    path: capturePath(sessionId, capture.id),
    kind: capture.kind,
    contentType: capture.contentType,
    createdAt: capture.createdAt,
    capturedAt: capture.capturedAt,
  };
}

function toResponse(
  req: Request,
  session: Session,
  origin: string,
  queuePosition: number | null,
): SessionResponse {
  return {
    id: session.id,
    joinUrl: joinUrlFor(origin, session.joinToken),
    joinToken: session.joinToken,
    status: session.status,
    roomName: session.roomName,
    createdAt: session.createdAt,
    createdBy: session.createdBy,
    onboardingPayload: { ...session.onboardingPayload },
    checklist: session.checklist.map((item) => ({ ...item })),
    acwNotes: session.acwNotes,
    disposition: session.disposition,
    captureGuide: session.captureGuide,
    captures: session.captures.map((capture) => toCapture(req, session.id, capture)),
    claimedBy: session.claimedBy,
    queuePosition,
    recordingUrl: session.recordingUrl,
    recordingId: session.recordingId,
    recordingAttachedAt: session.recordingAttachedAt,
  };
}

function stubBody(req: Request, session: Session, agentId: string, disposition: Disposition): DispositionStubBody {
  return {
    sessionId: session.id,
    disposition,
    agentId,
    claimedBy: session.claimedBy,
    timestamps: {
      createdAt: session.createdAt,
      acceptedAt: session.acceptedAt ?? null,
      endedAt: session.endedAt ?? null,
      dispositionAt: new Date().toISOString(),
    },
    captures: session.captures.map((capture) => {
      const summary = toCapture(req, session.id, capture);
      return {
        id: summary.id,
        kind: summary.kind,
        url: summary.url,
        contentType: summary.contentType,
        createdAt: summary.createdAt,
        capturedAt: summary.capturedAt,
      };
    }),
    recording: {
      id: session.recordingId,
      url: session.recordingUrl,
    },
  };
}

function sendError(res: Response, status: number, error: string, message: string): void {
  res.status(status).json({ error, message });
}

async function claimedCall(session: Session, origin: string) {
  return {
    sessionId: session.id,
    roomName: session.roomName,
    agentToken: await participantToken("agent", session.roomName),
    joinUrl: joinUrlFor(origin, session.joinToken),
    status: "in_call" as const,
    claimedBy: session.claimedBy,
  };
}

function isCapturePost(req: Request): boolean {
  return req.method === "POST" && /^\/sessions\/[^/]+\/captures$/.test(req.path);
}

function isRecordingPost(req: Request): boolean {
  return req.method === "POST" && /^\/sessions\/[^/]+\/call-recording$/.test(req.path);
}

function videoContentType(mime: string): "video/webm" | "video/mp4" | null {
  const base = mime.split(";")[0]?.trim().toLowerCase();
  if (base === "video/webm") return "video/webm";
  if (base === "video/mp4") return "video/mp4";
  return null;
}

function captureParser(req: Request, res: Response, next: NextFunction): void {
  const type = req.header("content-type") ?? "";
  if (type.includes("multipart/form-data")) {
    imageUpload.single("image")(req, res, (error: unknown) => {
      if (error) {
        next(error);
        return;
      }
      next();
    });
    return;
  }
  express.json({ limit: "8mb" })(req, res, next);
}

function isPayloadTooLarge(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const record = error as { status?: number; type?: string };
  return record.status === 413 || record.type === "entity.too.large";
}

/**
 * Session signaling for the Video KYC shell, plus Wave 1 desk fields.
 *
 *   POST /sessions                 -> session, stub onboarding unless the body overrides it
 *   GET  /sessions                 -> { sessions }
 *   GET  /sessions/:id             -> checklist, notes, disposition, captures[], recordingUrl, recordingId
 *   PATCH /sessions/:id            -> checklist, acwNotes, disposition, captureGuide
 *   POST /sessions/:id/recording   -> { recordingUrl?, recordingId? } from LiveKit egress
 *   POST /sessions/:id/captures    -> multipart field `image`, or JSON { image: data URL | base64 }
 *   GET  /sessions/:id/captures/:captureId -> JPEG or PNG bytes
 *   POST /sessions/claim           -> oldest waiting session, status "in_call"
 *   POST /sessions/:id/accept      -> that waiting session, status "in_call"
 *   POST /sessions/:id/end         -> { status: "ended" }
 *   GET  /sessions/:id/call-recording -> { mode, recordingId }
 *   POST /sessions/:id/call-recording -> fallback webm/mp4 when Cloud egress is unavailable
 *   GET  /sessions/:id/call-recording/file.webm|mp4 -> fallback recording bytes
 *   GET  /join/:token              -> { roomName, customerToken, status, captureGuide, queuePosition }
 *
 * Call recording starts a LiveKit room-composite egress when the in-call room
 * exists, and stops it when the session ends. The egress id and file URL are
 * stored with POST /sessions/:id/recording. GET /sessions/:id returns
 * recordingUrl, recordingId, and recordingAttachedAt.
 *
 * Creating a session always leaves it waiting. Claim and accept are the only
 * ways into in_call, and each one takes a single waiting session. GET
 * /sessions?status=waiting is oldest-first. queuePosition is 1-based while
 * waiting and null after that. claimedBy is the X-Demo-Agent value from the
 * claim or accept.
 *
 * Participant tokens are LiveKit JWTs when LIVEKIT_API_KEY and
 * LIVEKIT_API_SECRET are set. Otherwise they are `lk-stub-…` placeholders
 * and the call shell stays up. See tokens.ts.
 *
 * Disposition (Approve | Reject | UTV) is stored only after the session has
 * ended and at least one still exists. A saved disposition posts a stub
 * payload to CRM_STUB_WEBHOOK_URL and DATALAKE_STUB_WEBHOOK_URL, or appends
 * a JSON line to DISPOSITION_STUB_LOG_PATH when a webhook is unset.
 *
 * POST /sessions/:id/recording stores a recording URL and/or id. Egress calls
 * it when an artifact exists. After-call work reads recordingUrl.
 *
 * captureGuide is the desk's current still kind (`face` | `id` | `other` | null).
 * The customer join poll reads it. `id` is the only value that shows the
 * card wireframe. It does not change how still bytes are stored.
 */
export function createApp(store = new SessionStore(), options: AppOptions = {}): express.Express {
  const origin = options.customerAppOrigin ?? process.env.CUSTOMER_APP_ORIGIN ?? "http://localhost:5174";
  const corsOrigins = options.corsOrigins ?? readList(process.env.CORS_ORIGINS, DEFAULT_CORS);
  const stubs = resolveStubConfig(process.env, options.stubs);
  const recording = options.recording;
  const app = express();
  app.disable("x-powered-by");
  app.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  app.use((req, res, next) => {
    const requestOrigin = req.header("origin");
    if (requestOrigin && corsOrigins.includes(requestOrigin)) {
      res.setHeader("Access-Control-Allow-Origin", requestOrigin);
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Demo-Agent");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS");
      res.setHeader("Vary", "Origin");
    }
    if (req.method === "OPTIONS") {
      res.sendStatus(204);
      return;
    }
    next();
  });
  if (options.log) {
    app.use((req, res, next) => {
      res.on("finish", () => {
        console.log(`${req.method} ${req.originalUrl} ${res.statusCode}`);
      });
      next();
    });
  }
  app.use((req, res, next) => {
    if (isCapturePost(req) || isRecordingPost(req)) {
      next();
      return;
    }
    express.json({ limit: "32kb" })(req, res, next);
  });

  app.get("/health", (_req, res) => {
    res.json({ ok: true, service: "vkyc-api" });
  });

  app.post("/sessions", (req, res) => {
    const onboarding = parseOnboarding(req.body ?? {});
    if (!onboarding.ok) {
      sendError(res, 400, "bad_request", onboarding.message);
      return;
    }
    const session = store.create(demoAgent(req), onboarding.value);
    res.status(201).json(toResponse(req, session, origin, store.queuePosition(session.id)));
  });

  app.get("/sessions", (req, res) => {
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    if (status && !STATUSES.includes(status as SessionStatus)) {
      sendError(res, 400, "bad_request", "status must be waiting, in_call, or ended");
      return;
    }
    const sessions = store
      .list(status as SessionStatus | undefined)
      .map((session) => toResponse(req, session, origin, store.queuePosition(session.id)));
    res.json({ sessions });
  });

  app.get("/sessions/:id", (req, res) => {
    const session = store.get(req.params.id);
    if (!session) {
      sendError(res, 404, "not_found", "Session not found");
      return;
    }
    res.json(toResponse(req, session, origin, store.queuePosition(session.id)));
  });

  app.patch("/sessions/:id", async (req, res) => {
    const patch = parsePatch(req.body ?? {});
    if (!patch.ok) {
      sendError(res, 400, "bad_request", patch.message);
      return;
    }
    const result = store.update(req.params.id, patch.value);
    if (!result.ok && result.error === "not_found") {
      sendError(res, 404, "not_found", result.message);
      return;
    }
    if (!result.ok && result.error === "conflict") {
      sendError(res, 409, "conflict", result.message);
      return;
    }
    if (!result.ok && result.error === "capture_required") {
      sendError(res, 422, "capture_required", result.message);
      return;
    }
    if (!result.ok) {
      sendError(res, 400, "bad_request", result.message);
      return;
    }
    const disposition = patch.value.disposition;
    if (disposition) {
      await deliverDispositionStubs(stubBody(req, result.session, demoAgent(req), disposition), stubs);
    }
    res.json(toResponse(req, result.session, origin, store.queuePosition(result.session.id)));
  });

  app.post("/sessions/:id/recording", (req, res) => {
    const parsed = parseRecordingAttach(req.body ?? {});
    if (!parsed.ok) {
      sendError(res, 400, "bad_request", parsed.message);
      return;
    }
    const result = store.attachRecording(req.params.id, parsed.value);
    if (!result.ok) {
      sendError(res, 404, "not_found", result.message);
      return;
    }
    res.json(toResponse(req, result.session, origin, store.queuePosition(result.session.id)));
  });

  app.post("/sessions/:id/captures", captureParser, (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const file = (req as Request & { file?: { buffer?: Buffer } }).file;
    const decoded = file?.buffer
      ? decodeImage({ buffer: file.buffer })
      : typeof body.image === "string"
        ? decodeImage({ text: body.image })
        : { ok: false as const, status: 400 as const, message: "image is required (file field or base64/data URL)" };
    if (!decoded.ok) {
      sendError(res, decoded.status, decoded.status === 413 ? "payload_too_large" : "bad_request", decoded.message);
      return;
    }

    const meta = parseCaptureMeta({ kind: body.kind, capturedAt: body.capturedAt }, new Date());
    if (!meta.ok) {
      sendError(res, 400, "bad_request", meta.message);
      return;
    }

    const result = store.addCapture(req.params.id, {
      bytes: decoded.bytes,
      contentType: decoded.contentType,
      kind: meta.value.kind,
      capturedAt: meta.value.capturedAt,
    });
    if (!result.ok && result.error === "not_found") {
      sendError(res, 404, "not_found", result.message);
      return;
    }
    if (!result.ok) {
      sendError(res, 409, "limit", result.message);
      return;
    }
    res.status(201).json(toCapture(req, result.session.id, result.capture));
  });

  app.get("/sessions/:id/captures/:captureId", (req, res) => {
    const found = store.getCapture(req.params.id, req.params.captureId);
    if (!found) {
      sendError(res, 404, "not_found", "Capture not found");
      return;
    }
    res.setHeader("Content-Type", found.capture.contentType);
    res.setHeader("Content-Length", String(found.bytes.length));
    res.send(found.bytes);
  });

  app.post("/sessions/claim", async (req, res) => {
    const result = store.claimNext(demoAgent(req));
    if (!result.ok && result.error === "empty") {
      sendError(res, 409, "conflict", "No session is waiting in the queue");
      return;
    }
    if (!result.ok && result.error === "not_found") {
      sendError(res, 404, "not_found", "Session not found");
      return;
    }
    if (!result.ok) {
      sendError(
        res,
        409,
        "conflict",
        `Session is ${result.session?.status ?? "unavailable"} and cannot be claimed`,
      );
      return;
    }
    recording?.onInCall({ id: result.session.id, roomName: result.session.roomName });
    res.json(await claimedCall(result.session, origin));
  });

  app.post("/sessions/:id/accept", async (req, res) => {
    const result = store.accept(req.params.id, demoAgent(req));
    if (!result.ok && result.error === "not_found") {
      sendError(res, 404, "not_found", "Session not found");
      return;
    }
    if (!result.ok) {
      sendError(
        res,
        409,
        "conflict",
        `Session is ${result.session?.status ?? "unavailable"} and cannot be accepted`,
      );
      return;
    }
    recording?.onInCall({ id: result.session.id, roomName: result.session.roomName });
    res.json(await claimedCall(result.session, origin));
  });

  app.post("/sessions/:id/end", (req, res) => {
    const result = store.end(req.params.id);
    if (!result.ok) {
      sendError(res, 404, "not_found", "Session not found");
      return;
    }
    if (recording) {
      void recording.onEnded({ id: result.session.id, roomName: result.session.roomName }).catch((error: unknown) => {
        console.error("[vkyc] recording finish failed", error instanceof Error ? error.message : error);
      });
    }
    res.json({ status: "ended" as const, sessionId: result.session.id });
  });

  app.get("/sessions/:id/call-recording", (req, res) => {
    const session = store.get(req.params.id);
    if (!session) {
      sendError(res, 404, "not_found", "Session not found");
      return;
    }
    res.json(recording?.status(session.id) ?? { mode: "off" as const, recordingId: null });
  });

  app.post("/sessions/:id/call-recording", videoUpload.single("video"), (req, res) => {
    const session = store.get(req.params.id);
    if (!session) {
      sendError(res, 404, "not_found", "Session not found");
      return;
    }
    if (!recording) {
      sendError(res, 409, "conflict", "Call recording is off until LiveKit credentials are set");
      return;
    }
    const file = (req as Request & { file?: { buffer?: Buffer; mimetype?: string } }).file;
    if (!file?.buffer) {
      sendError(res, 400, "bad_request", "video file is required (multipart field video)");
      return;
    }
    const contentType = videoContentType(file.mimetype ?? "");
    if (!contentType) {
      sendError(res, 400, "bad_request", "Recording must be video/webm or video/mp4");
      return;
    }
    const ext = contentType === "video/mp4" ? "mp4" : "webm";
    const recordingUrl = `${req.protocol}://${req.get("host") ?? "localhost:3001"}/sessions/${session.id}/call-recording/file.${ext}`;
    void recording
      .saveFallback(session.id, { bytes: file.buffer, contentType, recordingUrl })
      .then((saved) => {
        if (!saved.ok) {
          sendError(res, saved.status, saved.status === 400 ? "bad_request" : "conflict", saved.message);
          return;
        }
        res.status(201).json({ recordingId: saved.recordingId, recordingUrl: saved.recordingUrl });
      })
      .catch((error: unknown) => {
        console.error("[vkyc] fallback recording failed", error instanceof Error ? error.message : error);
        if (!res.headersSent) sendError(res, 500, "error", "Could not store the call recording");
      });
  });

  app.get("/sessions/:id/call-recording/file.:ext", (req, res) => {
    const file = recording?.fallbackFile(req.params.id);
    const expected = file?.contentType === "video/mp4" ? "mp4" : "webm";
    if (!file || req.params.ext !== expected) {
      sendError(res, 404, "not_found", "Recording not found");
      return;
    }
    res.setHeader("Content-Type", file.contentType);
    res.setHeader("Content-Length", String(file.bytes.length));
    res.send(file.bytes);
  });

  app.get("/join/:token", async (req, res) => {
    const session = store.getByToken(req.params.token);
    if (!session) {
      sendError(res, 404, "not_found", "Join link not found");
      return;
    }
    res.json({
      sessionId: session.id,
      roomName: session.roomName,
      customerToken: await participantToken("customer", session.roomName),
      status: session.status,
      captureGuide: session.captureGuide,
      queuePosition: store.queuePosition(session.id),
    });
  });

  app.use((_req, res) => {
    sendError(res, 404, "not_found", "Route not found");
  });

  app.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
    if (err instanceof SyntaxError) {
      sendError(res, 400, "bad_request", "Invalid JSON body");
      return;
    }
    if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
      const recordingUpload = isRecordingPost(req);
      sendError(
        res,
        413,
        "payload_too_large",
        recordingUpload ? "Recording must be 40 MB or smaller" : "Image must be 4 MB or smaller",
      );
      return;
    }
    if (err instanceof multer.MulterError) {
      sendError(res, 400, "bad_request", err.message);
      return;
    }
    if (isPayloadTooLarge(err)) {
      sendError(res, 413, "payload_too_large", "Image must be 4 MB or smaller");
      return;
    }
    next(err);
  });

  return app;
}
