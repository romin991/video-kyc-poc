/**
 * Page → WKScriptMessageHandler bridge for the iOS customer SDK.
 *
 * Posts only connected, ended, and error. A normal browser has no `vkyc`
 * handler, so the posts are skipped and the call UI is unchanged.
 *
 * Payload:
 *   { event: "connected" }
 *   { event: "ended" }
 *   { event: "error", message: string }
 */
type VkycEvent = "connected" | "ended" | "error";

interface VkycHandler {
  postMessage: (body: unknown) => void;
}

interface VkycWindow extends Window {
  webkit?: { messageHandlers?: { vkyc?: VkycHandler } };
}

const once = new Set<"connected" | "ended">();
let lastError: string | null = null;

export function postCustomerEvent(event: VkycEvent, message?: string): void {
  if (typeof window === "undefined") return;

  let body: { event: VkycEvent; message?: string };
  if (event === "error") {
    const text = message?.trim() || "Video KYC error";
    if (lastError === text) return;
    lastError = text;
    body = { event, message: text };
  } else {
    if (once.has(event)) return;
    once.add(event);
    body = { event };
  }

  (window as VkycWindow).webkit?.messageHandlers?.vkyc?.postMessage(body);
}
