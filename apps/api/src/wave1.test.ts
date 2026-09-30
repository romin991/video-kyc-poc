import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { deflateSync, crc32 } from "node:zlib";
import { createApp } from "./app.js";
import { SessionStore } from "./sessions.js";

delete process.env.LIVEKIT_API_KEY;
delete process.env.LIVEKIT_API_SECRET;

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

function chunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])) >>> 0, 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function png(width: number, height: number, rgb: [number, number, number]): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const stride = 1 + width * 3;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const row = y * stride;
    raw[row] = 0;
    for (let x = 0; x < width; x++) {
      const index = row + 1 + x * 3;
      raw[index] = rgb[0];
      raw[index + 1] = rgb[1];
      raw[index + 2] = rgb[2];
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const FACE_PNG = png(8, 8, [214, 255, 74]);
const ID_PNG = png(8, 10, [80, 140, 255]);
const TINY_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

test("create seeds the stub and accepts onboarding overrides", async () => {
  await withApi(async (base) => {
    const seeded = await api(base, "/sessions", { method: "POST", body: "{}" });
    assert.equal(seeded.status, 201);
    const stub = seeded.body?.onboardingPayload as { phone?: string; reason?: string };
    assert.equal(stub.phone, "+628123456789");
    assert.equal(stub.reason, "New savings account video KYC");

    const custom = await api(base, "/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        fullName: "Citra",
        product: "TIME-DEPOSIT",
        onboarding: { fullName: "Budi Santoso", applicationId: "APP-9" },
      }),
    });
    assert.equal(custom.status, 201);
    const payload = custom.body?.onboardingPayload as {
      fullName: string;
      phone: string;
      productId: string;
      applicationId: string;
    };
    assert.equal(payload.fullName, "Budi Santoso");
    assert.equal(payload.applicationId, "APP-9");
    assert.equal(payload.productId, "TIME-DEPOSIT");
    assert.equal(payload.phone, "+628123456789");

    const bad = await api(base, "/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phone: 628 }),
    });
    assert.equal(bad.status, 400);
  });
});

test("checklist, notes, captures, and disposition survive a refresh", async () => {
  await withApi(async (base) => {
    const created = await api(base, "/sessions", { method: "POST" });
    const id = String(created.body?.id);

    const early = await api(base, `/sessions/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ disposition: "Approve" }),
    });
    assert.equal(early.status, 409);

    const patched = await api(base, `/sessions/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        checklist: [
          { id: "identity_match", checked: true },
          { id: "liveness_digits", checked: true },
        ],
        acwNotes: "Customer spelled the digits.",
      }),
    });
    assert.equal(patched.status, 200);
    assert.equal(patched.body?.acwNotes, "Customer spelled the digits.");
    const checks = patched.body?.checklist as Array<{ id: string; checked: boolean }>;
    assert.equal(checks.find((item) => item.id === "identity_match")?.checked, true);
    assert.equal(checks.find((item) => item.id === "docs_shown")?.checked, false);

    const unknown = await api(base, `/sessions/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ checklist: [{ id: "escalate", checked: true }] }),
    });
    assert.equal(unknown.status, 400);

    const blocked = await api(base, `/sessions/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ disposition: "reject" }),
    });
    assert.equal(blocked.status, 409);

    const endedBare = await api(base, "/sessions", { method: "POST" });
    const bareId = String(endedBare.body?.id);
    assert.equal((await api(base, `/sessions/${bareId}/end`, { method: "POST" })).status, 200);
    const needStill = await api(base, `/sessions/${bareId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ disposition: "reject" }),
    });
    assert.equal(needStill.status, 422);
    assert.equal(needStill.body?.error, "capture_required");

    const uploaded = await api(base, `/sessions/${id}/captures`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        image: `data:image/png;base64,${FACE_PNG.toString("base64")}`,
        kind: "face",
        capturedAt: "2026-09-30T07:00:00.000Z",
      }),
    });
    assert.equal(uploaded.status, 201);
    assert.equal(uploaded.body?.kind, "face");
    assert.equal(uploaded.body?.contentType, "image/png");
    assert.equal(uploaded.body?.capturedAt, "2026-09-30T07:00:00.000Z");
    const capturePath = String(uploaded.body?.path);
    assert.match(capturePath, new RegExp(`^/sessions/${id}/captures/cap_`));

    const form = new FormData();
    form.append("kind", "id");
    form.append("image", new Blob([new Uint8Array(ID_PNG)], { type: "image/png" }), "id-front.png");
    const multipart = await fetch(`${base}/sessions/${id}/captures`, { method: "POST", body: form });
    assert.equal(multipart.status, 201);
    const second = (await multipart.json()) as { kind?: string; contentType?: string; path?: string };
    assert.equal(second.kind, "id");
    assert.equal(second.contentType, "image/png");

    const jpeg = await api(base, `/sessions/${id}/captures`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ image: TINY_JPEG.toString("base64"), kind: "other" }),
    });
    assert.equal(jpeg.status, 201);
    assert.equal(jpeg.body?.contentType, "image/jpeg");

    const garbage = await api(base, `/sessions/${id}/captures`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ image: Buffer.from("not-an-image").toString("base64") }),
    });
    assert.equal(garbage.status, 400);

    const image = await fetch(`${base}${capturePath}`);
    assert.equal(image.status, 200);
    assert.equal(image.headers.get("content-type"), "image/png");
    const bytes = Buffer.from(await image.arrayBuffer());
    assert.ok(bytes.equals(FACE_PNG));

    const missingImage = await api(base, `/sessions/${id}/captures/cap_missing`);
    assert.equal(missingImage.status, 404);

    const beforeEnd = await api(base, `/sessions/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ disposition: "UTV" }),
    });
    assert.equal(beforeEnd.status, 409);

    const ended = await api(base, `/sessions/${id}/end`, { method: "POST" });
    assert.equal(ended.status, 200);

    const disposition = await api(base, `/sessions/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ disposition: "Approve", acwNotes: "Face still matches the stub profile." }),
    });
    assert.equal(disposition.status, 200);
    assert.equal(disposition.body?.disposition, "approve");
    assert.equal(disposition.body?.status, "ended");
    const captures = disposition.body?.captures as Array<{ id: string; kind: string; url: string; path: string }>;
    assert.equal(captures.length, 3);
    assert.deepEqual(
      captures.map((item) => item.kind),
      ["face", "id", "other"],
    );
    assert.match(captures[0].url, new RegExp(`/sessions/${id}/captures/`));

    const again = await api(base, `/sessions/${id}`);
    assert.equal(again.status, 200);
    assert.equal(again.body?.disposition, "approve");
    assert.equal(again.body?.acwNotes, "Face still matches the stub profile.");
    assert.equal((again.body?.captures as unknown[]).length, 3);
    const againChecks = again.body?.checklist as Array<{ id: string; checked: boolean }>;
    assert.equal(againChecks.find((item) => item.id === "identity_match")?.checked, true);
  });
});

test("capture upload and patch reject an unknown session", async () => {
  await withApi(async (base) => {
    const missing = await api(base, "/sessions/missing/captures", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ image: FACE_PNG.toString("base64"), kind: "face" }),
    });
    assert.equal(missing.status, 404);

    const badKind = await api(base, "/sessions", { method: "POST" });
    const id = String(badKind.body?.id);
    const kind = await api(base, `/sessions/${id}/captures`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ image: FACE_PNG.toString("base64"), kind: "escalate" }),
    });
    assert.equal(kind.status, 400);

    const options = await fetch(`${base}/sessions/${id}`, {
      method: "OPTIONS",
      headers: { Origin: "http://localhost:5173", "Access-Control-Request-Method": "PATCH" },
    });
    assert.equal(options.status, 204);
    assert.match(options.headers.get("access-control-allow-methods") ?? "", /PATCH/);
  });
});
