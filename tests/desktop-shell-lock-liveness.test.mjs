/* Actual shell-lock default probe, simulated platforms and signals only; no real process is signalled. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { shellLockName, takeShellLock } from "../dist/desktop/shell-lock.js";

const ownerPid = 999001, nextPid = 999002;
async function fixture(t, { platform = "linux", state = "S", signalError, procError, raw } = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-shell-liveness-"));
  t.after(() => discardTemp(root));
  const path = join(root, shellLockName);
  await writeFile(path, JSON.stringify({ pid: ownerPid, at: new Date().toISOString() }));
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  assert.ok(descriptor.configurable, "fixture requires a restorable platform descriptor");
  Object.defineProperty(process, "platform", { ...descriptor, value: platform });
  const signals = [], reads = [];
  t.mock.method(process, "kill", (pid, signal) => {
    signals.push([pid, signal]);
    assert.equal(pid, ownerPid); assert.equal(signal, 0);
    if (signalError) throw Object.assign(new Error(signalError), { code: signalError });
    return true;
  });
  t.mock.method(fs, "readFileSync", (at, encoding) => {
    reads.push(at); assert.equal(at, `/proc/${ownerPid}/stat`); assert.equal(encoding, "utf8");
    if (procError) throw Object.assign(new Error(procError), { code: procError });
    return raw ?? `${ownerPid} (Branch (worker) ) Z 1\nname) ${state} 1 0 0\n`;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); Object.defineProperty(process, "platform", descriptor); });
  return { path, signals, reads, take: () => takeShellLock(root, { pid: nextPid, waitMs: 0, settleMs: 0,
    sleep: async () => {} }) };
}

for (const state of ["Z", "X"]) test(`Linux ${state}: an exited owner relinquishes its shell lock without termination`, async (t) => {
  const f = await fixture(t, { state });
  const lock = await f.take();
  assert.equal(lock.held, true, "signal zero alone must not retain an exited zombie/dead owner");
  assert.equal(JSON.parse(await readFile(f.path, "utf8")).pid, nextPid);
  assert.deepEqual(f.signals, [[ownerPid, 0]]);
  // Release must retain a lock now owned by somebody else.
  await writeFile(f.path, JSON.stringify({ pid: 999003 }));
  await lock.release();
  assert.equal(JSON.parse(await readFile(f.path, "utf8")).pid, 999003);
});

for (const state of ["R", "S", "D", "T", "t", "I"]) test(`Linux ${state}: a live owner remains exclusive`, async (t) => {
  const f = await fixture(t, { state });
  assert.deepEqual(await f.take(), { held: false, by: ownerPid });
  assert.equal(JSON.parse(await readFile(f.path, "utf8")).pid, ownerPid);
  assert.deepEqual(f.signals, [[ownerPid, 0]]);
});

for (const options of [{ signalError: "EPERM" }, { procError: "ENOENT" }, { procError: "EACCES" },
  { raw: "malformed" }, { raw: `${ownerPid} (Branch) ? 1` }, { raw: `42 (Branch) Z 1` }])
  test(`unknown owner liveness remains exclusive: ${JSON.stringify(options)}`, async (t) => {
    const f = await fixture(t, options);
    assert.deepEqual(await f.take(), { held: false, by: ownerPid });
    assert.equal(JSON.parse(await readFile(f.path, "utf8")).pid, ownerPid);
    if (options.signalError) assert.deepEqual(f.reads, []);
  });

for (const platform of ["darwin", "win32"]) test(`${platform}: successful signal probe retains the lock without Linux reads`, async (t) => {
  const f = await fixture(t, { platform, state: "Z" });
  assert.deepEqual(await f.take(), { held: false, by: ownerPid });
  assert.deepEqual(f.reads, []);
});

test("a missing owner retains existing dead-process takeover behavior", async (t) => {
  const f = await fixture(t, { signalError: "ESRCH" });
  const lock = await f.take();
  assert.equal(lock.held, true); assert.deepEqual(f.reads, []);
  await lock.release();
  await assert.rejects(readFile(f.path), { code: "ENOENT" });
});
