import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, isAbsolute, join, sep } from "node:path";
import { z } from "zod";
import { audit } from "./audit.js";
import type { Store } from "./store.js";
import { mapStrings, type SecretScrubber } from "./vault.js";

/**
 * Reading a password out of the password manager the owner already has. Branch never keeps a copy:
 * a setting, a command or a tool argument holds a reference such as `secret://bitwarden/GitHub`,
 * and the real value is asked of Bitwarden's or 1Password's own command line at the moment it is
 * handed over, then taken straight back out of anything written down afterwards.
 *
 * It is off until the owner turns it on, and it can only read: nothing here ever writes to, unlocks
 * or signs in to a vault. A locked or missing vault is a plain refusal, never a guess.
 */
export const credentialServices = ["bitwarden", "1password"] as const;
export type CredentialService = (typeof credentialServices)[number];
const serviceNames: Record<CredentialService, string> = { bitwarden: "Bitwarden", "1password": "1Password" };

export const CredentialSettingsSchema = z.object({
  /** "Let Branch look up passwords in my password manager". Off until the owner turns it on. */
  enabled: z.boolean().default(false),
  /** Which password managers may be asked. Empty means none, even when the switch is on. */
  services: z.array(z.enum(credentialServices)).max(2).default([]),
  /** The Bitwarden command, when it is not simply `bw` on this computer's path. */
  bitwardenCommand: z.string().trim().max(500).default("bw"),
  /** The 1Password command, when it is not simply `op` on this computer's path. */
  onePasswordCommand: z.string().trim().max(500).default("op"),
  timeoutMs: z.number().int().min(500).max(30000).default(10000),
}).strict();
export type CredentialSettings = z.infer<typeof CredentialSettingsSchema>;
const settingsKey = "credential-services";

export function readCredentialSettings(store: Store, owner: string): CredentialSettings {
  const saved = CredentialSettingsSchema.safeParse(store.get("settings", owner, settingsKey)?.data ?? {});
  return saved.success ? saved.data : CredentialSettingsSchema.parse({});
}
/**
 * Q257: `{ choose }` is the window's "Password manager" choice. It puts that manager first and keeps any other the
 * owner already listed, with its command, so choosing one and then the other loses nothing. It never adds a manager
 * the owner did not choose, and never touches the on/off switch. `{ services }` still replaces the whole list, which
 * is how one is taken away; the two at once are refused.
 */
const ChoiceSchema = z.object({ choose: z.enum(credentialServices) }).strict();
function mergedInput(current: CredentialSettings, input: unknown): Record<string, unknown> {
  const body = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
  if (!("choose" in body)) return { ...current, ...body };
  const { choose } = ChoiceSchema.parse(body);
  return { ...current, services: [choose, ...current.services.filter((service) => service !== choose)] };
}
export function saveCredentialSettings(store: Store, owner: string, input: unknown): CredentialSettings {
  const current = readCredentialSettings(store, owner);
  const next = CredentialSettingsSchema.parse(mergedInput(current, input));
  store.save("settings", owner, settingsKey, { ...next });
  // Q257: written down like every other change to what Branch may reach: names only, never a command or a value.
  const commands = [next.bitwardenCommand !== current.bitwardenCommand ? "the Bitwarden command" : "",
    next.onePasswordCommand !== current.onePasswordCommand ? "the 1Password command" : ""].filter(Boolean);
  audit(store, owner, { action: "connection.changed", actor: owner, subject: "Password manager",
    reason: `${next.enabled ? "On" : "Off"}; asks ${next.services.map((service) => serviceNames[service]).join(", ") || "no password manager"}`
      + (commands.length ? `; changed ${commands.join(" and ")}` : ""), outcome: "saved" });
  return next;
}

/**
 * An item in a vault: letters, digits, spaces and the few punctuation marks item names use. A
 * 1Password reference may carry the vault and field too, as `Private/GitHub/password`.
 */
const referenceText = "secret://(bitwarden|1password)/([A-Za-z0-9][A-Za-z0-9 ._@/-]{0,79})";
const anyCredentialReference = new RegExp(referenceText, "g");
const wholeCredentialReference = new RegExp(`^${referenceText}$`);
export interface CredentialRef {
  service: CredentialService; item: string;
  /**
   * mac7/vault-autofill (R17-068): which field of the item to read. "password" is what every
   * `secret://` reference means and what every caller before this one asked for; "totp" is the
   * one-time code, and only the sign-in filling ever asks for it.
   */
  field?: "password" | "totp";
}
/** The reference text for one vault item, for settings screens and documentation. */
export const credentialReference = (service: CredentialService, item: string): string => `secret://${service}/${item}`;
export function parseCredentialReference(value: unknown): CredentialRef | null {
  const match = typeof value === "string" ? wholeCredentialReference.exec(value) : null;
  return match ? { service: match[1] as CredentialService, item: match[2]! } : null;
}
/** Every password-manager reference inside a value, so the runtime knows what to look up. */
export function collectCredentialReferences(value: unknown): CredentialRef[] {
  const found = new Map<string, CredentialRef>();
  mapStrings(value, (text) => {
    for (const match of text.matchAll(anyCredentialReference))
      found.set(`${match[1]}/${match[2]}`, { service: match[1] as CredentialService, item: match[2]! });
    return text;
  });
  return [...found.values()];
}

/** What one run of a password manager's command line came back with. */
export interface CliOutcome { code: number | null; stdout: string; stderr: string; missing?: boolean }
export type CliRunner = (executable: string, args: string[], timeoutMs: number) => Promise<CliOutcome>;

/**
 * The command and arguments that read one item, read-only in both password managers. Always an
 * array of arguments, never a line for a shell to take apart: an item name of the owner's with a
 * space or a quote in it is one argument, whatever it contains.
 */
export function commandFor(reference: CredentialRef, settings: CredentialSettings): { executable: string; args: string[] } {
  const field = reference.field ?? "password";
  if (reference.service === "bitwarden")
    return { executable: settings.bitwardenCommand || "bw", args: ["--nointeraction", "--raw", "get", field === "totp" ? "totp" : "password", reference.item] };
  // 1Password reads a field by its address, and a one-time code is not at a path Branch can guess.
  // It is refused here rather than quietly read as a password: a caller that asked for a code and
  // was handed a password would type the wrong secret into the wrong box.
  if (field === "totp")
    throw new Error("Branch reads a one-time code from Bitwarden only. 1Password holds it at an address only you know.");
  const path = reference.item.startsWith("op://") ? reference.item : `op://${reference.item}`;
  return { executable: settings.onePasswordCommand || "op", args: ["read", "--no-newline", path] };
}

/** Only what a password manager needs to find its own vault; nothing else of the owner's is passed on. */
const passedThrough = ["PATH", "PATHEXT", "SYSTEMROOT", "APPDATA", "LOCALAPPDATA", "USERPROFILE", "HOME", "TEMP", "TMP",
  "XDG_CONFIG_HOME", "BW_SESSION", "BITWARDENCLI_APPDATA_DIR", "OP_SERVICE_ACCOUNT_TOKEN", "OP_CONNECT_HOST", "OP_CONNECT_TOKEN"];
function vaultEnvironment(): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const name of passedThrough) if (process.env[name]) result[name] = process.env[name];
  return result;
}
/**
 * Where a bare command name lives on this computer. The whole path is worked out here, so the
 * password manager is always started by its full name and never looked up again as it is started:
 * Windows searches the folder Branch happens to be working in first, and a file left there called
 * `bw.exe` would otherwise be the thing asked for the owner's passwords. A name that is nowhere on
 * the path comes back as null, which is the plain "not on this computer" refusal rather than a guess.
 */
export function locateCommand(name: string, platform: string = process.platform, env: NodeJS.ProcessEnv = process.env): string | null {
  if (name.includes(sep) || name.includes("/") || isAbsolute(name)) return name;
  // On macOS and Linux a program has no extension, so the bare name (`bw`, `op`) is what is looked for.
  const extensions = platform === "win32" ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";") : [""];
  for (const folder of (env.PATH ?? "").split(platform === "win32" ? ";" : delimiter).filter(Boolean))
    for (const extension of extensions) {
      const candidate = join(folder, name + extension);
      try { accessSync(candidate, constants.X_OK); return candidate; } catch { /* keep looking */ }
    }
  return null;
}

/** Runs a password manager's command line directly: no shell, no window, and a hard time limit. */
export const spawnCli: CliRunner = (executable, args, timeoutMs) =>
  new Promise((resolve) => {
    // Nowhere on the path is the same answer as not installed, and it is given without starting
    // anything at all, so no folder Branch is working in can stand in for the password manager.
    const found = locateCommand(executable);
    if (!found) { resolve({ code: null, stdout: "", stderr: "", missing: true }); return; }
    execFile(found, args, { timeout: timeoutMs, windowsHide: true, shell: false, maxBuffer: 65536, env: vaultEnvironment() },
      (error, stdout, stderr) => {
        const failure = error as (NodeJS.ErrnoException & { code?: number | string }) | null;
        const missing = failure?.code === "ENOENT";
        const code = typeof failure?.code === "number" ? failure.code : failure ? 1 : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr), missing });
      });
  });

const locked = /\b(locked|not logged in|unlock|authentication required|sign in|session key)\b/i;
const absent = /\b(not found|no item|could not find|isn't an item|does not exist)\b/i;

/** Why a run of the command line did not hand back a password, in one plain sentence. */
export function refusalFrom(reference: CredentialRef, outcome: CliOutcome, executable: string): string | null {
  const name = serviceNames[reference.service];
  if (outcome.missing)
    return `${name}'s command line (${executable}) is not on this computer, so Branch cannot look that up. Install it, or keep the password in Branch's own locker instead.`;
  const said = `${outcome.stderr} ${outcome.stdout}`.trim();
  if (outcome.code !== 0 && locked.test(said))
    return `Your ${name} vault is locked, so Branch cannot read anything from it. Unlock it yourself, then ask again.`;
  if (outcome.code !== 0 && absent.test(said))
    return `There is nothing called "${reference.item}" in your ${name} vault.`;
  if (outcome.code !== 0) return `${name} would not hand that over, and gave no reason Branch can pass on.`;
  if (!outcome.stdout.trim())
    return `${name} found "${reference.item}" but it has no ${reference.field === "totp" ? "one-time code" : "password"} saved on it.`;
  return null;
}

export class CredentialResolver {
  /** Set by the session lock: it throws a plain reason when secrets may not be used yet. */
  gate: () => void = () => undefined;
  constructor(
    private readonly store: Store, private readonly owner: string,
    private readonly scrubber: SecretScrubber, private readonly run: CliRunner = spawnCli,
  ) {}
  settings(): CredentialSettings { return readCredentialSettings(this.store, this.owner); }

  /**
   * Replaces every `secret://bitwarden/...` and `secret://1password/...` reference inside a value
   * with the real password, at the moment of the call and nowhere earlier.
   */
  async fill<T>(value: T, use: { runId?: string | undefined; purpose: string }): Promise<T> {
    const references = collectCredentialReferences(value);
    if (!references.length) return value;
    const values = new Map<string, string>();
    for (const reference of references)
      values.set(`${reference.service}/${reference.item}`, await this.read(reference, use));
    return mapStrings(value, (text) =>
      text.replace(anyCredentialReference, (whole, service: string, item: string) => values.get(`${service}/${item}`) ?? whole));
  }

  /** One password, read through the owner's own command line. Everything that can go wrong is a plain sentence. */
  async read(reference: CredentialRef, use: { runId?: string | undefined; purpose: string }): Promise<string> {
    this.gate();
    const settings = this.settings();
    const name = serviceNames[reference.service];
    if (!settings.enabled)
      throw new Error(`Branch is not set up to read passwords from a password manager. Turn that on in Settings first.`);
    if (!settings.services.includes(reference.service))
      throw new Error(`Branch is not allowed to read from ${name}. Tick ${name} in Settings if that is what you want.`);
    const { executable, args } = commandFor(reference, settings);
    const outcome = await this.run(executable, args, settings.timeoutMs);
    const refusal = refusalFrom(reference, outcome, executable);
    if (refusal) { this.record(reference, use, "refused"); throw new Error(refusal); }
    const value = outcome.stdout.replace(/\r?\n$/, "");
    // A password is remembered by the scrubber so it is taken back out of anything written later.
    // A one-time code is not: it is six or eight figures, it is stale within the minute, and
    // remembering it would blank those figures out of ordinary text for the rest of the session.
    // Nothing downstream ever sees it instead — it goes straight into the page (src/vault-autofill.ts).
    if ((reference.field ?? "password") !== "totp") this.scrubber.remember(`${reference.service}:${reference.item}`, value);
    this.record(reference, use, "handed over");
    return value;
  }

  /** The name of the item only; the password itself never reaches this record. */
  private record(reference: CredentialRef, use: { runId?: string | undefined; purpose: string }, outcome: string): void {
    audit(this.store, this.owner, {
      action: "secret.used", actor: `your ${serviceNames[reference.service]} vault`,
      subject: `${credentialReference(reference.service, reference.item)}${reference.field === "totp" ? " (one-time code)" : ""}`,
      reason: use.purpose.slice(0, 120), runId: use.runId ?? null, outcome,
    });
  }
}
