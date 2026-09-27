/* The update screen and Settings › Updates' status card, against a real engine, with the desktop app's updater bridge
   stood in for (window.branchDesktop: updateStatus, onUpdateStatus, checkForUpdates, installUpdate), since a browser has
   no updater. Each status is one the updater sends (src/desktop/updater.ts stages, target, failure). Screenshots in dark
   and light. PORT=<port> TOKEN=<hex> [OUT=<folder>] node design/redesign/tools/verify-update-screen.cjs */
const { chromium } = require("playwright");
const { join } = require("node:path");

const port = process.env.PORT, token = process.env.TOKEN, out = process.env.OUT ?? ".";
if (!port || !token) throw new Error("PORT and TOKEN are needed.");
const INSTALLED = "0.19.4-dev.1790475733-g0ff7d55d711b", BUILT = "0.19.4-dev.1790477481-g3da16f3597a3", NEW = "3da16f3597a353daaca17a9e98def78c9c37f48a";
const ago = (s) => new Date(Date.now() - s * 1000).toISOString();
const stage = (id, state, from = null, to = null) => ({ id, state, startedAt: from === null ? null : ago(from), endedAt: to === null ? null : ago(to) });
const base = { installed: { version: INSTALLED, commit: "0ff7d55d711b" + "0".repeat(28) }, outcome: null, progress: null, bytes: null,
  release: { channel: "beta", commit: NEW, available: true, latestVersion: BUILT }, target: { version: BUILT, commit: NEW }, failure: null };
const building = { ...base, phase: "downloading", message: "Building Branch on this computer…", updatedAt: ago(0),
  stages: [stage("fetching", "done", 52, 46), stage("installing", "skipped", 46, 46), stage("building", "running", 46), stage("checking", "waiting"),
    stage("copying", "waiting"), stage("swapping", "waiting"), stage("restarting", "waiting")] };
const failed = { ...building, phase: "error", message: "node scripts/package-desktop.mjs did not finish: ENOENT: no such file or directory, copyfile", updatedAt: ago(0),
  outcome: { kept: INSTALLED, backgroundStopped: false }, failure: { stage: "building", line: "ENOENT: no such file or directory, copyfile 'node_modules\\electron\\dist\\electron.exe' -> 'release\\Branch Agent-win32-x64\\Branch Agent.exe'" },
  stages: building.stages.map((one) => (one.id === "building" ? { ...one, state: "failed", endedAt: ago(0) } : one)) };
const ready = { ...base, phase: "available", message: "A newer Beta build (change 3da16f3) can be built and installed.", stages: null, target: null, updatedAt: ago(0) };

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  for (const theme of ["dark", "light"]) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, colorScheme: theme });
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(() => {
      window.__upd = { status: null, listeners: [] };
      window.branchDesktop = {
        updateStatus: async () => window.__upd.status, checkForUpdates: async () => window.__upd.status, installUpdate: async () => window.__upd.status,
        onUpdateStatus: (callback) => window.__upd.listeners.push(callback), openExternal: async () => true,
      };
      window.__send = (status) => { window.__upd.status = status; for (const callback of window.__upd.listeners) callback(status); };
    });
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.getByLabel("Session token").fill(token);
    await page.getByRole("button", { name: "Connect" }).click();
    await page.waitForSelector(".app", { timeout: 20000 });
    await page.evaluate((look) => { document.documentElement.dataset.theme = look; }, theme);
    // The engine's saved look decides the theme on load; each step here is taken in the look being shot.
    const send = (status) => page.evaluate(([s, look]) => { document.documentElement.dataset.theme = look; window.__send(s); }, [status, theme]);
    const shot = async (name) => { await page.waitForTimeout(700); await page.screenshot({ path: join(out, `${name}-${theme}.png`) }); };

    await send(building);
    await page.waitForSelector("#upd18:not([hidden]) .upd18-card");
    await page.waitForTimeout(1500);
    const text = await page.locator("#upd18").innerText();
    if (!text.includes(BUILT) || !text.includes(INSTALLED) || !/0:4\d|0:5\d/.test(text)) throw new Error(`the screen does not name both versions and the time: ${text}`);
    await shot("update-building");
    await page.click('[data-act="upd18-fold"]');
    await page.waitForSelector("#upd18.folded");
    await shot("update-strip");
    await page.click('[data-act="upd18-open"]');
    await send(failed);
    await page.waitForSelector(".upd18-err");
    await shot("update-failed");
    await page.click('[data-act="upd18-close"]');
    if (await page.isVisible("#upd18")) throw new Error("Close did not close the failure");

    // A fresh engine opens setup first; the owner has finished it (POST /api/onboarding), then Settings › Updates.
    await page.evaluate(async (key) => {
      const response = await fetch("/api/onboarding", { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({ done: true, finished: true }) });
      if (!response.ok) throw new Error(`onboarding: ${response.status}`);
      // The owner's own choice: Beta, kept up to date by itself (POST /api/comfort merges the notify card).
      const comfort = await fetch("/api/comfort", { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({ card: "notify", values: { autoUpdate: "install", releaseChannel: "beta" } }) });
      if (!comfort.ok) throw new Error(`comfort: ${comfort.status} ${await comfort.text()}`);
    }, token);
    await page.goto(`http://127.0.0.1:${port}/#open=settings:updates`);
    await page.waitForSelector(".app", { timeout: 20000 });
    await page.evaluate((look) => { document.documentElement.dataset.theme = look; }, theme);
    await send(ready);
    await page.waitForSelector(".upd18-status");
    await page.waitForTimeout(500);
    const card = await page.locator(".upd18-status").innerText();
    if (!/3da16f3/.test(card) || !/Update now/.test(card)) throw new Error(`the card does not offer the ready update: ${card}`);
    if (!/Checks every few minutes/.test(await page.locator("#main").innerText())) throw new Error("the switch does not say Beta's cadence");
    await page.click("#u-more summary");
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(out, `settings-ready-${theme}.png`) });
    await send(building);
    await page.waitForSelector(".upd18-status .sdot.busy");
    await page.click("#upd18 [data-act='upd18-fold']");
    await page.waitForTimeout(500);
    await page.screenshot({ path: join(out, `settings-building-${theme}.png`) });
    await page.close();
  }
  await browser.close();
  if (errors.length) throw new Error(`page errors: ${errors.join(" | ")}`);
  console.log("update screen ok: building, strip, failure, Settings card (ready, building), dark and light; 0 page errors");
})().catch((error) => { console.error(error.message); process.exit(1); });
