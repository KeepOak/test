/* The places, their tabs and the phone's bars, measured against the approved design (DG-140, DG-143, DG-174).
   Headless only, 127.0.0.1, a temporary data folder. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { readPolicy, savePolicy } from "../dist/policy.js";
import { pressUntil } from "./places.mjs";

const quiet = { name: "scripted", async complete() { return { content: "Hello.", toolCalls: [] }; } };

async function fixture(t, { width = 1440, height = 950 } = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-places-phone-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: quiet });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => {
    await browser.close();
    await server.close();
    await app.close();
    await discardTemp(root);
  });
  await fetch(new URL("/api/onboarding", server.url), {
    method: "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify({ done: true }),
  });
  const page = await browser.newPage({ viewport: { width, height }, hasTouch: width < 900 });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url, { timeout: 120000, waitUntil: "domcontentloaded" });
  await page.locator("body.lx-ready").waitFor({ state: "attached", timeout: 120000 });
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  const workspace = page.locator("#workspace");
  await pressUntil(page.getByRole("button", { name: "Connect", exact: true }),
    () => workspace.waitFor({ state: "visible", timeout: 120000 }).then(() => true, () => false), "the window to connect");
  return { page, errors };
}

/* ---------- the new window (public/app/**, design/redesign/prototype.html) ---------- */
/* Redesign: the prototype's Inbox tabs (tabsHtml) always carry Needs you's count, 0 included; the side list's Inbox
   carries the same number once something waits. */
const writing = { name: "scripted", async complete(request) {
  if (request.messages.at(-1)?.role === "tool") return { content: "Written.", toolCalls: [] };
  return { content: "", toolCalls: [{ id: "c1", name: "files.write", arguments: JSON.stringify({ path: "note.txt", content: "hi" }) }] };
} };
test("DG-140 (new window): the Inbox's Needs you tab carries the live count, the side list's own number", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-places-phone-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: writing });
  const policy = readPolicy(app.store, app.runtime.owner);
  savePolicy(app.store, app.runtime.owner, { ...policy, rules: [{ tool: "files.write", decision: "ask" }, ...policy.rules] });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  const call = (path, body) => fetch(new URL(path, server.url), { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }).then((r) => r.json());
  await call("/api/onboarding", { done: true });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 }, serviceWorkers: "block" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  const inbox = page.locator('#side [data-act="view"][data-v="inbox"]');
  const tabCount = page.locator('#main [data-act="ptab"][data-place="inbox"][data-v="needs"] .n');
  await inbox.click();
  assert.equal(await tabCount.innerText(), "0", "none waiting");
  assert.equal(await inbox.locator(".cnt").count(), 0, "and the side list says nothing");
  await page.locator('[data-act="newmenu"]').first().click();
  await page.locator('[data-act="newconv"]').first().click();
  await page.locator("#prompt").fill("write the note");
  await page.locator("#send").click();
  await page.locator("#live-ask").waitFor({ state: "visible", timeout: 30000 });
  await page.waitForFunction(() => document.querySelector('#side [data-act="view"][data-v="inbox"] .cnt')?.textContent === "1", undefined, { timeout: 30000 });
  await inbox.click();
  await page.waitForFunction(() => document.querySelector('#main [data-act="ptab"][data-place="inbox"][data-v="needs"] .n')?.textContent === "1", undefined, { timeout: 30000 });
  assert.equal(await tabCount.innerText(), await inbox.locator(".cnt").innerText(), "the same number as the side list's");
  assert.deepEqual(errors, []);
});

// Redesign: replaced by the new window (no places bar); French is Coming soon (sw:lang), checked at fc541c24.
test.skip("DG-143: the bar reads in French", async (t) => {
  const { page, errors } = await fixture(t, { width: 400, height: 844 });
  await page.evaluate(async () => { const { setLanguage } = await import("/i18n.js"); await setLanguage("fr"); });
  await page.waitForFunction(() => document.documentElement.lang === "fr");
  assert.equal(await page.locator('.ew-place[data-place="customize"] .ew-word').innerText(), "Personnaliser");
  assert.deepEqual(errors, []);
});

