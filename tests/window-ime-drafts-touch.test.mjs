/* Three small window fixes (audits/ui.md). UP-UI-001: Enter while an input method is composing (Japanese, Chinese,
   Korean) confirms the word and never sends, in every Enter-to-send box. UP-UI-006: the words being typed survive a
   reload and a closed window, per person, and a sent message is not brought back. UP-UI-052: under a finger, text boxes
   are at least 16px (no iPhone focus zoom) and the message box's buttons at least 44px.
   Mutation: drop composing(e) from chat.js's Enter handler and the first test goes red; drop keepDrafts() from main.js
   and the second does; remove the touch.css link and the third does. Headless only, 127.0.0.1. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { waitInPage } from "./wait-in-page.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

async function fixture(t, contextOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-ime-drafts-"));
  const asked = [];
  const provider = { name: "scripted", async complete(request) {
    asked.push(String(request.messages.filter((m) => m.role === "user").at(-1)?.content ?? ""));
    return { content: "Heard.", toolCalls: [] };
  } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  await fetch(new URL("/api/onboarding", server.url), { method: "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify({ done: true }) });
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, reducedMotion: "reduce", serviceWorkers: "block", ...contextOptions });
  t.after(async () => { await context.close(); await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const errors = [];
  const open = async () => {
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(server.url, { timeout: 120000 });
    await page.getByLabel("Session token", { exact: true }).fill(server.token);
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await page.locator("#prompt").waitFor({ state: "visible", timeout: 120000 });
    return page;
  };
  return { open, asked, errors, context };
}

/* A keydown as an input method sends it: isComposing, or the legacy keyCode 229 some input methods send. */
const imeEnter = (page, selector, how) => page.locator(selector).evaluate((box, how) => {
  const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, isComposing: how === "composing" });
  if (how === "229") Object.defineProperty(event, "keyCode", { value: 229 });
  box.dispatchEvent(event);
}, how);

test("Enter while an input method composes never sends; a plain Enter still does", async (t) => {
  const f = await fixture(t);
  const page = await f.open();
  await page.locator("#prompt").fill("こんにちは");
  for (const how of ["composing", "229"]) {
    await imeEnter(page, "#prompt", how);
    await page.waitForTimeout(400);
    assert.equal(await page.locator("#prompt").inputValue(), "こんにちは", `the word stays in the box (${how})`);
    assert.deepEqual(f.asked, [], `nothing was sent (${how})`);
  }
  await imeEnter(page, "#prompt", "plain"); // the control: the same dispatch without composing reaches the handler and sends
  await waitInPage(page, () => document.querySelector("#prompt")?.value === "");
  await page.locator("#conversation").getByText("Heard.").waitFor({ timeout: 30000 });
  assert.deepEqual(f.asked, ["こんにちは"]);

  /* The palette: a composing Enter keeps it open on the word; Enter afterwards picks. */
  await page.keyboard.press("ControlOrMeta+k");
  await page.locator("#pal-in").waitFor({ state: "visible" });
  await page.locator("#pal-in").fill("設定");
  await imeEnter(page, "#pal-in", "composing");
  await page.waitForTimeout(200);
  assert.equal(await page.locator("#pal-in").isVisible(), true, "the palette stays open while composing");
  assert.deepEqual(f.errors, []);
});

test("every Enter-to-send handler asks whether an input method is composing", async () => {
  const files = ["chat/chat.js", "shell/home.js", "chat/quick.js", "chat/steer.js", "chat/helpframe.js", "shell/palette.js", "chat/messages.js", "chat/branches.js"];
  for (const file of files) {
    const text = await readFile(new URL(`../public/app/${file}`, import.meta.url), "utf8");
    assert.match(text, /composing\(e\)/, `${file} checks composing(e)`);
  }
});

test("an unsent draft survives a reload and a closed window, and a sent one does not come back", async (t) => {
  const f = await fixture(t);
  let page = await f.open();
  await page.locator("#prompt").fill("half a thought");
  await waitInPage(page, () => Object.keys(localStorage).some((k) => k.startsWith("branch-drafts:") && localStorage.getItem(k).includes("half a thought")), null, { timeout: 5000 });
  await page.reload();
  await page.locator("#prompt").waitFor({ state: "visible", timeout: 120000 });
  await waitInPage(page, () => document.querySelector("#prompt")?.value === "half a thought", null, { timeout: 15000 });

  await page.close(); // a closed window: a new one signs in afresh (the token is kept per tab), the words are still there
  page = await f.open();
  await waitInPage(page, () => document.querySelector("#prompt")?.value === "half a thought", null, { timeout: 15000 });

  await page.locator("#prompt").press("Enter");
  await page.locator("#conversation").getByText("Heard.").waitFor({ timeout: 30000 });
  assert.equal(await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("branch-drafts:")).map((k) => localStorage.getItem(k)).join("")).then((s) => s.includes("half a thought")), false, "the sent words are no longer kept");
  await page.reload();
  await page.locator("#prompt").waitFor({ state: "visible", timeout: 120000 });
  await page.waitForTimeout(500);
  assert.equal(await page.locator("#prompt").inputValue(), "", "a reload after sending shows an empty box");
  assert.deepEqual(f.errors, []);
});

test("on a phone, text boxes are at least 16px and the message box's buttons at least 44px", async (t) => {
  const f = await fixture(t, { viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true });
  const page = await f.open();
  assert.equal(await page.evaluate(() => matchMedia("(pointer: coarse)").matches), true, "the phone reports a coarse pointer");
  const px = (selector, prop) => page.locator(selector).first().evaluate((el, prop) => parseFloat(getComputedStyle(el)[prop]), prop);
  assert.ok(await px("#prompt", "fontSize") >= 16, "the message box is at least 16px");
  // Read in one step: the composer may be drawn again between finding Send and measuring it, which left no box.
  const send = await page.locator("#send").first().evaluate((el) => { const r = el.getBoundingClientRect(); return { width: r.width, height: r.height }; });
  assert.ok(send.width >= 44 && send.height >= 44, `Send is at least 44px (${send.width}×${send.height})`);
  await page.keyboard.press("ControlOrMeta+k");
  await page.locator("#pal-in").waitFor({ state: "visible" });
  assert.ok(await px("#pal-in", "fontSize") >= 16, "the palette box is at least 16px");
  await page.keyboard.press("Escape");
  await page.evaluate(async () => { const { S } = await import("/app/core/state.js"); const { renderNow } = await import("/app/core/dom.js"); S.view = "settings"; renderNow(); });
  await page.locator("#set-q").waitFor({ state: "attached" });
  assert.ok(await px("#set-q", "fontSize") >= 16, "the Settings search box is at least 16px");
  const small = await page.evaluate(() => [...document.querySelectorAll("input,textarea,select")]
    .filter((el) => el.getClientRects().length && !["checkbox", "radio", "range", "color", "file", "hidden"].includes(el.type))
    .filter((el) => parseFloat(getComputedStyle(el).fontSize) < 16).map((el) => el.id || el.className));
  assert.deepEqual(small, [], "no text box on the page is under 16px");
  assert.deepEqual(f.errors, []);
});

test("with a mouse, the message box keeps its own size", async (t) => {
  const f = await fixture(t);
  const page = await f.open();
  assert.equal(await page.evaluate(() => matchMedia("(pointer: coarse)").matches), false);
  await waitInPage(page, () => getComputedStyle(document.querySelector("#prompt")).fontSize === "15px", null, { timeout: 10000 });
});
