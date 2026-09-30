import { execFile } from "node:child_process";
import { writeFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, win32 } from "node:path";
import { tmpdir } from "node:os";

/**
 * The few Windows tools this app uses to install itself: the script host that makes shortcuts, and
 * `reg.exe` for the Add/Remove Programs entry and the "start with Windows" switch. Every call goes
 * through one small function so tests can hand in a stand-in and nothing real is touched.
 */
export type RunTool = (file: string, args: string[]) => Promise<string>;

export function systemTool(name: string, systemRoot = process.env.SystemRoot ?? "C:\\Windows"): string {
  // win32.join is what join is on Windows; it also keeps the answer a Windows path in tests elsewhere.
  return win32.join(systemRoot, "System32", name);
}

export const runTool: RunTool = (file, args) =>
  new Promise((resolve, reject) =>
    execFile(file, args, { windowsHide: true, timeout: 30000, maxBuffer: 1048576 }, (error, stdout, stderr) =>
      // The cause keeps the exit code and whether the tool was stopped for taking too long (src/install/gateway-task.ts).
      error ? reject(new Error(`${file} failed: ${(stderr || error.message).trim().slice(0, 300)}`, { cause: error })) : resolve(stdout)));

export interface ShortcutSpec {
  /** Full path of the .lnk file to write. */
  path: string;
  target: string;
  arguments?: string;
  workingDirectory?: string;
  description?: string;
  iconLocation?: string;
}

/** The VBScript that asks Windows to write one shortcut file. */
export function shortcutScript(spec: ShortcutSpec): string {
  const quote = (value: string) => `"${value.replace(/"/g, '""')}"`;
  const lines = [
    'Set shell = CreateObject("WScript.Shell")',
    `Set link = shell.CreateShortcut(${quote(spec.path)})`,
    `link.TargetPath = ${quote(spec.target)}`,
    `link.Arguments = ${quote(spec.arguments ?? "")}`,
    `link.WorkingDirectory = ${quote(spec.workingDirectory ?? "")}`,
    `link.Description = ${quote(spec.description ?? "Branch Agent")}`,
    `link.IconLocation = ${quote(spec.iconLocation ?? `${spec.target},0`)}`,
    "link.Save",
  ];
  return lines.join("\r\n") + "\r\n";
}

/** Writes shortcut files by running the script host; the temporary script is always removed. */
export async function createShortcuts(
  specs: ShortcutSpec[], deps: { run?: RunTool; systemRoot?: string } = {},
): Promise<string[]> {
  if (!specs.length) return [];
  const run = deps.run ?? runTool;
  const script = join(tmpdir(), `branch-shortcut-${randomUUID()}.vbs`);
  await writeFile(script, specs.map(shortcutScript).join(""), "utf8");
  try {
    await run(systemTool("cscript.exe", deps.systemRoot), ["//Nologo", "//B", script]);
  } finally {
    await rm(script, { force: true });
  }
  return specs.map((spec) => spec.path);
}

export interface RegistryValue { name: string; type: "REG_SZ" | "REG_DWORD"; value: string }

export function regAddArgs(key: string, entry: RegistryValue): string[] {
  return ["add", key, "/v", entry.name, "/t", entry.type, "/d", entry.value, "/f"];
}
export function regDeleteKeyArgs(key: string): string[] {
  return ["delete", key, "/f"];
}
export function regDeleteValueArgs(key: string, name: string): string[] {
  return ["delete", key, "/v", name, "/f"];
}
export function regQueryArgs(key: string, name: string): string[] {
  return ["query", key, "/v", name];
}

export async function writeRegistryValues(
  key: string, entries: RegistryValue[], deps: { run?: RunTool; systemRoot?: string } = {},
): Promise<void> {
  const run = deps.run ?? runTool, reg = systemTool("reg.exe", deps.systemRoot);
  for (const entry of entries) await run(reg, regAddArgs(key, entry));
}

/** Reads one value; returns null when the key or the value is not there. */
export async function readRegistryValue(
  key: string, name: string, deps: { run?: RunTool; systemRoot?: string } = {},
): Promise<string | null> {
  const run = deps.run ?? runTool;
  try {
    const output = await run(systemTool("reg.exe", deps.systemRoot), regQueryArgs(key, name));
    const match = new RegExp(`${name}\\s+REG_\\w+\\s+(.*)`).exec(output);
    return match?.[1]?.trim() ?? null;
  } catch {
    return null;
  }
}
