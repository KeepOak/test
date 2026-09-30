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
import { connected, desktopOptions, heardNothingOfUse, offScreen, squatterOn } from "./fixtures/desktop-options.mjs";

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

const stopped = async (child) => { if (child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, "exit"); } };

/**
 * `branch start` on the app's own data folder, at `port`; resolves once it has written its note and answers. The note
 * is read as the window reads it and must always be whole (a half-written one fails the test). An engine that did not
 * start is stopped here: the caller never holds it, and a running child would keep this file open until its timeout.
 */
async function backgroundEngine(env, port) {
  const child = spawn(process.execPath, [join(root, "dist", "cli.js"), "start"], {
    env: { ...env, BRANCH_PORT: String(port) }, stdio: ["ignore", "ignore", "inherit"], windowsHide: true,
  });
  const note = join(env.BRANCH_DATA_DIR, "running.json");
  try {
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
  } catch (error) {
    await stopped(child);
    throw error;
  }
}

test("a window joined to a background engine holds its requests while it restarts and sends its key only to the engine", { timeout: 360000 }, async () => {
  const { options } = await desktopOptions({ hidden: true }); // never on the screen
  options.env.BRANCH_TEST_ENGINE_HOOKS = "1";
  const port = await freePort();
  let engine = await backgroundEngine(options.env, port);
  const electron = await _electron.launch(options);
  let squatter;
  try {
    const page = await electron.firstWindow();
    await connected(page);
    assert.equal(new URL(page.url()).port, String(port), "the window joined the background engine");
    assert.equal(await electron.evaluate(() => typeof globalThis.branchEngineForTests), "undefined", "and started no engine of its own");
    assert.equal(await electron.evaluate(() => globalThis.branchEngineGateForTests.ready()), true);

    // The engine stops while the window is busy asking it, sending bodies too, so some requests are on their way when it
    // goes; a program takes its port before it is back. Each answer is let go once it has come, as the window's own code
    // reads each one: an answer nobody reads keeps its connection busy (main has 16) until the engine gives up on it, a
    // minute later, so hundreds of them left unread held the window's requests back far past this test's time.
    await page.evaluate(() => {
      window.answered = (response) => { void response.body?.cancel(); return response.status; };
      window.busy = setInterval(() => {
        void fetch("/api/state").then(window.answered, () => undefined);
        void fetch("/api/nothing-here", { method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ note: "A BODY THAT MUST NOT LEAVE ".repeat(200) }) }).then(window.answered, () => undefined);
      }, 5);
    });
    await page.waitForTimeout(200);
    await stopped(engine);
    for (const end = Date.now() + 10000; await electron.evaluate(() => globalThis.branchEngineGateForTests.ready());) {
      if (Date.now() > end) throw new Error("the window did not notice the engine stopped");
      await page.waitForTimeout(20);
    }
    squatter = await squatterOn(port);
    const meanwhile = await page.evaluate(() => {
      window.heldState = fetch("/api/state").then(window.answered, (error) => `refused: ${error.message}`);
      return Promise.race([window.heldState.then((status) => `answered ${status}`), new Promise((done) => setTimeout(() => done("held"), 1500))]);
    });
    await page.evaluate(() => window.branchDesktop.quickAskKeysChanged()); // main's own request, refused before it is sent
    assert.equal(meanwhile, "held", "the window's request waits; it is not sent to the program on the port");
    assert.equal(await electron.evaluate(() => globalThis.branchEngineGateForTests.ready()), false, "the program did not pass for the engine");
    await page.evaluate(() => clearInterval(window.busy));

    // The moment between the engine stopping and the window knowing it, made to last: the window's gate still says the
    // engine is there. A request with a body, and a task's socket, go out; the program on the port gets neither the
    // body nor a byte on the socket, because main proves each connection first and takes only answers the engine marked.
    await electron.evaluate(() => {
      const gate = globalThis.branchEngineGateForTests;
      gate.ready = () => true;
      gate.boot = () => "e".repeat(32);
    });
    const raced = await page.evaluate(async () => {
      const posted = await fetch("/api/nothing-here", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ note: "A BODY THAT MUST NOT LEAVE" }) }).then((response) => response.status, (error) => `refused: ${error.message}`);
      const socket = await new Promise((done) => {
        const ws = new WebSocket(`${location.origin.replace("http", "ws")}/api/runs/00000000-0000-4000-8000-000000000000/ws`, ["bearer"]);
        ws.onopen = () => { ws.send("A FRAME THAT MUST NOT LEAVE"); done("open"); };
        ws.onerror = () => done("refused");
        setTimeout(() => done("no answer"), 5000);
      });
      return { posted, socket };
    });
    await electron.evaluate(() => {
      const gate = globalThis.branchEngineGateForTests;
      delete gate.ready;
      delete gate.boot;
    });
    assert.equal(raced.socket, "refused", "the socket's unmarked answer was refused, so nothing was sent on it");
    assert.notEqual(raced.posted, 200, "the request with a body was not answered by the program");
    assert.ok(squatter.heard.some((each) => each.method === "UPGRADE"), "the socket did reach the program, and got nothing through");
    await squatter.close();

    // The engine is back at its address: it proves itself, the held request goes on, and the window works.
    engine = await backgroundEngine(options.env, port);
    assert.equal(await page.evaluate(() => window.heldState), 200, "the held request went on once the engine was back");
    assert.equal(await page.evaluate(async () => window.answered(await fetch("/api/state"))), 200);
    await connected(page);
    await offScreen(electron, "after the engine came back");
    const windowKey = (await readFile(join(options.env.BRANCH_DATA_DIR, "session-token"), "utf8")).trim();
    const onTheirWay = await heardNothingOfUse(squatter.heard, { windowKey, origin: `http://127.0.0.1:${port}` });
    console.log(`# task sockets that reached the program on the port, with nothing sent on them: ${onTheirWay}`);
  } finally {
    await squatter?.close();
    await electron.close();
    await stopped(engine);
  }
});
