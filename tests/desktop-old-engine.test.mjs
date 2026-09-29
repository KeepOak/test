/* The real desktop app (Electron, hidden in the tray, never shown) started while a background engine from a version
   before the engine's proof is running: it closes that engine the way `branch quit` does (its key goes there only once
   this computer says the process on the port is the one the engine's note names), starts this version's engine in its
   place at the same port, and joins it, with nothing for the owner to do and no error.
   The old engine is a stand-in keeping that version's contract (tests/fixtures/old-engine.mjs); with
   BRANCH_OLD_ENGINE_ROOT naming the folder of a build from before the proof, that real build is tested as well. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron } from "playwright";
import { connected, desktopOptions, mainLines, offScreen } from "./fixtures/desktop-options.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; } };

/** A free port on this computer that is none of the owner's (the installed app's, the preview's). */
async function freePort() {
  for (;;) {
    const probe = createServer();
    await new Promise((done) => probe.listen(0, "127.0.0.1", done));
    const { port } = probe.address();
    await new Promise((done) => probe.close(done));
    if (![3210, 3299, 3300].includes(port)) return port;
  }
}

const note = (env) => readFile(join(env.BRANCH_DATA_DIR, "running.json"), "utf8").then(JSON.parse, () => null);

/** The old engine, started as its version started, at `port`; resolves once its note names it. */
async function oldEngine(env, port, oldRoot) {
  const args = oldRoot ? [join(oldRoot, "dist", "cli.js"), "start"] : [join(root, "tests", "fixtures", "old-engine.mjs"), String(port)];
  const child = spawn(process.execPath, args, { env: { ...env, BRANCH_PORT: String(port) }, stdio: ["ignore", "ignore", "inherit"], windowsHide: true });
  for (const end = Date.now() + 120000; ;) {
    if (child.exitCode !== null) throw new Error(`the old engine stopped (code ${child.exitCode})`);
    const written = await note(env);
    if (written?.pid === child.pid && (await fetch(`http://127.0.0.1:${port}/`).then(() => true, () => false))) return child;
    if (Date.now() > end) throw new Error("the old engine did not start");
    await new Promise((done) => setTimeout(done, 100));
  }
}

async function upgradeCase(t, oldRoot) {
  const { options } = await desktopOptions({ hidden: true }); // never on the screen
  options.env.BRANCH_TEST_ENGINE_HOOKS = "1";
  if (!oldRoot) {
    await mkdir(options.env.BRANCH_DATA_DIR, { recursive: true });
    await writeFile(join(options.env.BRANCH_DATA_DIR, "session-token"), randomBytes(32).toString("hex"));
  }
  const port = await freePort();
  const old = await oldEngine(options.env, port, oldRoot);
  const freshEngine = async () => { const pid = (await note(options.env))?.pid; return pid && pid !== old.pid && alive(pid) ? pid : null; };
  t.after(async () => { if (old.exitCode === null && old.signalCode === null) { old.kill(); await once(old, "exit"); } });
  const electron = await _electron.launch(options);
  const lines = mainLines(electron);
  try {
    const page = await electron.firstWindow({ timeout: 180000 });
    await connected(page);
    assert.equal(new URL(page.url()).port, String(port), "the window joined the engine at the old engine's port");
    assert.equal(old.exitCode, 0, "the old engine closed itself, as it does when asked the way branch quit asks");
    assert.ok(await freshEngine(), "a fresh engine works in the background in its place");
    assert.equal(await electron.evaluate(() => typeof globalThis.branchEngineForTests), "undefined", "and the app started no engine of its own");
    assert.equal(await electron.evaluate(() => globalThis.branchEngineGateForTests.ready()), true, "the fresh engine proved itself");
    assert.equal(await page.evaluate(async () => (await fetch("/api/state")).status), 200);
    const said = lines.join("\n");
    assert.match(said, /Branch is moving its background engine to this version\./);
    assert.match(said, /Branch's background engine now runs this version\./);
    assert.doesNotMatch(said, /left the background engine|did not start again/);
    if (!oldRoot) {
      const heard = (await readFile(join(options.env.BRANCH_DATA_DIR, "heard.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
      assert.deepEqual(heard.filter((each) => each.withKey).map((each) => `${each.method} ${each.path}`), ["POST /api/deployment/quit"],
        "the old engine was sent the key once, to close it, and only after this computer said it held the port");
    }
    await offScreen(electron, "after the move");
  } finally {
    // The fresh engine works in the background and outlives the app, as it should; the test ends it first, because the
    // app's test output (which the test runner waits on) is still open in it.
    const fresh = await freshEngine();
    if (fresh) process.kill(fresh);
    await electron.close();
  }
}

test("a background engine from before the engine's proof is moved to this version by itself, and the window joins it", { timeout: 360000 }, async (t) => {
  await upgradeCase(t, null);
});

test("the same, with a real build from before the proof", {
  timeout: 360000, skip: process.env.BRANCH_OLD_ENGINE_ROOT ? false : "BRANCH_OLD_ENGINE_ROOT names no build from before the proof",
}, async (t) => {
  await upgradeCase(t, resolve(process.env.BRANCH_OLD_ENGINE_ROOT));
});
