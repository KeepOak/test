/* The versioned switch (src/desktop/version-switch.ts), run by the hand-over runner after the window has closed: one
   rename to switch, the new version watched, and a way back that is refused when the older version could no longer
   read the saved work. Real files in a temp folder; processes are stand-ins, so nothing is started or ended here
   (the chaos test, desktop-update-chaos.test.mjs, runs the same switch with real programs). */
import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { discardTemp } from "./temp-dir.mjs";
import { goingBackIsSafe, runSwitchPlan, switchVersion, systemDeps, SwitchPlanSchema } from "../dist/desktop/version-switch.js";
import { pointerFiles, readPointer } from "../dist/desktop/app-folders.js";
import { readSwitchFailure } from "../dist/desktop/shell-switch.js";
import { holdOpen, locksWork } from "./version-lock.mjs";

const exe = "Branch Agent.exe";
const exists = (path) => access(path).then(() => true, () => false);
async function temp(t) {
  const dir = await mkdtemp(join(tmpdir(), "branch-version-switch-"));
  t.after(() => discardTemp(dir));
  return dir;
}

/** Two versions side by side, app-1.0.0 in use, the switch to app-2.0.0 prepared as the updater prepares it. */
async function layout(t, { flatBefore = false } = {}) {
  const root = await temp(t), scratch = join(root, "scratch");
  for (const folder of ["app-1.0.0", "app-2.0.0"]) { await mkdir(join(root, folder), { recursive: true }); await writeFile(join(root, folder, exe), "stand-in"); }
  if (flatBefore) await writeFile(join(root, exe), "stand-in");
  await mkdir(scratch, { recursive: true });
  const running = flatBefore ? { folder: "", version: "1.0.0" } : { folder: "app-1.0.0", version: "1.0.0" };
  if (!flatBefore) await writeFile(join(root, "current.json"), JSON.stringify({ folder: "app-1.0.0", version: "1.0.0", previous: null, at: new Date().toISOString() }));
  const files = await pointerFiles(root, running, { folder: "app-2.0.0", version: "2.0.0" });
  const failureDraft = join(scratch, "shell-switch-failed.json.draft");
  await writeFile(failureDraft, JSON.stringify({ kept: "1.0.0", tried: "2.0.0", commit: null, at: new Date().toISOString(), message: "went back" }));
  const plan = SwitchPlanSchema.parse({ root, next: files.next, rollback: flatBefore ? null : files.rollback,
    newExe: join(root, "app-2.0.0", exe), oldExe: join(flatBefore ? root : join(root, "app-1.0.0"), exe), pid: 4242,
    marker: join(scratch, "shell-up-2.0.0"), failureDraft, failure: join(scratch, "shell-switch-failed.json"), log: join(scratch, "log"),
    minimized: true, upSeconds: 3, version: "2.0.0", kept: "1.0.0", commit: null, dataDir: join(root, "data"), understood: 3 });
  return { root, scratch, plan };
}

/** Stand-in processes: `up` says whether the new version writes its marker once started. */
function fakes(plan, { up = true, alive = () => false, format = async () => null, renameFile = rename } = {}) {
  const log = { started: [], ended: [], notes: [] };
  const deps = {
    alive, end: async (pid, tree) => { log.ended.push({ pid, tree }); },
    start: (program, args) => {
      log.started.push({ program, args });
      if (up && program === plan.newExe) void writeFile(plan.marker, "{}");
      return 7000 + log.started.length;
    },
    exists, rename: renameFile, remove: (path) => rm(path, { force: true }), write: (path, text) => writeFile(path, text),
    format, sleep: async () => undefined, note: async (line) => { log.notes.push(line); }, now: () => new Date(),
  };
  return { deps, log };
}

test("swap: the pointer names the new version in one rename, only the new version starts, and the way back is tidied", async (t) => {
  const { root, plan } = await layout(t);
  const { deps, log } = fakes(plan);
  assert.equal(await switchVersion(plan, deps), 0);
  assert.equal((await readPointer(root)).folder, "app-2.0.0");
  assert.deepEqual((await readPointer(root)).previous, { folder: "app-1.0.0", version: "1.0.0" }, "the version before is kept for going back");
  assert.deepEqual(log.started, [{ program: plan.newExe, args: ["--start-minimized"] }], "started in the tray, as the window was");
  assert.equal(await exists(plan.rollback), false);
  assert.equal(await exists(plan.failureDraft), false);
  assert.equal(await exists(join(root, "app-1.0.0", exe)), true, "nothing of the old version is touched");
});

test("a window that will not close is ended by its own process id after a minute, never by name", async (t) => {
  const { plan } = await layout(t);
  const { deps, log } = fakes(plan, { alive: () => true });
  assert.equal(await switchVersion(plan, deps), 0);
  assert.deepEqual(log.ended, [{ pid: 4242, tree: false }]);
});

test("failed swap: a new version that never comes up is ended, the old one is put back and started, and it is told why", async (t) => {
  const { root, scratch, plan } = await layout(t);
  const { deps, log } = fakes(plan, { up: false });
  assert.equal(await switchVersion(plan, deps), 1);
  assert.equal((await readPointer(root)).folder, "app-1.0.0", "the pointer names the old version again");
  assert.deepEqual(log.ended, [{ pid: 7001, tree: true }], "the one process it started, with what that started");
  assert.deepEqual(log.started.map((one) => one.program), [plan.newExe, plan.oldExe]);
  assert.equal((await readSwitchFailure(scratch, "1.0.0"))?.tried, "2.0.0", "the old version reads the note once");
  assert.equal(await exists(join(root, "app-2.0.0", exe)), true, "the new version stays whole for the next try");
});

test("rollback to a flat copy removes the pointer, as before the first switch", async (t) => {
  const { root, plan } = await layout(t, { flatBefore: true });
  const { deps, log } = fakes(plan, { up: false });
  assert.equal(await switchVersion(plan, deps), 1);
  assert.equal(await exists(join(root, "current.json")), false);
  assert.equal(log.started.at(-1).program, join(root, exe));
});

test("rollback is refused when the new version already moved the saved work past what the old one reads", async (t) => {
  const { root, scratch, plan } = await layout(t);
  const { deps, log } = fakes(plan, { up: false, format: async () => ({ version: 5, readableBy: 4 }) });
  assert.equal(await switchVersion(plan, deps), 1);
  assert.equal((await readPointer(root)).folder, "app-2.0.0", "the new version stays in use");
  assert.deepEqual(log.started.map((one) => one.program), [plan.newExe, plan.newExe], "and is started again, never the old one on newer data");
  const failure = await readSwitchFailure(scratch, "2.0.0");
  assert.match(failure.message, /cannot read/);
  assert.equal(await exists(plan.failureDraft), false, "the old version's note is not left for it to find");
});

test("the way back reads the real saved work's format, and anything it cannot read keeps the old behaviour", async (t) => {
  const dir = await temp(t);
  const note = async () => undefined;
  const store = new DatabaseSync(join(dir, "branch.sqlite"));
  store.exec("PRAGMA user_version = 4; CREATE TABLE branch_format(id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL, readable_by INTEGER NOT NULL, changed_at TEXT NOT NULL); INSERT INTO branch_format VALUES (1, 4, 4, 'now')");
  store.close();
  const { format } = systemDeps(join(dir, "log"));
  assert.deepEqual(await format(dir), { version: 4, readableBy: 4 });
  assert.deepEqual(await goingBackIsSafe({ dataDir: dir, understood: 4 }, { format, note }), { ok: true });
  assert.deepEqual(await goingBackIsSafe({ dataDir: dir, understood: 3 }, { format, note }), { ok: false, format: { version: 4, readableBy: 4 } });
  assert.deepEqual(await goingBackIsSafe({ dataDir: join(dir, "none"), understood: 1 }, { format, note }), { ok: true }, "no saved work yet");
  assert.deepEqual(await goingBackIsSafe({ dataDir: dir, understood: null }, { format, note }), { ok: true }, "not known: as before");
  assert.deepEqual(await goingBackIsSafe({ dataDir: dir, understood: 1 }, { format: async () => { throw new Error("locked"); }, note }), { ok: true });
});

test("a locked pointer file is tried again, and if it stays locked nothing switches and the old version starts again", async (t) => {
  const { root, plan } = await layout(t);
  let refusals = 2;
  const flaky = async (from, to) => { if (refusals-- > 0) throw Object.assign(new Error("busy"), { code: "EPERM" }); return rename(from, to); };
  const once = fakes(plan, { renameFile: flaky });
  assert.equal(await switchVersion(plan, once.deps), 0, "a lock that clears within the retries does not stop the switch");
  assert.equal((await readPointer(root)).folder, "app-2.0.0");
  const again = await layout(t);
  const stuck = fakes(again.plan, { renameFile: async () => { throw Object.assign(new Error("busy"), { code: "EBUSY" }); } });
  assert.equal(await switchVersion(again.plan, stuck.deps), 1);
  assert.equal((await readPointer(again.root)).folder, "app-1.0.0", "nothing switched");
  assert.deepEqual(stuck.log.started.map((one) => one.program), [again.plan.oldExe]);
});

test("a pointer file held open by another program (really locked) stops the switch whole, and the next try goes through", { skip: !locksWork && "Windows file locks" }, async (t) => {
  const { root, plan } = await layout(t);
  const lock = await holdOpen(join(root, "current.json"));
  t.after(() => lock.release());
  const held = fakes(plan);
  assert.equal(await switchVersion(plan, held.deps), 1);
  assert.equal(await exists(plan.next), true, "the prepared switch is still there");
  assert.deepEqual(held.log.started.map((one) => one.program), [plan.oldExe]);
  await lock.release();
  assert.equal((await readPointer(root)).folder, "app-1.0.0", "nothing switched while it was held");
  const free = fakes(plan);
  assert.equal(await switchVersion(plan, free.deps), 0);
  assert.equal((await readPointer(root)).folder, "app-2.0.0");
});

test("the runner's entry reads the plan the updater wrote and refuses anything else", async (t) => {
  const { root, plan } = await layout(t);
  const path = join(root, "scratch", "switch-version.json");
  await writeFile(path, JSON.stringify(plan));
  const { deps } = fakes(plan);
  assert.equal(await runSwitchPlan(path, deps), 0);
  await writeFile(path, JSON.stringify({ ...plan, extra: true }));
  await assert.rejects(runSwitchPlan(path, deps));
  assert.match(await readFile(plan.next, "utf8").catch(() => "gone"), /gone/, "the switch already used its pointer file");
});
