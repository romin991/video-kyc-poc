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
  releaseLiveKitRoom,
  scheduleLiveKitRelease,
  stopTrack,
  type LiveKitRoomRelease,
  type StoppableTrack,
} from "../../api/src/callMediaRelease";
import { localAvFailureMessage } from "./localAvFailure";

export interface LiveKitMedia {
  serverUrl: string | null;
  roomName: string;
  token: string;
  /** True after Room.connect resolves. */
  mediaConnected: boolean;
  /** Why media did not start. Null while idle, connecting, or connected. */
  mediaError: string | null;
  /**
   * Set when the room stayed up but this camera and microphone did not publish.
   * Null while idle, connecting, or after a successful publish.
   */
  localPublishError: string | null;
  /** Remote customer camera, once subscribed. Screen share is ignored. */
  remoteVideoTrack: MediaStreamTrack | null;
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
 * The local microphone is attached to that same muted tile so the call
 * recorder can mix it in. The mic does not set data-active, so a camera
 * failure still shows on the tile.
 * Remote camera and microphone attach to [data-livekit="remote"].
 * data-active="true" is set when a video track attaches.
 *
 * Cleanup runs when the call ends, the agent leaves, or this participant
 * unmounts. It disconnects the room, unpublishes and unsubscribes, stops and
 * detaches local camera and mic tracks (including a getUserMedia that has not
 * finished publishing), and revokes blob: URLs on the tiles. The next connect
 * waits until that release finishes. This stays a passive effect so the desk's
 * MediaRecorder can stop first.
 *
 * The customer webview hook matches this file. This desk also keeps the remote
 * customer camera track so Capture still can grab a frame from it.
 *
 * Media capture uses plain getUserMedia({ audio: true, video: true }) then
 * publishTrack — LiveKit's setCameraEnabled(true) exact-matches deviceId
 * "default", which Chrome fake-AV often lacks for video.
 */
export function useLiveKit(roomName: string | null, token: string | null): LiveKitMedia | null {
  const rawUrl = import.meta.env.VITE_LIVEKIT_URL;
  const serverUrl = rawUrl && rawUrl.length > 0 ? rawUrl : null;
  const [mediaConnected, setMediaConnected] = useState(false);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [localPublishError, setLocalPublishError] = useState<string | null>(null);
  const [remoteVideoTrack, setRemoteVideoTrack] = useState<MediaStreamTrack | null>(null);

  useEffect(() => {
    setMediaConnected(false);
    setMediaError(null);
    setLocalPublishError(null);
    setRemoteVideoTrack(null);

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
    let released = false;
    const ownedTracks: MediaStreamTrack[] = [];
    const room = new Room();
    const previousRelease = afterLiveKitReleased();

    const noteRemoteVideo = (track: RemoteTrack) => {
      if (cancelled || released) return;
      if (track.kind !== Track.Kind.Video) return;
      if (track.source === Track.Source.ScreenShare) return;
      setRemoteVideoTrack(track.mediaStreamTrack);
    };

    const onSubscribed = (track: RemoteTrack) => {
      if (cancelled || released) return;
      attachRemote(track);
      noteRemoteVideo(track);
    };

    const onUnsubscribed = (track: RemoteTrack) => {
      if (cancelled || released || track.kind !== Track.Kind.Video) return;
      setRemoteVideoTrack((current) => (current?.id === track.mediaStreamTrack.id ? null : current));
    };

    const onLocalPublished = (publication: LocalTrackPublication) => {
      if (cancelled || released || !publication.track) return;
      if (publication.source === Track.Source.Camera) attachLocal(publication.track);
      if (publication.source === Track.Source.Microphone) attachLocalMic(publication.track);
    };

    room.on(RoomEvent.TrackSubscribed, onSubscribed);
    room.on(RoomEvent.TrackUnsubscribed, onUnsubscribed);
    room.on(RoomEvent.LocalTrackPublished, onLocalPublished);

    const releaseNow = () => {
      if (released) return;
      released = true;
      for (const track of ownedTracks) stopTrack(track);
      room.off(RoomEvent.TrackSubscribed, onSubscribed);
      room.off(RoomEvent.TrackUnsubscribed, onUnsubscribed);
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
          await publishLocalAv(room, ownedTracks, () => cancelled || released);
          if (!cancelled && !released) setLocalPublishError(null);
        } catch (error) {
          console.error("[vkyc] local A/V publish failed", error);
          if (!cancelled && !released) setLocalPublishError(localAvFailureMessage(error));
        }
        if (cancelled || released) return;
        room.remoteParticipants.forEach((participant) => {
          participant.trackPublications.forEach((publication) => {
            if (!publication.track) return;
            attachRemote(publication.track);
            noteRemoteVideo(publication.track);
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
      setRemoteVideoTrack(null);
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
    localPublishError,
    remoteVideoTrack,
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

async function publishLocalAv(
  room: Room,
  ownedTracks: MediaStreamTrack[],
  isCancelled: () => boolean,
): Promise<void> {
  const devices = await navigator.mediaDevices.enumerateDevices();
  if (isCancelled()) return;
  const inputs = devices.filter((d) => d.kind === "audioinput" || d.kind === "videoinput");
  console.info(
    "[vkyc] media devices",
    inputs.map((d) => ({ kind: d.kind, label: d.label || "(empty)", id: d.deviceId.slice(0, 12) })),
  );
  if (inputs.length === 0) {
    throw new Error(
      "No audio/video inputs. On the box, Chrome must be launched with FAKE-AV (--use-fake-device-for-media-stream). Restart that Chrome fork with /workspace/vkyc-tunnels/FAKE-AV.on present.",
    );
  }

  const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
  const tracks = stream.getTracks();
  for (const track of tracks) ownedTracks.push(track);
  if (isCancelled()) {
    for (const track of tracks) stopTrack(track);
    return;
  }
  try {
    for (const mediaTrack of stream.getAudioTracks()) {
      if (isCancelled()) break;
      const publication = await room.localParticipant.publishTrack(mediaTrack, {
        source: Track.Source.Microphone,
        name: mediaTrack.label || "microphone",
      });
      if (publication.track && !isCancelled()) attachLocalMic(publication.track);
    }
    for (const mediaTrack of stream.getVideoTracks()) {
      if (isCancelled()) break;
      const publication = await room.localParticipant.publishTrack(mediaTrack, {
        source: Track.Source.Camera,
        name: mediaTrack.label || "camera",
      });
      if (publication.track && !isCancelled()) attachLocal(publication.track);
    }
  } catch (error) {
    for (const track of tracks) stopTrack(track);
    throw error;
  }
  if (isCancelled()) {
    for (const track of tracks) stopTrack(track);
  }
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

/** Puts the agent mic on the muted local tile without marking the camera active. */
function attachLocalMic(track: LocalTrack): void {
  const element = document.querySelector<HTMLVideoElement>(LOCAL_VIDEO);
  if (!element) return;
  track.attach(element);
  element.muted = true;
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
