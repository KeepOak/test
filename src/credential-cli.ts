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
export const credentialServices = ["bitwarden", "1password", "windows"] as const;
export type CredentialService = (typeof credentialServices)[number];
export const serviceNames: Record<CredentialService, string> = { bitwarden: "Bitwarden", "1password": "1Password", windows: "Windows Credential Manager" };

export const CredentialSettingsSchema = z.object({
  /** "Let Branch look up passwords in my password manager". Off until the owner turns it on. */
  enabled: z.boolean().default(false),
  /** Which password managers may be asked. Empty means none, even when the switch is on. */
  services: z.array(z.enum(credentialServices)).max(3).default([]),
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
const referenceText = "secret://(bitwarden|1password|windows)/([A-Za-z0-9][A-Za-z0-9 ._@/-]{0,79})";
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
    throw new Error(reference.service === "windows" ? "Branch reads a one-time code from Bitwarden only. Windows Credential Manager holds none."
      : "Branch reads a one-time code from Bitwarden only. 1Password holds it at an address only you know.");
  if (reference.service === "windows") return windowsCredentialCommand(reference.item);
  const path = reference.item.startsWith("op://") ? reference.item : `op://${reference.item}`;
  return { executable: settings.onePasswordCommand || "op", args: ["read", "--no-newline", path] };
}

/**
 * Windows Credential Manager: one generic credential, read by its exact target name (what `cmdkey /generic:<name>` and
 * the Credential Manager's "Windows Credentials" list call it) through Windows' own CredRead, in Windows PowerShell by
 * its full path. Only reading: nothing is listed, written or deleted. The call is declared in memory with
 * Reflection.Emit (no C# is compiled and no file is written: an unsigned library would be stopped by Smart App
 * Control). The target name reaches the script only as base64 inside a quoted literal, and the whole script is
 * passed encoded, so no name can be read as a command. The password is written to the program's own output, which
 * only this process reads; a name with no credential exits 44.
 */
export function windowsCredentialScript(target: string): string {
  const name = Buffer.from(target, "utf8").toString("base64");
  // No cmdlet is used (only .NET types), so PowerShell never loads a module: a fresh computer's first run would
  // otherwise spend its whole time limit "preparing modules for first use".
  return [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    "[Console]::OutputEncoding = [Text.Encoding]::UTF8",
    "$assembly = [AppDomain]::CurrentDomain.DefineDynamicAssembly([Reflection.AssemblyName]::new('BranchCredential'), [Reflection.Emit.AssemblyBuilderAccess]::Run)",
    "$type = $assembly.DefineDynamicModule('BranchCredential').DefineType('BranchCredential', 'Public, Class')",
    // Declared as PSReflect does: a PinvokeImpl method carrying DllImport (Unicode, SetLastError), so Windows' error is kept.
    "$read = $type.DefineMethod('CredReadW', 'Public, Static, PinvokeImpl', [bool], [Type[]]@([string], [int], [int], [IntPtr].MakeByRefType()))",
    "$import = [Runtime.InteropServices.DllImportAttribute]",
    "$read.SetCustomAttribute([Reflection.Emit.CustomAttributeBuilder]::new($import.GetConstructor(@([string])), @('advapi32.dll'), [Reflection.FieldInfo[]]@($import.GetField('SetLastError'), $import.GetField('CharSet'), $import.GetField('CallingConvention')), [object[]]@($true, [Runtime.InteropServices.CharSet]::Unicode, [Runtime.InteropServices.CallingConvention]::Winapi)))",
    "$free = $type.DefinePInvokeMethod('CredFree', 'advapi32.dll', 'Public, Static, PinvokeImpl', [Reflection.CallingConventions]::Standard, [void], [Type[]]@([IntPtr]), [Runtime.InteropServices.CallingConvention]::Winapi, [Runtime.InteropServices.CharSet]::Unicode)",
    "$free.SetImplementationFlags('PreserveSig')",
    // ReadCode calls CredReadW and takes Windows' error number in the same breath (0 when it read), before PowerShell's
    // own work can overwrite it.
    "$wrap = $type.DefineMethod('ReadCode', 'Public, Static', [int], [Type[]]@([string], [IntPtr].MakeByRefType()))",
    "$il = $wrap.GetILGenerator(); $ok = $il.DefineLabel(); $op = [Reflection.Emit.OpCodes]",
    "$il.Emit($op::Ldarg_0); $il.Emit($op::Ldc_I4_1); $il.Emit($op::Ldc_I4_0); $il.Emit($op::Ldarg_1); $il.Emit($op::Call, $read)",
    "$il.Emit($op::Brtrue_S, $ok); $il.Emit($op::Call, [Runtime.InteropServices.Marshal].GetMethod('GetLastWin32Error')); $il.Emit($op::Ret)",
    "$il.MarkLabel($ok); $il.Emit($op::Ldc_I4_0); $il.Emit($op::Ret)",
    "$api = $type.CreateType()",
    `$name = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${name}'))`,
    "$found = [IntPtr]::Zero",
    // 1168 is ERROR_NOT_FOUND: no credential by that name. Any other failure says its Windows error number (exit 45).
    "$code = $api::ReadCode($name, [ref]$found)",
    "if ($code -eq 1168) { [Console]::Error.WriteLine('not found'); exit 44 }",
    "if ($code -ne 0) { [Console]::Error.WriteLine(\"windows error $code\"); exit 45 }",
    "try {",
    // CREDENTIALW: the blob's size and address sit after Flags, Type, TargetName, Comment and LastWritten.
    "  $wide64 = [IntPtr]::Size -eq 8",
    "  $size = [Runtime.InteropServices.Marshal]::ReadInt32($found, $(if ($wide64) { 32 } else { 24 }))",
    "  $blob = [Runtime.InteropServices.Marshal]::ReadIntPtr($found, $(if ($wide64) { 40 } else { 28 }))",
    "  $bytes = [byte[]]::new($size)",
    "  if ($size -gt 0) { [Runtime.InteropServices.Marshal]::Copy($blob, $bytes, 0, $size) }",
    // Windows keeps a password as UTF-16 (cmdkey, the Credential Manager, most programs); a few write UTF-8. UTF-16 when the
    // bytes are an even count and either half the high bytes are zero (Latin text) or they are not clean UTF-8 text (Cyrillic,
    // Greek, most CJK): a strict UTF-8 reading that fails, or holds control characters, is not a password written as UTF-8.
    "  $zeros = 0; for ($i = 1; $i -lt $bytes.Length; $i += 2) { if ($bytes[$i] -eq 0) { $zeros++ } }",
    "  $asUtf8 = $null; try { $asUtf8 = [Text.UTF8Encoding]::new($false, $true).GetString($bytes) } catch { $asUtf8 = $null }",
    "  $cleanUtf8 = $null -ne $asUtf8 -and $asUtf8 -notmatch '[\\x00-\\x08\\x0B\\x0C\\x0E-\\x1F\\x7F]'",
    "  $unicode = $bytes.Length -gt 0 -and $bytes.Length % 2 -eq 0 -and ($zeros * 2 -ge $bytes.Length / 2 -or -not $cleanUtf8)",
    "  [Console]::Out.Write($(if ($unicode) { [Text.Encoding]::Unicode.GetString($bytes) } else { $asUtf8 }))",
    "} finally { $api::CredFree($found) }",
  ].join("\n");
}
export function windowsCredentialCommand(target: string, systemRoot: string = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows"): { executable: string; args: string[] } {
  const encoded = Buffer.from(windowsCredentialScript(target), "utf16le").toString("base64");
  return { executable: join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded] };
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
  if (reference.service === "windows" && outcome.code === 45)
    return `Windows Credential Manager could not be read here (${/windows error (\d+)/.exec(said)?.[0] ?? "no reason given"}). Branch reads it only while running as you, signed in to Windows.`;
  if (outcome.code !== 0 && (absent.test(said) || (reference.service === "windows" && outcome.code === 44)))
    return `There is nothing called "${reference.item}" in your ${reference.service === "windows" ? name : `${name} vault`}.`;
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
    private readonly platform: string = process.platform,
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
    if (reference.service === "windows" && this.platform !== "win32")
      throw new Error("Windows Credential Manager is part of Windows, and this Branch runs on another system, so it cannot read from it here.");
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
      action: "secret.used", actor: reference.service === "windows" ? "your Windows Credential Manager" : `your ${serviceNames[reference.service]} vault`,
      subject: `${credentialReference(reference.service, reference.item)}${reference.field === "totp" ? " (one-time code)" : ""}`,
      reason: use.purpose.slice(0, 120), runId: use.runId ?? null, outcome,
    });
  }
}
