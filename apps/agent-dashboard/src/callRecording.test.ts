import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (name: string) => readFileSync(new URL(`./${name}`, import.meta.url), "utf8");

test("the desk keeps the WebM locally and does not upload it", () => {
  const recording = read("callRecording.ts");
  const app = read("App.tsx");
  const kyc = read("kyc.tsx");
  const livekit = read("livekit.ts");

  assert.equal(recording.includes("uploadCallRecording"), false);
  assert.equal(recording.includes("getCallRecording"), false);
  assert.equal(app.includes("stopAndUpload"), false);
  assert.match(app, /recording\.stop\(/);
  assert.match(kyc, /Download recording/);
  assert.match(kyc, /download="call-recording\.webm"/);
  assert.doesNotMatch(kyc, /LiveKit egress can attach a URL/);
  assert.match(livekit, /function attachLocalMic/);
  assert.match(livekit, /Track\.Source\.Microphone\) attachLocalMic/);
});
