/**
 * Fallback tape helpers shared by the agent desk.
 *
 * Cloud egress is optional. While it is absent the desk keeps one browser
 * recorder for the whole call. End session must not replace that tape with
 * a shorter stub.
 */

export interface TapeRecorder {
  state: string;
  mimeType: string;
  stop: () => void;
  onstop: ((...args: never[]) => void) | null;
  onerror: ((...args: never[]) => void) | null;
}

export interface CallTape {
  stop: () => Promise<Blob>;
}

/**
 * While the customer camera is live, the desk keeps one recorder.
 * End session sets `ending` so the poll does not arm another recorder
 * during upload.
 */
export function fallbackRecorderAction(input: {
  mode: string;
  mediaConnected: boolean;
  ending: boolean;
  recorderState: string | null;
}): "start" | "restart" | "keep" {
  if (input.ending || !input.mediaConnected || input.mode !== "fallback") return "keep";
  if (input.recorderState == null) return "start";
  if (input.recorderState === "recording" || input.recorderState === "paused") return "keep";
  return "restart";
}

/** Keep the larger blob. A later 1–3s stub must not replace the call. */
export function selectLongerRecording<T extends { readonly size: number }>(current: T | null, next: T | null): T | null {
  if (!next || next.size <= 0) return current;
  if (!current || next.size > current.size) return next;
  return current;
}

/**
 * Stop a MediaRecorder and close the stream it owns.
 * A second stop returns the same blob.
 */
export function createCallTape(options: {
  recorder: TapeRecorder;
  chunks: Blob[];
  close: () => void;
}): CallTape {
  const recorder = options.recorder;
  let stopping: Promise<Blob> | null = null;
  let released = false;

  const releaseResources = () => {
    if (released) return;
    released = true;
    try {
      options.close();
    } catch {
      // The audio graph is already closed.
    }
  };

  return {
    stop: () => {
      if (stopping) return stopping;
      const blobType = recorder.mimeType || "video/webm";
      stopping = new Promise((resolve, reject) => {
        const finish = () => {
          releaseResources();
          resolve(new Blob(options.chunks, { type: blobType }));
        };
        recorder.onerror = () => {
          releaseResources();
          reject(new Error("call recorder failed"));
        };
        recorder.onstop = finish;
        if (recorder.state === "inactive") {
          finish();
          return;
        }
        try {
          recorder.stop();
        } catch (error) {
          releaseResources();
          reject(error instanceof Error ? error : new Error("call recorder failed"));
        }
      });
      return stopping;
    },
  };
}
