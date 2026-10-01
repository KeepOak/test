import { processRunning } from "./process-running.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";

/**
 * The background engine keeps working after whatever started it has gone.
 *
 * This is the one thing the feature ledger's own criterion asks for and nothing proved: installing
 * as a sign-in task, the controlled close and who may close it were all covered, and "start it,
 * close the launcher, see that tasks are still handled" was not. A note on disk is not that proof —
 * the note is written by whatever started, and it says nothing about who is still listening.
 *
 * Nothing here goes near the owner's own Branch. Its own scratch data directory, its own workspace,
 * a port the operating system picks, the offline demonstration provider, and an engine this test
 * starts and this test stops. No window opens.
 */

const alive = (pid) => processRunning(pid, () => { try { process.kill(pid, 0); return true; } catch { return false; } });
const until = async (what, check, ms = 30000) => {
  const deadline = Date.now() + ms;
  for (;;) {
    const answer = await check();
    if (answer) return answer;
    if (Date.now() >= deadline) assert.fail(`timed out waiting: ${what}`);
    await new Promise((resolve) => { setTimeout(resolve, 100); });
  }
};

test("the background engine keeps handling tasks after the launcher that started it has gone", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-daemon-"));
  const dataDir = join(root, "data"), workspace = join(root, "workspace");
  await mkdir(dataDir, { recursive: true });
  await mkdir(workspace, { recursive: true });

  let enginePid = null;
  t.after(async () => {
    if (enginePid && alive(enginePid)) { try { process.kill(enginePid); } catch { /* already gone */ } }
    await discardTemp(root);
  });

  // A launcher of this test's own: it starts the engine detached and then exits, which is what the
  // installed sign-in task does. Written here rather than installed, so nothing is registered on
  // this computer and nothing of the owner's is touched.
  const launcher = join(root, "launcher.mjs");
  await writeFile(launcher, `import { spawn } from "node:child_process";
const child = spawn(process.execPath, [${JSON.stringify(join(process.cwd(), "dist", "cli.js"))}, "start"], {
  detached: true, stdio: "ignore",
  env: { ...process.env, BRANCH_DATA_DIR: ${JSON.stringify(dataDir)},
    BRANCH_WORKSPACE: ${JSON.stringify(workspace)}, BRANCH_PORT: "0", BRANCH_PROVIDER: "demo" },
});
child.unref();
process.exit(0);
`);

  const launcherPid = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [launcher], { stdio: "ignore" });
    child.once("error", reject);
    child.once("exit", () => resolve(child.pid));
  });

  // The launcher is gone. Not "detached and forgotten about" — gone, and checked.
  assert.equal(alive(launcherPid), false, "the launcher that started the engine has exited");

  const note = await until("the engine to write down where it is", async () => {
    try { return JSON.parse(await readFile(join(dataDir, "running.json"), "utf8")); } catch { return null; }
  });
  enginePid = note.pid;
  assert.equal(note.mode, "daemon", "it is running as the background engine");
  assert.notEqual(note.pid, launcherPid, "and it is not the launcher");
  assert.ok(alive(note.pid), "the engine is still running with its launcher gone");

  const token = (await readFile(join(dataDir, "session-token"), "utf8")).trim();
  const ask = (path, body) => fetch(`${note.url}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  // The engine itself answers, over its own port. This is the part the ledger asked for: a task
  // handled after the launcher exited, and answered by the thing that is still listening rather
  // than inferred from a file.
  await until("the engine to answer for itself", async () => {
    try { return (await ask("/api/health")).ok; } catch { return false; }
  });
  const run = await ask("/api/run", { prompt: "Say hello." });
  const said = await run.text();
  assert.equal(run.status, 200, said);
  const answered = JSON.parse(said);
  assert.equal(answered.status, "completed", JSON.stringify(answered).slice(0, 300));
  assert.ok(String(answered.output ?? "").length > 0, "it really answered");

  // And a second one, so this is "keeps handling tasks" rather than "handled one".
  const again = await ask("/api/run", { prompt: "And again." });
  assert.equal(again.status, 200);
  assert.equal((await again.json()).status, "completed");

  // Stopped the way it is meant to be stopped, and then really gone.
  const stopped = await ask("/api/deployment/quit", {});
  assert.ok(stopped.status === 200 || stopped.status === 202, `${stopped.status}: ${await stopped.text()}`);
  await until("the engine to stop", async () => !alive(note.pid));
  assert.equal(alive(note.pid), false, "it left no process behind");
  enginePid = null;
});
