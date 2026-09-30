/**
 * A Branch that was working in the background comes back by itself after `branch update --yes` and
 * after `branch rollback --yes` (src/install/service-return.ts). Closing it for the swap is a polite
 * exit, which neither launchd's KeepAlive{SuccessfulExit:false} nor systemd (exit 78, RestartPreventExitStatus=78)
 * restarts, so before this the service stayed down until the next sign-in and the watch that rolls a
 * bad version back never ran. When the new version does not come up, the version before is put back
 * and started instead: the owner is never left with no Branch running.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { discardTemp } from "./temp-dir.mjs";
import { restartService, serviceRestartCommand, waitForReturn } from "../dist/install/service-return.js";
import { performRollback } from "../dist/never-break/rollback.js";
import { headlessUpdate } from "../dist/install/headless-update.js";
import { rollbackCommand } from "../dist/install/rollback-cli.js";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { attachToRunning, readRunning, writeRunning } from "../dist/install/running.js";
import { ActivationJournal, fingerprintTree } from "../dist/never-break/activation.js";

const posixOnly = process.platform === "win32" && "shell scripts are for macOS and Linux";
/** One newline, by its number, so no layer between here and the file has to agree about escaping. */
const NEWLINE = String.fromCharCode(10);

async function scratch(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-service-return-"));
  t.after(() => discardTemp(root));
  return root;
}

test("each system's own manager is asked to start the service again, by its exact name", () => {
  assert.deepEqual(serviceRestartCommand("darwin", 501), ["/bin/launchctl", ["kickstart", "-k", "gui/501/com.keepoak.branch-agent"]]);
  assert.deepEqual(serviceRestartCommand("linux"), ["systemctl", ["--user", "restart", "branch-agent.service"]]);
  const [tool, args] = serviceRestartCommand("win32");
  assert.match(tool, /schtasks\.exe$/i);
  assert.deepEqual(args, ["/Run", "/TN", "Branch Agent daemon"]);
  assert.throws(() => serviceRestartCommand("aix"), /not available/);
});

test("starting the service again really runs that system's own command", async () => {
  // Every test below hands in its own `restartService`, so without this the one function that
  // actually asks the system to start Branch again could do nothing at all and nothing would notice.
  const ran = [];
  await restartService("linux", async (tool, args) => { ran.push([tool, args]); });
  assert.deepEqual(ran, [["systemctl", ["--user", "restart", "branch-agent.service"]]]);

  const onMac = [];
  await restartService("darwin", async (tool, args) => { onMac.push([tool, args]); });
  assert.equal(onMac.length, 1);
  assert.equal(onMac[0][0], "/bin/launchctl");
  assert.equal(onMac[0][1][0], "kickstart");
});

/** A note the way the running file holds one, so a test says what it means rather than what it types. */
const note = (over = {}) => ({
  pid: 5151, mode: "daemon", port: 8787, url: "http://127.0.0.1:8787",
  version: "2.0.0", startedAt: "2026-09-22T10:00:05.000Z", ...over,
});
const wasRunning = { pid: 4242, mode: "daemon", port: 8787, url: "http://127.0.0.1:8787",
  version: "1.0.0", startedAt: "2026-09-22T10:00:00.000Z" };
/**
 * The wait, driven by a list of notes, with the clock and the answering Branch in the test's hands.
 * It waits for 2.0.0, the new version, unless a test names another one.
 */
async function waiting(notes, over = {}) {
  let clock = 0;
  const left = [...notes];
  const answers = over.attach === undefined ? { instance: note(), version: "2.0.0" } : over.attach;
  const back = await waitForReturn("data", wasRunning, { version: over.version ?? "2.0.0" }, {
    running: async () => left.shift() ?? null,
    attach: async () => answers,
    sleep: async (ms) => { clock += ms; },
    now: () => clock,
    waitMs: 3000,
  });
  return { back, clock };
}

test("the version a Branch answers with is not the version written down beside it", async (t) => {
  // `running.json` is written by whatever started. A swap that half happened, or an older copy that
  // wrote the file last, can leave it naming a version that is not the one now answering on the port.
  // The return check compares the answer, so the two have to come back as different things.
  const root = await mkdtemp(join(tmpdir(), "branch-attach-version-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"),
    provider: { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } } });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, presence: "app" });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });

  // Tell the note a lie the server will not repeat.
  const note = await readRunning(join(root, "data"));
  await writeRunning(join(root, "data"), { ...note, version: "9.9.9-not-really" });

  const joined = await attachToRunning(join(root, "data"));
  assert.ok(joined, "the running Branch is found");
  assert.equal(joined.instance.version, "9.9.9-not-really", "the note still says what it was told to say");
  assert.equal(joined.version, app.version, "and the version handed back is the one it answered with");
  assert.notEqual(joined.version, joined.instance.version, "which is the whole point of keeping both");
});

test("with nothing stubbed, the wait believes the running Branch and not the note", async (t) => {
  // The default way of asking is the one production uses: `attachToRunning`, with this computer's own
  // saved key. This drives it for real — a real server, a real note on disk — and makes the note claim
  // the version we are waiting for while the Branch answering says something else.
  const root = await mkdtemp(join(tmpdir(), "branch-return-real-"));
  const dataDir = join(root, "data");
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir,
    provider: { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } } });
  const server = await startServer(app, { dataDir, port: 0, presence: "app" });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });

  const started = await readRunning(dataDir);
  const before = { pid: 1, startedAt: "2000-01-01T00:00:00.000Z" };
  const clock = () => 0;
  const patient = { sleep: async () => undefined, now: clock, waitMs: 0 };

  // The note says it is the service on 2.0.0, started long after the one that was closed. Everything
  // on disk agrees. The Branch on the port does not.
  await writeRunning(dataDir, { ...started, mode: "daemon", version: "2.0.0", startedAt: "2030-01-01T00:00:00.000Z" });
  assert.equal(await waitForReturn(dataDir, before, { version: "2.0.0" }, patient), null,
    "a note that says 2.0.0 is not a Branch running 2.0.0");

  // And when what is asked for is what it really answers, it is accepted.
  await writeRunning(dataDir, { ...started, mode: "daemon", version: app.version, startedAt: "2030-01-01T00:00:00.000Z" });
  const back = await waitForReturn(dataDir, before, { version: app.version }, patient);
  assert.ok(back, "the Branch that is really there, on the version it really is");
  assert.equal(back.pid, started.pid);
});

test("the wait is for the service, on the right version, started since — and it has to answer", async () => {
  // What coming back looks like: the service, version 2.0.0, started after the one that was closed,
  // and answering on its own port with this computer's key.
  const good = await waiting([null, note()]);
  assert.equal(good.back?.pid, 5151, "that is the return");

  // Four things that look like a return and are not. Each of these was accepted before.
  const notTheService = await waiting([note({ mode: "app" })]);
  assert.equal(notTheService.back, null, "a window somebody opened is not the service coming back");

  const oldVersion = await waiting([note({ version: "1.0.0" })]);
  assert.equal(oldVersion.back, null, "coming back on the version we were leaving is not coming back");

  const staleNote = await waiting([note({ pid: 4242, startedAt: wasRunning.startedAt })]);
  assert.equal(staleNote.back, null, "the note the closed copy left behind is not a new Branch");

  const unrelated = await waiting([note({ pid: 9999, startedAt: "2026-09-22T09:59:00.000Z" })]);
  assert.equal(unrelated.back, null, "something that started before the swap is not the return either");

  // A process id the system handed out again is still a new Branch, and must not be punished for it.
  const reused = await waiting([note({ pid: 4242 })], { attach: { instance: note({ pid: 4242 }), version: "2.0.0" } });
  assert.equal(reused.back?.pid, 4242, "the same id, a later start: a new Branch");

  // And a note that cannot be made to answer is not proof of anything.
  const silent = await waiting([note(), note(), note()], { attach: null });
  assert.equal(silent.back, null, "a Branch that will not answer with this computer's key is not counted");
  assert.ok(silent.clock >= 3000 && silent.clock < 4000, "it waited as long as it was allowed, and no longer");

  const wrongAnswer = await waiting([note()], { attach: { instance: note(), version: "1.0.0" } });
  assert.equal(wrongAnswer.back, null, "and one that answers with another version is not the version we wanted");
});

test("a service put back on the same version is back only once a copy started since answers", async () => {
  // A failed update puts back the version that was running, so what is waited for is the same kind of
  // Branch on the same version as the copy that was closed. The note that copy left behind agrees on
  // both, and here it is even made to answer as that copy, so the time it started is the only thing
  // left to tell it from a copy started since.
  const leftBehind = { ...wasRunning };
  const stale = await waiting([leftBehind], { version: "1.0.0", attach: { instance: leftBehind, version: "1.0.0" } });
  assert.equal(stale.back, null, "the note the closed copy left behind, answering as that copy, is not the service back");

  const since = note({ version: "1.0.0" });
  const fresh = await waiting([since], { version: "1.0.0", attach: { instance: since, version: "1.0.0" } });
  assert.equal(fresh.back?.pid, 5151, "the same version, started after the closed copy, is the service back");
});

test("an undo whose restart fails is a failure, whatever else went right", async (t) => {
  // Everything about this undo works except the one thing that puts Branch back in front of the owner.
  // Being on the older files with nothing running them is not being back, and saying otherwise sent the
  // owner away with exit code 0 and a service that was down.
  const root = await scratch(t);
  const journal = new ActivationJournal(join(root, "activation.sqlite"));
  const target = join(root, "Apps", "Branch-Agent");
  await fakeApp(target, "2.0.0");
  await fakeApp(`${target}.previous`, "1.0.0");
  const id = journal.stage({ kind: "update", fromVersion: "1.0.0", toVersion: "2.0.0", target,
    previous: await fingerprintTree(`${target}.previous`), candidate: await fingerprintTree(target),
    launcher: null, executableName: "branch-agent", understood: 1, databases: [], backups: [] });
  journal.activated(id);

  const shared = {
    journal, by: "test@test",
    observe: async () => ({ current: await fingerprintTree(target), previous: await fingerprintTree(`${target}.previous`), store: null, runnerKnows: 0 }),
    swap: async () => ["put version 1.0.0 back"],
  };
  const refused = await performRollback(journal.current(), { ...shared, restart: async () => { throw new Error("no such unit"); } });
  assert.equal(refused.ok, false, "the undo did not do what it set out to do");
  assert.match(refused.message, /could not be started again/);
  assert.match(refused.message, /no such unit/, "and says what the manager said");
  assert.ok(refused.steps.some((step) => step.step === "started Branch again" && !step.ok), "the step is written down as failed");

  // The same undo with a restart that works is a success, so this is about the restart and nothing else.
  journal.activated(journal.stage({ kind: "update", fromVersion: "1.0.0", toVersion: "2.0.0", target,
    previous: await fingerprintTree(`${target}.previous`), candidate: await fingerprintTree(target),
    launcher: null, executableName: "branch-agent", understood: 1, databases: [], backups: [] }));
  const fine = await performRollback(journal.current(), { ...shared, restart: async () => undefined });
  journal.close(); // before the folder goes, or Windows will not let it
  assert.equal(fine.ok, true, fine.message);
  assert.match(fine.message, /Branch is back on version 1\.0\.0/);
});

/* ---------- branch update --yes ---------- */

async function fakeApp(dir, version) {
  await mkdir(join(dir, "resources", "app", "dist"), { recursive: true });
  // The update refuses a download that cannot identify itself as this program at this version, so a
  // stand-in without one is refused before any of this file's tests reach what they are about. It was
  // missing, and every test that runs a real update stopped on "did not contain a readable Branch
  // Agent package identity" -- on every system, not only on a Mac.
  await writeFile(join(dir, "resources", "app", "package.json"), JSON.stringify({ name: "branch-agent", version }));
  await writeFile(join(dir, "branch-agent"), `#!/bin/sh\necho ${version}\n`);
  await writeFile(join(dir, "resources", "app", "dist", "cli.js"), `// ${version}\n`);
  await writeFile(join(dir, "resources", "version.txt"), version);
}

async function updateSetup(t, { mode = "daemon" } = {}) {
  const root = await scratch(t);
  const archive = Buffer.from("pretend download");
  const digest = createHash("sha256").update(archive).digest("hex");
  const release = {
    tag_name: "v2.0.0", name: "Branch Agent 2.0.0", body: "", published_at: null, html_url: "https://github.com/stabrea/Branch-Agent/releases/v2.0.0",
    assets: [
      { name: "Branch-Agent-linux-x64.tar.gz", browser_download_url: "https://example.test/app.tar.gz", size: archive.length },
      { name: "Branch-Agent-linux-x64.tar.gz.sha256", browser_download_url: "https://example.test/app.sha256", size: 10 },
    ],
  };
  const events = [];
  const running = { pid: 4242, mode, port: 8787, url: "http://127.0.0.1:8787", version: "1.0.0", startedAt: new Date().toISOString() };
  const deps = { lastReleaseWithoutProvenance: "2.0.0",
    fetch: async (url) => url.endsWith("/releases/latest") ? Response.json(release)
      : url.endsWith(".sha256") ? new Response(`${digest}  x\n`) : new Response(archive),
    scratchDir: join(root, "scratch"),
    running: async () => running,
    extract: async (_file, into) => { await fakeApp(into, "2.0.0"); },
    backup: async () => { events.push("backup"); },
    snapshot: async () => join(root, "snapshot"),
    quit: async () => { events.push("quit"); return { stopped: true, wasRunning: true, pid: 4242, message: "" }; },
    runScript: (...args) => { events.push(["script", ...args]); return 0; },
    restartService: async () => { events.push("restart"); },
    rollback: async () => { events.push("rollback"); return 0; },
  };
  const lines = [];
  const input = { installRoot: join(root, "app"), dataDir: join(root, "data"), version: "1.0.0", platform: "linux", arch: "x64",
    yes: true, print: (line) => lines.push(line) };
  await mkdir(input.dataDir, { recursive: true });
  await fakeApp(input.installRoot, "1.0.0");
  return { deps, events, lines, input };
}
/**
 * A return the strict check will accept: the background service, on the version asked for, started
 * after the one that was closed, and answering on its own port with that same version. Anything a
 * test leaves out here is a thing the check is entitled to refuse.
 */
const cameBack = (over = {}) => {
  const note = { pid: 5151, mode: "daemon", port: 8787, url: "http://127.0.0.1:8787",
    version: "2.0.0", startedAt: new Date(Date.now() + 60000).toISOString(), ...over };
  return {
    running: async () => note,
    attach: async () => ({ instance: note, version: over.answers ?? note.version }),
    sleep: async () => undefined, waitMs: 0,
  };
};
/** Nothing comes back at all, and nothing answers. */
const neverBack = () => ({ running: async () => null, attach: async () => null, sleep: async () => undefined, waitMs: 0 });


test("a record that cannot be written puts the service back, and still calls the update failed", async (t) => {
  // The stop has already happened by the time what the update will change is written down, and
  // writing it down is a disk write like any other. Returning there left the owner on the version
  // they had with nothing running it -- the one outcome this whole path exists to prevent, reached
  // through the one door that had no recovery behind it.
  const s = await updateSetup(t);
  const code = await headlessUpdate({ ...s.input, deps: { ...s.deps,
    record: async () => { throw new Error("the disk is full"); },
    returnWait: cameBack({ version: "1.0.0" }),
  } });

  assert.ok(s.events.includes("restart"), "the service was started again after the record could not be written");
  assert.match(s.lines.join(NEWLINE), /the disk is full/, "and the owner is told why the update stopped");
  assert.match(s.lines.join(NEWLINE), /working in the background again, on version 1\.0\.0/,
    "and that it really came back, on the version that is still installed");
  assert.equal(code, 1, "recovering the service is the least this owes them, never a successful update");
  assert.equal(s.events.includes(["script"].toString()), false);
});


test("a record that cannot be written puts a window back as a window", async (t) => {
  // The owner had a window. It was closed for the update, writing the record failed before there was
  // a hand-over script to run, and nothing reopened it -- while the words on the screen said nothing
  // had changed. Nothing on disk had. Their window was still gone.
  const s = await updateSetup(t, { mode: "app" });
  const opened = [];
  const code = await headlessUpdate({ ...s.input, deps: { ...s.deps,
    record: async () => { throw new Error("the disk is full"); },
    launch: (...args) => { opened.push(args); },
    restartService: async () => { s.events.push("restart"); assert.fail("a window is never put back as a service"); },
  } });

  assert.equal(code, 1);
  assert.equal(opened.length, 1, "the window was opened again");
  assert.equal(opened[0][0], s.input.installRoot, "and it is the installed one, which was never touched");
  assert.equal(s.events.includes("restart"), false, "the service manager was not asked");
  const said = s.lines.join(NEWLINE);
  assert.match(said, /the disk is full/);
  assert.match(said, /Branch has been opened again, on version 1\.0\.0/);
});

test("a window that cannot be opened again is said out loud, not left as \"nothing was changed\"", async (t) => {
  const s = await updateSetup(t, { mode: "app" });
  const code = await headlessUpdate({ ...s.input, deps: { ...s.deps,
    record: async () => { throw new Error("the disk is full"); },
    launch: () => { throw new Error("nothing opened"); },
  } });

  assert.equal(code, 1);
  const said = s.lines.join(NEWLINE);
  assert.match(said, /could not be opened again/, "the owner is told their window is gone");
  assert.match(said, /nothing opened/, "and what went wrong");
  assert.match(said, /still the one installed/, "and that the version they had is intact");
});

test("a record that cannot be written and a service that will not start says so, and claims no way back", async (t) => {
  // Nothing was written down, so there is no record for `branch rollback` to work from: production
  // would answer "there is no record of an update to go back from". My first version of this test
  // handed it a rollback stub that returned 0, which is not a stand-in for that dependency -- it is a
  // different answer to the question, and it hid the fact that the real path offers a way out that
  // does not exist. **No rollback dependency is supplied here at all**, so anything reaching for one
  // would reach the real thing, and the assertions below say it is not reached.
  const s = await updateSetup(t);
  const { rollback: _never, ...withoutRollback } = s.deps;
  const code = await headlessUpdate({ ...s.input, deps: { ...withoutRollback,
    record: async () => { throw new Error("the disk is full"); },
    returnWait: neverBack(),
  } });

  assert.equal(code, 1);
  assert.equal(s.events.includes("rollback"), false, "nothing was written down, so there is nothing to go back to");
  assert.ok(s.events.includes("restart"), "the version still installed was asked to start");
  const said = s.lines.join(NEWLINE);
  assert.match(said, /the disk is full/, "the owner is told why the update stopped");
  assert.match(said, /Branch is not running in the background/, "and that it is not running");
  assert.match(said, /Nothing on this computer was changed/, "and that the files were never touched");
  assert.match(said, /branch start/, "and what to do about it");
  assert.equal(/going back|version it had|put back/.test(said), false,
    `nothing implies a way back that does not exist (${said})`);
});


test("a hand-over that fails before it reopens the window opens it", async (t) => {
  // The recovery after a failed script asked whether the conversation was a background service and
  // did nothing at all when it was a window. The script had already closed it, so the owner was left
  // with the version they had and nothing showing it.
  const s = await updateSetup(t, { mode: "app" });
  const opened = [];
  const code = await headlessUpdate({ ...s.input, deps: { ...s.deps,
    runScript: (...args) => { s.events.push(["script", ...args]); return 3; },
    // Asked twice, and the two answers are the truth at those two moments: Branch was running before
    // any of this, and after the script failed before launching anything, nothing is.
    running: (() => { let asked = 0; return async () => (asked++ === 0 ? s.deps.running() : null); })(),
    launch: (...args) => { opened.push(args); },
  } });

  assert.equal(code, 1, "the update still failed");
  assert.equal(opened.length, 1, "and the window the script closed was opened again");
  assert.match(s.lines.join(NEWLINE), /Branch has been opened again, on version 1\.0\.0/);
});

test("a hand-over that fails after it has already reopened the window does not open a second one", async (t) => {
  // The same exit code, the opposite situation: the script put the previous version back, launched
  // it, and then failed. Opening one here would leave the owner with two windows. Nothing in the exit
  // code tells the two apart, so it is not guessed at -- what is running is looked at.
  const s = await updateSetup(t, { mode: "app" });
  const opened = [];
  const code = await headlessUpdate({ ...s.input, deps: { ...s.deps,
    runScript: (...args) => { s.events.push(["script", ...args]); return 3; },
    // A window that really is back: the right kind, the version still installed, started since the
    // one that was closed, and answering for itself. Anything less is not proof, which is the whole
    // point of the check this replaced.
    returnWait: cameBack({ mode: "app", version: "1.0.0", pid: 9999 }),
    launch: (...args) => { opened.push(args); },
  } });

  assert.equal(code, 1, "the update still failed");
  assert.deepEqual(opened, [], "and no second window was opened");
  assert.match(s.lines.join(NEWLINE), /Branch is open again, on version 1\.0\.0/);
});


test("a background service answering is not the window coming back", async (t) => {
  // The check that decided the script had already reopened the window read the note on disk and
  // asked only whether the process id differed from the one we closed. A note is written by whatever
  // started, so a background service -- or a note left behind by anything at all -- satisfied it, and
  // the owner was told their window was open while their screen had nothing on it.
  const s = await updateSetup(t, { mode: "app" });
  const opened = [];
  const code = await headlessUpdate({ ...s.input, deps: { ...s.deps,
    runScript: (...args) => { s.events.push(["script", ...args]); return 3; },
    // Something is running, on the right version, started since -- and it is a daemon, not a window.
    returnWait: cameBack({ mode: "daemon", version: "1.0.0", pid: 9999 }),
    launch: (...args) => { opened.push(args); },
  } });

  assert.equal(code, 1);
  assert.equal(opened.length, 1, "the window is opened, because no window was there");
  assert.match(s.lines.join(NEWLINE), /Branch has been opened again/);
});

test("a Branch on the wrong version is not the window coming back either", async (t) => {
  const s = await updateSetup(t, { mode: "app" });
  const opened = [];
  await headlessUpdate({ ...s.input, deps: { ...s.deps,
    runScript: (...args) => { s.events.push(["script", ...args]); return 3; },
    returnWait: cameBack({ mode: "app", version: "2.0.0", pid: 9999 }),
    launch: (...args) => { opened.push(args); },
  } });

  assert.equal(opened.length, 1, "the version that is still installed is 1.0.0, so that is what has to be back");
});

/** The failure of a window that could not be started: no such program, or a Mac that would not open it. */
const couldNotStart = (error) => error.code === "ENOENT" || /ENOENT|not found|cannot find|could not open/i.test(error.message);

test("a window that cannot be started is not reported as opened", async (t) => {
  // `spawn` does not throw when the program is not there: the failure arrives later, on an error
  // event. With nobody listening, the line saying the window was opened had already been printed --
  // for a window that never opened -- and the event went on to end the whole command. On a Mac the
  // program started is `open`, which is always there, so there the failure is how `open` ends.
  const { openWindow } = await import("../dist/install/rollback-cli.js");
  await assert.rejects(openWindow(join(await scratch(t), "not-a-program"), "nothing-here"),
    couldNotStart, "it answers with the failure instead of pretending");
});

/** Stands in for starting a program: notes what would have run, and hands back a child the test drives. */
function fakeStarts(platform) {
  const started = [];
  const spawn = (file, args) => {
    const child = Object.assign(new EventEmitter(), { unrefs: 0 });
    child.unref = () => { child.unrefs += 1; };
    started.push({ run: [file, args], child });
    return child;
  };
  return { started, system: { platform, spawn } };
}

/** Whether a promise has settled once everything already queued has run. */
async function settledYet(promise) {
  let settled = false;
  promise.then(() => { settled = true; }, () => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  return settled;
}

test("on a Mac, a window is reported open only when the system says it opened", async (t) => {
  // There the program started is `open`, not Branch, and `open` is always there, so its starting
  // proves nothing. It ends with 0 once the app has launched, and with anything else when the app
  // could not be opened.
  const { openWindow } = await import("../dist/install/rollback-cli.js");
  const app = join(await scratch(t), "Branch Agent.app");
  const mac = fakeStarts("darwin");

  const refused = openWindow(app, "Branch Agent", mac.system);
  assert.deepEqual(mac.started.map(({ run }) => run), [["/usr/bin/open", [app]]], "the Mac is asked to open the app");
  const opener = mac.started[0].child;
  opener.emit("spawn");
  assert.equal(await settledYet(refused), false, "`open` having started is not the window having opened");
  assert.equal(opener.unrefs, 0, "nothing lets go of `open` before it has answered");
  opener.emit("exit", 1, null);
  await assert.rejects(refused, (error) => couldNotStart(error) && error.message.includes(app),
    "`open` ending with 1 is a window that did not open, and the owner is told what could not be opened");

  const accepted = openWindow(app, "Branch Agent", mac.system);
  mac.started[1].child.emit("spawn");
  mac.started[1].child.emit("exit", 0, null);
  assert.equal(await settledYet(accepted), true, "`open` ending with 0 is the window opening");
  await accepted;

  const missing = openWindow(app, "Branch Agent", mac.system);
  mac.started[2].child.emit("error", Object.assign(new Error("spawn /usr/bin/open ENOENT"), { code: "ENOENT" }));
  await assert.rejects(missing, { code: "ENOENT" }, "an `open` that cannot be started at all is a failure too");
});

test("elsewhere the window is Branch itself, so it counts as opened once it has started", async (t) => {
  // Waiting for this program to end would be waiting for the owner to close the window.
  const { openWindow } = await import("../dist/install/rollback-cli.js");
  const root = join(await scratch(t), "branch");
  const linux = fakeStarts("linux");

  const opening = openWindow(root, "branch-agent", linux.system);
  assert.deepEqual(linux.started.map(({ run }) => run), [[join(root, "branch-agent"), []]], "the program itself is started");
  linux.started[0].child.emit("spawn");
  assert.equal(await settledYet(opening), true, "it is open once it has started");
  await opening;
  assert.equal(linux.started[0].child.unrefs, 1, "and the command does not wait for the window to close");
});

test("a Branch working in the background comes back by itself on the new version", { skip: posixOnly }, async (t) => {
  const s = await updateSetup(t);
  const code = await headlessUpdate({ ...s.input, deps: { ...s.deps, returnWait: cameBack() } });
  assert.equal(code, 0, s.lines.join("\n"));
  assert.ok(s.events.includes("restart"), "the service was started again through its manager");
  assert.ok(!s.events.includes("rollback"));
  assert.match(s.lines.at(-1), /working in the background again, on version 2\.0\.0/);
  assert.ok(!s.lines.some((line) => /start it again with `branch start`/.test(line)), "the owner is no longer told to do it themselves");
});

test("when the new version does not come up, the version before is put back and started", { skip: posixOnly }, async (t) => {
  const s = await updateSetup(t);
  // The service does come back — on the version we were leaving. That is not the new version coming
  // up, and taking the note's word for it was how this used to pass.
  const code = await headlessUpdate({ ...s.input, deps: { ...s.deps, returnWait: cameBack({ version: "1.0.0" }) } });
  assert.equal(code, 1);
  assert.ok(s.events.indexOf("rollback") > s.events.indexOf("restart"), "it went back only after the new version failed to come up");
  assert.match(s.lines.join("\n"), /did not come back up in the background, so Branch is going back to the version it had/);
});

test("a Branch that answers with the old version is not the new one coming back", { skip: posixOnly }, async (t) => {
  // The note on disk is written by whatever started, so a swap that half happened can leave it saying
  // 2.0.0 while the Branch actually answering on the port is still 1.0.0. The note is not the proof.
  const s = await updateSetup(t);
  const code = await headlessUpdate({ ...s.input, deps: { ...s.deps, returnWait: cameBack({ answers: "1.0.0" }) } });
  assert.equal(code, 1, "what it answered with is what counts, not what was written down");
  assert.ok(s.events.includes("rollback"), "so the version before was put back");
});

test("a service manager that refuses the start goes straight to the way back", { skip: posixOnly }, async (t) => {
  const s = await updateSetup(t);
  const code = await headlessUpdate({ ...s.input, deps: { ...s.deps, restartService: async () => { throw new Error("no such unit"); }, returnWait: neverBack() } });
  assert.equal(code, 1);
  assert.ok(s.events.includes("rollback"));
});

test("a window, not a service, is reopened by the hand-over as before and no service is started", { skip: posixOnly }, async (t) => {
  const s = await updateSetup(t, { mode: "app" });
  assert.equal(await headlessUpdate({ ...s.input, deps: s.deps }), 0, s.lines.join("\n"));
  const script = s.events.find((event) => Array.isArray(event) && event[0] === "script");
  assert.ok(script && !script.includes("stay"), "the hand-over reopens the window itself");
  assert.ok(!s.events.includes("restart"));
});

/* ---------- branch rollback --yes ---------- */

test("branch rollback brings a background service back as the service, not as a window", { skip: posixOnly }, async (t) => {
  const root = await scratch(t);
  const dataDir = join(root, "data");
  await mkdir(dataDir, { recursive: true });
  const target = join(root, "Apps", "Branch-Agent");
  await fakeApp(target, "2.0.0");
  await fakeApp(`${target}.previous`, "1.0.0");
  const journal = new ActivationJournal(join(dataDir, "activation.sqlite"));
  const id = journal.stage({ kind: "update", fromVersion: "1.0.0", toVersion: "2.0.0", target,
    previous: await fingerprintTree(`${target}.previous`), candidate: await fingerprintTree(target),
    launcher: null, executableName: "branch-agent", understood: 1, databases: [], backups: [] });
  journal.activated(id);
  journal.close();
  await writeRunning(dataDir, { pid: process.pid, mode: "daemon", port: 8787, url: "http://127.0.0.1:8787", version: "2.0.0" });
  let restarted = 0;
  const said = [];
  // The service coming back is now part of what "brought back" means, so this has to say what came
  // back. Before, the manager accepting was the whole proof and this test needed nothing -- which is
  // why, once the product asked for a real return, it sat on the real sixty-second deadline and then
  // failed. The stub records being asked, so this still fails if the undo ever stops asking.
  let looked = 0;
  const answered = cameBack({ version: "1.0.0" });
  const returnWait = { ...answered, running: async (dir) => { looked += 1; return answered.running(dir); } };
  const code = await rollbackCommand({ dataDir, version: "2.0.0", yes: true, platform: "linux", print: (line) => said.push(line),
    deps: {
      quit: { alive: () => true, stopEngine: async () => ({ stopped: true, message: "" }) },
      restartService: async () => { restarted += 1; },
      returnWait,
      launch: () => assert.fail("a service is never brought back as a window"),
    } });
  assert.equal(code, 0, said.join("\n"));
  assert.equal(restarted, 1);
  assert.ok(looked > 0, "the undo waited for the version it put back, rather than taking the manager's word");
  assert.equal(await readFile(join(target, "resources", "version.txt"), "utf8"), "1.0.0", "the version before is back");
});


test("the undo is told what was running, so a service that never came back is started again", async (t) => {
  // The update's recovery reaches the undo after the service has been closed and the new version never
  // came up. Asking the disk then answers "nothing is running", and the files would go back with nothing
  // started. What was running before all this began is carried in instead.
  const root = await scratch(t);
  const dataDir = join(root, "data");
  await mkdir(dataDir, { recursive: true });
  const target = join(root, "Apps", "Branch-Agent");
  await fakeApp(target, "2.0.0");
  await fakeApp(`${target}.previous`, "1.0.0");
  const journal = new ActivationJournal(join(dataDir, "activation.sqlite"));
  const id = journal.stage({ kind: "update", fromVersion: "1.0.0", toVersion: "2.0.0", target,
    previous: await fingerprintTree(`${target}.previous`), candidate: await fingerprintTree(target),
    launcher: null, executableName: "branch-agent", understood: 1, databases: [], backups: [] });
  journal.activated(id);
  journal.close();

  // Nothing is running, exactly as it is at that moment.
  let restarted = 0;
  const said = [];
  const code = await rollbackCommand({ dataDir, version: "2.0.0", yes: true, platform: "linux", print: (line) => said.push(line),
    deps: {
      quit: { alive: () => false, stopEngine: async () => ({ stopped: true, message: "" }) },
      wasRunning: { pid: 4242, mode: "daemon", port: 8787, url: "http://127.0.0.1:8787", version: "1.0.0", startedAt: "2026-09-22T10:00:00.000Z" },
      restartService: async () => { restarted += 1; },
      returnWait: cameBack({ version: "1.0.0" }),
      launch: () => assert.fail("a service is never brought back as a window"),
    } });
  assert.equal(code, 0, said.join("\n"));
  assert.equal(restarted, 1, "the service was started again, because the undo was told there was one");
  assert.equal(await readFile(join(target, "resources", "version.txt"), "utf8"), "1.0.0");
});

/** Everything `branch rollback --yes` needs to undo 2.0.0 back to 1.0.0, with 1.0.0 having been the service. */
async function undoSetup(t, { mode = "daemon" } = {}) {
  const root = await scratch(t);
  const dataDir = join(root, "data");
  await mkdir(dataDir, { recursive: true });
  const target = join(root, "Apps", "Branch-Agent");
  await fakeApp(target, "2.0.0");
  await fakeApp(`${target}.previous`, "1.0.0");
  const journal = new ActivationJournal(join(dataDir, "activation.sqlite"));
  const id = journal.stage({ kind: "update", fromVersion: "1.0.0", toVersion: "2.0.0", target,
    previous: await fingerprintTree(`${target}.previous`), candidate: await fingerprintTree(target),
    launcher: null, executableName: "branch-agent", understood: 1, databases: [], backups: [] });
  journal.activated(id);
  journal.close();
  const said = [], events = [];
  const run = (returnWait, over = {}) => rollbackCommand({ dataDir, version: "2.0.0", yes: true, platform: "linux",
    print: (line) => said.push(line),
    deps: {
      quit: { alive: () => false, stopEngine: async () => ({ stopped: true, message: "" }) },
      wasRunning: { pid: 4242, mode, port: 8787, url: "http://127.0.0.1:8787",
        version: "2.0.0", startedAt: "2026-09-22T10:00:00.000Z" },
      restartService: async () => { events.push("restart"); },
      returnWait,
      launch: () => assert.fail("a service is never brought back as a window"),
      ...over,
    } });
  const told = () => said.join("\n");
  return { run, told, events, target };
}

test("the undo waits for the version it put back to answer for itself, as the update already does", async (t) => {
  const undo = await undoSetup(t);
  const code = await undo.run(cameBack({ version: "1.0.0" }));

  assert.equal(code, 0, undo.told());
  assert.deepEqual(undo.events, ["restart"]);
  assert.equal(await readFile(join(undo.target, "resources", "version.txt"), "utf8"), "1.0.0");
});

test("a manager that took the command while nothing came back is not the version being back", async (t) => {
  // launchctl and systemctl answer as soon as they have been asked, whether or not anything came up.
  // Taking that for success is how an undo reports Branch is back while nothing is running, which is
  // the one failure this whole path exists to prevent.
  const undo = await undoSetup(t);
  const code = await undo.run(neverBack());

  assert.equal(code, 1, "the undo says it did not finish");
  assert.deepEqual(undo.events, ["restart"], "the manager really was asked");
  assert.match(undo.told(), /could not be started again/, undo.told());
  assert.match(undo.told(), /did not come back up in the background/, "and says what was waited for");
  assert.match(undo.told(), /branch start/, "and what the owner can do about it");
  assert.equal(await readFile(join(undo.target, "resources", "version.txt"), "utf8"), "1.0.0",
    "the files really are back; it is only the running that is not");
});

test("a Branch that answers with the version we undid is not the version we put back", async (t) => {
  // The note on disk can say 1.0.0 while what is running is still 2.0.0: a note is written by whatever
  // started, and an undo that believes it would call the thing it was trying to escape a success.
  // What the running Branch answers when it is asked is what decides.
  const undo = await undoSetup(t);
  const code = await undo.run(cameBack({ version: "1.0.0", answers: "2.0.0" }));

  assert.equal(code, 1, "a Branch on the version we just undid does not count as the undo working");
  assert.match(undo.told(), /could not be started again/, undo.told());
});


test("an undo that put the files back and could not start Branch can be finished later", async (t) => {
  // The undo records that the files are back -- they are -- and then tries to start the service. If
  // that fails, running the whole undo again is refused, and rightly: the installed program is no
  // longer the version the record says it replaced. So what is left undone is the service, and the
  // service is the only thing this route does. No file is moved a second time.
  const undo = await undoSetup(t);
  assert.equal(await undo.run(neverBack()), 1, "the first attempt fails at the start, as it should");
  const versionAfterFirst = await readFile(join(undo.target, "resources", "version.txt"), "utf8");
  assert.equal(versionAfterFirst, "1.0.0", "and the files are already back");

  // Now finish it. Nothing on disk may move, and the service must really answer.
  const finished = await undo.run(cameBack({ version: "1.0.0" }));
  assert.equal(finished, 0, undo.told());
  assert.match(undo.told(), /working in the background again, on version 1\.0\.0/);
  assert.deepEqual(undo.events, ["restart", "restart"], "asked the manager again, and nothing else");
  assert.equal(await readFile(join(undo.target, "resources", "version.txt"), "utf8"), "1.0.0",
    "the same files, not swapped a second time");
  assert.equal(await readFile(join(`${undo.target}.failed`, "resources", "version.txt"), "utf8"), "2.0.0",
    "and the version that was undone is still parked beside it, not swapped back in");
});


test("an undo of a window that could not reopen it is finished as a window, not as a service", async (t) => {
  // The finish-later route reads "the last start failed" from the ledger. It used to hand every one
  // of them to the background service manager -- so an owner who had a window, whose relaunch failed,
  // would get a daemon they never asked for and never see Branch come back.
  const undo = await undoSetup(t, { mode: "app" });
  assert.equal(await undo.run(neverBack(), { launch: () => { throw new Error("nothing opened"); } }), 1,
    "the first attempt fails at the reopening");

  const opened = [];
  const finished = await undo.run(cameBack({ version: "1.0.0" }), { launch: (...args) => { opened.push(args); } });
  assert.equal(finished, 0, undo.told());
  assert.equal(opened.length, 1, "the window was reopened");
  assert.deepEqual(undo.events, [], "and the service manager was never asked");
  assert.match(undo.told(), /Branch is open again, on version 1\.0\.0/);
});

test("a second attempt that still cannot start Branch says so again, rather than reporting it done", async (t) => {
  const undo = await undoSetup(t);
  assert.equal(await undo.run(neverBack()), 1);
  assert.equal(await undo.run(neverBack()), 1, "still not started, still said");
  assert.match(undo.told(), /could not be started again/);
});

test("an update whose hand-over fails does not leave a service down", { skip: posixOnly }, async (t) => {
  // The hand-over closed the service and told the script not to reopen it. If the script then fails,
  // stopping here leaves the owner on the version they had with nothing running it.
  const s = await updateSetup(t);
  const events = s.events;
  const code = await headlessUpdate({ ...s.input, deps: { ...s.deps,
    runScript: (...args) => { events.push(["script", ...args]); return 3; },
    returnWait: cameBack({ version: "1.0.0" }),
  } });
  assert.ok(events.includes("restart"), "the service was started again after the hand-over failed");
  assert.match(s.lines.join("\n"), /did not finish/);
  assert.match(s.lines.join("\n"), /working in the background again, on version 1\.0\.0/, "and it really came back");
  // The service is back, and the update still failed. Whatever asked for it is told so.
  assert.equal(code, 1, "a failed update never answers 0, however well the recovery went");
});
