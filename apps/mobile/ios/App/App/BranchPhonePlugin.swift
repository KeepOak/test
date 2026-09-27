import Capacitor
import CryptoKit
import LocalAuthentication
import Security
import UIKit
import UserNotifications
import WebKit

/// The phone app's page talks to the phone through this plugin only (see apps/mobile/web/vault.js).
/// The key a Branch hands over stays here and in the Keychain; this page never receives it. (Opening
/// the owner's Branch writes the key and this phone's secret into that address's own session storage,
/// as public/pair.js does, because the window sends them itself.)
@objc(BranchPhonePlugin)
public class BranchPhonePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "BranchPhonePlugin"
    public let jsName = "BranchPhone"
    public let pluginMethods: [CAPPluginMethod] = [
        "pair", "session", "forget", "request", "getSwitches", "setSwitches", "switchesChanged", "unlock",
        "openBranch", "look", "notify", "lastSeen", "takeShared", "clearShared",
        // mac7/phone-pairing: lending this phone to Branch as one of the owner's devices.
        "deviceStatus", "devicePair", "deviceNever", "deviceForget",
        // mac7/residuals: the public half of this phone's key, for the check code both screens show.
        "deviceKey",
        // B6: connecting from the window's "Pair a phone" square: pairs as a device, then collects the phone's session.
        "phonePair",
    ].map { CAPPluginMethod(name: $0, returnType: CAPPluginReturnPromise) }

    /// Capacitor on iOS answers its bridge from whatever page the window shows, and the window also
    /// shows the owner's Branch. Every method here is for the phone app's own page only, so a call
    /// made while another page is showing is refused.
    private func fromAppPage(_ call: CAPPluginCall) -> Bool {
        var allowed = false
        let check = {
            guard let shown = self.bridge?.webView?.url, let local = self.bridge?.config.localURL else { return }
            allowed = shown.scheme == local.scheme && shown.host == local.host && shown.port == local.port
        }
        if Thread.isMainThread { check() } else { DispatchQueue.main.sync(execute: check) }
        if !allowed { call.reject("Only the phone app's own page may ask this.") }
        return allowed
    }

    @objc func pair(_ call: CAPPluginCall) {
        guard fromAppPage(call) else { return }
        guard let origin = BranchRules.checkOrigin(call.getString("origin") ?? ""), let id = call.getString("id"),
              let code = call.getString("code") else {
            call.resolve(["paired": false, "error": BranchNative.word("phone.error.plainHttp", "That address is refused.")])
            return
        }
        Task {
            do {
                let session = try await BranchClient.pair(origin: origin, id: id, code: code, name: call.getString("name") ?? "iPhone")
                try BranchKeychain.save(session)
                call.resolve(["paired": true])
            } catch {
                call.resolve(["paired": false, "error": error.localizedDescription])
            }
        }
    }

    @objc func session(_ call: CAPPluginCall) {
        guard fromAppPage(call) else { return }
        guard let session = BranchKeychain.load() else { call.resolve(["paired": false]); return }
        call.resolve(["paired": true, "origin": session.origin, "pairedAt": session.pairedAt, "deviceId": session.deviceId ?? ""])
    }

    @objc func forget(_ call: CAPPluginCall) {
        guard fromAppPage(call) else { return }
        BranchKeychain.forget()
        call.resolve()
    }

    @objc func request(_ call: CAPPluginCall) {
        guard fromAppPage(call) else { return }
        guard let session = BranchKeychain.load() else { call.reject("Not paired"); return }
        let method = call.getString("method") ?? "GET", path = call.getString("path") ?? ""
        let raw = call.getString("base64").flatMap { Data(base64Encoded: $0) }
        let body = call.getObject("body")
        Task {
            do {
                let answer = try await BranchClient.send(session, method: method, path: path, json: body, raw: raw,
                                                         contentType: call.getString("contentType"), query: call.getString("query"))
                call.resolve(["status": answer.status, "data": answer.json ?? NSNull()])
            } catch {
                call.reject(error.localizedDescription)
            }
        }
    }

    @objc func getSwitches(_ call: CAPPluginCall) {
        guard fromAppPage(call) else { return }
        call.resolve(["switches": BranchSwitches.all()])
    }

    @objc func setSwitches(_ call: CAPPluginCall) {
        guard fromAppPage(call) else { return }
        BranchSwitches.save(call.getObject("switches") as? [String: String] ?? [:])
        call.resolve()
    }

    /// Asks for what a switch now needs: permission to notify, the background check, push.
    @objc func switchesChanged(_ call: CAPPluginCall) {
        guard fromAppPage(call) else { return }
        let switches = BranchSwitches.all()
        if switches["notifications"] != "off" || switches["push"] != "off" {
            UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in }
        }
        BranchBackground.schedule()
        DispatchQueue.main.async { BranchBackground.updatePush() }
        call.resolve()
    }

    @objc func unlock(_ call: CAPPluginCall) {
        guard fromAppPage(call) else { return }
        let context = LAContext()
        var problem: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &problem) else {
            call.resolve(["unlocked": false, "reason": "unavailable"])
            return
        }
        context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: call.getString("reason") ?? "Branch") { unlocked, _ in
            call.resolve(["unlocked": unlocked])
        }
    }

    @objc func openBranch(_ call: CAPPluginCall) {
        guard fromAppPage(call) else { return }
        guard let session = BranchKeychain.load() else { call.reject("Not paired"); return }
        DispatchQueue.main.async {
            (self.bridge?.viewController as? BranchViewController)?.openBranch(session, at: call.getString("at") ?? "")
            call.resolve()
        }
    }

    @objc func look(_ call: CAPPluginCall) {
        guard fromAppPage(call) else { return }
        let saved = UserDefaults.standard.dictionary(forKey: "branch-look") ?? [:]
        call.resolve(["theme": saved["theme"] as? String ?? "slate", "mode": saved["mode"] as? String ?? "dark"])
    }

    @objc func notify(_ call: CAPPluginCall) {
        guard fromAppPage(call) else { return }
        BranchBackground.show(id: call.getString("id") ?? UUID().uuidString, title: call.getString("title") ?? "Branch",
                              body: call.getString("body") ?? "")
        call.resolve()
    }

    @objc func lastSeen(_ call: CAPPluginCall) {
        guard fromAppPage(call) else { return }
        call.resolve(["at": UserDefaults.standard.double(forKey: "branch-last-seen")])
    }

    /// iOS shares straight from the extension, so nothing waits here.
    @objc func takeShared(_ call: CAPPluginCall) {
        guard fromAppPage(call) else { return }
        call.resolve(["items": []])
    }
    @objc func clearShared(_ call: CAPPluginCall) {
        guard fromAppPage(call) else { return }
        call.resolve()
    }


    // ---- mac7/phone-pairing: this phone as one of the owner's devices (src/devices/) ----

    /// What the page may know: whether this phone is lent, to which computer, and its refusals.
    /// The phone's own key is never part of the answer.
    @objc func deviceStatus(_ call: CAPPluginCall) {
        guard fromAppPage(call) else { return }
        let node = BranchNode.load()
        call.resolve(["paired": node?.hub != nil && node?.nodeId != nil, "origin": node?.hub ?? "",
                      "pairedAt": node?.pairedAt ?? "", "nodeId": node?.nodeId ?? "",
                      "never": node?.never ?? [], "canSign": true])
    }

    /// mac7/residuals: this phone's public key (made now when it has none), so the page can show the
    /// check code the computer shows beside the request. The private half never leaves BranchNode.
    @objc func deviceKey(_ call: CAPPluginCall) {
        guard fromAppPage(call) else { return }
        do {
            call.resolve(["publicKey": try BranchNode.publicKey()])
        } catch {
            call.reject(BranchNative.word("phone.device.failed", "That did not work."))
        }
    }

    /// Answers the Devices card's invitation, then waits for the owner's yes on the computer.
    @objc func devicePair(_ call: CAPPluginCall) {
        guard fromAppPage(call) else { return }
        guard let origin = BranchRules.checkOrigin(call.getString("origin") ?? ""), let offer = call.getString("offer"),
              offer.range(of: "^[a-f0-9]{32}$", options: .regularExpression) != nil,
              let code = call.getString("code"), code.range(of: "^[0-9]{6}$", options: .regularExpression) != nil else {
            call.resolve(["paired": false, "error": BranchNative.word("phone.error.plainHttp", "That address is refused.")])
            return
        }
        let never = BranchNode.keep(never: call.getArray("never", String.self) ?? [])
        let name = (call.getString("name") ?? "").isEmpty ? UIDevice.current.name : call.getString("name")!
        Task {
            do {
                let nodeId = try await BranchNode.pair(origin: origin, offer: offer, code: code, name: String(name.prefix(80)), never: never)
                call.resolve(["paired": true, "nodeId": nodeId])
            } catch {
                call.resolve(["paired": false, "error": error.localizedDescription])
            }
        }
    }

    /// B6: connects to a Branch from the window's "Pair a phone" square. The phone answers the invitation as
    /// `devicePair` does and waits for the owner's yes, then collects its session once (POST /api/devices/pair/session,
    /// signed with the same key) and keeps it where `pair` keeps the session from a /pair invitation.
    @objc func phonePair(_ call: CAPPluginCall) {
        guard fromAppPage(call) else { return }
        guard let origin = BranchRules.checkOrigin(call.getString("origin") ?? ""), let offer = call.getString("offer"),
              offer.range(of: "^[a-f0-9]{32}$", options: .regularExpression) != nil,
              let code = call.getString("code"), code.range(of: "^[0-9]{6}$", options: .regularExpression) != nil else {
            call.resolve(["paired": false, "error": BranchNative.word("phone.error.plainHttp", "That address is refused.")])
            return
        }
        let name = (call.getString("name") ?? "").isEmpty ? UIDevice.current.name : call.getString("name")!
        Task {
            do {
                let session = try await BranchNode.pairPhone(origin: origin, offer: offer, code: code, name: String(name.prefix(80)))
                try BranchKeychain.save(session)
                call.resolve(["paired": true])
            } catch {
                call.resolve(["paired": false, "error": error.localizedDescription])
            }
        }
    }

    /// The phone's own refusals. They only take away, so no computer is asked about them.
    @objc func deviceNever(_ call: CAPPluginCall) {
        guard fromAppPage(call) else { return }
        do {
            call.resolve(["never": try BranchNode.setNever(call.getArray("never", String.self) ?? [])])
        } catch {
            call.reject(BranchNative.word("phone.device.failed", "That did not work."))
        }
    }

    /// Throws this phone's key away; its signature stops working at once.
    @objc func deviceForget(_ call: CAPPluginCall) {
        guard fromAppPage(call) else { return }
        BranchNode.forget()
        call.resolve()
    }

    /// Only the paired Branch opens inside the app; every other address goes to Safari as before.
    override public func shouldOverrideLoad(_ navigationAction: WKNavigationAction) -> NSNumber? {
        guard let paired = BranchKeychain.load()?.origin, BranchRules.origin(of: navigationAction.request.url) == paired else { return nil }
        return false
    }
}

/// mac7/phone-pairing: this phone as one of the owner's devices (src/devices/, docs/configuration.md
/// "Devices"). Everything secret is here and nowhere else:
///
///   - the phone's Ed25519 key is made here, kept in the **iOS Keychain** as a generic password item
///     with `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` (this phone only, never a backup, never
///     iCloud), and only ever used here. It is never handed to the app's page, never printed and never
///     sent: Branch is given the public half alone;
///   - pairing and the wait for the owner's yes happen here, because the app's page may only talk to
///     itself (its Content-Security-Policy). The address rule is `BranchRules.checkOrigin`, the same
///     one the page keeps: https anywhere, plain http only to this network or a Tailscale address.
enum BranchNode {
    /// What this phone could do for Branch, before the owner's refusals (apps/mobile/web/phone-node.js).
    static let offers = ["camera", "location", "open-url", "speak", "listen", "canvas"]
    /// What this phone can promise never to do (apps/mobile/web/rules.js DEVICE_REFUSALS).
    static let refusals = ["camera", "screen", "listen", "run"]
    /// The 12 bytes an Ed25519 public key carries in front of it as SPKI DER, which is what Branch takes.
    private static let spkiPrefix = Data([0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00])
    private static let service = "com.keepoak.branchagent.node"

    struct Record: Codable {
        var seed: Data
        var hub: String?
        var nodeId: String?
        var never: [String] = []
        var pairedAt: String?
    }

    static func keep(never: [String]) -> [String] { refusals.filter { never.contains($0) } }

    private static var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
         kSecAttrAccount as String: "this-phone"]
    }

    static func load() -> Record? {
        var lookup = query
        lookup[kSecReturnData as String] = true
        lookup[kSecMatchLimit as String] = kSecMatchLimitOne
        var found: CFTypeRef?
        guard SecItemCopyMatching(lookup as CFDictionary, &found) == errSecSuccess, let data = found as? Data else { return nil }
        return try? JSONDecoder().decode(Record.self, from: data)
    }

    private static func save(_ record: Record) throws {
        let data = try JSONEncoder().encode(record)
        SecItemDelete(query as CFDictionary)
        var item = query
        item[kSecValueData as String] = data
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(item as CFDictionary, nil)
        if status != errSecSuccess { throw NSError(domain: "BranchNode", code: Int(status)) }
    }

    static func forget() { SecItemDelete(query as CFDictionary) }

    /// Saved or refused, never pretended: the card only shows what the Keychain really holds.
    static func setNever(_ never: [String]) throws -> [String] {
        let kept = keep(never: never)
        if var record = load() {
            record.never = kept
            try save(record)
        } else {
            try save(Record(seed: Curve25519.Signing.PrivateKey().rawRepresentation, never: kept))
        }
        return kept
    }

    /// Whether this phone refuses a capability, for the web view's camera and microphone gate.
    static func refuses(_ capability: String) -> Bool { load()?.never.contains(capability) ?? false }

    /// The phone's key, made once and kept in the Keychain. The private half never leaves this file.
    private static func key() throws -> (Curve25519.Signing.PrivateKey, Record) {
        if let record = load(), let existing = try? Curve25519.Signing.PrivateKey(rawRepresentation: record.seed) {
            return (existing, record)
        }
        let made = Curve25519.Signing.PrivateKey()
        let record = Record(seed: made.rawRepresentation, never: load()?.never ?? [])
        try save(record)
        return (made, record)
    }

    /// mac7/residuals: the public half of the key, as it is sent with the invitation's number.
    static func publicKey() throws -> String {
        let (signing, _) = try key()
        return (spkiPrefix + signing.publicKey.rawRepresentation).base64EncodedString()
    }

    /// Never follows a redirect, as Android does not (BranchNode.java): the invitation, the six
    /// numbers and the signed ask go to the checked address and nowhere else.
    private final class NoRedirects: NSObject, URLSessionTaskDelegate {
        func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                        newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
            completionHandler(nil)
        }
    }
    private static let session = URLSession(configuration: .ephemeral, delegate: NoRedirects(), delegateQueue: nil)

    private static func post(_ address: String, _ body: [String: Any]) async throws -> [String: Any] {
        guard let url = URL(string: address) else { throw URLError(.badURL) }
        var request = URLRequest(url: url, timeoutInterval: 30)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, response) = try await session.data(for: request)
        let answer = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        guard (response as? HTTPURLResponse)?.statusCode == 200 else {
            throw NSError(domain: "BranchNode", code: 1, userInfo: [NSLocalizedDescriptionKey: answer["error"] as? String
                ?? BranchNative.word("phone.device.failed", "That did not work. Make a new invitation on the computer.")])
        }
        return answer
    }

    /// Sends the invitation's number and this phone's public key, then asks how it went until the
    /// owner answers. Each ask is signed, which is how Branch knows it is still this same phone.
    static func pair(origin: String, offer: String, code: String, name: String, never: [String]) async throws -> String {
        try await answerInvitation(origin: origin, offer: offer, code: code, name: name, never: never).nodeId
    }

    /// B6: the window's "Pair a phone" square. Answered and let in as `pair` is, then the phone's session is collected
    /// once, signed with this phone's key over "branch-phone-session-v1" and the request id (src/devices/book.ts).
    static func pairPhone(origin: String, offer: String, code: String, name: String) async throws -> BranchSession {
        let (_, requestId) = try await answerInvitation(origin: origin, offer: offer, code: code, name: name, never: load()?.never ?? [])
        let (signing, _) = try key()
        let proof = try signing.signature(for: Data("branch-phone-session-v1\n\(requestId)".utf8)).base64EncodedString()
        let body = try await post(origin + "/api/devices/pair/session", ["requestId": requestId, "signature": proof])
        guard let token = body["token"] as? String else { throw URLError(.badServerResponse) }
        return BranchSession(origin: origin, token: token, deviceId: body["deviceId"] as? String,
                             deviceKey: body["deviceKey"] as? String, pairedAt: ISO8601DateFormatter().string(from: Date()))
    }

    private static func answerInvitation(origin: String, offer: String, code: String, name: String, never: [String]) async throws
        -> (nodeId: String, requestId: String) {
        guard BranchRules.checkOrigin(origin) == origin else { throw URLError(.badURL) }
        let (signing, kept) = try key()
        let publicKey = (spkiPrefix + signing.publicKey.rawRepresentation).base64EncodedString()
        let sent = try await post(origin + "/api/devices/pair", ["offer": offer, "code": code, "name": name,
            "platform": "ios", "publicKey": publicKey, "offers": offers.filter { !never.contains($0) }])
        guard let requestId = sent["requestId"] as? String else { throw URLError(.badServerResponse) }
        let proof = try signing.signature(for: Data("branch-node-status-v1\n\(requestId)".utf8)).base64EncodedString()
        for _ in 0..<100 {
            let answer = try await post(origin + "/api/devices/pair/status", ["requestId": requestId, "signature": proof])
            if answer["status"] as? String == "approved", let nodeId = answer["deviceId"] as? String {
                try save(Record(seed: kept.seed, hub: origin, nodeId: nodeId, never: never,
                                pairedAt: ISO8601DateFormatter().string(from: Date())))
                return (nodeId, requestId)
            }
            if answer["status"] as? String == "refused" {
                throw NSError(domain: "BranchNode", code: 2, userInfo: [NSLocalizedDescriptionKey:
                    BranchNative.word("phone.node.refused", "The owner refused this phone.")])
            }
            try await Task.sleep(nanoseconds: 3_000_000_000)
        }
        throw NSError(domain: "BranchNode", code: 3, userInfo: [NSLocalizedDescriptionKey:
            BranchNative.word("phone.node.late", "Nobody answered in time. Make a new invitation and try again.")])
    }
}

/// mac7/phone-pairing review: Capacitor answers every page's camera and microphone request with a
/// yes, and the owner's Branch opens in this same web view. This stands in front of Capacitor's own
/// delegate and turns them away from any page but the app's own when this phone's "never allow" list
/// says so. The app's own page (the square-code scanner, "Hold to talk") is the owner's own hand, not
/// Branch asking. Everything else is handed to Capacitor's delegate untouched.
final class BranchMediaGuard: NSObject, WKUIDelegate {
    private let inner: WKUIDelegate
    private let local: URL?

    init(inner: WKUIDelegate, local: URL?) {
        self.inner = inner
        self.local = local
    }

    override func responds(to aSelector: Selector!) -> Bool {
        super.responds(to: aSelector) || inner.responds(to: aSelector)
    }

    override func forwardingTarget(for aSelector: Selector!) -> Any? {
        inner.responds(to: aSelector) ? inner : nil
    }

    /// The refusals a request would break: the camera, the microphone, or both.
    static func refused(_ type: WKMediaCaptureType, never: (String) -> Bool) -> Bool {
        switch type {
        case .camera: return never("camera")
        case .microphone: return never("listen")
        case .cameraAndMicrophone: return never("camera") || never("listen")
        @unknown default: return never("camera") || never("listen")
        }
    }

    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType,
                 decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        let ownPage = origin.protocol == local?.scheme && origin.host == local?.host
        if !ownPage && Self.refused(type, never: BranchNode.refuses) {
            decisionHandler(.deny)
            return
        }
        // What Capacitor itself answers; iOS still asks the owner the first time.
        decisionHandler(.grant)
    }
}
