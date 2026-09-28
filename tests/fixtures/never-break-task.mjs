/**
 * A whole Branch in a process of its own, working through a scripted plan of tool calls, so a test
 * can kill it at any moment and start it again on the same folder. Refuses to run outside a
 * temporary folder. No network, no real model, no window.
 *
 *   node never-break-task.mjs <root> work      works through CHAOS_PLAN, one tool call a round
 *   node never-break-task.mjs <root> recover   opens the same folder, settles what was cut off, prints JSON
 *   node never-break-task.mjs <root> gateway   run by a gateway: settles what was cut off, or starts the plan
 *                                              if nothing was ever started; writes result.json when settled
 *
 * CHAOS_KILL_AT kills the process at an exact point instead of at a random moment: "saved:<call id>"
 * just after the model's request for that call is saved to the conversation, "result:<call id>"
 * just before that call's result is saved, or "partial:<call id>" after files.write truncates its file.
 *
 * CHAOS_PLAN is a JSON list of { id, tool, args }. Tools: chaos.look (only looks), chaos.send
 * (reaches "outside": appends to outbox.log), and the real files.write.
 */
import { appendFileSync, realpathSync } from "node:fs";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { createServer } from "node:http";
import { writeFileSync, existsSync } from "node:fs";
import { createBranch } from "../../dist/index.js";
import { joinGateway } from "../../dist/never-break/worker-link.js";

const [root, phase] = process.argv.slice(2);
if (!realpathSync(resolve(root)).startsWith(realpathSync(tmpdir()))) { console.error("refusing: not a temporary folder"); process.exit(9); }
const plan = JSON.parse(process.env.CHAOS_PLAN ?? "[]");
const pause = phase !== "recover" ? Number(process.env.CHAOS_DELAY ?? 20) : 0;
const log = (file, line) => appendFileSync(join(root, file), `${line}\n`);

/** The next step is the first one the conversation holds no settled result for. */
function nextCall(messages) {
  const results = new Map(messages.filter((m) => m.role === "tool").map((m) => [m.toolCallId, JSON.parse(m.content)]));
  const settled = new Set([...results].filter(([, result]) => result.ok !== false && result.status !== "not-done").map(([id]) => id));
  const asked = messages.filter((m) => m.role === "assistant").flatMap((m) => m.toolCalls ?? []).map((c) => c.id);
  for (const step of plan) {
    const ids = asked.filter((id) => id === step.id || id.startsWith(`${step.id}~`));
    if (ids.some((id) => settled.has(id))) continue;
    const failed = results.get(ids.at(-1));
    if (failed?.ok === false && failed.status !== "not-done") {
      if (step.tool !== "files.write" || !/read .* with files.read first|Read it again with files.read/.test(failed.error ?? ""))
        throw new Error(`scripted step failed: ${JSON.stringify(failed)}`);
      // A cut-off write can leave a partial file. The real guard still requires a fresh read before
      // replacing it, so this model reads and retries instead of treating the refusal as success.
      const readId = `read-${step.id}~${ids.length}`;
      if (!settled.has(readId)) return { id: readId, name: "files.read", arguments: JSON.stringify({ path: step.args.path }) };
    }
    const id = ids.length ? `${step.id}~${ids.length}` : step.id;
    return { id, name: step.tool, arguments: JSON.stringify(step.args ?? {}) };
  }
  return null;
}
const provider = { name: "scripted", async complete(request) {
  const call = nextCall(request.messages);
  return call ? { content: "", toolCalls: [call] } : { content: "all done", toolCalls: [] };
} };

const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
app.registry.register({ name: "chaos.look", permission: "files.read", description: "Look at something.",
  parameters: z.object({ n: z.number() }).strict(),
  execute: async ({ n }) => { log("calls.log", `look ${n}`); await delay(pause); return { seen: n }; } });
app.registry.register({ name: "chaos.send", permission: "chaos.send", description: "Send something to somebody.",
  parameters: z.object({ n: z.number() }).strict(),
  execute: async ({ n }) => { log("calls.log", `send ${n}`); await delay(pause); log("outbox.log", `sent ${n}`); await delay(pause); return { sent: n }; } });

/** Kills this process at the point CHAOS_KILL_AT names (see the top of this file). */
function killAtExactPoint() {
  const [point, callId] = (process.env.CHAOS_KILL_AT ?? "").split(":");
  if (!point || !callId) return;
  const save = app.store.message.bind(app.store);
  const kill = () => { log("calls.log", `killed at ${point}:${callId}`); process.kill(process.pid, "SIGKILL"); };
  if (point === "partial") {
    const step = plan.find((one) => one.id === callId && one.tool === "files.write");
    if (!step) throw new Error("partial kill needs a files.write step");
    const target = resolve(root, "workspace", step.args.path);
    const open = fsPromises.open;
    fsPromises.open = async (path, ...args) => {
      const handle = await open(path, ...args);
      if (resolve(String(path)) === target) {
        const truncate = handle.truncate.bind(handle);
        handle.truncate = async (...values) => { await truncate(...values); kill(); };
      }
      return handle;
    };
    syncBuiltinESMExports();
  }
  app.store.message = (sessionId, message, ...rest) => {
    if (point === "result" && message.role === "tool" && message.toolCallId === callId) kill();
    save(sessionId, message, ...rest);
    if (point === "saved" && message.role === "assistant" && (message.toolCalls ?? []).some((call) => call.id === callId)) kill();
  };
}

/** A full disk after this many journal writes, when CHAOS_FULL_AFTER is set. */
function fillDiskLater() {
  const after = Number(process.env.CHAOS_FULL_AFTER ?? -1);
  if (after < 0) return;
  let writes = 0;
  app.neverBreak.journal.failWrites = () => (++writes > after ? Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" }) : null);
}
const summary = (report) => ({
  report: report.map(({ resumed, ...rest }) => rest),
  runs: app.store.runs("local").filter(r => r.prompt === "work through the plan").map((r) => ({ id: r.id, status: r.status, output: r.output })),
  steps: Object.fromEntries(app.store.runs("local").map((r) => [r.id, app.neverBreak.journal.steps(r.id)])),
});
const work = () => app.runtime.run({ prompt: "work through the plan", onTextDelta: () => undefined, onStarted: (r) => log("calls.log", `run ${r.id}`) });

if (phase === "work") {
  fillDiskLater();
  killAtExactPoint();
  const run = await work();
  console.log(JSON.stringify({ status: run.status, output: run.output, ...summary([]) }));
  await app.close();
} else if (phase === "recover") {
  const report = await app.neverBreak.recoverOnStart(join(root, "data"));
  await Promise.all(report.map((r) => r.resumed));
  console.log(JSON.stringify(summary(report)));
  await app.close();
} else {
  // Under a gateway: say where we listen, close when asked or when the gateway goes away.
  const link = joinGateway();
  const server = createServer((request, response) => response.end("{}"));
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  let closing = false;
  link?.onStop(async () => { closing = true; server.close(); server.closeAllConnections(); await app.close(); });
  link?.ready(server.address().port, "chaos");
  const started = existsSync(join(root, "calls.log"));
  const report = await app.neverBreak.recoverOnStart(join(root, "data"));
  await Promise.all(report.map((r) => r.resumed));
  if (!started) await work();
  if (!closing) writeFileSync(join(root, `result-${process.pid}.json`), JSON.stringify(summary(report)));
}
