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
        // PH-03: lending this phone while the app's own page is open.
        "lendStart", "lendStop", "lendResult", "lendNotify", "lendOpen",
    ].map { CAPPluginMethod(name: $0, returnType: CAPPluginReturnPromise) }

    /// PH-03: the device socket. Asks reach the page only while the app's own page shows (never the owner's Branch).
    private lazy var lend = BranchLend(
        showing: { [weak self] in self?.appPageShowing() ?? false },
        state: { [weak self] connected, enabled in self?.notifyListeners("lendState", data: ["connected": connected, "enabled": enabled]) },
        invoke: { [weak self] ask in self?.notifyListeners("lendInvoke", data: ask) })

    override public func load() {
        // The socket closes while the app is off the screen and dials again when it is back, if the page still wants it.
        NotificationCenter.default.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
            self?.lend.pause()
        }
        NotificationCenter.default.addObserver(forName: UIApplication.willEnterForegroundNotification, object: nil, queue: .main) { [weak self] _ in
            self?.lend.resume()
        }
    }

    /// Whether the web view shows the app's own page, asked on the main thread.
    private func appPageShowing() -> Bool {
        var showing = false
        let check = {
            guard UIApplication.shared.applicationState == .active else { return }
            guard let shown = self.bridge?.webView?.url, let local = self.bridge?.config.localURL else { return }
            showing = shown.scheme == local.scheme && shown.host == local.host && shown.port == local.port
        }
        if Thread.isMainThread { check() } else { DispatchQueue.main.sync(execute: check) }
        return showing
    }

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
        lend.stop() // PH-03: Branch's page never sees an ask
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
            lend.pause()
            lend.resume()
        } catch {
            call.reject(BranchNative.word("phone.device.failed", "That did not work."))
        }
    }

    /// Throws this phone's key away; its signature stops working at once.
    @objc func deviceForget(_ call: CAPPluginCall) {
        guard fromAppPage(call) else { return }
        lend.stop()
        BranchNode.forget()
        call.resolve()
    }

    /// PH-03: dials the Branch this phone is lent to. It takes nothing from the page: the address and the key are this side's.
    @objc func lendStart(_ call: CAPPluginCall) {
        guard fromAppPage(call) else { return }
        lend.start()
        call.resolve()
    }

    @objc func lendStop(_ call: CAPPluginCall) {
        guard fromAppPage(call) else { return }
        lend.stop()
        call.resolve()
    }

    @objc func lendNotify(_ call: CAPPluginCall) {
        guard fromAppPage(call) else { return }
        guard BranchSwitches.position("notifications") != "off", let id = call.getString("id"),
              let title = call.getString("title"), !title.isEmpty, title.count <= 120,
              let body = call.getString("body"), body.count <= 1000 else { call.reject("Enable notifications and give bounded text."); return }
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            guard settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional else {
                call.reject("Enable system notifications on this phone first."); return
            }
            self.lend.performAction(id, capability: "notify") { allowed in
                guard allowed && BranchSwitches.position("notifications") != "off" else { call.reject("No current phone action request."); return }
                let content = UNMutableNotificationContent(); content.title = title; content.body = body
                UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: id, content: content, trigger: nil)) { error in
                    if let error { call.reject(error.localizedDescription) } else { call.resolve() }
                }
            }
        }
    }

    @objc func lendOpen(_ call: CAPPluginCall) {
        guard fromAppPage(call) else { return }
        guard let id = call.getString("id"), let raw = call.getString("url"), raw.count <= 2048,
              let url = URL(string: raw), url.scheme == "https", url.host != nil, url.user == nil, url.password == nil else {
            call.reject("Only HTTPS web addresses without credentials can be opened."); return
        }
        self.lend.performAction(id, capability: "open-url") { allowed in
            guard allowed else { call.reject("No current phone action request."); return }
            DispatchQueue.main.async {
                guard self.appPageShowing() else { call.reject("Open the phone app’s own page."); return }
                UIApplication.shared.open(url, options: [:]) { opened in
                    if opened { call.resolve() } else { call.reject("No app could open that page.") }
                }
            }
        }
    }

    /// The page's answer to one ask it was handed (BranchLend.answer checks it).
    @objc func lendResult(_ call: CAPPluginCall) {
        guard fromAppPage(call) else { return }
        lend.answer(call.options as? [String: Any] ?? [:]) { error in
            if let error { call.reject(error) } else { call.resolve() }
        }
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
    /// PH-03: what this phone does for Branch when lent, before the owner's refusals: the app's page takes photos,
    /// records and speaks, gets one foreground location fix, and delegates bounded notification/HTTPS opening here.
    static let offers = ["camera", "listen", "speak", "location", "notify", "open-url"]
    /// What this phone can promise never to do (apps/mobile/web/rules.js DEVICE_REFUSALS).
    static let refusals = ["camera", "screen", "listen", "run", "location", "notify", "open-url"]
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

    /// Only these characters, counted: `$` in a regular expression also matches before a final line break.
    static func only(_ text: String, _ allowed: String, count: Int) -> Bool {
        text.count == count && text.unicodeScalars.allSatisfy { allowed.unicodeScalars.contains($0) }
    }

    /// PH-03: exactly what the phone signs to prove itself on the device socket (src/devices/protocol.ts helloText).
    static func helloText(deviceId: String, nonce: String) -> String? {
        guard only(deviceId, "0123456789abcdef", count: 16),
              only(nonce, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_", count: 43) else { return nil }
        return "branch-node-hello-v1\n\(deviceId)\n\(nonce)"
    }

    /// PH-03: the hello's signature, over exactly `helloText` for this phone's own id. No other text is signed here.
    static func helloSignature(nonce: String) throws -> String {
        guard let record = load(), let id = record.nodeId, let text = helloText(deviceId: id, nonce: nonce),
              let signing = try? Curve25519.Signing.PrivateKey(rawRepresentation: record.seed) else { throw URLError(.userAuthenticationRequired) }
        return try signing.signature(for: Data(text.utf8)).base64EncodedString()
    }

    /// PH-03: the Branch this phone is lent to and its id there, the address checked again; or nil.
    static func lendTarget() -> (hub: String, id: String)? {
        guard let record = load(), let hub = record.hub, let id = record.nodeId, BranchRules.checkOrigin(hub) == hub,
              only(id, "0123456789abcdef", count: 16) else { return nil }
        return (hub, id)
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

/// PH-03: lending this phone to Branch while the app's own page is open. This side holds the device socket
/// (src/devices/hub.ts) and the key (BranchNode); the page does the one thing asked (apps/mobile/web/phone-node.js
/// serveLending) and hands its answer back. What is checked here, whatever the page or Branch says: the socket goes
/// only to the Branch in the Keychain record, checked again, and never follows a redirect; the only text signed is the
/// hello over this connection's own challenge; an ask reaches the page only when this phone offers it, the owner
/// switched it on, the phone's own "never" list allows it, it is in time and the app's own page shows, and is
/// otherwise answered "no" at once; each ask is answered once; a picture or sound is at most 8 MB.
final class BranchLend: NSObject, URLSessionTaskDelegate {
    static let mediaLimit = 8 * 1024 * 1024
    private let queue = DispatchQueue(label: "branch-lend")
    private let showing: () -> Bool
    private let state: (Bool, [String]) -> Void
    private let invoke: ([String: Any]) -> Void
    /// The page asked for lending and has not stopped it; a pause keeps it, so coming back dials again.
    private var desired = false
    private var wanted = false
    private var proven = false
    private var failures = 0
    private var session: URLSession?
    private var task: URLSessionWebSocketTask?
    private var enabled: [String] = []
    private var waiting: [String: Int64] = [:]
    private var waitingActions: [String: String] = [:]
    private var seen = Set<String>()

    init(showing: @escaping () -> Bool, state: @escaping (Bool, [String]) -> Void, invoke: @escaping ([String: Any]) -> Void) {
        self.showing = showing
        self.state = state
        self.invoke = invoke
    }

    static func offers(never: [String]) -> [String] { BranchNode.offers.filter { !never.contains($0) } }

    /// Why an ask is turned away before the page sees it, or nil when it may go to the page.
    static func refusal(_ capability: String, deadline: Any?, now: Int64, never: [String], enabled: [String], showing: Bool) -> String? {
        if never.contains(capability) { return "This phone never allows that." }
        if !BranchNode.offers.contains(capability) || !enabled.contains(capability) { return "That is switched off on this phone." }
        guard let due = (deadline as? NSNumber)?.int64Value, due >= now else { return "The request came too late." }
        if !showing { return "The Branch app is not open on this phone." }
        return nil
    }

    func start() {
        queue.async {
            self.desired = true
            self.connect()
        }
    }

    func stop() {
        queue.async {
            self.desired = false
            self.wanted = false
            self.close()
        }
    }

    func pause() {
        queue.async {
            self.wanted = false
            self.close()
        }
    }

    func resume() {
        queue.async { if self.desired { self.connect() } }
    }

    private func connect() {
        guard !wanted, BranchNode.lendTarget() != nil else { return }
        wanted = true
        failures = 0
        dial()
    }

    /// Never follows a redirect: the socket goes to the paired Branch and nowhere else.
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }

    private func dial() {
        guard wanted, let target = BranchNode.lendTarget(), var parts = URLComponents(string: target.hub) else { wanted = false; return }
        parts.scheme = parts.scheme == "https" ? "wss" : "ws"
        parts.path = "/api/devices/socket"
        parts.queryItems = [URLQueryItem(name: "device", value: target.id)]
        guard let url = parts.url else { wanted = false; return }
        let session = URLSession(configuration: .ephemeral, delegate: self, delegateQueue: nil)
        let task = session.webSocketTask(with: url)
        task.maximumMessageSize = 256 * 1024
        self.session = session
        self.task = task
        proven = false
        task.resume()
        receive(task, id: target.id)
    }

    private func receive(_ task: URLSessionWebSocketTask, id: String) {
        task.receive { [weak self] result in
            self?.queue.async {
                guard let self, self.task === task else { return }
                switch result {
                case .failure: self.ended()
                case .success(.string(let text)):
                    self.onMessage(text, id: id)
                    if self.task === task { self.receive(task, id: id) }
                case .success: self.receive(task, id: id)
                }
            }
        }
    }

    private func close() {
        task?.cancel(with: .normalClosure, reason: nil)
        task = nil
        session?.invalidateAndCancel()
        session = nil
        enabled = []
        waiting = [:]
        waitingActions = [:]
        state(false, [])
    }

    /// The line dropped or was refused: dialled again a little later each time; refused five times running (switched
    /// off on the computer, or the phone taken off), it waits for the next time the app opens.
    private func ended() {
        close()
        failures = proven ? 0 : failures + 1
        guard wanted, failures < 5 else { wanted = false; return }
        queue.asyncAfter(deadline: .now() + min(30, pow(2, Double(max(0, failures - 1))))) { [weak self] in
            guard let self, self.wanted, self.task == nil else { return }
            self.dial()
        }
    }

    private func send(_ value: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: value), let text = String(data: data, encoding: .utf8) else { return }
        task?.send(.string(text)) { _ in }
    }

    private func onMessage(_ text: String, id: String) {
        guard let message = (try? JSONSerialization.jsonObject(with: Data(text.utf8))) as? [String: Any] else { return }
        let never = BranchNode.load()?.never ?? []
        switch message["type"] as? String {
        case "challenge":
            guard let nonce = message["nonce"] as? String, BranchNode.helloText(deviceId: id, nonce: nonce) != nil,
                  let signature = try? BranchNode.helloSignature(nonce: nonce) else { ended(); return }
            send(["type": "hello", "version": 1, "deviceId": id, "platform": "ios", "offers": Self.offers(never: never), "signature": signature])
        case "welcome", "enabled":
            let switched = message["enabled"] as? [String] ?? []
            enabled = Self.offers(never: never).filter { switched.contains($0) }
            proven = true
            state(true, enabled)
        case "invoke":
            onInvoke(message, never: never)
        case "bye":
            // The owner took this phone off the list on the computer: it forgets the pairing, as phone-node.js does.
            if (message["reason"] as? String ?? "").contains("taken off") {
                desired = false
                wanted = false
                BranchNode.forget()
            }
        default: break
        }
    }

    private func onInvoke(_ ask: [String: Any], never: [String]) {
        guard let id = ask["id"] as? String, BranchNode.only(id, "0123456789abcdef", count: 32), seen.insert(id).inserted else { return }
        if seen.count > 500 { seen.removeAll() }
        let capability = ask["capability"] as? String ?? ""
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        if let why = Self.refusal(capability, deadline: ask["deadline"], now: now, never: never, enabled: enabled, showing: showing()) {
            send(["type": "result", "id": id, "ok": false, "error": why])
            return
        }
        let deadline = (ask["deadline"] as? NSNumber)?.int64Value ?? now
        waiting[id] = deadline
        waitingActions[id] = capability
        invoke(["id": id, "capability": capability, "args": ask["args"] as? [String: Any] ?? [:], "deadline": deadline])
    }

    /// Authorization remains tied to this connection's pending action and the phone's own refusal.
    func performAction(_ id: String, capability: String, done: @escaping (Bool) -> Void) {
        queue.async {
            let now = Int64(Date().timeIntervalSince1970 * 1000)
            let allowed = self.task != nil && self.proven && self.waitingActions[id] == capability
                && (self.waiting[id] ?? 0) >= now && self.enabled.contains(capability)
                && !BranchNode.refuses(capability) && self.showing()
            if allowed { self.waitingActions.removeValue(forKey: id) }
            done(allowed)
        }
    }
    /// The page's answer to one ask it was handed: answered once, a picture or sound as its own frame after it.
    func answer(_ from: [String: Any], done: @escaping (String?) -> Void) {
        queue.async {
            guard let id = from["id"] as? String, self.waiting.removeValue(forKey: id) != nil, let task = self.task else {
                done("That request is not waiting.")
                return
            }
            self.waitingActions.removeValue(forKey: id)
            let ok = from["ok"] as? Bool ?? false
            var result: [String: Any] = ["type": "result", "id": id, "ok": ok]
            var bytes: Data?
            if !ok {
                let error = from["error"] as? String ?? ""
                result["error"] = error.isEmpty ? "The phone could not do it." : String(error.prefix(2000))
            } else {
                if let value = from["value"] { result["value"] = value }
                if let media = from["media"] as? [String: Any] {
                    let mime = media["mime"] as? String ?? "", name = media["name"] as? String ?? ""
                    let kinds = mime.split(separator: "/", maxSplits: 1)
                    guard kinds.count == 2, ["image", "audio"].contains(String(kinds[0])),
                          BranchNode.only(String(kinds[1]), "abcdefghijklmnopqrstuvwxyz0123456789.+-", count: kinds[1].count), kinds[1].count <= 60,
                          let data = Data(base64Encoded: media["data"] as? String ?? ""), data.count <= Self.mediaLimit, name.count <= 120 else {
                        done("The picture or sound was larger than Branch accepts.")
                        return
                    }
                    var meta: [String: Any] = ["mime": mime, "bytes": data.count]
                    if !name.isEmpty { meta["name"] = name }
                    result["media"] = meta
                    bytes = data
                }
            }
            self.send(result)
            if let bytes { task.send(.data(Data(id.utf8) + bytes)) { _ in } }
            done(nil)
        }
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
