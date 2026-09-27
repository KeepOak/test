/* Everything that moves falls asleep when it is left alone, and wakes when you come back (core/sleep.js). A face sleeps
   two minutes after it was last in focus (its conversation open while you use the window, or its row hovered) and, when
   its conversation is not open, lies still twenty seconds later; the
   window's own motion two minutes after your last input, and after ten minutes every sleeping loop holds still. A face
   at work never sleeps. Headless, against 127.0.0.1, with the page's clock moved forward (Playwright clock). */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

const MIN = 60 * 1000;

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-sleep-"));
  let release = () => {};
  const held = new Promise((resolve) => { release = resolve; });
  /* A reply that "Busy" asks for is held until the test ends, so its task stays running. */
  const provider = { name: "scripted", async complete(request) {
    if (JSON.stringify(request.messages ?? request).includes("keep working")) await held;
    return { content: "Done.", toolCalls: [] };
  } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { release(); await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const call = (path, body) => fetch(new URL(path, server.url), {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).then((response) => response.json());
  await call("/api/onboarding", { done: true });
  await call("/api/trunks/switch", { part: "trunks", mode: "on" });
  const trunks = {};
  for (const [name, character] of [["Ledger", "ember"], ["Scout", "kite"], ["Busy", "tide"], ["Quill", null]]) {
    const { trunk } = await call("/api/trunks", { name, description: "Helps" });
    if (character) await call(`/api/trunks/${trunk.id}`, { character });
    trunks[name] = trunk;
  }
  await call("/api/delight/settings", { pets: { on: true, kind: "fennec" }, background: { on: true } });
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 }, reducedMotion: "no-preference", serviceWorkers: "block" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.clock.install();
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  await page.locator("#side .keeper .petbox").waitFor({ state: "attached" });
  const work = () => { app.runtime.run({ prompt: "keep working", sessionId: trunks.Busy.chatSessionId }).catch(() => {}); };
  return { page, errors, trunks, work };
}

const face = (page, trunk) => page.locator(`#side [data-rk="t:${trunk.id}"]`).first();
const loopOf = (page, trunk) => face(page, trunk).evaluate((el) => el.querySelector("video")?.getAttribute("src") ?? el.querySelector("img")?.getAttribute("src") ?? "");
const playing = (page) => page.evaluate(() => [...document.querySelectorAll("video")].filter((v) => !v.paused).length);
const open = (page, trunk) => page.evaluate((id) => document.querySelector(`#side [data-id="${id}"]`)?.click(), trunk.chatSessionId);
/* Waits (no fixed sleep) until a face's loop matches, and, with still, until that loop is paused. */
const settled = (page, trunk, pattern, still = false) => page.waitForFunction(([id, source, still]) => {
  const el = document.querySelector(`#side [data-rk="t:${id}"]`), v = el?.querySelector("video");
  const src = v?.getAttribute("src") ?? el?.querySelector("img")?.getAttribute("src") ?? "";
  return new RegExp(source).test(src) && (!still || !!v?.paused);
}, [trunk.id, pattern.source, still]);
/* The owner at the window: a pointer move now and then. */
async function busy(page, ms) {
  for (let t = 0; t < ms; t += 30000) { await page.mouse.move(600 + (t / 30000) % 50, 500); await page.clock.fastForward(30000); }
}

test("left alone, every face, the pet and the scene fall asleep; after ten minutes nothing plays", async (t) => {
  const { page, errors, trunks } = await fixture(t);
  await page.clock.fastForward(2 * MIN + 5000);
  await page.waitForFunction(() => document.documentElement.classList.contains("doze18") && !!document.querySelector("#side .petbox.zz11"));
  await settled(page, trunks.Ledger, /ember\/sleep/);
  assert.match(await loopOf(page, trunks.Ledger), /ember\/sleep/, "a character plays its sleeping loop");
  assert.equal(await face(page, trunks.Ledger).evaluate((el) => el.classList.contains("rest18")), true);
  assert.equal(await page.locator("#side .petbox.zz11").count(), 1, "the pet naps");
  assert.equal(await page.locator("#bgLayer .paint11").evaluate((el) => el.getAnimations().every((a) => a.playState === "paused")), true, "the scene's drift holds");
  await page.clock.fastForward(8 * MIN + 5000);
  await page.waitForFunction(() => document.documentElement.classList.contains("still18")
    && [...document.querySelectorAll("video")].every((v) => v.paused) && !document.getAnimations().some((a) => a.playState === "running"));
  assert.equal(await playing(page), 0, "no loop plays after the long sleep");
  assert.equal(await page.evaluate(() => document.getAnimations().filter((a) => a.playState === "running").length), 0, "no CSS animation runs");
  assert.deepEqual(errors, []);
});

test("only the open conversation's Trunk stays awake while you use the window; hovering a row wakes its face", async (t) => {
  const { page, errors, trunks } = await fixture(t);
  await open(page, trunks.Ledger);
  await busy(page, 2.5 * MIN);
  await settled(page, trunks.Scout, /kite\/sleep/, true);
  assert.equal(await page.evaluate(() => document.documentElement.classList.contains("doze18")), false, "the window is awake while you use it");
  assert.match(await loopOf(page, trunks.Ledger), /ember\/idle/, "the open conversation's face stays awake");
  assert.match(await loopOf(page, trunks.Scout), /kite\/sleep/, "a face whose conversation is not open sleeps");
  assert.equal(await face(page, trunks.Scout).evaluate((el) => el.querySelector("video").paused), true, "and, fallen asleep, lies still");
  assert.equal(await page.evaluate(() => [...document.querySelectorAll("#side [data-rk] video")].filter((v) => !v.paused).map((v) => v.closest("[data-rk]").dataset.rk).every((k, _, all) => k === all[0])), true, "only the open conversation's face moves in the list");
  await face(page, trunks.Scout).hover();
  await settled(page, trunks.Scout, /kite\/idle/);
  assert.match(await loopOf(page, trunks.Scout), /kite\/idle/, "hovering its row wakes it");
  assert.deepEqual(errors, []);
});

test("input wakes the window and the open conversation's face at once, gently", async (t) => {
  const { page, errors, trunks } = await fixture(t);
  await page.clock.fastForward(10 * MIN + 5000);
  await page.waitForFunction(() => document.documentElement.classList.contains("still18"));
  await page.mouse.move(700, 400);
  await page.waitForFunction(() => !document.documentElement.classList.contains("doze18"));
  assert.equal(await page.evaluate(() => document.documentElement.classList.contains("wake18")), true, "the window plays its wake");
  assert.equal(await page.locator("#side .petbox.zz11").count(), 0, "the pet wakes");
  assert.match(await page.locator(".hero11 video").getAttribute("src"), /anim-idle/, "Branch, whose conversation is open, wakes");
  assert.ok(await playing(page) > 0, "loops play again");
  assert.match(await loopOf(page, trunks.Scout), /kite\/sleep/, "a Trunk whose conversation is not open sleeps on");
  assert.deepEqual(errors, []);
});

test("a Trunk at work never sleeps", async (t) => {
  const { page, errors, trunks, work } = await fixture(t);
  work();
  await page.waitForFunction((id) => document.querySelector(`#side [data-rk="t:${id}"]`)?.dataset.st === "work", trunks.Busy.id, { timeout: 30000 });
  await page.clock.fastForward(10 * MIN + 5000);
  await settled(page, trunks.Ledger, /ember\/sleep/);
  assert.match(await loopOf(page, trunks.Busy), /tide\/work/, "its working loop stays");
  assert.equal(await face(page, trunks.Busy).evaluate((el) => el.classList.contains("rest18")), false);
  assert.match(await loopOf(page, trunks.Ledger), /ember\/sleep/, "the others sleep");
  assert.deepEqual(errors, []);
});
