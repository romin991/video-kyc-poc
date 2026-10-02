"use client";

import { useEffect, useState } from "react";
import {
  Room,
  RoomEvent,
  Track,
  type LocalTrack,
  type LocalTrackPublication,
  type RemoteTrack,
} from "livekit-client";
import {
  afterLiveKitReleased,
  clearLiveKitTiles,
  isJoinableToken,
  publishLocalAv,
  releaseLiveKitRoom,
  scheduleLiveKitRelease,
  stopTrack,
  type LiveKitRoomRelease,
  type StoppableTrack,
} from "@vkyc/media";

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
 * Connects this participant when NEXT_PUBLIC_LIVEKIT_URL and a LiveKit JWT
 * are both present. Otherwise the call shell stays up and the camera stays off.
 *
 * Local camera attaches to [data-livekit="local"] and stays muted.
 * Remote camera and microphone attach to [data-livekit="remote"].
 * data-active="true" is set when a video track attaches.
 *
 * Cleanup runs when the session leaves the call (the agent ended it, or this
 * page unmounts). It disconnects the room, unpublishes and unsubscribes, stops
 * and detaches local camera and mic tracks (including a getUserMedia that has
 * not finished publishing), and revokes blob: URLs on the tiles. The next
 * connect waits until that release finishes.
 *
 * The agent app hook matches this connection flow. The desk copy also keeps
 * the remote customer camera track so the agent can grab a still later.
 */
export function useLiveKit(roomName: string | null, token: string | null): LiveKitMedia | null {
  const rawUrl = process.env.NEXT_PUBLIC_LIVEKIT_URL;
  const serverUrl = rawUrl && rawUrl.length > 0 ? rawUrl : null;
  const [mediaConnected, setMediaConnected] = useState(false);
  const [mediaError, setMediaError] = useState<string | null>(null);

  useEffect(() => {
    setMediaConnected(false);
    setMediaError(null);

    if (!roomName || !token) return;

    if (!serverUrl) {
      console.info("[vkyc] NEXT_PUBLIC_LIVEKIT_URL is empty; skipping Room.connect");
      return;
    }

    if (!isJoinableToken(token)) {
      console.warn(`[vkyc] ${NOT_A_JWT}`);
      return;
    }

    let cancelled = false;
    let released = false;
    const ownedTracks: MediaStreamTrack[] = [];
    const room = new Room();
    const previousRelease = afterLiveKitReleased();

    const onSubscribed = (track: RemoteTrack) => {
      if (cancelled || released) return;
      attachRemote(track);
    };

    const onLocalPublished = (publication: LocalTrackPublication) => {
      if (cancelled || released) return;
      if (publication.source !== Track.Source.Camera || !publication.track) return;
      attachLocal(publication.track);
    };

    room.on(RoomEvent.TrackSubscribed, onSubscribed);
    room.on(RoomEvent.LocalTrackPublished, onLocalPublished);

    const releaseNow = () => {
      if (released) return;
      released = true;
      for (const track of ownedTracks) stopTrack(track);
      room.off(RoomEvent.TrackSubscribed, onSubscribed);
      room.off(RoomEvent.LocalTrackPublished, onLocalPublished);
      clearTiles();
      scheduleLiveKitRelease(async () => {
        try {
          await releaseLiveKitRoom(asReleaseRoom(room), ownedTracks);
          console.info("[vkyc] LiveKit room released");
        } catch (error) {
          console.error("[vkyc] LiveKit release failed", error);
        } finally {
          for (const track of ownedTracks) stopTrack(track);
          clearTiles();
        }
      });
    };

    const connect = async () => {
      try {
        await previousRelease;
        if (cancelled || released) return;
        await room.connect(serverUrl, token);
        if (cancelled || released) return;
        setMediaConnected(true);
        setMediaError(null);
        try {
          await publishLocalAv({
            publisher: {
              publishTrack: async (mediaTrack, options) => {
                const publication = await room.localParticipant.publishTrack(mediaTrack as MediaStreamTrack, {
                  source: options.source === "camera" ? Track.Source.Camera : Track.Source.Microphone,
                  name: options.name,
                });
                return { track: publication.track ?? undefined };
              },
            },
            ownedTracks,
            isCancelled: () => cancelled || released,
            devices: navigator.mediaDevices,
            onCameraPublished: (track) => attachLocal(track as LocalTrack),
            logDevices: (devices) => console.info("[vkyc] media devices", devices),
          });
        } catch (error) {
          console.error("[vkyc] local A/V publish failed", error);
        }
        if (cancelled || released) return;
        room.remoteParticipants.forEach((participant) => {
          participant.trackPublications.forEach((publication) => {
            if (publication.track) attachRemote(publication.track);
          });
        });
      } catch (error) {
        if (released) return;
        if (!cancelled) {
          const message = error instanceof Error ? error.message : "LiveKit connection failed";
          console.error("[vkyc] Room.connect failed", error);
          setMediaConnected(false);
          setMediaError(message);
        }
        releaseNow();
      }
    };

    void connect();

    return () => {
      cancelled = true;
      releaseNow();
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

function asReleaseRoom(room: Room): LiveKitRoomRelease {
  return {
    localParticipant: {
      trackPublications: room.localParticipant.trackPublications,
      unpublishTrack: (track: StoppableTrack, stopOnUnpublish?: boolean) =>
        room.localParticipant.unpublishTrack(track as LocalTrack, stopOnUnpublish),
    },
    remoteParticipants: room.remoteParticipants,
    disconnect: (stopTracks?: boolean) => room.disconnect(stopTracks),
    removeAllListeners: () => {
      room.removeAllListeners();
    },
  };
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
  clearLiveKitTiles(document.querySelectorAll<HTMLVideoElement>("[data-livekit]"), (url) => {
    URL.revokeObjectURL(url);
  });
}
