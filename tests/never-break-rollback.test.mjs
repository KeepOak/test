/**
 * Never breaks: undoing a bad update without making things worse. The activation journal records
 * what an update actually changed — which files, their fingerprints on both sides, which format
 * changes ran, what the older version could read — and the gate refuses in plain words whenever
 * putting the older version back would cost the owner something.
 *
 * Fake installs and fake data folders in temporary folders only. No real app is launched, nothing is
 * installed, and the owner's own Branch is never touched.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { discardTemp } from "./temp-dir.mjs";
import {
  ActivationJournal, fingerprintTree, openActivationJournal,
} from "../dist/never-break/activation.js";
import {
  assessRollback, observeForRollback, performRollback, repairRollback, rollbackSwap, olderVersionCanRead,
} from "../dist/never-break/rollback.js";
import { migrate, migrateDown, formatOf, DataTooNewError } from "../dist/never-break/migrations.js";
import { repairSwap } from "../dist/never-break/canary.js";

const exists = (path) => stat(path).then(() => true, () => false);
const closers = new WeakMap();
async function temp(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-rollback-"));
  const list = [];
  closers.set(t, list);
  t.after(async () => { for (const close of list.reverse()) await close(); await discardTemp(root); });
  return root;
}
const closeFirst = (t, close) => closers.get(t).push(close);

/* ---------- fake versions on the disk ---------- */

/** Lays out a program folder the way the hand-over leaves one after an update. */
async function fakeInstall(root, { before = "1.0.0", after = "2.0.0" } = {}) {
  const target = join(root, "Apps", "Branch-Agent");
  const previous = `${target}.previous`;
  for (const [dir, version] of [[target, after], [previous, before]]) {
    await mkdir(join(dir, "resources", "app", "dist"), { recursive: true });
    await writeFile(join(dir, "branch-agent"), `#!/bin/sh\necho ${version}\n`);
    await writeFile(join(dir, "resources", "app", "dist", "cli.js"), `// version ${version}\n`);
    await writeFile(join(dir, "resources", "version.txt"), version);
  }
  return { target, previous };
}

/* ---------- a fake saved-work database ---------- */

const additive = [
  { version: 1, readableBy: 1, up: () => undefined, down: () => undefined },
  { version: 2, readableBy: 1, up: (db) => db.exec("ALTER TABLE work ADD COLUMN note TEXT"), down: (db) => db.exec("ALTER TABLE work DROP COLUMN note") },
];
const breaking = [
  ...additive,
  { version: 3, readableBy: 3, up: (db) => db.exec("ALTER TABLE work RENAME TO work_v3"), down: (db) => db.exec("ALTER TABLE work_v3 RENAME TO work") },
];
const oldKnows = 1;

function makeStore(path, list) {
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE IF NOT EXISTS work(id INTEGER PRIMARY KEY, body TEXT)");
  db.prepare("INSERT INTO work(id, body) VALUES(1, ?)").run("the owner's conversation");
  migrate(db, list, { backupTo: null });
  return db;
}

/* ---------- entries ---------- */

async function stagedEntry(t, root, options = {}) {
  const { target, previous } = await fakeInstall(root);
  const journal = new ActivationJournal(join(root, "activation.sqlite"));
  closeFirst(t, () => journal.close());
  const id = journal.stage({
    kind: "update", fromVersion: "1.0.0", toVersion: "2.0.0", target,
    previous: await fingerprintTree(previous), candidate: await fingerprintTree(target),
    launcher: null, executableName: "branch-agent", understood: oldKnows,
    databases: options.databases ?? [], backups: options.backups ?? [join(root, "data", "update-backups", "before-x.json")],
  });
  journal.activated(id);
  return { journal, entry: journal.entry(id), target, previous };
}

const look = (entry, extra = {}) => observeForRollback(entry, { runnerKnows: 3, storeFormat: async () => null, ...extra });

/* ---------- the journal itself ---------- */

test("the activation journal records the fingerprints on both sides of an update", async (t) => {
  const root = await temp(t);
  const { entry } = await stagedEntry(t, root);
  assert.equal(entry.state, "activated");
  assert.equal(entry.fromVersion, "1.0.0");
  assert.equal(entry.toVersion, "2.0.0");
  assert.equal(entry.understood, 1);
  assert.equal(entry.executableName, "branch-agent");
  assert.match(entry.previous.digest, /^[a-f0-9]{64}$/);
  assert.match(entry.candidate.digest, /^[a-f0-9]{64}$/);
  assert.notEqual(entry.previous.digest, entry.candidate.digest, "the two versions are not the same files");
  assert.equal(entry.previous.partial, false);
  assert.ok(entry.previous.files >= 3 && entry.previous.bytes > 0);
});

test("a fingerprint is the same for the same files in a different place, and moves with any edit", async (t) => {
  const root = await temp(t);
  const { previous } = await fakeInstall(root);
  const first = await fingerprintTree(previous);
  await rename(previous, join(root, "moved"));
  const moved = await fingerprintTree(join(root, "moved"));
  assert.equal(moved.digest, first.digest, "a copy in another place is the same version");
  assert.notEqual(moved.identity, null);
  await writeFile(join(root, "moved", "resources", "version.txt"), "1.0.0-tampered");
  assert.notEqual((await fingerprintTree(join(root, "moved"))).digest, first.digest);
});

test("a fingerprint that ran out of its budget says so instead of pretending", async (t) => {
  const root = await temp(t);
  const { previous } = await fakeInstall(root);
  let clock = 0;
  const print = await fingerprintTree(previous, { budgetMs: 5, now: () => (clock += 10) });
  assert.equal(print.partial, true, "a walk that ran out of time is partial");
});

test("an activation journal that cannot be read is put aside and Branch still comes up", async (t) => {
  const root = await temp(t);
  const path = join(root, "activation.sqlite");
  await writeFile(path, "this is not a database at all, not even a little bit");
  const { journal, reset } = openActivationJournal(path);
  closeFirst(t, () => journal.close());
  assert.match(reset ?? "", /could not be read/);
  assert.equal(journal.current(), null, "nothing is offered to undo when the record was lost");
});

test("a record that cannot be written stops the update rather than making one nobody can undo", async (t) => {
  const root = await temp(t);
  const journal = new ActivationJournal(join(root, "activation.sqlite"));
  closeFirst(t, () => journal.close());
  journal.failWrites = () => new Error("SQLITE_FULL: database or disk is full");
  assert.throws(() => journal.stage({
    kind: "update", fromVersion: "1.0.0", toVersion: "2.0.0", target: join(root, "x"), previous: null,
    candidate: null, launcher: null, executableName: "b", understood: 1, databases: [], backups: [],
  }), /could not write down what this update changed[\s\S]*disk may be full/);
});

test("only the newest update is the one an undo offers", async (t) => {
  const root = await temp(t);
  const { journal, entry } = await stagedEntry(t, root);
  const second = journal.stage({ ...entry, fromVersion: "2.0.0", toVersion: "3.0.0" });
  journal.activated(second);
  assert.equal(journal.entry(entry.id).state, "superseded");
  assert.equal(journal.current().id, second);
});

/* ---------- the gate: when it refuses ---------- */

test("with nothing recorded, an undo refuses instead of guessing", () => {
  const refusal = assessRollback(null, { current: null, previous: null, store: null, runnerKnows: 0 });
  assert.equal(refusal.ok, false);
  assert.equal(refusal.reason, "no-activation");
  assert.match(refusal.message, /will not guess/);
  assert.match(refusal.message, /restore a safety copy|ask for help/);
});

test("a rollback after a forward migration refuses and says why", async (t) => {
  const root = await temp(t);
  await mkdir(join(root, "data"), { recursive: true });
  // The update's record says the data was in format 1. The new version then took it to format 3,
  // which the older version cannot read, and kept no copy of it as it was.
  const { entry } = await stagedEntry(t, root, { databases: [{
    name: "branch.sqlite", before: { version: 1, readableBy: 1 }, after: { version: 3, readableBy: 3 },
    ran: [2, 3], backup: null,
  }] });
  const db = makeStore(join(root, "data", "branch.sqlite"), breaking);
  closeFirst(t, () => db.close());
  const now = formatOf(db);
  assert.equal(now.readableBy, 3);
  assert.equal(olderVersionCanRead(now, entry.understood), false, "the older version could not open this");
  const refusal = assessRollback(entry, await look(entry, { storeFormat: async () => now }));
  assert.equal(refusal.ok, false);
  assert.equal(refusal.reason, "state-migrated-no-rollback");
  assert.match(refusal.message, /cannot read/);
  assert.match(refusal.message, /no copy of it as it was before/);
  assert.match(refusal.message, /Staying on version 2\.0\.0 keeps everything you have/);
  // And the promise the refusal rests on is real: the older version would indeed refuse this data.
  assert.throws(() => migrate(db, additive, { backupTo: null }), DataTooNewError);
});

test("a rollback refuses when the data has moved on since the update was written down", async (t) => {
  const root = await temp(t);
  const { entry } = await stagedEntry(t, root, { databases: [{
    name: "branch.sqlite", before: { version: 1, readableBy: 1 }, after: { version: 2, readableBy: 1 },
    ran: [2], backup: null,
  }] });
  const refusal = assessRollback(entry, await look(entry, { storeFormat: async () => ({ version: 3, readableBy: 3 }) }));
  assert.equal(refusal.ok, false);
  assert.equal(refusal.reason, "state-moved-since");
  assert.match(refusal.message, /format 2 when version 2\.0\.0 was installed and it is in format 3 now/);
  assert.match(refusal.message, /will not undo changes it did not write down/);
});

test("a rollback with a changed file refuses — the kept copy of the old version is not the one put aside", async (t) => {
  const root = await temp(t);
  const { entry, previous } = await stagedEntry(t, root);
  await writeFile(join(previous, "resources", "app", "dist", "cli.js"), "// somebody edited this\n");
  const refusal = assessRollback(entry, await look(entry));
  assert.equal(refusal.ok, false);
  assert.equal(refusal.reason, "previous-changed");
  assert.match(refusal.message, /not the one this update put aside/);
  assert.match(refusal.message, /Download version 1\.0\.0 again/);
});

test("a journal entry that does not match what is on disk is detected", async (t) => {
  const root = await temp(t);
  const { entry, target } = await stagedEntry(t, root);
  // Something replaced the installed program since — another update, or a reinstall.
  await writeFile(join(target, "resources", "version.txt"), "2.5.0");
  const refusal = assessRollback(entry, await look(entry));
  assert.equal(refusal.ok, false);
  assert.equal(refusal.reason, "program-changed");
  assert.match(refusal.message, /not the version 2\.0\.0 this update put there/);
  assert.match(refusal.message, /two versions mixed together/);
});

test("with no kept copy of the old version there is nothing to put back, and it says so", async (t) => {
  const root = await temp(t);
  const { entry, previous } = await stagedEntry(t, root);
  await rm(previous, { recursive: true, force: true });
  const refusal = assessRollback(entry, await look(entry));
  assert.equal(refusal.ok, false);
  assert.equal(refusal.reason, "previous-missing");
  assert.match(refusal.message, /nothing to put back/);
  assert.match(refusal.message, /release page/);
});

test("a check that could not be finished refuses rather than counting as verified", async (t) => {
  const root = await temp(t);
  const { entry, previous } = await stagedEntry(t, root);
  const slow = async (path) => {
    let clock = 0;
    return path === previous ? fingerprintTree(path, { budgetMs: 1, now: () => (clock += 10) }) : fingerprintTree(path);
  };
  const observed = await observeForRollback(entry, { runnerKnows: 3, fingerprint: slow, storeFormat: async () => null });
  const refusal = assessRollback(entry, observed);
  assert.equal(refusal.ok, false);
  assert.equal(refusal.reason, "unverifiable");
  assert.match(refusal.message, /will not put back a version it has not checked/);
});

/* ---------- the gate: when it says yes ---------- */

test("a safe rollback completes and the older version opens its data", async (t) => {
  const root = await temp(t);
  await mkdir(join(root, "data"), { recursive: true });
  // The update ran a format change that only added: the older version still reads the result.
  const db = makeStore(join(root, "data", "branch.sqlite"), additive);
  const now = formatOf(db);
  db.close();
  assert.equal(now.version, 2);
  assert.equal(now.readableBy, 1, "an added column keeps the older version reading it");
  const { journal, entry, target, previous } = await stagedEntry(t, root, { databases: [{
    name: "branch.sqlite", before: { version: 1, readableBy: 1 }, after: now, ran: [2], backup: null }] });
  const keptPrevious = await fingerprintTree(previous);

  const report = await performRollback(entry, {
    journal, by: "test",
    observe: (one) => look(one, { storeFormat: async () => now }),
    takeDown: async () => assert.fail("nothing should be taken down when the older version can read it"),
    restart: async () => undefined,
  });
  assert.equal(report.ok, true, report.message);
  assert.match(report.message, /back on version 1\.0\.0/);
  assert.match(report.message, /exactly as they were/);

  // The older version is back, the newer one is kept beside it, and nothing needs a human.
  assert.equal(await readFile(join(target, "resources", "version.txt"), "utf8"), "1.0.0");
  assert.equal((await fingerprintTree(target)).digest, keptPrevious.digest);
  assert.equal(await exists(`${target}.failed`), true);
  assert.equal(await exists(`${target}.previous`), false);
  assert.deepEqual(await repairRollback(target), [], "there is nothing left to tidy up");

  // The real claim: the older version, which only knows format 1, opens the data without refusing.
  const reopened = new DatabaseSync(join(root, "data", "branch.sqlite"));
  closeFirst(t, () => reopened.close());
  assert.doesNotThrow(() => migrate(reopened, additive.slice(0, oldKnows), { backupTo: null }));
  assert.equal(reopened.prepare("SELECT body FROM work WHERE id=1").get().body, "the owner's conversation");
  assert.equal(journal.entry(entry.id).state, "rolled-back");
  const ledger = journal.ledger(entry.id).map((line) => line.step);
  assert.ok(ledger.includes("checked whether going back is safe"));
  assert.ok(ledger.includes("left your work alone"));
  assert.ok(ledger.includes("put version back"));
  assert.ok(ledger.includes("started Branch again"));
});

test("a rollback that has to take a format change back out does, and keeps the work as it was", async (t) => {
  const root = await temp(t);
  await mkdir(join(root, "data", "update-backups"), { recursive: true });
  const path = join(root, "data", "branch.sqlite");
  const db = makeStore(path, breaking);
  const now = formatOf(db);
  const backup = join(root, "data", "update-backups", "before-format.sqlite");
  db.exec(`VACUUM INTO '${backup}'`);
  const { journal, entry, target } = await stagedEntry(t, root, { databases: [{
    name: "branch.sqlite", before: { version: 1, readableBy: 1 }, after: now, ran: [2, 3], backup }] });
  const decision = assessRollback(entry, await look(entry, { storeFormat: async () => now }));
  assert.equal(decision.ok, true, decision.message);
  assert.equal(decision.data.action, "take-down");
  assert.match(decision.message, /taken back out/);
  assert.match(decision.message, /your work as it was before the update is kept at/);

  const report = await performRollback(entry, {
    journal, by: "test",
    observe: (one) => look(one, { storeFormat: async () => now }),
    takeDown: async (to) => { migrateDown(db, breaking, to); return { backup }; },
  });
  db.close();
  assert.equal(report.ok, true, report.message);
  assert.equal(await readFile(join(target, "resources", "version.txt"), "utf8"), "1.0.0");
  const reopened = new DatabaseSync(path);
  closeFirst(t, () => reopened.close());
  assert.doesNotThrow(() => migrate(reopened, additive.slice(0, oldKnows), { backupTo: null }),
    "the older version opens the data it was taken back down to");
  assert.equal(reopened.prepare("SELECT body FROM work WHERE id=1").get().body, "the owner's conversation");
});

test("a rollback whose data step fails does not put the older version back on data it cannot read", async (t) => {
  const root = await temp(t);
  const { journal, entry, target } = await stagedEntry(t, root, { databases: [{
    name: "branch.sqlite", before: { version: 1, readableBy: 1 }, after: { version: 3, readableBy: 3 },
    ran: [2, 3], backup: join(root, "copy.sqlite") }] });
  const report = await performRollback(entry, {
    journal, by: "test",
    observe: (one) => look(one, { storeFormat: async () => ({ version: 3, readableBy: 3 }) }),
    takeDown: async () => { throw new Error("the copy could not be written"); },
  });
  assert.equal(report.ok, false);
  assert.equal(report.reason, "state-migrated-no-rollback");
  assert.match(report.message, /was \*\*not\*\* put back/);
  assert.match(report.message, /Nothing on the disk was changed/);
  assert.equal(await readFile(join(target, "resources", "version.txt"), "utf8"), "2.0.0", "the program was not moved");
  assert.equal(journal.entry(entry.id).state, "activated", "the undo is handed back so it can be tried again");
});

/* ---------- two copies at once, and being cut off ---------- */

test("two copies at once: only one undo runs, and the second is told so", async (t) => {
  const root = await temp(t);
  const { journal, entry } = await stagedEntry(t, root);
  assert.equal(journal.claim(entry.id, "first"), true);
  assert.equal(journal.claim(entry.id, "second"), false, "the second copy does not get it too");
  const report = await performRollback(journal.entry(entry.id), {
    journal, by: "second", observe: (one) => look(one),
  });
  assert.equal(report.ok, false);
  assert.equal(report.reason, "in-progress");
  assert.match(report.message, /already putting version 1\.0\.0 back/);
  assert.match(report.message, /first/);
});

test("an undo already done is not offered again", async (t) => {
  const root = await temp(t);
  const { journal, entry } = await stagedEntry(t, root);
  journal.claim(entry.id, "test");
  journal.rolledBack(entry.id);
  const refusal = assessRollback(journal.entry(entry.id), await look(entry));
  assert.equal(refusal.ok, false);
  assert.equal(refusal.reason, "already-undone");
});

test("a rollback cut off after every step leaves one whole version and nothing half-done", async (t) => {
  const root = await temp(t);
  for (const stopAfter of [0, 1, 2, 3]) {
    const here = join(root, `cut-${stopAfter}`);
    await mkdir(here, { recursive: true });
    const { target } = await fakeInstall(here);
    await mkdir(`${target}.previous-2`, { recursive: true });
    await writeFile(join(`${target}.previous-2`, "resources.txt"), "0.9.0");
    await rollbackSwap(target, stopAfter);
    const tidied = await repairRollback(target);
    assert.equal(await exists(target), true, `cut after ${stopAfter}: something whole is in place`);
    const version = await readFile(join(target, "resources", "version.txt"), "utf8");
    assert.ok(["1.0.0", "2.0.0"].includes(version), `cut after ${stopAfter}: ${version} is a whole version`);
    // Never both: the program folder is never a mix, and never left needing a person.
    assert.equal(await exists(`${target}.incoming`), false);
    if (stopAfter < 3) assert.ok(tidied.length <= 1);
    assert.deepEqual(await repairRollback(target), [], `cut after ${stopAfter}: tidying twice changes nothing`);
  }
});

test("a rollback cut off with nothing kept puts back the version that was there", async (t) => {
  const root = await temp(t);
  const { target, previous } = await fakeInstall(root);
  await rm(previous, { recursive: true, force: true });
  await rename(target, `${target}.failed`);
  const tidied = await repairRollback(target);
  assert.equal(await exists(target), true);
  assert.equal(await readFile(join(target, "resources", "version.txt"), "utf8"), "2.0.0");
  assert.match(tidied.join(" "), /could not be finished/);
  assert.match(tidied.join(" "), /Nothing of your work was changed/);
});

test("the start-up tidy-up knows a half-done rollback from a half-done update", async (t) => {
  const root = await temp(t);
  const { target } = await fakeInstall(root);
  await rename(target, `${target}.failed`);
  const said = await repairSwap(target);
  assert.equal(await exists(target), true);
  assert.equal(await readFile(join(target, "resources", "version.txt"), "utf8"), "1.0.0",
    "the kept version is the one put in place");
  assert.match(said.join(" "), /Going back to the previous version had stopped half-way/);
  assert.ok(!said.join(" ").includes("The update had stopped half-way"), "it is not described as an update");
});

test("a swap that cannot be done reports how far it got and leaves a whole version", async (t) => {
  const root = await temp(t);
  const { journal, entry, target } = await stagedEntry(t, root);
  const report = await performRollback(entry, {
    journal, by: "test", observe: (one) => look(one),
    swap: async () => { throw new Error("the disk is full"); },
  });
  assert.equal(report.ok, false);
  assert.match(report.message, /could not be put back \(the disk is full\)/);
  assert.match(report.message, /were not changed/);
  assert.equal(await exists(target), true);
  assert.equal(journal.entry(entry.id).state, "activated");
  const failed = report.steps.filter((one) => !one.ok);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].step, "put version back");
});

/* ---------- the record learns what the new version did, and nothing may edit it ---------- */

test("the record learns which format changes the new version made after the swap", async (t) => {
  const root = await temp(t);
  const { journal, entry } = await stagedEntry(t, root, { databases: [{
    name: "branch.sqlite", before: { version: 1, readableBy: 1 }, after: { version: 1, readableBy: 1 },
    ran: [], backup: null }] });
  journal.noteMigration(entry.id, { name: "branch.sqlite", before: { version: 9, readableBy: 9 },
    after: { version: 2, readableBy: 1 }, ran: [2], backup: "/copies/before.sqlite" });
  const change = journal.entry(entry.id).databases.find((one) => one.name === "branch.sqlite");
  assert.deepEqual(change.before, { version: 1, readableBy: 1 }, "what the older version was reading is kept");
  assert.deepEqual(change.after, { version: 2, readableBy: 1 });
  assert.deepEqual(change.ran, [2]);
  assert.equal(change.backup, "/copies/before.sqlite");
});

test("the record of what an update changed is a place no task may touch", async () => {
  const { protectedAreas, protectedTarget, gatewayDataFiles } = await import("../dist/never-break/protected.js");
  assert.ok(gatewayDataFiles.includes("activation.sqlite"));
  // The workspace inside the data folder is the case where the files are listed one by one, so it
  // is the one that would quietly leave the new file out.
  const areas = protectedAreas({ workspace: "/home/me/.branch/workspace", dataDir: "/home/me/.branch",
    installRoot: "/opt/branch", platform: "linux" });
  const write = (path) => protectedTarget({ tool: "files.write", readOnly: false, args: { path }, target: path }, areas);
  assert.match(write("/home/me/.branch/activation.sqlite") ?? "", /never lets a task/);
  assert.match(write("/home/me/.branch/activation.sqlite-wal") ?? "", /never lets a task/);
  assert.equal(write("/home/me/.branch/workspace/notes.md"), null, "ordinary work is untouched");
});

test("branch rollback says what it would do, and refuses with an exit code when it would lose work", async (t) => {
  const { manageCommand } = await import("../dist/install/manage-cli.js");
  const root = await temp(t);
  const dataDir = join(root, "data");
  await mkdir(dataDir, { recursive: true });
  const said = [];
  const context = (args) => manageCommand(args, {
    env: { BRANCH_DATA_DIR: dataDir }, platform: "linux", version: "2.0.0", packageRoot: root,
    print: (line) => said.push(line),
  });
  // Nothing recorded yet.
  assert.equal(await context(["rollback"]), 1);
  assert.match(said.join("\n"), /no record of an update to go back from/);

  // A safe one: it describes it and changes nothing without --yes.
  const { target } = await fakeInstall(dataDir);
  const journal = new ActivationJournal(join(dataDir, "activation.sqlite"));
  const id = journal.stage({ kind: "update", fromVersion: "1.0.0", toVersion: "2.0.0", target,
    previous: await fingerprintTree(`${target}.previous`), candidate: await fingerprintTree(target),
    launcher: null, executableName: "branch-agent", understood: 1, databases: [], backups: [] });
  journal.activated(id);
  journal.close();
  said.length = 0;
  assert.equal(await context(["rollback"]), 0);
  assert.match(said.join("\n"), /Going back to version 1\.0\.0/);
  assert.match(said.join("\n"), /branch rollback --yes/);
  assert.equal(await readFile(join(target, "resources", "version.txt"), "utf8"), "2.0.0", "a check changes nothing");
});

/* ---------- preconditions, half-checked records and the app's own Update button ---------- */

test("a Branch that will not close stops the undo with nothing touched", async (t) => {
  const root = await temp(t);
  const { journal, entry, target } = await stagedEntry(t, root);
  const report = await performRollback(entry, {
    journal, by: "test", observe: (one) => look(one),
    stop: async () => { throw new Error("Branch Agent could not be closed (it is busy)."); },
    swap: async () => assert.fail("the swap must never run under a live Branch"),
  });
  assert.equal(report.ok, false);
  assert.match(report.message, /could not be closed/);
  assert.match(report.message, /Nothing was changed/);
  assert.match(report.message, /can be tried again once Branch has closed/);
  assert.equal(await readFile(join(target, "resources", "version.txt"), "utf8"), "2.0.0");
  assert.equal(await exists(`${target}.previous`), true);
  assert.equal(journal.entry(entry.id).state, "activated", "the undo is handed back, not consumed");
});

test("a fingerprint the update never finished taking refuses as unchecked, not as tampered with", async (t) => {
  const root = await temp(t);
  const { target, previous } = await fakeInstall(root);
  const journal = new ActivationJournal(join(root, "activation.sqlite"));
  closeFirst(t, () => journal.close());
  let clock = 0;
  const id = journal.stage({
    kind: "update", fromVersion: "1.0.0", toVersion: "2.0.0", target,
    // Taken while the disk was busy: the walk stopped part-way, so the digest covers half a folder.
    previous: await fingerprintTree(previous, { budgetMs: 1, now: () => (clock += 10) }),
    candidate: await fingerprintTree(target), launcher: null, executableName: "branch-agent",
    understood: 1, databases: [], backups: [],
  });
  journal.activated(id);
  const entry = journal.entry(id);
  assert.equal(entry.previous.partial, true);
  const refusal = assessRollback(entry, await look(entry));
  assert.equal(refusal.ok, false);
  assert.equal(refusal.reason, "unverifiable", "not previous-changed: nothing was tampered with");
  assert.match(refusal.message, /ran out of time/);
  assert.ok(!/Download version/.test(refusal.message), "the owner is not sent chasing a re-download");
});

test("an update the app handed over to a script is settled by the version that comes up next", async (t) => {
  const { settleActivation } = await import("../dist/never-break/activation.js");
  const root = await temp(t);
  const { target } = await fakeInstall(root);
  const path = join(root, "activation.sqlite");
  const stage = () => {
    const journal = new ActivationJournal(path);
    const id = journal.stage({ kind: "update", fromVersion: "1.0.0", toVersion: "2.0.0", target, previous: null,
      candidate: null, launcher: null, executableName: "branch-agent", understood: 1, databases: [], backups: [] });
    journal.close();
    return id;
  };
  const stateOf = (id) => { const j = new ActivationJournal(path); const s = j.entry(id).state; j.close(); return s; };

  // The swap landed: the version that came up is the one the update was going to.
  const landed = stage();
  assert.equal(settleActivation(path, "2.0.0"), "activated");
  assert.equal(stateOf(landed), "activated");

  // The swap did not land: the old version came up again, so there is nothing to undo.
  const notLanded = stage();
  assert.equal(settleActivation(path, "1.0.0"), "failed");
  assert.equal(stateOf(notLanded), "failed");
  assert.equal(settleActivation(path, "1.0.0"), "none", "a settled record is left alone");
});

test("branch rollback is not half-attempted on Windows", async () => {
  const { manageCommand } = await import("../dist/install/manage-cli.js");
  const said = [];
  const code = await manageCommand(["rollback", "--yes"], {
    env: { BRANCH_DATA_DIR: "C:\\nowhere" }, platform: "win32", version: "2.0.0", packageRoot: "C:\\nowhere",
    print: (line) => said.push(line),
  });
  assert.equal(code, 1);
  assert.match(said.join("\n"), /On Windows, Branch goes back to the version before by itself when a new version does not open/);
  // Settings › Updates' undo is greyed, so the refusal never sends the owner there.
  assert.doesNotMatch(said.join("\n"), /Settings, Updates/);
});

test("merge-queue review: a swap that fails after the format was taken down does not say the work was untouched", async (t) => {
  const root = await temp(t);
  const { journal, entry } = await stagedEntry(t, root, { databases: [{
    name: "branch.sqlite", before: { version: 1, readableBy: 1 }, after: { version: 3, readableBy: 3 },
    ran: [2, 3], backup: join(root, "copy.sqlite") }] });
  const report = await performRollback(entry, {
    journal, by: "test",
    observe: (one) => look(one, { storeFormat: async () => ({ version: 3, readableBy: 3 }) }),
    takeDown: async () => ({ backup: join(root, "copy.sqlite") }),
    swap: async () => { throw new Error("the folder is in use"); },
  });
  assert.equal(report.ok, false);
  assert.doesNotMatch(report.message, /were not changed/);
  assert.match(report.message, /had already been put back into the format/);
  assert.match(report.message, /moves it forward again the next time it starts/);
});
