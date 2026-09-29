/**
 * Never breaks: the second chaos round — installing, updating and starting up.
 *
 * The first round (never-break-chaos.test.mjs) kills Branch in the middle of a task. This one kills
 * it in the middle of an update, a change to the shape of its saved work, and a first start, and
 * starts it on machines that are already broken. Each seed picks a state to put the saved work in
 * and a moment to cut off, and then the same question is asked every time:
 *
 *   Branch starts, the owner's conversations, settings and memory are all still there, no change to
 *   the shape of the data is half-applied, nothing half-installed is left lying about, and anything
 *   Branch refuses to do it says in a sentence a person can act on.
 *
 * A crash, quiet loss of the owner's work, or a state only a person with a terminal could clean up
 * is a failure. Quick by default (a few seeds, for CI); BRANCH_INSTALL_SEEDS=200 runs the long set.
 * Every seed's choices are printed, so a failing one can be replayed on its own.
 *
 * Only temporary folders, fake releases and fake installs. Nothing is installed on this computer, no
 * real app is launched, no `launchctl`, `systemctl` or real GitHub release is ever touched.
 */
import nodeTest from "node:test";
/* This file is split into parts so the build machines can run its minutes side by side: each
   tests/never-break-install-chaos-N.test.mjs runs every 4th test declared here, starting from its own. Nothing is
   skipped: the parts together declare every test, in the same order, with the same body. */
const part = globalThis.branchTestPart ?? { index: 0, of: 1 };
let declared = 0;
const test = (...args) => (declared++ % part.of === part.index ? nodeTest(...args) : undefined);
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, open, readFile, readdir, rm, stat, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { Updater } from "../dist/desktop/updater.js";
import { posixHandOverScript, posixRollbackScript } from "../dist/desktop/hand-over.js";
import { repairSwap, watchVerdict, readWatch, writeWatch } from "../dist/never-break/canary.js";
import {
  assertFormatReadable, dataOpenError, dataProblemSentence, DataTooNewError, formatOf, migrate, storeMigrations,
} from "../dist/never-break/migrations.js";
import { backupsToPrune, backupFileName, formatCopiesToPrune, writeUpdateBackup } from "../dist/install/update-backup.js";
import { GatewayConfigSchema, loadGatewayConfig, promoteGood, saveGatewayConfig } from "../dist/never-break/gateway-config.js";
import { openJournal } from "../dist/never-break/journal.js";
import { headlessUpdate } from "../dist/install/headless-update.js";
import { doctorFix } from "../dist/doctor-fix.js";
import { builtInSpeech } from "../dist/speech-engines.js";

const seeds = Math.max(1, Number(process.env.BRANCH_INSTALL_SEEDS ?? 4));
const posix = process.platform !== "win32";

/** The same small repeatable random source the first chaos round uses (mulberry32). */
function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}
const exists = (path) => stat(path).then(() => true, () => false);

/** Windows will not delete an open database, so what a test opened is closed first, in one hook. */
const closers = new WeakMap();
async function temp(t, name) {
  const root = await mkdtemp(join(tmpdir(), `branch-install-chaos-${name}-`));
  const list = closers.get(t) ?? [];
  if (!closers.has(t)) {
    closers.set(t, list);
    t.after(async () => { for (const close of list.reverse()) await close(); });
  }
  list.push(async () => {
    // A test that made a folder unwritable must not leave it that way, or it cannot be tidied up.
    for (const entry of ["", "d", "w"]) await chmod(join(root, entry), 0o700).catch(() => undefined);
    await discardTemp(root, { tries: 80, pause: 100 });
  });
  return root;
}

/* ------------------------------------------------------------------ what a pass means -------- */

/**
 * A refusal a person can act on: a real sentence, about Branch's own files, saying what to do —
 * and never the system's own words for what went wrong.
 */
const systemWords = /SQLITE_|ENOENT|EACCES|EPERM|EPIPE|errno|\[object |undefined|disk image is malformed|file is not a database|attempt to write a readonly|database is locked|database disk image/i;
function assertPlainRefusal(label, error) {
  assert.ok(error instanceof Error, `${label}: refused with something that is not an error`);
  const text = error.message;
  assert.ok(text.length >= 40, `${label}: the refusal is too short to act on: ${text}`);
  assert.match(text, /\.\s*$|\.\s/, `${label}: the refusal is not written as sentences: ${text}`);
  assert.doesNotMatch(text, systemWords, `${label}: the refusal uses the system's own words: ${text}`);
  // It must place the owner: say whose program this is about, or say where their work now stands.
  assert.match(text, /Branch|nothing was changed|version it had|your work|your saved work/i,
    `${label}: the refusal leaves the owner guessing what it is about and what state things are in: ${text}`);
}

/** Everything of the owner's that a start must not lose. */
async function fingerprint(dataDir, workspace) {
  const app = await createBranch({ workspace, dataDir });
  try {
    const runs = app.store.runs("local").map((run) => `${run.prompt}|${run.status}`).sort();
    const memory = app.store.list("memory", "local").map((one) => JSON.stringify(one.data)).sort();
    const settings = app.store.list("settings", "local").map((one) => JSON.stringify(one.data)).sort();
    const messages = runs.length ? app.store.runs("local").flatMap((run) => app.store.messages(run.sessionId).map((m) => m.content)) : [];
    const format = formatOf(app.store.sqlite);
    return { runs, memory, settings, messages: messages.sort(), format };
  } finally { await app.close(); }
}

/** A data folder with real work in it: a finished conversation, something remembered, a setting. */
async function ownersData(root) {
  const dataDir = join(root, "d"), workspace = join(root, "w");
  const app = await createBranch({ workspace, dataDir });
  await app.runtime.run({ prompt: "what the owner asked for", onTextDelta: () => undefined });
  app.store.save("memory", "local", "m1", { text: "the owner's cat is called Pepper" });
  app.store.save("settings", "local", "s1", { theme: "dark", tellMeFirst: true });
  await app.close();
  await saveGatewayConfig(dataDir, GatewayConfigSchema.parse({ mode: "on", holdSeconds: 11 }));
  await promoteGood(dataDir, GatewayConfigSchema.parse({ mode: "on", holdSeconds: 11 }));
  return { dataDir, workspace, before: await fingerprint(dataDir, workspace) };
}

/**
 * No change to the shape of the data is half-applied. The format is either one this build knows, or
 * a newer one that says this format can still read it — which is the promise that lets an owner go
 * back one release, so it counts as whole too.
 */
function assertFormatWhole(label, format, list = storeMigrations) {
  const newest = list.at(-1).version;
  assert.ok(format.version >= 1, `${label}: the data has no format at all (${format.version})`);
  assert.ok(format.readableBy <= format.version, `${label}: the format says it needs a newer reader than it is`);
  if (format.version > newest)
    assert.ok(format.readableBy <= newest,
      `${label}: the data is at format ${format.version}, which this build cannot read (it needs ${format.readableBy})`);
}

/**
 * Starts Branch on this folder and answers what happened, holding it to the rules: it either starts
 * with everything still there, or refuses in a sentence a person can act on.
 */
async function startOrRefuse(label, dataDir, workspace, before) {
  let app = null;
  try { app = await createBranch({ workspace, dataDir }); }
  catch (error) { assertPlainRefusal(label, error); return "refused"; }
  try {
    const now = { runs: app.store.runs("local").map((r) => `${r.prompt}|${r.status}`).sort(),
      memory: app.store.list("memory", "local").map((one) => JSON.stringify(one.data)).sort(),
      settings: app.store.list("settings", "local").map((one) => JSON.stringify(one.data)).sort(),
      format: formatOf(app.store.sqlite) };
    assertFormatWhole(label, now.format);
    if (before) {
      // Branch writes notes of its own on every start, so what must hold is that nothing of the
      // owner's went missing, not that the rows are identical.
      const kept = (was, now2, what) => {
        const missing = was.filter((one) => !now2.includes(one));
        assert.deepEqual(missing, [], `${label}: ${what} went missing: ${missing.join(" | ")}`);
      };
      kept(before.memory, now.memory, "what the owner asked Branch to remember");
      kept(before.settings, now.settings, "the owner's settings");
      kept(before.runs.map((r) => r.split("|")[0]), now.runs.map((r) => r.split("|")[0]), "the owner's conversations");
    }
    return "started";
  } finally { if (app) await app.close(); }
}

/** Nothing half-installed is left lying about in the data folder. */
async function assertNothingHalfInstalled(label, dataDir) {
  const updates = await readdir(join(dataDir, "updates")).catch(() => []);
  assert.deepEqual(updates, [], `${label}: a copy taken for an update was left behind: ${updates.join(", ")}`);
  assert.equal(await exists(join(dataDir, "branch.sqlite.incoming")), false, `${label}: a half-written database was left behind`);
}

/* ============================== 1. killed in the middle of an update ======================== */

/** A fake release the updater can download, check and unpack without touching the network. */
function fakeRelease(bytes, { checksum = "good" } = {}) {
  const digest = createHash("sha256").update(bytes).digest("hex");
  return async (url) => {
    const text = String(url);
    if (text.includes("releases/latest"))
      return Response.json({ tag_name: "v2.0.0", name: null, body: "", published_at: null,
        html_url: "https://example.invalid/releases/tag/v2.0.0",
        assets: [{ name: "app.tgz", browser_download_url: "https://example.invalid/app.tgz", size: bytes.length },
          { name: "app.tgz.sha256", browser_download_url: "https://example.invalid/app.sha256", size: 64 }] });
    if (text.endsWith("app.tgz")) return new Response(bytes);
    if (checksum === "cut-off") return new Response(`${digest.slice(0, 30)}`);
    if (checksum === "unreachable") return new Response("nope", { status: 503 });
    if (checksum === "wrong") return new Response(`${"0".repeat(64)}  app.tgz\n`);
    return new Response(`${digest}  app.tgz\n`);
  };
}

/** The five named moments an update can be cut off at, before the files are swapped. */
const updateMoments = [
  { id: "after-the-download", fetch: { checksum: "unreachable" }, expect: /could not read the checksum published with the new version/ },
  { id: "during-the-checksum", fetch: { checksum: "cut-off" }, expect: /checksum published with the new version did not arrive in full/ },
  { id: "checksum-does-not-match", fetch: { checksum: "wrong" }, expect: /did not match the published checksum/ },
  { id: "during-the-self-test", canary: async () => { throw new Error("the engine stopped half-way through its check"); },
    expect: /did not pass its check, so nothing was changed/ },
  { id: "self-test-said-nothing", canary: async () => { throw new Error("The new version did not finish its check (it was ended by SIGKILL)."); },
    expect: /did not pass its check[\s\S]*did not finish its check/ },
  { id: "no-room-for-the-safety-copy", backup: async () => { throw new Error("ENOSPC: no space left on device"); },
    expect: /safety copy could not be made, so the update was stopped/ },
];

test(`an update cut off at each named moment changes nothing and says why (${updateMoments.length} moments x ${seeds} seeds)`, async (t) => {
  const outcomes = [];
  for (let seed = 1; seed <= seeds; seed++) {
    const next = random(seed * 7907);
    for (const moment of updateMoments) {
      const root = await temp(t, `update-${seed}-${moment.id}`);
      const { dataDir, workspace, before } = await ownersData(root);
      const install = join(root, "installed");
      await mkdir(install, { recursive: true });
      await writeFile(join(install, "branch-agent"), "the version in use");
      const order = [];
      const updater = new Updater({ lastReleaseWithoutProvenance: "2.0.0",
        repo: "x/y", currentVersion: "1.0.0", installDir: install, executableName: "branch-agent",
        assetName: "app.tgz", scratchDir: join(root, "scratch"), platform: "linux", packaged: true,
        fetch: fakeRelease(Buffer.from(`release-${seed}`), moment.fetch ?? {}),
        extract: async (_archive, into) => {
          const unpacked = join(into, "unpacked");
          await mkdir(join(unpacked, "resources", "app"), { recursive: true });
          await writeFile(join(unpacked, "branch-agent"), "the new version");
          await writeFile(join(unpacked, "resources", "app", "package.json"), JSON.stringify({ name: "branch-agent", version: "2.0.0" }));
        },
        canary: moment.canary ?? (async () => { order.push("canary"); }),
        backup: moment.backup ?? (async () => { order.push("backup"); }),
      });
      let refusal = null;
      await updater.install().catch((error) => { refusal = error; });
      assert.ok(refusal, `seed ${seed}, cut off ${moment.id}: the update went ahead anyway`);
      assertPlainRefusal(`seed ${seed}, cut off ${moment.id}`, refusal);
      assert.match(refusal.message, moment.expect, `seed ${seed}, cut off ${moment.id}: ${refusal.message}`);
      // Nothing was swapped, no hand-over was written, and the owner's work is untouched.
      assert.equal(await readFile(join(install, "branch-agent"), "utf8"), "the version in use",
        `seed ${seed}, cut off ${moment.id}: the program was replaced anyway`);
      assert.equal(await exists(join(root, "scratch", "apply-update.sh")), false, `seed ${seed}, cut off ${moment.id}: a hand-over was written`);
      assert.equal(await exists(`${install}.previous`), false, `seed ${seed}, cut off ${moment.id}: the old version was moved`);
      assert.equal(await startOrRefuse(`seed ${seed}, cut off ${moment.id}`, dataDir, workspace, before), "started");
      await assertNothingHalfInstalled(`seed ${seed}, cut off ${moment.id}`, dataDir);
      outcomes.push(`${seed}:${moment.id}`);
      // Cutting the update off never takes the safety copy after the check has already failed.
      if (moment.canary) assert.deepEqual(order, [], `seed ${seed}: a safety copy was taken after the check failed`);
      const _ = next();
    }
  }
  t.diagnostic(outcomes.join(" "));
});

/* -------- killed after the switch-over, and in the middle of a rollback -------- */

async function fakeInstall(root, marker = "old") {
  const target = join(root, "Branch-Agent-linux-x64");
  const staged = join(root, "staged", "Branch-Agent-linux-x64");
  for (const [dir, mark] of [[target, marker], [staged, "new"]]) {
    await mkdir(join(dir, "resources"), { recursive: true });
    await writeFile(join(dir, "branch-agent"), "#!/bin/sh\nexit 0\n");
    await chmod(join(dir, "branch-agent"), 0o755);
    await writeFile(join(dir, "resources", "version.txt"), mark);
  }
  return { target, staged };
}
const versionIn = (folder) => readFile(join(folder, "resources", "version.txt"), "utf8").catch(() => null);
const deadPid = () => spawnSync(process.execPath, ["-e", ""]).pid ?? 1;
const runSh = (script, args) => spawnSync("/bin/sh", [script, ...args], { stdio: "ignore" });

/** Cuts a shell script off just after the line that matches, the way a power cut would. */
function cutAfter(text, matcher) {
  const lines = text.split("\n");
  const at = lines.findIndex((line) => matcher.test(line));
  assert.ok(at >= 0, `the script has no line matching ${matcher}`);
  lines.splice(at + 1, 0, "kill -9 $$");
  return lines.join("\n");
}

/** The moments inside the swap itself, named the way the owner would describe them. */
const swapMoments = [
  { id: "after-the-new-version-was-copied-beside-the-old", after: /\|\| \{ log "copy failed/ },
  { id: "after-the-old-version-was-set-aside", after: /mv "\$TARGET" "\$PREVIOUS"/ },
  { id: "after-the-switch-over-before-the-old-copy-was-dropped", after: /mv "\$INCOMING" "\$TARGET"/ },
  { id: "while-the-spare-copy-was-being-rolled-along", after: /mv "\$PREVIOUS" "\$PREVIOUS-2"/ },
];

test(`an update cut off during the swap always leaves one whole version (${swapMoments.length} moments x ${seeds} seeds)`, { skip: !posix && "POSIX shell" }, async (t) => {
  const outcomes = [];
  const dead = deadPid();
  for (let seed = 1; seed <= seeds; seed++) {
    const next = random(seed * 15013);
    for (const moment of swapMoments) {
      const root = await temp(t, `swap-${seed}`);
      const where = join(root, moment.id);
      const install = await fakeInstall(where);
      const plan = { platform: "linux", target: install.target, staged: install.staged, log: join(where, "update.log"),
        executableName: "branch-agent", daemonPid: null, settleSeconds: 0 };
      const script = join(where, "apply.sh");
      await writeFile(script, cutAfter(posixHandOverScript(plan), moment.after));
      runSh(script, [String(dead), "stay"]);
      const said = await repairSwap(install.target);
      const label = `seed ${seed}, cut off ${moment.id}`;
      const now = await versionIn(install.target);
      assert.ok(now === "old" || now === "new", `${label}: the program folder does not hold a whole version (${now}); ${said.join(" ")}`);
      assert.equal(await exists(`${install.target}.incoming`), false, `${label}: a half-copied version was left behind`);
      for (const line of said) assert.match(line, /^[A-Z].*\.$/, `${label}: the repair was not said in plain words: ${line}`);
      // Something to go back to, unless the swap never reached the point of setting one aside.
      const spare = await versionIn(`${install.target}.previous`);
      assert.ok(spare === null || spare === "old" || spare === "new", `${label}: the spare copy is not a whole version`);
      outcomes.push(`${seed}:${moment.id}:${now}`);
      next();
    }
  }
  t.diagnostic(outcomes.join(" "));
});

test(`a rollback cut off part-way still leaves one whole version (${seeds} seeds)`, { skip: !posix && "POSIX shell" }, async (t) => {
  const cuts = [/mv "\$TARGET" "\$FAILED"/, /mv "\$PREVIOUS" "\$TARGET"/, /mv "\$PREVIOUS-2" "\$PREVIOUS"/, /drop "\$FAILED"/];
  const outcomes = [];
  const dead = deadPid();
  for (let seed = 1; seed <= seeds; seed++) {
    const next = random(seed * 20011);
    for (const cut of cuts) {
      const root = await temp(t, `rollback-${seed}`);
      const where = join(root, `cut-${cuts.indexOf(cut)}`);
      const { target } = await fakeInstall(where, "the one that failed");
      for (const [suffix, marker] of [[".previous", "the one before"], [".previous-2", "the one before that"]]) {
        await mkdir(join(`${target}${suffix}`, "resources"), { recursive: true });
        await writeFile(join(`${target}${suffix}`, "resources", "version.txt"), marker);
        await writeFile(join(`${target}${suffix}`, "branch-agent"), "#!/bin/sh\nexit 0\n");
      }
      const script = join(where, "roll-back.sh");
      await writeFile(script, cutAfter(posixRollbackScript({ platform: "linux", target, log: join(where, "roll-back.log"), executableName: "branch-agent" }), cut));
      runSh(script, [String(dead), "stay"]);
      const label = `seed ${seed}, rollback cut at ${cut}`;
      // Whatever the cut, some whole version is reachable: in place, set aside, or kept as the spare.
      const anywhere = await Promise.all([target, `${target}.previous`, `${target}.failed`, `${target}.previous-2`].map(versionIn));
      assert.ok(anywhere.some((one) => one !== null), `${label}: every version was lost`);
      const inPlace = anywhere[0];
      if (inPlace === null) {
        // Nothing in place: the previous one must still be there for `repairSwap` or a person to put back.
        assert.ok(anywhere[1] !== null || anywhere[3] !== null, `${label}: nothing in place and nothing to go back to`);
      }
      outcomes.push(`${seed}:${cuts.indexOf(cut)}:${inPlace ?? "none"}`);
      next();
    }
  }
  t.diagnostic(outcomes.join(" "));
});

/* ============================== 2. killed in the middle of a migration ====================== */

const migrationScript = resolve("tests/fixtures/never-break-kill-migration.mjs");

test(`a change to the shape of the data killed part-way, twice, is finished by a newer version (${seeds * 4} tries)`, async (t) => {
  const outcomes = [];
  for (let seed = 1; seed <= seeds; seed++) {
    const next = random(seed * 30011);
    const root = await temp(t, `migrate-${seed}`);
    for (let trial = 0; trial < 4; trial++) {
      const path = join(root, `try-${trial}.sqlite`);
      const db = new DatabaseSync(path);
      db.exec("PRAGMA journal_mode=WAL; CREATE TABLE notes(t TEXT)");
      db.prepare("INSERT INTO notes VALUES('the owner''s memory')").run();
      migrate(db, [{ version: 1, readableBy: 1, up: () => undefined, down: () => undefined }], { backupTo: null });
      db.close();
      // Killed at a point the seed picks, twice in a row, then finished by a version that knows more.
      const at = Math.floor(next() * 5);
      for (const round of [1, 2]) {
        const killed = spawnSync(process.execPath, [migrationScript, path, String(at), String(round)], { stdio: "ignore" });
        assert.notEqual(killed.status, 0, `seed ${seed} try ${trial}: the run at step ${at} was meant to be cut off`);
      }
      const after = new DatabaseSync(path);
      const label = `seed ${seed}, killed twice at step ${at}`;
      try {
        const report = migrate(after, newerVersionMigrations(), { backupTo: null });
        assert.equal(report.to, 3, `${label}: the newer version did not finish the change`);
        assertFormatWhole(label, formatOf(after), newerVersionMigrations());
        assert.equal(after.prepare("SELECT t FROM notes").get().t, "the owner's memory", `${label}: the owner's memory was lost`);
        const columns = after.prepare("PRAGMA table_info(notes)").all().map((row) => row.name);
        assert.deepEqual(columns, ["t", "extra", "newer"], `${label}: the change is half-applied: ${columns.join(",")}`);
        assert.equal(after.prepare("SELECT x FROM more").get().x, "filled in", `${label}: the change ran but left its work undone`);
      } finally { after.close(); }
      outcomes.push(`${seed}:${trial}:step${at}`);
    }
  }
  t.diagnostic(outcomes.join(" "));
});

/** What the "newer version" of Branch knows how to do, used by the test above and its fixture. */
function newerVersionMigrations() {
  return [
    { version: 1, readableBy: 1, up: () => undefined, down: () => undefined },
    { version: 2, readableBy: 1,
      up: (d) => { d.exec("ALTER TABLE notes ADD COLUMN extra TEXT"); d.exec("UPDATE notes SET extra='moved'");
        d.exec("CREATE TABLE IF NOT EXISTS more(x TEXT)"); d.exec("INSERT INTO more VALUES('filled in')"); },
      down: (d) => d.exec("ALTER TABLE notes DROP COLUMN extra") },
    { version: 3, readableBy: 2, up: (d) => d.exec("ALTER TABLE notes ADD COLUMN newer TEXT"),
      down: (d) => d.exec("ALTER TABLE notes DROP COLUMN newer") },
  ];
}

test(`settings written over while Branch was being killed never stop it starting (${seeds * 10} tries)`, async (t) => {
  const root = await temp(t, "settings");
  for (let trial = 0; trial < seeds * 10; trial++) {
    const next = random(trial + 101);
    const dataDir = join(root, `try-${trial}`);
    await mkdir(dataDir, { recursive: true });
    const good = GatewayConfigSchema.parse({ mode: "on", holdSeconds: 11 });
    await promoteGood(dataDir, good);
    await saveGatewayConfig(dataDir, good);
    // A settings file caught half-written: cut short, or the two halves of two different writes.
    const whole = await readFile(join(dataDir, "gateway.json"), "utf8");
    const other = JSON.stringify({ ...good, holdSeconds: 33, startSeconds: 45 });
    const kind = Math.floor(next() * 3);
    const torn = kind === 0 ? whole.slice(0, Math.floor(next() * whole.length))
      : kind === 1 ? whole.slice(0, whole.length / 2) + other.slice(other.length / 2)
      : `${whole}${whole}`;
    await writeFile(join(dataDir, "gateway.json"), torn);
    const loaded = await loadGatewayConfig(dataDir);
    assert.ok(GatewayConfigSchema.safeParse(loaded.config).success, `try ${trial} (kind ${kind}): the settings in use are not valid`);
    if (loaded.problem) {
      assert.equal(loaded.config.holdSeconds, 11, `try ${trial}: the last settings known to be good were not put back`);
      assert.doesNotMatch(loaded.problem, systemWords, `try ${trial}: ${loaded.problem}`);
    }
  }
});

/* ============================== 3. a machine that is already broken ========================= */

/**
 * The states a machine can be in before Branch even starts. Each one is made on a folder that
 * already holds the owner's work, so the rules can be checked against what was there.
 */
/**
 * A folder nobody may write in. Windows ignores the read-only mark on a folder, so chmod there makes
 * nothing read-only and Branch rightly starts; the same state is made by denying writes in the
 * folder's permissions, which is what a read-only folder is on Windows, and taken off again after.
 */
const everyone = "*S-1-1-0";
const icacls = (...args) => {
  const done = spawnSync(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "icacls.exe"), args, { encoding: "utf8" });
  assert.equal(done.status, 0, `icacls ${args.join(" ")}: ${done.stdout}${done.stderr}`);
};
async function makeReadOnly(dir) {
  if (process.platform === "win32") icacls(dir, "/deny", `${everyone}:(OI)(CI)(W,D,DC)`);
  else await chmod(dir, 0o500);
}
async function makeWritable(dir) {
  if (process.platform === "win32") icacls(dir, "/remove:d", everyone);
  else await chmod(dir, 0o700);
}
const brokenStates = [
  { id: "the-data-folder-is-read-only", must: "refused",
    make: async ({ dataDir }) => { await makeReadOnly(dataDir); }, undo: async ({ dataDir }) => { await makeWritable(dataDir); } },
  { id: "the-database-was-cut-off-half-written", must: "refused",
    make: async ({ dataDir }) => { const p = join(dataDir, "branch.sqlite"); await truncate(p, Math.floor((await stat(p)).size / 2)); } },
  { id: "the-database-is-not-a-database", must: "refused",
    make: async ({ dataDir }) => { await writeFile(join(dataDir, "branch.sqlite"), "this file was replaced by something else"); } },
  { id: "a-page-of-the-database-was-scribbled-over", must: "either",
    make: async ({ dataDir }) => { const fh = await open(join(dataDir, "branch.sqlite"), "r+"); await fh.write(Buffer.alloc(4096, 0x41), 0, 4096, 8192); await fh.close(); } },
  { id: "the-journal-has-a-torn-last-entry", must: "started",
    make: async ({ dataDir }) => { const p = join(dataDir, "journal.sqlite"); await truncate(p, Math.max(0, (await stat(p)).size - 300)); } },
  { id: "the-journal-is-not-a-database", must: "started",
    make: async ({ dataDir }) => { await writeFile(join(dataDir, "journal.sqlite"), "scribbled on"); } },
  { id: "the-settings-are-not-valid-json", must: "started",
    make: async ({ dataDir }) => { await writeFile(join(dataDir, "gateway.json"), "{ half a settings file,,,"); } },
  { id: "the-note-about-what-is-running-is-rubbish", must: "started",
    make: async ({ dataDir }) => { await writeFile(join(dataDir, "running.json"), "\x00\x00not json"); } },
  { id: "the-note-about-the-last-update-is-rubbish", must: "started",
    make: async ({ dataDir }) => { await writeFile(join(dataDir, "update-watch.json"), "{"); } },
  { id: "the-device-key-was-cut-off-half-written", must: "started",
    make: async ({ dataDir }) => { await writeFile(join(dataDir, "locker.key"), "hal"); } },
  { id: "the-update-copies-folder-is-a-file", must: "started",
    make: async ({ dataDir }) => { await writeFile(join(dataDir, "update-backups"), "not a folder"); } },
  { id: "a-copy-taken-for-a-check-was-left-behind", must: "started",
    make: async ({ dataDir }) => { await mkdir(join(dataDir, "updates", "canary-2020-01-01T00-00-00-000Z", "data"), { recursive: true }); },
    allowLeftovers: true },
];

test(`Branch started on a broken machine either starts with everything there or says why (${brokenStates.length} states x ${seeds} seeds)`, async (t) => {
  const outcomes = [];
  for (let seed = 1; seed <= seeds; seed++) {
    const next = random(seed * 40009);
    // The seed decides the order, so a long run tries them in different sequences; each is still tried.
    const order = [...brokenStates].sort(() => next() - 0.5);
    for (const state of order) {
      const root = await temp(t, `broken-${seed}`);
      const made = await ownersData(root);
      await state.make(made);
      const label = `seed ${seed}, ${state.id}`;
      let outcome;
      try { outcome = await startOrRefuse(label, made.dataDir, made.workspace, made.before); }
      finally { await state.undo?.(made); }
      if (state.must !== "either") assert.equal(outcome, state.must, `${label}: expected it to have ${state.must}`);
      if (outcome === "started" && !state.allowLeftovers) await assertNothingHalfInstalled(label, made.dataDir);
      outcomes.push(`${seed}:${state.id}:${outcome}`);
    }
  }
  t.diagnostic(outcomes.join(" "));
});

/** What SQLite really hands back, message and number together, as its own tests would. */
const sqliteError = (message, errcode) => Object.assign(new Error(message), { code: "ERR_SQLITE_ERROR", errcode, errstr: message });

test("a refusal names the file, says nothing was changed, and says what to do next", () => {
  const path = "/home/someone/Branch/state/branch.sqlite";
  for (const [why, must] of [
    [sqliteError("database disk image is malformed", 11), /damaged[\s\S]*nothing was changed[\s\S]*safety cop(y|ies)/i],
    [sqliteError("file is not a database", 26), /damaged[\s\S]*safety cop(y|ies)/i],
    [sqliteError("attempt to write a readonly database", 1544), /cannot write[\s\S]*allowed to write/i],
    [sqliteError("database or disk is full", 13), /no room left[\s\S]*Free some space/i],
    // A folder that has gone and a disk with no room both say this; it must not blame permissions alone.
    [sqliteError("unable to open database file", 14), /moved, renamed[\s\S]*disk may be full[\s\S]*allowed to read it/i],
    [new Error("database disk image is malformed"), /damaged/i],
    [new Error("attempt to write a readonly database"), /cannot write/i],
  ]) {
    const sentence = dataProblemSentence(path, why);
    assert.ok(sentence, `no plain words for ${why.message}`);
    assert.ok(sentence.includes(path), `the refusal does not say which file: ${sentence}`);
    assert.match(sentence, must, sentence);
    assertPlainRefusal(why.message, new Error(sentence));
  }
  assert.equal(dataProblemSentence(path, new Error("something nobody expected")), null, "an unknown problem is not dressed up");
  const passed = dataOpenError(path, new DataTooNewError(9, 9, 1));
  assert.ok(passed instanceof DataTooNewError, "a refusal that already reads well is left alone");
});

test("only a database another Branch is holding makes the format check step aside", async (t) => {
  const root = await temp(t, "held");
  const { dataDir, workspace } = await ownersData(root);
  const path = join(dataDir, "branch.sqlite");
  // A message that merely mentions being busy is not a reason to skip the check: only SQLite's own
  // numbers for busy (5) and locked (6) are, or an older Branch would write to newer data again.
  const stamped = new DatabaseSync(path);
  stamped.exec("CREATE TABLE IF NOT EXISTS branch_format(id INTEGER PRIMARY KEY CHECK (id=1), version INTEGER NOT NULL, readable_by INTEGER NOT NULL, changed_at TEXT NOT NULL)");
  stamped.prepare("INSERT INTO branch_format(id,version,readable_by,changed_at) VALUES(1,99,98,?) ON CONFLICT(id) DO UPDATE SET version=99, readable_by=98").run(new Date().toISOString());
  stamped.exec("PRAGMA user_version=99");
  stamped.close();
  assert.throws(() => assertFormatReadable(path, storeMigrations), DataTooNewError,
    "the check must still refuse data from the future");
  // With a Branch holding the file, the check steps aside and the store says the plain thing.
  const first = await createBranch({ workspace, dataDir: join(root, "other") });
  try {
    const held = await createBranch({ workspace, dataDir: join(root, "other") }).then(() => null, (error) => error);
    assertPlainRefusal("a second Branch", held);
  } finally { await first.close(); }
});

test("a copy that cannot be taken before a change to the data's shape stops it in plain words", async (t) => {
  const root = await temp(t, "no-copy");
  const path = join(root, "x.sqlite");
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE notes(t TEXT)");
  db.prepare("INSERT INTO notes VALUES('the owner''s memory')").run();
  migrate(db, [{ version: 1, readableBy: 1, up: () => undefined, down: () => undefined }], { backupTo: null });
  try {
    // `update-backups` is a file, not a folder: the copy cannot be written, so nothing may change.
    await writeFile(join(root, "update-backups"), "something is in the way");
    const refused = (() => { try { migrate(db, newerVersionMigrations(), { backupTo: join(root, "update-backups", "before.sqlite") }); return null; } catch (error) { return error; } })();
    assert.ok(refused, "the change went ahead with no copy to go back to");
    assertPlainRefusal("no room for the copy", refused);
    assert.match(refused.message, /could not take the copy[\s\S]*nothing was changed[\s\S]*update-backups/i, refused.message);
    assert.equal(formatOf(db).version, 1, "the change was not half-applied");
    assert.deepEqual(db.prepare("PRAGMA table_info(notes)").all().map((row) => row.name), ["t"], "nothing was added");
    // With the way clear it goes through and the owner's memory is still there.
    await rm(join(root, "update-backups"), { force: true });
    await mkdir(join(root, "update-backups"), { recursive: true });
    const report = migrate(db, newerVersionMigrations(), { backupTo: join(root, "update-backups", "before.sqlite") });
    assert.equal(report.to, 3);
    assert.equal(db.prepare("SELECT t FROM notes").get().t, "the owner's memory");
  } finally { db.close(); }
});

/* ============================== 4. data from the wrong version ============================== */

test(`data from a newer Branch is refused without a single byte being changed (${seeds} seeds)`, async (t) => {
  const outcomes = [];
  for (let seed = 1; seed <= seeds; seed++) {
    const next = random(seed * 50021);
    const root = await temp(t, `newer-${seed}`);
    const { dataDir, workspace, before } = await ownersData(root);
    const newest = storeMigrations.at(-1).version;
    const ahead = newest + 1 + Math.floor(next() * 40);
    // A task the newer Branch left running, and a table only it knows about: neither may be touched.
    const db = new DatabaseSync(join(dataDir, "branch.sqlite"));
    db.prepare("UPDATE tasks SET status='running', output=''").run();
    db.exec("CREATE TABLE only_the_newer_one_knows(x TEXT)");
    db.prepare("INSERT INTO only_the_newer_one_knows VALUES(?)").run("the owner's newer work");
    db.exec("CREATE TABLE IF NOT EXISTS branch_format(id INTEGER PRIMARY KEY CHECK (id=1), version INTEGER NOT NULL, readable_by INTEGER NOT NULL, changed_at TEXT NOT NULL)");
    db.prepare("INSERT INTO branch_format(id,version,readable_by,changed_at) VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version, readable_by=excluded.readable_by")
      .run(ahead, ahead, new Date().toISOString());
    db.exec(`PRAGMA user_version=${ahead}`);
    db.close();
    const digest = async () => createHash("sha256").update(await readFile(join(dataDir, "branch.sqlite"))).digest("hex");
    const wasAt = await digest();
    const label = `seed ${seed}, data from format ${ahead}`;
    let refusal = null;
    await createBranch({ workspace, dataDir }).then((app) => app.close(), (error) => { refusal = error; });
    assert.ok(refusal instanceof DataTooNewError, `${label}: an older Branch opened work it cannot read`);
    assertPlainRefusal(label, refusal);
    assert.match(refusal.message, /Nothing was changed/, label);
    assert.equal(await digest(), wasAt, `${label}: the file was changed although the refusal says nothing was`);
    // And the same check on its own, the way the start-up calls it.
    assert.throws(() => assertFormatReadable(join(dataDir, "branch.sqlite"), storeMigrations), DataTooNewError, label);
    outcomes.push(`${seed}:format-${ahead}`);
    const _ = before;
  }
  t.diagnostic(outcomes.join(" "));
});

/**
 * Stamps a data folder as having been written by a Branch newer than this one. `readableBy` says the
 * oldest format that can still read it, and it is what decides whether this build may open it at
 * all: data marked as still readable here is meant to open, so it defaults to the new format.
 */
function stampFromTheFuture(dataDir, ahead, readableBy = ahead) {
  const db = new DatabaseSync(join(dataDir, "branch.sqlite"));
  try {
    db.prepare("UPDATE tasks SET status='running', output=''").run();
    db.exec("CREATE TABLE IF NOT EXISTS branch_format(id INTEGER PRIMARY KEY CHECK (id=1), version INTEGER NOT NULL, readable_by INTEGER NOT NULL, changed_at TEXT NOT NULL)");
    db.prepare("INSERT INTO branch_format(id,version,readable_by,changed_at) VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version, readable_by=excluded.readable_by")
      .run(ahead, readableBy, new Date().toISOString());
    db.exec(`PRAGMA user_version=${ahead}`);
  } finally { db.close(); }
}

/** A release the headless updater can find, download and check, with nothing leaving this computer. */
function releaseFor(archive) {
  const digest = createHash("sha256").update(archive).digest("hex");
  return async (url) => {
    const text = String(url);
    if (text.includes("releases/latest"))
      return Response.json({ tag_name: "v2.0.0", name: null, body: "", published_at: null,
        html_url: "https://example.invalid/releases/tag/v2.0.0",
        assets: [{ name: "Branch-Agent-linux-x64.tar.gz", browser_download_url: "https://example.invalid/app.tgz", size: archive.length },
          { name: "Branch-Agent-linux-x64.tar.gz.sha256", browser_download_url: "https://example.invalid/app.sha256", size: 64 }] });
    if (text.endsWith("app.tgz")) return new Response(archive);
    return new Response(`${digest}  Branch-Agent-linux-x64.tar.gz\n`);
  };
}

test(`\`branch update --yes\` on data from a newer Branch refuses without touching it (${seeds} seeds)`, { skip: !posix && "POSIX shell" }, async (t) => {
  const outcomes = [];
  for (let seed = 1; seed <= seeds; seed++) {
    const next = random(seed * 80021);
    const root = await temp(t, `headless-${seed}`);
    const { dataDir } = await ownersData(root);
    const ahead = storeMigrations.at(-1).version + 1 + Math.floor(next() * 20);
    // Two ways in, and the seed picks one. With the never-break switch on, the copy for the check is
    // taken first; with it off there is no check, and the safety copy is the first thing to open the
    // saved work. Both go through the same `withStore`, and both must refuse before writing.
    const checking = next() < 0.5;
    await saveGatewayConfig(dataDir, GatewayConfigSchema.parse({ mode: checking ? "on" : "off" }));
    stampFromTheFuture(dataDir, ahead);
    const digest = async () => createHash("sha256").update(await readFile(join(dataDir, "branch.sqlite"))).digest("hex");
    const wasAt = await digest();
    // The safety copy and the copy for the check are the real ones, so they open the saved work the
    // way `branch update --yes` does when nothing is running to hold it.
    const lines = [];
    const code = await headlessUpdate({
      installRoot: join(root, "app"), dataDir, version: "1.0.0", platform: "linux", arch: "x64", yes: true,
      print: (line) => lines.push(line),
      deps: {
        // This is a test of the data check, not of provenance, so this release names itself the last without a record.
        lastReleaseWithoutProvenance: "2.0.0",
        fetch: releaseFor(Buffer.from(`release-${seed}`)),
        scratchDir: join(root, "scratch"),
        running: async () => null,
        extract: async (_file, into) => {
          const unpacked = join(into, "Branch-Agent-linux-x64");
          await mkdir(join(unpacked, "resources", "app"), { recursive: true });
          await writeFile(join(unpacked, "branch-agent"), "new");
          await writeFile(join(unpacked, "resources", "app", "package.json"), JSON.stringify({ name: "branch-agent", version: "2.0.0" }));
        },
        quit: async () => ({ stopped: true, wasRunning: false, pid: null, message: "" }),
        runScript: () => { throw new Error(`seed ${seed}: the files were swapped although the saved work could not be read`); },
      },
    });
    const label = `seed ${seed}, \`branch update --yes\` on data from format ${ahead} (${checking ? "the copy for the check" : "the safety copy"})`;
    assert.equal(code, 1, `${label}: the update went ahead`);
    assert.equal(await digest(), wasAt, `${label}: the saved work was changed by an update that then refused`);
    const said = lines.join("\n");
    assert.match(said, /newer version of Branch|cannot read safely/, `${label}: ${said}`);
    assert.doesNotMatch(said, systemWords, `${label}: ${said}`);
    outcomes.push(`${seed}:format-${ahead}:${checking ? "check-copy" : "safety-copy"}`);
  }
  t.diagnostic(outcomes.join(" "));
});

test("data a newer Branch marked as still readable here opens, and is not dragged back", async (t) => {
  // Seed 5 of the update round drew this case and showed the tests were asking for the wrong thing.
  // A change that only adds keeps `readableBy` at the old number precisely so the release before can
  // still open the data — going back one version is the whole point of it, so it must not refuse,
  // and it must not quietly stamp the data back down to its own format either.
  const root = await temp(t, "readable-ahead");
  const { dataDir, workspace, before } = await ownersData(root);
  const newest = storeMigrations.at(-1).version;
  stampFromTheFuture(dataDir, newest + 1, newest);
  assert.doesNotThrow(() => assertFormatReadable(join(dataDir, "branch.sqlite"), storeMigrations),
    "data marked as still readable by this format must open");
  assert.equal(await startOrRefuse("newer data still readable here", dataDir, workspace, before), "started");
  const db = new DatabaseSync(join(dataDir, "branch.sqlite"), { readOnly: true });
  try {
    assert.equal(formatOf(db).version, newest + 1, "the newer version's format stamp was not written over");
  } finally { db.close(); }
  // One more ahead than that, and no longer readable here: it must refuse.
  stampFromTheFuture(dataDir, newest + 2, newest + 1);
  assert.throws(() => assertFormatReadable(join(dataDir, "branch.sqlite"), storeMigrations), DataTooNewError);
});

test("data from a much older Branch opens and keeps everything", async (t) => {
  const root = await temp(t, "older");
  const { dataDir, workspace, before } = await ownersData(root);
  // What a Branch from before formats were numbered left behind: no stamp at all.
  const db = new DatabaseSync(join(dataDir, "branch.sqlite"));
  db.exec("DROP TABLE IF EXISTS branch_format");
  db.exec("PRAGMA user_version=0");
  db.close();
  assert.doesNotThrow(() => assertFormatReadable(join(dataDir, "branch.sqlite"), storeMigrations));
  assert.equal(await startOrRefuse("much older data", dataDir, workspace, before), "started");
  const after = await fingerprint(dataDir, workspace);
  assertFormatWhole("much older data", after.format);
  assert.equal(after.format.version, storeMigrations.at(-1).version, "the old data was brought up to this version's format");
});

test("a saved-work file that was never there is not treated as damaged", async (t) => {
  const root = await temp(t, "absent");
  assert.doesNotThrow(() => assertFormatReadable(join(root, "nothing-here.sqlite"), storeMigrations));
});

/* ============================== 5. the clock talking nonsense ============================== */

test("a clock that jumped backwards neither holds an update's watch open nor rolls a good version back", () => {
  const started = Date.parse("2026-09-18T12:00:00.000Z");
  const watch = { from: "1.0.0", to: "2.0.0", target: "/x", platform: "linux", executableName: "b", startedAt: new Date(started).toISOString() };
  const at = (now, extra) => watchVerdict(watch, { now, watchSeconds: 300, runningVersion: "2.0.0", failing: false, ...extra });
  const year = 365 * 86400 * 1000;
  assert.equal(at(started + 10_000), "watching", "the ordinary case still watches");
  assert.equal(at(started - year), "done", "a clock a year behind does not keep watching for ever");
  assert.equal(at(started - year, { failing: true }), "done", "a crash with the clock a year behind is not an update to roll back");
  assert.equal(at(started - 1000, { failing: true }), "done", "a clock a second behind is not a reason to roll back");
  assert.equal(at(started + year), "done", "a clock years ahead ends the watch rather than leaving it open");
  const unreadable = { ...watch, startedAt: "when the update happened" };
  assert.equal(watchVerdict(unreadable, { now: Date.now(), watchSeconds: 300, runningVersion: "2.0.0", failing: true }), "done",
    "a time that cannot be read is not a reason to roll back either");
});

test("a clock that jumped backwards never throws away the safety copy just written", async (t) => {
  const root = await temp(t, "clock-backups");
  const dataDir = join(root, "d");
  const times = ["2026-09-15T10:00:00Z", "2026-09-16T10:00:00Z", "2026-09-17T10:00:00Z"];
  for (const [index, when] of times.entries())
    await writeUpdateBackup(dataDir, { note: `copy ${index}` }, `0.17.${index}`, new Date(when));
  // The clock jumps back years; this copy is the newest there is, and must survive the tidy-up.
  const jumped = new Date("2019-01-01T10:00:00Z");
  const written = await writeUpdateBackup(dataDir, { note: "taken after the clock jumped" }, "0.18.0", jumped);
  const name = backupFileName("0.18.0", jumped);
  assert.ok(!written.pruned.includes(name), `the copy just written was thrown away: ${written.pruned.join(", ")}`);
  assert.ok(await exists(join(dataDir, "update-backups", name)), "the copy just written is gone");
  assert.deepEqual(JSON.parse(await readFile(join(dataDir, "update-backups", name), "utf8")), { note: "taken after the clock jumped" });
  assert.deepEqual(backupsToPrune([name, ...times.map((when, i) => backupFileName(`0.17.${i}`, new Date(when)))], 3, name).includes(name), false);
});

test("the copies taken before a change to the data's shape do not pile up for ever", () => {
  const names = Array.from({ length: 7 }, (_, i) => `before-format-${1_700_000_000_000 + i}.sqlite`);
  const pruned = formatCopiesToPrune([...names].reverse(), 3);
  assert.deepEqual(pruned, names.slice(0, 4), "the oldest are let go and the newest three kept");
  assert.deepEqual(formatCopiesToPrune(["before-2026-09-17T10-00-00-v0.17.0.json", "notes.txt"], 3), [],
    "the owner's own safety copies are not touched by this");
});

test(`the clock jumping between two starts loses nothing (${seeds} seeds)`, async (t) => {
  const outcomes = [];
  for (let seed = 1; seed <= seeds; seed++) {
    const next = random(seed * 60013);
    const root = await temp(t, `clock-${seed}`);
    const { dataDir, workspace, before } = await ownersData(root);
    // The note an update leaves behind, written with a time the clock will later contradict.
    const jump = next() < 0.5 ? -400 * 86400 * 1000 : 400 * 86400 * 1000;
    await writeWatch(dataDir, { from: "1.0.0", to: "2.0.0", target: join(root, "installed"), platform: "linux",
      executableName: "branch-agent", startedAt: new Date(Date.now() - jump).toISOString() });
    const label = `seed ${seed}, clock jumped ${Math.round(jump / 86400000)} days`;
    assert.equal(await startOrRefuse(label, dataDir, workspace, before), "started");
    const watch = await readWatch(dataDir);
    assert.ok(watch, `${label}: the note about the update became unreadable`);
    assert.equal(watchVerdict(watch, { now: Date.now(), watchSeconds: 300, runningVersion: "2.0.0", failing: true }), "done",
      `${label}: a clock that jumped would have rolled a good version back`);
    outcomes.push(`${seed}:${jump > 0 ? "forwards" : "backwards"}`);
  }
  t.diagnostic(outcomes.join(" "));
});

/* ============================== 6. two Branches on one folder ============================== */

test(`a second Branch on the same folder refuses cleanly and the first keeps working (${seeds} seeds)`, async (t) => {
  const outcomes = [];
  for (let seed = 1; seed <= seeds; seed++) {
    const root = await temp(t, `two-${seed}`);
    const { dataDir, workspace, before } = await ownersData(root);
    const first = await createBranch({ workspace, dataDir });
    let refusal = null, second = null;
    try {
      await createBranch({ workspace, dataDir }).then((app) => { second = app; }, (error) => { refusal = error; });
      assert.equal(second, null, `seed ${seed}: two Branches opened the same saved work at once`);
      assertPlainRefusal(`seed ${seed}, a second Branch`, refusal);
      assert.match(refusal.message, /already open|already running/i, `seed ${seed}: ${refusal.message}`);
      assert.match(refusal.message, /Nothing was changed/, `seed ${seed}: the refusal does not say the work is safe`);
      // The first one is untouched by the attempt and still works.
      const run = await first.runtime.run({ prompt: "still working", onTextDelta: () => undefined });
      assert.notEqual(run.status, "failed", `seed ${seed}: the first Branch was disturbed`);
    } finally {
      if (second) await second.close();
      await first.close();
    }
    assert.equal(await startOrRefuse(`seed ${seed}, after both closed`, dataDir, workspace, before), "started");
    outcomes.push(`${seed}:refused-cleanly`);
  }
  t.diagnostic(outcomes.join(" "));
});

/* ============================== 7. a fetched extra that is not all there =================== */

/**
 * How a fetched extra can be wrong on disk, and what can honestly be told about it without running
 * it. A file that is gone or empty can be seen from the outside; one whose insides are scrambled
 * cannot, so there the rule is only that Branch still starts and the failure reads as a sentence.
 */
const extraStates = [
  { id: "deleted", seen: true, make: async (path) => { await rm(path, { force: true }); } },
  { id: "half-downloaded", seen: true, make: async (path) => { await writeFile(path, ""); await chmod(path, 0o755); } },
  { id: "corrupted", seen: false, make: async (path) => { await writeFile(path, "\x00\x00broken"); await chmod(path, 0o755); } },
];

test(`a fetched extra that is missing or half-there says why, and Branch still starts (${extraStates.length} states x ${seeds} seeds)`, async (t) => {
  const outcomes = [];
  for (let seed = 1; seed <= seeds; seed++) {
    const next = random(seed * 70001);
    for (const state of extraStates) {
      const root = await temp(t, `extra-${seed}-${state.id}`);
      const { dataDir, workspace, before } = await ownersData(root);
      const label = `seed ${seed}, the browser was ${state.id}`;
      const browser = join(root, "chromium-shell");
      await writeFile(browser, "#!/bin/sh\nexit 0\n");
      await chmod(browser, 0o755);
      await state.make(browser);
      // The browser check, asked the same question the health screen asks.
      const present = async () => {
        const info = await stat(browser).catch(() => null);
        return Boolean(info?.isFile() && info.size > 0);
      };
      const report = await doctorFix({ fix: false, port: 0, workspace, browsersInstalled: present, platform: "linux" },
        { run: async () => { throw new Error("nothing is run in this test"); }, portFree: async () => true });
      const web = report.checks.find((check) => check.name === "Web browsing");
      assert.doesNotMatch(web.summary, systemWords, `${label}: ${web.summary}`);
      if (state.seen) {
        assert.equal(web.ok, false, `${label}: an extra that is not there was called installed`);
        assert.match(web.summary, /missing/, `${label}: ${web.summary}`);
        assert.match(web.fix, /playwright install chromium/, `${label}: the fix does not say how to get it back`);
      }

      // The reading-aloud program, in the same three states.
      const speech = builtInSpeech().get("program");
      const spoke = await speech.speak("hello", { settings: { program: browser, programArgs: ["{text}", "{out}"] },
        run: async () => { throw new Error("the program on this computer could not be run"); } }).then(() => null, (error) => error);
      assert.ok(spoke, `${label}: speech claimed to work with no program to run it`);
      if (state.seen) {
        assertPlainRefusal(`${label} (speech)`, spoke);
        assert.match(spoke.message, /is not there any more|did not finish/, `${label}: ${spoke.message}`);
        assert.match(spoke.message, /Settings/, `${label}: the refusal does not say where to fix it`);
      }
      assert.doesNotMatch(spoke.message, systemWords, `${label} (speech): ${spoke.message}`);
      // Whatever the extras are doing, Branch itself still starts with everything in place.
      assert.equal(await startOrRefuse(label, dataDir, workspace, before), "started");
      outcomes.push(`${seed}:${state.id}`);
      next();
    }
  }
  t.diagnostic(outcomes.join(" "));
});

/* ============================== 8. the disk filling up while starting ====================== */

test(`a disk with no room left stops the start with a sentence, and a start after it works (${seeds} seeds)`, async (t) => {
  const outcomes = [];
  for (let seed = 1; seed <= seeds; seed++) {
    const root = await temp(t, `full-${seed}`);
    const { dataDir, workspace, before } = await ownersData(root);
    // No room to write the safety copy an update takes first.
    const huge = { note: "x".repeat(1) };
    await writeFile(join(dataDir, "update-backups"), "a file where the folder should be").catch(() => undefined);
    const refused = await writeUpdateBackup(dataDir, huge, "0.17.0").then(() => null, (error) => error);
    assert.ok(refused, `seed ${seed}: the safety copy was written although there was nowhere to put it`);
    await rm(join(dataDir, "update-backups"), { force: true });
    // And once there is room again, everything works and nothing was lost.
    const written = await writeUpdateBackup(dataDir, huge, "0.17.0");
    assert.ok(await exists(written.path), `seed ${seed}: the safety copy was not written once there was room`);
    assert.equal(await startOrRefuse(`seed ${seed}, after the disk filled up`, dataDir, workspace, before), "started");
    // The journal refusing to write is already the first round's ground; here it must not lose work.
    const app = await createBranch({ workspace, dataDir });
    try {
      app.neverBreak.journal.failWrites = () => new Error("ENOSPC: no space left on device");
      const run = await app.runtime.run({ prompt: "one more thing", onTextDelta: () => undefined });
      if (run.status !== "completed") assert.match(run.output, /disk may be full/, `seed ${seed}: ${run.output}`);
      app.neverBreak.journal.failWrites = null;
    } finally { await app.close(); }
    assert.equal(await startOrRefuse(`seed ${seed}, after the journal could not write`, dataDir, workspace, before), "started");
    outcomes.push(`${seed}:no-room`);
  }
  t.diagnostic(outcomes.join(" "));
});

/* ============================== 9. a journal cut off mid-write ============================= */

test(`a journal cut off mid-write is put aside and Branch starts with a fresh one (${seeds * 3} tries)`, async (t) => {
  const root = await temp(t, "journal");
  for (let trial = 0; trial < seeds * 3; trial++) {
    const next = random(trial + 7);
    const path = join(root, `j-${trial}.sqlite`);
    const { journal } = openJournal(path);
    journal.begin({ runId: "r", sessionId: "s", callId: "c", tool: "files.write", arguments: "{}", key: "k", effects: "idempotent", evidence: null });
    journal.close();
    const kind = Math.floor(next() * 3);
    if (kind === 0) await truncate(path, Math.max(0, Math.floor((await stat(path)).size * next())));
    else if (kind === 1) await writeFile(path, "not a journal at all");
    else {
      const db = new DatabaseSync(path);
      db.exec("PRAGMA user_version=99");
      db.exec("UPDATE branch_format SET version=99, readable_by=98");
      db.close();
    }
    const again = openJournal(path);
    try {
      assert.ok(again.journal, `try ${trial} (kind ${kind}): Branch could not open a journal at all`);
      if (again.reset) {
        assert.match(again.reset, /put aside|new one started/, `try ${trial}: ${again.reset}`);
        assert.doesNotMatch(again.reset.replace(/\(.*\)/s, ""), systemWords, `try ${trial}: ${again.reset}`);
      }
      // Whatever happened, the journal works from here on.
      const id = again.journal.begin({ runId: "r2", sessionId: "s2", callId: "c2", tool: "files.write", arguments: "{}", key: "k2", effects: "idempotent", evidence: null });
      assert.ok(id > 0, `try ${trial}: the fresh journal cannot be written to`);
    } finally { again.journal.close(); }
  }
});
