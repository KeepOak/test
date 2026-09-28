import { z } from "zod";
import { join } from "node:path";
import { DiagnosticLog, diagnosticLogSettings } from "./diagnostic-log.js";
import { gatherReport } from "./diagnostic-report.js";
import { reportSources, type DiagnosticContext } from "./diagnostic-api.js";
import { lastUpdateFailure, updateItemIds, updateLogItem } from "./update-failure.js";
import { saveTrunkMode, trunkMode } from "./trunks/settings.js";

/**
 * Owner item 21: "Fix update". When an update does not go through, one press hands what Branch
 * recorded to the agent the owner assigned to updates: a Trunk with its own instructions and its own
 * memory, which works in its own conversation so every fix it has looked at before is there for the
 * next one. It explains and proposes; it changes nothing without asking. The report goes in as the
 * owner's own visible message, so what the agent was given is always on screen.
 */
export const updateKeeperKey = "update-keeper";
const KeeperSchema = z.object({ trunkId: z.string().uuid().nullable().default(null) }).strict();
const promptChars = 12_000;
/** Kept for the update's own steps: that record says where it stopped, so it always goes. */
const logChars = 4_000;

export const keeperName = "Update keeper";
export const keeperInstructions = [
  "You look after Branch Agent's updates on this computer, and nothing else.",
  "When an update does not go through, you are given what Branch recorded: the version, the update history, the update's own steps, the activity log, crashes and disk space.",
  "Find the cause from that record. Say it in two or three plain sentences, then give the fix as numbered steps the owner can follow.",
  "Never change files, settings, installs or accounts yourself, and never start an update, without asking first and waiting for a yes.",
  "If the record is not enough, say exactly what you would need to see, and how the owner can find it.",
  "Remember what went wrong before on this computer, so the same problem is recognised at once next time.",
].join("\n");

function keeperOf(app: Pick<DiagnosticContext["app"], "store" | "runtime" | "trunks">): string | null {
  const saved = KeeperSchema.safeParse(app.store.get("settings", app.runtime.owner, updateKeeperKey)?.data ?? {});
  const id = saved.success ? saved.data.trunkId : null;
  return id && app.trunks.records.find(id) ? id : null;
}

/** The assigned Trunk, or the Update keeper made the first time it is needed. */
function ensureKeeper(app: Pick<DiagnosticContext["app"], "store" | "runtime" | "trunks">): { trunkId: string; made: boolean } {
  const assigned = keeperOf(app) ?? app.trunks.records.list().find((trunk) => trunk.name === keeperName)?.id ?? null;
  if (assigned) {
    app.store.save("settings", app.runtime.owner, updateKeeperKey, { trunkId: assigned });
    return { trunkId: assigned, made: false };
  }
  // defaulttrunk: the keeper is never the default Trunk; with none yet, the default is made first (quietly).
  app.trunks.ensureDefault(true);
  const made = app.trunks.create({ name: keeperName, title: "Keeps Branch's updates working", description: "Looks at an update that did not go through and says how to fix it." });
  app.trunks.edit(made.id, { instructions: keeperInstructions, sharedFacts: false });
  app.store.save("settings", app.runtime.owner, updateKeeperKey, { trunkId: made.id });
  return { trunkId: made.id, made: true };
}

/** The owner's message to the keeper: what happened, as Branch recorded it, cleaned and bounded. */
async function fixPrompt(ctx: DiagnosticContext): Promise<string> {
  const { app, dataDir } = ctx;
  const log = new DiagnosticLog({ dir: join(dataDir, "logs"), settings: () => diagnosticLogSettings(app.store, app.runtime.owner) });
  const items = await gatherReport(reportSources(ctx, log), updateItemIds);
  const steps = await updateLogItem();
  const failure = lastUpdateFailure(dataDir);
  const head = failure
    ? `The update from ${failure.fromVersion} to ${failure.toVersion} didn't go through, and Branch is still on ${app.version}.`
    : `An update didn't go through, and Branch is still on ${app.version}.`;
  return boundPrompt(`${head} Here is what Branch recorded, with secrets removed. What went wrong, and how do I fix it? Don't change anything without asking me first.\n`, items, steps);
}
/**
 * The message within `promptChars`: each item cut short rather than left out, within what is left once
 * the update's own steps have their room, and those steps always there, their end kept.
 */
export function boundPrompt(head: string, items: readonly { title: string; text: string }[], steps: { title: string; text: string }): string {
  let text = head;
  for (const item of items) text += section(item.title, item.text.trim(), promptChars - logChars - text.length, "start");
  return text + section(steps.title, steps.text.trim(), promptChars - text.length, "end");
}
/** One item under its title, cut to `room` characters: its start kept, or its end (where an update stopped). */
function section(title: string, body: string, room: number, keep: "start" | "end"): string {
  const heading = `\n## ${title}\n`, note = "(the rest is in the downloaded file)";
  const space = room - heading.length - 1;
  if (body.length <= space) return `${heading}${body}\n`;
  if (space <= note.length + 20) return `${heading}${note}\n`;
  const kept = space - note.length - 1;
  return keep === "start" ? `${heading}${body.slice(0, kept)}\n${note}\n` : `${heading}${note}\n${body.slice(-kept)}\n`;
}

export const handlesUpdateFixPath = (path: string): boolean => path === "/api/updates/fix" || path === "/api/updates/keeper";

export async function updateFixApi(ctx: DiagnosticContext, method: string, path: string, body: () => Promise<unknown>): Promise<unknown> {
  const { app } = ctx;
  // The owner's alone, checked here so the guard moves with the route.
  app.store.profiles.requireOwner("Fixing an update");
  if (path === "/api/updates/keeper") {
    if (method === "POST") {
      const { trunkId } = KeeperSchema.parse(await body());
      if (trunkId) app.trunks.records.get(trunkId); // a Trunk that exists, or "There is no Trunk…"
      app.store.save("settings", app.runtime.owner, updateKeeperKey, { trunkId });
    } else if (method !== "GET") throw new Error("Use GET or POST");
    return { trunkId: keeperOf(app), trunks: app.trunks.records.list().map((trunk) => ({ id: trunk.id, name: trunk.name })) };
  }
  if (method !== "POST") throw new Error("Use POST");
  // Pressing Fix update is the owner asking for a Trunk, so Trunks comes on if it was off, and says so.
  const trunksSwitchedOn = trunkMode(app.store, app.runtime.owner, "trunks") === "off";
  if (trunksSwitchedOn) saveTrunkMode(app.store, app.runtime.owner, "trunks", { mode: "when-needed" });
  const { trunkId, made } = ensureKeeper(app);
  // A new keeper introduces itself in its conversation first; the report is handed over after that.
  if (made) await app.trunks.introduced();
  const trunk = app.trunks.records.get(trunkId);
  return { trunkId, name: trunk.name, sessionId: trunk.chatSessionId, made, trunksSwitchedOn, prompt: await fixPrompt(ctx) };
}
