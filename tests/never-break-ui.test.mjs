/**
 * Never breaks, the owner's screens: the "Keep running" card in Settings → General (and, later in
 * this file, the Telegram setup card). A headless browser opens them the way a person does.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { openPlace } from "./places.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { proposeConfig } from "../dist/never-break/gateway-config.js";

async function served(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-never-ui-"));
  const dataDir = join(root, "data");
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir });
  const server = await startServer(app, { dataDir, port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  return { app, server, dataDir };
}
async function signedIn(t, server) {
  const { chromium } = await import("playwright");
  const call = (path, body) => fetch(new URL(path, server.url), { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }).then((r) => r.json());
  await call("/api/onboarding", { done: true });
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, serviceWorkers: "block" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  return { page, errors };
}

test("the settings can only be changed with the master key, and the gateway itself stays hidden from tasks", async (t) => {
  const { app, server } = await served(t);
  const call = (method, path, body, token = server.token) => fetch(server.url + path, { method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) }).then(async (r) => ({ status: r.status, body: await r.json() }));
  const shown = await call("GET", "/api/never-break");
  assert.equal(shown.status, 200);
  assert.equal(shown.body.mode, "off", "shipped off");
  const key = app.sessionTokens.create(app.runtime.owner, { scope: "run", minutes: 5 });
  const refused = await call("POST", "/api/never-break", { mode: "on" }, key.token);
  assert.equal(refused.status, 401);
  assert.match(refused.body.error, /cannot change how Branch keeps itself running/);
  assert.equal((await call("POST", "/api/never-break", { mode: "on" })).body.mode, "on");
  assert.equal(app.registry.inventory().some((tool) => tool.name === "gateway.propose"), false,
    "the suggesting tool is only offered when the switch was on at launch");
});

/* Redesign: the Keep running card is replaced by the prototype's Settings › Gateway page (public/app/settings/pages/
   gateway.js): the Off / When needed / On switch, and "A change Branch suggested" while the gateway is not off. The
   prototype draws "Use it" on every suggestion; a change that failed its try is refused by the engine and nothing
   changes. The window does not read the gateway-only health route (the status bar's gateway reads /api/never-break). */
test("Settings › Gateway: ships off, a change that failed its try cannot be used, and it fits 400 px", async (t) => {
  const { server, dataDir } = await served(t);
  await proposeConfig(dataDir, { holdSeconds: 3 }, "Shorter waits while the assistant restarts", async () => ({ ok: false, detail: "The engine did not come up." }));
  const { page, errors } = await signedIn(t, server);
  const gatewayAuthorizations = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/gateway/health")) gatewayAuthorizations.push(request.headers().authorization ?? "");
  });
  const view = () => fetch(server.url + "/api/never-break", { headers: { authorization: `Bearer ${server.token}` } }).then((r) => r.json());
  await page.locator('#side [data-act="view"][data-v="settings"]').click();
  await page.locator('[data-act="setpage"][data-v="gateway"]').click();
  await page.getByRole("heading", { name: "Gateway", exact: true }).waitFor();
  // One on/off switch: "when-needed" and "on" both run the gateway, so the window offers only on and off.
  await page.waitForFunction(() => { const sw = document.querySelector("#main #gw-mode"); return sw && !sw.disabled && !sw.checked; });
  assert.equal((await view()).mode, "off", "shipped off");
  assert.equal(await page.locator('#main [data-act="gw-mode"]').count(), 0, "no three-way left");
  assert.equal(await page.getByText("A change Branch suggested").count(), 0, "no suggestion while the gateway is off");

  await page.locator("#main #gw-mode").click();
  await page.waitForFunction(() => document.querySelector("#main #gw-mode")?.checked === true);
  // A native switch shows its new state at once; the engine's answer is what counts.
  for (let i = 0; i < 50 && (await view()).mode !== "on"; i++) await page.waitForTimeout(100);
  assert.equal((await view()).mode, "on", "the engine keeps the switch");
  const tile = page.locator("#main .tile").filter({ hasText: "A change Branch suggested" });
  await tile.waitFor();
  assert.match(await tile.textContent(), /Shorter waits while the assistant restarts/);
  assert.equal(await tile.getByText("passed").count(), 0, "a failed try is not shown as passed");
  await tile.getByRole("button", { name: "Use it", exact: true }).click();
  await page.locator(".toast").filter({ hasText: "cannot be used" }).waitFor();
  assert.ok((await view()).proposal, "a change that failed its try is not used");
  await tile.getByRole("button", { name: "Discard", exact: true }).click();
  await page.locator(".toast").filter({ hasText: "Discarded. Nothing changed." }).waitFor();
  await tile.waitFor({ state: "detached" });
  assert.equal((await view()).proposal ?? null, null);
  assert.deepEqual(gatewayAuthorizations, [], "a direct engine does not poll the gateway-only route");

  await page.setViewportSize({ width: 400, height: 800 });
  await page.waitForTimeout(300);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth));
  const wide = await page.evaluate(() => [...document.querySelectorAll("#main *")]
    .filter((node) => node.getClientRects().length && !node.closest(".sr-only, .set-nav") && (node.getBoundingClientRect().right > document.documentElement.clientWidth + 1))
    .map((node) => `${node.tagName} ${node.textContent.slice(0, 30)}`));
  assert.deepEqual(wide, []);
  assert.deepEqual(errors, []);
});

// Redesign: replaced by the new window (Settings › Gateway, checked above; its French words are Coming soon, the Language select sw:lang, checked at fc541c24).
test.skip("the Keep running card sits in Settings → General, works in French and fits 400 px", async (t) => {
  const { server, dataDir } = await served(t);
  await proposeConfig(dataDir, { holdSeconds: 3 }, "Shorter waits while the assistant restarts", async () => ({ ok: false, detail: "The engine did not come up." }));
  const { page, errors } = await signedIn(t, server);
  const gatewayAuthorizations = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/gateway/health"))
      gatewayAuthorizations.push(request.headers().authorization ?? "");
  });
  await page.evaluate(() => window.branchNeverBreak.refresh());
  assert.deepEqual(gatewayAuthorizations, [], "a direct engine does not poll the gateway-only route");
  await page.route("**/api/never-break", async (route) => {
    const response = await route.fetch();
    const view = await response.json();
    return route.fulfill({ response, json: { ...view, underGateway: true } });
  });
  await page.route("**/gateway/health", (route) => route.fulfill({
    status: 200, contentType: "application/json", body: '{"worker":{"state":"ready"},"restarts":0}',
  }));
  await page.evaluate(() => window.branchNeverBreak.refresh());
  assert.ok(gatewayAuthorizations.includes(`Bearer ${server.token}`), "the gateway health check uses the signed-in session");
  await openPlace(page, "settings:general");
  const card = page.locator("#never-break-card");
  await card.waitFor({ state: "attached" });
  assert.equal(await card.getAttribute("data-home"), "settings:general");
  await page.waitForFunction(() => document.getElementById("never-break-card")?.closest("#lx-page-general"));
  assert.equal(await page.locator("#never-break-mode").inputValue(), "off");
  assert.match(await card.textContent(), /Keep running through crashes and updates[\s\S]*without the gatekeeper[\s\S]*Shorter waits[\s\S]*cannot be used/);
  assert.equal(await card.locator("button:not(.quiet-button)").count(), 1, "one filled button");
  assert.equal(await card.getByRole("button", { name: "Use this change" }).isDisabled(), true, "a change that failed its try cannot be used");
  assert.equal(await card.locator("h2").count(), 1);

  await page.evaluate(async () => (await import("/i18n.js")).setLanguage("fr"));
  await page.waitForFunction(() => document.getElementById("never-break-card")?.textContent.includes("Continuer malgré les pannes"));
  await page.evaluate(async () => (await import("/i18n.js")).setLanguage("en"));

  await page.locator("#never-break-mode").selectOption("when-needed");
  await card.getByRole("button", { name: "Save this setting" }).click();
  await card.locator("[role=status]", { hasText: "Saved." }).first().waitFor();
  await card.getByRole("button", { name: "Discard this change" }).click();
  await page.waitForFunction(() => !document.getElementById("never-break-card")?.textContent.includes("Shorter waits"));

  await page.setViewportSize({ width: 400, height: 800 });
  await openPlace(page, "settings:general");
  await card.scrollIntoViewIfNeeded();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth));
  const wide = await page.evaluate(() => [...document.querySelectorAll("#never-break-card *")]
    .filter((node) => !node.closest(".sr-only") && (node.getBoundingClientRect().right > document.documentElement.clientWidth + 1 || node.scrollWidth > node.clientWidth + 1))
    .map((node) => `${node.tagName} ${node.textContent.slice(0, 30)}`));
  assert.deepEqual(wide, []);
  assert.deepEqual(errors, []);
});

/* ---------- Telegram, set up from a card (fake service, fake token) ---------- */

const fakeToken = `123456789:${"A".repeat(35)}`;
function fakeTelegram() {
  const sent = [];
  let delivered = false;
  const fetch = async (url, init) => {
    const method = String(url).split("/").pop();
    const body = init?.body && typeof init.body === "string" ? JSON.parse(init.body) : {};
    if (method === "getMe") return Response.json({ ok: true, result: { id: 1, is_bot: true, username: "owner_helper_bot" } });
    if (method === "getUpdates") {
      await new Promise((done) => setTimeout(done, 30));
      if (delivered || body.offset > 1) return Response.json({ ok: true, result: [] });
      delivered = true;
      return Response.json({ ok: true, result: [{ update_id: 1, message: { message_id: 1, text: "hello", from: { id: 42, username: "owner" }, chat: { id: 42, type: "private" } } }] });
    }
    if (method === "sendMessage") sent.push(body.text);
    return Response.json({ ok: true, result: { message_id: sent.length + 10 } });
  };
  return { fetch, sent };
}

test("the Telegram card keeps the token in the locker, connects the bot and pairs the owner", async (t) => {
  const { app, server } = await served(t);
  const call = (method, path, body) => fetch(server.url + path, { method,
    headers: { authorization: `Bearer ${server.token}`, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) }).then(async (r) => ({ status: r.status, text: await r.text() }));
  const first = JSON.parse((await call("GET", "/api/never-break/telegram")).text);
  assert.deepEqual([first.mode, first.tokenSaved, first.connected], ["off", false, false], "shipped off, nothing saved");
  const bad = await call("POST", "/api/never-break/telegram", { token: "not a token" });
  assert.equal(bad.status, 400);
  assert.match(JSON.parse(bad.text).error, /does not look like a bot token from BotFather/);
  const saved = await call("POST", "/api/never-break/telegram", { token: fakeToken, mode: "on" });
  assert.equal(saved.status, 200);
  assert.ok(!saved.text.includes(fakeToken), "the token is never sent back");
  assert.equal(JSON.parse(saved.text).tokenSaved, true);
  const kept = await app.store.secrets.resolve(app.runtime.owner, "default", ["TELEGRAM_BOT_TOKEN"], { purpose: "channel" });
  assert.equal(kept.TELEGRAM_BOT_TOKEN, fakeToken);

  const { connectGuidedTelegram } = await import("../dist/never-break/telegram-setup.js");
  const service = fakeTelegram();
  assert.equal(await connectGuidedTelegram({ store: app.store, owner: app.runtime.owner, router: app.channels, fetch: service.fetch }), null);
  const view = JSON.parse((await call("GET", "/api/never-break/telegram")).text);
  assert.deepEqual([view.connected, view.botName], [true, "owner_helper_bot"]);
  assert.match(await connectGuidedTelegram({ store: app.store, owner: app.runtime.owner, router: app.channels, fetch: service.fetch }), /already connected/,
    "one bot is never read twice");
  for (let i = 0; i < 200 && !service.sent.length; i++) await new Promise((done) => setTimeout(done, 20));
  const code = /code (\d{6})/.exec(service.sent[0] ?? "")?.[1];
  assert.ok(code, `the bot answered a stranger with a pairing code: ${service.sent[0]}`);
  assert.equal((await call("POST", "/api/channels/pairings/approve", { code })).status, 200);
  assert.equal(app.channels.summary().approved.length, 1, "the owner's account is paired");
});

// Redesign: replaced by the new window (the chat-app wizard, checked in channel-setup-ui; its check asks Telegram itself, which a test may not reach; the Language select sw:lang is Coming soon, checked at fc541c24).
test.skip("the Telegram card sits in Settings › Chat apps & devices, in plain words and in French, and fits 400 px", async (t) => {
  const { server } = await served(t);
  const { page, errors } = await signedIn(t, server);
  await openPlace(page, "settings:channels");
  const card = page.locator("#telegram-setup-card");
  await card.waitFor({ state: "attached" });
  assert.equal(await card.getAttribute("data-home"), "settings:channels");
  assert.match(await card.textContent(), /Set up Telegram[\s\S]*BotFather[\s\S]*\/newbot[\s\S]*six-digit code/);
  assert.equal(await card.locator("button:not(.quiet-button)").count(), 1, "one filled button");
  assert.equal(await page.locator("#telegram-setup-token").getAttribute("type"), "password");
  assert.equal(await page.locator("#telegram-setup-mode").inputValue(), "off");
  await page.locator("#telegram-setup-token").fill(`123456789:${"B".repeat(35)}`);
  await page.locator("#telegram-setup-mode").selectOption("when-needed");
  await card.getByRole("button", { name: "Save and connect" }).click();
  await card.locator("[role=status]", { hasText: "Saved." }).first().waitFor();
  assert.equal(await page.locator("#telegram-setup-token").inputValue(), "", "the token does not stay on screen");
  assert.match(await page.locator("#telegram-setup-token").getAttribute("placeholder"), /A token is saved/);
  await page.evaluate(async () => (await import("/i18n.js")).setLanguage("fr"));
  await page.waitForFunction(() => document.getElementById("telegram-setup-card")?.textContent.includes("Configurer Telegram"));
  await page.evaluate(async () => (await import("/i18n.js")).setLanguage("en"));
  await page.setViewportSize({ width: 400, height: 800 });
  await openPlace(page, "settings:channels");
  await card.scrollIntoViewIfNeeded();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth));
  const wide = await page.evaluate(() => [...document.querySelectorAll("#telegram-setup-card *")]
    .filter((node) => !node.closest(".sr-only") && (node.getBoundingClientRect().right > document.documentElement.clientWidth + 1 || node.scrollWidth > node.clientWidth + 1))
    .map((node) => `${node.tagName} ${node.textContent.slice(0, 30)}`));
  assert.deepEqual(wide, []);
  assert.deepEqual(errors, []);
});

/* ---------- integration review (17 September): pairing the owner's account ---------- */

test("a pairing code works once, only while fresh, never when shared, and not from a short-lived key", async (t) => {
  const { app, server } = await served(t);
  const call = (path, body, token = server.token) => fetch(server.url + path, { method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) })
    .then(async (r) => ({ status: r.status, body: await r.json() }));
  const pending = (sender, code, minutesAgo = 0) => app.store.save("settings", "local", `channel-pair:telegram:${sender}`,
    { status: "pending", code, name: sender, requestedAt: new Date(Date.now() - minutesAgo * 60_000).toISOString() });
  pending("stranger", "111111");
  const key = app.sessionTokens.create(app.runtime.owner, { scope: "run", minutes: 5 });
  const byKey = await call("/api/channels/pairings/approve", { code: "111111" }, key.token);
  assert.equal(byKey.status, 401);
  assert.match(byKey.body.error, /cannot let a new person reach the assistant/);

  pending("old", "222222", 120);
  assert.match((await call("/api/channels/pairings/approve", { code: "222222" })).body.error, /No pending request/, "a stale code is not taken");
  pending("twin-a", "333333"); pending("twin-b", "333333");
  assert.match((await call("/api/channels/pairings/approve", { code: "333333" })).body.error, /Two requests have that code/);
  const ok = await call("/api/channels/pairings/approve", { code: "111111" });
  assert.equal(ok.body.senderId, "stranger");
  assert.match((await call("/api/channels/pairings/approve", { code: "111111" })).body.error, /No pending request/, "used once");
  for (let i = 0; i < 9; i++) await call("/api/channels/pairings/approve", { code: String(400000 + i) });
  pending("late", "555555");
  assert.match((await call("/api/channels/pairings/approve", { code: "555555" })).body.error, /Too many wrong codes/, "guessing is slowed down");
});
