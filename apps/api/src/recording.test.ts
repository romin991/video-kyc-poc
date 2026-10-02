import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { EncodedFileOutput, EncodedFileType } from "livekit-server-sdk";
import { createApp } from "./app.js";
import {
  classifyEgressError,
  createCallRecorder,
  createCallRecorderFromEnv,
  playableRecordingUrl,
  postSessionRecording,
  type CallRecorder,
  type EgressApi,
  type EgressSnapshot,
  type RecordingAttach,
} from "./recording.js";
import { SessionStore } from "./sessions.js";

test("playable recording URLs prefer https locations", () => {
  assert.equal(
    playableRecordingUrl({ location: "https://cdn.example/vkyc/call.mp4", filename: "call.mp4" }),
    "https://cdn.example/vkyc/call.mp4",
  );
  assert.equal(
    playableRecordingUrl({ location: "s3://vkyc-recordings/recordings/room.mp4", filename: "room.mp4" }),
    null,
  );
  assert.equal(
    playableRecordingUrl(
      { location: "s3://vkyc-recordings/recordings/room.mp4" },
      "https://vkyc-recordings.s3.ap-southeast-3.amazonaws.com",
    ),
    "https://vkyc-recordings.s3.ap-southeast-3.amazonaws.com/recordings/room.mp4",
  );
  assert.equal(
    playableRecordingUrl({ filename: "recordings/room.mp4" }, "https://files.example/vkyc"),
    "https://files.example/vkyc/recordings/room.mp4",
  );
  assert.equal(playableRecordingUrl({ location: "http://example.com/call.mp4" }), null);
  assert.equal(
    playableRecordingUrl({ location: "http://127.0.0.1:3001/sessions/abc/call-recording/file" }),
    "http://127.0.0.1:3001/sessions/abc/call-recording/file",
  );
});

test("egress errors split room-not-live from storage that cannot record", () => {
  assert.equal(classifyEgressError(new Error("twirp error not_found: requested room does not exist")), "room_missing");
  assert.equal(classifyEgressError(new Error("no file output configured")), "blocked");
  assert.equal(classifyEgressError(new Error("egress is not enabled for this project")), "blocked");
  assert.equal(classifyEgressError(new Error("upstream timeout")), "retry");
});

test("recorder is off without LiveKit URL, key, and secret", () => {
  assert.equal(createCallRecorderFromEnv({}), undefined);
  assert.equal(createCallRecorderFromEnv({ LIVEKIT_URL: "wss://example.livekit.cloud" }), undefined);
  assert.equal(
    createCallRecorderFromEnv({
      LIVEKIT_URL: "wss://example.livekit.cloud",
      LIVEKIT_API_KEY: "key",
      LIVEKIT_API_SECRET: "secret",
    }) instanceof Object,
    true,
  );
});

test("in-call room composite patches the egress id, then the https file URL", async () => {
  const clock = virtualClock();
  const egress = fakeEgress();
  egress.files.push({ location: "https://cdn.example/vkyc/call.mp4", filename: "call.mp4" });
  const patches: Array<{ id: string; body: RecordingAttach }> = [];
  const recorder = createCallRecorder({
    egress,
    rooms: { listRooms: async () => [{ name: "vkyc-session-1" }] },
    attach: async (id, body) => {
      patches.push({ id, body });
      return { ok: true };
    },
    now: clock.now,
    sleep: clock.sleep,
    file: { bucket: "vkyc-recordings", region: "ap-southeast-3", accessKey: "ak", secret: "sk" },
    attachBackoffMs: 0,
  });

  recorder.onInCall({ id: "session-1", roomName: "vkyc-session-1" });
  await recorder.idle("session-1");

  assert.deepEqual(egress.starts, ["vkyc-session-1"]);
  const output = egress.outputs[0];
  assert.equal(output?.fileType, EncodedFileType.MP4);
  assert.equal(output?.filepath, "recordings/{room_name}-{time}.mp4");
  assert.equal(output?.disableManifest, true);
  assert.equal(output?.output.case, "s3");
  if (output?.output.case === "s3") {
    assert.equal(output.output.value.bucket, "vkyc-recordings");
    assert.equal(output.output.value.region, "ap-southeast-3");
  }
  assert.deepEqual(patches, [{ id: "session-1", body: { recordingId: "EG_1" } }]);
  assert.deepEqual(recorder.status("session-1"), { mode: "egress", recordingId: "EG_1" });

  recorder.onInCall({ id: "session-1", roomName: "vkyc-session-1" });
  await recorder.idle("session-1");
  assert.equal(egress.starts.length, 1);

  await recorder.onEnded({ id: "session-1", roomName: "vkyc-session-1" });
  assert.deepEqual(egress.stops, ["EG_1"]);
  assert.deepEqual(patches[1], {
    id: "session-1",
    body: { recordingId: "EG_1", recordingUrl: "https://cdn.example/vkyc/call.mp4" },
  });
  assert.equal(recorder.status("session-1").mode, "stopped");
});

test("egress waits until the room is live and does not start after the call ends", async () => {
  const clock = virtualClock();
  let live = false;
  const egress = fakeEgress();
  const recorder = createCallRecorder({
    egress,
    rooms: {
      listRooms: async (names) => (live ? [{ name: names?.[0] }] : []),
    },
    attach: async () => ({ ok: true }),
    now: clock.now,
    sleep: async (ms) => {
      live = true;
      await clock.sleep(ms);
    },
    roomPollMs: 1000,
    roomWaitMs: 10_000,
  });

  recorder.onInCall({ id: "s", roomName: "vkyc-s" });
  await recorder.idle("s");
  assert.deepEqual(egress.starts, ["vkyc-s"]);
  assert.equal(egress.outputs[0]?.output.case, undefined);

  const late = fakeEgress();
  let started = false;
  const ended = createCallRecorder({
    egress: late,
    rooms: {
      listRooms: async () => {
        started = true;
        return [];
      },
    },
    attach: async () => ({ ok: true }),
    now: clock.now,
    sleep: clock.sleep,
    roomPollMs: 1000,
    roomWaitMs: 10_000,
  });
  ended.onInCall({ id: "late", roomName: "vkyc-late" });
  await ended.onEnded({ id: "late", roomName: "vkyc-late" });
  assert.equal(started, true);
  assert.deepEqual(late.starts, []);
});

test("storage rejection switches to the browser fallback and still patches a file URL", async () => {
  const egress = fakeEgress();
  egress.startError = new Error("no file output configured");
  const patches: RecordingAttach[] = [];
  const recorder = createCallRecorder({
    egress,
    rooms: { listRooms: async () => [{ name: "vkyc-s" }] },
    attach: async (_id, body) => {
      patches.push(body);
      return { ok: true };
    },
    now: () => 0,
    sleep: async () => undefined,
    attachAttempts: 1,
  });

  recorder.onInCall({ id: "s", roomName: "vkyc-s" });
  await recorder.idle("s");
  assert.deepEqual(recorder.status("s"), { mode: "fallback", recordingId: null });
  assert.equal(egress.starts.length, 0);

  const saved = await recorder.saveFallback("s", {
    bytes: Buffer.from("webm-bytes"),
    contentType: "video/webm",
    recordingUrl: "http://127.0.0.1:3001/sessions/s/call-recording/file.webm",
  });
  assert.equal(saved.ok, true);
  if (saved.ok) {
    assert.match(saved.recordingId, /^local_/);
    assert.equal(patches[0]?.recordingId, saved.recordingId);
    assert.equal(patches[0]?.recordingUrl, "http://127.0.0.1:3001/sessions/s/call-recording/file.webm");
    assert.equal(recorder.fallbackFile("s")?.bytes.toString(), "webm-bytes");
  }

  const rejected = await recorder.saveFallback("other", {
    bytes: Buffer.from("x"),
    contentType: "video/webm",
    recordingUrl: "http://127.0.0.1:3001/sessions/other/call-recording/file.webm",
  });
  assert.equal(rejected.ok, false);
});

test("a shorter fallback upload does not replace a longer recording", async () => {
  const egress = fakeEgress();
  egress.startError = new Error("no file output configured");
  const patches: RecordingAttach[] = [];
  const recorder = createCallRecorder({
    egress,
    rooms: { listRooms: async () => [{ name: "vkyc-s" }] },
    attach: async (_id, body) => {
      patches.push(body);
      return { ok: true };
    },
    now: () => 0,
    sleep: async () => undefined,
    attachAttempts: 1,
  });
  recorder.onInCall({ id: "s", roomName: "vkyc-s" });
  await recorder.idle("s");

  const url = "http://127.0.0.1:3001/sessions/s/call-recording/file.webm";
  const call = Buffer.alloc(180_000, 1);
  const stub = Buffer.alloc(4_000, 2);
  const first = await recorder.saveFallback("s", { bytes: call, contentType: "video/webm", recordingUrl: url });
  assert.equal(first.ok, true);
  const second = await recorder.saveFallback("s", { bytes: stub, contentType: "video/webm", recordingUrl: url });
  assert.equal(second.ok, true);
  if (first.ok && second.ok) {
    assert.equal(second.recordingId, first.recordingId);
    assert.match(first.recordingId, /^local_/);
  }
  assert.equal(recorder.fallbackFile("s")?.bytes.length, call.length);
  assert.equal(recorder.fallbackFile("s")?.bytes[0], 1);
  assert.equal(patches.length, 1);

  const longer = Buffer.alloc(240_000, 3);
  const third = await recorder.saveFallback("s", { bytes: longer, contentType: "video/webm", recordingUrl: url });
  assert.equal(third.ok, true);
  if (first.ok && third.ok) assert.equal(third.recordingId, first.recordingId);
  assert.equal(recorder.fallbackFile("s")?.bytes.length, longer.length);
  assert.equal(recorder.fallbackFile("s")?.bytes[0], 3);
  assert.equal(patches.length, 2);
});

test("repeated room list failures use the browser fallback", async () => {
  const recorder = createCallRecorder({
    egress: fakeEgress(),
    rooms: {
      listRooms: async () => {
        throw new Error("unauthorized");
      },
    },
    attach: async () => ({ ok: true }),
    now: () => 0,
    sleep: async () => undefined,
  });
  recorder.onInCall({ id: "s", roomName: "vkyc-s" });
  await recorder.idle("s");
  assert.equal(recorder.status("s").mode, "fallback");
});

test("three transient egress failures use the browser fallback", async () => {
  const egress = fakeEgress();
  egress.startError = new Error("upstream timeout");
  const recorder = createCallRecorder({
    egress,
    rooms: { listRooms: async () => [{ name: "vkyc-s" }] },
    attach: async () => ({ ok: true }),
    now: () => 0,
    sleep: async () => undefined,
  });
  recorder.onInCall({ id: "s", roomName: "vkyc-s" });
  await recorder.idle("s");
  assert.equal(recorder.status("s").mode, "fallback");
  assert.deepEqual(egress.starts, []);
});

test("a missing attach route is retried and does not fail the call", async () => {
  const egress = fakeEgress();
  let attempts = 0;
  const recorder = createCallRecorder({
    egress,
    rooms: { listRooms: async () => [{ name: "vkyc-s" }] },
    attach: async () => {
      attempts += 1;
      return { ok: false, status: 404 };
    },
    now: () => 0,
    sleep: async () => undefined,
    attachAttempts: 3,
    attachBackoffMs: 0,
    fileWaitMs: 0,
  });
  recorder.onInCall({ id: "s", roomName: "vkyc-s" });
  await recorder.idle("s");
  await recorder.onEnded({ id: "s", roomName: "vkyc-s" });
  assert.equal(attempts >= 3, true);
  assert.equal(recorder.status("s").recordingId, "EG_1");
});

test("recording attach origin uses VERCEL_URL when RECORDING_ATTACH_ORIGIN is unset", async () => {
  const urls: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    urls.push(String(input));
    return new Response(null, { status: 204 });
  };
  const body = { recordingId: "EG_1" };
  await postSessionRecording("s1", body, {
    env: {
      RECORDING_ATTACH_ORIGIN: "https://api.example/",
      VERCEL_URL: "vkyc-api.vercel.app",
      PORT: "3001",
    },
    fetchImpl,
  });
  await postSessionRecording("s1", body, {
    env: { VERCEL_URL: "https://vkyc-api-abc.vercel.app/", PORT: "3001" },
    fetchImpl,
  });
  await postSessionRecording("s1", body, {
    env: { PORT: "3999" },
    fetchImpl,
  });
  assert.deepEqual(urls, [
    "https://api.example/sessions/s1/recording",
    "https://vkyc-api-abc.vercel.app/sessions/s1/recording",
    "http://127.0.0.1:3999/sessions/s1/recording",
  ]);
});

test("postSessionRecording sends eng's POST /sessions/:id/recording contract", async () => {
  const seen: Array<{ method: string; url: string; body: unknown }> = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      seen.push({
        method: req.method ?? "",
        url: req.url ?? "",
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
      });
      res.writeHead(req.url?.endsWith("/missing/recording") ? 404 : 200, { "content-type": "application/json" });
      res.end(req.url?.endsWith("/missing/recording") ? JSON.stringify({ error: "not_found" }) : "{}");
    });
  });
  await listen(server);
  const port = (server.address() as AddressInfo).port;
  try {
    const ok = await postSessionRecording(
      "session-1",
      { recordingId: "EG_9", recordingUrl: "https://cdn.example/call.mp4" },
      { origin: `http://127.0.0.1:${port}` },
    );
    assert.deepEqual(ok, { ok: true });
    assert.equal(seen[0]?.method, "POST");
    assert.equal(seen[0]?.url, "/sessions/session-1/recording");
    assert.deepEqual(seen[0]?.body, {
      recordingId: "EG_9",
      recordingUrl: "https://cdn.example/call.mp4",
    });

    const missing = await postSessionRecording("missing", { recordingId: "EG_9" }, { origin: `http://127.0.0.1:${port}` });
    assert.deepEqual(missing, { ok: false, status: 404 });
  } finally {
    await close(server);
  }
});

test("accept and claim arm recording, and end does not wait for the file", async () => {
  const events: string[] = [];
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const recording: CallRecorder = {
    onInCall(session) {
      events.push(`in:${session.roomName}`);
    },
    onEnded(session) {
      events.push(`end:${session.id}`);
      return gate;
    },
    idle() {
      return Promise.resolve();
    },
    status() {
      return { mode: "off", recordingId: null };
    },
    saveFallback() {
      return Promise.resolve({ ok: false, status: 409, message: "no" });
    },
    fallbackFile() {
      return undefined;
    },
  };

  await withApi(recording, async (base) => {
    const created = await api(base, "/sessions", { method: "POST" });
    const id = String(created.body?.id);
    const accepted = await api(base, `/sessions/${id}/accept`, { method: "POST" });
    assert.equal(accepted.status, 200);
    assert.deepEqual(events, [`in:vkyc-${id}`]);

    const ended = await api(base, `/sessions/${id}/end`, { method: "POST" });
    assert.equal(ended.status, 200);
    assert.equal(events[1], `end:${id}`);

    const second = await api(base, "/sessions", { method: "POST" });
    const claimed = await api(base, "/sessions/claim", { method: "POST" });
    assert.equal(claimed.status, 200);
    assert.equal(events[2], `in:vkyc-${String(second.body?.id)}`);
  });
  release?.();
});

test("fallback upload is served and patched when cloud egress is blocked", async () => {
  const patches: RecordingAttach[] = [];
  const egress = fakeEgress();
  egress.startError = new Error("egress is not enabled for this project");
  const recording = createCallRecorder({
    egress,
    rooms: { listRooms: async (names) => [{ name: names?.[0] }] },
    attach: async (_id, body) => {
      patches.push(body);
      return { ok: false, status: 404 };
    },
    now: () => 0,
    sleep: async () => undefined,
    attachAttempts: 1,
  });

  await withApi(recording, async (base) => {
    const created = await api(base, "/sessions", { method: "POST" });
    const id = String(created.body?.id);
    await api(base, `/sessions/${id}/accept`, { method: "POST" });
    await recording.idle(id);

    const status = await api(base, `/sessions/${id}/call-recording`);
    assert.equal(status.status, 200);
    assert.equal(status.body?.mode, "fallback");
    assert.equal(status.body?.recordingId, null);

    const uploaded = await fetch(`${base}/sessions/${id}/call-recording`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nope: true }),
    });
    assert.equal(uploaded.status, 400);

    const form = new FormData();
    form.set("video", new File([Buffer.from("fake-webm")], "call.webm", { type: "video/webm" }));
    const posted = await fetch(`${base}/sessions/${id}/call-recording`, { method: "POST", body: form });
    const postedBody = (await posted.json()) as { recordingId?: string; recordingUrl?: string };
    assert.equal(posted.status, 201);
    assert.match(String(postedBody.recordingUrl), new RegExp(`/sessions/${id}/call-recording/file\\.webm$`));
    assert.equal(patches[0]?.recordingId, postedBody.recordingId);
    assert.equal(patches[0]?.recordingUrl, postedBody.recordingUrl);

    const file = await fetch(`${base}/sessions/${id}/call-recording/file.webm`);
    assert.equal(file.status, 200);
    assert.equal(file.headers.get("content-type"), "video/webm");
    assert.equal(Buffer.from(await file.arrayBuffer()).toString(), "fake-webm");

    const again = await api(base, `/sessions/${id}/call-recording`);
    assert.equal(again.body?.mode, "fallback");
    assert.equal(again.body?.recordingId, postedBody.recordingId);

    const longer = new FormData();
    longer.set("video", new File([Buffer.alloc(32, 7)], "call.webm", { type: "video/webm" }));
    const replaced = await fetch(`${base}/sessions/${id}/call-recording`, { method: "POST", body: longer });
    assert.equal(replaced.status, 201);
    const short = new FormData();
    short.set("video", new File([Buffer.from("x")], "call.webm", { type: "video/webm" }));
    const kept = await fetch(`${base}/sessions/${id}/call-recording`, { method: "POST", body: short });
    const keptBody = (await kept.json()) as { recordingId?: string };
    assert.equal(kept.status, 201);
    assert.equal(keptBody.recordingId, postedBody.recordingId);
    const fileAgain = await fetch(`${base}/sessions/${id}/call-recording/file.webm`);
    const bytes = Buffer.from(await fileAgain.arrayBuffer());
    assert.equal(bytes.length, 32);
    assert.equal(bytes[0], 7);
  });
});

function virtualClock(): { now: () => number; sleep: (ms: number) => Promise<void> } {
  let time = 0;
  return {
    now: () => time,
    sleep: async (ms: number) => {
      time += ms;
    },
  };
}

function fakeEgress(): EgressApi & {
  starts: string[];
  stops: string[];
  outputs: EncodedFileOutput[];
  files: Array<{ location?: string; filename?: string }>;
  startError: Error | null;
} {
  const starts: string[] = [];
  const stops: string[] = [];
  const outputs: EncodedFileOutput[] = [];
  const files: Array<{ location?: string; filename?: string }> = [];
  let startError: Error | null = null;
  return {
    starts,
    stops,
    outputs,
    files,
    get startError() {
      return startError;
    },
    set startError(error: Error | null) {
      startError = error;
    },
    async startRoomCompositeEgress(roomName, output) {
      if (startError) throw startError;
      starts.push(roomName);
      outputs.push(output);
      return { egressId: "EG_1", status: 1, fileResults: [] };
    },
    async stopEgress(egressId) {
      stops.push(egressId);
      return { egressId, status: 2, fileResults: [] };
    },
    async listEgress(): Promise<EgressSnapshot[]> {
      return [{ egressId: "EG_1", status: 3, fileResults: files }];
    },
  };
}

async function withApi(recording: CallRecorder, fn: (base: string) => Promise<void>): Promise<void> {
  const app = createApp(new SessionStore(), {
    customerAppOrigin: "http://localhost:5174",
    corsOrigins: ["http://localhost:5173"],
    recording,
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address() as AddressInfo;
    await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await close(server);
  }
}

async function api(base: string, path: string, init?: RequestInit): Promise<{ status: number; body: Record<string, unknown> | null }> {
  const response = await fetch(`${base}${path}`, init);
  const text = await response.text();
  return { status: response.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : null };
}

function listen(server: Server): Promise<void> {
  server.listen(0, "127.0.0.1");
  return once(server, "listening").then(() => undefined);
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
