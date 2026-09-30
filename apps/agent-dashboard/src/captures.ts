import { useCallback, useState } from "react";
import { uploadSessionCapture, type CaptureSummary, type CaptureUploadOptions } from "./api";

export type CaptureSubmit = (image: Blob | File | string, options?: CaptureUploadOptions) => Promise<CaptureSummary>;

/**
 * Still-frame upload for the agent desk.
 *
 * WebRTC teammate: grab a JPEG or PNG from the customer LiveKit video track
 * (client-side) and pass that Blob, File, or base64/data URL here. This posts
 * to `POST /sessions/:id/captures` and returns the stored capture summary.
 *
 *   multipart: field `image` (file), optional `kind` (face|id|other), optional `capturedAt`
 *   JSON:      `{ image: "data:image/jpeg;base64,...", kind?, capturedAt? }`
 *
 * Prefer `captureVideoStill` in `./captureStill` for the remote customer
 * LiveKit track. `blobFromVideoFrame` paints a `<video>` element to a JPEG
 * when that track is not available.
 */
export function useCaptureUpload(sessionId: string | null, agentName: string): {
  submit: CaptureSubmit;
  pending: boolean;
} {
  const [pending, setPending] = useState(false);

  const submit = useCallback<CaptureSubmit>(
    async (image, options) => {
      if (!sessionId) throw new Error("No session is open on this desk.");
      setPending(true);
      try {
        return await uploadSessionCapture(sessionId, agentName, image, options);
      } finally {
        setPending(false);
      }
    },
    [sessionId, agentName],
  );

  return { submit, pending };
}

export async function blobFromVideoFrame(video: HTMLVideoElement): Promise<Blob> {
  if (video.videoWidth === 0 || video.videoHeight === 0) {
    throw new Error("Customer video has no frame yet. Add a JPEG or PNG still instead.");
  }
  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Could not capture the video frame.");
  context.drawImage(video, 0, 0);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92));
  if (!blob) throw new Error("Could not encode the video frame.");
  return blob;
}
