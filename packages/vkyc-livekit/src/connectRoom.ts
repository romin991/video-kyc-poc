import type { RemoteTrack, Room } from "livekit-client";
import { attachRemote, publishLocalAv, releaseLiveKitRoom, type StoppableTrack } from "./mediaSession";

export interface ConnectInput {
  serverUrl: string;
  token: string;
  /** Already `vkyc-${sessionId}`, matching the room claim inside the Go JWT. */
  roomName: string;
  /** Set when End unmounts the call before connect finishes. */
  signal?: AbortSignal;
}

export interface ConnectHandle {
  /** livekit-client Room. */
  room: Room;
  /** Set when the room is up but camera or microphone publish failed. */
  publishError: string | null;
  disconnect(): Promise<void>;
}

/**
 * Single LiveKit connect point for both Next.js shells.
 *
 * Room.connect, then getUserMedia({ audio: true, video: true }) and
 * publishTrack for the microphone and camera. Remote camera and microphone
 * tracks attach to [data-livekit="remote"]. The local camera attaches to
 * [data-livekit="local"] and stays muted.
 *
 * disconnect() unpublishes, unsubscribes, stops local tracks (including a
 * getUserMedia that has not finished publishing), and leaves the room.
 * Stub tokens never reach this function.
 */
export async function connectRoom(input: ConnectInput): Promise<ConnectHandle> {
  const { Room, RoomEvent, Track } = await import("livekit-client");
  const room = new Room();
  const ownedTracks: MediaStreamTrack[] = [];
  let released = false;

  const onSubscribed = (track: RemoteTrack) => {
    if (released || track.source === Track.Source.ScreenShare) return;
    attachRemote(asStoppable(track));
  };

  const release = async () => {
    if (released) return;
    released = true;
    room.off(RoomEvent.TrackSubscribed, onSubscribed);
    await releaseLiveKitRoom(
      {
        localParticipant: {
          trackPublications: room.localParticipant.trackPublications,
          unpublishTrack: (track, stopOnUnpublish) =>
            room.localParticipant.unpublishTrack(track as never, stopOnUnpublish),
        },
        remoteParticipants: room.remoteParticipants,
        disconnect: (stopTracks) => room.disconnect(stopTracks),
        removeAllListeners: () => {
          room.removeAllListeners();
        },
      },
      ownedTracks,
    );
  };

  const throwIfAborted = async () => {
    if (!input.signal?.aborted) return;
    await release();
    throw new DOMException("The call ended before media connected.", "AbortError");
  };

  try {
    console.info(`[vkyc] Room.connect ${input.roomName}`);
    await room.connect(input.serverUrl, input.token);
    await throwIfAborted();
    room.on(RoomEvent.TrackSubscribed, onSubscribed);

    let publishError: string | null = null;
    try {
      await publishLocalAv({
        publisher: {
          publishTrack: async (mediaTrack, options) => {
            const publication = await room.localParticipant.publishTrack(mediaTrack as MediaStreamTrack, {
              source: options.source === "camera" ? Track.Source.Camera : Track.Source.Microphone,
              name: options.name,
            });
            return { track: publication.track ? asStoppable(publication.track) : undefined };
          },
        },
        ownedTracks,
        isCancelled: () => released || input.signal?.aborted === true,
        devices: navigator.mediaDevices,
      });
    } catch (error) {
      publishError = error instanceof Error ? error.message : "Camera and microphone publish failed";
      console.error("[vkyc] local A/V publish failed", error);
    }

    await throwIfAborted();
    room.remoteParticipants.forEach((participant) => {
      participant.trackPublications.forEach((publication) => {
        if (!publication.track || publication.source === Track.Source.ScreenShare) return;
        attachRemote(asStoppable(publication.track));
      });
    });

    return { room, publishError, disconnect: release };
  } catch (error) {
    await release();
    throw error;
  }
}

function asStoppable(track: {
  stop: () => void;
  detach: () => HTMLMediaElement[];
  attach: (element: HTMLMediaElement) => HTMLMediaElement;
  kind: string;
  source: string;
  mediaStreamTrack: MediaStreamTrack;
}): StoppableTrack {
  return track;
}
