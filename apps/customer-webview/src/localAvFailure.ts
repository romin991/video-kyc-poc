const CAMERA_BLOCKED =
  "Camera blocked — click the lock icon in the address bar and choose Allow, then reload.";

const CAMERA_MISSING = "No camera or microphone found. Connect one, then reload.";

const CAMERA_BUSY = "Camera is in use by another app. Close it, then reload.";

const CAMERA_FAILED = "Camera and microphone could not start. Reload and try again.";

/**
 * Copy for a failed getUserMedia / local publish. The room can stay connected.
 * The agent dashboard keeps the same file.
 */
export function localAvFailureMessage(error: unknown): string {
  const name = errorName(error);
  const message = errorMessage(error);
  if (isPermissionDenied(name, message)) return CAMERA_BLOCKED;
  if (name === "NotFoundError" || message.startsWith("No audio/video inputs")) return CAMERA_MISSING;
  if (name === "NotReadableError") return CAMERA_BUSY;
  if (message) return message;
  return CAMERA_FAILED;
}

function errorName(error: unknown): string {
  if (typeof error === "object" && error !== null && "name" in error && typeof error.name === "string") {
    return error.name;
  }
  return "";
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string") {
    return error.message;
  }
  return "";
}

function isPermissionDenied(name: string, message: string): boolean {
  if (name === "NotAllowedError" || name === "PermissionDeniedError" || name === "PermissionDenied") {
    return true;
  }
  return /permission denied/i.test(message);
}
