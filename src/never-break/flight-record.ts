import { join } from "node:path";
import { DiagnosticLog, DiagnosticLogSettingsSchema, crashCaptureMarked, watchProcessCrashes } from "../diagnostic-log.js";

/**
 * QA retest 2026-09-28 (X1): the gateway and its engine both ended with nothing written anywhere: the gateway keeps its
 * notes in memory only and writes no log, so how it stopped was lost with it. It now keeps a flight record of its own,
 * `logs/gateway.jsonl` in the data folder (the engine's `branch.jsonl` stays the engine's): when it started, every engine
 * that stopped and how, any failure nobody caught, and whether it ended because it was asked to. A fatal error inside
 * Node itself leaves Node's own report in the same folder.
 */
class GatewayLog extends DiagnosticLog {
  override get file(): string { return join(this.dir, "gateway.jsonl"); }
}

export interface GatewayRecord {
  log: DiagnosticLog;
  /** Marks the end that follows as asked for (Ctrl+C, `branch quit`, the window's Close, a roll-back). */
  asked(why: string): void;
}

/** Node's own report when it dies of a fatal error (out of memory, a V8 abort), written into the log folder. */
export function reportFatalErrors(dir: string, name: string): void {
  try {
    process.report.reportOnFatalError = true;
    process.report.directory = dir;
    process.report.filename = `${name}-fatal-${process.pid}.json`;
  } catch { /* a report that cannot be arranged must never stop Branch starting */ }
}

export function openGatewayRecord(dataDir: string, version: string): GatewayRecord {
  const dir = join(dataDir, "logs");
  // Everything from "info" up: a gateway writes a handful of lines a day, and each one is about staying up.
  const log = new GatewayLog({ dir, settings: () => DiagnosticLogSettingsSchema.parse({ mode: "on", crashCapture: crashCaptureMarked(dataDir) ? "on" : "off" }) });
  reportFatalErrors(dir, "gateway");
  watchProcessCrashes(log, "gateway");
  let why: string | null = null;
  // Written synchronously as the process ends, so it survives the exit itself. An end forced from outside (the process
  // killed) runs no code at all; then the record's last line is the last thing the gateway did, and the next start says
  // the previous one never wrote its end.
  process.on("exit", (code) => {
    if (why) log.write({ level: "info", component: "gateway", message: "The gateway closed", fields: { code, why } });
    else log.write({ level: "error", component: "gateway", message: "The gateway ended without being asked to", fields: { code } });
  });
  log.write({ level: "info", component: "gateway", message: "The gateway started", fields: { pid: process.pid, version } });
  return { log, asked: (reason) => { why ??= reason; } };
}
