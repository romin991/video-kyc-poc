import type { CaptureKind, Disposition, ImageContentType, OnboardingPayload } from "./types.js";

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
  other: "other",
};

export interface SessionPatch {
  checklist?: { id: string; checked: boolean }[];
  acwNotes?: string;
  disposition?: Disposition | null;
}

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

  return { ok: true, value: patch };
}

export function parseCaptureMeta(
  input: { kind?: unknown; capturedAt?: unknown },
  now: Date,
): ParseResult<{ kind: CaptureKind; capturedAt: string }> {
  let kind: CaptureKind = "other";
  if (input.kind !== undefined && input.kind !== null && input.kind !== "") {
    if (typeof input.kind !== "string") return { ok: false, message: "kind must be face, id, or other" };
    const mapped = KINDS[input.kind.trim().toLowerCase()];
    if (!mapped) return { ok: false, message: "kind must be face, id, or other" };
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
