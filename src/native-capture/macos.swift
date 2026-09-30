// Prepared helper source; macOS 14+ only. ScreenCaptureKit filters before pixels enter Branch.
import Foundation
import Darwin
import ScreenCaptureKit
import ImageIO
import UniformTypeIdentifiers

struct Bounds: Codable, Equatable { let x: Int; let y: Int; let w: Int; let h: Int }
struct Window: Codable, Equatable { let id: String; let pid: Int; let title: String; let program: String; let bounds: Bounds }
struct Display: Codable, Equatable { let id: String; let bounds: Bounds }
struct Target: Codable, Equatable { let kind: String; let window: Window?; let display: Display? }
struct Request: Decodable { let action: String; let target: Target?; let exclude: [Window]?; let outPath: String? }
struct Reply: Encodable {
    let `protocol` = 1; let platform = "darwin"; let windows: [Window]; let displays: [Display]
    var before: [Window]?; var width: Int?; var height: Int?; var method: String?; var target: Target?; var exclude: [Window]?
}
enum Refusal: Error { case message(String) }
func box(_ frame: CGRect) -> Bounds { Bounds(x: Int(frame.origin.x.rounded()), y: Int(frame.origin.y.rounded()), w: Int(frame.width.rounded()), h: Int(frame.height.rounded())) }
func describe(_ window: SCWindow) -> Window? {
    guard window.isOnScreen, window.windowLayer == 0, let app = window.owningApplication else { return nil }
    let bounds = box(window.frame)
    guard bounds.w > 0, bounds.h > 0, bounds.w <= 8192, bounds.h <= 8192 else { return nil }
    return Window(id: String(window.windowID), pid: Int(app.processID), title: String((window.title ?? "").prefix(1000)), program: String(app.applicationName.prefix(500)), bounds: bounds)
}
@available(macOS 14.0, *)
func content() async throws -> SCShareableContent { try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true) }
@available(macOS 14.0, *)
func exact(_ wanted: Window, in source: SCShareableContent) throws -> SCWindow {
    guard let current = source.windows.first(where: { String($0.windowID) == wanted.id }), describe(current) == wanted else { throw Refusal.message("Window closed, moved, resized or changed identity. Discover again.") }
    return current
}
@available(macOS 14.0, *)
func capture(_ request: Request, _ source: SCShareableContent) async throws -> Reply {
    guard let target = request.target, let excluded = request.exclude, excluded.count <= 32, let path = request.outPath, path.hasPrefix("/"), path.hasSuffix(".png") else { throw Refusal.message("Missing exact capture terms.") }
    let filter: SCContentFilter; let dimensions: Bounds
    if target.kind == "window", let window = target.window, target.display == nil, excluded.isEmpty {
        filter = SCContentFilter(desktopIndependentWindow: try exact(window, in: source)); dimensions = window.bounds
    } else if target.kind == "display", let display = target.display, target.window == nil,
              let found = source.displays.first(where: { String($0.displayID) == display.id }), box(found.frame) == display.bounds {
        let omit = try excluded.map { try exact($0, in: source) }
        filter = SCContentFilter(display: found, excludingWindows: omit); dimensions = display.bounds
    } else { throw Refusal.message("Unsupported or changed native target. No rectangle fallback.") }
    guard dimensions.w > 0, dimensions.h > 0, dimensions.w <= 8192, dimensions.h <= 8192, dimensions.w * dimensions.h <= 16_000_000 else { throw Refusal.message("Capture pixel limit exceeded.") }
    let config = SCStreamConfiguration(); config.width = dimensions.w; config.height = dimensions.h
    config.showsCursor = false; config.capturesAudio = false
    let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
    let after = try await content()
    if let selected = target.window { _ = try exact(selected, in: after) }
    if let selected = target.display { guard after.displays.contains(where: { String($0.displayID) == selected.id && box($0.frame) == selected.bounds }) else { throw Refusal.message("Display changed during capture.") } }
    for window in excluded { _ = try exact(window, in: after) }
    guard let destination = CGImageDestinationCreateWithURL(URL(fileURLWithPath: path) as CFURL, UTType.png.identifier as CFString, 1, nil) else { throw Refusal.message("Cannot write private PNG.") }
    CGImageDestinationAddImage(destination, image, nil)
    guard CGImageDestinationFinalize(destination) else { throw Refusal.message("PNG output failed.") }
    var reply = Reply(windows: after.windows.compactMap(describe), displays: after.displays.map { Display(id: String($0.displayID), bounds: box($0.frame)) })
    reply.before = source.windows.compactMap(describe); reply.width = image.width; reply.height = image.height
    reply.method = target.kind == "window" ? "native-window" : "native-filter"; reply.target = target; reply.exclude = excluded
    return reply
}
@main struct NativeWindowCapture {
    static func main() async {
        do {
            guard #available(macOS 14.0, *) else { throw Refusal.message("ScreenCaptureKit screenshots require macOS 14 or newer.") }
            guard CommandLine.arguments.count == 2, CommandLine.arguments[1].utf8.count <= 100_000 else { throw Refusal.message("Bounded JSON request required.") }
            let request = try JSONDecoder().decode(Request.self, from: Data(CommandLine.arguments[1].utf8))
            let source = try await content(); guard source.windows.count <= 2048, source.displays.count <= 32 else { throw Refusal.message("Discovery bound exceeded.") }
            let reply: Reply
            if request.action == "list" { reply = Reply(windows: source.windows.compactMap(describe), displays: source.displays.map { Display(id: String($0.displayID), bounds: box($0.frame)) }) }
            else if request.action == "capture" { reply = try await capture(request, source) }
            else { throw Refusal.message("Unknown native capture action.") }
            FileHandle.standardOutput.write(try JSONEncoder().encode(reply))
        } catch { FileHandle.standardError.write(Data("Native capture refused: \(error)".utf8)); exit(1) }
    }
}