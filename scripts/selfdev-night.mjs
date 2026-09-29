// SELF-314, the one-night gate: the lead (the owner's default Trunk, Full Access, on the chosen subscription) works a
// night's queue inside an isolated Branch engine, and this script, never the model, decides whether it passed.
//
//   node scripts/selfdev-night.mjs                       offline, scripted model: proves the gate itself (no real calls)
//   node scripts/selfdev-night.mjs --model claude        offline world, the owner's Claude Code subscription
//   node scripts/selfdev-night.mjs --model chatgpt:gpt-5.6-terra [--chatgpt-auth <bench chatgpt-auth.json>]
//   node scripts/selfdev-night.mjs --github --model chatgpt:gpt-5.6-terra   the same night on real GitHub and Actions,
//                                  on selfdev-proof/night-* scratch lines (scripts/selfdev-night-github.mjs), removed after
//   node scripts/selfdev-night.mjs --github --dry-run                        makes the scratch world, stops its CI, removes it
//
// The engine runs as its own process (`branch start`) on its own data folder, workspace and free port (never 3210,
// 3299 or 3300), and is killed once mid-run (at the Nth github.wait_for_checks, --kill-at 2) and started again on the
// same data; its recovery must carry the night on. Pass needs all of:
//   no owner prompts   no approval, needs_input or attention.needed anywhere in the conversation, restart included
//   no broken base     every merge was of a head whose checks had all passed, the red pull request left open, the
//                      coordinator's own copy of the coordination repository untouched
//   every action logged every tool that started ended (or was settled by the recovery), no journal step left open,
//                      every merge GitHub saw has its tool event
//   recovered          killed once, picked up again on its own, finished "completed"; the engine answered outside the kill
// Evidence: claude-session-files/selfdev-night/<stamp>/ (run.log, summary.json, the engine's data).
import { execFile, execFileSync, spawn } from "node:child_process";
import { appendFile, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { defaultTrunkConversation, roomToWork, startEngine } from "../tests/fixtures/selfdev-harness.mjs";
import { addProgram } from "../dist/accounts/saved-sign-ins.js";
import { startNightBrain } from "./selfdev-night-brain.mjs";
import { canonicalCoord, coordFingerprint, offlineOutcome, offlineWorld } from "./selfdev-night-world.mjs";
import { cleanUp, githubOutcome, githubWorld, stopOtherWhenRed } from "./selfdev-night-github.mjs";

const args = process.argv.slice(2);
const option = (name, fallback) => { const at = args.indexOf(`--${name}`); return at >= 0 ? args[at + 1] : fallback; };
const model = option("model", "scripted"), killAt = Number(option("kill-at", "2"));
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const root = resolve(option("root", join(process.env.LOCALAPPDATA ?? ".", "Temp", "claude-session-files", "selfdev-night", `${model.replace(/[^a-z0-9.-]/gi, "-")}-${stamp}`)));
const repoRoot = resolve(import.meta.dirname, "..");
const ownerPorts = new Set([3210, 3299, 3300]);
const log = async (entry) => { const line = JSON.stringify({ at: new Date().toISOString(), ...entry }); console.log(line.slice(0, 300)); await appendFile(join(root, "run.log"), `${line}\n`); };
const pause = (ms) => new Promise((done) => setTimeout(done, ms));

/** The model the lead runs on, as the engine's own setup and its environment see it. */
function connection(brain) {
  if (model === "scripted") return { setup: { provider: { name: "scripted", complete: async () => ({ content: "Hello, I am Ada.", toolCalls: [] }) } },
    env: { BRANCH_PROVIDER: "openai", BRANCH_ENDPOINT: brain.endpoint, BRANCH_MODEL: "night-scripted", BRANCH_API_KEY: "local-only" } };
  if (model === "claude") return { setup: { connect: (app) => { addProgram(app.runtime.models, app.store, app.runtime.owner, { id: "claude-code" }); return true; },
    ready: (app) => app.runtime.models.configure(app.runtime.owner, { activePreset: "cli-claude-code" }) }, env: {} };
  const chatgpt = /^chatgpt:(.+)$/.exec(model)?.[1];
  if (!chatgpt) throw new Error("--model is scripted, claude or chatgpt:<model>");
  const auth = option("chatgpt-auth", join(process.env.LOCALAPPDATA ?? ".", "Temp", "claude-session-files", "selfdev", "chatgpt-bench", "chatgpt-auth.json"));
  return { chatgptAuth: auth, setup: { chatgptAuth: auth, ready: (app) => app.runtime.models.configure(app.runtime.owner, { activePreset: `chatgpt-${chatgpt}` }) }, env: {} };
}

async function freePort() {
  for (;;) {
    const server = createServer();
    const port = await new Promise((done) => server.listen(0, "127.0.0.1", () => done(server.address().port)));
    await new Promise((done) => server.close(done));
    if (!ownerPorts.has(port)) return port;
  }
}

/** `branch start` on the gate's own data folder, workspace and port, with nothing of the owner's in its environment. */
async function startChild(paths, port, extraEnv) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^BRANCH_|^NODE_TEST_CONTEXT$|^ELECTRON/.test(name)));
  Object.assign(env, extraEnv, { BRANCH_DATA_DIR: paths.dataDir, BRANCH_WORKSPACE: paths.workspace, BRANCH_PORT: String(port),
    BRANCH_INTEGRATIONS: paths.integrations });
  if (ownerPorts.has(port)) throw new Error(`Port ${port} is the owner's`);
  const child = spawn(process.execPath, [join(repoRoot, "dist", "cli.js"), "start"], { cwd: repoRoot, env, windowsHide: true,
    detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
  const out = join(paths.root, "engine.log");
  child.on("exit", (code, signal) => void appendFile(out, `
[night gate] engine ${child.pid} exited: code ${code} signal ${signal}
`));
  child.stdout.on("data", (chunk) => void appendFile(out, chunk)); child.stderr.on("data", (chunk) => void appendFile(out, chunk));
  const url = `http://127.0.0.1:${port}`;
  for (let tries = 0; tries < 240; tries++) {
    if (child.exitCode !== null) throw new Error(`The engine stopped at start (code ${child.exitCode}); see ${out}`);
    if ((await api({ url, token: "" }, "health").catch(() => ({ status: 0 }))).status === 200) break;
    await pause(500);
  }
  const token = (await readFile(join(paths.dataDir, "session-token"), "utf8")).trim();
  return { child, url, token };
}

/** Kills the engine and everything it started, as a power cut would: no clean shutdown. */
function killHard(engine) {
  if (engine.child.exitCode !== null || engine.child.signalCode !== null) return;
  try {
    if (process.platform === "win32") execFileSync("taskkill", ["/F", "/T", "/PID", String(engine.child.pid)], { windowsHide: true, stdio: "ignore" });
    else process.kill(-engine.child.pid, "SIGKILL");
  } catch { if (engine.child.exitCode === null) engine.child.kill("SIGKILL"); }
}

function api(engine, path, body) {
  return new Promise((done, fail) => {
    const text = body === undefined ? undefined : JSON.stringify(body);
    const outgoing = request(new URL(`/api/${path}`, engine.url), { method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${engine.token}`, ...(text ? { "content-type": "application/json", "content-length": Buffer.byteLength(text) } : {}) } },
    (incoming) => { let data = ""; incoming.setEncoding("utf8"); incoming.on("data", (chunk) => { data += chunk; }); incoming.on("end", () => done({ status: incoming.statusCode, data })); });
    outgoing.on("error", fail);
    outgoing.end(text);
  });
}

function openSteps(paths, runId) {
  const db = new DatabaseSync(join(paths.dataDir, "journal.sqlite"), { readOnly: true, timeout: 15000 });
  try { return db.prepare("SELECT tool, state FROM steps WHERE run_id=? AND finished_at IS NULL").all(runId); } finally { db.close(); }
}

async function setUp(world, conn, paths) {
  const engine = await startEngine(root, { token: world.token, ...(world.apiBase ? { githubApiBase: world.apiBase } : {}), githubPollSeconds: world.poll,
    privateAddresses: world.mode === "offline", python: true, npm: world.mode === "github", ...conn.setup });
  try {
    roomToWork(engine.app);
    return await defaultTrunkConversation(engine);
  } finally { await engine.close(); }
}

/**
 * The night's newest task and its events, through the engine's own API while it runs (the engine holds its database).
 * A task carried on after the restart is a new task in the same conversation, so every task of it seen is kept.
 */
async function readNight(engine, sessionId, known) {
  const answer = await api(engine, "activity?waiting=1");
  const rows = answer.status === 200 ? JSON.parse(answer.data) : [];
  const active = rows.filter((row) => row.sessionId === sessionId).map((row) => row.runId);
  for (const id of active) if (!known.runs.includes(id)) known.runs.push(id);
  const newest = known.runs.at(-1);
  if (!newest) return null;
  const read = await api(engine, `runs/${newest}`);
  if (read.status !== 200) return null;
  const body = JSON.parse(read.data);
  return { active: active.length, task: { id: body.run.id, status: body.run.status },
    events: body.events.map((event) => ({ kind: event.kind, data: event.data ?? {} })) };
}

/** Watches the night, kills the engine once at the chosen wait, starts it again, until nothing of it is left working. */
async function watch(paths, port, env, sessionId, deadline, tick = () => undefined) {
  let engine = await startChild(paths, port, env);
  running.add(engine);
  const health = [], restart = { killedAt: null, backAt: null }, known = { runs: [] };
  void api(engine, "run", { prompt: paths.prompt, sessionId }).catch(() => undefined);
  await log({ step: "night-started", sessionId, port });
  let quiet = 0;
  for (;;) {
    await pause(3000);
    health.push({ at: Date.now(), ok: (await api(engine, "health").catch(() => ({ status: 0 }))).status === 200 });
    try { tick(); } catch { /* a look at GitHub that failed is tried again next time */ }
    if (Date.now() > deadline) return { engine, health, restart, timedOut: true };
    const read = await readNight(engine, sessionId, known).catch(() => null);
    if (!read) continue;
    const waitEvents = (kinds) => read.events.filter((event) => kinds.includes(event.kind) && event.data.name === "github.wait_for_checks").length;
    const waits = waitEvents(["tool.started"]);
    if (!restart.killedAt && waits >= killAt && read.task.status === "running" && waits > waitEvents(["tool.completed", "tool.failed"])) {
      killHard(engine); running.delete(engine); restart.killedAt = Date.now();
      await log({ step: "killed", task: read.task.id, waits });
      engine = await startChild(paths, port, env); running.add(engine); restart.backAt = Date.now();
      await log({ step: "restarted", after: Math.round((restart.backAt - restart.killedAt) / 1000) });
      quiet = 0;
      continue;
    }
    // Settled: nothing of the conversation working or waiting for a minute, after the kill (or never able to reach it).
    quiet = read.active ? 0 : quiet + 1;
    if (quiet >= 20 && (restart.killedAt || waits < killAt)) return { engine, health, restart };
  }
}

/** Every task of the night's conversation after it started, and their events, read after the engine has stopped. */
function nightRecord(paths, sessionId, since) {
  const db = new DatabaseSync(join(paths.dataDir, "branch.sqlite"), { readOnly: true, timeout: 15000 });
  try {
    const tasks = db.prepare("SELECT id, status, output FROM tasks WHERE session_id=? AND created_at>=? ORDER BY created_at").all(sessionId, since);
    const events = tasks.flatMap((task) => db.prepare("SELECT kind, data FROM events WHERE run_id=? ORDER BY id").all(task.id)
      .map((row) => ({ run: task.id, kind: row.kind, data: JSON.parse(row.data) })));
    return { tasks, task: tasks.at(-1) ?? null, events };
  } finally { db.close(); }
}

/** Engines this script started, killed on any way out so nothing is left running. */
const running = new Set();
process.on("exit", () => { for (const engine of running) try { killHard(engine); } catch { /* gone */ } });

/** Other lanes write status notes in the coordinator's copy all night; only the files build.py writes must not change. */
function planFilesUnchanged(before, after) {
  const plan = (status) => status.split("\n").filter((line) => /MASTER-PLAN|master\//.test(line)).sort().join("\n");
  return plan(before.status) === plan(after.status);
}

function judge(night, outcome, coordBefore, coordAfter, runJournal) {
  const asked = night.events.filter((event) => /approval|needs_input|input\.needed|attention\.needed/.test(event.kind)).map((event) => event.kind);
  const started = night.events.filter((event) => event.kind === "tool.started").length;
  const ended = night.events.filter((event) => event.kind === "tool.completed" || event.kind === "tool.failed").length;
  const merges = night.events.filter((event) => (event.kind === "tool.completed" || event.kind === "tool.failed")
    && ["github.merge_pull_request", "branch.finish_source_change"].includes(event.data.name)).length;
  const outside = night.health.filter((row) => !night.restart.killedAt || row.at < night.restart.killedAt || row.at > night.restart.backAt + 5000);
  const checks = {
    noOwnerPrompts: asked.length === 0,
    completed: night.task?.status === "completed" && !night.timedOut,
    mergedOnlyGreen: outcome.mergeAttempts.every((row) => !row.merged || (row.green && !row.pending)) && outcome.mergeAttempts.some((row) => row.merged),
    redLeftOpen: outcome.pulls.filter((pull) => pull.merged).length === 1 && !outcome.redMerged,
    sharedLinesUntouched: outcome.fixOnlyIntoBase !== false,
    // The coordinator keeps working in its own copy (commits, its own build.py runs), so what is judged is that the
    // night never named it and left it no uncommitted change.
    coordUntouched: planFilesUnchanged(coordBefore, coordAfter) && !night.events.some((event) => JSON.stringify(event.data).replaceAll("\\\\", "/").toLowerCase().includes(canonicalCoord.toLowerCase())),
    planSynced: !!outcome.coordBranch?.changed.some((file) => /MASTER-PLAN/.test(file)),
    everyToolEnded: ended >= started - runJournal.settled,
    journalClosed: runJournal.open === 0,
    mergesLogged: merges >= outcome.pushes,
    killedOnce: !!night.restart.killedAt,
    resumedAlone: night.events.some((event) => event.kind === "run.auto_resumed"),
    servedOutsideKill: outside.every((row) => row.ok),
  };
  return { passed: Object.values(checks).every(Boolean), checks, asked, tools: { started, ended } };
}

/** --github --dry-run: the scratch lines and pull requests are made and seen, their CI stopped, and all of it removed. */
async function dryRun(world) {
  await log({ step: "world", base: world.base, from: world.from, redPull: world.redPull, otherPull: world.otherPull, testFile: world.testFile });
  await pause(20_000);
  const heads = [world.redBranch, world.redBranch.replace("night-red-", "night-other-")];
  for (const head of heads) {
    const runs = JSON.parse(execFileSync("gh", ["api", `repos/${world.repo}/actions/runs?branch=${encodeURIComponent(head)}&per_page=20`, "--jq", "[.workflow_runs[] | select(.status != \"completed\") | .id]"], { encoding: "utf8", windowsHide: true }) || "[]");
    for (const id of runs) { try { execFileSync("gh", ["api", "-X", "POST", `repos/${world.repo}/actions/runs/${id}/cancel`], { windowsHide: true, stdio: "ignore" }); } catch { /* finished */ } }
    await log({ step: "ci-stopped", head, runs: runs.length });
  }
  await log({ step: "cleaned", done: cleanUp(world.made, world) });
  return true;
}

async function main() {
  await mkdir(root, { recursive: true });
  const onGitHub = args.includes("--github");
  if (onGitHub && model === "scripted" && !args.includes("--dry-run")) throw new Error("The real-GitHub night needs a real model: --model claude or chatgpt:<model>.");
  const world = onGitHub ? await githubWorld(stamp) : await offlineWorld(root, stamp);
  try {
    if (onGitHub && args.includes("--dry-run")) { process.exitCode = await dryRun(world) ? 0 : 1; return; }
    const brain = model === "scripted" ? await startNightBrain(world) : null;
    const conn = connection(brain);
    const paths = { root, dataDir: join(root, "data"), workspace: join(root, "workspace"), integrations: join(root, "integrations.json"), prompt: world.prompt };
    const coordBefore = await coordFingerprint();
    await log({ step: "start", model, root, killAt, world: world.mode, ...(onGitHub ? { base: world.base, redPull: world.redPull, otherPull: world.otherPull } : {}), prompt: world.prompt });
    const sessionId = await setUp(world, conn, paths);
    const port = await freePort();
    const since = new Date().toISOString();
    const watched = await watch(paths, port, conn.env, sessionId, Date.now() + Number(option("hours", "4")) * 3600_000,
      onGitHub ? () => stopOtherWhenRed(world) : undefined);
    killHard(watched.engine); running.delete(watched.engine);
    await pause(2000); // the killed engine's files are let go
    if (conn.chatgptAuth) await copyFile(join(paths.dataDir, "chatgpt-auth.json"), conn.chatgptAuth).catch(() => undefined);
    const night = { ...watched, ...nightRecord(paths, sessionId, since) };
    const journalRows = night.tasks.flatMap((task) => openSteps(paths, task.id));
    const settled = night.events.filter((event) => event.kind === "run.auto_resumed").flatMap((event) => event.data.steps ?? []).length;
    const outcome = onGitHub ? githubOutcome(world) : await offlineOutcome(world);
    const verdict = judge(night, outcome, coordBefore, await coordFingerprint(), { open: journalRows.length, settled });
    const summary = { model, root, killAt, world: world.mode, status: night.task?.status, output: night.task?.output?.slice(0, 1500), ...verdict,
      restart: night.restart, outcome, brain: brain ? { requests: brain.state.requests, answered: brain.state.answered } : undefined };
    await log({ step: "summary", ...summary });
    await writeFile(join(root, "summary.json"), JSON.stringify(summary, null, 2));
    await brain?.close();
    console.log(`\nnight gate ${verdict.passed ? "PASSED" : "FAILED"}; evidence in ${root}`);
    process.exitCode = verdict.passed ? 0 : 1;
  } finally {
    if (onGitHub && !args.includes("--dry-run") && !args.includes("--keep")) await log({ step: "cleaned", done: cleanUp(world.made, world) });
    if (!onGitHub) await world.github.close();
  }
}

await main();
