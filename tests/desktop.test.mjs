import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { _electron } from "playwright";

import { backToConversation, connected, desktopOptions, onboarded, openSettingsPage, send, taskDone, tokenNotExposed } from "./fixtures/desktop-options.mjs";

/* Redesign: the old Appearance page had Daylight or Forest and a "Save appearance" button. The new one (Settings ›
   Appearance, as the prototype's) has a Light and a Dark mirror that apply and save at once: the page wears
   data-theme="light" or "dark", and the engine keeps it as daylight or forest (shell/shell.js setTheme). */
const KEPT = { light: "daylight", dark: "forest" };
async function appearance(page, mode) {
  await openSettingsPage(page, "appearance");
  await page.locator(`button.mirror[data-act="themeset"][data-v="${mode}"]`).click();
  await page.waitForFunction((mode) => document.documentElement.dataset.theme === mode, mode);
  await page.waitForFunction(async (kept) => (await (await fetch("/api/state")).json()).preferences?.appearance === kept, KEPT[mode]);
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
  async () => {
    const { home, options } = await desktopOptions();
    const electron = await _electron.launch(options);
    const child = electron.process();
    let url;
    try {
      const page = await electron.firstWindow();
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
    } finally {
      await electron.close();
    }
    assert.equal(child.exitCode, 0);
    await assert.rejects(fetch(url, { signal: AbortSignal.timeout(2000) }));
    const restarted = await _electron.launch(options);
    try {
      const page = await restarted.firstWindow();
      await connected(page);
      assert.equal(
        await page.locator("html").getAttribute("data-theme"),
        "light",
      );
      // Redesign: the old window's "Branch Agent home" link is gone; the prototype's wordmark is not a link. Its way
      // home from anywhere else is Settings' "Back to <assistant>", so that is what is followed after the restart.
      await openSettingsPage(page, "general");
      await backToConversation(page);
      await connected(page);
    } finally {
      await restarted.close();
    }
  },
);

/* Talk live in the desktop window: the page holds no key, so the app signs the task socket's opening request, and the
   window lets the microphone through only for a call the owner started, for sound only, once. Chromium's fake
   microphone only (--use-fake-device-for-media-stream): no real microphone is opened. */
test("the desktop window opens a task's socket, and the microphone only for a call the owner started", { timeout: 360000 }, async () => {
  const { options } = await desktopOptions();
  const electron = await _electron.launch({ ...options, args: [...options.args, "--use-fake-device-for-media-stream"] });
  try {
    const page = await electron.firstWindow();
    await onboarded(page);
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
