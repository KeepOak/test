import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBranch } from "../dist/index.js";
import { discardTemp } from "./temp-dir.mjs";
import { brain, fixture } from "./trunks-helpers.mjs";
import { startServer } from "../dist/server.js";
import { saveOnboarding } from "../dist/onboarding.js";

test("the window uses the default face, edits live files, changes default and lists its threads", async (t) => {
  const { app, root } = await fixture(t);
  saveOnboarding(app.store, app.runtime.owner, { done: true });
  const home = app.trunks.ensureDefault(), other = app.trunks.create({ name: "Other" });
  await app.trunks.introduced();
  const thread = await app.runtime.run({ prompt: "window default thread", trunkId: home.id });
  const server = await startServer(app, { dataDir: root, port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); });
  const page = await browser.newPage({ serviceWorkers: "block" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible" });
  assert.equal(await page.locator(".empty-chat [src*=branch-wave]").count(), 0);
  // trunk-one-row: the thread is the default Trunk's newest conversation, so the Trunk's one row opens it.
  const threadRow = page.locator(`#side [data-act="chat"][data-line="${home.id}"]`);
  await threadRow.waitFor({ state: "visible" });
  assert.equal(await threadRow.getAttribute("data-id"), thread.sessionId);
  assert.equal(await threadRow.locator("b .ellip14").textContent(), home.name);
  await page.locator('[data-act="view"][data-v="customize"]').first().click();
  await page.locator(`[data-act="edit"][data-id="${home.id}"]`).click();
  await page.getByRole("tab", { name: "Files", exact: true }).click();
  // TRUNK-021: the Files tab follows the level chosen in Settings: Regular shows SOUL and USER, and says where the rest are.
  const shownFiles = () => page.locator("[data-personality-file]").evaluateAll((nodes) => nodes.map((node) => node.dataset.personalityFile));
  await page.locator('[data-personality-file="USER.md"]').waitFor();
  assert.deepEqual(await shownFiles(), ["SOUL.md", "USER.md"]);
  assert.equal(await page.getByText("More personality files are available in Advanced and Technical.").count(), 1);
  const file = page.locator('[data-personality-file="USER.md"]');
  await file.fill("Window preferences TEST-WINDOW-6512");
  const saved = page.waitForResponse((response) => response.url().endsWith(`/api/trunks/${home.id}/files`) && response.request().method() === "POST");
  await page.locator('[data-act="trunk-file-save"][data-name="USER.md"]').click();
  assert.equal((await saved).status(), 200);
  assert.equal(app.trunks.files.view(home.id).files.find((entry) => entry.name === "USER.md").text, "Window preferences TEST-WINDOW-6512");
  // Technical shows all seven, and what was saved at Regular is still there.
  await page.evaluate(() => import("/app/core/state.js").then((state) => { state.S.level = "technical"; }));
  await page.getByRole("tab", { name: "Look", exact: true }).click();
  await page.getByRole("tab", { name: "Files", exact: true }).click();
  await page.locator('[data-personality-file="HEARTBEAT.md"]').waitFor();
  assert.equal((await shownFiles()).length, 7);
  assert.equal(await page.locator('[data-personality-file="USER.md"]').inputValue(), "Window preferences TEST-WINDOW-6512");
  await page.locator('[data-act="dlg-close"]').last().click();
  const changed = page.waitForResponse((response) => response.url().endsWith(`/api/trunks/${other.id}/default`));
  await page.locator(`[data-act="trunk-default"][data-id="${other.id}"]`).click();
  assert.equal((await changed).status(), 200);
  assert.equal(app.trunks.defaultTrunk().id, other.id);
  assert.deepEqual(errors, []);
});

test("after an update, the sidebar lists every stray conversation under the default Trunk, and a hand-made Trunk under its own", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-default-window-"));
  const closing = [];
  t.after(async () => { for (const close of closing.reverse()) await close(); await discardTemp(root); });
  const open = (data) => createBranch({ workspace: join(root, "workspace"), dataDir: join(root, data), provider: brain() });
  // ---- a Branch from before threads: setup skipped, a hand-made Trunk, stray conversations ----
  const before = await open("data");
  saveOnboarding(before.store, before.runtime.owner, { done: true, skipped: true });
  const stray = [await before.runtime.run({ prompt: "hey" }), await before.runtime.run({ prompt: "please remember this" })];
  const kite = before.trunks.create({ name: "Kite" });
  await before.trunks.introduced();
  before.store.sqlite.exec("DELETE FROM trunk_threads; DELETE FROM governance WHERE id='trunk-default' OR id GLOB 'trunk-files:*'");
  await before.close();
  // ---- this build starts on it ----
  const app = await open("data");
  closing.push(() => app.close());
  const home = app.trunks.ownerDefault();
  assert.notEqual(home.id, kite.id);
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const browser = await chromium.launch({ headless: true });
  closing.push(() => server.close(), () => browser.close());
  const page = await browser.newPage({ serviceWorkers: "block" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible" });
  // trunk-one-row: the moved conversations are the default Trunk's, in its one row and its one timeline.
  const homeRow = page.locator(`#side [data-act="chat"][data-line="${home.id}"]`);
  await homeRow.waitFor({ state: "visible" });
  for (const run of stray) assert.equal(await page.locator(`#side [data-act="chat"][data-id="${run.sessionId}"]:not([data-line])`).count(), 0, "no row of its own");
  assert.equal(await page.locator(`#side [data-act="chat"][data-line="${kite.id}"]`).getAttribute("data-id"), kite.chatSessionId, "the hand-made Trunk keeps its own chat");
  assert.equal(await page.locator('#side [data-act="chat"][data-id]:not([data-line])').count(), 0, "no conversation is left loose");
  await homeRow.click();
  for (const words of ["hey", "please remember this"]) await page.locator("#scroll .u", { hasText: words }).first().waitFor();
  assert.deepEqual(errors, []);
});

test("QA Pass 2: the default Trunk's own conversation opens with its greeting, headed as the list, not by its name twice", async (t) => {
  const { app, root } = await fixture(t);
  saveOnboarding(app.store, app.runtime.owner, { done: true });
  const home = app.trunks.ensureDefault();
  const server = await startServer(app, { dataDir: root, port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); });
  const page = await browser.newPage({ serviceWorkers: "block" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  const row = page.locator(`#side [data-act="chat"][data-id="${home.chatSessionId}"]`);
  await row.waitFor({ state: "visible" });
  // trunk-one-row: the Trunk is its row; no heading repeats its name above it.
  assert.equal(await row.getAttribute("data-line"), home.id);
  assert.deepEqual((await page.locator("#side .lh").allTextContents()).map((h) => h.trim()).filter((h) => h === home.name), [], "the heading says what the list is, not the Trunk's name above a row of the same name");
  await row.click();
  await page.locator("#main").getByText(`Hi, I'm ${home.name}.`, { exact: false }).first().waitFor();
  assert.deepEqual(errors, []);
});
