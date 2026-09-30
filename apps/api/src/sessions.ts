import { newJoinToken, newSessionId, roomNameFor } from "./tokens.js";
import type { Session, SessionStatus } from "./types.js";

export class SessionStore {
  private readonly sessions = new Map<string, Session>();
  private readonly byToken = new Map<string, string>();

  create(createdBy: string, now = new Date()): Session {
    const id = newSessionId();
    const joinToken = newJoinToken();
    const session: Session = {
      id,
      joinToken,
      status: "waiting",
      roomName: roomNameFor(id),
      createdAt: now.toISOString(),
      createdBy,
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
}
