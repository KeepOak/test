import UIKit
import UniformTypeIdentifiers

/// "Send to Branch" in the iOS share sheet. It reads what was shared, and sends it straight to the
/// paired Branch with the key the app keeps in the shared Keychain group. While the "share" switch is
/// off it only says how to turn it on; "when needed" asks for a note first; "on" sends at once.
/// The layout follows OpenClaw's share extension (MIT, see THIRD_PARTY_NOTICES.md).
final class ShareViewController: UIViewController {
    private static let maxSharedBytes = 20 * 1024 * 1024
    private let titleLabel = UILabel()
    private let status = UILabel()
    private let note = UITextView()
    private let send = UIButton(type: .system)
    private let cancel = UIButton(type: .system)
    private var texts: [String] = []
    private var files: [(name: String, type: String, data: Data)] = []
    private var remainingFileBytes = ShareViewController.maxSharedBytes

    override func viewDidLoad() {
        super.viewDidLoad()
        buildLayout()
        let position = BranchSwitches.position("share")
        guard position != "off" else { return finish(BranchNative.word("phone.share.off", "Sending from the share sheet is off."), after: 3) }
        guard BranchKeychain.load() != nil else { return finish(BranchNative.word("phone.share.notPaired", "Connect Branch first."), after: 3) }
        Task {
            await readItems()
            if position == "on" { await deliver() } else { note.isHidden = false; send.isHidden = false; note.becomeFirstResponder() }
        }
    }

    private func buildLayout() {
        view.backgroundColor = BranchNative.dynamic("ground")
        titleLabel.text = BranchNative.word("phone.send.title", "Send to Branch")
        titleLabel.font = .preferredFont(forTextStyle: .title2)
        status.numberOfLines = 0
        status.font = .preferredFont(forTextStyle: .body)
        note.isHidden = true
        note.font = .preferredFont(forTextStyle: .body)
        note.layer.cornerRadius = 8
        note.layer.borderWidth = 1
        note.accessibilityLabel = BranchNative.word("phone.send.note", "A note to go with it")
        send.isHidden = true
        send.setTitle(BranchNative.word("phone.send.send", "Send to Branch"), for: .normal)
        send.addAction(UIAction { [weak self] _ in Task { await self?.deliver() } }, for: .touchUpInside)
        cancel.setTitle(BranchNative.word("phone.share.cancel", "Cancel"), for: .normal)
        cancel.addAction(UIAction { [weak self] _ in self?.close() }, for: .touchUpInside)
        paint()
        let stack = UIStackView(arrangedSubviews: [titleLabel, status, note, send, cancel])
        stack.axis = .vertical
        stack.spacing = 12
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 20),
            stack.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 16),
            stack.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -16),
            note.heightAnchor.constraint(equalToConstant: 120),
        ])
    }

    /// Colours from the theme table (branch-native.json), never typed here.
    private func paint() {
        let text = BranchNative.dynamic("text"), muted = BranchNative.dynamic("muted"), accent = BranchNative.dynamic("accent")
        titleLabel.textColor = text
        status.textColor = muted
        note.textColor = text
        note.backgroundColor = .clear
        note.layer.borderColor = BranchNative.dynamic("line").resolvedColor(with: traitCollection).cgColor
        send.backgroundColor = accent
        send.setTitleColor(BranchNative.dynamic("onAccent"), for: .normal)
        send.layer.cornerRadius = 8
        cancel.setTitleColor(text, for: .normal)
    }

    private func readItems() async {
        let providers = (extensionContext?.inputItems as? [NSExtensionItem] ?? []).flatMap { $0.attachments ?? [] }
        for provider in providers {
            if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier),
               let url = try? await provider.loadItem(forTypeIdentifier: UTType.url.identifier) as? URL {
                if url.isFileURL, let file = Self.boundedFile(url, name: url.lastPathComponent,
                                                              type: mimeType(url), limit: remainingFileBytes) { keep(file) }
                else { texts.append(url.absoluteString) }
            } else if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier),
                      let text = try? await provider.loadItem(forTypeIdentifier: UTType.plainText.identifier) as? String {
                texts.append(text)
            } else if let type = provider.registeredTypeIdentifiers.first,
                      let file = await loadFile(provider, type: type, limit: remainingFileBytes) {
                keep(file)
            }
        }
    }

    private func keep(_ file: (name: String, type: String, data: Data)) {
        guard file.data.count <= remainingFileBytes else { return }
        remainingFileBytes -= file.data.count
        files.append(file)
    }

    private static func boundedFile(_ url: URL, name: String, type: String, limit: Int)
        -> (name: String, type: String, data: Data)? {
        let bound = min(maxSharedBytes, limit)
        guard let values = try? url.resourceValues(forKeys: [.fileSizeKey]), let size = values.fileSize,
              size >= 0, size <= min(maxSharedBytes, limit),
              let handle = try? FileHandle(forReadingFrom: url) else { return nil }
        defer { try? handle.close() }
        guard let data = try? handle.read(upToCount: bound + 1), data.count == size else { return nil }
        return (name, type, data)
    }

    private func loadFile(_ provider: NSItemProvider, type: String, limit: Int) async
        -> (name: String, type: String, data: Data)? {
        let suggested = provider.suggestedName
        return await withCheckedContinuation { done in
            provider.loadFileRepresentation(forTypeIdentifier: type) { url, _ in
                let uttype = UTType(type)
                let name = (suggested ?? "Shared file") + (uttype?.preferredFilenameExtension.map { ".\($0)" } ?? "")
                done.resume(returning: url.flatMap { Self.boundedFile($0, name: name,
                    type: uttype?.preferredMIMEType ?? "application/octet-stream", limit: limit) })
            }
        }
    }

    private func mimeType(_ url: URL) -> String {
        UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
    }

    private func deliver() async {
        guard let session = BranchKeychain.load() else { return }
        send.isEnabled = false
        status.text = BranchNative.word("phone.share.sending", "Sending…")
        do {
            for request in BranchSharePlan.requests(note: note.text ?? "", texts: texts, files: files) {
                let answer = try await BranchClient.send(session, method: "POST", path: request.path, json: request.body)
                if answer.status >= 400 { throw NSError(domain: "Branch", code: answer.status, userInfo: [NSLocalizedDescriptionKey: (answer.json as? [String: Any])?["error"] as? String ?? "\(answer.status)"]) }
            }
            finish(BranchNative.word("phone.share.sent", "Sent to Branch."), after: 1)
        } catch {
            status.text = BranchNative.word("phone.share.failed", "Not sent: {reason}", ["reason": error.localizedDescription])
            send.isEnabled = true
            send.isHidden = false
        }
    }

    private func finish(_ message: String, after seconds: Double) {
        status.text = message
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds) { [weak self] in self?.close() }
    }

    private func close() {
        extensionContext?.completeRequest(returningItems: nil)
    }
}
