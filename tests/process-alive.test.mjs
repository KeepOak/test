import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { processAlive } from "../dist/install/process-alive.js";
import { quitRunning } from "../dist/install/quit.js";
import { stopBackgroundEngine } from "../dist/install/background-engine.js";
import { writeRunning, readRunning } from "../dist/install/running.js";

const pid = 999001;
const stat = (state, comm = "branch") => `${pid} (${comm}) ${state} 1 0 0 0\n`;
function probes(t, read = () => stat("S"), error) {
  const signals = [];
  t.mock.method(process, "kill", (target, signal) => {
    signals.push([target, signal]);
    if (error) throw Object.assign(new Error(error), { code: error });
    return true;
  });
  t.mock.method(fs, "readFileSync", (path, encoding) => {
    assert.equal(path, `/proc/${pid}/stat`);
    assert.equal(encoding, "utf8");
    return read();
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  return signals;
}

for (const state of ["R", "S", "D", "T", "t", "I", "Z", "X"]) {
  test(`signal-zero success with proc state ${state}`, (t) => {
    const signals = probes(t, () => stat(state, "Branch (worker) ) Z 1\nname"));
    assert.equal(processAlive(pid), process.platform !== "linux" || !["Z", "X"].includes(state));
    assert.deepEqual(signals, [[pid, 0]]);
  });
}
for (const error of ["ESRCH", "EPERM", "EINVAL"]) {
  test(`signal-zero ${error} retains existing semantics and does not read procfs`, (t) => {
    probes(t, () => { assert.fail("no procfs read after a failed probe"); }, error);
    assert.equal(processAlive(pid), error === "EPERM");
  });
}
for (const value of ["", "garbage", `${pid} (branch) Z`, `${pid} (branch) Z bad`, "42 (branch) Z 1", `${pid} branch) Z 1`]) {
  test(`malformed proc stat stays conservatively alive: ${JSON.stringify(value)}`, (t) => {
    probes(t, () => value);
    assert.equal(processAlive(pid), true);
  });
}
for (const error of ["ENOENT", "EACCES", "EIO"]) {
  test(`unreadable proc stat ${error} stays conservatively alive`, (t) => {
    probes(t, () => { throw Object.assign(new Error(error), { code: error }); });
    assert.equal(processAlive(pid), true);
  });
}

test("the current process is alive without injected probes", () => assert.equal(processAlive(process.pid), true));

async function scratch(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-zombie-stop-"));
  t.after(() => discardTemp(root));
  await writeFile(join(root, "session-token"), "c".repeat(64));
  await writeRunning(root, { port: 3210, pid, url: "http://127.0.0.1:3210", mode: "daemon", version: "1.0.0" });
  return root;
}

test("Linux: quit observes an exited zombie after acknowledgement without waiting or force fallback", { skip: process.platform !== "linux" }, async (t) => {
  const root = await scratch(t);
  let state = "S";
  const signals = probes(t, () => stat(state));
  const report = await quitRunning(root, {
    fetch: async () => { state = "Z"; return new Response("{}"); },
    sleep: async () => { assert.fail("an exited process needs no polling delay"); },
    stopEngine: async () => { assert.fail("no fallback after graceful exit"); },
  });
  assert.deepEqual([report.stopped, report.wasRunning, report.pid], [true, true, pid]);
  assert.deepEqual(signals, [[pid, 0], [pid, 0]], "only signal-zero probes");
});

for (const door of ["close", "quit"]) {
  test(`Linux: background ${door} accepts an exited zombie without termination signals`, { skip: process.platform !== "linux" }, async (t) => {
    const root = await scratch(t);
    let state = "S";
    const signals = probes(t, () => stat(state));
    const asked = [];
    const report = await stopBackgroundEngine(root, {
      fetch: async (url) => {
        asked.push(new URL(url).pathname);
        if (!url.endsWith(`/${door}`)) return new Response("{}", { status: 400 });
        state = "Z";
        return new Response("{}");
      },
      sleep: async () => { assert.fail("no delay for an exited process"); },
      kill: () => { assert.fail("no SIGTERM or SIGKILL"); },
    });
    assert.deepEqual([report.stopped, report.forced, report.pid], [true, false, pid]);
    assert.equal(await readRunning(root), null);
    assert.equal(asked.at(-1), `/api/deployment/${door}`);
    assert.deepEqual(signals, [[pid, 0]]);
  });
}

for (const platform of ["darwin", "win32"]) {
  test(`${platform}: a successful probe never reads Linux procfs`, (t) => {
    const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { ...descriptor, value: platform });
    t.after(() => Object.defineProperty(process, "platform", descriptor));
    const signals = probes(t, () => { assert.fail("procfs is Linux-only"); });
    assert.equal(processAlive(pid), true);
    assert.deepEqual(signals, [[pid, 0]]);
  });
}
