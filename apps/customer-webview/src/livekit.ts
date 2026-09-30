import { useEffect, useState } from "react";
import { Room, RoomEvent, Track, type LocalTrack, type RemoteTrack } from "livekit-client";

export interface LiveKitMedia {
  serverUrl: string | null;
  roomName: string;
  token: string;
  /** True after Room.connect resolves. */
  mediaConnected: boolean;
  /** Why media did not start. Null while idle, connecting, or connected. */
  mediaError: string | null;
}

const LOCAL_VIDEO = '[data-livekit="local"]';
const REMOTE_VIDEO = '[data-livekit="remote"]';

const NOT_A_JWT =
  "Participant token is not a LiveKit JWT. Set LIVEKIT_API_KEY and LIVEKIT_API_SECRET on the API, then start a new session.";

/**
 * Connects this participant when VITE_LIVEKIT_URL and a LiveKit JWT are both
 * present. Otherwise the call shell stays up and the camera stays off.
 *
 * Local camera attaches to [data-livekit="local"] and stays muted.
 * Remote camera and microphone attach to [data-livekit="remote"].
 * data-active="true" is set when a video track attaches.
 * Cleanup disconnects the room and clears data-active.
 *
 * The agent dashboard and customer webview copies of this hook match on purpose.
 */
export function useLiveKit(roomName: string | null, token: string | null): LiveKitMedia | null {
  const rawUrl = import.meta.env.VITE_LIVEKIT_URL;
  const serverUrl = rawUrl && rawUrl.length > 0 ? rawUrl : null;
  const [mediaConnected, setMediaConnected] = useState(false);
  const [mediaError, setMediaError] = useState<string | null>(null);

  useEffect(() => {
    setMediaConnected(false);
    setMediaError(null);

    if (!roomName || !token) return;

    if (!serverUrl) {
      console.info("[vkyc] VITE_LIVEKIT_URL is empty; skipping Room.connect");
      return;
    }

    if (!isJoinableToken(token)) {
      console.warn(`[vkyc] ${NOT_A_JWT}`);
      return;
    }

    let cancelled = false;
    const room = new Room();

    const onSubscribed = (track: RemoteTrack) => {
      attachRemote(track);
    };

    room.on(RoomEvent.TrackSubscribed, onSubscribed);
    room.on(RoomEvent.LocalTrackPublished, (publication) => {
      if (publication.source !== Track.Source.Camera || !publication.track) return;
      attachLocal(publication.track);
    });

    const connect = async () => {
      try {
        await room.connect(serverUrl, token);
        if (cancelled) {
          room.disconnect();
          return;
        }
        setMediaConnected(true);
        setMediaError(null);
        try {
          await room.localParticipant.setMicrophoneEnabled(true);
        } catch (error) {
          console.error("[vkyc] microphone enable failed", error);
        }
        if (cancelled) return;
        try {
          const camera = await room.localParticipant.setCameraEnabled(true);
          if (camera?.track) attachLocal(camera.track);
        } catch (error) {
          console.error("[vkyc] camera enable failed", error);
        }
        if (cancelled) return;
        room.remoteParticipants.forEach((participant) => {
          participant.trackPublications.forEach((publication) => {
            if (publication.track) attachRemote(publication.track);
          });
        });
      } catch (error) {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : "LiveKit connection failed";
        console.error("[vkyc] Room.connect failed", error);
        setMediaConnected(false);
        setMediaError(message);
        room.disconnect();
      }
    };

    void connect();

    return () => {
      cancelled = true;
      room.disconnect();
      clearTiles();
    };
  }, [roomName, token, serverUrl]);

  if (!roomName || !token) return null;

  const configurationError = serverUrl && !isJoinableToken(token) ? NOT_A_JWT : null;
  return {
    serverUrl,
    roomName,
    token,
    mediaConnected,
    mediaError: configurationError ?? mediaError,
  };
}

function isJoinableToken(token: string): boolean {
  const parts = token.split(".");
  return parts.length === 3 && parts.every((part) => part.length > 0);
}

function attachLocal(track: LocalTrack): void {
  const element = document.querySelector<HTMLVideoElement>(LOCAL_VIDEO);
  if (!element) return;
  track.attach(element);
  element.muted = true;
  element.dataset.active = "true";
  void element.play().catch(() => undefined);
}

function attachRemote(track: RemoteTrack): void {
  if (track.kind !== Track.Kind.Video && track.kind !== Track.Kind.Audio) return;
  const element = document.querySelector<HTMLVideoElement>(REMOTE_VIDEO);
  if (!element) return;
  track.attach(element);
  if (track.kind === Track.Kind.Video) element.dataset.active = "true";
  if (track.kind === Track.Kind.Audio) element.muted = false;
  void element.play().catch(() => undefined);
}

function clearTiles(): void {
  document.querySelectorAll<HTMLVideoElement>("[data-livekit]").forEach((element) => {
    delete element.dataset.active;
    element.srcObject = null;
  });
}
