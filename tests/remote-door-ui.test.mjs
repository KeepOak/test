/**
 * The pairing dialog's "Open it to Tailscale" switch (public/app/flows/pair.js), opened the way a person opens it:
 * Settings › Computer & browser › Add a computer › Another computer with Branch. One change at a time reaches the
 * engine, however fast it is clicked; the switch is on while the door is open, and turning it off closes the door.
 *
 * No real Tailscale is asked: the engine is handed a stand-in that answers when the test says so, and the door that
 * asks for its address (in Tailscale's range, which this computer does not have) is opened on 127.0.0.1 and counted.
 */
import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { signIn, openSettings } from "./new-window-places.mjs";

const TAILNET = "100.101.102.103";
const doors = [];
const realListen = net.Server.prototype.listen;
net.Server.prototype.listen = function listen(...args) {
  if (args[1] === TAILNET) { args[1] = "127.0.0.1"; doors.push(this); }
  return realListen.apply(this, args);
};
const openDoors = () => doors.filter((server) => server.listening).length;

function tailscale() {
  const waiting = [];
  const probe = () => { probe.calls++; return new Promise((resolve) => waiting.push(resolve)); };
  probe.calls = 0;
  probe.waiting = () => waiting.length;
  probe.answer = () => { for (const resolve of waiting.splice(0))
    resolve({ present: true, running: true, address: TAILNET, hostname: null, message: "Tailscale is running." }); };
  return probe;
}

async function pairingDialog(t) {
  doors.length = 0;
  const probe = tailscale();
  const root = await mkdtemp(join(tmpdir(), "branch-door-ui-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"),
    provider: { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } } });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1", tailscale: probe });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { probe.answer(); await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const call = (path, body) => fetch(new URL(path, server.url), { method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    .then((response) => response.json());
  await call("/api/onboarding", { done: true });
  await call("/api/devices/mode", { mode: "when-needed" });
  const page = await (await browser.newContext({ viewport: { width: 1200, height: 900 }, serviceWorkers: "block" })).newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const posts = [];
  page.on("request", (request) => { if (request.method() === "POST" && new URL(request.url()).pathname === "/api/deployment/remote") posts.push(request.postDataJSON()); });
  await signIn(page, server);
  await openSettings(page, "computer");
  await page.locator('#main [data-act="comp-add"]').click();
  await page.locator('.dlg [data-act="comp-add-go"][data-v="pair"]').click();
  await page.locator('.dlg input.sw#pair-door:not(:checked)').waitFor({ timeout: 20000 });
  assert.equal(await page.locator(".dlg input.sw#pair-door").getAttribute("aria-label"), "Open it to Tailscale");
  const until = async (check, what) => { for (let i = 0; i < 200 && !check(); i++) await page.waitForTimeout(25); assert.ok(check(), what); };
  return { page, probe, posts, errors, call, until };
}

test("a double click on the Open it to Tailscale switch sends one switch-on and opens one door; off closes it", async (t) => {
  const { page, probe, posts, errors, call, until } = await pairingDialog(t);
  await page.locator(".dlg #pair-door").dblclick();
  await until(() => probe.waiting() > 0, "Tailscale is asked");
  assert.equal(await page.locator('.dlg #pair-door[aria-busy="true"]:disabled').count(), 1, "the switch is drawn busy while the engine answers");
  probe.answer();
  const on = page.locator(".dlg #pair-door:checked:not(:disabled)");
  await on.waitFor({ timeout: 20000 });
  assert.deepEqual(posts, [{ enabled: true }], "one switch-on reached the engine");
  assert.equal(openDoors(), 1);
  assert.ok((await page.locator(".dlg .pair-cmd15").innerText()).includes(TAILNET), "the new invitation carries the Tailscale address");

  await on.click();
  await page.locator(".dlg #pair-door:not(:checked):not(:disabled)").waitFor({ timeout: 20000 });
  assert.deepEqual(posts, [{ enabled: true }, { enabled: false }], "turning the switch off switched the door off");
  await until(() => openDoors() === 0, "no door is left listening");
  assert.equal((await call("/api/deployment")).remote.enabled, false);
  assert.deepEqual(errors, []);
});

test("two changes in the same moment reach the engine once", async (t) => {
  const { page, probe, posts, until } = await pairingDialog(t);
  await page.evaluate(() => {
    // The switch is drawn again at the first change, so the second goes to the switch now showing, as a script could.
    for (let i = 0; i < 2; i++) {
      const box = document.querySelector(".dlg #pair-door");
      box.checked = true;
      box.dispatchEvent(new Event("change", { bubbles: true }));
    }
  });
  await until(() => probe.waiting() > 0, "Tailscale is asked");
  probe.answer();
  await page.locator(".dlg #pair-door:checked:not(:disabled)").waitFor({ timeout: 20000 });
  await page.waitForTimeout(200);
  assert.deepEqual(posts, [{ enabled: true }]);
});
