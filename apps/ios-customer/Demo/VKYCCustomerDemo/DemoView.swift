import SuperbankVKYC
import SwiftUI
import UIKit

/// Local Next.js customer app. Paste a full join URL over this origin.
private let localCustomerOrigin = "http://127.0.0.1:3002"

struct DemoView: View {
    @State private var joinURL = ""
    @State private var warning: String?
    @State private var events: [String] = []

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Superbank Video KYC")
                .font(.title2.bold())
            Text("Customer app defaults to \(localCustomerOrigin) until a public join URL exists. Paste the full join URL from the agent desk.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
            TextField("\(localCustomerOrigin)/join/<token>", text: $joinURL)
                .textInputAutocapitalization(.never)
                .disableAutocorrection(true)
                .keyboardType(.URL)
                .textContentType(.URL)
                .textFieldStyle(.roundedBorder)
                .accessibilityIdentifier("join-url")
            if let warning {
                Text(warning)
                    .font(.footnote)
                    .foregroundStyle(.red)
                    .accessibilityIdentifier("join-url-warning")
            }
            Button("Open VKYC") {
                open()
            }
            .buttonStyle(.borderedProminent)
            .frame(maxWidth: .infinity)
            .accessibilityIdentifier("open-vkyc")
            if events.isEmpty {
                Text("Callbacks show up here: Connected, Ended, Error.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            } else {
                Text(events.joined(separator: "\n"))
                    .font(.footnote)
                    .accessibilityIdentifier("vkyc-events")
            }
            Spacer()
        }
        .padding()
    }

    private func open() {
        let trimmed = joinURL.trimmingCharacters(in: .whitespacesAndNewlines)
        if let message = VKYCCustomer.rejectionMessage(for: trimmed) {
            warning = message
            return
        }
        warning = nil
        guard let presenter = UIApplication.topPresenter() else {
            note("Error: Could not find a screen to present from.")
            return
        }
        note("Opening")
        VKYCCustomer.start(
            joinURL: trimmed,
            from: presenter,
            onConnected: { note("Connected") },
            onEnded: { note("Ended") },
            onError: { message in note("Error: \(message)") }
        )
    }

    private func note(_ line: String) {
        events.append(line)
    }
}

private extension UIApplication {
    static func topPresenter() -> UIViewController? {
        let scenes = shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        let scene = scenes.first { $0.activationState == .foregroundActive } ?? scenes.first
        let root = scene?.windows.first { $0.isKeyWindow }?.rootViewController ?? scene?.windows.first?.rootViewController
        return root?.deepestPresenter()
    }
}

private extension UIViewController {
    func deepestPresenter() -> UIViewController {
        if let presented = presentedViewController {
            return presented.deepestPresenter()
        }
        if let navigation = self as? UINavigationController, let visible = navigation.visibleViewController {
            return visible.deepestPresenter()
        }
        if let tab = self as? UITabBarController, let selected = tab.selectedViewController {
            return selected.deepestPresenter()
        }
        return self
    }
}
