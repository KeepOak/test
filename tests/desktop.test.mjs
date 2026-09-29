import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { spawnSync } from "node:child_process";
import { _electron } from "playwright";

import { backToConversation, connected, desktopOptions, offScreen, onboarded, openSettingsPage, send, taskDone, tokenNotExposed, STARTUP_MS } from "./fixtures/desktop-options.mjs";
import { waitInPage } from "./wait-in-page.mjs";
/* The window opens once the engine's own process has started (src/desktop/main.ts startEngine), which on a busy build
   machine takes longer than Playwright's 30 s default, so the first window is waited for as long as a start may take. */
const firstWindow = (electron) => electron.firstWindow({ timeout: STARTUP_MS });

/* Redesign: the old Appearance page had Daylight or Forest and a "Save appearance" button. The new one (Settings ›
   Appearance, as the prototype's) has a Light and a Dark mirror that apply and save at once: the page wears
   data-theme="light" or "dark", and the engine keeps it as daylight or forest (shell/shell.js setTheme). */
const KEPT = { light: "daylight", dark: "forest" };
async function appearance(page, mode) {
  await openSettingsPage(page, "appearance");
  await page.locator(`button.mirror[data-act="themeset"][data-v="${mode}"]`).click();
  await page.waitForFunction((mode) => document.documentElement.dataset.theme === mode, mode);
  await waitInPage(page, async (kept) => (await (await fetch("/api/state")).json()).preferences?.appearance === kept, KEPT[mode]);
}

async function verifyWindow(electron, page, home) {
  await onboarded(page);
  // Redesign: the new window names itself Branch (its title and its wordmark, as the prototype's titlebar).
  assert.match(await page.title(), /^Branch/);
  const isolation = await electron.evaluate(({ BrowserWindow }) => {
    const p =
      BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
    return {
      node: p.nodeIntegration,
      context: p.contextIsolation,
      sandbox: p.sandbox,
    };
  });
  assert.deepEqual(isolation, { node: false, context: true, sandbox: true });
  assert.equal(await page.evaluate(() => typeof window.require), "undefined");
  await tokenNotExposed(page, home);
  await send(page, "Run the file workflow.");
  await page.locator("#conversation .b").first().waitFor({ timeout: 30000 });
  await taskDone(page, "Run the file workflow.");
  assert.equal(
    await readFile(join(home, "workspace", "branch-demo.txt"), "utf8"),
    "Hello from Branch.\n",
  );
}

/**
 * Quitting while a task is working asks the person (src/desktop/quit-guard.ts), and a test cannot answer that box,
 * so the app is closed only once nothing is working. It waits at most a minute and says what was still going.
 */
async function settled(page, label) {
  for (let tries = 0; tries < 120; tries++) {
    const busy = await page.evaluate(async () => (await (await fetch("/api/comfort/update-readiness")).json()).busyTasks).catch(() => null);
    if (busy === 0) return;
    if (tries % 20 === 0) console.log(`Desktop ${label}: ${busy ?? "unknown"} task(s) still working`);
    await page.waitForTimeout(500);
  }
  console.log(`Desktop ${label}: still working after a minute; closing anyway`);
}

/**
 * Closes the app, but never waits on it for more than half a minute: a close that does not come back is ended, so a
 * stuck app fails this test in minutes instead of holding the whole shard until the job's hour runs out (Q244).
 */
async function closeWithin(app, child, label) {
  const closed = await Promise.race([app.close().then(() => true, () => true), new Promise((resolve) => setTimeout(() => resolve(false), 30000))]);
  if (!closed && child.exitCode === null) { console.log(`Desktop ${label}: close did not come back in 30 s; ending it`); endTree(child); }
}
/**
 * Q244 (R21's Windows run): ending only Electron's main process left its helpers holding the test's output open, so the
 * shard still waited out its hour after the test had failed. On Windows the whole tree is ended.
 */
function endTree(child) {
  if (child.exitCode !== null) return;
  if (process.platform === "win32" && child.pid) spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  else child.kill();
}
/** Q244: what the window was doing when a step failed: its address, loading, crashed, visible, and whether the page answers. */
async function windowState(app, page) {
  const within = (work) => Promise.race([work.catch((error) => `error: ${String(error?.message ?? error).split(/\r?\n/)[0]}`),
    new Promise((resolve) => setTimeout(() => resolve("no answer in 5 s"), 5000))]);
  const main = await within(app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => ({
    url: w.webContents.getURL(), loading: w.webContents.isLoading(), crashed: w.webContents.isCrashed(),
    visible: w.isVisible(), destroyed: w.isDestroyed() }))));
  const inPage = await within(page.evaluate(() => ({ ready: document.readyState, url: location.href })));
  return JSON.stringify({ main, inPage });
}
/** Q244: says what went wrong before the app is closed, so a run that then hangs still shows it. */
function said(label) {
  return (error) => { console.log(`Desktop ${label}: failed: ${String(error?.message ?? error).split(/\r?\n/)[0]}`); throw error; };
}

async function verifyNetworkBoundary(electron, page) {
  let hits = 0;
  const outside = createServer((_request, response) => {
    hits++;
    response.end("outside");
  });
  outside.listen(0, "127.0.0.1");
  await once(outside, "listening");
  const original = page.url(),
    target = `http://127.0.0.1:${outside.address().port}`;
  try {
    await electron.evaluate(async ({ BrowserWindow }, target) => {
      const contents = BrowserWindow.getAllWindows()[0].webContents;
      try {
        await contents.loadURL(target);
      } catch {}
      /* The refused load is reported before the window has stopped loading. Loading the page again
         in between made that late stop end the new load instead ("ERR_FAILED (-2) loading" the
         app's own address, seen on Linux), so the window is let finish first. */
      if (contents.isLoading())
        await new Promise((done) => contents.once("did-stop-loading", done));
    }, target);
    assert.equal(hits, 0);
    await electron.evaluate(
      ({ BrowserWindow }, url) => BrowserWindow.getAllWindows()[0].loadURL(url),
      original,
    );
    await connected(page);
    assert.equal(
      await page.evaluate(() => window.open("https://example.com") === null),
      true,
    );
    assert.equal(
      await electron.evaluate(
        ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
      ),
      1,
    );
  } finally {
    outside.close();
    await once(outside, "close");
  }
}

test(
  "native desktop authenticates locally, completes work, persists appearance, and hides to tray",
  { timeout: 360000 },
  async (t) => {
    // Hidden on a desktop someone is using; on a build machine (CI) the window shows, so closing it can prove it goes
    // to the tray rather than quitting.
    const { home, hidden, options } = await desktopOptions();
    const electron = await _electron.launch(options);
    const child = electron.process();
    // The trunk's Windows runs after R18 and R19: when this test ran out of time its app was never closed, so the
    // shard waited on it until the job's hour was up. Running out of time now ends each app it started.
    // Node aborts the signal whenever the test ends, passed or not (Mac mini 07fdc5b), so only a child still running is ended.
    t.signal.addEventListener("abort", () => endTree(child), { once: true });
    let url;
    try {
      const page = await firstWindow(electron);
      await verifyWindow(electron, page, home);
      url = page.url();
      await verifyNetworkBoundary(electron, page);
      await appearance(page, "light");
      await page.reload();
      await connected(page);
      assert.equal(
        await page.locator("html").getAttribute("data-theme"),
        "light",
      );
      await appearance(page, "dark");
      /* Settings covers the conversation in the new window; its "Back to <assistant>" is the way back to it. */
      await backToConversation(page);
      await page.screenshot({ path: join(home, "desktop.png") });
      await appearance(page, "light");
      if (hidden) await offScreen(electron, "before closing");
      else assert.equal(await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), true, "on the screen before closing");
      await electron.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].close(),
      );
      assert.equal(
        await electron.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0].isVisible(),
        ),
        false,
      );
      console.log(`Desktop screenshot: ${join(home, "desktop.png")}`);
      await settled(page, "first run");
    } catch (error) {
      said("first app")(error);
    } finally {
      await closeWithin(electron, child, "first app");
      console.log("Desktop: first app closed");
    }
    assert.equal(child.exitCode, 0);
    await assert.rejects(fetch(url, { signal: AbortSignal.timeout(2000) }));
    const restarted = await _electron.launch(options);
    const restartedChild = restarted.process();
    // Q244: the restarted app stops answering (main process included) soon after it connects; the engine runs inside
    // that process, so what it says about itself (a long job, a blocked event loop) is passed on, at most 80 lines.
    let told = 0;
    const tell = (stream) => (chunk) => {
      for (const line of String(chunk).split(/\r?\n/).filter(Boolean))
        if (told++ < 80) console.log(`Desktop restart ${stream}: ${line.slice(0, 300)}`);
    };
    restartedChild.stdout?.on("data", tell("out"));
    restartedChild.stderr?.on("data", tell("err"));
    t.signal.addEventListener("abort", () => endTree(restartedChild), { once: true });
    try {
      // Each step says so, so a run that stops here shows where.
      const page = await firstWindow(restarted);
      console.log("Desktop restart: window open");
      await connected(page);
      if (hidden) await offScreen(restarted, "restarted");
      console.log("Desktop restart: connected");
      assert.equal(
        await page.locator("html").getAttribute("data-theme"),
        "light",
      );
      // Redesign: the old window's "Branch Agent home" link is gone; the prototype's wordmark is not a link. Its way
      // home from anywhere else is Settings' "Back to <assistant>", so that is what is followed after the restart.
      await openSettingsPage(page, "general");
      await backToConversation(page);
      console.log("Desktop restart: home clicked");
      await connected(page);
      console.log("Desktop restart: home again");
      await settled(page, "restart");
    } catch (error) {
      console.log(`Desktop restart: window state: ${await windowState(restarted, await firstWindow(restarted))}`);
      said("restart")(error);
    } finally {
      await closeWithin(restarted, restartedChild, "restart");
      console.log("Desktop restart: closed");
    }
  },
);

/* Talk live in the desktop window: the page holds no key, so the app signs the task socket's opening request, and the
   window lets the microphone through only for a call the owner started, for sound only, once. Chromium's fake
   microphone only (--use-fake-device-for-media-stream): no real microphone is opened. */
test("the desktop window opens a task's socket, and the microphone only for a call the owner started", { timeout: 360000 }, async () => {
  const { options } = await desktopOptions({ hidden: true });
  const electron = await _electron.launch({ ...options, args: [...options.args, "--use-fake-device-for-media-stream"] });
  try {
    const page = await firstWindow(electron);
    await onboarded(page);
    await offScreen(electron, "opened");
    const ask = (constraints, started) => page.evaluate(async ({ constraints, started }) => {
      if (started) await window.branchDesktop.talkLiveMic();
      try {
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        stream.getTracks().forEach((track) => track.stop());
        return "open";
      } catch (error) { return error.name; }
    }, { constraints, started });
    assert.equal(await ask({ audio: true }, false), "NotAllowedError", "never before the owner starts a call");
    assert.equal(await ask({ audio: true }, true), "open", "the call's own microphone");
    assert.equal(await ask({ audio: true }, false), "NotAllowedError", "once per call");
    assert.equal(await ask({ audio: true, video: true }, true), "NotAllowedError", "never the camera");

    await send(page, "Run the file workflow.");
    await taskDone(page, "Run the file workflow.");
    const heard = await page.evaluate(async () => {
      const run = (await (await fetch("/api/state")).json()).runs.find((each) => each.prompt === "Run the file workflow.");
      const socket = new WebSocket(new URL(`/api/runs/${run.id}/ws`, location.href).href.replace(/^http/, "ws"), ["bearer"]);
      const kinds = [];
      socket.onmessage = (event) => kinds.push(JSON.parse(event.data).kind);
      return new Promise((done) => {
        socket.onclose = () => done(kinds);
        setTimeout(() => { socket.close(); done(kinds); }, 20000);
      });
    });
    assert.ok(heard.includes("end"), `the signed socket opened and streamed the task (${heard.join(", ")})`);
  } finally {
    await electron.close();
  }
});
