// The never-break half of scripts/selfdev-proof.mjs (--candidate): while an isolated engine keeps serving, two
// candidate builds of Branch's own source are made in throwaway worktrees of this checkout's HEAD, the way Beta
// builds a merged change (src/desktop/dev-build.ts), without packaging an executable:
//   - a self-edit with a syntax error: its build fails, so nothing is there to swap in;
//   - a self-edit that compiles but breaks the engine as it starts: the canary on a copy of the data refuses it;
//   - the same source unchanged: its build passes and its engine passes the canary self-test on a copy of the
//     running engine's data (src/never-break/canary.ts), the check a candidate must pass before any swap.
// The running engine answers /api/health throughout and still finishes a task afterwards. A failing test is
// refused one step earlier, at the merge (tests/self-development-e2e.test.mjs and the --broken run).
import { execFile } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { startEngine } from "../tests/fixtures/selfdev-harness.mjs";
import { runCanary, snapshotData } from "../dist/never-break/canary.js";

const run = promisify(execFile);
const repo = resolve(import.meta.dirname, "..");
const npm = [process.execPath, join(process.execPath, "..", "node_modules", "npm", "bin", "npm-cli.js")];

async function step(cwd, command, args, timeout = 900_000) {
  try { await run(command, args, { cwd, windowsHide: true, timeout, maxBuffer: 64 << 20 }); return { ok: true }; }
  catch (error) { return { ok: false, detail: String(error.stderr || error.stdout || error.message).split(/\r?\n/).filter(Boolean).slice(-6).join(" | ").slice(0, 600) }; }
}

async function candidate(root, name, edit, log) {
  const folder = join(root, name);
  await run("git", ["worktree", "add", "--detach", folder, "HEAD"], { cwd: repo, windowsHide: true });
  if (edit) await edit(folder);
  const install = await step(folder, npm[0], [npm[1], "ci", "--ignore-scripts", "--no-audit", "--no-fund"]);
  const build = install.ok ? await step(folder, npm[0], [npm[1], "run", "build"]) : { ok: false, detail: "packages did not install" };
  await log({ step: "candidate-build", name, install: install.ok, build: build.ok, detail: build.detail });
  return { folder, build };
}

export async function candidateProof({ root, stamp, log, health }) {
  const provider = { name: "scripted", async complete() { return { content: "Still here.", toolCalls: [] }; } };
  const engine = await startEngine(join(root, "running"), { token: `fake-${stamp}`, githubApiBase: "http://127.0.0.1:9/", privateAddresses: true, provider });
  const results = [], poller = setInterval(() => void health(engine, results), 1000);
  const made = [];
  try {
    const canary = async (folder) => runCanary({ engine: { executable: process.execPath, script: join(folder, "dist", "cli.js") },
      dataCopy: await snapshotData({ dataDir: engine.dataDir, database: engine.app.store.sqlite }), timeoutMs: 300_000 });
    // 1. A syntax error: the build fails, and Beta (dev-build.ts) stops there; nothing is offered to swap in.
    const syntax = await candidate(root, "candidate-syntax-error", async (folder) => {
      const file = join(folder, "src", "knobs", "apply.ts");
      await writeFile(file, `${await readFile(file, "utf8")}
export function broken( {
`);
    }, log);
    made.push(syntax.folder);
    // 2. A change that compiles but breaks the engine as it starts: the canary on a copy of the running data refuses it.
    const crash = await candidate(root, "candidate-breaks-at-start", async (folder) => {
      const file = join(folder, "src", "cli.ts");
      await writeFile(file, `${await readFile(file, "utf8")}
throw new Error("This candidate breaks on purpose as it starts.");
`);
    }, log);
    made.push(crash.folder);
    const crashCanary = crash.build.ok ? await canary(crash.folder) : null;
    await log({ step: "candidate-canary", name: "candidate-breaks-at-start", ok: crashCanary?.ok ?? null, detail: crashCanary?.detail });
    // 3. The source unchanged: it builds and passes the canary, so it may swap in.
    const good = await candidate(root, "candidate-unchanged", null, log);
    made.push(good.folder);
    const goodCanary = good.build.ok ? await canary(good.folder) : null;
    await log({ step: "candidate-canary", name: "candidate-unchanged", ok: goodCanary?.ok ?? null, detail: goodCanary?.detail,
      checks: goodCanary?.report?.checks?.map((check) => `${check.ok ? "ok" : "FAIL"} ${check.name}`) });
    const after = await engine.api("run", { prompt: "Are you still there?" });
    await health(engine, results);
    const summary = { mode: "candidate", syntaxErrorBuild: syntax.build.ok, syntaxErrorBuildDetail: syntax.build.detail,
      breaksAtStartBuild: crash.build.ok, breaksAtStartCanary: crashCanary ? { ok: crashCanary.ok, detail: crashCanary.detail } : null,
      goodBuild: good.build.ok, goodCanary: goodCanary ? { ok: goodCanary.ok, detail: goodCanary.detail } : null,
      runningEngineAfter: after.body?.status, health: { checks: results.length, allOk: results.every((status) => status === 200) } };
    const passed = !summary.syntaxErrorBuild && summary.breaksAtStartBuild && summary.breaksAtStartCanary?.ok === false
      && summary.goodBuild && summary.goodCanary?.ok === true && summary.runningEngineAfter === "completed" && summary.health.allOk;
    await log({ step: "summary", passed, ...summary });
    await writeFile(join(root, "summary.json"), JSON.stringify({ passed, ...summary }, null, 2));
    return passed;
  } finally {
    clearInterval(poller);
    await engine.close();
    for (const folder of made) {
      await run("git", ["worktree", "remove", "--force", folder], { cwd: repo, windowsHide: true }).catch(() => undefined);
      await rm(folder, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
    }
  }
}
