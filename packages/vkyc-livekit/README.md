# @vkyc/livekit

Browser connect point for the R1 Next.js shells.

- Go mints the participant JWT (`apps/go-api/internal/livekit`). Room name is `vkyc-${sessionId}`.
- `connectRoom` is the only `livekit-client` `Room.connect` call. It publishes the camera and microphone with `getUserMedia` then `publishTrack`, subscribes to the remote participant, and attaches tiles. `disconnect()` stops those tracks when the call ends.
- Agent and customer import `useCallMedia`. They render `[data-livekit="local"]` and `[data-livekit="remote"]` and do not open a second room.

Stub tokens (`lk-stub-…`) and an empty LiveKit URL skip `Room.connect`. The call shell still renders.
