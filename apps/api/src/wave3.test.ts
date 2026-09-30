import assert from "node:assert/strict";
import { once } from "node:events";
import { access, mkdtemp, readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createApp, type AppOptions } from "./app.js";
import { SessionStore } from "./sessions.js";

delete process.env.LIVEKIT_API_KEY;
delete process.env.LIVEKIT_API_SECRET;

const TINY_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

interface ApiResult {
  status: number;
  body: Record<string, unknown> | null;
}

interface HookHit {
  path: string;
  body: Record<string, unknown>;
  status: number;
}

async function withApi(options: AppOptions, fn: (base: string) => Promise<void>): Promise<void> {
  const app = createApp(new SessionStore(), {
    customerAppOrigin: "http://localhost:5174",
    corsOrigins: ["http://localhost:5173"],
    ...options,
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

async function withHooks(
  handler: (req: IncomingMessage, res: ServerResponse, body: Record<string, unknown>) => void,
  fn: (url: (path: string) => string, hits: () => HookHit[]) => Promise<void>,
): Promise<void> {
  const hits: HookHit[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      const body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
      const path = req.url ?? "/";
      hits.push({ path, body, status: res.statusCode });
      handler(req, res, body);
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  try {
    await fn((path) => `http://127.0.0.1:${address.port}${path}`, () => hits);
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

async function logLines(path: string): Promise<Record<string, unknown>[]> {
  const text = await readFile(path, "utf8");
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function missing(path: string): Promise<boolean> {
  try {
    await access(path);
    return false;
  } catch {
    return true;
  }
}

async function endedSession(base: string): Promise<string> {
  const created = await api(base, "/sessions", {
    method: "POST",
    headers: { "content-type": "application/json", "x-demo-agent": "Customer" },
    body: "{}",
  });
  assert.equal(created.status, 201);
  const id = String(created.body?.id);
  const claimed = await api(base, `/sessions/${id}/accept`, {
    method: "POST",
    headers: { "x-demo-agent": "Desk 1" },
  });
  assert.equal(claimed.status, 200);
  const uploaded = await api(base, `/sessions/${id}/captures`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ image: TINY_JPEG.toString("base64"), kind: "face" }),
  });
  assert.equal(uploaded.status, 201);
  const ended = await api(base, `/sessions/${id}/end`, { method: "POST" });
  assert.equal(ended.status, 200);
  return id;
}

test("recording attach stores a url and id for after-call work", async () => {
  const logPath = join(await mkdtemp(join(tmpdir(), "vkyc-rec-")), "stubs.jsonl");
  await withApi({ stubs: { logPath } }, async (base) => {
    const created = await api(base, "/sessions", { method: "POST", body: "{}" });
    assert.equal(created.status, 201);
    assert.equal(created.body?.recordingUrl, null);
    assert.equal(created.body?.recordingId, null);
    assert.equal(created.body?.recordingAttachedAt, null);
    const id = String(created.body?.id);

    const missingSession = await api(base, "/sessions/missing/recording", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ recordingId: "EG_missing" }),
    });
    assert.equal(missingSession.status, 404);

    const empty = await api(base, `/sessions/${id}/recording`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(empty.status, 400);

    const ftp = await api(base, `/sessions/${id}/recording`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ recordingUrl: "ftp://files.example/call.mp4" }),
    });
    assert.equal(ftp.status, 400);

    const idOnly = await api(base, `/sessions/${id}/recording`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ recordingId: " EG_room_1 " }),
    });
    assert.equal(idOnly.status, 200);
    assert.equal(idOnly.body?.recordingId, "EG_room_1");
    assert.equal(idOnly.body?.recordingUrl, null);
    assert.equal(typeof idOnly.body?.recordingAttachedAt, "string");

    const attached = await api(base, `/sessions/${id}/recording`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ recordingUrl: "https://egress.example/vkyc/call.mp4" }),
    });
    assert.equal(attached.status, 200);
    assert.equal(attached.body?.recordingUrl, "https://egress.example/vkyc/call.mp4");
    assert.equal(attached.body?.recordingId, "EG_room_1");
    assert.equal(attached.body?.status, "waiting");

    const bad = await api(base, `/sessions/${id}/recording`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ recordingUrl: "not a url" }),
    });
    assert.equal(bad.status, 400);
    const still = await api(base, `/sessions/${id}`);
    assert.equal(still.body?.recordingUrl, "https://egress.example/vkyc/call.mp4");
    assert.equal(still.body?.recordingId, "EG_room_1");

    assert.equal((await api(base, `/sessions/${id}/end`, { method: "POST" })).status, 200);
    const ended = await api(base, `/sessions/${id}`);
    assert.equal(ended.body?.status, "ended");
    assert.equal(ended.body?.recordingUrl, "https://egress.example/vkyc/call.mp4");
    assert.equal(ended.body?.recordingId, "EG_room_1");

    const listed = await api(base, "/sessions?status=ended");
    const sessions = listed.body?.sessions as Array<{ id: string; recordingUrl: string | null }>;
    assert.equal(sessions.find((session) => session.id === id)?.recordingUrl, "https://egress.example/vkyc/call.mp4");
    assert.equal(await missing(logPath), true);
  });
});

test("disposition posts stub payloads to CRM and datalake webhooks", async () => {
  await withHooks(
    (_req, res) => {
      res.writeHead(204);
      res.end();
    },
    async (hookUrl, hits) => {
      const logPath = join(await mkdtemp(join(tmpdir(), "vkyc-hook-")), "stubs.jsonl");
      await withApi(
        {
          stubs: {
            crmWebhookUrl: hookUrl("/crm"),
            datalakeWebhookUrl: hookUrl("/datalake"),
            logPath,
          },
        },
        async (base) => {
          const id = await endedSession(base);
          const recording = await api(base, `/sessions/${id}/recording`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              recordingUrl: "https://egress.example/vkyc/call.mp4",
              recordingId: "EG_call",
            }),
          });
          assert.equal(recording.status, 200);

          const blocked = await api(base, "/sessions", { method: "POST", body: "{}" });
          const openId = String(blocked.body?.id);
          const tooSoon = await api(base, `/sessions/${openId}`, {
            method: "PATCH",
            headers: { "content-type": "application/json", "x-demo-agent": "Closer" },
            body: JSON.stringify({ disposition: "approve" }),
          });
          assert.equal(tooSoon.status, 409);
          assert.equal(hits().length, 0);

          const disposition = await api(base, `/sessions/${id}`, {
            method: "PATCH",
            headers: { "content-type": "application/json", "x-demo-agent": "Closer" },
            body: JSON.stringify({ disposition: "Approve" }),
          });
          assert.equal(disposition.status, 200);
          assert.equal(disposition.body?.disposition, "approve");

          const received = hits();
          assert.equal(received.length, 2);
          const byPath = new Map(received.map((hit) => [hit.path, hit.body]));
          for (const [path, sink] of [
            ["/crm", "crm"],
            ["/datalake", "datalake"],
          ] as const) {
            const payload = byPath.get(path);
            assert.ok(payload, path);
            assert.equal(payload.sink, sink);
            assert.equal(payload.sessionId, id);
            assert.equal(payload.disposition, "approve");
            assert.equal(payload.agentId, "Closer");
            assert.equal(payload.claimedBy, "Desk 1");
            const timestamps = payload.timestamps as {
              createdAt: string;
              acceptedAt: string | null;
              endedAt: string | null;
              dispositionAt: string;
            };
            assert.equal(typeof timestamps.createdAt, "string");
            assert.equal(typeof timestamps.acceptedAt, "string");
            assert.equal(typeof timestamps.endedAt, "string");
            assert.equal(Number.isNaN(Date.parse(timestamps.dispositionAt)), false);
            const captures = payload.captures as Array<{ id: string; kind: string; url: string }>;
            assert.equal(captures.length, 1);
            assert.equal(captures[0]?.kind, "face");
            assert.match(captures[0]?.url ?? "", new RegExp(`/sessions/${id}/captures/`));
            const recordingFields = payload.recording as { id: string | null; url: string | null };
            assert.equal(recordingFields.id, "EG_call");
            assert.equal(recordingFields.url, "https://egress.example/vkyc/call.mp4");
            assert.equal("webhookError" in payload, false);
          }
          assert.equal(await missing(logPath), true);

          const notes = await api(base, `/sessions/${id}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ acwNotes: "No second stub." }),
          });
          assert.equal(notes.status, 200);
          assert.equal(hits().length, 2);
        },
      );
    },
  );
});

test("disposition appends a JSON line per sink when webhooks are unset", async () => {
  const logPath = join(await mkdtemp(join(tmpdir(), "vkyc-log-")), "stubs.jsonl");
  await withApi({ stubs: { logPath } }, async (base) => {
    const created = await api(base, "/sessions", { method: "POST", body: "{}" });
    const bareId = String(created.body?.id);
    assert.equal((await api(base, `/sessions/${bareId}/end`, { method: "POST" })).status, 200);
    const needStill = await api(base, `/sessions/${bareId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ disposition: "reject" }),
    });
    assert.equal(needStill.status, 422);
    assert.equal(await missing(logPath), true);

    const id = await endedSession(base);
    const disposition = await api(base, `/sessions/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-demo-agent": "Closer" },
      body: JSON.stringify({ disposition: "UTV" }),
    });
    assert.equal(disposition.status, 200);

    const lines = await logLines(logPath);
    assert.deepEqual(
      lines.map((line) => line.sink).sort(),
      ["crm", "datalake"],
    );
    for (const line of lines) {
      assert.equal(line.sessionId, id);
      assert.equal(line.disposition, "utv");
      assert.equal(line.agentId, "Closer");
      assert.equal(line.claimedBy, "Desk 1");
      const timestamps = line.timestamps as { dispositionAt: string; endedAt: string | null };
      assert.equal(typeof timestamps.endedAt, "string");
      assert.equal(Number.isNaN(Date.parse(timestamps.dispositionAt)), false);
      const captures = line.captures as Array<{ kind: string; url: string }>;
      assert.equal(captures[0]?.kind, "face");
      assert.match(String(captures[0]?.url), /^http:\/\//);
    }

    const cleared = await api(base, `/sessions/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ disposition: null }),
    });
    assert.equal(cleared.status, 200);
    assert.equal(cleared.body?.disposition, null);
    assert.equal((await logLines(logPath)).length, 2);

    const again = await api(base, `/sessions/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ disposition: "reject" }),
    });
    assert.equal(again.status, 200);
    const after = await logLines(logPath);
    assert.equal(after.length, 4);
    assert.deepEqual(
      after.slice(2).map((line) => line.disposition),
      ["reject", "reject"],
    );
  });
});

test("a failed disposition webhook falls back to the log file", async () => {
  await withHooks(
    (_req, res) => {
      res.writeHead(500);
      res.end("no");
    },
    async (hookUrl) => {
      const logPath = join(await mkdtemp(join(tmpdir(), "vkyc-fail-")), "stubs.jsonl");
      await withApi(
        {
          stubs: {
            crmWebhookUrl: hookUrl("/crm"),
            datalakeWebhookUrl: hookUrl("/datalake"),
            logPath,
          },
        },
        async (base) => {
          const id = await endedSession(base);
          const disposition = await api(base, `/sessions/${id}`, {
            method: "PATCH",
            headers: { "content-type": "application/json", "x-demo-agent": "Closer" },
            body: JSON.stringify({ disposition: "reject" }),
          });
          assert.equal(disposition.status, 200);
          assert.equal(disposition.body?.disposition, "reject");
          const lines = await logLines(logPath);
          assert.equal(lines.length, 2);
          assert.deepEqual(
            lines.map((line) => line.sink).sort(),
            ["crm", "datalake"],
          );
          for (const line of lines) {
            assert.equal(line.webhookError, "webhook returned 500");
            assert.equal(line.sessionId, id);
          }
        },
      );
    },
  );
});
