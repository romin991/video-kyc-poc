import type { RemoteTrack, Room } from "livekit-client";
import type { StoppableTrack } from "./mediaSession";
import { createSessionGate, startMediaSession, type MediaRoom } from "./roomSession";

export interface ConnectInput {
  serverUrl: string;
  token: string;
  /** Already `vkyc-${sessionId}`, matching the room claim inside the Go JWT. */
  roomName: string;
  /** Aborted on End or unmount. Disconnects and stops local tracks. */
  signal: AbortSignal;
  onUnexpectedDisconnect?: (reason: string) => void;
}

export interface ConnectHandle {
  /** livekit-client Room. */
  room: Room;
  /** Set when the room is up but camera or microphone publish failed. */
  publishError: string | null;
  disconnect(): Promise<void>;
}

/** One gate per page, so a remount never overlaps the previous Room. */
const pageGate = createSessionGate();

/**
 * Single LiveKit connect point for both Next.js shells.
 *
 * Room.connect, then getUserMedia({ audio: true, video: true }) and
 * publishTrack for the microphone and camera. Remote camera and microphone
 * tracks attach to [data-livekit="remote"]. The local camera attaches to
 * [data-livekit="local"] and stays muted. Aborting `signal` disconnects,
 * unpublishes, and stops local tracks. Stub tokens never reach this function.
 */
export async function connectRoom(input: ConnectInput): Promise<ConnectHandle> {
  let liveRoom: Room | null = null;
  const session = await startMediaSession(input, {
    gate: pageGate,
    devices: navigator.mediaDevices,
    createRoom: async () => {
      const livekit = await import("livekit-client");
      liveRoom = new livekit.Room();
      return adaptRoom(liveRoom, livekit);
    },
  });
  return {
    room: liveRoom as unknown as Room,
    publishError: session.publishError,
    disconnect: session.disconnect,
  };
}

function adaptRoom(room: Room, livekit: typeof import("livekit-client")): MediaRoom {
  const { ConnectionState, RoomEvent, Track, DisconnectReason } = livekit;
  const isCallTrack = (track: RemoteTrack | undefined): track is RemoteTrack =>
    Boolean(track) && track!.source !== Track.Source.ScreenShare;

  return {
    localParticipant: {
      trackPublications: room.localParticipant.trackPublications,
      unpublishTrack: (track, stopOnUnpublish) => room.localParticipant.unpublishTrack(track as never, stopOnUnpublish),
    },
    remoteParticipants: room.remoteParticipants,
    disconnect: (stopTracks) => room.disconnect(stopTracks),
    removeAllListeners: () => {
      room.removeAllListeners();
    },
    connect: (serverUrl, token) => room.connect(serverUrl, token),
    async publish(track, source, name) {
      const publication = await room.localParticipant.publishTrack(track as MediaStreamTrack, {
        source: source === "camera" ? Track.Source.Camera : Track.Source.Microphone,
        name,
      });
      return { track: publication.track ? toStoppable(publication.track) : undefined };
    },
    remoteTracks() {
      const tracks: StoppableTrack[] = [];
      room.remoteParticipants.forEach((participant) => {
        participant.trackPublications.forEach((publication) => {
          if (isCallTrack(publication.track)) tracks.push(toStoppable(publication.track));
        });
      });
      return tracks;
    },
    onRemoteTrack(listener) {
      const handler = (track: RemoteTrack) => {
        if (isCallTrack(track)) listener(toStoppable(track));
      };
      room.on(RoomEvent.TrackSubscribed, handler);
      return () => {
        room.off(RoomEvent.TrackSubscribed, handler);
      };
    },
    onDisconnected(listener) {
      const handler = (reason?: number) => {
        listener(reason === undefined ? "unknown" : (DisconnectReason[reason] ?? String(reason)));
      };
      room.on(RoomEvent.Disconnected, handler);
      return () => {
        room.off(RoomEvent.Disconnected, handler);
      };
    },
    whenConnected(signal) {
      return new Promise<void>((resolve, reject) => {
        if (signal.aborted) {
          reject(new DOMException("The call ended.", "AbortError"));
          return;
        }
        if (room.state === ConnectionState.Connected) {
          resolve();
          return;
        }
        const cleanup = () => {
          room.off(RoomEvent.ConnectionStateChanged, onState);
          signal.removeEventListener("abort", onAbort);
        };
        const onState = (state: (typeof ConnectionState)[keyof typeof ConnectionState]) => {
          if (state !== ConnectionState.Connected) return;
          cleanup();
          resolve();
        };
        const onAbort = () => {
          cleanup();
          reject(new DOMException("The call ended.", "AbortError"));
        };
        room.on(RoomEvent.ConnectionStateChanged, onState);
        signal.addEventListener("abort", onAbort, { once: true });
      });
    },
  };
}

function toStoppable(track: {
  stop: () => void;
  detach: () => HTMLMediaElement[];
  attach: (element: HTMLMediaElement) => HTMLMediaElement;
  kind: string;
  source: string;
  mediaStreamTrack: MediaStreamTrack;
}): StoppableTrack {
  return track;
}
