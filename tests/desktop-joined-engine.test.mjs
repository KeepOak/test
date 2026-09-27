/* The real desktop app (Electron, hidden in the tray, never shown) joined to an engine working in the background
   (`branch start`): while that engine restarts, the window holds its requests, and a program that takes the free port
   gets no key and cannot pass for the engine; once the engine is back at its address and has proved itself there, the
   held request goes on and the window works as before. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron } from "playwright";
import { connected, desktopOptions, heardNothingOfUse, mainLines, offScreen, squatterOn } from "./fixtures/desktop-options.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

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

/** `branch start` on the app's own data folder, at `port`; resolves once it has written its note and answers. */
async function backgroundEngine(env, port) {
  const child = spawn(process.execPath, [join(root, "dist", "cli.js"), "start"], {
    env: { ...env, BRANCH_PORT: String(port) }, stdio: ["ignore", "ignore", "inherit"], windowsHide: true,
  });
  const note = join(env.BRANCH_DATA_DIR, "running.json");
  for (const end = Date.now() + 120000; ;) {
    if (child.exitCode !== null) throw new Error(`the background engine stopped (code ${child.exitCode})`);
    const written = await readFile(note, "utf8").then(JSON.parse, () => null);
    if (written?.pid === child.pid && written.mode === "daemon") {
      const answer = await fetch(`http://127.0.0.1:${port}/api/engine-proof?challenge=${"0".repeat(64)}`).catch(() => null);
      if (answer?.ok) return child;
    }
    if (Date.now() > end) throw new Error("the background engine did not start");
    await new Promise((done) => setTimeout(done, 100));
  }
}
const stopped = async (child) => { if (child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, "exit"); } };

test("a window joined to a background engine holds its requests while it restarts and sends its key only to the engine", { timeout: 360000 }, async () => {
  const { options } = await desktopOptions({ hidden: true }); // never on the screen
  options.env.BRANCH_TEST_ENGINE_HOOKS = "1";
  const port = await freePort();
  let engine = await backgroundEngine(options.env, port);
  const electron = await _electron.launch(options);
  const lines = mainLines(electron);
  let squatter;
  try {
    const page = await electron.firstWindow();
    await connected(page);
    assert.equal(new URL(page.url()).port, String(port), "the window joined the background engine");
    assert.equal(await electron.evaluate(() => typeof globalThis.branchEngineForTests), "undefined", "and started no engine of its own");
    assert.equal(await electron.evaluate(() => globalThis.branchEngineGateForTests.ready()), true);

    // The engine stops; a program takes its port before it is back.
    await stopped(engine);
    for (const end = Date.now() + 10000; await electron.evaluate(() => globalThis.branchEngineGateForTests.ready());) {
      if (Date.now() > end) throw new Error("the window did not notice the engine stopped");
      await page.waitForTimeout(20);
    }
    squatter = await squatterOn(port);
    const meanwhile = await page.evaluate(() => {
      window.heldState = fetch("/api/state").then((response) => response.status, (error) => `refused: ${error.message}`);
      return Promise.race([window.heldState.then((status) => `answered ${status}`), new Promise((done) => setTimeout(() => done("held"), 1500))]);
    });
    await page.evaluate(() => window.branchDesktop.quickAskKeysChanged()); // main's own request, refused before it is sent
    assert.equal(meanwhile, "held", "the window's request waits; it is not sent to the program on the port");
    assert.equal(await electron.evaluate(() => globalThis.branchEngineGateForTests.ready()), false, "the program did not pass for the engine");
    await squatter.close();

    // The engine is back at its address: it proves itself, the held request goes on, and the window works.
    engine = await backgroundEngine(options.env, port);
    assert.equal(await page.evaluate(() => window.heldState), 200, "the held request went on once the engine was back");
    assert.equal(await page.evaluate(async () => (await fetch("/api/state")).status), 200);
    await connected(page);
    await offScreen(electron, "after the engine came back");
    const windowKey = (await readFile(join(options.env.BRANCH_DATA_DIR, "session-token"), "utf8")).trim();
    const onTheirWay = await heardNothingOfUse(squatter.heard, { windowKey, origin: `http://127.0.0.1:${port}`, refused: () => lines });
    console.log(`# requests already on their way that reached the program on the port: ${onTheirWay}`);
  } finally {
    await squatter?.close();
    await electron.close();
    await stopped(engine);
  }
});
