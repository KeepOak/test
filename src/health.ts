import { presetRunsLocally } from "./models.js";
import { randomBytes } from "node:crypto";
import { access, constants, stat, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { createBranch } from "./index.js";
import { localRuntimes } from "./local-runtimes.js";
import { noModelWords } from "./no-model.js";
import { needsYou } from "./needs-you.js";

/** Q024: "1 channel", "2 channels": a count with its word, never "channel(s)". */
const counted = (count: number, word: string): string => `${count} ${word}${count === 1 ? "" : "s"}`;

/**
 * A health check a person can act on: each item says what was tried, whether it works, and what to
 * do when it does not. Provider probing sends one tiny request and is optional because it costs.
 */
export interface HealthItem { name: string; ok: boolean; summary: string; fix?: string }
export interface HealthReport { ok: boolean; checkedAt: string; items: HealthItem[] }
type Branch = Awaited<ReturnType<typeof createBranch>>;

const item = (name: string, ok: boolean, summary: string, fix?: string): HealthItem => (fix && !ok ? { name, ok, summary, fix } : { name, ok, summary });
const failure = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 200);

async function checkDatabase(app: Branch): Promise<HealthItem> {
  try {
    const runs = app.store.runs(app.runtime.owner).length;
    return item("Saved data", true, `Database opens; ${runs} recent tasks on record`);
  } catch (error) { return item("Saved data", false, `Database problem: ${failure(error)}`, "Close the app, make a copy of the data folder, then reopen. If it persists, restore from a backup."); }
}
/**
 * Audit #36: checking must not change anything, so by default the workspace is only looked at (it exists, is a folder,
 * and this user may write to it). Only with `probe` (`branch doctor --probe`, which also sends real requests) is a
 * small file written and removed again, the one test that also holds on Windows, where write permission can mislead.
 */
async function checkWorkspace(app: Branch, probeWrite: boolean): Promise<HealthItem> {
  if (!probeWrite) {
    try {
      if (!(await stat(app.runtime.workspace)).isDirectory()) throw new Error("it is not a folder");
      await access(app.runtime.workspace, constants.W_OK);
      return item("Workspace folder", true, `${app.runtime.workspace} is there and may be written to`);
    } catch (error) { return item("Workspace folder", false, `Cannot use the workspace: ${failure(error)}`, "Check that the folder exists and that you have permission to write to it."); }
  }
  const probe = join(app.runtime.workspace, `health-${randomBytes(4).toString("hex")}.tmp`);
  try { await writeFile(probe, "ok", { mode: 0o600 }); await unlink(probe); return item("Workspace folder", true, `Can write to ${app.runtime.workspace}`); }
  catch (error) { return item("Workspace folder", false, `Cannot write to the workspace: ${failure(error)}`, "Check that the folder exists and that you have permission to write to it."); }
}
async function checkDeviceKey(app: Branch): Promise<HealthItem> {
  try { await app.store.receipts.sign("health", "health", "health", { ok: true }); return item("Device key", true, "The key that protects secrets and signs receipts loads"); }
  catch (error) { return item("Device key", false, `The device key cannot be used: ${failure(error)}`, "The locker.key file in the data folder is missing or unreadable. Secrets saved before cannot be recovered without it."); }
}
async function checkModels(app: Branch, probe: boolean): Promise<HealthItem> {
  if (!app.runtime.models.configured) return item("Models", false, noModelWords);
  const presets = [...app.runtime.models.presets.values()];
  const cooling = presets.filter((p) => app.runtime.models.coolingDown(p.id)).map((p) => p.name);
  const active = app.runtime.models.plan(app.runtime.owner, "health-check").candidates[0] ?? app.runtime.models.default;
  const base = `${counted(presets.length, "model choice")}; default is ${active.name}${cooling.length ? `; resting after failures: ${cooling.join(", ")}` : ""}`;
  if (!probe) return item("Models", presets.length > 0, base, "Sign in to ChatGPT or save a model connection under Settings.");
  const started = Date.now();
  try {
    await active.provider.complete({ messages: [{ role: "user", content: "Reply with the single word OK." }], tools: [], signal: AbortSignal.timeout(20000), maxTokens: 8 });
    return item("Models", true, `${base}; the default answered in ${((Date.now() - started) / 1000).toFixed(1)} s`);
  } catch (error) { return item("Models", false, `${base}; the default did not answer: ${failure(error)}`, "Check the connection under Settings → Models, or sign in to ChatGPT again."); }
}
async function checkChatGPT(app: Branch): Promise<HealthItem | null> {
  if (!app.chatgpt) return null;
  try { const status = await app.chatgpt.status(); return item("ChatGPT account", true, status.signedIn ? `Signed in${status.email ? " as " + status.email : ""}` : "Not signed in (optional)"); }
  catch (error) { return item("ChatGPT account", false, `Sign-in state unreadable: ${failure(error)}`, "Sign out and in again under Settings → ChatGPT account."); }
}
function checkChannels(app: Branch): HealthItem {
  const summary = app.channels.summary(), waiting = app.channels.outstanding();
  const dead = waiting.filter((d) => d.status === "dead").length;
  const text = `${counted(summary.channels.length, "channel")} connected; ${counted(waiting.length, "message")} waiting, ${dead} gave up`;
  return item("Channels", dead === 0, text, "Open Settings → Channels and press Try again on the messages that gave up, or check the bot token.");
}
function checkSchedules(app: Branch): HealthItem {
  const all = app.store.list("schedules", app.runtime.owner).map((r) => String(r.data.status));
  const interrupted = all.filter((s) => s === "interrupted").length;
  return item("Schedules", interrupted === 0, `${all.filter((s) => s === "pending").length} waiting, ${all.filter((s) => s === "running").length} running, ${interrupted} interrupted`, "Interrupted schedules stopped with the app. Press Run now on the ones that still matter.");
}
function checkAttention(app: Branch): HealthItem {
  // Q050: the same count the window's Inbox and Overview show, never every task ever left waiting.
  const waiting = needsYou(app);
  return item("Tasks waiting for you", waiting === 0, waiting ? `${counted(waiting, "task")} stopped to ask you something` : "Nothing is waiting on you", "Open the conversation shown in the banner and answer the question.");
}

/** Ollama and LM Studio on this computer: whether they run, what they hold, what last went wrong. */
async function checkLocalRuntimes(app: Branch): Promise<HealthItem> {
  try {
    const report = await localRuntimes().health([...app.runtime.models.presets.values()].some(presetRunsLocally));
    return item("Models on this computer", report.ok, report.summary, report.fix);
  } catch (error) {
    return item("Models on this computer", true, `Could not ask: ${failure(error)}`);
  }
}

export async function healthReport(app: Branch, options: { probeProvider?: boolean } = {}): Promise<HealthReport> {
  const items = (await Promise.all([
    checkDatabase(app), checkWorkspace(app, options.probeProvider ?? false), checkDeviceKey(app), checkModels(app, options.probeProvider ?? false), checkChatGPT(app),
    checkLocalRuntimes(app),
  ])).filter((i): i is HealthItem => i !== null);
  items.push(checkChannels(app), checkSchedules(app), checkAttention(app));
  return { ok: items.every((i) => i.ok), checkedAt: new Date().toISOString(), items };
}

/**
 * Dogfood F6: whether a version that has just been installed started cleanly. Only the checks about the program
 * itself count. A question waiting for the owner, a schedule the update's own restart cut off, a channel message
 * that gave up, or Ollama's last problem is the owner's to-do, not a sign the new version is broken, so none of
 * them may offer to put back the saved work from before the update.
 */
const startChecks = new Set(["Saved data", "Workspace folder", "Device key", "Models", "ChatGPT account"]);
export const startedCleanly = (report: HealthReport): boolean =>
  report.items.filter((i) => startChecks.has(i.name)).every((i) => i.ok);
