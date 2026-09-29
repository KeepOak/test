/**
 * QA retest 2026-09-28 (and CODEX-TEST-2026-09-27): on Windows the iMessage wizard let the owner Continue through Paste
 * ("Paste what iMessage gave you … Nothing to paste") to a switch the engine then refuses, because the service only runs
 * on a Mac (src/channels/imessage.ts `platforms`). The Set up panel now says why and the wizard holds Continue there.
 * Node only: the real dist/ and public/, headless Chromium, port 0.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { setupList, setupPanel, saveSetup, saveSetupMode } from "../dist/channel-setup/service.js";
import { recipes } from "../dist/channel-setup/recipes.js";
import { readFile } from "node:fs/promises";
import { newWindow, openPlace } from "./new-window-places.mjs";

const store = { get: () => undefined };

test("the Set up panel says a Mac-only app cannot be set up elsewhere, and nothing else is held", () => {
  for (const platform of ["win32", "linux"]) {
    const panel = setupPanel(store, "local", "imessage", platform);
    assert.match(String(panel.unavailable), /^iMessage works only on a Mac, so it cannot be set up on this computer\.$/, platform);
  }
  assert.deepEqual(setupPanel(store, "local", "imessage", "win32").onlyOn, ["darwin"], "the window words it from the systems");
  assert.equal(setupPanel(store, "local", "imessage", "darwin").unavailable, null, "on a Mac it can");
  assert.equal(setupPanel(store, "local", "imessage", "darwin").onlyOn, null);
  const held = recipes().filter((recipe) => setupPanel(store, "local", recipe.id, "win32").unavailable !== null).map((recipe) => recipe.id);
  assert.deepEqual(held, ["imessage"], "on Windows only iMessage is held");
});

test("the catalog marks only iMessage off a Mac, and saving it there is refused before anything is checked or kept", async (t) => {
  const onlyOn = (platform) => setupList(store, "local", platform).channels.filter((c) => c.onlyOn).map((c) => [c.id, c.onlyOn]);
  assert.deepEqual(onlyOn("win32"), [["imessage", ["darwin"]]]);
  assert.deepEqual(onlyOn("darwin"), []);
  const root = await mkdtemp(join(tmpdir(), "branch-setup-platform-save-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  t.after(async () => { await app.close(); await discardTemp(root); });
  saveSetupMode(app.store, "local", { mode: "on" });
  let fetched = 0;
  const host = { store: app.store, owner: "local", platform: "win32", fetch: async () => { fetched++; throw new Error("no network here"); } };
  await assert.rejects(saveSetup(host, "imessage", { values: {}, enable: "on" }), /iMessage works only on a Mac/);
  assert.equal(fetched, 0);
  assert.equal(app.store.get("settings", "local", "channel-setup-done"), undefined, "nothing was kept");
});

test("the window's sentence has its words in every language the window speaks", async () => {
  const keys = ["window.flows.chw.only-on", "window.flows.chw.system-mac", "window.flows.chw.system-windows", "window.flows.chw.system-linux"];
  const en = JSON.parse(await readFile(new URL("../public/locales/en.json", import.meta.url), "utf8"));
  for (const lang of ["fr", "de", "es"]) {
    const other = JSON.parse(await readFile(new URL(`../public/locales/${lang}.json`, import.meta.url), "utf8"));
    for (const key of keys) assert.ok(other[key], `${lang} ${key}`);
    assert.notEqual(other[keys[0]], en[keys[0]], `${lang} is not the English`);
  }
});

test("off a Mac the iMessage wizard shows why and its Continue stays off", { skip: process.platform === "darwin" && "this computer is a Mac" }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-setup-platform-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"),
    provider: { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } } });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  await fetch(new URL("/api/onboarding", server.url), { method: "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify({ done: true }) });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 }, serviceWorkers: "block" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#main").waitFor({ state: "visible", timeout: 120000 });
  // The same opener the chat-app cards call (data-act="ch-open").
  await page.evaluate(async () => (await import("/app/flows/chat.js")).openChatWizard("imessage"));
  const note = page.locator("[data-chw-unavailable]");
  await note.waitFor({ timeout: 30000 });
  assert.match(await note.textContent(), /iMessage works only on a Mac/);
  assert.equal(await page.locator('[data-act="chw-next"]').isDisabled(), true, "Continue stays off");
  assert.equal(await page.getByText("Paste what iMessage gave you", { exact: false }).count(), 0, "no Paste step with nothing to paste");
  assert.deepEqual(errors, []);
});

test("off a Mac the chat app catalog says iMessage needs a Mac", { skip: process.platform === "darwin" && "this computer is a Mac" }, async (t) => {
  const { page, errors } = await newWindow(t);
  await openPlace(page, "customize", "channels");
  await page.locator('[data-act="ch-open"][data-v="imessage"]').getByText("Needs a Mac", { exact: true }).waitFor();
  assert.equal(await page.getByText("Two minutes to set up", { exact: false }).count(), 0);
  assert.deepEqual(errors, []);
});
