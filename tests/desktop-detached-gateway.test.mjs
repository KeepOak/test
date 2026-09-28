import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { _electron } from "playwright";
import { desktopOptions, offScreen, onboarded } from "./fixtures/desktop-options.mjs";
import { discardTemp } from "./temp-dir.mjs";
import { stopHomeBroker } from "./fixtures/gateway-close.mjs";
import { proveOnce, sessionKey } from "../dist/engine-proof.js";

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
  const firstPid = await first.evaluate(() => process.pid);
  console.log("isolated gateway shell", JSON.stringify({ mainPid: firstPid, home, launchedAt: new Date().toISOString() }));
  await onboarded(await first.firstWindow()); await offScreen(first, "first joined shell");
  presence = JSON.parse(await readFile(join(home, "state", "running.json"), "utf8"));
  token = (await readFile(join(home, "state", "session-token"), "utf8")).trim();
  const boot = await proveOnce(presence.url, token, 5000); assert.ok(boot); assert.notEqual(presence.pid, firstPid);
  console.log("isolated retained broker", JSON.stringify({ mainPid: presence.pid, home }));
  // Playwright waits for its Windows job (including a deliberately retained descendant); observe the real shell exit separately.
  closing.push(first.close()); firstItem.closing = true;
  // A busy computer can take a while to end the shell's processes; the broker's proof is what must not change.
  const until = Date.now() + 45000;
  while (Date.now() < until) { try { process.kill(firstPid, 0); } catch { break; } await new Promise((resolve) => setTimeout(resolve, 30)); }
  assert.throws(() => process.kill(firstPid, 0), "the actual first shell exited");
  assert.equal(await proveOnce(presence.url, token, 5000), boot, "shell close leaves the gateway proof unchanged");
  const second = await _electron.launch(options); shells.push({ electron: second, closing: false });
  await onboarded(await second.firstWindow()); await offScreen(second, "reopened joined shell");
  assert.deepEqual(JSON.parse(await readFile(join(home, "state", "running.json"), "utf8")), presence);
  assert.equal(await proveOnce(presence.url, token, 5000), boot);
});

test("the owner's OFF from a joined shell stops the broker and the shell starts again instead of waiting forever", { timeout: 180000 }, async (t) => {
  // Here an explicit existing runtime is required; a build machine uses the one its install put in place.
  assert.ok(process.env.BRANCH_TEST_ELECTRON || process.env.CI, "an explicit existing runtime is required");
  const { options, home } = await desktopOptions({ hidden: true, gateway: true });
  if (process.env.BRANCH_TEST_ELECTRON) options.executablePath = process.env.BRANCH_TEST_ELECTRON; options.env.BRANCH_TEST_ENGINE_HOOKS = "1";
  const shell = await _electron.launch(options);
  let presence, token;
  t.after(async () => {
    await offScreen(shell, "joined shell cleanup");
    const closing = shell.close();
    // Ends the broker this test's home started, even when the test stopped before it read the note (a busy computer).
    await stopHomeBroker(home);
    await closing;
    await discardTemp(home);
  });
  const shellPid = await shell.evaluate(() => process.pid);
  console.log("isolated gateway-off shell", JSON.stringify({ mainPid: shellPid, home, launchedAt: new Date().toISOString() }));
  await onboarded(await shell.firstWindow()); await offScreen(shell, "joined shell before OFF");
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
  while (Date.now() < until) { try { process.kill(presence.pid, 0); } catch { break; } await new Promise((resolve) => setTimeout(resolve, 50)); }
  assert.throws(() => process.kill(presence.pid, 0), "the broker stopped after the owner's OFF");
  const gone = await shell.evaluate(async () => {
    const stop = Date.now() + 15000;
    while (!globalThis.branchJoinedGoneForTests && Date.now() < stop) await new Promise((resolve) => setTimeout(resolve, 100));
    return globalThis.branchJoinedGoneForTests === true;
  });
  assert.equal(gone, true, "the joined shell saw nothing running and chose to start again");
});
