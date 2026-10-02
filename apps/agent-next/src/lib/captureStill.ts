/** Grab one JPEG from the remote customer tile already on the desk. */
export async function captureRemoteStill(): Promise<Blob> {
  const video = document.querySelector('video[data-livekit="remote"]');
  if (!(video instanceof HTMLVideoElement)) {
    throw new Error("Customer video is not on the desk yet.");
  }
  if (video.videoWidth === 0 || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
    throw new Error("Customer video has no frame yet. Add a JPEG or PNG instead.");
  }

  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Could not draw the customer video frame.");
  context.drawImage(video, 0, 0, canvas.width, canvas.height);

  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob((next) => resolve(next), "image/jpeg", 0.92);
  });
  if (!blob) throw new Error("Could not encode the customer video frame.");
  return blob;
}

export function blobToDataURL(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Could not read the still."));
    reader.readAsDataURL(blob);
  });
}
