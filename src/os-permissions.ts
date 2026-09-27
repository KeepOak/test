import { execFile } from "node:child_process";
import { join } from "node:path";
import { macLoginItemsLink } from "./install/autostart.js";

/**
 * What Windows itself will let this app do. Branch has always had its own switches — "Allow the
 * assistant to use my screen and keyboard", "Let Branch look up passwords" — but Windows has
 * switches of its own, under Settings > Privacy & security, and a refusal there looks to a program
 * like nothing happening at all. Asking first means the person is told what to turn on, in one plain
 * sentence with the button that opens the right page, instead of watching something quietly fail.
 *
 * Nothing here asks Windows for a permission: only the person can grant one. It reads what they
 * have already chosen, and for the screen it tries the smallest possible action to find out.
 *
 * A Mac keeps the same kind of switches under System Settings > Privacy & Security, plus one more,
 * Accessibility, for pressing keys and clicking in other apps. Merely asking a Mac about one of them
 * can put a question on the screen, so on a Mac nothing is asked at all: each switch is explained,
 * with the link that opens its page. On Linux the desktop session decides what works, so that is
 * what is read and said.
 */
export const osCapabilities = ["microphone", "camera", "screen"] as const;
export type OsCapability = (typeof osCapabilities)[number] | "accessibility";

/** The switches worth showing on this kind of computer. */
export function capabilitiesFor(platform: string = process.platform): OsCapability[] {
  return platform === "darwin" ? [...osCapabilities, "accessibility"] : [...osCapabilities];
}

/** What the computer says: yes, no, or nothing this computer can answer. */
export type ConsentState = "allowed" | "refused" | "unknown";
export type ConsentReader = (capability: OsCapability) => Promise<ConsentState>;

export interface CapabilityCheck {
  capability: OsCapability;
  state: ConsentState;
  /** True unless the computer said no outright; "unknown" never stops anything. */
  allowed: boolean;
  /** One plain sentence for the person when it said no, or "" when there is nothing to say. */
  message: string;
  /** The settings page that turns it on, or "" when there is no page for it. */
  settingsLink: string;
  /** What the switch is for and where it lives, always filled in, for the permissions page. */
  explanation: string;
}

/** The pages of Windows Settings that turn each one on (parity B5: the desktop app opens these by exact address). */
export const windowsSettingsLinks: Record<string, string> = {
  microphone: "ms-settings:privacy-microphone",
  camera: "ms-settings:privacy-webcam",
  screen: "ms-settings:privacy-graphicscaptureprogrammatic",
};
const settingsLinks = windowsSettingsLinks;
/**
 * Parity B5: where each computer keeps whether an app may show notifications. Branch reads that choice in the window
 * itself (the page's Notification permission); this is only the page that changes it.
 */
export const notificationSettingsLinks: Record<string, string> = {
  win32: "ms-settings:notifications",
  darwin: "x-apple.systempreferences:com.apple.preference.notifications",
};
/** Add or remove programs, where Windows removes a program (Settings › Remove Branch opens it in the desktop app). */
export const windowsAppsLink = "ms-settings:appsfeatures";
/**
 * mac2/desktop-ui: every page of the computer's own settings the desktop window may open, each matched exactly, so
 * nothing else under ms-settings: or x-apple.systempreferences: can be opened from the window. On a Mac the four
 * permission pages and Login Items; on Windows the three Privacy pages and Add or remove programs; on both the
 * notifications page.
 */
export function openableSettingsPages(platform: string): Set<string> {
  const own = platform === "darwin" ? [...Object.values(macSettingsLinks), macLoginItemsLink]
    : platform === "win32" ? [...Object.values(windowsSettingsLinks), windowsAppsLink] : [];
  const notifications = notificationSettingsLinks[platform];
  return new Set(notifications ? [...own, notifications] : own);
}
const refusals: Record<string, string> = {
  microphone: "Windows is not letting Branch use the microphone, so nothing you say can be written down. Open Windows Settings, Privacy & security, Microphone, and turn it on for this app.",
  camera: "Windows is not letting Branch use the camera. Open Windows Settings, Privacy & security, Camera, and turn it on for this app.",
  screen: "Windows is not letting Branch take hold of other programs' windows, so it cannot use your screen and keyboard. Open Windows Settings, Privacy & security, and turn screen access on for this app.",
};
const windowsExplanations: Record<string, string> = {
  microphone: "Lets Branch hear what you say. It is under Windows Settings, Privacy & security, Microphone.",
  camera: "Lets Branch use the camera. It is under Windows Settings, Privacy & security, Camera.",
  screen: "Lets Branch see and use other programs' windows. It is under Windows Settings, Privacy & security.",
};

/** The pages of System Settings on a Mac, opened by these links. */
export const macSettingsLinks: Record<OsCapability, string> = {
  microphone: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
  camera: "x-apple.systempreferences:com.apple.preference.security?Privacy_Camera",
  screen: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
  accessibility: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
};
const macPages: Record<OsCapability, { page: string; purpose: string }> = {
  microphone: { page: "Microphone", purpose: "hear what you say" },
  camera: { page: "Camera", purpose: "use the camera" },
  screen: { page: "Screen & System Audio Recording", purpose: "take a picture of a window or of the whole screen" },
  accessibility: { page: "Accessibility", purpose: "press keys and click in other apps for you" },
};

/** What one reading means on a Mac. The link is offered unless the Mac has said yes. */
function macCheck(capability: OsCapability, state: ConsentState): CapabilityCheck {
  const { page, purpose } = macPages[capability];
  const where = `System Settings, Privacy & Security, ${page}`;
  const allowed = state !== "refused";
  return {
    capability, state, allowed,
    message: allowed ? "" : `Your Mac is not letting Branch ${purpose}. Open ${where}, and turn Branch Agent on.`,
    settingsLink: state === "allowed" ? "" : macSettingsLinks[capability],
    explanation: `Lets Branch ${purpose}. Your Mac asks the first time it is needed; you can change it any time in ${where}.`,
  };
}

/** Which kind of desktop session this Linux computer is running, read from what the session sets. */
export type LinuxSession = "x11" | "wayland" | "none";
export function linuxSession(env: NodeJS.ProcessEnv = process.env): LinuxSession {
  if (env.XDG_SESSION_TYPE === "wayland" || env.WAYLAND_DISPLAY) return "wayland";
  if (env.XDG_SESSION_TYPE === "x11" || env.DISPLAY) return "x11";
  return "none";
}
const linuxScreen: Record<LinuxSession, string> = {
  x11: "Your desktop session is X11, so Branch can use other programs' windows once xdotool is installed.",
  wayland: "Your desktop session is Wayland, which does not let one program type or click into another's windows. To use your screen and keyboard, sign in with an X11 session (often called \"on Xorg\" on the sign-in screen).",
  none: "There is no desktop session here, so there is no screen for Branch to use.",
};
const linuxOther: Record<string, string> = {
  microphone: "Linux has no single switch for the microphone. If Branch hears nothing, check your desktop's sound settings and that the microphone is not muted.",
  camera: "Linux has no single switch for the camera. If Branch sees nothing, check that the camera is connected and that no other program is holding it.",
  accessibility: "Linux has no separate switch for this; the desktop session decides.",
};

/** What one reading means on Linux, where the session, not a switch, is usually the answer. */
function linuxCheck(capability: OsCapability, state: ConsentState, env: NodeJS.ProcessEnv): CapabilityCheck {
  const allowed = state !== "refused";
  const explanation = capability === "screen" ? linuxScreen[linuxSession(env)] : linuxOther[capability]!;
  return { capability, state, allowed, message: allowed ? "" : explanation, settingsLink: "", explanation };
}

/** What one reading means for the person: whether to go ahead, and what to tell them if not. */
export function capabilityCheck(
  capability: OsCapability, state: ConsentState,
  platform: string = process.platform, env: NodeJS.ProcessEnv = process.env,
): CapabilityCheck {
  if (platform === "darwin") return macCheck(capability, state);
  if (platform === "linux") return linuxCheck(capability, state, env);
  const allowed = state !== "refused";
  return {
    capability, state, allowed,
    message: allowed ? "" : refusals[capability] ?? "",
    settingsLink: allowed ? "" : settingsLinks[capability] ?? "",
    explanation: windowsExplanations[capability] ?? "",
  };
}

/** Where Windows keeps what the person chose for the microphone and the camera. */
const consentKeys: Partial<Record<OsCapability, string>> = {
  microphone: "Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone",
  camera: "Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\webcam",
};

/** Reads one registry value; anything at all going wrong is simply "nothing this computer can say". */
function registryValue(root: string, key: string, name: string): Promise<string | null> {
  const system = process.env.SystemRoot;
  if (process.platform !== "win32" || !system) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(join(system, "System32", "reg.exe"), ["query", `${root}\\${key}`, "/v", name],
      { timeout: 4000, windowsHide: true, shell: false, maxBuffer: 16384, env: { SystemRoot: system, PATH: "" } },
      (error, stdout) => {
        if (error) return resolve(null);
        const match = /\bREG_SZ\s+(\S+)/i.exec(String(stdout));
        resolve(match ? match[1]! : null);
      });
  });
}

/**
 * What the person chose for one capability. The machine-wide setting is read first because a
 * refusal there cannot be overridden per user; then the user's own. "Deny" is the only answer that
 * stops anything: a key that is not there means this build of Windows keeps no such setting.
 */
export const windowsConsent: ConsentReader = async (capability) => {
  const key = consentKeys[capability];
  if (!key) return "unknown";
  for (const root of ["HKLM", "HKCU"]) {
    const value = await registryValue(root, key, "Value");
    if (value?.toLowerCase() === "deny") return "refused";
    if (value?.toLowerCase() === "allow" && root === "HKCU") return "allowed";
  }
  return "unknown";
};

/**
 * Windows keeps no switch for taking hold of another program's window, so the only way to find out
 * is to try the smallest thing screen control does — ask for the list of open windows. A reader
 * built this way answers "screen" from that probe and leaves the other two to the registry.
 */
export function probeReader(
  probe: () => Promise<unknown>, fallback: ConsentReader = consentReaderFor(process.platform),
  platform: string = process.platform,
): ConsentReader {
  return async (capability) => {
    // A Mac is never probed: asking another app about its windows is what puts the question up.
    if (capability !== "screen" || platform === "darwin") return fallback(capability);
    // On Linux a session with no way in says so before anything is tried.
    if (platform === "linux" && (await fallback(capability)) === "refused") return "refused";
    return probe().then((): ConsentState => "allowed").catch((error): ConsentState => probeFailure(error));
  };
}

/** A Mac is not asked, because asking can put a question on the screen; the page explains instead. */
export const macConsent: ConsentReader = async () => "unknown";

/** On Linux the screen depends on the session: none, or Wayland, means another program's window cannot be used. */
export function linuxConsent(env: NodeJS.ProcessEnv = process.env): ConsentReader {
  return async (capability) => {
    if (capability !== "screen") return "unknown";
    return linuxSession(env) === "x11" ? "unknown" : "refused";
  };
}

/** The way this kind of computer is asked. */
export function consentReaderFor(platform: string, env: NodeJS.ProcessEnv = process.env): ConsentReader {
  if (platform === "darwin") return macConsent;
  if (platform === "linux") return linuxConsent(env);
  return windowsConsent;
}
/**
 * Only a refusal counts as a refusal. A probe that times out on a cold computer, or that cannot find
 * what it needs, says nothing this computer can answer — it must never be read as "Windows said no"
 * and stop screen control outright.
 */
const deniedWords = /\b(access is denied|permission|not permitted|unauthori[sz]ed|elevation|privilege)\b/i;
export function probeFailure(error: unknown): ConsentState {
  const said = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  return deniedWords.test(said) ? "refused" : "unknown";
}

export class OsPermissions {
  /** Readings are kept for a short while: the person does not change these between two clicks. */
  private readonly cached = new Map<OsCapability, { at: number; state: ConsentState }>();
  now: () => number = () => Date.now();
  constructor(
    private readonly read: ConsentReader = consentReaderFor(process.platform),
    private readonly holdMs = 30_000,
    private readonly platform: string = process.platform,
  ) {}

  /** What Windows says about one capability right now, with the sentence to show if it says no. */
  async check(capability: OsCapability): Promise<CapabilityCheck> {
    const kept = this.cached.get(capability);
    if (kept && this.now() - kept.at < this.holdMs) return capabilityCheck(capability, kept.state, this.platform);
    const state = await this.read(capability).catch((): ConsentState => "unknown");
    this.cached.set(capability, { at: this.now(), state });
    return capabilityCheck(capability, state, this.platform);
  }
  /** Every capability at once, for the settings screen. */
  async all(): Promise<CapabilityCheck[]> {
    return Promise.all(capabilitiesFor(this.platform).map((capability) => this.check(capability)));
  }
  /** Forgets what was read, so a person who has just changed a Windows switch is believed. */
  forget(): void { this.cached.clear(); }
}
