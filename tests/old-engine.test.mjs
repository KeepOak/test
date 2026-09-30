/**
 * Moving a background engine from before the engine's proof to this version (src/install/old-engine.ts): the window's
 * key goes to it only once this computer says the process holding its port is the one its note names; it is asked to
 * close the way `branch quit` asks, then the way an update does, and only then ended.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { closeOldEngine, listenerFromNetstat, listeningInodes, moveOldEngine, startFreshEngine } from "../dist/install/old-engine.js";
import { writeRunning } from "../dist/install/running.js";
import { daemonCommandLine } from "../dist/install/daemon.js";
import { hiddenRunner } from "../dist/install/daemon.js";

const KEY = "b".repeat(64);
const PID = 424242;
const PORT = 45123;

async function home(t, note = {}) {
  const dir = await mkdtemp(join(tmpdir(), "branch-old-engine-"));
  t.after(() => discardTemp(dir));
  await writeFile(join(dir, "session-token"), KEY);
  await writeRunning(dir, { port: PORT, pid: PID, url: `http://127.0.0.1:${PORT}`, mode: "daemon", version: "0.9.0", ...note });
  return dir;
}

/** A computer where process PID holds the port until it is asked to close (or ended), with every call recorded. */
function computer({ holder = PID, answers = {}, closes = true, ends = true } = {}) {
  let running = true;
  const sent = [], ended = [];
  return {
    sent, ended, get running() { return running; },
    deps: {
      platform: "win32",
      alive: (pid) => pid === PID && running,
      listener: async (port) => (port === PORT && running ? holder : null),
      fetch: async (url, init) => {
        sent.push([new URL(url).pathname, init.headers.authorization]);
        const status = answers[new URL(url).pathname] ?? 404;
        if (status === 200 && closes) running = false;
        return new Response("{}", { status });
      },
      run: async (file, args) => { ended.push([file.split("\\").pop(), args]); if (ends) running = false; return ""; },
      sleep: async () => undefined,
      waitMs: 50,
    },
  };
}

test("the tables this computer keeps name the process listening at a port", () => {
  const netstat = [
    "  Proto  Local Address          Foreign Address        State           PID",
    "  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1100",
    "  TCP    127.0.0.1:45123        127.0.0.1:50000        ESTABLISHED     77",
    "  TCP    127.0.0.1:45123        0.0.0.0:0              LISTENING       4242",
    "  TCP    127.0.0.1:451234       0.0.0.0:0              LISTENING       99",
  ].join("\r\n");
  assert.equal(listenerFromNetstat(netstat, 45123), 4242);
  assert.equal(listenerFromNetstat(netstat, 45124), null);
  const proc = [
    "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
    "   0: 0100007F:B043 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 5555 1 0000000000000000 100 0 0 10 0",
    "   1: 0100007F:B043 0100007F:C350 01 00000000:00000000 00:00000000 00000000  1000        0 6666 1 0000000000000000 20 4 30 10 -1",
  ].join("\n");
  assert.deepEqual([...listeningInodes(proc, 45123)], ["5555"]);
});

test("an old engine is asked to close the way branch quit asks, with its key, once this computer says it holds the port", async (t) => {
  const dir = await home(t);
  const pc = computer({ answers: { "/api/deployment/quit": 200 } });
  const closed = await closeOldEngine(dir, pc.deps);
  assert.equal(closed.closed, true);
  assert.equal(closed.forced, false);
  assert.equal(closed.instance.port, PORT);
  assert.deepEqual(pc.sent, [["/api/deployment/quit", `Bearer ${KEY}`]]);
  assert.deepEqual(pc.ended, []);
});

test("nothing is sent when the port is held by any process but the one the note names", async (t) => {
  const dir = await home(t);
  for (const holder of [PID + 1, null]) {
    const pc = computer({ holder, answers: { "/api/deployment/quit": 200 } });
    const closed = await closeOldEngine(dir, pc.deps);
    assert.equal(closed.closed, false);
    assert.deepEqual(pc.sent, [], "the key went nowhere");
    assert.deepEqual(pc.ended, [], "and nothing was ended");
  }
});

test("a note that is not a background engine's, or names no running process, or another address, is left alone", async (t) => {
  for (const note of [{ mode: "app" }, { pid: PID + 7 }, { url: `http://localhost:${PORT}` }]) {
    const dir = await home(t, note);
    const pc = computer({ answers: { "/api/deployment/quit": 200 } });
    assert.equal((await closeOldEngine(dir, pc.deps)).closed, false, JSON.stringify(note));
    assert.deepEqual(pc.sent, []);
  }
});

test("an engine behind a gateway, which refuses quit, is asked to close as an update asks; one that will not go is ended", async (t) => {
  const dir = await home(t);
  const gateway = computer({ answers: { "/api/deployment/quit": 403, "/api/deployment/close": 200 } });
  assert.equal((await closeOldEngine(dir, gateway.deps)).closed, true);
  assert.deepEqual(gateway.sent.map(([path]) => path), ["/api/deployment/quit", "/api/deployment/close"]);
  const stuck = computer({ answers: { "/api/deployment/quit": 200 }, closes: false });
  const closed = await closeOldEngine(dir, stuck.deps);
  assert.equal(closed.closed, true);
  assert.equal(closed.forced, true);
  assert.deepEqual(stuck.ended, [["taskkill.exe", ["/PID", String(PID), "/T", "/F"]]]);
  const note = await readFile(join(dir, "running.json"), "utf8").catch(() => null);
  assert.equal(note, null, "the note of the engine that was ended is cleared");
});

test("an engine that is ended is ended only while it still holds its port", async (t) => {
  const dir = await home(t);
  const pc = computer({ answers: {}, closes: false });
  let asked = 0;
  const deps = { ...pc.deps, listener: async () => (++asked <= 3 ? PID : 999) }; // the port changed hands before the end
  const closed = await closeOldEngine(dir, deps);
  assert.equal(closed.closed, false);
  assert.deepEqual(pc.ended, [], "a process that no longer holds the port is not ended");
});

test("the fresh engine is this version's, started in the background at the old engine's port as the sign-in task starts it", async () => {
  const fresh = { executable: "C:\\App\\Branch Agent.exe", script: "C:\\App\\dist\\cli.js", dataDir: "D", workspace: "W", port: PORT, env: { PATH: "p" } };
  const record = (started) => (file, args, options) => { started.push([file, args, options]); return { pid: 5, on: () => undefined, unref: () => undefined }; };
  const onWindows = [], written = [];
  await startFreshEngine(fresh, { platform: "win32", start: record(onWindows), write: async (path, text) => { written.push([path, text]); } });
  const [[launcher, script]] = written;
  assert.equal(launcher, join("D", "branch-engine-start.vbs"));
  assert.equal(script, hiddenRunner(daemonCommandLine({ ...fresh, launcherPath: launcher })), "the sign-in task's own command, hidden");
  assert.match(script, /BRANCH_PORT=45123/);
  const [[host, hostArgs, hostOptions]] = onWindows;
  assert.match(host, /wscript\.exe$/i);
  assert.deepEqual(hostArgs, ["//B", "//Nologo", launcher]);
  assert.equal(hostOptions.windowsHide, true);
  const elsewhere = [];
  await startFreshEngine(fresh, { platform: "linux", start: record(elsewhere) });
  const [[file, args, options]] = elsewhere;
  assert.equal(file, "C:\\App\\Branch Agent.exe");
  assert.deepEqual(args, ["C:\\App\\dist\\cli.js", "start"]);
  assert.deepEqual(options.env, { PATH: "p", ELECTRON_RUN_AS_NODE: "1", BRANCH_DATA_DIR: "D", BRANCH_WORKSPACE: "W", BRANCH_PORT: String(PORT) });
  assert.equal(options.detached, true);
});

/** The move, with every step it takes recorded: the close, the start and the join are stand-ins. */
function move(dir, { proves = false, closed = true, joins = true, freshPid = PID + 1 } = {}) {
  const steps = [], said = [];
  const run = moveOldEngine({
    dataDir: dir, fresh: { executable: "app", script: "cli.js", workspace: "W" }, waitMs: 2000, log: (line) => said.push(line),
    proves: async (url, key) => { steps.push(["prove", url, key === KEY]); return proves; },
    close: async () => { steps.push(["close"]); return closed ? { closed: true, instance: { port: PORT, pid: PID }, forced: false } : { closed: false, why: "a reason" }; },
    start: async (fresh) => {
      steps.push(["start", fresh.port]);
      await writeRunning(dir, { port: PORT, pid: freshPid, url: `http://127.0.0.1:${PORT}`, mode: "daemon", version: "1.0.0" });
    },
    join: async () => { steps.push(["join"]); return joins ? { joined: true } : null; },
  });
  return { run, steps, said };
}

test("an engine that cannot prove itself is closed, this version's started at its port, and the fresh one joined", async (t) => {
  const dir = await home(t);
  const { run, steps, said } = move(dir);
  assert.deepEqual(await run, { joined: true });
  assert.deepEqual(steps, [["prove", `http://127.0.0.1:${PORT}`, true], ["close"], ["start", PORT], ["join"]]);
  assert.deepEqual(said, ["Branch is moving its background engine to this version.", "Branch's background engine now runs this version."]);
});

test("an engine that proves itself is never closed, and nothing is done without a background engine's note", async (t) => {
  const proven = move(await home(t), { proves: true });
  assert.equal(await proven.run, null);
  assert.deepEqual(proven.steps.map(([step]) => step), ["prove"]);
  assert.deepEqual(proven.said, []);
  const app = move(await home(t, { mode: "app" }));
  assert.equal(await app.run, null);
  assert.deepEqual(app.steps, []);
});

test("an engine that could not be closed is left, and one that never comes back leaves the app to start its own", async (t) => {
  const kept = move(await home(t), { closed: false });
  assert.equal(await kept.run, null);
  assert.deepEqual(kept.steps.map(([step]) => step), ["prove", "close"]);
  assert.match(kept.said.at(-1), /left the background engine as it was \(a reason\)/);
  const late = move(await home(t), { joins: false });
  assert.equal(await late.run, null);
  assert.match(late.said.at(-1), /did not start again in time/);
  const same = move(await home(t), { freshPid: PID });
  assert.equal(await same.run, null);
  assert.ok(!same.steps.some(([step]) => step === "join"), "the old engine's own note is never taken for the fresh engine's");
});
