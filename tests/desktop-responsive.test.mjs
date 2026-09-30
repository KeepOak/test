/* The real desktop app (Electron): the engine runs in a process of its own, so while it is busy the window's main
   process (the tray, the window, Windows' "is this app still answering?" check) keeps answering at once, and when the
   engine stops by itself it is started again at the same address and the window's signed requests work again. The
   engine's test hook exists only in an unpackaged copy started with BRANCH_TEST_ENGINE_HOOKS=1. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { _electron } from "playwright";
import { connected, desktopOptions, heardNothingOfUse, noTaskWorking, offScreen, squatterOn, STARTUP_MS } from "./fixtures/desktop-options.mjs";

const BLOCK_MS = 3000;
/** The window's main process's event-loop delay, 99th percentile, while the engine is blocked. */
const P99_LIMIT_MS = 20;

/** A model server that records the key each question came with and answers in a word. */
async function modelServer() {
  const heard = [];
  const server = createServer(async (request, response) => {
    for await (const _ of request) { /* the question */ }
    if (request.url.endsWith("/chat/completions")) heard.push(request.headers.authorization ?? "");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: [{ id: "saved-model" }], choices: [{ message: { role: "assistant", content: "Done." } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 } }));
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  server.unref();
  return { heard, endpoint: `http://127.0.0.1:${server.address().port}/v1` };
}

const signedState = (page) => page.evaluate(async () => {
  const began = performance.now();
  const response = await fetch("/api/state");
  return { status: response.status, ms: performance.now() - began };
});

test("the window stays responsive while the engine is busy, and the engine comes back after it stops", {
  timeout: 360000,
  skip: process.env.BRANCH_PACKAGED_EXECUTABLE ? "the engine's test hook exists only in a copy run from its source" : false,
}, async (t) => {
  // Started quietly in the tray (fixtures/desktop-options.mjs `hidden`): the window loads and works but is never shown.
  const { options } = await desktopOptions({ hidden: true });
  // No model named at launch: the connection is saved in the app while it runs, and the restarted engine must use it.
  delete options.env.BRANCH_PROVIDER;
  const model = await modelServer();
  options.env.BRANCH_TEST_ENGINE_HOOKS = "1";
  const electron = await _electron.launch(options);
  let squatter;
  try {
    const page = await electron.firstWindow({ timeout: STARTUP_MS });
    await connected(page);
    const origin = new URL(page.url()).origin;
    const firstPid = await electron.evaluate(() => globalThis.branchEngineForTests.pid);
    assert.ok(Number.isInteger(firstPid) && firstPid !== (await electron.evaluate(() => process.pid)), "the engine is a process of its own");
    const priority = await electron.evaluate((_electron, pid) => {
      const os = process.getBuiltinModule("node:os");
      return { engine: os.getPriority(pid), below: os.constants.priority.PRIORITY_BELOW_NORMAL, window: os.getPriority(process.pid) };
    }, firstPid);
    assert.equal(priority.engine, priority.below, "a busy computer serves the window before the engine's work");
    // A build machine may start everything below normal already; the window is never below its engine.
    assert.ok(priority.window <= priority.engine, "the window keeps its own priority");

    // Main's event loop is measured only across the block, at 1 ms, so the limit means what it says.
    await electron.evaluate(() => {
      const { monitorEventLoopDelay } = process.getBuiltinModule("node:perf_hooks");
      globalThis.mainDelay = monitorEventLoopDelay({ resolution: 1 });
      globalThis.mainDelay.enable();
    });
    await electron.evaluate((_electron, ms) => {
      globalThis.engineBlocked = globalThis.branchEngineForTests.call("test-block", { ms }, ms + 10000).then(() => "done", (error) => error.message);
    }, BLOCK_MS);
    const pending = signedState(page);
    let settled = false;
    void pending.finally(() => { settled = true; });
    // While the engine is blocked, main answers and works its window at once, over and over.
    const roundTrips = [];
    while (!settled) {
      const began = Date.now();
      await electron.evaluate(({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows().find((each) => !each.isDestroyed());
        win.setTitle(win.getTitle());
        return win.getBounds().width;
      });
      roundTrips.push(Date.now() - began);
    }
    const blocked = await pending;
    const delay = await electron.evaluate(() => {
      globalThis.mainDelay.disable();
      return { p99: globalThis.mainDelay.percentile(99) / 1e6, max: globalThis.mainDelay.max / 1e6 };
    });
    t.diagnostic(`engine answer ${Math.round(blocked.ms)} ms; main p99 ${delay.p99.toFixed(1)} ms, max ${delay.max.toFixed(1)} ms; ${roundTrips.length} round trips, slowest ${Math.max(...roundTrips)} ms`);
    assert.equal(await electron.evaluate(() => globalThis.engineBlocked), "done");
    assert.equal(blocked.status, 200);
    assert.ok(blocked.ms >= BLOCK_MS * 0.7, `the engine really was busy: its answer took ${Math.round(blocked.ms)} ms`);
    assert.ok(roundTrips.length >= 5, `main was asked again and again while the engine was busy (${roundTrips.length})`);
    assert.ok(Math.max(...roundTrips) < 200, `main answered each time at once (slowest ${Math.max(...roundTrips)} ms)`);
    assert.ok(delay.p99 < P99_LIMIT_MS, `main's event loop p99 stayed under ${P99_LIMIT_MS} ms (${delay.p99.toFixed(1)} ms, max ${delay.max.toFixed(1)} ms)`);
    assert.equal(await page.evaluate(() => 1 + 1), 2, "the window's page answers");
    await offScreen(electron, "while the engine was busy");

    // A failure nobody caught in the engine is written down and the engine carries on: same process, still answering.
    assert.equal(await electron.evaluate(() => globalThis.branchEngineForTests.call("test-throw", { kind: "exception" }, 5000)), true);
    assert.equal(await electron.evaluate(() => globalThis.branchEngineForTests.call("test-throw", { kind: "rejection" }, 5000)), true);
    assert.equal((await signedState(page)).status, 200, "the engine still answers the window");
    assert.equal(await electron.evaluate(() => globalThis.branchEngineForTests.pid), firstPid, "and it is the same engine, not a fresh one");

    // The engine stops by itself: it is started again at the same address, with the window signed in as before.
    // A model connection saved now, after launch, is what the engine uses once it has started again.
    const saved = await page.evaluate((endpoint) => window.branchDesktop.saveModelSettings({ provider: "openai", endpoint, model: "saved-model",
      apiKey: "saved-after-launch-key" }).then(() => "saved", (error) => error.message), model.endpoint);
    await electron.evaluate((_electron, pid) => { process.kill(pid); }, firstPid);
    // While it is down its port is free, and another program could take it: the window sends it nothing, above all not
    // its key, until the engine answers there again.
    for (const gone = Date.now() + 10000; await electron.evaluate(() => globalThis.branchEngineForTests.running);) {
      if (Date.now() > gone) throw new Error("main did not notice the engine stopped");
      await page.waitForTimeout(20);
    }
    squatter = await squatterOn(Number(new URL(origin).port));
    // The window's request is held (not sent) while the engine has not proved itself at its address.
    const meanwhile = await page.evaluate(() => {
      window.heldState = fetch("/api/state").then((response) => response.status, (error) => `refused: ${error.message}`);
      return Promise.race([window.heldState.then((status) => `answered ${status}`), new Promise((resolve) => setTimeout(() => resolve("held"), 300))]);
    });
    // Main's own requests too (here the quick-ask keys, read again at the page's asking) are refused before they are sent.
    await page.evaluate(() => window.branchDesktop.quickAskKeysChanged());
    await squatter.close();
    assert.equal(meanwhile, "held", "nothing reaches the engine's address while it is down");
    assert.equal(await electron.evaluate(() => globalThis.branchEngineGateForTests.ready()), false, "the program there did not pass for the engine");
    const back = Date.now() + 60000;
    for (;;) {
      const now = await electron.evaluate(() => ({ running: globalThis.branchEngineForTests.running, pid: globalThis.branchEngineForTests.pid }));
      if (now.running && now.pid !== firstPid) break;
      if (Date.now() > back) throw new Error("the engine was not started again within a minute");
      await page.waitForTimeout(100);
    }
    assert.equal(new URL(page.url()).origin, origin, "the window stays at its address");
    assert.equal(await page.evaluate(() => window.heldState), 200, "the held request went on once the engine was back");
    if (saved === "saved") {
      void page.evaluate(() => fetch("/api/run", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "Use the saved connection." }) }).catch(() => undefined));
      for (const end = Date.now() + 30000; !model.heard.length;) {
        if (Date.now() > end) throw new Error("the restarted engine never asked the connection saved after launch");
        await page.waitForTimeout(100);
      }
      assert.equal(model.heard[0], "Bearer saved-after-launch-key", "the restarted engine uses the connection saved after launch");
    } else t.diagnostic(`this computer cannot keep a key (${saved}); the saved-connection step is skipped`);
    assert.equal((await signedState(page)).status, 200, "the window's signed requests work with the new engine");
    await connected(page);
    const windowKey = (await readFile(join(options.env.BRANCH_DATA_DIR, "session-token"), "utf8")).trim();
    const onTheirWay = await heardNothingOfUse(squatter.heard, { windowKey, origin });
    t.diagnostic(`task sockets that reached the program on the port, with nothing sent on them: ${onTheirWay}`);
  } finally {
    await squatter?.close();
    // Quitting with a task still working asks the owner in a dialog, which would show on the screen: none is left working.
    await noTaskWorking(electron).catch((error) => t.diagnostic(`tasks left working: ${error.message}`));
    await electron.close();
  }
});
