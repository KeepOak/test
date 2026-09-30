import { join } from "node:path";
import { DiagnosticLog, markedLogSettings, setDiagnosticLog, type DiagnosticLogSettings } from "../diagnostic-log.js";

/**
 * The desktop app's main process writes into the engine's activity log, `<data folder>/logs/branch.jsonl`. Before
 * this, `diagnose` did nothing here (only the engine set a log up), so every line main wrote, the updater's among
 * them, was lost; and the updater does its work exactly while the engine is stopping or stopped.
 *
 * Main writes the file itself rather than sending its lines to the engine: the engine may be closed (an update stops
 * it), restarting, or a background engine this window only joined over HTTP. Each line is one synchronous append of a
 * whole line (DiagnosticLog.append), so two writers never mix inside a line, and a line written just before main quits
 * into the hand-over is already on disk. Rotation follows the engine's rules and never stops a line.
 *
 * Main cannot read the database, so the owner's settings come from the file the engine writes beside the log
 * (`writeLogSettingsMark`). Off means off. Otherwise main writes from "info" up, as the gateway's flight record does
 * (src/never-break/flight-record.ts): it writes a handful of lines, and each says what an update or a start did,
 * which "when needed" (warnings and errors only) would otherwise drop, leaving an update that waits with no reason.
 */
export function mainLogSettings(dataDir: string): DiagnosticLogSettings {
  const marked = markedLogSettings(dataDir);
  return { ...marked, mode: marked.mode === "off" ? "off" : "on" };
}

/** Sets up this process's log; `diagnose(...)` anywhere in main writes to it from here on. */
export function openMainLog(dataDir: string): DiagnosticLog {
  const log = new DiagnosticLog({ dir: join(dataDir, "logs"), settings: () => mainLogSettings(dataDir) });
  setDiagnosticLog(log);
  return log;
}
