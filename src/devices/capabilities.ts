import { z } from "zod";

/**
 * mac7/nodes: what one of the owner's devices can be allowed to do for Branch.
 *
 * The idea is OpenClaw's "nodes" (MIT, see THIRD_PARTY_NOTICES.md): a device dials out to the
 * computer running Branch and offers a short list of things it can do. Branch's version differs in
 * three ways that matter to an owner who is not technical:
 *
 *   - every capability has its own switch on every device, and every switch starts off (the
 *     per-device, per-feature list is the idea KDE Connect made familiar; nothing of its code is used);
 *   - a capability that captures something or runs something asks the owner first even when no
 *     approval rule has been written (see `asksUnlessRuled`, read by src/policy.ts);
 *   - the operating system's own permission prompt only ever appears on the device, and only at
 *     the moment the owner switches that capability on there.
 */
export const capabilities = [
  "camera", "screen", "location", "notify", "clipboard-read", "clipboard-write", "open-url",
  "run", "files", "speak", "listen", "canvas",
  // computer-control: the owner uses the device's screen and keyboard from Branch's computer view. No task tool.
  "input",
] as const;
export type Capability = (typeof capabilities)[number];
export const CapabilitySchema = z.enum(capabilities);

/** How much a capability can do, which decides its permission and whether it asks by default. */
export type CapabilityKind = "capture" | "act" | "run";
export type DevicePlatform = "darwin" | "linux" | "win32" | "ios" | "android";
export const devicePlatforms: readonly DevicePlatform[] = ["darwin", "linux", "win32", "ios", "android"];

export interface CapabilityInfo {
  kind: CapabilityKind;
  /** The tool the model calls. */
  tool: string;
  /** The owner's words, for the card and for a refusal. */
  label: string;
  /** Where Branch knows how to do it. A device only offers what its own platform can. */
  platforms: readonly DevicePlatform[];
  /** Only the owner uses it, from Branch's own window; no tool is registered for tasks. */
  ownerOnly?: true;
}

const computers: readonly DevicePlatform[] = ["darwin", "linux", "win32"];
const everywhere: readonly DevicePlatform[] = devicePlatforms;

export const capabilityInfo: Record<Capability, CapabilityInfo> = {
  camera: { kind: "capture", tool: "device.camera", label: "Take a photo with the camera", platforms: ["darwin", "linux", "ios", "android"] },
  screen: { kind: "capture", tool: "device.screen", label: "Take a picture of the screen", platforms: computers },
  location: { kind: "capture", tool: "device.location", label: "Say where the device is", platforms: ["linux", "ios", "android"] },
  notify: { kind: "act", tool: "device.notify", label: "Show a notification", platforms: computers },
  "clipboard-read": { kind: "capture", tool: "device.clipboard", label: "Read what was copied", platforms: computers },
  "clipboard-write": { kind: "act", tool: "device.clipboard", label: "Put text on the clipboard", platforms: computers },
  "open-url": { kind: "act", tool: "device.open", label: "Open a web page", platforms: everywhere },
  run: { kind: "run", tool: "device.run", label: "Run a command inside a walled folder", platforms: ["darwin", "linux"] },
  files: { kind: "capture", tool: "device.files", label: "Read and list files in one chosen folder", platforms: computers },
  speak: { kind: "act", tool: "device.speak", label: "Say something out loud", platforms: everywhere },
  listen: { kind: "capture", tool: "device.listen", label: "Listen for a few seconds", platforms: ["darwin", "linux", "ios", "android"] },
  canvas: { kind: "act", tool: "device.canvas", label: "Show a page on the screen", platforms: ["ios", "android"] },
  input: { kind: "act", tool: "device.input", label: "Let you use its screen and keyboard from Branch", platforms: ["linux", "win32"], ownerOnly: true },
};

/** The permission each kind of capability needs; only `devices.read` is look-only. */
export const devicePermissions: Record<CapabilityKind | "list", string> = {
  list: "devices.read", capture: "devices.capture", act: "devices.act", run: "devices.run",
};

/** Every tool this feature registers, so the catalog can leave them out while it is off. */
export const deviceTools: readonly string[] = ["device.list",
  ...new Set(Object.values(capabilityInfo).filter((info) => !info.ownerOnly).map((info) => info.tool))];

/**
 * Tools that ask the owner even when no approval rule mentions them: anything that captures a
 * picture, a sound, a place, a file or the clipboard, and anything that runs a command. A rule the
 * owner writes still decides first, so "always allow device.notify" or "never device.run" hold.
 */
const askingTools = new Set(Object.values(capabilityInfo)
  .filter((info) => info.kind === "capture" || info.kind === "run").map((info) => info.tool));
export const asksUnlessRuled = (tool: string): boolean => askingTools.has(tool);
/**
 * Integration review: a yes to a picture, a recording or a command is for that one call; it is not
 * remembered for the conversation unless the owner picks that when answering (or writes a rule).
 */
const everyTimeTools = new Set(["device.camera", "device.screen", "device.listen", "device.run"]);
export const asksEveryTime = (tool: string): boolean => everyTimeTools.has(tool);

/** What a platform can offer at all, before any switch is looked at. */
export function offeredOn(platform: DevicePlatform): Capability[] {
  return capabilities.filter((capability) => capabilityInfo[capability].platforms.includes(platform));
}

/** Largest picture, sound or file a device may send back, in bytes. */
export const mediaLimitBytes = 8 * 1024 * 1024;
/** Largest text a device may send back inside one answer. */
export const textLimitBytes = 64 * 1024;
