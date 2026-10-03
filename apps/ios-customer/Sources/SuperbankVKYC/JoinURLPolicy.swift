import Foundation

extension VKYCCustomer {
    /// Why this string cannot be loaded into the customer webview, or nil when it can.
    ///
    /// `getUserMedia` inside WKWebView runs only in a secure context: `https`,
    /// or `http` on `localhost` / `127.0.0.1`. Any other `http` host, including
    /// a LAN address such as `192.168.x.x`, is rejected.
    public static func rejectionMessage(for joinURL: String) -> String? {
        let trimmed = joinURL.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty {
            return "Paste a join URL. The local customer app is http://127.0.0.1:3002/join/<token>."
        }
        guard let parts = URL(string: trimmed),
              let scheme = parts.scheme?.lowercased(),
              let host = parts.host?.lowercased(),
              !host.isEmpty
        else {
            return "That is not a join URL. Use https, or http://127.0.0.1 / http://localhost, including the /join/<token> path."
        }
        if scheme == "https" {
            return nil
        }
        if scheme == "http", host == "localhost" || host == "127.0.0.1" {
            return nil
        }
        if scheme == "http" {
            return "http://\(host) is not a secure context, so the camera and microphone will not start. Use https, or http://127.0.0.1 / http://localhost. A plain LAN address (http://192.168.x.x) is blocked."
        }
        return "Use an https join URL, or http://127.0.0.1 / http://localhost."
    }
}
