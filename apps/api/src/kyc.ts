import type { CaptureKind, Disposition, ImageContentType, MaField, OnboardingPayload } from "./types.js";

export const IMAGE_MAX_BYTES = 4 * 1024 * 1024;
export const NOTE_MAX_CHARS = 4000;
export const CAPTURE_MAX_COUNT = 20;

export const STUB_ONBOARDING: OnboardingPayload = {
  fullName: "Ayu Prameswari",
  phone: "+628123456789",
  productId: "SAVINGS-PLUS",
  applicationId: "APP-2026-00421",
  reason: "New savings account video KYC",
};

const DISPOSITIONS: Readonly<Record<string, Disposition>> = {
  approve: "approve",
  reject: "reject",
  utv: "utv",
};

const KINDS: Readonly<Record<string, CaptureKind>> = {
  face: "face",
  id: "id",
  selfie_ktp: "selfie_ktp",
  "selfie-ktp": "selfie_ktp",
  "selfie+ktp": "selfie_ktp",
  selfiektp: "selfie_ktp",
  other: "other",
  doc: "other",
  extra_doc: "other",
  "extra-doc": "other",
  extradoc: "other",
};

const KIND_LIST = "face, id, selfie_ktp, or other";

export const MA_PROMPTS: Readonly<Record<MaField, string>> = {
  full_name: "Please type your full name.",
  dob: "Please type your date of birth.",
  mothers_maiden_name: "Please type your mother's maiden name.",
};

const MA_FIELDS: Readonly<Record<string, MaField>> = {
  full_name: "full_name",
  dob: "dob",
  mothers_maiden_name: "mothers_maiden_name",
};

const MA_FIELD_LIST = "full_name, dob, or mothers_maiden_name";
const PROMPT_MAX_CHARS = 240;
const ANSWER_MAX_CHARS = 200;
const DIGIT_RESPONSE_MAX_CHARS = 16;

export interface MaPromptInput {
  field: MaField;
  prompt: string;
}

export interface SessionPatch {
  checklist?: { id: string; checked: boolean }[];
  acwNotes?: string;
  disposition?: Disposition | null;
  captureGuide?: CaptureKind | null;
  /** Active question. Null clears it. The server stamps sentAt. */
  maPrompt?: MaPromptInput | null;
  /** Digits to show the customer. Null clears the prompt and keeps the last reply. */
  digitChallenge?: { digits: string } | null;
  maMatch?: boolean | null;
  digitMatch?: boolean | null;
}

export interface CustomerReply {
  answer?: string;
  digitResponse?: string;
}

export function digitChallengePrompt(digits: string): string {
  return `Please say these digits, then type them here: ${digits.split("").join(" ")}`;
}

function parseKindToken(value: string): CaptureKind | undefined {
  const trimmed = value.trim().toLowerCase();
  const direct = KINDS[trimmed];
  if (direct) return direct;
  const compact = trimmed.replace(/[\s_+-]+/g, "");
  if (compact === "selfiektp") return "selfie_ktp";
  if (compact === "extradoc") return "other";
  return undefined;
}

export interface RecordingAttach {
  recordingUrl?: string;
  recordingId?: string;
}

const RECORDING_URL_MAX = 2048;
const RECORDING_ID_MAX = 200;

export type ParseResult<T> = { ok: true; value: T } | { ok: false; message: string };

function isPlain(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readField(
  sources: Array<Record<string, unknown>>,
  keys: string[],
  fallback: string,
  max: number,
  label: string,
): ParseResult<string> {
  for (const source of sources) {
    for (const key of keys) {
      if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
      const raw = source[key];
      if (typeof raw !== "string") return { ok: false, message: `${label} must be a string` };
      const value = raw.trim();
      if (!value) return { ok: true, value: fallback };
      if (value.length > max) {
        return { ok: false, message: `${label} must be ${max} characters or fewer` };
      }
      return { ok: true, value };
    }
  }
  return { ok: true, value: fallback };
}

/**
 * Seed the fixed stub, then overlay JSON fields.
 * A nested `onboarding` object wins over the same key at the top level.
 * Blank strings keep the stub so `{}` still creates a desk-ready session.
 */
export function parseOnboarding(body: unknown): ParseResult<OnboardingPayload> {
  if (body === undefined || body === null) body = {};
  if (!isPlain(body)) return { ok: false, message: "Body must be a JSON object" };
  const nested = isPlain(body.onboarding) ? body.onboarding : null;
  const sources = nested ? [nested, body] : [body];

  const fullName = readField(sources, ["fullName"], STUB_ONBOARDING.fullName, 120, "fullName");
  if (!fullName.ok) return fullName;
  const phone = readField(sources, ["phone"], STUB_ONBOARDING.phone, 40, "phone");
  if (!phone.ok) return phone;
  const productId = readField(sources, ["productId", "product"], STUB_ONBOARDING.productId, 64, "productId");
  if (!productId.ok) return productId;
  const applicationId = readField(
    sources,
    ["applicationId", "application"],
    STUB_ONBOARDING.applicationId,
    64,
    "applicationId",
  );
  if (!applicationId.ok) return applicationId;
  const reason = readField(sources, ["reason", "reasonForVkyc"], STUB_ONBOARDING.reason, 280, "reason");
  if (!reason.ok) return reason;

  return {
    ok: true,
    value: {
      fullName: fullName.value,
      phone: phone.value,
      productId: productId.value,
      applicationId: applicationId.value,
      reason: reason.value,
    },
  };
}

export function parsePatch(body: unknown): ParseResult<SessionPatch> {
  if (!isPlain(body)) return { ok: false, message: "Body must be a JSON object" };
  const patch: SessionPatch = {};

  if ("checklist" in body) {
    if (!Array.isArray(body.checklist)) return { ok: false, message: "checklist must be an array" };
    const items: { id: string; checked: boolean }[] = [];
    for (const entry of body.checklist) {
      if (!isPlain(entry) || typeof entry.id !== "string" || !entry.id.trim()) {
        return { ok: false, message: "Each checklist item needs an id" };
      }
      if (typeof entry.checked !== "boolean") {
        return { ok: false, message: `checklist ${entry.id} needs checked: true or false` };
      }
      items.push({ id: entry.id.trim(), checked: entry.checked });
    }
    patch.checklist = items;
  }

  if ("acwNotes" in body) {
    if (typeof body.acwNotes !== "string") return { ok: false, message: "acwNotes must be a string" };
    if (body.acwNotes.length > NOTE_MAX_CHARS) {
      return { ok: false, message: `acwNotes must be ${NOTE_MAX_CHARS} characters or fewer` };
    }
    patch.acwNotes = body.acwNotes;
  }

  if ("disposition" in body) {
    if (body.disposition === null) {
      patch.disposition = null;
    } else if (typeof body.disposition === "string" && body.disposition.trim()) {
      const mapped = DISPOSITIONS[body.disposition.trim().toLowerCase()];
      if (!mapped) return { ok: false, message: "disposition must be Approve, Reject, or UTV" };
      patch.disposition = mapped;
    } else {
      return { ok: false, message: "disposition must be Approve, Reject, or UTV" };
    }
  }

  if ("captureGuide" in body) {
    const guide = parseCaptureGuide(body.captureGuide);
    if (!guide.ok) return guide;
    patch.captureGuide = guide.value;
  }

  if ("maPrompt" in body) {
    const prompt = parseMaPrompt(body.maPrompt);
    if (!prompt.ok) return prompt;
    patch.maPrompt = prompt.value;
  }

  if ("digitChallenge" in body) {
    const challenge = parseDigitChallenge(body.digitChallenge);
    if (!challenge.ok) return challenge;
    patch.digitChallenge = challenge.value;
  }

  if ("maMatch" in body) {
    const match = parseMatchFlag(body.maMatch, "maMatch");
    if (!match.ok) return match;
    patch.maMatch = match.value;
  }

  if ("digitMatch" in body) {
    const match = parseMatchFlag(body.digitMatch, "digitMatch");
    if (!match.ok) return match;
    patch.digitMatch = match.value;
  }

  return { ok: true, value: patch };
}

function parseMaPrompt(value: unknown): ParseResult<MaPromptInput | null> {
  if (value === null) return { ok: true, value: null };
  if (!isPlain(value)) return { ok: false, message: "maPrompt must be an object or null" };
  if (typeof value.field !== "string" || !value.field.trim()) {
    return { ok: false, message: `maPrompt.field must be ${MA_FIELD_LIST}` };
  }
  const field = MA_FIELDS[value.field.trim().toLowerCase()];
  if (!field) return { ok: false, message: `maPrompt.field must be ${MA_FIELD_LIST}` };

  let prompt = MA_PROMPTS[field];
  if ("prompt" in value && value.prompt !== undefined) {
    if (typeof value.prompt !== "string") return { ok: false, message: "maPrompt.prompt must be a string" };
    const text = value.prompt.trim();
    if (!text) return { ok: false, message: "maPrompt.prompt must not be empty" };
    if (text.length > PROMPT_MAX_CHARS) {
      return { ok: false, message: `maPrompt.prompt must be ${PROMPT_MAX_CHARS} characters or fewer` };
    }
    prompt = text;
  }
  return { ok: true, value: { field, prompt } };
}

function parseDigitChallenge(value: unknown): ParseResult<{ digits: string } | null> {
  if (value === null) return { ok: true, value: null };
  if (!isPlain(value)) return { ok: false, message: "digitChallenge must be an object or null" };
  if (typeof value.digits !== "string") return { ok: false, message: "digitChallenge.digits must be a string" };
  const digits = value.digits.replace(/\s+/g, "");
  if (!/^\d{4,6}$/.test(digits)) {
    return { ok: false, message: "digitChallenge.digits must be 4 to 6 digits" };
  }
  return { ok: true, value: { digits } };
}

function parseMatchFlag(value: unknown, label: string): ParseResult<boolean | null> {
  if (value === null) return { ok: true, value: null };
  if (typeof value !== "boolean") return { ok: false, message: `${label} must be true, false, or null` };
  return { ok: true, value };
}

/** Body for POST /join/:token/replies. At least one of answer or digitResponse. */
export function parseCustomerReply(body: unknown): ParseResult<CustomerReply> {
  if (!isPlain(body)) return { ok: false, message: "Body must be a JSON object" };
  const reply: CustomerReply = {};

  if ("answer" in body) {
    if (typeof body.answer !== "string") return { ok: false, message: "answer must be a string" };
    const answer = body.answer.trim();
    if (!answer) return { ok: false, message: "answer must not be empty" };
    if (answer.length > ANSWER_MAX_CHARS) {
      return { ok: false, message: `answer must be ${ANSWER_MAX_CHARS} characters or fewer` };
    }
    reply.answer = answer;
  }

  if ("digitResponse" in body) {
    if (typeof body.digitResponse !== "string") return { ok: false, message: "digitResponse must be a string" };
    const raw = body.digitResponse.trim();
    if (!raw) return { ok: false, message: "digitResponse must not be empty" };
    if (raw.length > DIGIT_RESPONSE_MAX_CHARS) {
      return { ok: false, message: `digitResponse must be ${DIGIT_RESPONSE_MAX_CHARS} characters or fewer` };
    }
    if (!/^[0-9 ]+$/.test(raw)) return { ok: false, message: "digitResponse must be digits" };
    reply.digitResponse = raw;
  }

  if (!reply.answer && !reply.digitResponse) {
    return { ok: false, message: "answer or digitResponse is required" };
  }
  return { ok: true, value: reply };
}

/**
 * Body for POST /sessions/:id/recording.
 * At least one of recordingUrl or recordingId is required.
 * A field that is omitted is left unchanged. An empty string is rejected.
 */
export function parseRecordingAttach(body: unknown): ParseResult<RecordingAttach> {
  if (!isPlain(body)) return { ok: false, message: "Body must be a JSON object" };
  const attach: RecordingAttach = {};

  if ("recordingUrl" in body) {
    if (typeof body.recordingUrl !== "string") return { ok: false, message: "recordingUrl must be a string" };
    const url = body.recordingUrl.trim();
    if (!url || url.length > RECORDING_URL_MAX) {
      return {
        ok: false,
        message: url
          ? `recordingUrl must be ${RECORDING_URL_MAX} characters or fewer`
          : "recordingUrl must be an http(s) URL",
      };
    }
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { ok: false, message: "recordingUrl must be an http(s) URL" };
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { ok: false, message: "recordingUrl must be an http(s) URL" };
    }
    attach.recordingUrl = url;
  }

  if ("recordingId" in body) {
    if (typeof body.recordingId !== "string") return { ok: false, message: "recordingId must be a string" };
    const id = body.recordingId.trim();
    if (!id) return { ok: false, message: "recordingId must not be empty" };
    if (id.length > RECORDING_ID_MAX) {
      return { ok: false, message: `recordingId must be ${RECORDING_ID_MAX} characters or fewer` };
    }
    if (/[\r\n]/.test(id)) return { ok: false, message: "recordingId must not contain line breaks" };
    attach.recordingId = id;
  }

  if (!attach.recordingUrl && !attach.recordingId) {
    return { ok: false, message: "recordingUrl or recordingId is required" };
  }
  return { ok: true, value: attach };
}

/** `id` shows the customer card guide. Every other kind, and `null`, hides it. */
export function parseCaptureGuide(value: unknown): ParseResult<CaptureKind | null> {
  if (value === null) return { ok: true, value: null };
  if (typeof value !== "string" || !value.trim()) {
    return { ok: false, message: `captureGuide must be ${KIND_LIST}, or null` };
  }
  const mapped = parseKindToken(value);
  if (!mapped) return { ok: false, message: `captureGuide must be ${KIND_LIST}, or null` };
  return { ok: true, value: mapped };
}

export function parseCaptureMeta(
  input: { kind?: unknown; capturedAt?: unknown },
  now: Date,
): ParseResult<{ kind: CaptureKind; capturedAt: string }> {
  let kind: CaptureKind = "other";
  if (input.kind !== undefined && input.kind !== null && input.kind !== "") {
    if (typeof input.kind !== "string") return { ok: false, message: `kind must be ${KIND_LIST}` };
    const mapped = parseKindToken(input.kind);
    if (!mapped) return { ok: false, message: `kind must be ${KIND_LIST}` };
    kind = mapped;
  }

  let capturedAt = now.toISOString();
  if (input.capturedAt !== undefined && input.capturedAt !== null && input.capturedAt !== "") {
    if (typeof input.capturedAt !== "string" || Number.isNaN(Date.parse(input.capturedAt))) {
      return { ok: false, message: "capturedAt must be an ISO-8601 date string" };
    }
    capturedAt = new Date(input.capturedAt).toISOString();
  }

  return { ok: true, value: { kind, capturedAt } };
}

export function sniffImage(bytes: Buffer): ImageContentType | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  return null;
}

export function decodeImage(input: { buffer?: Buffer; text?: string }):
  | { ok: true; bytes: Buffer; contentType: ImageContentType }
  | { ok: false; message: string; status: 400 | 413 } {
  let bytes = input.buffer;
  if (!bytes && input.text !== undefined) {
    const text = input.text.trim();
    const dataUrl = /^data:image\/[a-z0-9.+-]+;base64,([a-z0-9+/=\s]+)$/i.exec(text);
    const base64 = dataUrl ? dataUrl[1] : text;
    if (!dataUrl && !/^[a-z0-9+/=\s]+$/i.test(text)) {
      return { ok: false, status: 400, message: "image must be a JPEG/PNG file, a data URL, or base64" };
    }
    bytes = Buffer.from(base64.replace(/\s/g, ""), "base64");
  }

  if (!bytes || bytes.length === 0) {
    return { ok: false, status: 400, message: "image is required" };
  }
  if (bytes.length > IMAGE_MAX_BYTES) {
    return { ok: false, status: 413, message: "Image must be 4 MB or smaller" };
  }
  const contentType = sniffImage(bytes);
  if (!contentType) {
    return { ok: false, status: 400, message: "Image must be JPEG or PNG" };
  }
  return { ok: true, bytes, contentType };
}
