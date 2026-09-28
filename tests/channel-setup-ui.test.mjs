/**
 * mac7/connect: the Set up panel as a person sees it, in a headless browser: its home in Customize,
 * Chat apps, the square codes, off by default, a refused paste, French, and 400 px wide. Nothing here
 * reaches a chat service: the only paste tried is refused before anything is asked.
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

async function signedIn(t, viewport = { width: 1280, height: 800 }) {
  const root = await mkdtemp(join(tmpdir(), "branch-connect-ui-"));
  const dataDir = join(root, "data");
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir });
  const server = await startServer(app, { dataDir, port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const call = (path, body) => fetch(new URL(path, server.url), { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }).then((r) => r.json());
  await call("/api/onboarding", { done: true });
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport, serviceWorkers: "block" });
  // The page picks the install line from userAgentData first and only then from the older
  // navigator.platform, so a stub that sets just the latter left the viewer as whatever the
  // machine running the tests happened to be: a Mac passed, Linux read its own Flatpak line.
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "platform", { get: () => "MacIntel" });
    Object.defineProperty(navigator, "userAgentData", { get: () => ({ platform: "macOS" }) });
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  // Nothing in these tests may leave this computer: any request the window makes elsewhere is stopped and noted.
  const outside = [];
  await page.route((url) => !["127.0.0.1", "localhost"].includes(url.hostname), (route) => { outside.push(route.request().url()); return route.abort(); });
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  return { page, errors, outside, call };
}

/** Customize › Channels, the way a person gets there; on a narrow window the list is slid open first. */
async function openChannels(page) {
  if (!(await page.locator("#app.side-open").count()) && (await page.evaluate(() => innerWidth <= 760))) await page.locator('[data-act="side"]').first().click();
  await page.locator('#side [data-act="view"][data-v="customize"]').click();
  await page.locator('#main [data-act="ptab"][data-place="customize"][data-v="channels"]').click();
  await page.locator('[data-act="ch-open"]').first().waitFor();
}
/** Opens one chat app's wizard from its tile. */
async function openWizard(page, id) {
  await page.locator(`[data-act="ch-open"][data-v="${id}"]`).click();
  await page.locator(".dlg .chw-steps12").waitFor();
}
const closeWizard = async (page) => { await page.locator('.dlg [data-act="dlg-close"]').first().click(); await page.locator(".dlg").waitFor({ state: "detached" }); };
const next = (page) => page.locator('.dlg [data-act="chw-next"]').click();

const tooWide = (page, selector) => page.evaluate((selector) => [...document.querySelectorAll(`${selector} *`)]
  .filter((node) => node.getClientRects().length && !node.closest(".sr-only") && (node.getBoundingClientRect().right > document.documentElement.clientWidth + 1 || node.scrollWidth > node.clientWidth + 1))
  .map((node) => `${node.tagName} ${node.textContent.slice(0, 30)}`), selector);

/* Redesign: the Set up card in Settings is replaced by the prototype's chat-app wizard (public/app/flows/chat.js), opened
   from each app's tile in Customize › Channels: Create, Paste, Check, Pair, Save. The card's install command lines, the
   iPhone/Android codes and the off/when-needed select are not in the prototype (one code, "Or scan to do this on your
   phone"; setting an app up here is asking for it, so the window switches guided setup on as it checks). What is still
   proved: every app is offered, guided setup ships off, the bot page and the square code, a secret is a password field,
   a server that is not https:// is refused by the engine, and a refused paste is never shown back or kept. */
test("the chat-app wizard: every app, ships off, the bot page and the code, and a refused paste is not shown back", async (t) => {
  const { page, errors, outside, call } = await signedIn(t);
  assert.equal((await call("/api/channel-setup")).mode, "off", "guided setup ships off");
  await openChannels(page);
  assert.equal(await page.locator('[data-act="ch-open"]').count(), 56);
  await openWizard(page, "telegram");
  const dlg = page.locator(".dlg");
  assert.equal(await dlg.locator(".dlg-h h2").textContent(), "Set up Telegram");
  assert.match(await dlg.textContent(), /BotFather opens with \/newbot/);
  assert.equal(await dlg.getByRole("link", { name: /Open Telegram/ }).getAttribute("href"), "https://t.me/BotFather?text=%2Fnewbot");
  assert.equal(await dlg.locator(".chw-qr12 svg").count(), 1, "the square code to do it on a phone");
  await next(page);
  assert.equal(await page.locator('[data-chf="TELEGRAM_BOT_TOKEN"]').getAttribute("type"), "password");
  await closeWizard(page);

  await openWizard(page, "slack");
  assert.match(await dlg.getByRole("link", { name: /Open Slack/ }).getAttribute("href"), /^https:\/\/api\.slack\.com\/apps\?new_app=1&manifest_json=/);
  assert.equal(await dlg.locator(".chw-qr12 svg").count(), 1, "Slack's plain page still gets a code");
  await closeWizard(page);

  await openWizard(page, "mastodon");
  assert.equal(await dlg.locator(".chw-create12 a.btn.pri").count(), 0, "no page until the server is typed");
  await next(page);
  await page.locator('[data-chf="server"]').fill("javascript:alert(1)");
  await page.locator('[data-chf="MASTODON_ACCESS_TOKEN"]').fill("abc");
  await next(page);
  await dlg.getByText("did not accept it").waitFor();
  assert.match(await dlg.textContent(), /must (be a full address starting with|start with) https:\/\//);
  assert.equal(await page.locator('a[href^="javascript:"]').count(), 0);
  await closeWizard(page);

  await openWizard(page, "telegram");
  await next(page);
  await page.locator('[data-chf="TELEGRAM_BOT_TOKEN"]').fill("not-a-token");
  const checked = page.waitForResponse((r) => r.url().includes("/api/channel-setup/telegram/check"));
  await next(page);
  assert.equal((await checked).status(), 400, "the engine refuses it before asking Telegram");
  await dlg.getByText("does not look right").waitFor();
  assert.ok(!(await page.content()).includes("not-a-token"), "a refused paste is not shown back");
  assert.equal(await page.evaluate(() => [...document.querySelectorAll("input")].some((i) => i.value.includes("not-a-token"))), false);
  assert.equal(((await call("/api/channels")).channels ?? []).some((c) => c.id === "telegram" || c.kind === "telegram"), false, "nothing was switched on");
  assert.deepEqual(outside, [], "nothing left this computer");
  assert.deepEqual(errors, []);
});

/* Redesign: the "More chat apps" rows and the separate Telegram card are replaced by the one grid of tiles in
   Customize › Channels (public/app/places/customize.js channelsTab); each tile opens the same wizard. */
test("each chat app's tile opens its own wizard, and the wizard fits 400 px, Slack's long lines too", async (t) => {
  const { page, errors, outside } = await signedIn(t);
  await openChannels(page);
  await page.locator('[data-act="ch-fam"][data-v="parity"]').click();
  await openWizard(page, "mastodon");
  assert.equal(await page.locator(".dlg .dlg-h h2").textContent(), "Set up Mastodon");
  await closeWizard(page);
  await page.locator('[data-act="ch-fam"][data-v="all"]').click();
  await openWizard(page, "telegram");
  assert.equal(await page.locator(".dlg .dlg-h h2").textContent(), "Set up Telegram");
  await closeWizard(page);

  await page.setViewportSize({ width: 400, height: 800 });
  await page.reload();
  await page.locator("#app #side").waitFor({ state: "attached", timeout: 120000 });
  await openChannels(page);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth));
  await openWizard(page, "slack");
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth));
  assert.deepEqual(await tooWide(page, ".dlg"), [], "Slack's long lines wrap");
  assert.deepEqual(outside, []);
  assert.deepEqual(errors, []);
});

// Redesign: Coming soon (sw:lang, the Language select in Settings › Appearance), checked at fc541c24.
test.skip("each More chat apps row and the Telegram card open the same panel, and it reads in French at 400 px", async (t) => {
  const { page, errors } = await signedIn(t);
  await openPlace(page, "settings:channels");
  const row = page.locator("#channels-more-list details").filter({ hasText: "Mastodon" }).first();
  await row.locator(".channel-setup-row").waitFor({ state: "attached" });
  await row.locator("summary").click();
  await row.getByRole("button", { name: "Set up" }).click();
  await page.locator("#channel-setup-panel-card[data-app=mastodon]").waitFor();
  assert.equal(await page.locator("#channel-setup-app").inputValue(), "mastodon");

  const telegram = page.locator("#telegram-setup-card");
  await telegram.locator("#channel-setup-panel-telegram").waitFor({ state: "attached" });
  assert.equal(await telegram.locator("button:not(.quiet-button)").count(), 1, "the Telegram card keeps one filled button");
  assert.equal(await page.locator("#telegram-setup-card").count(), 1, "no second Telegram card");

  await page.evaluate(async () => (await import("/i18n.js")).setLanguage("fr"));
  await page.waitForFunction(() => document.getElementById("channel-setup-card")?.textContent.includes("Configurer une appli de messagerie"));
  await page.locator("#channel-setup-panel-card").waitFor();
  assert.match(await page.locator("#channel-setup-card").textContent(), /Collez ceci dans un terminal[\s\S]*Ouvrir la page qui crée le bot/);
  assert.match(await page.locator("#channel-setup-card").textContent(), /Votre serveur ouvre/, "the recipe's own sentence in French");

  await page.setViewportSize({ width: 400, height: 800 });
  await openPlace(page, "settings:channels");
  await page.locator("#channel-setup-card").scrollIntoViewIfNeeded();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth));
  assert.deepEqual(await tooWide(page, "#channel-setup-card"), []);
  await page.evaluate(async () => (await import("/i18n.js")).setLanguage("en"));
  await page.locator("#channel-setup-app").selectOption("slack");
  await page.locator("#channel-setup-panel-card[data-app=slack]").waitFor();
  assert.deepEqual(await tooWide(page, "#channel-setup-card"), [], "Slack's long lines wrap");
  assert.deepEqual(errors, []);
});

/* ---------- the phone app's own panel (apps/mobile/web), with a stand-in for the phone ---------- */

test("the phone shows the same panel as links: the store for this phone and the bot page, at 400 px", async (t) => {
  const { createServer } = await import("node:http");
  const { readFile } = await import("node:fs/promises");
  const { extname } = await import("node:path");
  const { setupList, setupPanel } = await import("../dist/channel-setup/service.js");
  const store = { get: () => ({ data: { mode: "when-needed" } }) };
  const answers = { list: setupList(store, "local"), telegram: setupPanel(store, "local", "telegram"), bluesky: setupPanel(store, "local", "bluesky") };
  const WEB = join(import.meta.dirname, "..", "apps", "mobile", "web"), PUBLIC = join(import.meta.dirname, "..", "public");
  const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".woff2": "font/woff2" };
  const server = createServer(async (request, response) => {
    const path = decodeURIComponent(new URL(request.url, "http://x").pathname).replace(/^\/+/, "") || "index.html";
    for (const file of [join(WEB, path), join(PUBLIC, path)]) {
      let body;
      try { body = await readFile(file); } catch { continue; }
      return void response.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream" }).end(body);
    }
    response.writeHead(404).end();
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await new Promise((done) => server.close(done)); });
  const page = await browser.newPage({ viewport: { width: 400, height: 800 },
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript((answers) => {
    globalThis.posted = [];
    globalThis.branchPhoneFake = {
      async session() { return { paired: true, origin: "http://100.64.0.9:3210" }; },
      async request({ method, path, body }) {
        if (path === "/api/channel-setup") return { status: 200, data: answers.list };
        const panel = /^\/api\/channel-setup\/([a-z-]+)$/.exec(path);
        if (panel) return { status: 200, data: answers[panel[1]] };
        if (method === "POST") { globalThis.posted.push({ path, body }); return { status: 422, data: { error: "Telegram did not accept that (it answered 401)." } }; }
        return { status: 200, data: { attention: [] } };
      },
      async getSwitches() { return { switches: {} }; }, async setSwitches() {}, async switchesChanged() {},
      async look() { return { theme: "forest", mode: "dark" }; }, async lastSeen() { return { at: Date.now() }; },
      async takeShared() { return { items: [] }; }, async openBranch() {}, async notify() {}, async unlock() { return { unlocked: true }; },
      async deviceKey() { return null; }, async deviceStatus() { return { paired: false, never: [], canSign: true }; },
    };
  }, answers);
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  // The redesigned phone app (pass 8, apps/mobile/web/ph-settings.js) has the panel under More › Settings › Chat apps › <app>.
  const openApp = async (id) => {
    await page.locator('#tabs [data-v="more"]').click();
    await page.locator('[data-act="go"][data-v="settings"]').click();
    await page.locator('[data-act="go"][data-v="chatapps"]').click();
    await page.locator('[data-act="ph-chf"][data-v="all"]').click();
    await page.locator(`[data-act="ph-ch"][data-v="${id}"]`).click();
    await page.locator("#connect-body").waitFor({ state: "visible" });
  };
  await openApp("telegram");
  const card = page.locator("#connect-body");
  await card.locator("a").first().waitFor();
  assert.equal(answers.list.channels.length, 56, "every chat app the window offers is offered here");
  assert.equal(await card.getByRole("link", { name: "Get the app" }).getAttribute("href"), "https://apps.apple.com/app/id686449807", "the iPhone store on an iPhone");
  assert.equal(await card.getByRole("link", { name: "Make the bot" }).getAttribute("href"), "https://t.me/BotFather?text=%2Fnewbot");
  assert.equal(await page.locator("#connect-TELEGRAM_BOT_TOKEN").getAttribute("type"), "password");
  await page.locator("#connect-TELEGRAM_BOT_TOKEN").fill(`123456789:${"Q".repeat(35)}`);
  await page.locator("#connect-save").click();
  await page.locator("#connect-status", { hasText: "did not accept" }).waitFor();
  assert.deepEqual(await page.evaluate(() => globalThis.posted.map((post) => post.path)), ["/api/channel-setup/telegram/check"]);
  assert.equal(await page.locator("#connect-TELEGRAM_BOT_TOKEN").inputValue().then((value) => value.length), 45, "a refused token stays to be corrected");
  await page.locator('[data-act="back"]').first().click();
  assert.equal(await page.locator('[data-act="ph-ch"]').count(), 56, "the phone lists every chat app the window offers");
  await page.locator(`[data-act="ph-ch"][data-v="bluesky"]`).click();
  await page.locator("#connect-handle").waitFor();
  assert.equal(await card.getByRole("link", { name: "Make the bot" }).getAttribute("href"), "https://bsky.app/settings/app-passwords");
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth));
  assert.deepEqual(errors, []);
});

/* CHAT-147: an app set up here connects there and then, and the wizard says what really happened. Signal with a program
   that is not on this computer is the honest failure, and needs no network and runs nothing. The Save step offers the
   owner's Trunks with the default one chosen, never a "Branch" of its own. */
test("the wizard connects without a restart and says when it could not; who answers is a Trunk, never Branch", async (t) => {
  const { page, errors, outside, call } = await signedIn(t);
  await call("/api/trunks", { name: "Scout" });
  await call("/api/trunks", { name: "Ivy" });
  const trunks = await call("/api/trunks");
  await openChannels(page);
  await openWizard(page, "signal");
  const dlg = page.locator(".dlg");
  await next(page);
  await page.locator('[data-chf="path"]').fill("/nonexistent-branch-test/signal-cli");
  await page.locator('[data-chf="account"]').fill("+15551234567");
  await next(page);
  await dlg.getByText("Signal is saved but not connected").waitFor();
  assert.match(await dlg.textContent(), /nothing at \/nonexistent-branch-test\/signal-cli/, "the engine's own reason");
  assert.equal(((await call("/api/channels")).channels ?? []).some((c) => c.id === "signal"), false, "not reported as connected");
  assert.equal((await call("/api/channel-setup/signal")).setUpHere, true, "kept, so it connects at the next start");

  await next(page);
  const who = dlg.locator('[data-act="chw-who"]');
  assert.deepEqual(await who.allTextContents(), trunks.trunks.map((tr) => (tr.id === trunks.defaultId ? `${tr.name} · default` : tr.name)));
  // The owner's default Trunk (#594/#726, named "Branch Agent") is a Trunk like the others, so it is offered too; Branch itself never is.
  assert.deepEqual([...(await who.allTextContents())].map((text) => text.split(" · ")[0]).sort(), trunks.trunks.map((tr) => tr.name).sort(), "every Trunk, and only Trunks");
  assert.ok(trunks.trunks.some((tr) => tr.id === trunks.defaultId), "the default is one of the Trunks");
  const home = (trunks.trunks.find((tr) => tr.id === trunks.defaultId) ?? trunks.trunks[0]).name;
  assert.equal(await dlg.locator('[data-act="chw-who"][aria-pressed="true"]').textContent().then((text) => text.split(" · ")[0]), home, "the default Trunk is chosen");
  assert.equal(await dlg.getByRole("button", { name: "Branch", exact: true }).count(), 0, "no brand-voiced Branch conversation");

  await dlg.locator('[data-act="chw-remove"]').click();
  await page.getByText("Signal is disconnected").waitFor();
  assert.equal((await call("/api/channel-setup/signal")).setUpHere, false);
  assert.deepEqual(outside, [], "nothing left this computer");
  assert.deepEqual(errors, []);
});
