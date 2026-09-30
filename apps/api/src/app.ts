import express, { type NextFunction, type Request, type Response } from "express";
import { SessionStore } from "./sessions.js";
import { stubParticipantToken } from "./tokens.js";
import type { Session, SessionResponse, SessionStatus } from "./types.js";

const STATUSES: readonly SessionStatus[] = ["waiting", "in_call", "ended"];

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

function toResponse(session: Session, origin: string): SessionResponse {
  return {
    id: session.id,
    joinUrl: joinUrlFor(origin, session.joinToken),
    joinToken: session.joinToken,
    status: session.status,
    roomName: session.roomName,
    createdAt: session.createdAt,
    createdBy: session.createdBy,
  };
}

function sendError(res: Response, status: number, error: string, message: string): void {
  res.status(status).json({ error, message });
}

/**
 * Session signaling for the P0 shell.
 *
 *   POST /sessions            -> { id, joinUrl, status, ... }
 *   GET  /sessions            -> { sessions }
 *   GET  /sessions/:id        -> session
 *   POST /sessions/:id/accept -> { roomName, agentToken, status: "in_call" }
 *   POST /sessions/:id/end    -> { status: "ended" }
 *   GET  /join/:token         -> { roomName, customerToken, status }
 *
 * Participant tokens are `lk-stub-…` placeholders. See tokens.ts.
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
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
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
  app.use(express.json({ limit: "32kb" }));

  app.get("/health", (_req, res) => {
    res.json({ ok: true, service: "vkyc-api" });
  });

  app.post("/sessions", (req, res) => {
    const session = store.create(demoAgent(req));
    res.status(201).json(toResponse(session, origin));
  });

  app.get("/sessions", (req, res) => {
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    if (status && !STATUSES.includes(status as SessionStatus)) {
      sendError(res, 400, "bad_request", "status must be waiting, in_call, or ended");
      return;
    }
    const sessions = store.list(status as SessionStatus | undefined).map((session) => toResponse(session, origin));
    res.json({ sessions });
  });

  app.get("/sessions/:id", (req, res) => {
    const session = store.get(req.params.id);
    if (!session) {
      sendError(res, 404, "not_found", "Session not found");
      return;
    }
    res.json(toResponse(session, origin));
  });

  app.post("/sessions/:id/accept", (req, res) => {
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
      agentToken: stubParticipantToken("agent", result.session.roomName),
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

  app.get("/join/:token", (req, res) => {
    const session = store.getByToken(req.params.token);
    if (!session) {
      sendError(res, 404, "not_found", "Join link not found");
      return;
    }
    res.json({
      sessionId: session.id,
      roomName: session.roomName,
      customerToken: stubParticipantToken("customer", session.roomName),
      status: session.status,
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
    next(err);
  });

  return app;
}
