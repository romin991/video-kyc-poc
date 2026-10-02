# Wave R1 LiveKit media

This slice is the LiveKit contract for the Go + Next rewrite. The Express API and Vite apps on `main` stay the reference. Manual auth, captures, the waiting queue, recording, and deploy are out of scope.

Session create, join, claim, and end are not implemented in Go. Eng owns those handlers. When they exist, call the minter and put `roomName` plus the participant token on the response the browsers already use:

- accept and claim: `livekit.Minter.ForAccept(sessionID)` → agent token
- customer join: `livekit.Minter.ForJoin(sessionID)` → customer token

`POST /media/tokens` is only the stand-in the Next call shells use until those handlers are mounted. Do not expose it publicly without the session checks eng will add.

## Contract

| Piece | Value |
| --- | --- |
| SFU | LiveKit Cloud, same project as the Vite apps |
| Room | `vkyc-${sessionId}` |
| Identity | `agent` or `customer` |
| Grants | `roomJoin`, `canPublish`, `canSubscribe` |
| TTL | 10 minutes, reused until it is within 1 minute of expiry |
| Go env | `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` |
| Next env | `NEXT_PUBLIC_LIVEKIT_URL` (same WebSocket URL as `LIVEKIT_URL`) |
| Publish | `getUserMedia({ audio: true, video: true })` then `publishTrack` |
| End | disconnect the room, unpublish, unsubscribe, stop local tracks |

Missing `LIVEKIT_API_KEY` or `LIVEKIT_API_SECRET` returns `lk-stub-…` and does not fail the caller. Missing `NEXT_PUBLIC_LIVEKIT_URL` skips `Room.connect`. The call shell stays up either way.

## Env

Repo-root `.env` (gitignored). Names are listed in `.env.example`.

```bash
LIVEKIT_URL=wss://your-project.livekit.cloud
LIVEKIT_API_KEY=your_api_key
LIVEKIT_API_SECRET=your_api_secret
NEXT_PUBLIC_LIVEKIT_URL=wss://your-project.livekit.cloud
NEXT_PUBLIC_API_BASE=http://127.0.0.1:8080
```

The Go process reads `LIVEKIT_*` from the environment, then fills any that are still empty from the nearest `.env` walking up from the working directory (the repo root when you start it from `services/vkyc-api`). It does not override variables that are already set. Next agent and customer load the repo-root `.env` when `next dev` or `next build` starts, and inline `NEXT_PUBLIC_*`. Restart Next after changing them.

`VKYC_GO_ADDR` defaults to `127.0.0.1:8080`. `CORS_ORIGINS` is appended to the Next dev origins (`http://127.0.0.1:3100` and `:3101`).

## Run the media shell

```bash
# Go mint
cd services/vkyc-api
export LIVEKIT_URL=wss://your-project.livekit.cloud
export LIVEKIT_API_KEY=your_api_key
export LIVEKIT_API_SECRET=your_api_secret
go run ./cmd/vkyc-api
```

```bash
# Next, from the repo root. Both apps read NEXT_PUBLIC_* from the repo-root .env.
pnpm --filter @vkyc/next-agent dev
pnpm --filter @vkyc/next-customer dev
```

| Process | URL |
| --- | --- |
| Go API | http://127.0.0.1:8080 |
| Agent | http://127.0.0.1:3100 |
| Customer | http://127.0.0.1:3101 |

Once eng’s session handlers return tokens, open the apps with that payload instead of the mint stand-in:

```text
http://127.0.0.1:3100/?sessionId=<id>&roomName=vkyc-<id>&token=<agent jwt>
http://127.0.0.1:3101/?sessionId=<id>&roomName=vkyc-<id>&token=<customer jwt>
```

Those query params call `useLiveKit(roomName, token)` directly. `Room.connect` runs when both the JWT and `NEXT_PUBLIC_LIVEKIT_URL` are set.

## QA: two-way audio and video for at least 10 seconds

Use two browsers (or one normal window and one private window) on a machine with a camera and microphone. Headphones avoid echo.

1. Confirm the Go API is up: `curl -s http://127.0.0.1:8080/health` returns `{"ok":true,"service":"vkyc-api-go"}`.
2. Mint check, without opening a browser. The payload `video.room` must be `vkyc-qa-10s` and `sub` must be `agent`:

```bash
curl -s -X POST http://127.0.0.1:8080/media/tokens \
  -H 'content-type: application/json' \
  -d '{"sessionId":"qa-10s","role":"agent"}'
```

3. Agent window: http://127.0.0.1:3100. Enter session id `qa-10s`. Click **Join call**. Allow the camera and microphone.
4. Customer window: http://127.0.0.1:3101. Enter the same session id `qa-10s`. Click **Join call**. Allow the camera and microphone.
5. Each window’s remote tile shows the other person, and the local tile shows this side (muted). Leave both connected for at least 10 seconds. Speak on each side and confirm the other side hears it.
6. Click **End** on each window. The status says the room is disconnected and the camera and microphone are stopped. The camera indicator on the machine turns off. The tiles return to the placeholder (`data-active` is removed).
7. A second join with the same session id connects again. Ending again stops the new tracks.

If `NEXT_PUBLIC_LIVEKIT_URL` is empty, join still succeeds and the status says the camera stays off. No permission prompt is expected. If the API key or secret is empty, the token is `lk-stub-…` and the browser does not call `Room.connect`.

## Checks that do not need LiveKit Cloud

```bash
cd services/vkyc-api && go test ./...
pnpm --filter @vkyc/media test
pnpm --filter @vkyc/next-agent --filter @vkyc/next-customer typecheck
```

`go test` verifies the signed JWT: issuer, identity `agent` or `customer`, room `vkyc-${sessionId}`, `roomJoin`, `canPublish`, `canSubscribe`, and a TTL of about 10 minutes.
