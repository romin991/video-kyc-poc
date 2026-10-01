import { randomBytes } from "node:crypto";
import {
  EgressClient,
  EgressStatus,
  EncodedFileOutput,
  EncodedFileType,
  RoomServiceClient,
  S3Upload,
  type EgressInfo,
} from "livekit-server-sdk";

const DEFAULT_FILEPATH = "recordings/{room_name}-{time}.mp4";

export type CallRecordingMode = "off" | "pending" | "egress" | "fallback" | "stopped";

export interface CallRecordingStatus {
  mode: CallRecordingMode;
  recordingId: string | null;
}

/** Eng attach body for POST /sessions/:id/recording. At least one field is sent. */
export interface RecordingAttach {
  recordingId?: string;
  recordingUrl?: string;
}

export interface EgressFileConfig {
  filepath?: string;
  bucket?: string;
  region?: string;
  accessKey?: string;
  secret?: string;
  endpoint?: string;
  forcePathStyle?: boolean;
  /** HTTPS origin for objects whose egress location is not already https. */
  publicBaseUrl?: string;
}

export interface EgressFileRef {
  location?: string;
  filename?: string;
}

export interface EgressSnapshot {
  egressId?: string;
  status?: number | string;
  error?: string;
  fileResults?: EgressFileRef[];
  result?: { case?: string; value?: EgressFileRef };
}

export interface EgressApi {
  startRoomCompositeEgress(
    roomName: string,
    output: EncodedFileOutput,
  ): Promise<EgressSnapshot>;
  stopEgress(egressId: string): Promise<EgressSnapshot>;
  listEgress(options?: { roomName?: string; egressId?: string; active?: boolean }): Promise<EgressSnapshot[]>;
}

export interface RoomApi {
  listRooms(names?: string[]): Promise<Array<{ name?: string }>>;
}

export type AttachResult = { ok: true } | { ok: false; status: number };

export type AttachFn = (sessionId: string, body: RecordingAttach) => Promise<AttachResult>;

export interface FallbackUpload {
  bytes: Buffer;
  contentType: "video/webm" | "video/mp4";
  recordingUrl: string;
}

export interface CallRecorder {
  onInCall(session: { id: string; roomName: string }): void;
  onEnded(session: { id: string; roomName: string }): Promise<void>;
  idle(sessionId: string): Promise<void>;
  status(sessionId: string): CallRecordingStatus;
  saveFallback(
    sessionId: string,
    upload: FallbackUpload,
  ): Promise<{ ok: true; recordingId: string; recordingUrl: string } | { ok: false; status: number; message: string }>;
  fallbackFile(sessionId: string): { bytes: Buffer; contentType: string } | undefined;
}

export interface CallRecorderDeps {
  egress: EgressApi;
  rooms: RoomApi;
  attach: AttachFn;
  file?: EgressFileConfig;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  roomPollMs?: number;
  roomWaitMs?: number;
  fileWaitMs?: number;
  attachAttempts?: number;
  attachBackoffMs?: number;
}

interface Job {
  sessionId: string;
  roomName: string;
  mode: CallRecordingMode;
  fallback: boolean;
  stopped: boolean;
  egressId: string | null;
  fallbackId: string | null;
  postedId: boolean;
  file?: { bytes: Buffer; contentType: string };
  task: Promise<void>;
  finish?: Promise<void>;
}

const sleepMs = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function classifyEgressError(error: unknown): "room_missing" | "blocked" | "retry" {
  const message = (error instanceof Error ? `${error.name} ${error.message}` : String(error)).toLowerCase();
  if (/not_found|does not exist|room not found|no such room/.test(message)) return "room_missing";
  if (
    /no file output|missing (file )?output|upload config|storage config|s3 config|no upload|bucket is required|egress is not enabled|egress not enabled|feature not enabled|quota exceeded|limit reached|insufficient credit|billing/.test(
      message,
    )
  ) {
    return "blocked";
  }
  return "retry";
}

/**
 * HTTPS location Cloud already returned, or an operator-supplied public base
 * joined to the object key. Localhost http is only for the in-memory fallback file.
 */
export function playableRecordingUrl(file: EgressFileRef | undefined, publicBaseUrl?: string): string | null {
  const location = file?.location?.trim();
  if (location && /^https:\/\//i.test(location)) return location;
  if (location && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//i.test(location)) return location;

  const base = publicBaseUrl?.trim().replace(/\/$/, "");
  const key = objectKey(location, file?.filename);
  if (base && /^https:\/\//i.test(base) && key) return `${base}/${key}`;
  return null;
}

function objectKey(location: string | undefined, filename: string | undefined): string | null {
  if (location?.startsWith("s3://")) {
    const rest = location.slice("s3://".length);
    const slash = rest.indexOf("/");
    if (slash >= 0 && slash < rest.length - 1) return rest.slice(slash + 1);
  }
  const name = filename?.trim().replace(/^\/+/, "");
  return name || null;
}

export function roomCompositeFile(config: EgressFileConfig = {}): EncodedFileOutput {
  const filepath = config.filepath?.trim() || DEFAULT_FILEPATH;
  const output = new EncodedFileOutput({
    fileType: EncodedFileType.MP4,
    filepath,
    disableManifest: true,
  });
  if (config.bucket) {
    output.output = {
      case: "s3",
      value: new S3Upload({
        bucket: config.bucket,
        region: config.region ?? "",
        accessKey: config.accessKey ?? "",
        secret: config.secret ?? "",
        endpoint: config.endpoint ?? "",
        forcePathStyle: config.forcePathStyle === true,
      }),
    };
  }
  return output;
}

export function egressFileConfigFromEnv(env: NodeJS.ProcessEnv = process.env): EgressFileConfig {
  const force = env.EGRESS_S3_FORCE_PATH_STYLE?.trim().toLowerCase();
  return {
    filepath: blank(env.EGRESS_FILEPATH),
    bucket: blank(env.EGRESS_S3_BUCKET),
    region: blank(env.EGRESS_S3_REGION),
    accessKey: blank(env.EGRESS_S3_ACCESS_KEY),
    secret: blank(env.EGRESS_S3_SECRET),
    endpoint: blank(env.EGRESS_S3_ENDPOINT),
    forcePathStyle: force === "1" || force === "true",
    publicBaseUrl: blank(env.EGRESS_PUBLIC_BASE_URL),
  };
}

function blank(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function defaultAttachOrigin(env: NodeJS.ProcessEnv = process.env): string {
  const configured = blank(env.RECORDING_ATTACH_ORIGIN);
  if (configured) return configured.replace(/\/$/, "");
  const port = blank(env.PORT) ?? "3001";
  return `http://127.0.0.1:${port}`;
}

export async function postSessionRecording(
  sessionId: string,
  body: RecordingAttach,
  options: { origin?: string; fetchImpl?: typeof fetch; env?: NodeJS.ProcessEnv } = {},
): Promise<AttachResult> {
  const origin = (options.origin ?? defaultAttachOrigin(options.env)).replace(/\/$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(`${origin}/sessions/${encodeURIComponent(sessionId)}/recording`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (response.ok) return { ok: true };
    return { ok: false, status: response.status };
  } catch (error) {
    console.warn("[vkyc] recording attach failed", error instanceof Error ? error.message : error);
    return { ok: false, status: 0 };
  }
}

export function createCallRecorderFromEnv(env: NodeJS.ProcessEnv = process.env): CallRecorder | undefined {
  const url = blank(env.LIVEKIT_URL);
  const apiKey = blank(env.LIVEKIT_API_KEY);
  const apiSecret = blank(env.LIVEKIT_API_SECRET);
  if (!url || !apiKey || !apiSecret) return undefined;
  const egress = new EgressClient(url, apiKey, apiSecret);
  const rooms = new RoomServiceClient(url, apiKey, apiSecret);
  return createCallRecorder({
    egress: {
      startRoomCompositeEgress: async (roomName, output) => snapshot(await egress.startRoomCompositeEgress(roomName, output)),
      stopEgress: async (egressId) => snapshot(await egress.stopEgress(egressId)),
      listEgress: async (options) => (await egress.listEgress(options)).map(snapshot),
    },
    rooms: {
      listRooms: async (names) => rooms.listRooms(names),
    },
    attach: (sessionId, body) => postSessionRecording(sessionId, body, { env }),
    file: egressFileConfigFromEnv(env),
  });
}

function snapshot(info: EgressInfo): EgressSnapshot {
  const file = info.result.case === "file" ? info.result.value : undefined;
  return {
    egressId: info.egressId,
    status: info.status,
    error: info.error,
    fileResults: info.fileResults.map((item) => ({ location: item.location, filename: item.filename })),
    result: file ? { case: "file", value: { location: file.location, filename: file.filename } } : undefined,
  };
}

export function createCallRecorder(deps: CallRecorderDeps): CallRecorder {
  return new LiveKitCallRecorder(deps);
}

class LiveKitCallRecorder implements CallRecorder {
  private readonly jobs = new Map<string, Job>();
  private readonly egress: EgressApi;
  private readonly rooms: RoomApi;
  private readonly attach: AttachFn;
  private readonly fileConfig: EgressFileConfig;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly roomPollMs: number;
  private readonly roomWaitMs: number;
  private readonly fileWaitMs: number;
  private readonly attachAttempts: number;
  private readonly attachBackoffMs: number;

  constructor(deps: CallRecorderDeps) {
    this.egress = deps.egress;
    this.rooms = deps.rooms;
    this.attach = deps.attach;
    this.fileConfig = deps.file ?? {};
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? sleepMs;
    this.roomPollMs = deps.roomPollMs ?? 1000;
    this.roomWaitMs = deps.roomWaitMs ?? 120_000;
    this.fileWaitMs = deps.fileWaitMs ?? 60_000;
    this.attachAttempts = deps.attachAttempts ?? 4;
    this.attachBackoffMs = deps.attachBackoffMs ?? 1000;
  }

  onInCall(session: { id: string; roomName: string }): void {
    if (this.jobs.has(session.id)) return;
    const job: Job = {
      sessionId: session.id,
      roomName: session.roomName,
      mode: "pending",
      fallback: false,
      stopped: false,
      egressId: null,
      fallbackId: null,
      postedId: false,
      task: Promise.resolve(),
    };
    job.task = this.watch(job);
    this.jobs.set(session.id, job);
    console.info(`[vkyc] call recording armed for ${session.roomName}`);
  }

  onEnded(session: { id: string; roomName: string }): Promise<void> {
    const job = this.jobs.get(session.id);
    if (!job) return Promise.resolve();
    if (job.finish) return job.finish;
    job.stopped = true;
    job.finish = this.finish(job);
    return job.finish;
  }

  idle(sessionId: string): Promise<void> {
    return this.jobs.get(sessionId)?.task ?? Promise.resolve();
  }

  status(sessionId: string): CallRecordingStatus {
    const job = this.jobs.get(sessionId);
    if (!job) return { mode: "off", recordingId: null };
    return { mode: job.mode, recordingId: job.egressId ?? job.fallbackId };
  }

  async saveFallback(
    sessionId: string,
    upload: FallbackUpload,
  ): Promise<{ ok: true; recordingId: string; recordingUrl: string } | { ok: false; status: number; message: string }> {
    const job = this.jobs.get(sessionId);
    if (!job?.fallback) {
      return {
        ok: false,
        status: 409,
        message: "Browser recording is only used when Cloud egress is unavailable",
      };
    }
    if (upload.bytes.length === 0) {
      return { ok: false, status: 400, message: "Recording file is empty" };
    }
    const recordingId = job.fallbackId ?? `local_${randomBytes(9).toString("base64url")}`;
    job.fallbackId = recordingId;
    if (job.file && upload.bytes.length < job.file.bytes.length) {
      console.warn(
        `[vkyc] kept fallback recording ${recordingId} (${job.file.bytes.length} bytes); ignored a shorter upload (${upload.bytes.length} bytes)`,
      );
      return { ok: true, recordingId, recordingUrl: upload.recordingUrl };
    }
    job.file = { bytes: upload.bytes, contentType: upload.contentType };
    await this.send(sessionId, { recordingId, recordingUrl: upload.recordingUrl });
    return { ok: true, recordingId, recordingUrl: upload.recordingUrl };
  }

  fallbackFile(sessionId: string): { bytes: Buffer; contentType: string } | undefined {
    return this.jobs.get(sessionId)?.file;
  }

  private async watch(job: Job): Promise<void> {
    const deadline = this.now() + this.roomWaitMs;
    let failures = 0;
    let roomErrors = 0;
    while (!job.stopped && this.now() < deadline) {
      const live = await this.roomIsLive(job.roomName);
      if (job.stopped) return;
      if (live === "error") {
        roomErrors += 1;
        if (roomErrors >= 3) {
          this.useFallback(job, "could not list the LiveKit room");
          return;
        }
        await this.sleep(this.roomPollMs);
        continue;
      }
      if (live === "missing") {
        await this.sleep(this.roomPollMs);
        continue;
      }
      try {
        const info = await this.egress.startRoomCompositeEgress(job.roomName, roomCompositeFile(this.fileConfig));
        const egressId = info.egressId?.trim();
        if (!egressId) throw new Error("egress response missing egress id");
        job.egressId = egressId;
        job.mode = "egress";
        console.info(`[vkyc] egress ${egressId} recording ${job.roomName}`);
        if (job.stopped) return;
        await this.send(job.sessionId, { recordingId: egressId });
        job.postedId = true;
        return;
      } catch (error) {
        const kind = classifyEgressError(error);
        const message = error instanceof Error ? error.message : String(error);
        if (kind === "room_missing") {
          await this.sleep(this.roomPollMs);
          continue;
        }
        failures += 1;
        if (kind === "blocked" || failures >= 3) {
          this.useFallback(job, message);
          return;
        }
        console.warn(`[vkyc] egress start failed for ${job.roomName} (${failures}): ${message}`);
        await this.sleep(this.roomPollMs);
      }
    }
  }

  private useFallback(job: Job, message: string): void {
    job.mode = "fallback";
    job.fallback = true;
    console.warn(
      `[vkyc] Cloud egress unavailable for ${job.roomName}; browser fallback will record the call. ${message}`,
    );
  }

  private async roomIsLive(roomName: string): Promise<"live" | "missing" | "error"> {
    try {
      const rooms = await this.rooms.listRooms([roomName]);
      const live = rooms.some((room) => room.name == null || room.name === "" || room.name === roomName);
      return live ? "live" : "missing";
    } catch (error) {
      console.warn("[vkyc] listRooms failed", error instanceof Error ? error.message : error);
      return "error";
    }
  }

  private async finish(job: Job): Promise<void> {
    try {
      await job.task;
      if (job.egressId && job.mode === "egress") {
        let snapshot: EgressSnapshot | undefined;
        try {
          snapshot = await this.egress.stopEgress(job.egressId);
        } catch (error) {
          console.warn(
            `[vkyc] stop egress ${job.egressId}`,
            error instanceof Error ? error.message : error,
          );
        }
        const url = await this.waitForUrl(job, snapshot);
        if (url) {
          await this.send(job.sessionId, { recordingId: job.egressId, recordingUrl: url });
        } else if (!job.postedId) {
          await this.send(job.sessionId, { recordingId: job.egressId });
        }
      }
    } finally {
      job.mode = "stopped";
    }
  }

  private async waitForUrl(job: Job, first: EgressSnapshot | undefined): Promise<string | null> {
    const deadline = this.now() + this.fileWaitMs;
    let latest = first ? urlFromSnapshot(first, this.fileConfig.publicBaseUrl) : null;
    if (first && terminalStatus(first.status) !== "pending") return latest;
    while (this.now() <= deadline) {
      try {
        const list = await this.egress.listEgress({ egressId: job.egressId ?? undefined, roomName: job.roomName });
        const info = list.find((item) => item.egressId === job.egressId) ?? list[0];
        if (info) {
          latest = urlFromSnapshot(info, this.fileConfig.publicBaseUrl) ?? latest;
          const terminal = terminalStatus(info.status);
          if (terminal === "complete") return latest;
          if (terminal === "failed") {
            console.warn(`[vkyc] egress ${job.egressId} failed: ${info.error || "unknown error"}`);
            return latest;
          }
        }
      } catch (error) {
        console.warn("[vkyc] list egress failed", error instanceof Error ? error.message : error);
      }
      if (this.now() >= deadline) break;
      await this.sleep(this.roomPollMs);
    }
    return latest;
  }

  private async send(sessionId: string, body: RecordingAttach): Promise<void> {
    if (!body.recordingId && !body.recordingUrl) return;
    let lastStatus = 0;
    for (let attempt = 0; attempt < this.attachAttempts; attempt += 1) {
      if (attempt > 0) await this.sleep(this.attachBackoffMs);
      const result = await this.attach(sessionId, body);
      if (result.ok) return;
      lastStatus = result.status;
      if (result.status !== 404 && result.status !== 0) break;
    }
    console.warn(
      `[vkyc] POST /sessions/${sessionId}/recording was not stored (HTTP ${lastStatus}). Eng attach route is not on this API yet. ${JSON.stringify(body)}`,
    );
  }
}

function urlFromSnapshot(info: EgressSnapshot, publicBaseUrl?: string): string | null {
  const files = [...(info.fileResults ?? [])];
  if (info.result?.case === "file" && info.result.value) files.push(info.result.value);
  for (const file of files) {
    const url = playableRecordingUrl(file, publicBaseUrl);
    if (url) return url;
  }
  return null;
}

function terminalStatus(status: number | string | undefined): "complete" | "failed" | "pending" {
  if (status === EgressStatus.EGRESS_COMPLETE || status === 3 || status === "EGRESS_COMPLETE") return "complete";
  if (
    status === EgressStatus.EGRESS_FAILED ||
    status === 4 ||
    status === "EGRESS_FAILED" ||
    status === EgressStatus.EGRESS_ABORTED ||
    status === 5 ||
    status === "EGRESS_ABORTED" ||
    status === EgressStatus.EGRESS_LIMIT_REACHED ||
    status === 6 ||
    status === "EGRESS_LIMIT_REACHED"
  ) {
    return "failed";
  }
  return "pending";
}
