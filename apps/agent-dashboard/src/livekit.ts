import { useEffect } from "react";

export interface LiveKitStub {
  serverUrl: string | null;
  roomName: string;
  token: string;
  /** Stays false until Room.connect is implemented. */
  mediaConnected: false;
}

/**
 * Holds the room name and participant token for the call shell.
 * Media is owned by another engineer — this does not open a camera or microphone.
 *
 * TODO(livekit): replace the body of this hook with `livekit-client`.
 *   import { Room, RoomEvent, Track } from "livekit-client";
 *   const room = new Room();
 *   await room.connect(serverUrl, token);
 *   await room.localParticipant.setMicrophoneEnabled(true);
 *   await room.localParticipant.setCameraEnabled(true);
 *   room.on(RoomEvent.TrackSubscribed, (track) => {
 *     if (track.kind !== Track.Kind.Video) return;
 *     const element = document.querySelector<HTMLVideoElement>('[data-livekit="remote"]');
 *     if (!element) return;
 *     track.attach(element);
 *     element.dataset.active = "true";
 *   });
 *   Attach the local camera track to [data-livekit="local"] the same way.
 *   On cleanup call room.disconnect() and delete dataset.active.
 *
 * Keep the local <video> muted. Set data-active="true" after attach so the
 * placeholder hides (see styles.css).
 *
 * Keep this file in step with apps/customer-webview/src/livekit.ts.
 */
export function useLiveKitStub(roomName: string | null, token: string | null): LiveKitStub | null {
  const rawUrl = import.meta.env.VITE_LIVEKIT_URL;
  const serverUrl = rawUrl && rawUrl.length > 0 ? rawUrl : null;

  useEffect(() => {
    if (!roomName || !token) return;
    console.info("[vkyc] LiveKit hook armed (stub)", { roomName, token, serverUrl });
    return () => {
      console.info("[vkyc] LiveKit hook released (stub). TODO: room.disconnect()");
    };
  }, [roomName, token, serverUrl]);

  if (!roomName || !token) return null;
  return { serverUrl, roomName, token, mediaConnected: false };
}
