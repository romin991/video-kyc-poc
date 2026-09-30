import { appendFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CaptureKind, Disposition } from "./types.js";

/** apps/api/src -> repo root. Relative log paths resolve from here, not the process cwd. */
export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

const DEFAULT_LOG_PATH = "data/disposition-stubs.jsonl";
const WEBHOOK_TIMEOUT_MS = 8000;

export const STUB_SINKS = ["crm", "datalake"] as const;
export type StubSink = (typeof STUB_SINKS)[number];

export interface StubCapture {
  id: string;
  kind: CaptureKind;
  url: string;
  contentType: string;
  createdAt: string;
  capturedAt: string;
}

export interface DispositionStubPayload {
  sink: StubSink;
  sessionId: string;
  disposition: Disposition;
  /** X-Demo-Agent on the disposition request, or "Demo agent" when the header is blank. */
  agentId: string;
  claimedBy: string | null;
  timestamps: {
    createdAt: string;
    acceptedAt: string | null;
    endedAt: string | null;
    dispositionAt: string;
  };
  captures: StubCapture[];
  recording: {
    id: string | null;
    url: string | null;
  };
  /** Set only when a configured webhook failed and this line is the log fallback. */
  webhookError?: string;
}

export type DispositionStubBody = Omit<DispositionStubPayload, "sink" | "webhookError">;

export interface StubConfig {
  crmWebhookUrl: string | null;
  datalakeWebhookUrl: string | null;
  logPath: string;
}

export interface StubOverrides {
  crmWebhookUrl?: string | null;
  datalakeWebhookUrl?: string | null;
  logPath?: string | null;
}

function blankToNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

function resolveLogPath(value: string | null | undefined): string {
  const raw = value?.trim() || DEFAULT_LOG_PATH;
  return resolve(repoRoot, raw);
}

/**
 * Env wins unless `override` is passed. An override object replaces both
 * webhook URLs (unset means log, even if the env var is set) so tests stay isolated.
 */
export function resolveStubConfig(env: NodeJS.ProcessEnv, override?: StubOverrides): StubConfig {
  const crmSource = override ? override.crmWebhookUrl : env.CRM_STUB_WEBHOOK_URL;
  const lakeSource = override ? override.datalakeWebhookUrl : env.DATALAKE_STUB_WEBHOOK_URL;
  const logSource = override ? override.logPath : env.DISPOSITION_STUB_LOG_PATH;
  return {
    crmWebhookUrl: blankToNull(crmSource),
    datalakeWebhookUrl: blankToNull(lakeSource),
    logPath: resolveLogPath(logSource),
  };
}

export function describeStubDelivery(config: StubConfig): string {
  const crm = config.crmWebhookUrl ? `webhook ${config.crmWebhookUrl}` : `log ${config.logPath}`;
  const datalake = config.datalakeWebhookUrl ? `webhook ${config.datalakeWebhookUrl}` : `log ${config.logPath}`;
  return `disposition stubs: crm ${crm}; datalake ${datalake}`;
}

function webhookFor(config: StubConfig, sink: StubSink): string | null {
  return sink === "crm" ? config.crmWebhookUrl : config.datalakeWebhookUrl;
}

async function postWebhook(url: string, body: string): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    });
    if (!response.ok) return { ok: false, message: `webhook returned ${response.status}` };
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : "webhook request failed";
    return { ok: false, message };
  }
}

async function appendLog(logPath: string, payload: DispositionStubPayload): Promise<void> {
  await mkdir(dirname(logPath), { recursive: true });
  await appendFile(logPath, `${JSON.stringify(payload)}\n`, "utf8");
}

async function deliverOne(sink: StubSink, body: DispositionStubBody, config: StubConfig): Promise<void> {
  const payload: DispositionStubPayload = { sink, ...body };
  const url = webhookFor(config, sink);
  if (!url) {
    await appendLog(config.logPath, payload);
    return;
  }
  const result = await postWebhook(url, JSON.stringify(payload));
  if (result.ok) return;
  console.error(`disposition stub ${sink} webhook failed: ${result.message}`);
  await appendLog(config.logPath, { ...payload, webhookError: result.message });
}

/** Post one payload per sink, or append a JSON line when that sink's webhook is unset. */
export async function deliverDispositionStubs(body: DispositionStubBody, config: StubConfig): Promise<void> {
  await Promise.all(
    STUB_SINKS.map(async (sink) => {
      try {
        await deliverOne(sink, body, config);
      } catch (error) {
        const message = error instanceof Error ? error.message : "stub delivery failed";
        console.error(`disposition stub ${sink} failed: ${message}`);
      }
    }),
  );
}
