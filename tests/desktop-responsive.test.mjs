/* The real desktop app (Electron): the engine runs in a process of its own, so while it is busy the window's main
   process (the tray, the window, Windows' "is this app still answering?" check) keeps answering at once, and when the
   engine stops by itself it is started again at the same address and the window's signed requests work again. The
   engine's test hook exists only in an unpackaged copy started with BRANCH_TEST_ENGINE_HOOKS=1. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { _electron } from "playwright";
import { connected, desktopOptions } from "./fixtures/desktop-options.mjs";

const BLOCK_MS = 3000;
/** The window's main process's event-loop delay, 99th percentile, while the engine is blocked. */
const P99_LIMIT_MS = 20;

const signedState = (page) => page.evaluate(async () => {
  const began = performance.now();
  const response = await fetch("/api/state");
  return { status: response.status, ms: performance.now() - began };
});

test("the window stays responsive while the engine is busy, and the engine comes back after it stops", { timeout: 360000 }, async (t) => {
  const { options } = await desktopOptions();
  options.env.BRANCH_TEST_ENGINE_HOOKS = "1";
  const electron = await _electron.launch(options);
  try {
    const page = await electron.firstWindow();
    await connected(page);
    const origin = new URL(page.url()).origin;
    const firstPid = await electron.evaluate(() => globalThis.branchEngineForTests.pid);
    assert.ok(Number.isInteger(firstPid) && firstPid !== (await electron.evaluate(() => process.pid)), "the engine is a process of its own");

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

    // The engine stops by itself: it is started again at the same address, with the window signed in as before.
    await electron.evaluate((_electron, pid) => { process.kill(pid); }, firstPid);
    const back = Date.now() + 60000;
    for (;;) {
      const now = await electron.evaluate(() => ({ running: globalThis.branchEngineForTests.running, pid: globalThis.branchEngineForTests.pid }));
      if (now.running && now.pid !== firstPid) break;
      if (Date.now() > back) throw new Error("the engine was not started again within a minute");
      await page.waitForTimeout(100);
    }
    assert.equal(new URL(page.url()).origin, origin, "the window stays at its address");
    assert.equal((await signedState(page)).status, 200, "the window's signed requests work with the new engine");
    await connected(page);
  } finally {
    await electron.close();
  }
});
