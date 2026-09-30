/* One Branch window per data folder (src/desktop/shell-lock.ts): Electron's own single-instance lock is kept per
   program settings folder, so two copies of Branch sharing one data folder would both open it. Stand-in process ids;
   nothing is started. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { shellLockName, takeShellLock } from "../dist/desktop/shell-lock.js";
import { gatewayDataFiles } from "../dist/never-break/protected.js";

const quick = { waitMs: 300, pollMs: 20, settleMs: 5 };

test("a second copy of Branch on the same data folder waits, then leaves; once the first quits, it takes over", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "branch-shell-lock-"));
  t.after(() => discardTemp(dir));
  const running = new Set([101, 202]);
  const alive = (pid) => running.has(pid);
  const first = await takeShellLock(dir, { pid: 101, alive, ...quick });
  assert.equal(first.held, true);
  assert.equal(JSON.parse(await readFile(join(dir, shellLockName), "utf8")).pid, 101);
  const second = await takeShellLock(dir, { pid: 202, alive, ...quick });
  assert.deepEqual(second, { held: false, by: 101 }, "the second copy leaves, naming who has it");
  // A restart: the first lets go while the second waits, and the second goes on.
  const waiting = takeShellLock(dir, { pid: 202, alive, waitMs: 5000, pollMs: 20, settleMs: 5 });
  await first.release();
  assert.equal((await waiting).held, true);
});

test("a lock left by a Branch that is gone is taken over, and the lock is one the assistant may not touch", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "branch-shell-lock-"));
  t.after(() => discardTemp(dir));
  await writeFile(join(dir, shellLockName), JSON.stringify({ pid: 999, at: new Date().toISOString() }));
  const next = await takeShellLock(dir, { pid: 303, alive: (pid) => pid === 303, ...quick });
  assert.equal(next.held, true);
  assert.ok(gatewayDataFiles.includes(shellLockName));
});

test("the window's start takes the lock on its data folder before any engine is started or joined", async () => {
  const main = await readFile(new URL("../src/desktop/main.ts", import.meta.url), "utf8");
  const start = main.slice(main.indexOf("async function start("));
  const lock = start.indexOf("await takeShellLock(dataDir)");
  assert.ok(lock > 0, "the start takes the lock");
  for (const later of ["startCrashReporter(dataDir)", "joinBackground(dataDir)", "startEngine("])
    assert.ok(start.indexOf(later) > lock, `${later} comes after the lock`);
  assert.match(start.slice(lock, lock + 400), /if \(!lock\.held\) \{[\s\S]*app\.exit\(0\);\s*return;/);
});
