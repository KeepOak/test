/**
 * Q75: the person cards under "People who share this computer" show what Branch really holds each
 * person to. A group can narrow someone's projects and daily limit below what the owner saved for
 * them, and the card must show the narrowed ones, as the People page already does.
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
import { openSettingsPage } from "./settings-window.mjs";

test("a person's card shows the projects and daily limit their group holds them to", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-q75-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const headers = { authorization: `Bearer ${server.token}`, "content-type": "application/json" };
  const post = async (path, body) => {
    const response = await fetch(server.url + path, { method: "POST", headers, body: JSON.stringify(body) });
    assert.equal(response.status, 200, `${path}: ${await response.clone().text()}`);
    return response.json();
  };
  const person = app.store.profiles.create({ name: "Alice", pin: "1234" });
  app.runtime.roles.save(person.id, { role: "adult", projects: [], dailySpendLimit: 0 });
  await post("/api/people/groups", { name: "Weekdays", members: [person.id], projects: ["homework"], dailySpendLimit: 10 });

  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await post("/api/onboarding", { done: true });
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click({ noWaitAfter: true });
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  // Redesign: the person cards are Settings › People in the new window (public/app/settings/pages/people.js): pick the
  // person, and their card lists the projects and the allowance the engine holds them to (roles[].effective).
  await openSettingsPage(page, "people");
  await page.locator(`.set-col [data-act="p-sel"][data-v="${person.id}"]`).click();
  const card = page.locator(".set-col .pcard10", { hasText: "Alice" });
  await card.waitFor({ timeout: 30000 });
  const facts = await card.locator("dl.kv").evaluate((list) => Object.fromEntries([...list.querySelectorAll("dt")]
    .map((term) => [term.textContent.trim(), term.nextElementSibling?.textContent.trim()])));
  assert.equal(facts.Projects, "homework", "the group's project, not every project");
  assert.equal(facts["Daily allowance"], "$10 a day", "the group's daily limit, not none");
  assert.deepEqual(errors, []);
});

test("the card payload gives somebody switched in only their own grant, and the owner everyone's", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-q75-own-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const headers = { authorization: `Bearer ${server.token}`, "content-type": "application/json" };
  const call = async (path, body) => (await fetch(server.url + path, body === undefined ? { headers } : { method: "POST", headers, body: JSON.stringify(body) })).json();
  const alice = app.store.profiles.create({ name: "Alice", pin: "1234" });
  const bob = app.store.profiles.create({ name: "Bob", pin: "5678" });
  const owner = (await call("/api/collab")).profile.roles.map((entry) => entry.profileId).sort();
  assert.deepEqual(owner, [alice.id, bob.id].sort());
  await call("/api/profiles/switch", { profileId: alice.id, pin: "1234" });
  // Q261: reading fails closed for a household person at the window, and the window never reads /api/collab; the card
  // it draws reads GET /api/profiles, which gives Alice only her own grant.
  assert.match((await call("/api/collab")).error, /belongs to the owner/);
  const own = (await call("/api/profiles")).roles.filter((entry) => entry.effective).map((entry) => entry.profileId);
  assert.deepEqual(own, [alice.id], "Alice does not see Bob's grant");
});
