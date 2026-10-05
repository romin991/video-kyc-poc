import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { createApp } from "./app.js";
import {
  createSessionStoreFromEnv,
  RedisSessionStore,
  RedisTokenCache,
  SESSION_CAS_SCRIPT,
  SESSION_CREATE_SCRIPT,
  sessionTtlSeconds,
  type RedisCommands,
} from "./redis-session-store.js";
import { SessionStore, type SessionStoreApi } from "./sessions.js";
import { STUB_ONBOARDING } from "./kyc.js";
import { participantToken } from "./tokens.js";

delete process.env.LIVEKIT_API_KEY;
delete process.env.LIVEKIT_API_SECRET;

const TINY_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

function deserialize(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/**
 * In-process Redis with the same SET/GET JSON rules as @upstash/redis.
 * EVAL runs the two session scripts atomically (no await between read and write).
 */
class FakeRedis implements RedisCommands {
  private readonly strings = new Map<string, string>();
  private readonly sets = new Map<string, Set<string>>();
  private readonly expires = new Map<string, number>();
  onEval?: (script: string) => Promise<void> | void;
  now = () => Date.now();

  async get<T>(key: string): Promise<T | null> {
    if (this.dropIfExpired(key) || !this.strings.has(key)) return null;
    return deserialize(this.strings.get(key)!) as T;
  }

  async set(key: string, value: unknown, opts?: { ex?: number }): Promise<unknown> {
    this.sets.delete(key);
    this.strings.set(key, typeof value === "string" ? value : JSON.stringify(value));
    if (opts?.ex != null) this.expires.set(key, this.now() + opts.ex * 1000);
    else this.expires.delete(key);
    return "OK";
  }

  async del(...keys: string[]): Promise<number> {
    let removed = 0;
    for (const key of keys) {
      if (this.strings.delete(key) || this.sets.delete(key)) removed += 1;
      this.expires.delete(key);
    }
    return removed;
  }

  async incr(key: string): Promise<number> {
    this.dropIfExpired(key);
    const current = this.strings.has(key) ? Number(deserialize(this.strings.get(key)!)) : 0;
    const next = (Number.isFinite(current) ? current : 0) + 1;
    this.strings.set(key, String(next));
    return next;
  }

  async expire(key: string, seconds: number): Promise<number> {
    if (this.dropIfExpired(key)) return 0;
    if (!this.strings.has(key) && !this.sets.has(key)) return 0;
    this.expires.set(key, this.now() + seconds * 1000);
    return 1;
  }

  async sadd(key: string, member: string, ...members: string[]): Promise<number> {
    this.dropIfExpired(key);
    const set = this.sets.get(key) ?? new Set<string>();
    this.sets.set(key, set);
    let added = 0;
    for (const item of [member, ...members]) {
      if (set.has(item)) continue;
      set.add(item);
      added += 1;
    }
    return added;
  }

  async srem(key: string, member: string, ...members: string[]): Promise<number> {
    if (this.dropIfExpired(key)) return 0;
    const set = this.sets.get(key);
    if (!set) return 0;
    let removed = 0;
    for (const item of [member, ...members]) {
      if (set.delete(item)) removed += 1;
    }
    return removed;
  }

  async smembers(key: string): Promise<string[]> {
    if (this.dropIfExpired(key)) return [];
    return [...(this.sets.get(key) ?? [])];
  }

  async mget<T>(...keys: string[]): Promise<Array<T | null>> {
    const values: Array<T | null> = [];
    for (const key of keys) values.push(await this.get<T>(key));
    return values;
  }

  async eval<T>(script: string, keys: string[], args: string[]): Promise<T> {
    if (this.onEval) await this.onEval(script);
    return this.evalSync(script, keys, args) as T;
  }

  private evalSync(script: string, keys: string[], args: string[]): unknown {
    if (script === SESSION_CREATE_SCRIPT) {
      const [sessionKey, tokenKey, idsKey] = keys;
      const [payload, tokenValue, sessionId, ttlRaw] = args;
      this.strings.set(sessionKey!, payload!);
      this.strings.set(tokenKey!, tokenValue!);
      const set = this.sets.get(idsKey!) ?? new Set<string>();
      set.add(sessionId!);
      this.sets.set(idsKey!, set);
      const ttl = Number(ttlRaw);
      if (ttl > 0) {
        const exp = this.now() + ttl * 1000;
        this.expires.set(sessionKey!, exp);
        this.expires.set(tokenKey!, exp);
        this.expires.set(idsKey!, exp);
      }
      return 1;
    }
    if (script === SESSION_CAS_SCRIPT) {
      const key = keys[0]!;
      const [expected, payload, ttlRaw] = args;
      if (this.dropIfExpired(key) || !this.strings.has(key)) return 0;
      const doc = JSON.parse(this.strings.get(key)!) as { rev?: unknown };
      if (String(doc.rev) !== expected) return 0;
      this.strings.set(key, payload!);
      const ttl = Number(ttlRaw);
      if (ttl > 0) this.expires.set(key, this.now() + ttl * 1000);
      return 1;
    }
    throw new Error(`FakeRedis has no implementation for script: ${script.slice(0, 80)}`);
  }

  private dropIfExpired(key: string): boolean {
    const exp = this.expires.get(key);
    if (exp == null || this.now() < exp) return false;
    this.strings.delete(key);
    this.sets.delete(key);
    this.expires.delete(key);
    return true;
  }
}

function pair(redis: RedisCommands = new FakeRedis()): { a: RedisSessionStore; b: RedisSessionStore; redis: RedisCommands } {
  return {
    a: new RedisSessionStore({ redis }),
    b: new RedisSessionStore({ redis }),
    redis,
  };
}

test("session scripts compare-and-set the revision and insert the token with the session", () => {
  assert.match(SESSION_CAS_SCRIPT, /cjson\.decode/);
  assert.match(SESSION_CAS_SCRIPT, /tostring\(doc\['rev'\]\)/);
  assert.match(SESSION_CAS_SCRIPT, /redis\.call\('SET'/);
  assert.match(SESSION_CREATE_SCRIPT, /redis\.call\('SET', KEYS\[1\]/);
  assert.match(SESSION_CREATE_SCRIPT, /redis\.call\('SET', KEYS\[2\]/);
  assert.match(SESSION_CREATE_SCRIPT, /redis\.call\('SADD'/);
  assert.equal(sessionTtlSeconds(undefined), 7 * 24 * 60 * 60);
  assert.equal(sessionTtlSeconds("15"), 7 * 24 * 60 * 60);
  assert.equal(sessionTtlSeconds("120"), 120);
});

test("unset Upstash env keeps the in-memory store", () => {
  const missing = createSessionStoreFromEnv({});
  assert.equal(missing.store instanceof SessionStore, true);
  assert.equal(missing.tokenCache, undefined);
  assert.match(missing.description, /memory/);

  const partial = createSessionStoreFromEnv({ UPSTASH_REDIS_REST_URL: "https://example.upstash.io" });
  assert.equal(partial.store instanceof SessionStore, true);

  const ready = createSessionStoreFromEnv({
    UPSTASH_REDIS_REST_URL: "https://example.upstash.io",
    UPSTASH_REDIS_REST_TOKEN: "token",
  });
  assert.equal(ready.store instanceof RedisSessionStore, true);
  assert.ok(ready.tokenCache);

  const kv = createSessionStoreFromEnv({
    KV_REST_API_URL: "https://example.upstash.io",
    KV_REST_API_TOKEN: "token",
  });
  assert.equal(kv.store instanceof RedisSessionStore, true);
});

test("two stores share create, claim, join, and end", async () => {
  const { a, b } = pair();
  for (const name of ["Ayu Prameswari", "Budi Santoso"]) {
    const created = await a.create("Customer", { ...STUB_ONBOARDING, fullName: name });
    const joined = await b.getByToken(created.joinToken);
    assert.equal(joined?.id, created.id);
    assert.equal(joined?.status, "waiting");

    const claimed = await b.claimNext("Desk");
    assert.equal(claimed.ok, true);
    if (!claimed.ok) return;
    assert.equal(claimed.session.id, created.id);
    assert.equal(claimed.session.status, "in_call");
    assert.equal(claimed.session.claimedBy, "Desk");

    const mid = await a.get(created.id);
    assert.equal(mid?.status, "in_call");

    const ended = await a.end(created.id);
    assert.equal(ended.ok, true);
    const after = await b.getByToken(created.joinToken);
    assert.ok(after);
    assert.equal(after?.status, "ended");
    assert.equal(await b.queuePosition(created.id), null);
  }

  assert.equal(await a.getByToken("missing-token"), undefined);
  const empty = await b.claimNext("Desk");
  assert.equal(empty.ok, false);
  if (!empty.ok) assert.equal(empty.error, "empty");
});

test("claim takes the oldest createdAt, then the next arrival", async () => {
  const { a, b } = pair();
  const later = await a.create("Customer", STUB_ONBOARDING, new Date("2026-02-02T00:00:00.000Z"));
  const earlier = await a.create("Customer", STUB_ONBOARDING, new Date("2026-02-01T00:00:00.000Z"));
  const sameClock = new Date("2026-03-01T00:00:00.000Z");
  const firstTie = await a.create("Customer", STUB_ONBOARDING, sameClock);
  const secondTie = await a.create("Customer", STUB_ONBOARDING, sameClock);

  const waiting = await b.list("waiting");
  assert.deepEqual(
    waiting.map((session) => session.id),
    [earlier.id, later.id, firstTie.id, secondTie.id],
  );
  assert.equal(await a.queuePosition(earlier.id), 1);
  assert.equal(await b.queuePosition(secondTie.id), 4);

  const claimed = await b.claimNext("Desk");
  assert.equal(claimed.ok && claimed.session.id, earlier.id);
  const next = await a.claimNext("Desk 2");
  assert.equal(next.ok && next.session.id, later.id);
});

test("concurrent claimNext gives one session to each caller", async () => {
  const redis = new FakeRedis();
  let entered = 0;
  let release: (() => void) | undefined;
  redis.onEval = async (script) => {
    if (script !== SESSION_CAS_SCRIPT) return;
    entered += 1;
    if (entered === 1) {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    } else {
      release?.();
    }
  };
  const a = new RedisSessionStore({ redis });
  const b = new RedisSessionStore({ redis });
  const first = await a.create("Customer", { ...STUB_ONBOARDING, fullName: "First" });
  const second = await a.create("Customer", { ...STUB_ONBOARDING, fullName: "Second" });

  const [left, right] = await Promise.all([a.claimNext("Desk A"), b.claimNext("Desk B")]);
  const wins = [left, right].filter((result) => result.ok);
  assert.equal(wins.length, 2);
  if (left.ok && right.ok) assert.notEqual(left.session.id, right.session.id);
  const ids = new Set([first.id, second.id]);
  if (left.ok) assert.equal(ids.has(left.session.id), true);
  if (right.ok) assert.equal(ids.has(right.session.id), true);
  assert.equal((await a.get(first.id))?.status, "in_call");
  assert.equal((await b.get(second.id))?.status, "in_call");
});

test("one waiting session is claimed by only one of two racers", async () => {
  const redis = new FakeRedis();
  let entered = 0;
  let release: (() => void) | undefined;
  redis.onEval = async (script) => {
    if (script !== SESSION_CAS_SCRIPT) return;
    entered += 1;
    if (entered === 1) {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    } else if (release) {
      release();
    }
  };
  const a = new RedisSessionStore({ redis });
  const b = new RedisSessionStore({ redis });
  const created = await a.create("Customer", STUB_ONBOARDING);
  const [left, right] = await Promise.all([a.claimNext("Desk A"), b.claimNext("Desk B")]);
  const wins = [left, right].filter((result) => result.ok);
  assert.equal(wins.length, 1);
  assert.equal([left, right].some((result) => !result.ok && result.error === "empty"), true);
  const stored = await b.get(created.id);
  assert.equal(stored?.status, "in_call");
  assert.equal(stored?.claimedBy === "Desk A" || stored?.claimedBy === "Desk B", true);
  assert.ok(entered >= 2);
});

test("stills, replies, and recording metadata are visible from the other store", async () => {
  const { a, b } = pair();
  const created = await a.create("Customer", STUB_ONBOARDING);
  await b.accept(created.id, "Desk");
  await a.update(created.id, { maPrompt: { field: "full_name", prompt: "Please type your full name." } });
  const reply = await b.recordReply(created.id, { answer: "Ayu Prameswari" });
  assert.equal(reply.ok, true);
  assert.equal((await a.get(created.id))?.maPrompt, null);
  assert.equal((await a.get(created.id))?.maAnswers[0]?.answer, "Ayu Prameswari");

  const bytes = Buffer.concat([TINY_JPEG, Buffer.from('{"ok":1}12345')]);
  const captured = await a.addCapture(created.id, {
    bytes,
    contentType: "image/jpeg",
    kind: "id",
    capturedAt: "2026-04-01T00:00:00.000Z",
  });
  assert.equal(captured.ok, true);
  if (!captured.ok) return;
  const fromOther = await b.getCapture(created.id, captured.capture.id);
  assert.deepEqual(fromOther?.bytes, bytes);
  assert.equal(fromOther?.capture.kind, "id");
  assert.equal((await b.get(created.id))?.checklist.find((item) => item.id === "docs_shown")?.checked, true);

  await a.end(created.id);
  const attached = await b.attachRecording(created.id, {
    recordingId: "eg_1",
    recordingUrl: "https://example.com/vkyc.mp4",
  });
  assert.equal(attached.ok, true);
  const ended = await a.get(created.id);
  assert.equal(ended?.recordingId, "eg_1");
  assert.equal(ended?.recordingUrl, "https://example.com/vkyc.mp4");
  assert.ok(ended?.recordingAttachedAt);

  const disposition = await b.update(created.id, { disposition: "approve", acwNotes: "matched" });
  assert.equal(disposition.ok, true);
  assert.equal((await a.get(created.id))?.disposition, "approve");
  assert.equal((await a.get(created.id))?.acwNotes, "matched");
});

test("a prefix only sees its own sessions, and idle keys expire", async () => {
  const redis = new FakeRedis();
  let clock = 1_000_000;
  redis.now = () => clock;
  const a = new RedisSessionStore({ redis, prefix: "one", ttlSeconds: 60 });
  const b = new RedisSessionStore({ redis, prefix: "two", ttlSeconds: 60 });
  const session = await a.create("Customer", STUB_ONBOARDING);
  assert.equal(await b.get(session.id), undefined);
  assert.equal(await b.getByToken(session.joinToken), undefined);

  clock += 59_000;
  assert.equal((await a.getByToken(session.joinToken))?.id, session.id);
  clock += 2_000;
  assert.equal(await a.get(session.id), undefined);
  assert.equal(await a.getByToken(session.joinToken), undefined);
});

test("two token caches reuse one LiveKit JWT", async () => {
  const redis = new FakeRedis();
  const firstCache = new RedisTokenCache(redis, "vkyc");
  const secondCache = new RedisTokenCache(redis, "vkyc");
  const credentials = { apiKey: "devkey", apiSecret: "secretsecretsecretsecretsecret12" };
  const first = await participantToken("customer", "vkyc-shared-room", credentials, firstCache);
  const second = await participantToken("customer", "vkyc-shared-room", credentials, secondCache);
  const agent = await participantToken("agent", "vkyc-shared-room", credentials, secondCache);
  assert.equal(first, second);
  assert.notEqual(agent, first);
});

interface ApiResult {
  status: number;
  body: Record<string, unknown> | null;
}

async function listen(store: SessionStoreApi): Promise<{ base: string; close: () => Promise<void> }> {
  const app = createApp(store, {
    customerAppOrigin: "http://localhost:5174",
    corsOrigins: ["http://localhost:5173", "http://localhost:5174"],
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

async function api(base: string, path: string, init?: RequestInit): Promise<ApiResult> {
  const response = await fetch(`${base}${path}`, init);
  const text = await response.text();
  return { status: response.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : null };
}

test("two HTTP servers on one Redis fake do not 404 mid-call", async () => {
  const redis = new FakeRedis();
  const left = await listen(new RedisSessionStore({ redis }));
  const right = await listen(new RedisSessionStore({ redis }));
  try {
    for (const name of ["Ayu Prameswari", "Budi Santoso"]) {
      const created = await api(left.base, "/sessions", {
        method: "POST",
        headers: { "content-type": "application/json", "x-demo-agent": "Customer" },
        body: JSON.stringify({ fullName: name }),
      });
      assert.equal(created.status, 201);
      const id = String(created.body?.id);
      const token = String(created.body?.joinToken);

      const joined = await api(right.base, `/join/${token}`);
      assert.equal(joined.status, 200, JSON.stringify(joined.body));
      assert.equal(joined.body?.status, "waiting");
      assert.equal(joined.body?.sessionId, id);

      const claimed = await api(right.base, "/sessions/claim", {
        method: "POST",
        headers: { "x-demo-agent": "Desk" },
      });
      assert.equal(claimed.status, 200);
      assert.equal(claimed.body?.sessionId, id);
      assert.equal(claimed.body?.status, "in_call");

      const mid = await api(left.base, `/sessions/${id}`);
      assert.equal(mid.status, 200);
      assert.equal(mid.body?.status, "in_call");
      const stillThere = await api(left.base, `/join/${token}`);
      assert.equal(stillThere.status, 200);
      assert.equal(stillThere.body?.status, "in_call");

      if (name === "Ayu Prameswari") {
        const uploaded = await api(left.base, `/sessions/${id}/captures`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ image: TINY_JPEG.toString("base64"), kind: "id" }),
        });
        assert.equal(uploaded.status, 201);
        const captureId = String(uploaded.body?.id);
        const bytes = await fetch(`${right.base}/sessions/${id}/captures/${captureId}`);
        assert.equal(bytes.status, 200);
        assert.equal(bytes.headers.get("content-type"), "image/jpeg");
        assert.deepEqual(Buffer.from(await bytes.arrayBuffer()), TINY_JPEG);
      }

      const ended = await api(left.base, `/sessions/${id}/end`, { method: "POST" });
      assert.equal(ended.status, 200);
      const after = await api(right.base, `/join/${token}`);
      assert.equal(after.status, 200);
      assert.equal(after.body?.status, "ended");
    }

    const missing = await api(right.base, "/join/not-a-real-token");
    assert.equal(missing.status, 404);
    assert.equal(missing.body?.message, "Join link not found");
  } finally {
    await left.close();
    await right.close();
  }
});
