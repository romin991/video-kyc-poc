import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { createApp } from "./app.js";
import { SessionStore } from "./sessions.js";

delete process.env.LIVEKIT_API_KEY;
delete process.env.LIVEKIT_API_SECRET;

interface ApiResult {
  status: number;
  body: Record<string, unknown> | null;
}

const TINY_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

async function withApi(fn: (base: string) => Promise<void>): Promise<void> {
  const app = createApp(new SessionStore(), {
    customerAppOrigin: "http://localhost:5174",
    corsOrigins: ["http://localhost:5173", "http://localhost:5174"],
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

async function api(base: string, path: string, init?: RequestInit): Promise<ApiResult> {
  const response = await fetch(`${base}${path}`, init);
  const text = await response.text();
  return { status: response.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : null };
}

function sessionBody(fullName: string): string {
  return JSON.stringify({ fullName });
}

test("two waiting sessions: claim one, finish it, the other stays queued", async () => {
  await withApi(async (base) => {
    const first = await api(base, "/sessions", {
      method: "POST",
      headers: { "content-type": "application/json", "x-demo-agent": "Customer" },
      body: sessionBody("Ayu Prameswari"),
    });
    const second = await api(base, "/sessions", {
      method: "POST",
      headers: { "content-type": "application/json", "x-demo-agent": "Customer" },
      body: sessionBody("Budi Santoso"),
    });
    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    assert.equal(first.body?.status, "waiting");
    assert.equal(second.body?.status, "waiting");
    assert.equal(first.body?.queuePosition, 1);
    assert.equal(second.body?.queuePosition, 2);
    assert.equal("agentToken" in (first.body ?? {}), false);

    const firstId = String(first.body?.id);
    const secondId = String(second.body?.id);
    const secondToken = String(second.body?.joinToken);

    const queue = await api(base, "/sessions?status=waiting");
    const waiting = queue.body?.sessions as Array<{ id: string; queuePosition: number; status: string }>;
    assert.deepEqual(
      waiting.map((session) => session.id),
      [firstId, secondId],
    );
    assert.deepEqual(
      waiting.map((session) => session.queuePosition),
      [1, 2],
    );
    assert.equal(waiting.every((session) => session.status === "waiting"), true);

    const joined = await api(base, `/join/${secondToken}`);
    assert.equal(joined.body?.status, "waiting");
    assert.equal(joined.body?.queuePosition, 2);
    assert.match(String(joined.body?.customerToken), /^lk-stub-customer-/);

    const claimed = await api(base, "/sessions/claim", {
      method: "POST",
      headers: { "x-demo-agent": "Desk 1" },
    });
    assert.equal(claimed.status, 200);
    assert.equal(claimed.body?.sessionId, firstId);
    assert.equal(claimed.body?.status, "in_call");
    assert.equal(claimed.body?.claimedBy, "Desk 1");
    assert.match(String(claimed.body?.agentToken), /^lk-stub-agent-/);
    assert.match(String(claimed.body?.joinUrl), /^http:\/\/localhost:5174\/join\//);

    const again = await api(base, `/sessions/${firstId}/accept`, { method: "POST" });
    assert.equal(again.status, 409);

    const stillQueued = await api(base, "/sessions?status=waiting");
    const remaining = stillQueued.body?.sessions as Array<{ id: string; queuePosition: number; status: string }>;
    assert.deepEqual(
      remaining.map((session) => [session.id, session.queuePosition, session.status]),
      [[secondId, 1, "waiting"]],
    );

    const live = await api(base, `/sessions/${firstId}`);
    assert.equal(live.body?.status, "in_call");
    assert.equal(live.body?.claimedBy, "Desk 1");
    assert.equal(live.body?.queuePosition, null);

    const uploaded = await api(base, `/sessions/${firstId}/captures`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ image: TINY_JPEG.toString("base64"), kind: "face" }),
    });
    assert.equal(uploaded.status, 201);

    const ended = await api(base, `/sessions/${firstId}/end`, { method: "POST" });
    assert.equal(ended.body?.status, "ended");

    const disposition = await api(base, `/sessions/${firstId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ disposition: "approve", acwNotes: "Face still matches." }),
    });
    assert.equal(disposition.status, 200);
    assert.equal(disposition.body?.status, "ended");
    assert.equal(disposition.body?.disposition, "approve");
    assert.equal(disposition.body?.queuePosition, null);

    const afterWork = await api(base, "/sessions?status=waiting");
    const after = afterWork.body?.sessions as Array<{ id: string; status: string }>;
    assert.deepEqual(
      after.map((session) => session.id),
      [secondId],
    );
    assert.equal(after[0]?.status, "waiting");

    const secondStillWaiting = await api(base, `/join/${secondToken}`);
    assert.equal(secondStillWaiting.body?.status, "waiting");
    assert.equal(secondStillWaiting.body?.queuePosition, 1);

    const endedJoin = await api(base, `/join/${String(first.body?.joinToken)}`);
    assert.equal(endedJoin.body?.status, "ended");
    assert.equal(endedJoin.body?.queuePosition, null);
  });
});

test("accepting one waiting session by id leaves the rest of the queue", async () => {
  await withApi(async (base) => {
    const older = await api(base, "/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: sessionBody("Older"),
    });
    const newer = await api(base, "/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: sessionBody("Newer"),
    });
    const olderId = String(older.body?.id);
    const newerId = String(newer.body?.id);

    const accepted = await api(base, `/sessions/${newerId}/accept`, {
      method: "POST",
      headers: { "x-demo-agent": "Desk 2" },
    });
    assert.equal(accepted.status, 200);
    assert.equal(accepted.body?.sessionId, newerId);
    assert.equal(accepted.body?.claimedBy, "Desk 2");

    const queue = await api(base, "/sessions?status=waiting");
    const waiting = queue.body?.sessions as Array<{ id: string }>;
    assert.deepEqual(
      waiting.map((session) => session.id),
      [olderId],
    );

    const empty = await api(base, "/sessions/claim", { method: "POST" });
    assert.equal(empty.status, 200);
    assert.equal(empty.body?.sessionId, olderId);

    const none = await api(base, "/sessions/claim", { method: "POST" });
    assert.equal(none.status, 409);
    assert.equal(none.body?.error, "conflict");
  });
});
