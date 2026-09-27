import { writeFile } from "node:fs/promises";
import { createBranch } from "../index.js";
import { DemoProvider } from "../demo.js";
import { defaultPreset } from "../providers.js";
import { startServer } from "../server.js";
import { gatewayContract } from "./contract.js";
import { formatOf } from "./migrations.js";
import { recoverAfterRestart } from "./resume.js";

/**
 * The check a new version must pass before it replaces the old one. It runs as that new version,
 * on a copy of the owner's data (so its format changes are tried on the copy), and it needs no
 * network: it opens the saved work, answers on its address, runs a task on the copy (answered by a scripted
 * test stand-in, never offered as a model, so no model service is asked), loads every chat adapter, lets the
 * timed jobs tick, and picks up an interrupted task.
 */
import type { SelfTestCheck, SelfTestReport } from "./canary.js";
export type { SelfTestCheck, SelfTestReport } from "./canary.js";

const channelModules = ["telegram", "discord", "slack", "whatsapp", "email", "matrix", "signal-cli", "meta-graph", "webhook-chat"];

async function check(checks: SelfTestCheck[], name: string, work: () => Promise<string>): Promise<void> {
  try { checks.push({ name, ok: true, detail: await work() }); }
  catch (error) { checks.push({ name, ok: false, detail: (error instanceof Error ? error.message : String(error)).slice(0, 300) }); }
}

type Branch = Awaited<ReturnType<typeof createBranch>>;

async function interruptedTask(app: Branch): Promise<string> {
  const run = app.store.createRun(app.runtime.owner, "self-test: carry on after a restart");
  const call = { id: "self-test-look", name: "files.list", arguments: JSON.stringify({ path: "." }) };
  app.store.message(run.sessionId, { role: "assistant", content: "", toolCalls: [call] });
  app.neverBreak.journal.begin({ runId: run.id, sessionId: run.sessionId, callId: call.id, tool: call.name,
    arguments: call.arguments, key: "self-test", effects: "none", evidence: null });
  app.store.finish(run.id, "interrupted", "self-test");
  const [report] = await recoverAfterRestart({ store: app.store, runtime: app.runtime, journal: app.neverBreak.journal, mode: "on",
    only: new Set([run.id]) });
  if (report?.outcome !== "resumed") throw new Error(`the interrupted task was ${report?.outcome ?? "not found"}`);
  await report.resumed;
  const done = app.store.runs(app.runtime.owner).some((one) => one.id !== run.id && one.status === "completed" && one.sessionId === run.sessionId);
  if (!done) throw new Error("the interrupted task did not finish");
  return "an interrupted task carried on and finished";
}

/**
 * The copy holds the owner's real schedules, webhooks and interrupted tasks. None of them may act from
 * here: timed jobs are paused on the copy, and nothing is announced to the owner's webhooks.
 */
export function quietCopy(app: Pick<Branch, "store" | "runtime">): void {
  app.runtime.notifyEvent = () => undefined;
  app.store.sqlite.prepare("UPDATE schedules SET data=json_set(data,'$.status','paused','$.pausedBecause','self-test') WHERE json_extract(data,'$.status') IN ('pending','running')").run();
}

async function checksOn(app: Branch, dataDir: string, checks: SelfTestCheck[]): Promise<void> {
  quietCopy(app);
  await check(checks, "runs a task on a copy of your data", async () => {
    const run = await app.runtime.run({ prompt: "Self-test: say hello.", onTextDelta: () => undefined });
    if (run.status !== "completed") throw new Error(`the task ended ${run.status}: ${run.output.slice(0, 200)}`);
    return "a task finished";
  });
  await check(checks, "loads every chat adapter", async () => {
    for (const name of channelModules) {
      const loaded = await import(`../channels/${name}.js`) as Record<string, unknown>;
      if (!Object.values(loaded).some((value) => typeof value === "function")) throw new Error(`${name} has nothing to start`);
    }
    return `${channelModules.length} adapters load`;
  });
  await check(checks, "lets timed jobs tick", async () => { await app.scheduler.tick(); return "the scheduler ticked"; });
  await check(checks, "picks up interrupted work", () => interruptedTask(app));
  // Last: closing the address also closes the engine's task runner.
  await check(checks, "answers on its address", async () => {
    const server = await startServer(app, { dataDir, port: 0 });
    try {
      const response = await fetch(`${server.url}/api/health`, { headers: { authorization: `Bearer ${server.token}` }, signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`the health check answered ${response.status}`);
      return "the health check answered";
    } finally { await server.close(); }
  });
}

export async function selfTest(input: { dataDir: string; workspace: string; version: string }): Promise<SelfTestReport> {
  const checks: SelfTestCheck[] = [];
  let app: Branch | null = null;
  await check(checks, "opens the saved work", async () => {
    app = await createBranch({ dataDir: input.dataDir, workspace: input.workspace, presets: [defaultPreset(new DemoProvider())] });
    return `format ${formatOf(app.store.sqlite).version}`;
  });
  const opened = app as Branch | null;
  let format: number | null = null;
  if (opened) {
    format = formatOf(opened.store.sqlite).version;
    try { await checksOn(opened, input.dataDir, checks); } finally { await opened.close(); }
  }
  return { ok: checks.every((one) => one.ok), version: input.version, contract: gatewayContract.speaks, format, checks };
}

/** `branch start` with BRANCH_SELF_TEST set: run the check, write the report there, and stop. */
export async function selfTestCommand(reportPath: string, input: { dataDir: string; workspace: string; version: string }): Promise<void> {
  const report = await selfTest(input);
  await writeFile(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(report.checks.map((one) => `${one.ok ? "ok  " : "FAIL"} ${one.name}: ${one.detail}`).join("\n"));
  process.exitCode = report.ok ? 0 : 1;
}

