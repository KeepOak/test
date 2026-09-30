import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, realpath, writeFile, access, readdir, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestCopyReceipt } from "./self-development-test-copy.js";
import { nativeQaWorker } from "./continuous-qa-native-worker.js";

export const qaJourneys = ["settings-reading", "usage-reading", "self-reading"] as const;
export type QaJourney = typeof qaJourneys[number];
const xml = (s: string) => s.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]!);
const literal = (s: string) => JSON.stringify(s);

/** Never launches a host Windows app; macOS descendants inherit the deny-default profile. */
export async function nativeQa(copy: TestCopyReceipt, journeys: QaJourney[], signal: AbortSignal): Promise<{ passed: boolean; evidence: string }> {
  if (!["win32", "darwin"].includes(process.platform)) throw new Error("Held: native QA needs Windows Sandbox or macOS sandbox-exec.");
  if (!journeys.length || journeys.length > 3 || new Set(journeys).size !== journeys.length || journeys.some((x) => !qaJourneys.includes(x)))
    throw new Error("Select one to three owner-approved read-only journeys.");
  const root = await realpath(copy.folder), home = await mkdtemp(join(await realpath(tmpdir()), "branch-native-qa-")), worker = randomUUID();
  if (root !== copy.folder || await realpath(home) !== home) throw new Error("Native QA roots must be plain dedicated directories.");
  const windows = process.platform === "win32", mappedRoot = windows ? "C:\\qa-source" : root, mappedHome = windows ? "C:\\qa-work" : home;
  const relativeExecutable = windows ? "release/Branch Agent-win32-x64/Branch Agent.exe"
    : `release/Branch Agent-darwin-${process.arch}/Branch Agent.app/Contents/MacOS/Branch Agent`;
  const executable = join(root, relativeExecutable); if (await realpath(executable) !== executable) throw new Error("Held: prepare a plain exact-copy package.");
  await access(join(root, "node_modules", "playwright"));
  if (windows) await rejectMappedLinks(root);
  const input = { worker, platform: process.platform, root: mappedRoot, home: mappedHome,
    executable: windows ? mappedRoot + "\\" + relativeExecutable.replaceAll("/", "\\") : executable, sha: copy.sha, journeys };
  await writeFile(join(home, "worker.cjs"), nativeQaWorker, { flag: "wx" });
  await writeFile(join(home, "input.json"), JSON.stringify(input), { flag: "wx" });
  const command = windows ? await windowsCommand(root, home) : await macCommand(root, home);
  const child = spawn(command.executable, command.args, { env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: home, TMPDIR: home },
    stdio: "ignore", windowsHide: true, detached: !windows });
  let problem: Error | undefined; child.on("error", (error) => { problem = error; });
  const stop = () => { if (!child.pid || child.exitCode !== null) return; try { if (windows) child.kill(); else process.kill(-child.pid, "SIGKILL"); } catch { /* Child already exited. */ } };
  signal.addEventListener("abort", stop, { once: true });
  try {
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      signal.throwIfAborted(); if (problem) throw problem;
      try { const raw = await readFile(join(home, "result.json"), "utf8"); if (raw.length > 65_536) throw new Error("Native result exceeded bound");
        const result = JSON.parse(raw) as { worker?: string; workerPid?: number; appPid?: number; observed?: boolean; problem?: string };
        if (result.worker !== worker || !result.workerPid || result.appPid === result.workerPid) throw new Error("Native result worker/PID fence mismatch");
        return { passed: result.observed === true && !result.problem, evidence: JSON.stringify({ artifacts: home, result }) };
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (child.exitCode !== null) throw new Error("Native worker exited without verified evidence.");
      await new Promise<void>((resolve) => setTimeout(resolve, 500));
    }
    throw new Error("Native journey deadline exceeded.");
  } finally { signal.removeEventListener("abort", stop); stop(); }
}

async function windowsCommand(root: string, home: string) {
  // Portable Node must be explicitly prepared in this copy; no owner executable is mapped.
  await access(join(root, "qa-runtime", "node.exe"));
  const file = join(home, "worker.wsb");
  await writeFile(file, `<Configuration><Networking>Disable</Networking><ClipboardRedirection>Disable</ClipboardRedirection><AudioInput>Disable</AudioInput><VideoInput>Disable</VideoInput><PrinterRedirection>Disable</PrinterRedirection><ProtectedClient>Enable</ProtectedClient><MappedFolders><MappedFolder><HostFolder>${xml(root)}</HostFolder><SandboxFolder>C:\\qa-source</SandboxFolder><ReadOnly>true</ReadOnly></MappedFolder><MappedFolder><HostFolder>${xml(home)}</HostFolder><SandboxFolder>C:\\qa-work</SandboxFolder><ReadOnly>false</ReadOnly></MappedFolder></MappedFolders><LogonCommand><Command>C:\\qa-source\\qa-runtime\\node.exe C:\\qa-work\\worker.cjs C:\\qa-work\\input.json</Command></LogonCommand></Configuration>`);
  const executable = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsSandbox.exe"); await access(executable);
  return { executable, args: [file] };
}
async function macCommand(root: string, home: string) {
  await access("/usr/bin/sandbox-exec");
  const file = join(home, "worker.sb");
  const profile = `(version 1)(deny default)(allow process*)(allow mach-lookup)(allow sysctl-read)(allow file-read* (subpath "/System") (subpath "/usr") (subpath "/Library") (subpath ${literal(root)}) (subpath ${literal(home)}) (literal ${literal(process.execPath)}))(allow file-write* (subpath ${literal(home)}))(allow network-inbound (local ip "localhost:*"))(allow network-outbound (remote ip "localhost:*"))`;
  await writeFile(file, profile);
  return { executable: "/usr/bin/sandbox-exec", args: ["-f", file, process.execPath, join(home, "worker.cjs"), join(home, "input.json")] };
}

async function rejectMappedLinks(root: string): Promise<void> {
  const pending = [join(root, "release"), join(root, "node_modules"), join(root, "qa-runtime")];
  let count = 0;
  while (pending.length) {
    const folder = pending.pop()!;
    if (++count > 50_000) throw new Error("Held: mapped native package tree exceeds inspection limit.");
    const stat = await lstat(folder);
    if (stat.isSymbolicLink()) throw new Error("Held: Windows mapped package/dependencies must contain no links or junctions.");
    if (stat.isDirectory()) for (const entry of await readdir(folder)) pending.push(join(folder, entry));
  }
}