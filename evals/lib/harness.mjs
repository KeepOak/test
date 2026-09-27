/**
 * What every eval task is handed: its own engine (fresh data folder, fresh workspace, the eval's own port), the model
 * connection it is judged on, and a few honest helpers. Tasks score real outcomes (files, diffs, engine GET routes, test
 * exit codes); `judge` is only for what no machine check can see, with its rubric in evals/judge-rubric.md.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { startEngine } from "./engine.mjs";
import { connectModel } from "./models.mjs";

export async function makeContext({ task, model, root, port, judge, log }) {
  const ctx = {
    task, model, root, port, runs: [], notes: [], judged: [], engine: null, clockOffsetMs: 0,
    get api() { return ctx.engine.api; },
    get workspace() { return ctx.engine.workspace; },
  };
  ctx.start = async (clockOffsetMs = ctx.clockOffsetMs) => {
    ctx.clockOffsetMs = clockOffsetMs;
    ctx.engine = await startEngine({ root, port, env: model.env ?? {}, clockOffsetMs });
    await ctx.engine.api("onboarding", { skipped: true, welcomed: true }).catch(() => undefined);
    await connectModel(ctx.engine, model);
    return ctx.engine;
  };
  /** Stops the engine and starts it again on the same data, optionally with the clock moved on. */
  ctx.restart = async (clockOffsetMs = ctx.clockOffsetMs) => { await ctx.engine.stop(); return ctx.start(clockOffsetMs); };
  ctx.stop = async () => { if (ctx.engine) await ctx.engine.stop(); };
  ctx.file = (relative) => join(ctx.workspace, relative);
  ctx.write = async (relative, content) => { await mkdir(dirname(ctx.file(relative)), { recursive: true }); await writeFile(ctx.file(relative), content); };
  ctx.read = (relative) => readFile(ctx.file(relative), "utf8").catch(() => null);
  ctx.note = (line) => { ctx.notes.push(line); log?.(`    ${line}`); };
  ctx.ask = (prompt, options = {}) => ask(ctx, prompt, options);
  ctx.judge = (rubric, input) => judgeWith(ctx, judge, rubric, input);
  return ctx;
}

/**
 * One message to the engine, waited for to the end. Questions the engine asks are answered only as the task says:
 * `approve: true` says yes to each, `approve: "deny"` says no to each (both counted); otherwise the run is left waiting.
 */
async function ask(ctx, prompt, { sessionId, approve = false, attachments, timeoutMs = 900_000 } = {}) {
  let run = await ctx.api("run", { prompt, ...(sessionId ? { sessionId } : {}), ...(attachments ? { attachments } : {}) }, { timeoutMs });
  ctx.runs.push(run.id);
  const session = run.sessionId;
  let approvals = 0;
  // The engine pauses at "needs_input" for each guarded tool. A caller answers, then re-sends the same task in the
  // session, which now proceeds because the yes is remembered for the session (the pattern in tests/approvals.test.mjs).
  for (let round = 0; round < 8 && run.status === "needs_input"; round++) {
    const waiting = ((await ctx.api("policy")).waiting ?? []).filter((q) => q.sessionId === session);
    if (!waiting.length || !approve) break;
    approvals++;
    const decision = approve === "deny" ? "deny" : "allow";
    await ctx.api("policy/approve", { sessionId: session, decision, remember: "session",
      ...(waiting[0].fingerprint ? { fingerprint: waiting[0].fingerprint } : {}) }, { timeoutMs });
    if (decision === "deny") { run = (await ctx.api(`runs/${run.id}`)).run; break; } // a no ends the task; nothing to resume
    run = await ctx.api("run", { prompt, sessionId: session }, { timeoutMs });
    if (run.id && !ctx.runs.includes(run.id)) ctx.runs.push(run.id);
  }
  return { ...run, sessionId: session, approvals, answer: run.output ?? "" };
}

/** Tokens the task's runs used, as the engine recorded them (the service's own count where it gave one). */
export async function tokensUsed(ctx) {
  let total = 0, reported = true;
  for (const id of ctx.runs) {
    const usage = (await ctx.api(`runs/${id}`).catch(() => null))?.usage;
    if (!usage) continue;
    if (usage.reports) total += (usage.reportedInput ?? 0) + (usage.reportedOutput ?? 0);
    else { total += (usage.estimatedInput ?? 0) + (usage.estimatedOutput ?? 0); reported = false; }
  }
  return { tokens: total, estimated: !reported };
}

async function judgeWith(ctx, judge, rubric, input) {
  if (!judge) return { pass: false, reason: "no judge model is available for this run", unavailable: true };
  const verdict = await judge(rubric, input);
  ctx.judged.push({ rubric, ...verdict });
  return verdict;
}
