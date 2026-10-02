import type { Room } from "livekit-client";

export interface ConnectInput {
  serverUrl: string;
  token: string;
  /** Already `vkyc-${sessionId}`, matching the room claim inside the Go JWT. */
  roomName: string;
}

export interface ConnectHandle {
  /** livekit-client Room. The LiveKit client PR attaches tracks from here. */
  room: Room;
  disconnect(): Promise<void>;
}

/**
 * Single LiveKit connect point for both Next.js shells.
 *
 * Ownership: the parallel vkyc webrtc agent fills camera/microphone publish,
 * subscribe, and `[data-livekit="local"|"remote"]` tile attach in this file.
 * The desks call `useCallMedia` and do not open their own rooms.
 *
 * R1 calls `Room.connect` when a WebSocket URL and a real JWT are present.
 * It does not publish or attach media. Stub tokens (`lk-stub-…`) never reach
 * this function. If a mint package lands on the webrtc branch first, the Go
 * API should call that package; this file stays the browser connect point.
 */
export async function connectRoom(input: ConnectInput): Promise<ConnectHandle> {
  const { Room } = await import("livekit-client");
  const room = new Room();
  console.info(`[vkyc] Room.connect ${input.roomName}`);
  await room.connect(input.serverUrl, input.token);
  return {
    room,
    disconnect() {
      return room.disconnect();
    },
  };
}
