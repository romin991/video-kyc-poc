import UIKit
import WebKit

/// Presents the existing customer web join flow in a WKWebView.
///
/// Camera and microphone stay on that page's LiveKit path. The page posts
/// `connected`, `ended`, and `error` to the `vkyc` script handler
/// (`apps/customer-next/src/lib/wk-bridge.ts`).
public enum VKYCCustomer {
    /// Script message handler the customer page calls.
    public static let scriptHandlerName = "vkyc"

    /// Loads `joinURL` and presents it from `presenter`.
    ///
    /// `onConnected` fires when the web call reaches LiveKit `connected`.
    /// `onEnded` fires when the session status becomes `ended`, and the webview is dismissed.
    /// `onError` fires for an insecure or invalid URL, a page error, or a load failure.
    /// An insecure URL is not presented.
    public static func start(
        joinURL: String,
        from presenter: UIViewController,
        onConnected: @escaping () -> Void,
        onEnded: @escaping () -> Void,
        onError: @escaping (_ message: String) -> Void
    ) {
        if let rejection = rejectionMessage(for: joinURL) {
            dispatch(onError, rejection)
            return
        }
        guard let url = URL(string: joinURL.trimmingCharacters(in: .whitespacesAndNewlines)) else {
            dispatch(onError, "That is not a join URL.")
            return
        }

        let web = VKYCWebController(
            url: url,
            onConnected: onConnected,
            onEnded: onEnded,
            onError: onError
        )
        let navigation = UINavigationController(rootViewController: web)
        navigation.modalPresentationStyle = .fullScreen
        dispatch {
            presenter.present(navigation, animated: true)
        }
    }

    private static func dispatch(_ body: @escaping () -> Void) {
        if Thread.isMainThread {
            body()
        } else {
            DispatchQueue.main.async(execute: body)
        }
    }

    private static func dispatch(_ body: @escaping (String) -> Void, _ message: String) {
        dispatch { body(message) }
    }
}

private final class ScriptBridge: NSObject, WKScriptMessageHandler {
    weak var owner: VKYCWebController?

    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage
    ) {
        owner?.receive(message)
    }
}

private final class VKYCWebController: UIViewController, WKNavigationDelegate, WKUIDelegate {
    private let url: URL
    private let onConnected: () -> Void
    private let onEnded: () -> Void
    private let onError: (String) -> Void
    private let bridge = ScriptBridge()
    private var webView: WKWebView?
    private var didConnect = false
    private var didEnd = false

    init(
        url: URL,
        onConnected: @escaping () -> Void,
        onEnded: @escaping () -> Void,
        onError: @escaping (String) -> Void
    ) {
        self.url = url
        self.onConnected = onConnected
        self.onEnded = onEnded
        self.onError = onError
        super.init(nibName: nil, bundle: nil)
        bridge.owner = self
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("VKYCWebController is created in code")
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        title = "Video verification"
        navigationItem.leftBarButtonItem = UIBarButtonItem(
            barButtonSystemItem: .close,
            target: self,
            action: #selector(closeTapped)
        )

        let configuration = WKWebViewConfiguration()
        configuration.allowsInlineMediaPlayback = true
        configuration.mediaTypesRequiringUserActionForPlayback = []
        configuration.userContentController.add(bridge, name: VKYCCustomer.scriptHandlerName)

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = false
        if #available(iOS 16.4, *) {
            webView.isInspectable = true
        }
        webView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(webView)
        NSLayoutConstraint.activate([
            webView.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            webView.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor),
            webView.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor),
        ])
        self.webView = webView
        webView.load(URLRequest(url: url))
    }

    deinit {
        webView?.configuration.userContentController.removeScriptMessageHandler(forName: VKYCCustomer.scriptHandlerName)
    }

    @objc private func closeTapped() {
        dismissPresentedWebView()
    }

    func receive(_ message: WKScriptMessage) {
        guard message.name == VKYCCustomer.scriptHandlerName, !didEnd else { return }
        guard let event = eventName(in: message.body) else { return }
        switch event.name {
        case "connected":
            guard !didConnect else { return }
            didConnect = true
            onConnected()
        case "ended":
            didEnd = true
            onEnded()
            dismissPresentedWebView()
        case "error":
            let text = event.message?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            onError(text.isEmpty ? "Video KYC error" : text)
        default:
            break
        }
    }

    private func eventName(in body: Any) -> (name: String, message: String?)? {
        if let object = body as? [String: Any], let name = object["event"] as? String {
            return (name, object["message"] as? String)
        }
        if let object = body as? [String: String], let name = object["event"] {
            return (name, object["message"])
        }
        return nil
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        reportLoadFailure(error)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        reportLoadFailure(error)
    }

    /// iOS 15+ denies `getUserMedia` unless the webview answers this. `.prompt`
    /// shows the system camera/microphone prompt (Info.plist usage strings required).
    func webView(
        _ webView: WKWebView,
        requestMediaCapturePermissionFor origin: WKSecurityOrigin,
        initiatedByFrame frame: WKFrameInfo,
        type: WKMediaCaptureType,
        decisionHandler: @escaping (WKPermissionDecision) -> Void
    ) {
        decisionHandler(.prompt)
    }

    private func reportLoadFailure(_ error: Error) {
        let nsError = error as NSError
        if nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorCancelled {
            return
        }
        guard !didEnd else { return }
        onError(nsError.localizedDescription)
    }

    private func dismissPresentedWebView() {
        let host = navigationController ?? self
        host.dismiss(animated: true)
    }
}
