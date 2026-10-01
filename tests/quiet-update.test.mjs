import { processRunning } from "./process-running.mjs";
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
import { activeDeadline, BuildGate, descendants, pauseReason, posixHold, typingQuietMs, watchForOwner, windowsHold } from "../dist/desktop/quiet-build.js";
import { readFile } from "node:fs/promises";
import { realRun, RunError } from "../dist/desktop/dev-build.js";
import { runHostedBuild, runHostedLiveBuild } from "../dist/desktop/build-client.js";
import { Updater, UpdateDeferredError } from "../dist/desktop/updater.js";

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

test("keys pressed in Branch's window and tasks at work pause the install, and nothing is left listening after it", async () => {
  const listeners = new Set(), said = [];
  const window = { isDestroyed: () => false, webContents: { on: (_name, fn) => listeners.add(fn), off: (_name, fn) => listeners.delete(fn) } };
  let working = 0;
  const stop = watchForOwner(window, { setPaused: (reason) => said.push(reason) }, async () => working, 10, 10);
  try {
    await wait(30);
    assert.equal(said.at(-1), null, "nothing going on");
    for (const fn of listeners) fn({}, { type: "keyUp" });
    await wait(30);
    assert.equal(said.at(-1), null, "only a key going down counts");
    for (const fn of listeners) fn({}, { type: "keyDown" });
    await wait(30);
    assert.equal(said.at(-1), "typing");
    working = 1;
    await wait(30);
    assert.equal(said.at(-1), "typing", "typing wins while it lasts");
  } finally { stop(); }
  assert.equal(said.at(-1), null, "the install ended: nothing waits any more");
  assert.equal(listeners.size, 0, "and the window is not listened to");
  const sender = await readFile(new URL("../src/desktop/updater-ipc.ts", import.meta.url), "utf8");
  assert.match(sender, /const key = JSON\.stringify\(\[[^\]]*status\.paused\]\)/, "a pause starting or ending is sent to the window at once");
});

test("a task at work pauses the install, and only while the engine says so", async () => {
  const said = [];
  const window = { isDestroyed: () => false, webContents: { on: () => undefined, off: () => undefined } };
  let answers = true;
  const stop = watchForOwner(window, { setPaused: (reason) => said.push(reason) }, async () => { if (!answers) throw new Error("the engine did not answer"); return 2; }, 10, 10);
  try {
    await wait(40);
    assert.equal(said.at(-1), "task");
    answers = false;
    await wait(40);
    assert.equal(said.at(-1), null, "an engine that stops answering never holds the install on an old count");
  } finally { stop(); }
});

test("the gate holds the next program while paused, suspends a pausable one in place and lets it go again", async () => {
  const calls = [];
  const hold = { pause: async (pid) => calls.push(`pause ${pid}`), resume: async (pid) => calls.push(`resume ${pid}`), end: async (pid) => { calls.push(`end ${pid}`); } };
  const gate = new BuildGate(hold);
  gate.started(11, true);
  gate.started(12, false);
  await gate.set(true);
  assert.deepEqual(calls, ["pause 11"], "only the program that may be is suspended; a download is left to finish");
  await wait(30);
  assert.ok(gate.heldMs(11) >= 25, "its time held is kept");
  assert.equal(gate.heldMs(12), 0, "its time goes on counting");
  let started = false;
  const next = gate.ready().then(() => { started = true; });
  await wait(20);
  assert.equal(started, false, "the next program does not start while paused");
  gate.started(13, true);
  await wait(0);
  assert.deepEqual(calls, ["pause 11", "pause 13"], "one that starts during a pause is held at once");
  await gate.set(false);
  await next;
  assert.equal(started, true);
  assert.deepEqual(calls.slice(2), ["resume 11", "resume 13"]);
  gate.ended(11);
  await gate.endAll();
  assert.deepEqual(calls.slice(4), ["end 12", "end 13"], "the app going away ends what is still running");
});

test("a pause and a going-on that overlap end in the state asked for last", async () => {
  // Holding is slow on Windows (a look at the process list each time); the second change must not finish first.
  const applied = [];
  const hold = { pause: async (pid) => { await wait(60); applied.push(`pause ${pid}`); }, resume: async (pid) => { await wait(5); applied.push(`resume ${pid}`); }, end: async () => undefined };
  const gate = new BuildGate(hold);
  gate.started(21, true);
  const first = gate.set(true), second = gate.set(false);
  await Promise.all([first, second]);
  assert.equal(applied.at(-1), "resume 21", `going on is what holds at the end (${applied.join(", ")})`);
  const third = gate.set(true), fourth = gate.set(false), fifth = gate.set(true);
  await Promise.all([third, fourth, fifth]);
  assert.equal(applied.at(-1), "pause 21", "and a pause asked for last holds");
});

test("a time limit counts only the time a program was not held", () => {
  let clock = 0, held = 0, expired = 0;
  const ticks = [];
  const realSetInterval = globalThis.setInterval;
  globalThis.setInterval = (fn) => { ticks.push(fn); return { unref() {} }; };
  try { activeDeadline(1_000, () => held, () => { expired++; }, 10, () => clock); } finally { globalThis.setInterval = realSetInterval; }
  const tick = (to) => { clock = to; ticks[0](); };
  tick(400);
  held = 2_000; // held for two seconds, then running again
  tick(2_900);
  assert.equal(expired, 0, "0.9 s of running under a 1 s limit: not ended, however long it was held");
  tick(3_000);
  assert.equal(expired, 1, "1 s of running: ended, once");
});

/* ---------- real programs ---------- */

const holdHere = () => (process.platform === "win32" ? windowsHold() : posixHold);

test("the build's programs are found by parent, and a process number handed on after its parent ended is not followed", () => {
  const rows = [
    { pid: 10, parent: 1, created: 100 }, // the build's program
    { pid: 11, parent: 10, created: 110 }, // npm's child
    { pid: 12, parent: 11, created: 120 }, // and tsc under it
    { pid: 13, parent: 10, created: 50 }, // started by an older program that had number 10 before: not the build's
    { pid: 14, parent: 13, created: 130 },
    { pid: 15, parent: 2, created: 105 },
  ];
  assert.deepEqual(descendants(rows, 10), [10, 11, 12]);
  assert.deepEqual(descendants(rows, 99), [], "a program that has ended holds nothing");
});

test("a paused build holds the program it runs and everything that program started, and lets them go again", { timeout: 60_000 }, async () => {
  const gate = new BuildGate(holdHere()), dir = await mkdtemp(join(tmpdir(), "quiet-"));
  try {
    // A program that starts another; both write, every 20 ms, a count and their own priority, for about 3 s.
    const report = (name) => `const fs=require("fs"),os=require("os");let n=0;const t=setInterval(()=>{fs.writeFileSync(${JSON.stringify(join(dir, "NAME"))}.replace("NAME","${name}"),++n+" "+os.getPriority());if(n>=400){clearInterval(t)}},20);`;
    const parent = `require("child_process").spawn(process.execPath,["-e",${JSON.stringify(report("child"))}],{stdio:"ignore"});${report("parent")}`;
    const done = realRun(process.platform, undefined, gate)(...node(parent), { timeoutMs: 60_000, pausable: true });
    const read = async (name) => (await import("node:fs/promises").then((fs) => fs.readFile(join(dir, name), "utf8")).catch(() => "0 0")).split(" ").map(Number);
    while ((await read("child"))[0] < 5) await wait(20);
    await gate.set(true);
    await wait(250);
    const [parentHeld, parentPriority] = await read("parent"), [childHeld, childPriority] = await read("child");
    if (process.platform === "win32") {
      // Windows cannot stop a program without native code: a held one runs only on cores nothing else wants.
      assert.equal(parentPriority, constants.priority.PRIORITY_LOW, "the program is held at the idle priority");
      assert.equal(childPriority, constants.priority.PRIORITY_LOW, "and so is the program it started");
    } else {
      await wait(400);
      assert.ok((await read("parent"))[0] - parentHeld <= 1 && (await read("child"))[0] - childHeld <= 1, "neither counts while held");
    }
    await gate.set(false);
    await wait(250);
    if (process.platform === "win32") assert.equal((await read("child"))[1], constants.priority.PRIORITY_BELOW_NORMAL, "let go, it is back below normal");
    await done;
    assert.ok((await read("parent"))[0] >= 400, "it finished its work after the pause");
  } finally { await discardTemp(dir); }
});

test("a program held past its time limit is not ended for it; one that really runs out is, with a plain reason", { timeout: 60_000 }, async () => {
  const gate = new BuildGate(holdHere());
  const run = realRun(process.platform, undefined, gate);
  // It ends 1.4 s after it starts and is held for most of that, under a 1 s limit: the limit counts only the rest.
  const done = run(...node("setTimeout(()=>console.log('built'),1400)"), { timeoutMs: 1_000, pausable: true });
  await wait(100);
  await gate.set(true);
  await wait(1_700);
  await gate.set(false);
  assert.equal((await done).trim(), "built");
  await assert.rejects(run(...node("setTimeout(()=>{},30000)"), { timeoutMs: 1_000, pausable: true }),
    (error) => error instanceof RunError && /did not finish in time/.test(error.message));
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
const { gate, lowered } = lowerBuildProcess();
const out = await realRun(process.platform, undefined, gate)("node", ["-e", "const r=require('child_process').spawnSync(process.execPath,['-e','process.stdout.write(String(require(\\"os\\").getPriority()))'],{encoding:'utf8'});process.stdout.write(r.stdout)"], { timeoutMs: 60000 });
process.send({ grandchild: Number(out), lowered });
`);
    const answer = await new Promise((resolve, reject) => {
      const one = fork(child, [], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
      one.once("message", resolve);
      one.once("exit", (code) => reject(new Error(`exited ${code}`)));
    });
    assert.equal(answer.grandchild, constants.priority.PRIORITY_BELOW_NORMAL, `the grandchild runs below every normal program (${answer.lowered})`);
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

test("the new version's check is started by a go-between, never by the app itself, and ended with it when it runs too long", { timeout: 60_000 }, async () => {
  // Windows checks a freshly built program before it starts, holding the thread that asked for about 4 s: the app's
  // own thread must not be the one asking (measured: the window froze for 2-3 s in "Checking the new version").
  const { runCanary } = await import("../dist/never-break/canary.js");
  const dir = await mkdtemp(join(tmpdir(), "quiet-canary-"));
  try {
    const engine = async (name, body) => {
      const script = join(dir, `${name}.cjs`);
      await writeFile(script, `require("node:fs").writeFileSync(${JSON.stringify(join(dir, `${name}.pid`))}, JSON.stringify({ pid: process.pid, parent: process.ppid }));\n${body}`);
      return { executable: process.execPath, script };
    };
    const copy = async (name) => { const data = join(dir, name, "data"); await import("node:fs/promises").then((fs) => fs.mkdir(data, { recursive: true })); return data; };
    const pass = await engine("pass", `require("node:fs").writeFileSync(process.env.BRANCH_SELF_TEST, JSON.stringify({ ok: true, version: "2.0.0", contract: 1, format: 1, checks: [] }));`);
    const good = await runCanary({ engine: pass, dataCopy: await copy("a"), expectedVersion: "2.0.0" });
    assert.equal(good.ok, true, good.detail);
    const started = JSON.parse(await import("node:fs/promises").then((fs) => fs.readFile(join(dir, "pass.pid"), "utf8")));
    assert.notEqual(started.parent, process.pid, "the app's own process did not start it");
    const hang = await engine("hang", "setInterval(() => {}, 1000);");
    const slow = await runCanary({ engine: hang, dataCopy: await copy("b"), timeoutMs: 1_500 });
    assert.match(slow.detail, /it took too long and was stopped/);
    const { pid } = JSON.parse(await import("node:fs/promises").then((fs) => fs.readFile(join(dir, "hang.pid"), "utf8")));
    let alive = true;
    for (let i = 0; i < 50 && alive; i++) { try { alive = processRunning(pid); if (alive) await wait(100); } catch { alive = false; } }
    assert.equal(alive, false, "the new version stopped with it");
    const gone = await runCanary({ engine: { executable: join(dir, "no-such-program.exe"), script: pass.script }, dataCopy: await copy("c") });
    assert.match(gone.detail, /did not finish its check \(it could not be started: /);
  } finally { await discardTemp(dir); }
});

test("the owner changing their mind while the install waits or builds gives it back as a wait, however long a task works", async () => {
  const updater = new Updater({ repo: "stabrea/Branch-Agent", currentVersion: "0.19.4", installDir: null, executableName: "Branch Agent.exe",
    assetName: "Branch-Agent-windows-x64.zip", scratchDir: join(tmpdir(), "never-used") });
  updater.callOff("Update by itself was turned off, so this update is not installed.");
  await updater.untilUnpaused(); // no install under way: nothing to call off
  Object.assign(updater, { busy: true, stages: [{ id: "checking", state: "running", startedAt: new Date().toISOString(), endedAt: null }] });
  updater.setPaused("task");
  const waiting = updater.untilUnpaused();
  updater.callOff("Update by itself was turned off, so this update is not installed.");
  await assert.rejects(waiting, (error) => error instanceof UpdateDeferredError && /turned off/.test(error.message), "the wait ends as a wait, not a failure");
  await assert.rejects(updater.untilUnpaused(), UpdateDeferredError, "and every later step stops there too");
  const ipc = await readFile(new URL("../src/desktop/updater-ipc.ts", import.meta.url), "utf8");
  assert.match(ipc, /const why = changedMind\(state, started\);\s*if \(why\) updater\.callOff\(why\);/, "the app looks for a changed mind each time it counts the tasks");
});

test("a build in its own process can be stopped, and says so", { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "quiet-host-"));
  try {
    // A stand-in for the build's process: lowered and listening, then it builds for ever until its channel closes.
    const script = join(dir, "host.cjs");
    await writeFile(script, `process.send({ type: "quiet", lowered: "stand-in" });
process.on("message", () => undefined);
process.on("disconnect", () => process.exit(1));
setInterval(() => {}, 1000);`);
    const hosted = runHostedBuild({ repo: "stabrea/Branch-Agent", buildDir: dir, commit: "a".repeat(40), running: null, assetName: "x", onStage: () => undefined },
      { log: join(dir, "build.log"), script });
    assert.equal(await hosted.lowered, "stand-in");
    hosted.stop();
    await assert.rejects(hosted.done, (error) => error instanceof RunError && /stopped before it finished/.test(error.message));
  } finally { await discardTemp(dir); }
});

test("a build paused before its host is ready receives the pause before the plan", { timeout: 30_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "quiet-host-order-"));
  try {
    const script = join(dir, "host.cjs");
    await writeFile(script, `const messages = [];
process.on("message", (message) => {
  messages.push(message.type);
  if (message.type === "build") process.send({ type: "done", built: { messages } });
});
process.on("disconnect", () => process.exit(0));
process.send({ type: "quiet", lowered: "stand-in" });`);
    const hosted = runHostedBuild({ repo: "stabrea/Branch-Agent", buildDir: dir, commit: "a".repeat(40), running: null,
      assetName: "x", onStage: () => undefined }, { log: join(dir, "build.log"), script });
    hosted.pause(true);
    assert.deepEqual((await hosted.done).messages, ["pause", "build"], "the first step must already be held when the build starts");
  } finally { await discardTemp(dir); }
});

test("live builds use the paused host and preserve their parts across its JSON channel", { timeout: 30_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "quiet-live-host-"));
  try {
    const script = join(dir, "host.cjs");
    await writeFile(script, `let paused = false;
process.on("message", (message) => {
  if (message.type === "pause") paused = message.paused;
  if (message.type === "live-build") process.send({ type: "done", built: { tier: "engine", parts: ["engine", "window"], paused } });
});
process.on("disconnect", () => process.exit(0));
process.send({ type: "quiet", lowered: "stand-in" });`);
    const hosted = runHostedLiveBuild({ repo: "stabrea/Branch-Agent", buildDir: dir, commit: "a".repeat(40), running: null,
      packaged: null, engineAt: null, windowAt: null, appRoot: dir, onStage: () => undefined }, { log: join(dir, "build.log"), script });
    hosted.pause(true);
    const outcome = await hosted.done;
    assert.equal(outcome.paused, true, "the live plan receives the same pre-start pause");
    assert.ok(outcome.parts instanceof Set, "JSON IPC must restore the parts used by classification");
    assert.deepEqual([...outcome.parts], ["engine", "window"]);
  } finally { await discardTemp(dir); }
});

test("calling off a live build stops its host and releases the update as a wait", async () => {
  let rejectBuild, stopped = false;
  const build = new Promise((_resolve, reject) => { rejectBuild = reject; });
  const updater = new Updater({ repo: "stabrea/Branch-Agent", currentVersion: "0.19.4", installDir: null,
    executableName: "Branch Agent.exe", assetName: "Branch-Agent-windows-x64.zip", scratchDir: join(tmpdir(), "never-used"),
    live: { build: () => build, apply: async () => { throw new Error("a cancelled build must never apply"); },
      stop: () => { stopped = true; rejectBuild(new Error("host stopped")); } } });
  Object.assign(updater, { busy: true });
  const updating = updater.tryLive({ channel: "beta", commit: "a".repeat(40), available: true, latestVersion: "0.19.5" });
  updater.callOff("Update by itself was turned off, so this update is not installed.");
  await assert.rejects(updating, UpdateDeferredError);
  assert.equal(stopped, true);
  assert.equal(updater.status.phase, "available", "a changed choice is a wait, not a failed update");
  assert.equal(updater.status.failure, null);
});
