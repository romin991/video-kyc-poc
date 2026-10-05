import { Redis } from "@upstash/redis";
import {
  appendCapture,
  applyAccept,
  applyEnd,
  applyRecording,
  applyReply,
  applyUpdate,
  blankSession,
  compareRecent,
  compareWaiting,
  newCaptureId,
  SessionStore,
  type AcceptResult,
  type CaptureInput,
  type CaptureResult,
  type ClaimResult,
  type EndResult,
  type RecordingResult,
  type ReplyResult,
  type SessionStoreApi,
  type UpdateResult,
} from "./sessions.js";
import { newJoinToken, newSessionId, type CachedToken, type TokenCache } from "./tokens.js";
import type { CaptureRecord, OnboardingPayload, Session, SessionStatus } from "./types.js";

/**
 * Shared session store for more than one Vercel instance.
 *
 * Keys (prefix defaults to `vkyc`):
 * - `{prefix}:arrival` monotonic FIFO tie-break
 * - `{prefix}:sessions` set of session ids
 * - `{prefix}:session:{id}` JSON `{ rev, session }`
 * - `{prefix}:token:{joinToken}` session id
 * - `{prefix}:blob:{captureId}` JSON `{ d: base64 }` still bytes
 * - `{prefix}:lk:{cacheKey}` LiveKit participant JWT reuse cache
 *
 * Writes of an existing session use a Lua compare-and-set on `rev`, so two
 * instances cannot both claim the same waiting session. `claimNext` retries
 * when that swap loses and then takes the next oldest waiting session.
 *
 * Stills are capped at 4MB by the capture parser. They are stored as base64
 * inside a JSON object so Upstash's automatic JSON parsing cannot rewrite the
 * bytes. A 4MB JPEG is about 5.4MB of base64, under the 10MB Upstash REST
 * request limit. Fallback call-recording files (up to 40MB) and the in-process
 * LiveKit egress watcher stay on the instance that handled them. `recordingUrl`
 * and `recordingId` are fields on the session, so they are shared.
 */

const DEFAULT_PREFIX = "vkyc";
const DEFAULT_TTL_SECONDS = 7 * 24 * 60 * 60;
const MIN_TTL_SECONDS = 60;
const CAS_ATTEMPTS = 12;

interface StoredSession {
  rev: number;
  session: Session;
}

interface BlobEnvelope {
  d: string;
}

export interface RedisCommands {
  get<T = unknown>(key: string): Promise<T | null>;
  set(key: string, value: unknown, opts?: { ex?: number }): Promise<unknown>;
  del(...keys: string[]): Promise<unknown>;
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<unknown>;
  sadd(key: string, member: string, ...members: string[]): Promise<unknown>;
  srem(key: string, member: string, ...members: string[]): Promise<unknown>;
  smembers(key: string): Promise<string[]>;
  mget<T = unknown>(...keys: string[]): Promise<Array<T | null>>;
  eval<T = unknown>(script: string, keys: string[], args: string[]): Promise<T>;
}

export const SESSION_CREATE_SCRIPT = `
local ttl = tonumber(ARGV[4])
redis.call('SET', KEYS[1], ARGV[1])
redis.call('SET', KEYS[2], ARGV[2])
redis.call('SADD', KEYS[3], ARGV[3])
if ttl and ttl > 0 then
  redis.call('EXPIRE', KEYS[1], ttl)
  redis.call('EXPIRE', KEYS[2], ttl)
  redis.call('EXPIRE', KEYS[3], ttl)
end
return 1
`.trim();

export const SESSION_CAS_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then
  return 0
end
local doc = cjson.decode(raw)
if tostring(doc['rev']) ~= ARGV[1] then
  return 0
end
redis.call('SET', KEYS[1], ARGV[2])
local ttl = tonumber(ARGV[3])
if ttl and ttl > 0 then
  redis.call('EXPIRE', KEYS[1], ttl)
end
return 1
`.trim();

export interface RedisSessionStoreOptions {
  redis: RedisCommands;
  prefix?: string;
  ttlSeconds?: number;
}

export function sessionTtlSeconds(raw: string | undefined): number {
  if (!raw?.trim()) return DEFAULT_TTL_SECONDS;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < MIN_TTL_SECONDS) return DEFAULT_TTL_SECONDS;
  return value;
}

export function redisPrefix(raw: string | undefined): string {
  const trimmed = raw?.trim();
  return trimmed ? trimmed : DEFAULT_PREFIX;
}

export function upstashCommands(client: Redis): RedisCommands {
  return {
    get: (key) => client.get(key),
    set: (key, value, opts) =>
      opts?.ex != null ? client.set(key, value, { ex: opts.ex }) : client.set(key, value),
    del: (...keys) => client.del(...keys),
    incr: (key) => client.incr(key),
    expire: (key, seconds) => client.expire(key, seconds),
    sadd: (key, member, ...members) => client.sadd(key, member, ...members),
    srem: (key, member, ...members) => client.srem(key, member, ...members),
    smembers: async (key) => {
      const members = await client.smembers<string[]>(key);
      return (members ?? []).map(String);
    },
    mget: async <T = unknown>(...keys: string[]): Promise<Array<T | null>> => {
      if (keys.length === 0) return [];
      const values = await client.mget<Array<T | null>>(...(keys as [string, ...string[]]));
      return values ?? keys.map(() => null);
    },
    eval: (script, keys, args) => client.eval(script, keys, args),
  };
}

export class RedisTokenCache implements TokenCache {
  constructor(
    private readonly redis: RedisCommands,
    private readonly prefix: string,
  ) {}

  async get(key: string): Promise<CachedToken | undefined> {
    const value = await this.redis.get<CachedToken>(this.storageKey(key));
    if (!value || typeof value !== "object" || typeof value.token !== "string" || typeof value.expiresAt !== "number") {
      return undefined;
    }
    return { token: value.token, expiresAt: value.expiresAt };
  }

  async set(key: string, value: CachedToken): Promise<void> {
    const ttl = Math.max(1, Math.ceil((value.expiresAt - Date.now()) / 1000));
    await this.redis.set(this.storageKey(key), value, { ex: ttl });
  }

  private storageKey(key: string): string {
    return `${this.prefix}:lk:${key}`;
  }
}

export class RedisSessionStore implements SessionStoreApi {
  private readonly redis: RedisCommands;
  private readonly prefix: string;
  private readonly ttlSeconds: number;

  constructor(options: RedisSessionStoreOptions) {
    this.redis = options.redis;
    this.prefix = redisPrefix(options.prefix);
    this.ttlSeconds = options.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  }

  async create(createdBy: string, onboarding: OnboardingPayload, now = new Date()): Promise<Session> {
    const id = newSessionId();
    const joinToken = newJoinToken();
    const arrival = await this.redis.incr(this.k("arrival"));
    const session = blankSession({ id, joinToken, createdBy, onboarding, arrival, now });
    const doc: StoredSession = { rev: 1, session };
    await this.redis.eval(SESSION_CREATE_SCRIPT, [this.sessionKey(id), this.tokenKey(joinToken), this.k("sessions")], [
      JSON.stringify(doc),
      id,
      id,
      String(this.ttlSeconds),
    ]);
    return session;
  }

  async list(status?: SessionStatus): Promise<Session[]> {
    const ids = await this.redis.smembers(this.k("sessions"));
    if (ids.length === 0) return [];
    const docs = await this.redis.mget<StoredSession>(...ids.map((id) => this.sessionKey(id)));
    const missing: string[] = [];
    const sessions: Session[] = [];
    ids.forEach((id, index) => {
      const parsed = parseStored(docs[index]);
      if (!parsed) {
        missing.push(id);
        return;
      }
      sessions.push(parsed.session);
    });
    if (missing.length > 0) await this.redis.srem(this.k("sessions"), missing[0]!, ...missing.slice(1));
    const filtered = status ? sessions.filter((session) => session.status === status) : sessions;
    if (status === "waiting") return filtered.sort(compareWaiting);
    return filtered.sort(compareRecent);
  }

  async queuePosition(id: string): Promise<number | null> {
    const index = (await this.list("waiting")).findIndex((session) => session.id === id);
    return index === -1 ? null : index + 1;
  }

  async get(id: string): Promise<Session | undefined> {
    return (await this.read(id))?.session;
  }

  async getByToken(token: string): Promise<Session | undefined> {
    const id = await this.redis.get<string>(this.tokenKey(token));
    if (typeof id !== "string" || id.length === 0) return undefined;
    return this.get(id);
  }

  async accept(id: string, claimedBy: string, now = new Date()): Promise<AcceptResult> {
    return this.mutate(id, { ok: false, error: "not_found" }, (session) => applyAccept(session, claimedBy, now));
  }

  /**
   * Oldest waiting session wins. The compare-and-set inside accept makes two
   * racing claims take two different sessions, or the second sees an empty queue.
   */
  async claimNext(claimedBy: string, now = new Date()): Promise<ClaimResult> {
    let last: ClaimResult = { ok: false, error: "empty" };
    for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt += 1) {
      const next = (await this.list("waiting"))[0];
      if (!next) return { ok: false, error: "empty" };
      const result = await this.accept(next.id, claimedBy, now);
      if (result.ok) return result;
      if (result.error === "not_found") continue;
      last = result;
      if (result.error !== "conflict") return result;
    }
    return last;
  }

  async end(id: string, now = new Date()): Promise<EndResult> {
    return this.mutate(id, { ok: false, error: "not_found" }, (session) => applyEnd(session, now));
  }

  async update(id: string, patch: Parameters<SessionStoreApi["update"]>[1], now = new Date()): Promise<UpdateResult> {
    return this.mutate(id, { ok: false, error: "not_found", message: "Session not found" }, (session) =>
      applyUpdate(session, patch, now),
    );
  }

  async recordReply(
    id: string,
    input: Parameters<SessionStoreApi["recordReply"]>[1],
    now = new Date(),
  ): Promise<ReplyResult> {
    return this.mutate(id, { ok: false, error: "not_found", message: "Session not found" }, (session) =>
      applyReply(session, input, now),
    );
  }

  async attachRecording(
    id: string,
    input: { recordingUrl?: string; recordingId?: string },
    now = new Date(),
  ): Promise<RecordingResult> {
    return this.mutate(id, { ok: false, error: "not_found", message: "Session not found" }, (session) =>
      applyRecording(session, input, now),
    );
  }

  async addCapture(id: string, input: CaptureInput): Promise<CaptureResult> {
    const captureId = newCaptureId();
    const envelope: BlobEnvelope = { d: input.bytes.toString("base64") };
    await this.redis.set(this.blobKey(captureId), envelope, { ex: this.ttlSeconds });
    const result = await this.mutate(id, { ok: false, error: "not_found", message: "Session not found" }, (session) =>
      appendCapture(session, { ...input, id: captureId }),
    );
    if (!result.ok) await this.redis.del(this.blobKey(captureId));
    return result;
  }

  async getCapture(sessionId: string, captureId: string): Promise<{ capture: CaptureRecord; bytes: Buffer } | undefined> {
    const session = await this.get(sessionId);
    const capture = session?.captures.find((item) => item.id === captureId);
    if (!capture) return undefined;
    const envelope = await this.redis.get<BlobEnvelope>(this.blobKey(capture.id));
    if (!envelope || typeof envelope !== "object" || typeof envelope.d !== "string") return undefined;
    return { capture, bytes: Buffer.from(envelope.d, "base64") };
  }

  private async mutate<T extends { ok: boolean }>(id: string, missing: T, apply: (session: Session) => T): Promise<T> {
    for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt += 1) {
      const loaded = await this.read(id);
      if (!loaded) return missing;
      const draft = cloneSession(loaded.session);
      const result = apply(draft);
      if (!result.ok) return result;
      const saved = await this.commit(id, loaded.rev, draft);
      if (saved) return result;
    }
    throw new Error(`Could not save session ${id} after concurrent updates`);
  }

  private async commit(id: string, expectedRev: number, session: Session): Promise<boolean> {
    const next: StoredSession = { rev: expectedRev + 1, session };
    const swapped = await this.redis.eval<number>(SESSION_CAS_SCRIPT, [this.sessionKey(id)], [
      String(expectedRev),
      JSON.stringify(next),
      String(this.ttlSeconds),
    ]);
    if (Number(swapped) !== 1) return false;
    await this.redis.expire(this.tokenKey(session.joinToken), this.ttlSeconds);
    await this.redis.expire(this.k("sessions"), this.ttlSeconds);
    if (session.captures.length > 0) {
      await Promise.all(session.captures.map((capture) => this.redis.expire(this.blobKey(capture.id), this.ttlSeconds)));
    }
    return true;
  }

  private async read(id: string): Promise<StoredSession | undefined> {
    return parseStored(await this.redis.get<StoredSession>(this.sessionKey(id)));
  }

  private k(suffix: string): string {
    return `${this.prefix}:${suffix}`;
  }

  private sessionKey(id: string): string {
    return this.k(`session:${id}`);
  }

  private tokenKey(token: string): string {
    return this.k(`token:${token}`);
  }

  private blobKey(captureId: string): string {
    return this.k(`blob:${captureId}`);
  }
}

export interface SessionBackend {
  store: SessionStoreApi;
  tokenCache?: TokenCache;
  description: string;
}

function redisCredentials(env: NodeJS.ProcessEnv): { url: string; token: string } | undefined {
  const url = env.UPSTASH_REDIS_REST_URL?.trim() || env.KV_REST_API_URL?.trim() || "";
  const token = env.UPSTASH_REDIS_REST_TOKEN?.trim() || env.KV_REST_API_TOKEN?.trim() || "";
  if (!url && !token) return undefined;
  if (!url || !token) return undefined;
  return { url, token };
}

/**
 * Redis when both Upstash REST env vars are set. Otherwise the in-memory store,
 * so local `pnpm dev` keeps working with an empty `.env`.
 * `KV_REST_API_URL` / `KV_REST_API_TOKEN` are accepted as aliases.
 */
export function createSessionStoreFromEnv(env: NodeJS.ProcessEnv = process.env): SessionBackend {
  const urlSet = Boolean(env.UPSTASH_REDIS_REST_URL?.trim() || env.KV_REST_API_URL?.trim());
  const tokenSet = Boolean(env.UPSTASH_REDIS_REST_TOKEN?.trim() || env.KV_REST_API_TOKEN?.trim());
  const credentials = redisCredentials(env);
  if (!credentials) {
    if (urlSet || tokenSet) {
      console.warn(
        "[vkyc] session store: memory. Set both UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN to share sessions across instances.",
      );
      return {
        store: new SessionStore(),
        description:
          "session store: memory (set both UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN to share sessions)",
      };
    }
    return {
      store: new SessionStore(),
      description: "session store: memory (UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN unset)",
    };
  }

  const prefix = redisPrefix(env.VKYC_REDIS_PREFIX);
  const ttlSeconds = sessionTtlSeconds(env.VKYC_SESSION_TTL_SECONDS);
  const redis = upstashCommands(
    new Redis({
      url: credentials.url,
      token: credentials.token,
      enableAutoPipelining: false,
      enableTelemetry: false,
    }),
  );
  return {
    store: new RedisSessionStore({ redis, prefix, ttlSeconds }),
    tokenCache: new RedisTokenCache(redis, prefix),
    description: `session store: upstash redis (prefix ${prefix}, ttl ${ttlSeconds}s)`,
  };
}

function cloneSession(session: Session): Session {
  return JSON.parse(JSON.stringify(session)) as Session;
}

function parseStored(value: unknown): StoredSession | undefined {
  let doc = value;
  if (typeof value === "string") {
    try {
      doc = JSON.parse(value) as unknown;
    } catch {
      return undefined;
    }
  }
  if (!doc || typeof doc !== "object") return undefined;
  const record = doc as { rev?: unknown; session?: Session };
  const rev = typeof record.rev === "number" ? record.rev : Number(record.rev);
  if (!Number.isInteger(rev) || !record.session?.id || !record.session.joinToken) return undefined;
  return { rev, session: record.session };
}
