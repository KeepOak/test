import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { activeDiagnosticLog, redactFields, redactForLog } from "../diagnostic-log.js";
import { lockedDown } from "../lockdown.js";
import type { Call, Reply } from "./handlers.js";

const lastMade = new WeakMap<object, number>();
const items = ["about", "tasks", "log"] as const;
type Item = (typeof items)[number];

function selection(argument: string): Item[] | null {
  const wanted = argument.trim() ? argument.trim().toLowerCase().split(/[\s,]+/) : [...items];
  if (wanted.length > 3 || wanted.some((id) => !(items as readonly string[]).includes(id))) return null;
  return [...new Set(wanted)] as Item[];
}

/** Shape only: no prompts, outputs, config, model names, key reads, host probes or network. */
function snapshot(call: Call, include: Item[]): string {
  const { runtime, version } = call.host;
  const report: Record<string, unknown> = { schema: "branch.local-diagnostics.v1", madeAt: new Date().toISOString(),
    checksRun: false, items: include, note: "Observed metadata only; no health checks or provider calls were made." };
  if (include.includes("about")) report.about = { branch: version ?? "unknown", node: process.version,
    platform: process.platform, arch: process.arch, pid: process.pid, uptimeSeconds: Math.floor(process.uptime()),
    processMemoryBytes: process.memoryUsage(), lockdown: lockedDown(runtime.store, runtime.owner) };
  if (include.includes("tasks")) {
    const runs = runtime.store.sqlite.prepare("SELECT status FROM tasks WHERE owner=? AND session_id NOT IN (SELECT session_id FROM conversation_marks WHERE deleted_at IS NOT NULL) ORDER BY created_at DESC, rowid DESC LIMIT 50").all(runtime.owner);
    const counts: Record<string, number> = {};
    for (const run of runs) { const status = String(run.status); counts[status] = (counts[status] ?? 0) + 1; }
    report.tasks = { sampled: runs.length, limit: 50, counts, scope: "retained owner tasks; aggregate only" };
  }
  if (include.includes("log")) {
    const log = activeDiagnosticLog();
    report.log = { available: !!log, limit: 20, scope: "in-memory breadcrumbs; message and fields excluded",
      entries: log?.breadcrumbs().slice(-20).map(({ at, level, component }) => ({ at, level, component })) ?? [] };
  }
  return JSON.stringify(redactFields(report, (text) => redactForLog(runtime.hideSecrets(text))), null, 2) + "\n";
}

/** Generated names, real owned data directory, no user path and exclusive file creation. */
function save(call: Call, text: string): string {
  const base = realpathSync(call.host.runtime.store.folder), folder = join(base, "diagnostics");
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const info = lstatSync(folder);
  const canonical = realpathSync(folder), direct = process.platform === "win32"
    ? canonical.toLowerCase() === folder.toLowerCase() : canonical === folder;
  if (!info.isDirectory() || info.isSymbolicLink() || !direct)
    throw new Error("The diagnostics folder must be a direct directory in Branch's data home.");
  if (Buffer.byteLength(text, "utf8") > 65536) throw new Error("The report is too large to save.");
  call.host.requireOwner("save local diagnostics");
  const name = `branch-diagnostics-${Date.now()}-${randomUUID()}.json`;
  writeFileSync(join(folder, name), text, { encoding: "utf8", mode: 0o600, flag: "wx" });
  return name;
}

export function diagnostics(call: Call): Reply {
  call.host.requireOwner("local diagnostics");
  const include = selection(call.argument);
  if (!include) return { text: "Use /diagnostics [about tasks log]. No files, messages, keys or settings are included." };
  const now = Date.now(), previous = lastMade.get(call.host.runtime);
  if (previous !== undefined && now - previous < 60000) return { text: "A report was just made. Wait one minute before making another." };
  const text = snapshot(call, include), name = save(call, text);
  lastMade.set(call.host.runtime, now);
  const reply = `Saved ${name} in this computer's Branch data home, under diagnostics. Checks were not run. Nothing was uploaded. Review the file before sharing it.`;
  // The chat receives only the generated local filename, never the report body.
  return call.surface === "window" || call.surface === "phone"
    ? { text: reply, client: { do: "download", name, text } } : { text: reply };
}
