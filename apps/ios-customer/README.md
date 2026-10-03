# iOS customer SDK

Swift package and demo that load the customer join page in a `WKWebView`. The page keeps the LiveKit camera and microphone. The SDK presents that page and reports connected, ended, and error.

The live public host is the Vite customer app. The API returns join URLs as `https://vkyc-customer.vercel.app/join/<token>`. The page route is `/join/<token>`.

| Host | URL |
| --- | --- |
| Customer | https://vkyc-customer.vercel.app |
| Agent | https://vkyc-agent.vercel.app |
| API | https://vkyc-api.vercel.app |

## Secure context

`getUserMedia` inside `WKWebView` runs only in a secure context.

Allowed:

- `https://…`, including `https://vkyc-customer.vercel.app/join/<token>`
- `http://127.0.0.1` (any port)
- `http://localhost` (any port)

Anything else on `http`, including a LAN address such as `http://192.168.x.x`, is rejected. The demo shows the reason and does not open the webview. `VKYCCustomer.start` does the same and calls `onError`.

## Project

| Path | Role |
| --- | --- |
| `Package.swift` | Library product `SuperbankVKYC` (iOS 15+) |
| `Sources/SuperbankVKYC` | `VKYCCustomer.start(joinURL:from:onConnected:onEnded:onError:)` |
| `Demo/VKYCCustomerDemo.xcodeproj` | One-button demo. Shared scheme `VKYCCustomerDemo` |

Open `apps/ios-customer/Demo/VKYCCustomerDemo.xcodeproj` in Xcode 15 or newer. The app target links the local package next to the project (`..`).

`VKYCCustomer.start` takes the full join URL as a `String`, presents a full-screen webview from the given view controller, and invokes:

- `onConnected` when the Vite call's LiveKit room has connected (`mediaConnected`)
- `onEnded` when the session status is `ended`, then dismisses the webview
- `onError` for an insecure or invalid URL, a page error, or a failed load

Close in the navigation bar dismisses the webview and does not fire `onEnded`.

The join field placeholder is `https://vkyc-customer.vercel.app/join/<token>`. Paste over it with the URL copied from the agent desk.

## Web bridge

`apps/customer-webview/src/wk-bridge.ts` posts to `window.webkit.messageHandlers.vkyc`. A normal browser has no handler, so the posts are skipped. The call UI is unchanged.

| Payload | When |
| --- | --- |
| `{ "event": "connected" }` | `Room.connect` has resolved (`mediaConnected`) |
| `{ "event": "ended" }` | Session status is `ended` |
| `{ "event": "error", "message": "…" }` | LiveKit connect failure, a non-JWT token, or an invalid join link |

The Next.js customer page posts the same three payloads from `apps/customer-next/src/lib/wk-bridge.ts`. QA uses the Vite host above.

No API change. No response header. `https://vkyc-customer.vercel.app` is a secure context. The webview settings below are what let `getUserMedia` prompt.

## WKWebView and Info.plist

- `allowsInlineMediaPlayback = true`
- `mediaTypesRequiringUserActionForPlayback = []`
- `WKUIDelegate` `requestMediaCapturePermissionFor` answers `.prompt` (on iOS 15+, omitting this denies `getUserMedia`)
- `NSCameraUsageDescription` and `NSMicrophoneUsageDescription` in `Demo/VKYCCustomerDemo/Info.plist`
- `NSAllowsLocalNetworking` so an `http://127.0.0.1` or `http://localhost` URL can still load if you paste one

## Run the demo on a Mac

Xcode 15 or newer, and an iPhone simulator (iOS 15+) or a device. This tree was prepared on Linux, where `xcodebuild` is not available, so build and run it on a Mac.

Open `apps/ios-customer/Demo/VKYCCustomerDemo.xcodeproj`, select the `VKYCCustomerDemo` scheme, and run. The public customer page is already hosted. Do not start the Mac Go API or the Next.js apps for this demo.

## One-button flow

1. On https://vkyc-agent.vercel.app, create a session. Copy the customer join URL. It looks like `https://vkyc-customer.vercel.app/join/<token>`.
2. In the demo, paste that full URL.
3. Tap **Open VKYC**. The SDK presents the Vite customer page in a `WKWebView`.
4. Allow the camera and microphone when iOS and the page ask. Those prompts are the web `getUserMedia` path.
5. Claim the session on the agent desk if it is still waiting. The webview joins the same room as the desk.

## QA

Do not use the Mac Go stack. Create the session on https://vkyc-agent.vercel.app and paste that customer join URL.

1. Open https://vkyc-agent.vercel.app and create a session. Copy the customer join URL (`https://vkyc-customer.vercel.app/join/<token>`).
2. Paste it into the demo. It must be `https`, or `http://127.0.0.1` / `http://localhost`. Paste `http://192.168.x.x/join/…` (or any other insecure host) and tap **Open VKYC**. The demo shows the secure-context warning and does not present the webview. A LAN IP is not a secure context: `WKWebView` would block the camera and microphone even if the page loaded. `https://vkyc-customer.vercel.app` is allowed.
3. Paste the join URL from the agent desk and tap **Open VKYC**. The webview shows the customer join page.
4. Claim the session on https://vkyc-agent.vercel.app. Allow camera and microphone. Confirm two-way audio and video for at least 10 seconds. Use headphones if the desk and the phone are on one Mac. The customer tiles stay the web page's `data-livekit="remote"` and `data-livekit="local"` elements.
5. The demo event line shows `Connected` once the Vite call's LiveKit room has connected.
6. End the session on the agent desk. The webview closes, the demo is on screen again, and the event line includes `Ended`.
7. A bad token or a LiveKit failure shows `Error: …` and leaves the webview up. Close dismisses it and does not add `Ended`.

The bridge is in `apps/customer-webview`. The copy already deployed at https://vkyc-customer.vercel.app posts these events only after that app is built and published. This change does not deploy it.

## Out of scope

Agent iOS app, a Swift-owned camera, a native LiveKit SDK, OCR, liveness, App Store, TestFlight, and Railway, Render, or other hosting work.
