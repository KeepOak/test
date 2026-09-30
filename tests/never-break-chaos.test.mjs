/**
 * Never breaks: chaos. The engine and the gateway are killed at random points in a scripted task,
 * the gateway's settings are filled with rubbish, and the disk fills up part-way through — and every
 * time Branch comes back and either finishes the work or asks the owner, never doing something that
 * reaches outside twice. An update cut off after every line is in never-break-update.test.mjs.
 *
 * Quick by default (a few seeds, for CI). BRANCH_CHAOS_SEEDS=200 runs the long set. Only temporary
 * folders and processes this file starts; each seed's numbers are printed so a failure can be replayed.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { GatewayConfigSchema, loadGatewayConfig, promoteGood, saveGatewayConfig } from "../dist/never-break/gateway-config.js";

const seeds = Math.max(1, Number(process.env.BRANCH_CHAOS_SEEDS ?? 3));
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("BRANCH_") && name !== "NODE_OPTIONS"));
const script = resolve("tests/fixtures/never-break-task.mjs");

/** A small repeatable random source (mulberry32). */
function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}
const plan = [
  { id: "a", tool: "chaos.look", args: { n: 1 } },
  { id: "b", tool: "files.write", args: { path: "one.txt", content: "first" } },
  { id: "c", tool: "chaos.send", args: { n: 2 } },
  { id: "d", tool: "chaos.look", args: { n: 3 } },
  { id: "e", tool: "files.write", args: { path: "two.txt", content: "second" } },
  { id: "f", tool: "chaos.send", args: { n: 4 } },
];
const env = (extra = {}) => ({ ...cleanEnv(), CHAOS_PLAN: JSON.stringify(plan), CHAOS_DELAY: "40", ...extra });
const text = (path) => readFile(path, "utf8").catch(() => "");
async function until(check, what, ms = 60000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const value = await check(); if (value) return value; await delay(40); }
  assert.fail(`timed out waiting for ${what}`);
}
async function folder(t, seed) {
  const root = await mkdtemp(join(tmpdir(), `branch-never-chaos-${seed}-`));
  t.after(() => discardTemp(root));
  await mkdir(join(root, "data"), { recursive: true });
  await saveGatewayConfig(join(root, "data"), GatewayConfigSchema.parse({ mode: "on" }));
  return root;
}
const exited = (child) => new Promise((done) => { if (child.exitCode !== null || child.signalCode !== null) done(); else child.once("exit", () => done()); });
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; } };

/**
 * What must be true however the task was cut off: nothing that reaches outside happened twice; a
 * send that was cut off before it could be recorded was asked about, not repeated; and the work
 * either finished, with every effect in place, or waits for the owner. It never just fails.
 */
async function checkOutcome(root, result, label) {
  const outbox = (await text(join(root, "outbox.log"))).trim().split("\n").filter(Boolean);
  for (const n of [2, 4]) assert.ok(outbox.filter((line) => line === `sent ${n}`).length <= 1, `${label}: send ${n} happened twice: ${outbox}`);
  const statuses = result.runs.map((run) => run.status);
  assert.ok(!statuses.includes("failed"), `${label}: a task failed: ${JSON.stringify(result.runs)}`);
  const finished = result.runs.some((run) => run.status === "completed" && run.output === "all done");
  const asked = result.runs.some((run) => run.status === "needs_input" && (
    /may already have happened/.test(run.output)
    || (/The original task's Trunk scope is unavailable.*Reconcile it before continuing/.test(run.output)
      && result.report.some((entry) => entry.runId === run.id && entry.outcome === "asked"))));
  assert.ok(finished || asked, `${label}: neither finished nor asked: ${JSON.stringify(result.runs)} ${JSON.stringify(result.report)}`);
  if (finished) {
    const seen = `${JSON.stringify(result.report)} ${JSON.stringify(result.steps)}`;
    assert.deepEqual(outbox, ["sent 2", "sent 4"], `${label}: both sends happened exactly once: ${seen}`);
    assert.equal(await text(join(root, "workspace", "one.txt")), "first", `${label}: one.txt was written: ${seen}`);
    assert.equal(await text(join(root, "workspace", "two.txt")), "second", `${label}: two.txt was written: ${seen}`);
  }
  const how = result.report.map((one) => one.outcome).join("+") || "no-restart-needed";
  return `${finished ? "finished" : "asked"}(${how})`;
}

test(`the engine killed at random points in a task comes back and finishes or asks (${seeds} seeds)`, async (t) => {
  const outcomes = [];
  for (let seed = 1; seed <= seeds; seed++) {
    const next = random(seed * 7919);
    const root = await folder(t, seed);
    const worker = spawn(process.execPath, [script, root, "work"], { env: env(), stdio: ["ignore", "ignore", "inherit"] });
    t.after(() => { if (worker.exitCode === null) worker.kill("SIGKILL"); });
    await until(async () => (await text(join(root, "calls.log"))).includes("run "), "the task to start");
    const wait = Math.floor(next() * 700);
    await delay(wait);
    worker.kill("SIGKILL");
    await exited(worker);
    const recover = spawn(process.execPath, [script, root, "recover"], { env: env(), stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    recover.stdout.on("data", (chunk) => { out += chunk; });
    await exited(recover);
    const result = JSON.parse(out.trim().split("\n").pop());
    outcomes.push(`${seed}:${wait}ms:${await checkOutcome(root, result, `seed ${seed}, killed after ${wait} ms`)}`);
  }
  t.diagnostic(outcomes.join(" "));
});

test(`the gateway killed at random points in a task comes back and finishes or asks (${seeds} seeds)`, async (t) => {
  const gatewayScript = resolve("tests/fixtures/never-break-chaos-gateway.mjs");
  const outcomes = [];
  for (let seed = 1; seed <= seeds; seed++) {
    const next = random(seed * 104729);
    const root = await folder(t, `gw${seed}`);
    const first = spawn(process.execPath, [gatewayScript, root], { env: env(), stdio: ["ignore", "pipe", "inherit"] });
    t.after(() => { if (first.exitCode === null) first.kill("SIGKILL"); });
    let said = "";
    first.stdout.on("data", (chunk) => { said += chunk; });
    const { worker } = JSON.parse(await until(() => said.split("\n").find((line) => line.startsWith("{")), "the first engine"));
    await until(async () => (await text(join(root, "calls.log"))).includes("run "), "the task to start");
    const wait = Math.floor(next() * 700);
    await delay(wait);
    first.kill("SIGKILL");
    await exited(first);
    await until(() => !alive(worker), "the orphaned engine to close itself", 30000);

    const second = spawn(process.execPath, [gatewayScript, root], { env: env(), stdio: ["ignore", "ignore", "inherit"] });
    t.after(() => { if (second.exitCode === null) second.kill("SIGKILL"); });
    // The file can be seen before it is written in full, so wait until it reads as a whole answer.
    const result = await until(async () => {
      const resultFile = (await readdir(root)).find((name) => name.startsWith("result-"));
      if (!resultFile) return null;
      try { return JSON.parse(await text(join(root, resultFile))); } catch { return null; }
    }, "the work to settle", 120000);
    second.kill("SIGTERM");
    await exited(second);
    outcomes.push(`${seed}:${wait}ms:${await checkOutcome(root, result, `seed ${seed}, gateway killed after ${wait} ms`)}`);
  }
  t.diagnostic(outcomes.join(" "));
});

test(`rubbish in the gateway's settings never stops it starting (${seeds * 20} tries)`, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-never-chaos-config-"));
  t.after(() => discardTemp(root));
  const good = GatewayConfigSchema.parse({ mode: "on", holdSeconds: 11 });
  for (let trial = 0; trial < seeds * 20; trial++) {
    const next = random(trial + 1);
    const withGood = trial % 2 === 0;
    const dataDir = join(root, `try-${trial}`);
    await mkdir(dataDir, { recursive: true });
    if (withGood) await promoteGood(dataDir, good);
    const valid = JSON.stringify({ mode: "on", holdSeconds: 3, startSeconds: 30 });
    const bytes = Buffer.from(valid);
    // Flip, cut or replace a few bytes, the way a half-written or hand-edited file goes wrong.
    const kind = Math.floor(next() * 3);
    const broken = kind === 0 ? bytes.subarray(0, Math.floor(next() * bytes.length))
      : kind === 1 ? Buffer.from(bytes.map((byte) => (next() < 0.1 ? Math.floor(next() * 256) : byte)))
      : Buffer.from(JSON.stringify({ mode: "on", workerEnv: { PATH: "/evil" }, startSeconds: -1 }));
    await writeFile(join(dataDir, "gateway.json"), broken);
    const loaded = await loadGatewayConfig(dataDir);
    assert.ok(GatewayConfigSchema.safeParse(loaded.config).success, `try ${trial}: the settings in use are valid`);
    if (loaded.problem) assert.equal(loaded.config.holdSeconds, withGood ? 11 : 20, `try ${trial}: ${loaded.problem}`);
  }
});

test(`a disk that fills up part-way stops the task cleanly, never doing a step it did not record (${seeds * 3} tries)`, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-never-chaos-disk-"));
  t.after(() => discardTemp(root));
  for (let trial = 0; trial < seeds * 3; trial++) {
    const next = random(trial + 31);
    const after = Math.floor(next() * 10);
    const done = [];
    let round = 0;
    const provider = { name: "scripted", async complete() {
      round++;
      return round <= 4 ? { content: "", toolCalls: [{ id: `s${round}`, name: "chaos.send", arguments: JSON.stringify({ n: round }) }] } : { content: "all done", toolCalls: [] };
    } };
    const app = await createBranch({ workspace: join(root, `w${trial}`), dataDir: join(root, `d${trial}`), provider });
    try {
      app.registry.register({ name: "chaos.send", permission: "chaos.send", description: "send", parameters: z.object({ n: z.number() }).strict(),
        execute: async ({ n }) => { done.push(n); return { sent: n }; } });
      let writes = 0;
      app.neverBreak.journal.failWrites = () => (++writes > after ? new Error("ENOSPC: no space left on device") : null);
      const run = await app.runtime.run({ prompt: "send four", onTextDelta: () => undefined });
      // A call whose intent was written but whose start could not be is recorded as never started.
      const recorded = app.neverBreak.journal.steps(run.id).filter((step) => step.kind === "tool" && step.state !== "intent").length;
      assert.equal(done.length, recorded, `try ${trial} (full after ${after} writes): every step that ran was recorded first`);
      if (run.status !== "completed") assert.match(run.output, /disk may be full/, `try ${trial}`);
      else assert.deepEqual(done, [1, 2, 3, 4]);
      app.neverBreak.journal.failWrites = null;
      assert.equal((await app.runtime.run({ prompt: "and again", onTextDelta: () => undefined })).status, "completed", "Branch keeps working once there is room");
    } finally { await app.close(); }
  }
});
