import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { localAvFailureMessage } from "./localAvFailure.ts";

const BLOCKED = "Camera blocked — click the lock icon in the address bar and choose Allow, then reload.";
const MISSING = "No camera or microphone found. Connect one, then reload.";
const BUSY = "Camera is in use by another app. Close it, then reload.";

test("NotAllowedError and PermissionDenied use the lock-icon message", () => {
  assert.equal(localAvFailureMessage(new DOMException("Permission denied", "NotAllowedError")), BLOCKED);
  assert.equal(localAvFailureMessage(new DOMException("Permission denied", "PermissionDeniedError")), BLOCKED);
  assert.equal(localAvFailureMessage({ name: "PermissionDenied", message: "denied" }), BLOCKED);
  assert.equal(localAvFailureMessage(new Error("Permission denied by feature policy")), BLOCKED);
});

test("NotFoundError and an empty device list say no camera", () => {
  assert.equal(localAvFailureMessage(new DOMException("Requested device not found", "NotFoundError")), MISSING);
  assert.equal(
    localAvFailureMessage(
      new Error(
        "No audio/video inputs. On the box, Chrome must be launched with FAKE-AV (--use-fake-device-for-media-stream).",
      ),
    ),
    MISSING,
  );
});

test("NotReadableError says the camera is in use", () => {
  assert.equal(localAvFailureMessage(new DOMException("Could not start video source", "NotReadableError")), BUSY);
});

test("other failures keep a short message so the tile is not blank", () => {
  assert.equal(localAvFailureMessage(new Error("signal closed")), "signal closed");
  assert.equal(
    localAvFailureMessage("nope"),
    "Camera and microphone could not start. Reload and try again.",
  );
});

test("agent and customer copies stay the same", () => {
  const agent = readFileSync(new URL("./localAvFailure.ts", import.meta.url), "utf8");
  const customer = readFileSync(
    new URL("../../customer-webview/src/localAvFailure.ts", import.meta.url),
    "utf8",
  );
  const normalize = (source: string) => source.replaceAll("customer webview", "other app").replaceAll("agent dashboard", "other app");
  assert.equal(normalize(agent), normalize(customer));
});
