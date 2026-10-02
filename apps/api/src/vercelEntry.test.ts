import assert from "node:assert/strict";
import type { Express } from "express";
import test from "node:test";

test("vercel entry default-exports the Express app and trusts the proxy", async () => {
  const previous = process.env.VERCEL;
  process.env.VERCEL = "1";
  try {
    const { default: app } = (await import("../index.js")) as { default: Express };
    assert.equal(typeof app, "function");
    assert.equal(typeof app.listen, "function");
    assert.equal(app.get("trust proxy"), 1);
  } finally {
    if (previous === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = previous;
  }
});
