# iOS customer SDK

Swift package and demo that load the existing Next.js customer join page in a `WKWebView`. The page keeps the LiveKit camera and microphone. The SDK presents that page and reports connected, ended, and error.

Join links come from the Go API as `CUSTOMER_APP_ORIGIN + "/join/" + joinToken`. The company-stack default origin is `http://127.0.0.1:3002`, so a link looks like `http://127.0.0.1:3002/join/<token>`.

## Secure context

`getUserMedia` inside `WKWebView` runs only in a secure context.

Allowed:

- `https://…`
- `http://127.0.0.1` (any port)
- `http://localhost` (any port)

Anything else on `http`, including a LAN address such as `http://192.168.x.x`, is rejected. The demo shows the reason and does not open the webview. `VKYCCustomer.start` does the same and calls `onError`. An `https` URL on a public host is allowed; that is the shape to use when a public customer origin exists.

A physical iPhone cannot open the Mac's `127.0.0.1`. Use the simulator on that Mac, or an `https` join URL. Do not point the demo at `http://192.168.x.x`.

## Project

| Path | Role |
| --- | --- |
| `Package.swift` | Library product `SuperbankVKYC` (iOS 15+) |
| `Sources/SuperbankVKYC` | `VKYCCustomer.start(joinURL:from:onConnected:onEnded:onError:)` |
| `Demo/VKYCCustomerDemo.xcodeproj` | One-button demo. Shared scheme `VKYCCustomerDemo` |

Open `apps/ios-customer/Demo/VKYCCustomerDemo.xcodeproj` in Xcode 15 or newer. The app target links the local package next to the project (`..`).

`VKYCCustomer.start` takes the full join URL as a `String`, presents a full-screen webview from the given view controller, and invokes:

- `onConnected` when the web LiveKit phase is `connected`
- `onEnded` when the session status is `ended`, then dismisses the webview
- `onError` for an insecure or invalid URL, a page error, or a failed load

Close in the navigation bar dismisses the webview and does not fire `onEnded`.

## Web bridge

The customer page did not post events to native code. `apps/customer-next/src/lib/wk-bridge.ts` is the whole addition. It posts to `window.webkit.messageHandlers.vkyc` and does nothing in a normal browser.

| Payload | When |
| --- | --- |
| `{ "event": "connected" }` | Web LiveKit phase is `connected` |
| `{ "event": "ended" }` | Session status is `ended` (customer End, or the poll after the agent ends) |
| `{ "event": "error", "message": "…" }` | LiveKit connect or publish failure, invalid join link, or End failed |

No Go API change. No response header. Localhost and `https` are already secure contexts. The webview settings below are what let `getUserMedia` prompt.

## WKWebView and Info.plist

- `allowsInlineMediaPlayback = true`
- `mediaTypesRequiringUserActionForPlayback = []`
- `WKUIDelegate` `requestMediaCapturePermissionFor` answers `.prompt` (on iOS 15+, omitting this denies `getUserMedia`)
- `NSCameraUsageDescription` and `NSMicrophoneUsageDescription` in `Demo/VKYCCustomerDemo/Info.plist`
- `NSAllowsLocalNetworking` so the simulator can load `http://127.0.0.1` and `http://localhost`

## Run the demo on a Mac

Xcode 15 or newer, and an iPhone simulator (iOS 15+). This tree was prepared on Linux, where `xcodebuild` is not available, so build and run it on a Mac.

From the repo root, with LiveKit `LIVEKIT_URL`, `LIVEKIT_API_KEY`, and `LIVEKIT_API_SECRET` set the same way as the company stack:

```bash
export CUSTOMER_APP_ORIGIN=http://127.0.0.1:3002
export NEXT_PUBLIC_API_BASE=http://127.0.0.1:3001
export NEXT_PUBLIC_LIVEKIT_URL="$LIVEKIT_URL"
```

`CUSTOMER_APP_ORIGIN` in `.env.example` points at the Vite reference app. Export `http://127.0.0.1:3002` in the shell before `go run` so the desk link targets the Next.js customer app. That is the page that posts the bridge. A Vite join URL (`http://localhost:5174/join/…`) will load, and the callbacks will not fire.

Three terminals:

```bash
cd apps/go-api && go run ./cmd/vkyc-api
```

```bash
pnpm dev:agent-next
```

```bash
pnpm dev:customer-next
```

| Process | URL |
| --- | --- |
| Go API | http://127.0.0.1:3001 |
| Agent desk | http://127.0.0.1:3000 |
| Customer join | http://127.0.0.1:3002 |

In Xcode, open `apps/ios-customer/Demo/VKYCCustomerDemo.xcodeproj`, select the `VKYCCustomerDemo` scheme and an iPhone simulator, and run. The simulator shares the Mac loopback, so `http://127.0.0.1:3002` reaches the customer app.

## One-button flow

1. On the agent desk, create a session. Copy the join URL (`http://127.0.0.1:3002/join/<token>`).
2. In the demo, paste that full URL. The field is empty on purpose so a paste replaces nothing.
3. Tap **Open VKYC**. The SDK presents the customer page in a `WKWebView`.
4. Allow the camera and microphone when iOS and the page ask. Those prompts are the web `getUserMedia` path.
5. Claim the session on the desk if it is still waiting. The webview joins the same room as the desk.

## QA

1. Create a session on the agent desk (`http://127.0.0.1:3000`). Copy `joinUrl`.
2. Paste it into the demo. It must be `https`, or `http://127.0.0.1` / `http://localhost`. Paste `http://192.168.x.x/join/…` (or any other insecure host) and tap **Open VKYC**. The demo shows the secure-context warning and does not present the webview. A LAN IP is not a secure context: `WKWebView` would block the camera and microphone even if the page loaded.
3. Paste the real `http://127.0.0.1:3002/join/<token>` link and tap **Open VKYC**. The webview shows the customer join page.
4. Claim the session on the desk. Allow camera and microphone. Confirm two-way audio and video for at least 10 seconds. Use headphones if the desk and the simulator are on one Mac. The customer tiles stay the web page's `data-livekit="remote"` and `data-livekit="local"` elements.
5. The demo event line shows `Connected` once the web LiveKit phase is connected.
6. Tap **End session** in the webview, or end from the desk. The webview closes, the demo is on screen again, and the event line includes `Ended`.
7. A bad token or a LiveKit failure shows `Error: …` and leaves the webview up. Close dismisses it and does not add `Ended`.

LiveKit credentials are required for the two-way check. Without them the page stays on the call shell with a stub token, and `Connected` does not fire.

## Out of scope

Agent iOS app, a Swift-owned camera, a native LiveKit SDK, OCR, liveness, App Store, TestFlight, and public hosting for the customer app.
