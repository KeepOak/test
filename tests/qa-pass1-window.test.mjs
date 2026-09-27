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
});

test("Q011: a blank group chat waits for a name and two Trunks, and the engine's refusal is in plain words", async (t) => {
  const f = await windowFor(t);
  const refused = await f.call("/api/trunks/rooms", { name: "", members: [] });
  assert.equal(refused.status, 400);
  assert.doesNotMatch(refused.body.error, /Too small|expected string|>=/, refused.body.error);
  assert.match(refused.body.error, /"name" cannot be empty/);
  await ready(f.page);
  await f.page.locator('.side-nav [data-v="customize"]').click();
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

test("Q013: Overview names what new conversations start on, and the owner's setting as that", async (t) => {
  const f = await windowFor(t);
  const mode = (await f.call("/api/conversation-mode")).body;
  assert.equal(mode.newConversation, "ask");
  await ready(f.page);
  await f.page.locator('.side-nav [data-v="overview"]').click();
  await f.page.waitForFunction(() => /New conversations start on/.test(document.querySelector(".ov-mode18")?.textContent ?? ""), null, { timeout: 15000 });
  const words = await f.page.locator(".ov-mode18").innerText();
  assert.match(words, /New conversations start on Ask first/);
  assert.ok(words.includes(`still ${mode.following.label}`), words);
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
  await says("Ask first");
  await f.page.locator("#prompt").focus();
  await f.page.keyboard.press("Shift+Tab");
  await says("Plan first");
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
    for (let stop = 0; stop < 40 && await f.page.locator(".tour-layer").count(); stop++) {
      await f.page.waitForTimeout(300);
      const at = await f.page.evaluate(() => {
        const r = document.querySelector(".tour-card").getBoundingClientRect(), s = document.querySelector(".tour-spot");
        const q = s.classList.contains("none") ? null : s.getBoundingClientRect();
        return { card: [r.left, r.top, r.right, r.bottom], spot: q && [q.left, q.top, q.right, q.bottom], n: document.querySelector(".tour-card .n")?.textContent };
      });
      const inside = ([l, tp, r, b]) => l >= 0 && tp >= 0 && r <= width && b <= height;
      assert.ok(inside(at.card), `${width}: the card of ${at.n} is on screen (${at.card})`);
      if (at.spot) assert.ok(at.spot[3] > 0 && at.spot[1] < height && at.spot[2] > 0 && at.spot[0] < width, `${width}: the part of ${at.n} is on screen (${at.spot})`);
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
