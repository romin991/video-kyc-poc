import assert from "node:assert/strict";
import test from "node:test";
import { createCallTape, fallbackRecorderAction, selectLongerRecording, type TapeRecorder } from "./callTape";

test("fallback recorder starts once the customer camera is live", () => {
  assert.equal(
    fallbackRecorderAction({ mode: "fallback", mediaConnected: true, ending: false, recorderState: null }),
    "start",
  );
  assert.equal(
    fallbackRecorderAction({ mode: "fallback", mediaConnected: true, ending: false, recorderState: "recording" }),
    "keep",
  );
  assert.equal(
    fallbackRecorderAction({ mode: "fallback", mediaConnected: true, ending: false, recorderState: "inactive" }),
    "restart",
  );
  assert.equal(
    fallbackRecorderAction({ mode: "fallback", mediaConnected: false, ending: false, recorderState: null }),
    "keep",
  );
  assert.equal(
    fallbackRecorderAction({ mode: "fallback", mediaConnected: true, ending: true, recorderState: null }),
    "keep",
  );
  assert.equal(
    fallbackRecorderAction({ mode: "egress", mediaConnected: true, ending: false, recorderState: null }),
    "keep",
  );
});

test("a longer recording replaces a shorter one", () => {
  const call = { size: 4000 };
  const stub = { size: 200 };
  assert.equal(selectLongerRecording(null, stub), stub);
  assert.equal(selectLongerRecording(call, stub), call);
  assert.equal(selectLongerRecording(stub, call), call);
  assert.equal(selectLongerRecording(call, { size: 0 }), call);
  assert.equal(selectLongerRecording(call, null), call);
});

test("createCallTape stops once and returns the same blob", async () => {
  const chunks = [new Blob(["webm-call"]), new Blob(["-tail"])];
  let closed = 0;
  const recorder: TapeRecorder = {
    state: "recording",
    mimeType: "video/webm",
    onstop: null,
    onerror: null,
    stop() {
      this.state = "inactive";
      this.onstop?.();
    },
  };
  const tape = createCallTape({
    recorder,
    chunks,
    close: () => {
      closed += 1;
    },
  });
  const first = tape.stop();
  const second = tape.stop();
  const blob = await first;
  assert.equal(second, first);
  assert.equal(blob.type, "video/webm");
  assert.equal(await blob.text(), "webm-call-tail");
  assert.equal(closed, 1);
  await second;
  assert.equal(closed, 1);
});
