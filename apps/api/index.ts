// Vercel loads the first file that imports "express". This index is that file.
// src/app.ts also imports express and does not default-export the app, so it is not the entry.
import express from "express";
import { config as loadEnv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./src/app.js";
import { createCallRecorderFromEnv } from "./src/recording.js";
import { describeStubDelivery, resolveStubConfig } from "./src/stubs.js";

const here = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(here, "../../.env") });

const recording = createCallRecorderFromEnv();
const app = createApp(undefined, { log: true, recording });

if (process.env.VERCEL) {
  app.set("trust proxy", 1);
}

export default app satisfies ReturnType<typeof express>;

if (!process.env.VERCEL) {
  const port = Number(process.env.PORT ?? 3001);
  app.listen(port, "127.0.0.1", () => {
    const customerOrigin = process.env.CUSTOMER_APP_ORIGIN ?? "http://localhost:5174";
    const liveKitUrl = process.env.LIVEKIT_URL?.trim();
    const liveKitReady = Boolean(process.env.LIVEKIT_API_KEY?.trim() && process.env.LIVEKIT_API_SECRET?.trim());
    console.log(`vkyc api  http://127.0.0.1:${port}`);
    console.log(`join urls use ${customerOrigin}`);
    if (liveKitReady) {
      console.log(
        liveKitUrl
          ? `livekit ${liveKitUrl}`
          : "livekit tokens enabled; set LIVEKIT_URL and VITE_LIVEKIT_URL to the same WebSocket URL",
      );
    } else {
      console.warn(
        "LIVEKIT_API_KEY or LIVEKIT_API_SECRET is unset. Sessions still accept and join; media stays off.",
      );
    }
    if (recording) {
      console.log("call recording: LiveKit room composite egress on vkyc-<sessionId>");
    } else {
      console.warn("call recording off until LIVEKIT_URL, LIVEKIT_API_KEY, and LIVEKIT_API_SECRET are all set");
    }
    console.log(describeStubDelivery(resolveStubConfig(process.env)));
  });
}
