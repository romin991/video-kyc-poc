import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { createApp } from "./app.js";
import { SessionStore } from "./sessions.js";

interface ApiResult {
  status: number;
  body: Record<string, unknown> | null;
}

async function withApi(fn: (base: string) => Promise<void>): Promise<void> {
  const app = createApp(new SessionStore(), {
    customerAppOrigin: "http://localhost:5174",
    corsOrigins: ["http://localhost:5173"],
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

test("session lifecycle: create, queue, accept, join, end", async () => {
  await withApi(async (base) => {
    const created = await api(base, "/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Demo-Agent": "Desk 1" },
      body: "{}",
    });
    assert.equal(created.status, 201);
    assert.equal(created.body?.status, "waiting");
    assert.equal(typeof created.body?.id, "string");
    assert.equal(created.body?.createdBy, "Desk 1");
    assert.match(String(created.body?.joinUrl), /^http:\/\/localhost:5174\/join\/.+/);
    assert.equal("agentToken" in (created.body ?? {}), false);
    assert.equal("customerToken" in (created.body ?? {}), false);

    const id = String(created.body?.id);
    const joinToken = String(created.body?.joinToken);
    const roomName = String(created.body?.roomName);
    assert.notEqual(joinToken, id);
    assert.equal(roomName, `vkyc-${id}`);

    const queue = await api(base, "/sessions?status=waiting");
    assert.equal(queue.status, 200);
    const sessions = queue.body?.sessions as Array<{ id: string }>;
    assert.ok(sessions.some((session) => session.id === id));

    const waitingJoin = await api(base, `/join/${joinToken}`);
    assert.equal(waitingJoin.status, 200);
    assert.equal(waitingJoin.body?.status, "waiting");
    assert.equal(waitingJoin.body?.roomName, roomName);
    assert.match(String(waitingJoin.body?.customerToken), /^lk-stub-customer-/);

    const accepted = await api(base, `/sessions/${id}/accept`, { method: "POST" });
    assert.equal(accepted.status, 200);
    assert.equal(accepted.body?.status, "in_call");
    assert.equal(accepted.body?.roomName, roomName);
    assert.equal(accepted.body?.agentToken, `lk-stub-agent-${roomName}`);

    const conflict = await api(base, `/sessions/${id}/accept`, { method: "POST" });
    assert.equal(conflict.status, 409);

    const liveJoin = await api(base, `/join/${joinToken}`);
    assert.equal(liveJoin.body?.status, "in_call");
    assert.equal(liveJoin.body?.customerToken, `lk-stub-customer-${roomName}`);

    const ended = await api(base, `/sessions/${id}/end`, { method: "POST" });
    assert.equal(ended.status, 200);
    assert.deepEqual(ended.body, { status: "ended", sessionId: id });

    const endedAgain = await api(base, `/sessions/${id}/end`, { method: "POST" });
    assert.equal(endedAgain.status, 200);
    assert.equal(endedAgain.body?.status, "ended");

    const afterEnd = await api(base, `/join/${joinToken}`);
    assert.equal(afterEnd.body?.status, "ended");

    const waitingAfter = await api(base, "/sessions?status=waiting");
    const stillWaiting = waitingAfter.body?.sessions as Array<{ id: string }>;
    assert.equal(stillWaiting.some((session) => session.id === id), false);
  });
});

test("unknown session, bad filter, and missing join link", async () => {
  await withApi(async (base) => {
    const missing = await api(base, "/sessions/does-not-exist/accept", { method: "POST" });
    assert.equal(missing.status, 404);

    const badFilter = await api(base, "/sessions?status=nope");
    assert.equal(badFilter.status, 400);

    const missingJoin = await api(base, "/join/not-a-real-token");
    assert.equal(missingJoin.status, 404);

    const health = await api(base, "/health");
    assert.equal(health.status, 200);
    assert.equal(health.body?.ok, true);
  });
});

test("ending a session that was never accepted still closes the join link", async () => {
  await withApi(async (base) => {
    const created = await api(base, "/sessions", { method: "POST" });
    const id = String(created.body?.id);
    const joinToken = String(created.body?.joinToken);
    const ended = await api(base, `/sessions/${id}/end`, { method: "POST" });
    assert.equal(ended.body?.status, "ended");
    const join = await api(base, `/join/${joinToken}`);
    assert.equal(join.body?.status, "ended");
    const accept = await api(base, `/sessions/${id}/accept`, { method: "POST" });
    assert.equal(accept.status, 409);
  });
});

test("browser origin is echoed for the agent dashboard", async () => {
  await withApi(async (base) => {
    const response = await fetch(`${base}/sessions`, {
      method: "OPTIONS",
      headers: { Origin: "http://localhost:5173", "Access-Control-Request-Method": "POST" },
    });
    assert.equal(response.status, 204);
    assert.equal(response.headers.get("access-control-allow-origin"), "http://localhost:5173");
  });
});
