import { execFile } from "node:child_process";
import type { Store } from "../store.js";
import { doctorFix, type DoctorFixReport } from "../doctor-fix.js";
import { formatOf } from "../never-break/migrations.js";
import { diagnose } from "../diagnostic-log.js";

const key = "doctor-after-update";
export interface PostUpdateDoctorOptions {
  store: Pick<Store, "get" | "save" | "sqlite">;
  owner: string;
  version: string;
  workspace: string;
  port: number;
  redact: (text: string) => string;
}

/** Read-only Git probe: no shell, no npx, no installer, bounded runtime and cancellation when the owning engine stops. */
function probe(signal: AbortSignal): (file: string, args: string[]) => Promise<string> {
  return (file, args) => new Promise((resolve, reject) => {
    if (file !== "git" || args.join(" ") !== "--version") return reject(new Error("An unattended doctor cannot run this command."));
    execFile(file, args, { windowsHide: true, timeout: 10_000, maxBuffer: 8192, signal },
      (error, stdout) => error ? reject(error) : resolve(stdout));
  });
}

/** Run in the accepted engine which already owns the database, never by opening a second doctor process. */
export function startPostUpdateDoctor(options: PostUpdateDoctorOptions): () => void {
  const controller = new AbortController();
  const schema = formatOf(options.store.sqlite).version;
  const previous = options.store.get("settings", options.owner, key)?.data;
  if (!previous) {
    options.store.save("settings", options.owner, key, { version: options.version, schema, baseline: true });
  } else if (previous.version !== options.version || previous.schema !== schema) {
    void runDoctor(options, schema, controller.signal).catch((error: unknown) => {
      if (!controller.signal.aborted) diagnose("updater", "warn", options.redact(`The post-update doctor could not finish: ${String(error)}`));
    });
  }
  return () => controller.abort();
}

async function runDoctor(options: PostUpdateDoctorOptions, schema: number, signal: AbortSignal): Promise<void> {
  const report = await doctorFix({ fix: true, browserRepair: "manual", workspace: options.workspace,
    port: options.port, portIsOurs: true }, { run: probe(signal) });
  if (signal.aborted) return;
  const checked = redactedReport(report, options.redact);
  // Record every completed verdict, including unresolved checks, so a missing external prerequisite cannot create a restart loop.
  options.store.save("settings", options.owner, key, { version: options.version, schema, baseline: false, ...checked });
  diagnose("updater", checked.ok ? "info" : "warn", checked.ok ? "The post-update doctor found the local prerequisites in place."
    : `The post-update doctor needs attention: ${checked.checks.filter((check) => !check.ok).map((check) => check.summary).join(" ")}`);
}

function redactedReport(report: DoctorFixReport, redact: (text: string) => string): DoctorFixReport {
  return { ...report, checks: report.checks.map((check) => ({ ...check, summary: redact(check.summary),
    ...(check.fix ? { fix: redact(check.fix) } : {}) })) };
}
