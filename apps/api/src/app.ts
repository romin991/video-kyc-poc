import express, { type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import { decodeImage, parseCaptureMeta, parseOnboarding, parsePatch } from "./kyc.js";
import { SessionStore } from "./sessions.js";
import { participantToken } from "./tokens.js";
import type { CaptureRecord, Session, SessionResponse, SessionStatus } from "./types.js";

const STATUSES: readonly SessionStatus[] = ["waiting", "in_call", "ended"];

const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 4 * 1024 * 1024, files: 1 },
});

export interface AppOptions {
  customerAppOrigin?: string;
  corsOrigins?: string[];
  log?: boolean;
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

function toResponse(req: Request, session: Session, origin: string): SessionResponse {
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
  };
}

function sendError(res: Response, status: number, error: string, message: string): void {
  res.status(status).json({ error, message });
}

function isCapturePost(req: Request): boolean {
  return req.method === "POST" && /^\/sessions\/[^/]+\/captures$/.test(req.path);
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
 *   GET  /sessions/:id             -> onboardingPayload, checklist, acwNotes, disposition, captures[]
 *   PATCH /sessions/:id            -> checklist, acwNotes, disposition, captureGuide
 *   POST /sessions/:id/captures    -> multipart field `image`, or JSON { image: data URL | base64 }
 *   GET  /sessions/:id/captures/:captureId -> JPEG or PNG bytes
 *   POST /sessions/:id/accept      -> { roomName, agentToken, status: "in_call" }
 *   POST /sessions/:id/end         -> { status: "ended" }
 *   GET  /join/:token              -> { roomName, customerToken, status, captureGuide }
 *
 * Participant tokens are LiveKit JWTs when LIVEKIT_API_KEY and
 * LIVEKIT_API_SECRET are set. Otherwise they are `lk-stub-…` placeholders
 * and the call shell stays up. See tokens.ts.
 *
 * Disposition (Approve | Reject | UTV) is stored only after the session has
 * ended and at least one still is on the session.
 *
 * captureGuide is the desk's current still kind (`face` | `id` | `other` | null).
 * The customer join poll reads it. `id` is the only value that shows the
 * card wireframe. It does not change how still bytes are stored.
 */
export function createApp(store = new SessionStore(), options: AppOptions = {}): express.Express {
  const origin = options.customerAppOrigin ?? process.env.CUSTOMER_APP_ORIGIN ?? "http://localhost:5174";
  const corsOrigins = options.corsOrigins ?? readList(process.env.CORS_ORIGINS, DEFAULT_CORS);
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
    if (isCapturePost(req)) {
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
    res.status(201).json(toResponse(req, session, origin));
  });

  app.get("/sessions", (req, res) => {
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    if (status && !STATUSES.includes(status as SessionStatus)) {
      sendError(res, 400, "bad_request", "status must be waiting, in_call, or ended");
      return;
    }
    const sessions = store
      .list(status as SessionStatus | undefined)
      .map((session) => toResponse(req, session, origin));
    res.json({ sessions });
  });

  app.get("/sessions/:id", (req, res) => {
    const session = store.get(req.params.id);
    if (!session) {
      sendError(res, 404, "not_found", "Session not found");
      return;
    }
    res.json(toResponse(req, session, origin));
  });

  app.patch("/sessions/:id", (req, res) => {
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
    res.json(toResponse(req, result.session, origin));
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

  app.post("/sessions/:id/accept", async (req, res) => {
    const result = store.accept(req.params.id);
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
    res.json({
      sessionId: result.session.id,
      roomName: result.session.roomName,
      agentToken: await participantToken("agent", result.session.roomName),
      status: "in_call" as const,
    });
  });

  app.post("/sessions/:id/end", (req, res) => {
    const result = store.end(req.params.id);
    if (!result.ok) {
      sendError(res, 404, "not_found", "Session not found");
      return;
    }
    res.json({ status: "ended" as const, sessionId: result.session.id });
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
    });
  });

  app.use((_req, res) => {
    sendError(res, 404, "not_found", "Route not found");
  });

  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (err instanceof SyntaxError) {
      sendError(res, 400, "bad_request", "Invalid JSON body");
      return;
    }
    if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
      sendError(res, 413, "payload_too_large", "Image must be 4 MB or smaller");
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
