import { createHash } from "node:crypto";
import type { Store } from "./store.js";
import { redactLeaksIn } from "./leak-guard.js";

/** Export retained events without rerunning models or tools. An oversize log fails rather than dropping steps. */
export function runEventLog(store: Store, owner: string, runId: string, scrub: <T>(value: T) => T): string {
  const run = store.run(runId);
  if (!run || run.owner !== owner) throw Object.assign(new Error("Task not found"), { status: 404 });
  const through = store.eventLogEnd(runId), lines: string[] = [];
  let bytes = 0, after = 0, count = 0;
  const append = (value: unknown) => {
    const line = JSON.stringify(redactLeaksIn(scrub(value)).value) + "\n";
    bytes += Buffer.byteLength(line);
    if (bytes > 16 * 1024 * 1024) throw Object.assign(new Error("The complete event log exceeds the 16 MiB export limit"), { status: 413 });
    lines.push(line);
  };
  append({ type: "header", format: "branch-run-event-log", version: 1, exportedAt: new Date().toISOString(),
    throughEventId: through, run, replay: "recorded events; executing again requires current permissions and approvals" });
  while (after < through) {
    const page = store.eventLogPage(runId, after, through);
    if (!page.length) throw new Error("The task event log changed during export; try again");
    for (const event of page) {
      if (++count > 50000) throw Object.assign(new Error("The complete event log exceeds 50000 events"), { status: 413 });
      append({ type: "event", event });
      after = event.id;
    }
  }
  const hash = createHash("sha256");
  for (const line of lines) hash.update(line);
  append({ type: "footer", events: count, sha256: hash.digest("hex"), throughEventId: through });
  return lines.join("");
}
