/* Settings › Chat apps › Drive a task's browser from your phone (public/app/settings/phone-access.js,
   src/miniapp/phone-access.ts). Greyed with its reason until an App lock PIN is set. "Turn on phone access" shows the
   exact `tailscale serve` command and runs exactly that on the owner's yes; the card then says where the phone reaches
   the Mini App. "Turn off" does the same with the command that removes that one path. Nothing else runs: a changed
   command, a short-lived key, or no PIN is refused before Tailscale is asked anything. Every change is on the record.
   Tailscale is a stand-in that keeps what it was told; the window is Branch's own, in hidden headless Chromium. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

const tailnet = "desk.tail1234.ts.net";

test("phone access is turned on and off only with the exact command the owner saw and said yes to", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-phone-access-ui-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const ran = [];
  let served = null;
  const tailscale = async (file, args) => {
    const command = [file, ...args].join(" ");
    if (command === "tailscale serve status --json")
      return JSON.stringify(served ? { Web: { [`${tailnet}:443`]: { Handlers: { "/branch": { Proxy: served } } } } } : {});
    ran.push(command);
    const on = /^tailscale serve --bg --yes --https=443 --set-path=\/branch (http:\/\/127\.0\.0\.1:\d+)$/.exec(command);
    if (on) served = on[1];
    else if (command === "tailscale serve --yes --https=443 --set-path=/branch off") served = null;
    else throw Object.assign(new Error("unknown"), { stderr: "not a command this stand-in knows" });
    return "";
  };
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1", tailscaleServe: tailscale });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const call = (path, body, key = server.token) => fetch(new URL(path, server.url), { method: body ? "POST" : "GET",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  await call("/api/onboarding", { done: true });
  await call("/api/deployment/suggestion", { id: "updates", answer: "never" }).catch(() => undefined);
  const onCommand = ["tailscale", "serve", "--bg", "--yes", "--https=443", "--set-path=/branch", `http://127.0.0.1:${server.miniAppDoor.port}`];

  // No PIN yet: greyed with its reason, and the route refuses too.
  assert.equal((await call("/api/miniapp/phone-access", { turn: "on", command: onCommand })).status, 409);
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, serviceWorkers: "block" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  const openPage = async () => {
    await page.locator('#side [data-act="view"][data-v="settings"]').first().click();
    await page.locator('[data-act="setpage"][data-v="chatapps"]').click();
  };
  await openPage();
  const greyed = page.locator('[data-act="phone-access-needs-pin"]');
  await greyed.waitFor();
  assert.equal(await greyed.getAttribute("aria-disabled"), "true");
  assert.match(await greyed.locator("xpath=ancestor::div[contains(@class,'ctl')]").getAttribute("data-why-text"), /App lock PIN/);

  app.sessionLock.setPin({ pin: "2468" });
  // A command other than the one shown, and a short-lived key, are refused before Tailscale is asked to do anything.
  assert.equal((await call("/api/miniapp/phone-access", { turn: "on", command: ["tailscale", "funnel", "--bg", "443"] })).status, 409);
  const { token: scriptKey } = app.sessionTokens.create(app.runtime.owner, { name: "script", scope: "run", minutes: 5 });
  assert.notEqual((await call("/api/miniapp/phone-access", { turn: "on", command: onCommand }, scriptKey)).status, 200);
  assert.deepEqual(ran, [], "nothing ran");

  await page.reload();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  await openPage();
  await page.locator('[data-act="phone-access-on"]').click();
  assert.equal(await page.locator("#phone-access-command").innerText(), onCommand.join(" "), "the exact command, shown first");
  assert.deepEqual(ran, [], "nothing runs before the yes");
  await page.locator('[data-act="phone-access-run"]').click();
  await page.locator('[data-phone-access="on"]').waitFor();
  assert.match(await page.locator('[data-phone-access="on"]').innerText(), new RegExp(`https://${tailnet.replace(/\./g, "\\.")}/branch/miniapp/telegram`));
  assert.deepEqual(ran, [onCommand.join(" ")]);

  await page.locator('[data-act="phone-access-off"]').click();
  assert.equal(await page.locator("#phone-access-command").innerText(), "tailscale serve --yes --https=443 --set-path=/branch off");
  await page.locator('[data-act="phone-access-run"]').click();
  await page.locator('[data-phone-access="off"]').waitFor();
  assert.equal(ran.length, 2);
  const record = await (await call("/api/audit?action=phone.access")).json();
  assert.deepEqual((record.entries ?? record).map((entry) => entry.outcome).sort(), ["refused", "turned off", "turned on"], "the changed command too");
  assert.deepEqual(errors, []);
});
