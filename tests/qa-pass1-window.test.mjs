/* QA pass 1 (the owner's stress-test stand-in, QA-2335): each finding driven in the real window against a real engine,
   plus the one place validation failures become words. Undo any fix and its test here goes red. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { validationText } from "../dist/request-errors.js";
import { waitInPage } from "./wait-in-page.mjs";

const HELLO = "Hello, I am the new Trunk and I help with research.";
/* A model that answers after a moment, so a new Trunk's hello lands after its conversation has opened. */
const slow = { name: "scripted", async complete() { await new Promise((done) => setTimeout(done, 1500)); return { content: HELLO, toolCalls: [] }; } };

async function engine(t) {
  const root = await mkdtemp(join(tmpdir(), "qa-pass1-"));
  const dataDir = join(root, "data");
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir, provider: slow });
  const server = await startServer(app, { dataDir, port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const call = async (path, body) => {
    const response = await fetch(new URL(path, server.url), { method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  };
  return { app, call, server };
}

/* The window in a browser. `link.down` makes every new request to the engine fail as a stopped engine's would (refused),
   which is what the window sees when Branch is not running; the engine itself keeps going, so it can change meanwhile. */
async function windowFor(t, { width = 1440, height = 900, done = true, before = null } = {}) {
  const { chromium } = await import("playwright");
  const f = await engine(t);
  if (done) await f.call("/api/onboarding", { done: true });
  if (before) await before(f);
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height }, serviceWorkers: "block" });
  const errors = [], link = { down: false };
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/**", (route) => (link.down ? route.abort("connectionrefused") : route.continue()));
  await page.goto(f.server.url);
  await page.getByLabel("Session token", { exact: true }).fill(f.server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  return { ...f, page, errors, link };
}
const ready = (page) => page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });

test("validation failures read as sentences: the field and what it needs, never Zod's words or the value sent", () => {
  const schema = z.object({ name: z.string().min(1), members: z.array(z.string()).min(2), rule: z.enum(["all", "lead"]), when: z.string().optional() }).strict();
  const said = validationText(schema.safeParse({ name: "", members: [], rule: "secret-value" }).error);
  assert.equal(said, '"name" cannot be empty. "members" needs at least 2 items. "rule" must be one of: all, lead.');
  assert.doesNotMatch(said, /Too small|expected|secret-value/);
  assert.equal(validationText(z.object({ when: z.string() }).safeParse({}).error), '"when" is missing.');
  assert.equal(validationText(z.object({ a: z.string() }).strict().safeParse({ a: "x", b: 1 }).error), '"b" is not an accepted field.');
  const own = z.object({ at: z.string().refine(() => false, "A daily time needs a timezone") });
  assert.equal(validationText(own.safeParse({ at: "x" }).error), "A daily time needs a timezone", "a schema's own sentence is kept");
  // A key the request chose itself (an unknown field, a record's key) can be a pasted secret: never said back.
  const secret = "sk-live-4f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c"; // not-a-real-secret
  const unknown = validationText(z.object({ a: z.string() }).strict().safeParse({ a: "x", [secret]: 1 }).error);
  assert.equal(unknown, "The request has a field that is not accepted.");
  const keyed = validationText(z.object({ env: z.record(z.string(), z.string().max(3)) }).safeParse({ env: { [secret]: "too long" } }).error);
  assert.doesNotMatch(keyed, /sk-live|too long/);
  assert.match(keyed, /^The request needs at most 3 characters\.$/);
  for (const value of [secret, { nested: secret }, [secret], 12345678901234])
    assert.doesNotMatch(validationText(z.object({ token: z.number().int().max(10) }).safeParse({ token: value }).error), /sk-live|12345678901234/);
});

test("Q011: a blank group chat waits for a name and two Trunks, and the engine's refusal is in plain words", async (t) => {
  const f = await windowFor(t);
  const refused = await f.call("/api/trunks/rooms", { name: "", members: [] });
  assert.equal(refused.status, 400);
  assert.doesNotMatch(refused.body.error, /Too small|expected string|>=/, refused.body.error);
  assert.match(refused.body.error, /"name" cannot be empty/);
  await ready(f.page);
  // With no Trunks yet Customize shows its empty state; the sidebar's + menu always offers a new room.
  await f.page.locator('[data-act="newmenu"]').click();
  await f.page.locator('[data-act="grp-new"]').first().click();
  const start = f.page.locator('.dlg [data-act="grp-make"]');
  await start.waitFor();
  assert.equal(await start.isDisabled(), true, "Start waits");
  assert.equal(await f.page.locator("#grp-need-name").isVisible(), true);
  assert.equal(await f.page.locator("#grp-need-two").isVisible(), true);
  await f.page.locator("#grp-name").fill("Study room");
  assert.equal(await f.page.locator("#grp-need-name").isVisible(), false, "the name's line goes once it has one");
  assert.equal(await start.isDisabled(), true, "still two Trunks short");
  assert.deepEqual(f.errors, []);
});

test("Q005: a new Trunk's conversation shows its hello where the owner is looking, with no reopening", async (t) => {
  const f = await windowFor(t);
  await ready(f.page);
  await f.page.locator('[data-act="newmenu"]').first().click();
  await f.page.locator('.pop [data-act="new-trunk"]').click();
  await f.page.locator("#conversation").getByText(HELLO).waitFor({ timeout: 20000 });
  assert.equal(await f.page.locator("#prompt").isEditable(), true, "the message box is ready");
});

test("Q006: engine stopped shows plain words and grey lights; back, it catches up without a reload", async (t) => {
  const f = await windowFor(t);
  await ready(f.page);
  f.link.down = true;
  await f.page.locator("#offline18").waitFor({ timeout: 20000 });
  assert.match(await f.page.locator("#offline18").innerText(), /isn't running/);
  assert.equal(await f.page.locator("#side .machine .dot.off").count(), 1, "This computer's light is off");
  await f.page.locator("#prompt").fill("are you there");
  await f.page.locator("#send").click();
  await f.page.waitForTimeout(1500);
  assert.doesNotMatch(await f.page.locator("#app").innerText(), /Failed to fetch|NetworkError|Load failed/);
  const made = await f.app.runtime.run({ prompt: "Catch-up check while the window was away" });
  assert.ok(made.sessionId);
  f.link.down = false;
  await f.page.locator("#offline18").waitFor({ state: "detached", timeout: 30000 });
  await f.page.locator("#side").getByText("Catch-up check while the window was away").first().waitFor({ timeout: 20000 });
  assert.equal(await f.page.locator("#side .machine .dot.off").count(), 0, "and the light is on again");
});

/* The owner's report after a Beta update: a raw "Failed to fetch" toast while Branch restarted. The engine is really stopped
   (closed, then started again on the same port and data), controls are pressed meanwhile, and no toast ever carries the
   browser's words; back, the window carries on in the same page. An install the window started says nothing at all. */
test("offline anywhere: a stopped engine never shows the browser's words; back, the same page carries on; an install is quiet", async (t) => {
  const { chromium } = await import("playwright");
  const root = await mkdtemp(join(tmpdir(), "qa-pass1-stop-"));
  const dataDir = join(root, "data"), workspace = join(root, "workspace");
  const up = { app: await createBranch({ workspace, dataDir, provider: slow }) };
  up.server = await startServer(up.app, { dataDir, port: 0 });
  t.after(async () => { await up.server?.close(); await up.app?.close(); await discardTemp(root); });
  const port = Number(new URL(up.server.url).port), token = up.server.token;
  const stop = async () => { const { server, app } = up; up.server = up.app = null; await server.close(); await app.close(); };
  const start = async () => { up.app = await createBranch({ workspace, dataDir, provider: slow }); up.server = await startServer(up.app, { dataDir, port }); }; // same-port-restart: the port port: 0 gave above
  await fetch(new URL("/api/onboarding", up.server.url), { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ done: true }) });
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
  await page.addInitScript(() => {
    window.toastsSeen = [];
    new MutationObserver(() => { for (const el of document.querySelectorAll(".toast")) window.toastsSeen.push(el.textContent); })
      .observe(document, { childList: true, subtree: true, characterData: true });
  });
  await page.goto(up.server.url);
  await page.getByLabel("Session token", { exact: true }).fill(token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await ready(page);
  await page.evaluate(() => { window.samePage = true; });

  await stop();
  await page.locator("#offline18").waitFor({ timeout: 30000 });
  for (const place of ["overview", "inbox", "automations", "library"]) {
    await page.locator(`.side-nav [data-v="${place}"]`).click();
    await page.waitForTimeout(400);
  }
  await page.locator('.side-nav [data-v="overview"]').click();
  await page.locator('[data-act="lock"]').click().catch(() => undefined);
  await page.locator('[data-act="pauseall"]').click().catch(() => undefined);
  await page.waitForTimeout(1500);
  const whileAway = await page.evaluate(() => window.toastsSeen);
  assert.equal(whileAway.filter((words) => /fetch|NetworkError|Load failed|abort/i.test(words)).length, 0, whileAway.join(" | "));
  assert.doesNotMatch(await page.locator("#app").innerText(), /Failed to fetch|NetworkError|Load failed/);

  await start();
  await page.locator("#offline18").waitFor({ state: "detached", timeout: 40000 });
  const made = await up.app.runtime.run({ prompt: "Back after a real stop" });
  assert.ok(made.sessionId);
  await page.locator("#side").getByText("Back after a real stop").first().waitFor({ timeout: 30000 });
  assert.equal(await page.evaluate(() => window.samePage), true, "no reload");

  // An install the window started (core/api.js goingAway): the swap screen covers the restart, so nothing is said.
  await page.evaluate(async () => (await import("/app/core/api.js")).goingAway());
  const before = (await page.evaluate(() => window.toastsSeen)).length;
  await stop();
  await page.waitForTimeout(4000);
  assert.equal(await page.locator("#offline18").count(), 0, "no offline notice during an install");
  await start();
  await waitInPage(page, async () => (await import("/app/core/api.js")).link.up && !(await import("/app/core/api.js")).link.quiet, null, { timeout: 40000 });
  const after = await page.evaluate(() => window.toastsSeen);
  assert.equal(after.slice(before).filter((words) => /fetch|NetworkError|Load failed|abort|isn't running/i.test(words)).length, 0, after.join(" | "));
  assert.equal(await page.evaluate(() => window.samePage), true);
});

test("Q013: new Trunks and rooms start on what new conversations start on, never looser; Overview names that one mode", async (t) => {
  const f = await windowFor(t);
  const modeOf = async (sessionId) => (await f.call(`/api/conversation-mode?sessionId=${sessionId}`)).body.mode;
  const mode = (await f.call("/api/conversation-mode")).body;
  // Owner ruling 2026-09-30: new conversations start on Full access.
  assert.equal(mode.newConversation, "full");
  const one = (await f.call("/api/trunks", { name: "Scout" })).body.trunk, two = (await f.call("/api/trunks", { name: "Ledger" })).body.trunk;
  assert.equal(await modeOf(one.chatSessionId), "full", "a new Trunk's own conversation starts on Full access, as the chip says");
  const room = (await f.call("/api/trunks/rooms", { name: "Price check", members: [one.id, two.id] })).body.room;
  assert.equal(await modeOf(room.sessionId), "ask", "a new room is a group, so it starts on Ask first");
  for (const session of Object.values(room.memberSessions))
    assert.equal(f.app.runtime.modeFollows(session), room.sessionId, "and each Trunk's side of the room is held to the room's mode");
  // The owner's own setting is the ceiling: under Read only a new Trunk follows it (a mode of Full access would be looser).
  assert.equal((await f.call("/api/policy", { preset: "read-only" })).status, 200);
  const three = (await f.call("/api/trunks", { name: "Quiet" })).body.trunk;
  assert.equal(await modeOf(three.chatSessionId), null);
  assert.equal((await f.call("/api/policy", { preset: "off", confirmLoosening: true })).status, 200);

  await ready(f.page);
  await f.page.locator('.side-nav [data-v="overview"]').click();
  const tile = f.page.locator("section.tile", { has: f.page.locator('[data-act="setgo"][data-v="permissions"]') });
  await f.page.waitForFunction(() => [...document.querySelectorAll("section.tile p")].some((p) => /^Mode: Full access/.test(p.textContent.trim())), null, { timeout: 15000 });
  const words = await tile.locator("p").first().innerText();
  assert.doesNotMatch(words, /No approvals/, "one mode, the one everything new starts on");
  const lock = tile.locator('[data-act="lock"]');
  assert.equal(await lock.getAttribute("aria-pressed"), "false");
  await lock.click();
  await f.page.waitForFunction(() => document.querySelector('section.tile [data-act="lock"]')?.getAttribute("aria-pressed") === "true", null, { timeout: 15000 });
  assert.equal((await lock.innerText()).trim(), "Turn Lockdown off");
  assert.match(await tile.locator("p").first().innerText(), /^Mode: Lockdown/);
});

test("Q014: Ctrl K finds every place, Team included, and every Settings page", async (t) => {
  const f = await windowFor(t);
  await ready(f.page);
  await f.page.keyboard.press("Control+k");
  const box = f.page.locator("#pal-in");
  await box.waitFor();
  const labels = await f.page.evaluate(async () => {
    const shell = await import("/app/shell/shell.js"), settings = await import("/app/settings/settings.js"), words = await import("/app/core/words.js");
    return [...shell.PLACES.map(([, , l]) => words.say(l)), ...settings.NAV.flatMap((g) => g[1]).map(([, l]) => words.say(l))];
  });
  assert.ok(labels.includes("Team"));
  for (const label of labels) {
    await box.fill(label);
    const found = await f.page.locator("#pal-list .mi .mi-t").allInnerTexts();
    assert.ok(found.some((x) => x.trim() === label), `Ctrl K finds ${label}`);
  }
});

test("Q015: Shift+Tab in the message box moves to the next mode, and the cursor stays", async (t) => {
  const f = await windowFor(t);
  await ready(f.page);
  const says = (words) => f.page.waitForFunction((w) => document.querySelector('#composer [data-act="modemenu2"]')?.textContent.trim() === w, words, { timeout: 10000 });
  await says("Full access"); // owner ruling 2026-09-30: new conversations start on Full access
  await f.page.locator("#prompt").focus();
  await f.page.keyboard.press("Shift+Tab");
  await says("Auto");
  assert.equal(await f.page.evaluate(() => document.activeElement?.id), "prompt", "the cursor stays in the box");
});

test("Q016: every tour stop's card is whole on screen at 1440 and at 390", async (t) => {
  for (const [width, height] of [[1440, 900], [390, 844]]) {
    const f = await windowFor(t, { width, height });
    await ready(f.page);
    await f.page.keyboard.press("Control+k");
    await f.page.locator("#pal-in").fill("tour");
    await f.page.keyboard.press("Enter");
    await f.page.locator(".tour-card").waitFor({ timeout: 15000 });
    let shown = null;
    for (let stop = 0; stop < 40 && await f.page.locator(".tour-layer").count(); stop++) {
      // A stop is measured once its card has come to rest: a new stop, and the same place for five frames running (the
      // card moves to its part and the part is scrolled into view first).
      await f.page.waitForFunction((was) => {
        const card = document.querySelector(".tour-card");
        if (!card) return true;
        const n = card.querySelector(".n")?.textContent ?? "";
        if (n === was) return false;
        const r = card.getBoundingClientRect(), key = [n, r.left, r.top, r.right, r.bottom].join();
        const settle = (globalThis.__tourSettle ??= { key: "", frames: 0 });
        if (settle.key === key) settle.frames += 1; else Object.assign(settle, { key, frames: 0 });
        return settle.frames >= 5;
      }, shown, { timeout: 10000 });
      if (!await f.page.locator(".tour-card").count()) break;
      const at = await f.page.evaluate(() => {
        const r = document.querySelector(".tour-card").getBoundingClientRect(), s = document.querySelector(".tour-spot");
        const q = s.classList.contains("none") ? null : s.getBoundingClientRect();
        return { card: [r.left, r.top, r.right, r.bottom], spot: q && [q.left, q.top, q.right, q.bottom], n: document.querySelector(".tour-card .n")?.textContent };
      });
      const inside = ([l, tp, r, b]) => l >= 0 && tp >= 0 && r <= width && b <= height;
      assert.ok(inside(at.card), `${width}: the card of ${at.n} is on screen (${at.card})`);
      if (at.spot) assert.ok(at.spot[3] > 0 && at.spot[1] < height && at.spot[2] > 0 && at.spot[0] < width, `${width}: the part of ${at.n} is on screen (${at.spot})`);
      shown = at.n;
      await f.page.keyboard.press("ArrowRight");
    }
  }
});

test("Q017: a daily schedule is listed as every day, not as its next run's weekday", async (t) => {
  const f = await windowFor(t, { before: async (e) => {
    const { proposal } = (await e.call("/api/schedules/propose", { edit: { prompt: "tell me the weather", dailyAt: "08:00" }, timezone: "UTC" })).body;
    assert.equal((await e.call("/api/schedules", proposal.schedule)).status, 200);
  } });
  await ready(f.page);
  await f.page.locator('.side-nav [data-v="automations"]').click();
  const row = f.page.locator(".prow", { hasText: "tell me the weather" }).first();
  await row.waitFor({ timeout: 15000 });
  assert.match(await row.locator("small").first().innerText(), /^Every day at 8:00\sAM/);
});

test("Q004: in setup, a service on this computer opens the local-model picker over setup", async (t) => {
  const f = await windowFor(t, { done: false });
  await f.call("/api/onboarding", { trust: true, step: "models" });
  await f.page.reload();
  const add = f.page.locator('[data-act="addacct"]').first();
  await add.waitFor({ timeout: 60000 });
  await add.click();
  const local = f.page.locator('.dlg [data-act="aa-local"]').first();
  await local.waitFor({ timeout: 15000 });
  await local.click();
  await f.page.locator(".dlg .lp").waitFor({ timeout: 10000 });
  assert.equal(await f.page.locator('.dlg [data-act="aa-local"]').count(), 0, "the account list gave way to the picker");
  assert.equal(await add.isVisible(), true, "setup is still open behind it");
  assert.deepEqual(f.errors, []);
});
