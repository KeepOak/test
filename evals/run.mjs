/**
 * Runs the eval suite end to end through a real engine with a real model, scores real outcomes, and writes a JSON +
 * Markdown scorecard with a trend. Never a paid API.
 *
 *   node evals/run.mjs --model ollama            the best tool-capable local model (default)
 *   node evals/run.mjs --model ollama:qwen2.5:3b a named local model
 *   node evals/run.mjs --model claude-code       a subscription CLI (words-only tasks)
 *   node evals/run.mjs --model standin --smoke   the smoke subset, scripted, no real model
 *   node evals/run.mjs --only edit-file,refuse-unsafe   just these tasks
 *   node evals/run.mjs --out <dir>               where the scorecard goes (default evals/results)
 */
import { mkdir, rm } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describeModel, preflight, warmRemote } from "./lib/models.mjs";
import { makeModelJudge } from "./lib/judge.mjs";
import { makeContext, tokensUsed } from "./lib/harness.mjs";
import { stopAllEngines } from "./lib/engine.mjs";
import { startStandin } from "./lib/standin.mjs";
import { previousRun, scorecardJson, scorecardMarkdown, summarise, writeScorecard } from "./lib/report.mjs";
import { allTasks, smokeTasks } from "./tasks/index.mjs";

const evalsDir = fileURLToPath(new URL("./", import.meta.url));

function parseArgs(argv) {
  const args = { model: "ollama", out: join(evalsDir, "results"), smoke: false, only: null, basePort: 0 };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--model") args.model = argv[++i];
    else if (flag === "--out") args.out = argv[++i];
    else if (flag === "--smoke") args.smoke = true;
    else if (flag === "--only") args.only = argv[++i].split(",").map((s) => s.trim()).filter(Boolean);
    else if (flag === "--base-port") args.basePort = Number(argv[++i]);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const startedAt = new Date().toISOString();

  // The stand-in model runs for the smoke subset only; it proves the plumbing, never a model's quality.
  let standin = null, standinPort = 0;
  if (args.model === "standin") {
    standin = await startStandin(0, () => ({ text: "" })); // the script is set per task
    standinPort = standin.port;
  }
  const model = await describeModel(args.model, { standinPort });

  let tasks = args.smoke ? smokeTasks() : allTasks();
  if (args.only) tasks = tasks.filter((t) => args.only.includes(t.id));

  // One preflight: a model that cannot answer at all marks its tasks, rather than failing each in turn.
  let modelBlock = model.unavailable ?? null;
  if (!modelBlock && model.kind !== "standin") {
    await warmRemote(model);
    // Started fresh every run, as each task's own engine is: kept, it gained one model connection a run until the engine's
    // cap of 32 refused the next ("At most 32 model presets") and every task read as "needs local model".
    const preflightRoot = join(scratch(args), "preflight");
    await rm(preflightRoot, { recursive: true, force: true });
    const probe = await makeContext({ task: { id: "preflight" }, model, root: preflightRoot, port: args.basePort });
    try { await probe.start(); modelBlock = await preflight(probe.engine); } catch (error) { modelBlock = `model did not start: ${error.message}`; }
    finally { await probe.stop().catch(() => undefined); }
  }

  const judge = modelBlock || model.kind === "standin" ? null : await makeModelJudge().catch(() => null);
  const results = [];
  for (const task of tasks) {
    const result = await runOne({ task, model, modelBlock, standin, args, judge });
    results.push(result);
    process.stdout.write(`  ${pad(result.status)} ${task.id}  ${result.ms ? Math.round(result.ms / 1000) + "s" : ""} ${result.detail ? "— " + result.detail : ""}\n`);
  }

  const finishedAt = new Date().toISOString();
  const current = scorecardJson({ model: { id: model.id, label: model.label }, startedAt, finishedAt, results, host: hostname() });
  await mkdir(args.out, { recursive: true });
  const previous = await previousRun(args.out, `${finishedAt.slice(0, 10)}.json`);
  const { jsonPath, mdPath } = await writeScorecard(args.out, current, previous);
  process.stdout.write("\n" + scorecardMarkdown(current, previous) + "\n");
  process.stdout.write(`\nWrote ${jsonPath}\n      ${mdPath}\n`);
  if (standin) await standin.close();

  const summary = summarise(results);
  // A run "succeeds" when the harness itself held together; a low pass rate is a real result, not a crash.
  const brokeHarness = results.some((r) => r.status === "harness-error");
  process.exitCode = brokeHarness ? 1 : 0;
  return summary;
}

async function runOne({ task, model, modelBlock, standin, args, judge }) {
  const base = { id: task.id, area: task.area, title: task.title };
  // A task that needs Branch to call tools cannot be judged on a words-only CLI model.
  if (task.needsTools && !model.branchTools) return { ...base, status: "n/a", reason: "this model answers in words only (cli-agent by design)", ms: 0 };
  if (modelBlock) return { ...base, status: statusFor(modelBlock), reason: modelBlock, ms: 0 };

  const root = join(scratch(args), task.id);
  await rm(root, { recursive: true, force: true });
  const port = 0; // each engine binds a port the system picks as it starts (no gap for another program to take it)
  if (standin && task.script) standin.script = task.script; // the stand-in answers this task's script
  const ctx = await makeContext({ task, model: standinModel(model, standin), root, port, judge, log: () => undefined });
  const started = Date.now();
  try {
    await withTimeout(ctx.start(), 90_000, "engine start");
    const outcome = await withTimeout(task.run(ctx), task.timeoutMs ?? 300_000, "task");
    const usage = await tokensUsed(ctx).catch(() => ({ tokens: null, estimated: false }));
    const checks = outcome.checks ?? [];
    const status = outcome.status ?? (checks.length && checks.every((c) => c.ok) ? "pass" : "fail");
    return { ...base, status, ms: Date.now() - started, tokens: usage.tokens, tokensEstimated: usage.estimated,
      detail: outcome.detail ?? "", reason: outcome.reason ?? "", checks };
  } catch (error) {
    const timedOut = error?.evalTimeout;
    return { ...base, status: timedOut ? "timeout" : "harness-error", ms: Date.now() - started,
      detail: (error?.message ?? String(error)).slice(0, 200), reason: timedOut ? "exceeded the per-task cap" : "" };
  } finally {
    await ctx.stop().catch(() => undefined);
  }
}

/** The stand-in is wired as an env model, but its port is already in the model's env. */
function standinModel(model, standin) { return model; }

function statusFor(block) { return /sign ?in/i.test(block) ? "needs sign-in" : "needs local model"; }
function scratch(args) { return process.env.EVAL_SCRATCH ?? join(evalsDir, ".scratch"); }
function pad(s) { return (s + "        ").slice(0, 8); }

function withTimeout(promise, ms, what) {
  let timer;
  const cap = new Promise((_, reject) => { timer = setTimeout(() => { const e = new Error(`${what} exceeded ${ms} ms`); e.evalTimeout = true; reject(e); }, ms); });
  return Promise.race([promise, cap]).finally(() => clearTimeout(timer));
}

// Exit once the scorecard is written, whatever is still open: a stray engine or socket must never keep a night waiting.
main().then(() => { stopAllEngines(); process.exit(); }, (error) => { console.error(error); stopAllEngines(); process.exit(1); });
