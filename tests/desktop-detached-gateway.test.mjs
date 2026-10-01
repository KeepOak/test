import { processRunning } from "./process-running.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { _electron } from "playwright";
import { desktopOptions, mainLines, offScreen, onboarded, STARTUP_MS } from "./fixtures/desktop-options.mjs";
import { discardTemp } from "./temp-dir.mjs";
import { stopHomeBroker } from "./fixtures/gateway-close.mjs";
import { proveOnce, sessionKey } from "../dist/engine-proof.js";

/**
 * A shell that ends before the test closes it says why: its exit code and everything main wrote are printed into the
 * test's output (a Windows run once saw a shell close about 3.5 s after launch with nothing else to go on).
 */
function reportEarlyExit(electron, name, closing) {
  const lines = mainLines(electron);
  electron.process().once("close", (code, signal) => {
    if (closing()) return;
    console.log(`${name} ended before the test closed it`, JSON.stringify({ code, signal, pid: electron.process().pid }));
    console.log(lines.filter((line) => line.trim()).join("\n") || "(it wrote nothing)");
  });
}

test("a detached Electron broker proves its public engine with no shell windows and ends only its owned engine", { timeout: 180000 }, async (t) => {
  // Here an explicit existing runtime is required; a build machine uses the one its install put in place.
  assert.ok(process.env.BRANCH_TEST_ELECTRON || process.env.CI, "an explicit existing runtime is required");
  const { options, home } = await desktopOptions({ hidden: true, gateway: true });
  if (process.env.BRANCH_TEST_ELECTRON) options.executablePath = process.env.BRANCH_TEST_ELECTRON;
  options.args.push("--branch-gateway"); options.env.BRANCH_TEST_ENGINE_HOOKS = "1";
  const electron = await _electron.launch(options), child = electron.process();
  const mainPid = await electron.evaluate(() => process.pid);
  console.log("isolated windowless broker", JSON.stringify({ launcherPid: child.pid, mainPid, home, launchedAt: new Date().toISOString() }));
  t.after(async () => {
    if (child.exitCode === null) {
      await offScreen(electron, "windowless broker cleanup");
      await electron.evaluate(async (_electron, expectedHome) => {
        if (process.env.BRANCH_DESKTOP_HOME !== expectedHome || process.env.BRANCH_TEST_ENGINE_HOOKS !== "1")
          throw new Error("Refusing another broker's cleanup");
        const gateway = globalThis.branchGatewayForTests;
        if (!gateway) throw new Error("The isolated broker has no cleanup hook");
        await gateway.stop();
      }, home);
      await electron.close();
    }
    await discardTemp(home);
  });
  await electron.evaluate(async () => {
    const until = Date.now() + 120000;
    while (!globalThis.branchGatewayForTests?.health().ok && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 50));
    if (!globalThis.branchGatewayForTests?.health().ok) throw new Error("The isolated gateway did not become ready");
  });
  assert.equal(await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 0);
  const presence = JSON.parse(await readFile(join(home, "state", "running.json"), "utf8"));
  assert.equal(presence.pid, mainPid); assert.equal(presence.mode, "daemon");
  const token = (await readFile(join(home, "state", "session-token"), "utf8")).trim();
  const boot = await proveOnce(presence.url, token, 5000); assert.ok(boot);
  const response = await fetch(`${presence.url}/api/never-break`, { headers: { authorization: `Bearer ${sessionKey(token, boot)}` }, signal: AbortSignal.timeout(10000) });
  assert.equal(response.status, 200);
  const view = await response.json();
  assert.equal(view.underGateway, true);
  assert.deepEqual(view.keepAwakeRuntime, { requested: false, active: false, suspended: false, error: null });
  await offScreen(electron, "windowless broker stays hidden");
});

test("closing and reopening a shell joins the same detached broker and keeps its proved engine", { timeout: 180000 }, async (t) => {
  // Here an explicit existing runtime is required; a build machine uses the one its install put in place.
  assert.ok(process.env.BRANCH_TEST_ELECTRON || process.env.CI, "an explicit existing runtime is required");
  const { options, home } = await desktopOptions({ hidden: true, gateway: true });
  if (process.env.BRANCH_TEST_ELECTRON) options.executablePath = process.env.BRANCH_TEST_ELECTRON; options.env.BRANCH_TEST_ENGINE_HOOKS = "1";
  const shells = []; let presence, token;
  const closing = [];
  t.after(async () => {
    for (const item of shells) {
      if (item.closing) continue;
      await offScreen(item.electron, "joined shell cleanup");
      closing.push(item.electron.close()); item.closing = true;
    }
    // Ends the broker this test's home started, even when the test stopped before it read the note (a busy computer).
    await stopHomeBroker(home);
    await Promise.all(closing);
    await discardTemp(home);
  });
  const first = await _electron.launch(options), firstItem = { electron: first, closing: false }; shells.push(firstItem);
  reportEarlyExit(first, "first joined shell", () => firstItem.closing);
  const firstPid = await first.evaluate(() => process.pid);
  console.log("isolated gateway shell", JSON.stringify({ mainPid: firstPid, home, launchedAt: new Date().toISOString() }));
  await onboarded(await first.firstWindow({ timeout: STARTUP_MS })); await offScreen(first, "first joined shell");
  presence = JSON.parse(await readFile(join(home, "state", "running.json"), "utf8"));
  token = (await readFile(join(home, "state", "session-token"), "utf8")).trim();
  const boot = await proveOnce(presence.url, token, 5000); assert.ok(boot); assert.notEqual(presence.pid, firstPid);
  console.log("isolated retained broker", JSON.stringify({ mainPid: presence.pid, home }));
  // Playwright waits for its Windows job (including a deliberately retained descendant); observe the real shell exit separately.
  closing.push(first.close()); firstItem.closing = true;
  // A busy computer can take a while to end the shell's processes; the broker's proof is what must not change.
  const until = Date.now() + 45000;
  while (Date.now() < until) { if (!processRunning(firstPid)) break; await new Promise((resolve) => setTimeout(resolve, 30)); }
  assert.equal(processRunning(firstPid), false, "the actual first shell exited");
  assert.equal(await proveOnce(presence.url, token, 5000), boot, "shell close leaves the gateway proof unchanged");
  const second = await _electron.launch(options), secondItem = { electron: second, closing: false }; shells.push(secondItem);
  reportEarlyExit(second, "reopened joined shell", () => secondItem.closing);
  await onboarded(await second.firstWindow({ timeout: STARTUP_MS })); await offScreen(second, "reopened joined shell");
  assert.deepEqual(JSON.parse(await readFile(join(home, "state", "running.json"), "utf8")), presence);
  assert.equal(await proveOnce(presence.url, token, 5000), boot);
});

test("the owner's OFF from a joined shell stops the broker and the shell starts again instead of waiting forever", { timeout: 180000 }, async (t) => {
  // Here an explicit existing runtime is required; a build machine uses the one its install put in place.
  assert.ok(process.env.BRANCH_TEST_ELECTRON || process.env.CI, "an explicit existing runtime is required");
  const { options, home } = await desktopOptions({ hidden: true, gateway: true });
  if (process.env.BRANCH_TEST_ELECTRON) options.executablePath = process.env.BRANCH_TEST_ELECTRON; options.env.BRANCH_TEST_ENGINE_HOOKS = "1";
  const shell = await _electron.launch(options);
  let presence, token, closing = false;
  reportEarlyExit(shell, "gateway-off shell", () => closing);
  t.after(async () => {
    closing = true;
    await offScreen(shell, "joined shell cleanup");
    const closed = shell.close();
    // Ends the broker this test's home started, even when the test stopped before it read the note (a busy computer).
    await stopHomeBroker(home);
    await closed;
    await discardTemp(home);
  });
  const shellPid = await shell.evaluate(() => process.pid);
  console.log("isolated gateway-off shell", JSON.stringify({ mainPid: shellPid, home, launchedAt: new Date().toISOString() }));
  await onboarded(await shell.firstWindow({ timeout: STARTUP_MS })); await offScreen(shell, "joined shell before OFF");
  presence = JSON.parse(await readFile(join(home, "state", "running.json"), "utf8"));
  token = (await readFile(join(home, "state", "session-token"), "utf8")).trim();
  const boot = await proveOnce(presence.url, token, 5000); assert.ok(boot); assert.notEqual(presence.pid, shellPid);
  console.log("isolated retained broker", JSON.stringify({ mainPid: presence.pid, home }));
  const response = await fetch(`${presence.url}/api/never-break`, { method: "POST", signal: AbortSignal.timeout(15000),
    headers: { authorization: `Bearer ${sessionKey(token, boot)}`, "content-type": "application/json" }, body: '{"mode":"off"}' });
  assert.equal(response.status, 200);
  const off = await response.json();
  assert.equal(off.mode, "off"); assert.equal(off.stopsWhenOff, true); assert.match(off.note, /stop after this response/);
  const until = Date.now() + 30000;
  while (Date.now() < until) { if (!processRunning(presence.pid)) break; await new Promise((resolve) => setTimeout(resolve, 50)); }
  assert.equal(processRunning(presence.pid), false, "the broker stopped after the owner's OFF");
  const gone = await shell.evaluate(async () => {
    const stop = Date.now() + 15000;
    while (!globalThis.branchJoinedGoneForTests && Date.now() < stop) await new Promise((resolve) => setTimeout(resolve, 100));
    return globalThis.branchJoinedGoneForTests === true;
  });
  assert.equal(gone, true, "the joined shell saw nothing running and chose to start again");
});
