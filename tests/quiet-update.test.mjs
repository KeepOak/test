/**
 * A background Beta build stays out of the owner's way (the owner, 2026-09-27: "when my app is in the middle of updating
 * in the background everything is slow and my computer is crying"). The build runs in a process of its own that lowers
 * itself first, so everything it starts inherits the low priority; it waits while the owner types or a task works, with
 * the program running then suspended in place when it only computes, and its time limit counting only the time it ran.
 * Real processes, hidden; no window. Node only.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { constants, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { discardTemp } from "./temp-dir.mjs";
import { activeDeadline, BuildGate, pauseReason, posixHold, typingQuietMs, WindowsQuiet } from "../dist/desktop/quiet-build.js";
import { realRun, RunError } from "../dist/desktop/dev-build.js";
import { runHostedBuild } from "../dist/desktop/build-client.js";
import { Updater } from "../dist/desktop/updater.js";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const node = (code) => ["node", ["-e", code]];

test("the build waits while the owner types, for a few seconds after the last key, and while a task works", () => {
  const now = 1_000_000;
  assert.equal(pauseReason({ now, lastKeyAt: null, workingTasks: 0 }), null, "nothing going on: it goes on");
  assert.equal(pauseReason({ now, lastKeyAt: now - 100, workingTasks: 0 }), "typing");
  assert.equal(pauseReason({ now, lastKeyAt: now - typingQuietMs + 1, workingTasks: 0 }), "typing", "a pause between words is still typing");
  assert.equal(pauseReason({ now, lastKeyAt: now - typingQuietMs, workingTasks: 0 }), null, "a few quiet seconds and it goes on");
  assert.equal(pauseReason({ now, lastKeyAt: null, workingTasks: 2 }), "task");
  assert.equal(pauseReason({ now, lastKeyAt: now - 10, workingTasks: 1 }), "typing", "the words say what the owner is doing");
});

test("the gate holds the next program while paused, suspends a pausable one in place and lets it go again", async () => {
  const calls = [];
  const hold = { pause: async (pid) => calls.push(`pause ${pid}`), resume: async (pid) => calls.push(`resume ${pid}`), end: async (pid) => { calls.push(`end ${pid}`); } };
  const gate = new BuildGate(hold);
  gate.started(11, true);
  gate.started(12, false);
  await gate.set(true);
  assert.deepEqual(calls, ["pause 11"], "only the program that may be is suspended; a download is left to finish");
  assert.equal(gate.holding(11), true);
  assert.equal(gate.holding(12), false, "its time goes on counting");
  let started = false;
  const next = gate.ready().then(() => { started = true; });
  await wait(20);
  assert.equal(started, false, "the next program does not start while paused");
  gate.started(13, true);
  assert.deepEqual(calls, ["pause 11", "pause 13"], "one that starts during a pause is held at once");
  await gate.set(false);
  await next;
  assert.equal(started, true);
  assert.deepEqual(calls.slice(2), ["resume 11", "resume 13"]);
  gate.ended(11);
  await gate.endAll();
  assert.deepEqual(calls.slice(4), ["end 12", "end 13"], "the app going away ends what is still running");
});

test("a time limit counts only the time a program was not held", async () => {
  let held = true, expired = false;
  const stop = activeDeadline(60, () => held, () => { expired = true; }, 10);
  await wait(200);
  assert.equal(expired, false, "held for longer than its limit, it is not ended");
  held = false;
  await wait(200);
  assert.equal(expired, true, "running, it is");
  stop();
});

/* ---------- real programs ---------- */

const holdHere = async () => (process.platform === "win32" ? WindowsQuiet.start() : posixHold);

test("a paused build really stops the program it runs, and it goes on from where it was", { timeout: 60_000 }, async () => {
  const hold = await holdHere();
  assert.ok(hold, "the Windows helper runs on this computer");
  const gate = new BuildGate(hold), dir = await mkdtemp(join(tmpdir(), "quiet-"));
  try {
    const counter = join(dir, "count");
    // Counts in a file every 20 ms for about 2 s of its own running time.
    const script = `const fs=require("fs");let n=0;const t=setInterval(()=>{fs.writeFileSync(${JSON.stringify(counter)},String(++n));if(n>=100){clearInterval(t)}},20)`;
    const run = realRun(process.platform, undefined, gate);
    const done = run(...node(script), { timeoutMs: 60_000, pausable: true });
    const read = async () => Number(await import("node:fs/promises").then((fs) => fs.readFile(counter, "utf8")).catch(() => "0"));
    while ((await read()) < 5) await wait(20);
    await gate.set(true);
    await wait(150);
    const held = await read();
    await wait(500);
    assert.ok((await read()) - held <= 1, `nothing counted while paused (${held} then ${await read()})`);
    await gate.set(false);
    await done;
    assert.equal(await read(), 100, "it finished its work after the pause");
  } finally { hold.close?.(); await discardTemp(dir); }
});

test("a program held past its time limit is not ended for it; one that really runs out is, with a plain reason", { timeout: 60_000 }, async () => {
  const hold = await holdHere();
  const gate = new BuildGate(hold);
  try {
    const run = realRun(process.platform, undefined, gate);
    // About 0.3 s of work, held for 1.6 s, under a 1 s limit: the limit counts the 0.3 s.
    const done = run(...node("setTimeout(()=>console.log('built'),300)"), { timeoutMs: 1_000, pausable: true });
    await wait(100);
    await gate.set(true);
    await wait(1_600);
    await gate.set(false);
    assert.equal((await done).trim(), "built");
    await assert.rejects(run(...node("setTimeout(()=>{},30000)"), { timeoutMs: 1_000, pausable: true }),
      (error) => error instanceof RunError && /did not finish in time/.test(error.message));
  } finally { hold.close?.(); }
});

test("the runner keeps a program's output, and a failure's words and key line", async () => {
  const run = realRun(process.platform);
  assert.equal((await run(...node("process.stdout.write('ok')"), { timeoutMs: 30_000 })), "ok");
  await assert.rejects(run(...node("console.error('npm error code E404');console.error('npm error 404 Not Found - GET x');process.exit(1)"), { timeoutMs: 30_000 }),
    (error) => error instanceof RunError && /^node -e did not finish: npm error 404 Not Found/.test(error.message) && error.detail === "npm error 404 Not Found - GET x");
});

test("every program the build starts, and every program those start, runs below the owner's own programs", { timeout: 60_000 }, async () => {
  // The build's own process lowers itself before anything else; this child does exactly that, then runs a program
  // that starts another, which says its own priority.
  const dir = await mkdtemp(join(tmpdir(), "quiet-"));
  try {
    const child = join(dir, "child.mjs"), dist = new URL("../dist/desktop/", import.meta.url).href;
    await writeFile(child, `import { lowerBuildProcess } from ${JSON.stringify(`${dist}quiet-build.js`)};
import { realRun } from ${JSON.stringify(`${dist}dev-build.js`)};
const { gate, quiet, lowered } = await lowerBuildProcess();
const out = await realRun(process.platform, undefined, gate)("node", ["-e", "const r=require('child_process').spawnSync(process.execPath,['-e','process.stdout.write(String(require(\\"os\\").getPriority()))'],{encoding:'utf8'});process.stdout.write(r.stdout)"], { timeoutMs: 60000 });
quiet?.close();
process.send({ grandchild: Number(out), lowered });
`);
    const answer = await new Promise((resolve, reject) => {
      const one = fork(child, [], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
      one.once("message", resolve);
      one.once("exit", (code) => reject(new Error(`exited ${code}`)));
    });
    assert.equal(answer.grandchild, constants.priority.PRIORITY_BELOW_NORMAL, `the grandchild runs below every normal program (${answer.lowered})`);
    if (process.platform === "win32") assert.match(answer.lowered, /io=0 memory=True eco=True/, "and with low I/O and memory priority, on the efficient cores (0: set)");
  } finally { await discardTemp(dir); }
});

test("the build's own process says the outcome back, and a build that cannot start changes nothing", { timeout: 60_000 }, async () => {
  const stages = [];
  const hosted = runHostedBuild({ repo: "stabrea/Branch-Agent", buildDir: join(tmpdir(), "never-used"), commit: "not-a-commit", running: null,
    assetName: "Branch-Agent-windows-x64.zip", onStage: (...args) => stages.push(args) }, { log: join(tmpdir(), "never-used.log"),
    script: fileURLToPath(new URL("../dist/desktop/build-host.js", import.meta.url)) });
  await assert.rejects(hosted.done, (error) => error instanceof RunError && /not set up on this computer, so nothing was changed/.test(error.message));
  assert.match(await hosted.lowered, /^(priority|nice) /, "it lowered itself before building");
  assert.deepEqual(stages, []);
});

test("the updater says when it waits for the owner, and holds its next step until it may go on", async () => {
  const seen = [];
  const updater = new Updater({ repo: "stabrea/Branch-Agent", currentVersion: "0.19.4", installDir: null, executableName: "Branch Agent.exe",
    assetName: "Branch-Agent-windows-x64.zip", scratchDir: join(tmpdir(), "never-used"), onChange: (status) => seen.push(status) });
  updater.setPaused("typing");
  assert.equal(seen.length, 0, "with no install under way there is nothing to say");
  assert.equal(updater.status.paused, null);
  // An install under way (its steps drawn): the status says it waits, and the next step waits with it.
  Object.assign(updater, { stages: [{ id: "building", state: "running", startedAt: new Date().toISOString(), endedAt: null }] });
  updater.setPaused("task");
  assert.equal(seen.at(-1).paused, "task");
  let went = false;
  const next = updater.untilUnpaused().then(() => { went = true; });
  await wait(20);
  assert.equal(went, false);
  updater.setPaused(null);
  await next;
  assert.equal(went, true);
  assert.equal(seen.at(-1).paused, null);
});
