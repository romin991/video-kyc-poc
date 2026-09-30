import { config as loadEnv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";
import { createCallRecorderFromEnv } from "./recording.js";
import { describeStubDelivery, resolveStubConfig } from "./stubs.js";

const here = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(here, "../../../.env") });

const port = Number(process.env.PORT ?? 3001);
const recording = createCallRecorderFromEnv();
const app = createApp(undefined, { log: true, recording });

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
