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

function json(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

async function openCall(base: string): Promise<{ id: string; token: string }> {
  const created = await api(base, "/sessions", { method: "POST" });
  assert.equal(created.status, 201);
  const id = String(created.body?.id);
  const token = String(created.body?.joinToken);
  const accepted = await api(base, `/sessions/${id}/accept`, { method: "POST" });
  assert.equal(accepted.status, 200);
  return { id, token };
}

test("manual auth prompts, digit replies, and stub match flags", async () => {
  await withApi(async (base) => {
    const created = await api(base, "/sessions", { method: "POST" });
    assert.equal(created.body?.maPrompt, null);
    assert.deepEqual(created.body?.maAnswers, []);
    assert.equal(created.body?.digitChallenge, null);
    assert.equal(created.body?.digitResponse, null);
    assert.equal(created.body?.digitRespondedAt, null);
    assert.equal(created.body?.maMatch, null);
    assert.equal(created.body?.digitMatch, null);

    const id = String(created.body?.id);
    const token = String(created.body?.joinToken);

    const waitingReply = await api(base, `/join/${token}/replies`, json("POST", { answer: "too early" }));
    assert.equal(waitingReply.status, 409);

    const accepted = await api(base, `/sessions/${id}/accept`, { method: "POST" });
    assert.equal(accepted.status, 200);

    const asked = await api(
      base,
      `/sessions/${id}`,
      json("PATCH", { maPrompt: { field: "full_name" } }),
    );
    assert.equal(asked.status, 200);
    const maPrompt = asked.body?.maPrompt as { field?: string; prompt?: string; sentAt?: string };
    assert.equal(maPrompt.field, "full_name");
    assert.match(maPrompt.prompt ?? "", /full name/i);
    assert.equal(Number.isNaN(Date.parse(maPrompt.sentAt ?? "")), false);

    const join = await api(base, `/join/${token}`);
    assert.equal(join.status, 200);
    assert.equal((join.body?.maPrompt as { field?: string }).field, "full_name");
    assert.equal(join.body?.digitChallenge, null);

    const missing = await api(base, `/join/${token}/replies`, json("POST", {}));
    assert.equal(missing.status, 400);

    const answered = await api(base, `/join/${token}/replies`, json("POST", { answer: "  Ayu Prameswari  " }));
    assert.equal(answered.status, 200);
    assert.equal(answered.body?.ok, true);
    assert.equal(answered.body?.maPrompt, null);

    const logged = await api(base, `/sessions/${id}`);
    const answers = logged.body?.maAnswers as Array<{ field: string; answer: string; prompt: string }>;
    assert.equal(answers.length, 1);
    assert.equal(answers[0]?.field, "full_name");
    assert.equal(answers[0]?.answer, "Ayu Prameswari");
    assert.equal(logged.body?.maPrompt, null);

    const dob = await api(base, `/sessions/${id}`, json("PATCH", { maPrompt: { field: "dob" } }));
    assert.equal(dob.status, 200);
    assert.equal((await api(base, `/join/${token}/replies`, json("POST", { answer: "1994-03-15" }))).status, 200);
    const maiden = await api(
      base,
      `/sessions/${id}`,
      json("PATCH", {
        maPrompt: { field: "mothers_maiden_name", prompt: "Mother's maiden name, please." },
      }),
    );
    assert.equal(maiden.status, 200);
    assert.equal(
      (maiden.body?.maPrompt as { prompt?: string }).prompt,
      "Mother's maiden name, please.",
    );
    assert.equal((await api(base, `/join/${token}/replies`, json("POST", { answer: "Wijaya" }))).status, 200);

    const both = await api(base, `/sessions/${id}`);
    const fields = (both.body?.maAnswers as Array<{ field: string; answer: string }>).map((item) => item.field);
    assert.deepEqual(fields, ["full_name", "dob", "mothers_maiden_name"]);
    assert.equal((both.body?.maAnswers as Array<{ answer: string }>)[2]?.answer, "Wijaya");

    const dobAgain = await api(base, `/sessions/${id}`, json("PATCH", { maPrompt: { field: "dob" } }));
    assert.equal(dobAgain.status, 200);
    assert.equal((await api(base, `/join/${token}/replies`, json("POST", { answer: "1-1-1" }))).status, 200);
    const replaced = await api(base, `/sessions/${id}`);
    const replacedAnswers = replaced.body?.maAnswers as Array<{ field: string; answer: string }>;
    assert.deepEqual(
      replacedAnswers.map((item) => item.field),
      ["full_name", "dob", "mothers_maiden_name"],
    );
    assert.equal(replacedAnswers.find((item) => item.field === "dob")?.answer, "1-1-1");
    assert.equal(replacedAnswers.find((item) => item.field === "full_name")?.answer, "Ayu Prameswari");
    assert.equal(replacedAnswers.find((item) => item.field === "mothers_maiden_name")?.answer, "Wijaya");
    const replacedChecks = replaced.body?.checklist as Array<{ id: string; checked: boolean }>;
    assert.equal(replacedChecks.find((item) => item.id === "identity_match")?.checked, false);

    const digits = await api(base, `/sessions/${id}`, json("PATCH", { digitChallenge: { digits: "48 21" } }));
    assert.equal(digits.status, 200);
    const challenge = digits.body?.digitChallenge as { digits?: string; prompt?: string };
    assert.equal(challenge.digits, "4821");
    assert.match(challenge.prompt ?? "", /4 8 2 1/);

    const digitJoin = await api(base, `/join/${token}`);
    assert.equal((digitJoin.body?.digitChallenge as { digits?: string }).digits, "4821");

    const spoken = await api(base, `/join/${token}/replies`, json("POST", { digitResponse: "4 8 2 1" }));
    assert.equal(spoken.status, 200);
    assert.equal(spoken.body?.digitChallenge, null);

    const afterDigits = await api(base, `/sessions/${id}`);
    assert.equal(afterDigits.body?.digitResponse, "4 8 2 1");
    assert.equal(afterDigits.body?.digitChallenge, null);
    assert.equal(typeof afterDigits.body?.digitRespondedAt, "string");
    const checks = afterDigits.body?.checklist as Array<{ id: string; checked: boolean }>;
    assert.equal(checks.find((item) => item.id === "liveness_digits")?.checked, true);
    assert.equal(checks.find((item) => item.id === "identity_match")?.checked, false);

    const passed = await api(base, `/sessions/${id}`, json("PATCH", { maMatch: true, digitMatch: false }));
    assert.equal(passed.status, 200);
    assert.equal(passed.body?.maMatch, true);
    assert.equal(passed.body?.digitMatch, false);
    const passedChecks = passed.body?.checklist as Array<{ id: string; checked: boolean }>;
    assert.equal(passedChecks.find((item) => item.id === "identity_match")?.checked, true);
    assert.equal(passedChecks.find((item) => item.id === "liveness_digits")?.checked, true);

    const failed = await api(base, `/sessions/${id}`, json("PATCH", { maMatch: false }));
    assert.equal(failed.body?.maMatch, false);
    const failedChecks = failed.body?.checklist as Array<{ id: string; checked: boolean }>;
    assert.equal(failedChecks.find((item) => item.id === "identity_match")?.checked, false);

    const noted = await api(base, `/sessions/${id}`, json("PATCH", { acwNotes: "Reviewed on the call." }));
    const notedChecks = noted.body?.checklist as Array<{ id: string; checked: boolean }>;
    assert.equal(notedChecks.find((item) => item.id === "identity_match")?.checked, false);

    const again = await api(base, `/sessions/${id}`, json("PATCH", { digitChallenge: { digits: "1357" } }));
    assert.equal(again.body?.digitResponse, null);
    assert.equal((again.body?.digitChallenge as { digits?: string }).digits, "1357");

    const badField = await api(base, `/sessions/${id}`, json("PATCH", { maPrompt: { field: "nik" } }));
    assert.equal(badField.status, 400);
    const badDigits = await api(base, `/sessions/${id}`, json("PATCH", { digitChallenge: { digits: "12" } }));
    assert.equal(badDigits.status, 400);
    const stillWaiting = await api(base, `/sessions/${id}`);
    assert.equal((stillWaiting.body?.digitChallenge as { digits?: string }).digits, "1357");
  });
});

test("capture kinds selfie_ktp and extra doc tick documents and disposition still saves", async () => {
  await withApi(async (base) => {
    const { id, token } = await openCall(base);

    const face = await api(
      base,
      `/sessions/${id}/captures`,
      json("POST", { image: TINY_JPEG.toString("base64"), kind: "face" }),
    );
    assert.equal(face.status, 201);
    assert.equal(face.body?.kind, "face");
    const afterFace = await api(base, `/sessions/${id}`);
    const faceChecks = afterFace.body?.checklist as Array<{ id: string; checked: boolean }>;
    assert.equal(faceChecks.find((item) => item.id === "docs_shown")?.checked, false);

    const selfie = await api(
      base,
      `/sessions/${id}/captures`,
      json("POST", { image: TINY_JPEG.toString("base64"), kind: "selfie+ktp" }),
    );
    assert.equal(selfie.status, 201);
    assert.equal(selfie.body?.kind, "selfie_ktp");

    const extra = await api(
      base,
      `/sessions/${id}/captures`,
      json("POST", { image: TINY_JPEG.toString("base64"), kind: "doc" }),
    );
    assert.equal(extra.status, 201);
    assert.equal(extra.body?.kind, "other");

    const guide = await api(base, `/sessions/${id}`, json("PATCH", { captureGuide: "selfie_ktp" }));
    assert.equal(guide.status, 200);
    assert.equal(guide.body?.captureGuide, "selfie_ktp");
    const join = await api(base, `/join/${token}`);
    assert.equal(join.body?.captureGuide, "selfie_ktp");

    const idGuide = await api(base, `/sessions/${id}`, json("PATCH", { captureGuide: "id" }));
    assert.equal(idGuide.body?.captureGuide, "id");
    assert.equal((await api(base, `/join/${token}`)).body?.captureGuide, "id");

    const docs = await api(base, `/sessions/${id}`);
    const kinds = (docs.body?.captures as Array<{ kind: string }>).map((item) => item.kind);
    assert.deepEqual(kinds, ["face", "selfie_ktp", "other"]);
    const checks = docs.body?.checklist as Array<{ id: string; checked: boolean }>;
    assert.equal(checks.find((item) => item.id === "docs_shown")?.checked, true);

    const unknown = await api(
      base,
      `/sessions/${id}/captures`,
      json("POST", { image: TINY_JPEG.toString("base64"), kind: "escalate" }),
    );
    assert.equal(unknown.status, 400);

    assert.equal((await api(base, `/sessions/${id}/end`, { method: "POST" })).status, 200);
    for (const disposition of ["approve", "reject", "utv"] as const) {
      const saved = await api(base, `/sessions/${id}`, json("PATCH", { disposition }));
      assert.equal(saved.status, 200, disposition);
      assert.equal(saved.body?.disposition, disposition);
    }
  });
});

test("a reply with no active prompt is rejected", async () => {
  await withApi(async (base) => {
    const { id, token } = await openCall(base);
    const answer = await api(base, `/join/${token}/replies`, json("POST", { answer: "Ayu" }));
    assert.equal(answer.status, 409);
    const digits = await api(base, `/join/${token}/replies`, json("POST", { digitResponse: "1234" }));
    assert.equal(digits.status, 409);
    const letters = await api(
      base,
      `/sessions/${id}`,
      json("PATCH", { digitChallenge: { digits: "1234" } }),
    );
    assert.equal(letters.status, 200);
    const bad = await api(base, `/join/${token}/replies`, json("POST", { digitResponse: "four" }));
    assert.equal(bad.status, 400);
    assert.equal((await api(base, `/sessions/${id}`)).body?.digitResponse, null);

    assert.equal((await api(base, `/sessions/${id}/end`, { method: "POST" })).status, 200);
    const late = await api(base, `/join/${token}/replies`, json("POST", { digitResponse: "1234" }));
    assert.equal(late.status, 409);
  });
});
