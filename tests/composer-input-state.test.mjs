import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { waitInPage } from "./wait-in-page.mjs";

async function fixture(t, viewport = { width: 1440, height: 950 }, { everything = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-composer-parity-"));
  /* Writes a file when a task is asked to "write <name>" (so a question can arrive while someone types), else answers. */
  const provider = { name: "sample-model", async complete(request) {
    const last = request.messages.at(-1);
    const named = last?.role === "user" && /^write (\S+)/.exec(String(last.content));
    return named ? { content: "", toolCalls: [{ id: `w${Date.now()}`, name: "files.write", arguments: JSON.stringify({ path: named[1], content: "x" }) }] }
      : { content: "Done.", toolCalls: [] };
  } };
  const app = await createBranch({
    workspace: join(root, "workspace"),
    dataDir: join(root, "data"),
    presets: [
      { id: "default", name: "Default connection", provider, model: "configured" },
      { id: "alternate", name: "Alternate connection", provider, model: "other-model" },
    ],
  });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport, reducedMotion: "reduce", serviceWorkers: "block" });
  t.after(async () => {
    await context.close();
    await browser.close();
    await server.close();
    await app.close();
    await discardTemp(root);
  });
  await fetch(new URL("/api/onboarding", server.url), {
    method: "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
    body: JSON.stringify({ done: true }),
  });
  const page = await context.newPage();
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120_000 });
  page.app = app;
  /* DG-175: the owner can be in either window; the bar is the sample's in both. */
  if (everything) {
    await page.evaluate(async () => {
      const { applyAppearance, currentAppearance } = await import("/appearance.js");
      applyAppearance({ ...currentAppearance(), showEverything: true });
    });
    await page.waitForFunction(() => document.documentElement.dataset.everything === "on");
  }
  return page;
}

/* Redesign: the new window's message box (public/app/chat/chat.js composer()): + (plusmenu), Tools (tools9), the box,
   the model chip (modelmenu2), the mode chip (modemenu2), dictation (dict), voice, Send. */
async function newShape(page) {
  return page.evaluate(() => {
    const box = (selector) => {
      const node = document.querySelector(selector);
      if (!node?.checkVisibility()) return null;
      const rect = node.getBoundingClientRect();
      return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height, middle: rect.top + rect.height / 2 };
    };
    return {
      form: box("#composer"), plus: box('#composer [data-act="plusmenu"]'), prompt: box("#prompt"), mode: box('#composer [data-act="modemenu2"]'),
      model: box('#composer [data-act="modelmenu2"]'), send: box("#send"),
      modelWords: document.querySelector('#composer [data-act="modelmenu2"] .lbl')?.textContent.trim() ?? "",
      viewportWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth,
    };
  });
}
function assertNewComposer(measured, { compact = false } = {}) {
  assert.ok(measured.form, "the message box is visible");
  for (const key of ["plus", "prompt", "model", "send"]) assert.ok(measured[key], `${key} stays in the bar`);
  if (!compact) assert.ok(measured.mode, "the mode chip stays in the bar");
  const visible = [measured.plus, measured.prompt, measured.mode, measured.model, measured.send].filter(Boolean);
  assert.ok(Math.max(...visible.map((item) => item.middle)) - Math.min(...visible.map((item) => item.middle)) <= 2, "controls share one line");
  assert.ok(visible.every((item) => item.left >= measured.form.left && item.right <= measured.form.right), "controls stay inside the bar");
  assert.equal(measured.scrollWidth <= measured.viewportWidth, true, "the composer never widens the page");
  if (!compact) assert.equal(measured.modelWords, "configured", "the chip names the model, not the connection");
}

// Redesign: replaced by the new window (the bar's exact 48/34 px sizes and the hidden microphone are the old sample's; the
// new message box follows design/redesign/prototype.html, checked by the look check). What stays: one line, inside the
// bar, no sideways scroll, and the model chip names the model.
test("the new window's composer keeps its controls on one line inside the bar at desktop, compact and phone widths", async (t) => {
  const page = await fixture(t);
  for (const [width, height, compact] of [[1440, 950, false], [1024, 700, false], [390, 844, true]]) {
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(200);
    assertNewComposer(await newShape(page), { compact });
  }
});

async function shape(page) {
  return page.evaluate(() => {
    const box = (selector) => {
      const node = document.querySelector(selector);
      if (!node?.checkVisibility()) return null;
      const rect = node.getBoundingClientRect();
      return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height };
    };
    return {
      form: box("#chat-form"), plus: box("#lx-plus"), prompt: box("#prompt"), mode: box("#mode-chip"),
      model: box("#lx-model-chip"), voice: box("#voice-record"), send: box("#send"),
      modelWords: document.querySelector("#lx-model-chip")?.textContent.trim() ?? "",
      viewportWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth,
    };
  });
}

function assertComposerContract(measured, { compact = false, everything = false } = {}) {
  assert.ok(measured.form, "the message box is visible");
  assert.ok(Math.abs(measured.form.height - 48) <= 1, `the sample bar is 48px tall, got ${measured.form.height}px`);
  for (const key of ["plus", "prompt", "mode", "model", "send"]) assert.ok(measured[key], `${key} stays in the bar`);
  for (const key of ["plus", "prompt", "mode", "model", "send"])
    assert.ok(Math.abs(measured[key].height - 34) <= 1, `${key} is 34px tall, got ${measured[key].height}px`);
  const visible = [measured.plus, measured.prompt, measured.mode, measured.model, measured.send];
  assert.ok(Math.max(...visible.map((item) => item.top)) - Math.min(...visible.map((item) => item.top)) <= 1, "controls share one line");
  assert.ok(visible.every((item) => item.left >= measured.form.left && item.right <= measured.form.right), "controls stay inside the bar");
  /* The sample's microphone shows when voice is on or everything is shown, and sits in the bar. */
  if (everything) assert.ok(measured.voice && measured.voice.left >= measured.form.left && measured.voice.right <= measured.form.right, "the microphone sits in the bar");
  else assert.equal(measured.voice, null, "voice recording stays hidden until voice is switched on");
  assert.equal(measured.scrollWidth <= measured.viewportWidth, true, "the composer never widens the page");
  if (!compact) assert.equal(measured.modelWords, "configured", "the chip names the model, not the connection");
}

// Redesign: replaced by the new window (the calm and full windows are one window; the sample bar's sizes and ids are
// replaced by the prototype's message box, re-checked above).
for (const everything of [false, true]) {
  test.skip(`the ${everything ? "full" : "calm"} window's composer matches the sample bar at desktop, compact and phone widths`, async (t) => {
    const page = await fixture(t, undefined, { everything });
    for (const [width, height, compact] of [[1440, 950, false], [1024, 700, false], [390, 844, true]]) {
      await page.setViewportSize({ width, height });
      assertComposerContract(await shape(page), { compact, everything });
    }
  });
}

/* Redesign: the model chip is [data-act="modelmenu2"] (public/app/chat/chips.js), its menu the prototype's
   POPS.modelmenu2: "Which model answers", one row per connection (name, then model), the Thinking row when the model
   takes one, and "Accounts and order…" (the old "Manage models…" and "Workspace default" rows are replaced by the new
   window). What each pick chose is read from the engine; what the chip says is checked last. */
test("the model chip opens a real model picker without leaving the conversation", async (t) => {
  const page = await fixture(t);
  const chip = page.locator('#composer [data-act="modelmenu2"]');
  const menu = page.locator("#app > .pop");
  /* Each row names the model and the connection it goes through (prototype: the model in .mi-t, the way in .mi-s). */
  const rows = () => menu.locator('[data-act="pick-model"]').evaluateAll((nodes) => nodes.map((n) =>
    [n.querySelector(".mi-t").textContent.trim(), n.querySelector(".mi-s").textContent.trim()].sort().join(" · ")));
  const said = [];
  await chip.click();
  await menu.waitFor({ state: "visible" });
  assert.deepEqual(await rows(), ["Default connection · configured", "Alternate connection · other-model"].map((r) => r.split(" · ").sort().join(" · ")));
  assert.equal(await menu.getByRole("menuitem", { name: /Accounts and order/ }).isVisible(), true);
  await menu.locator('[data-act="pick-model"]').first().click();
  await page.keyboard.press("Escape");
  /* Before the first message no conversation is open (the new window shows its empty screen); the picker opens none. */
  assert.equal(await page.locator(".empty-chat").isVisible(), true, "the new conversation's screen is still what is shown");
  assert.equal(await page.locator('#side [data-act="chat"][aria-current="true"]').count(), 0, "no conversation was opened");
  said.push((await chip.locator(".lbl").innerText()).trim());
  await page.locator("#prompt").fill("Start a conversation");
  await page.locator("#send").click();
  await page.locator("#conversation .b .txt").waitFor({ timeout: 30_000 });
  await page.waitForFunction(() => !document.getElementById("send").disabled);
  const sessionId = await page.locator('#side [data-act="chat"][aria-current="true"]').getAttribute("data-id");
  const model = () => page.evaluate(async (id) => (await (await fetch(`/api/sessions/${id}/model`, {
    headers: { authorization: "Bearer " + sessionStorage.getItem("branch-token") } })).json()).preset, sessionId);
  await chip.click();
  await menu.waitFor({ state: "visible" });
  assert.deepEqual(await rows(), ["Default connection · configured", "Alternate connection · other-model"].map((r) => r.split(" · ").sort().join(" · ")));
  await menu.locator('[data-act="pick-model"]').nth(1).click();
  await waitInPage(page, async (id) => (await (await fetch(`/api/sessions/${id}/model`, {
    headers: { authorization: "Bearer " + sessionStorage.getItem("branch-token") } })).json()).preset === "alternate", sessionId, { timeout: 10_000 });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(4_000);
  assert.equal(await model(), "alternate", "refresh keeps this conversation's model");
  assert.equal(await page.locator('#side [data-act="chat"][aria-current="true"]').getAttribute("data-id"), sessionId, "the picker left this conversation open");
  assert.equal(await page.locator("#conversation").isVisible(), true, "the conversation is still what is shown");
  said.push((await chip.locator(".lbl").innerText()).trim());
  await chip.click();
  await menu.locator('[data-act="pick-model"]').first().click();
  await waitInPage(page, async (id) => (await (await fetch(`/api/sessions/${id}/model`, {
    headers: { authorization: "Bearer " + sessionStorage.getItem("branch-token") } })).json()).preset === "default", sessionId, { timeout: 10_000 });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(600);
  said.push((await chip.locator(".lbl").innerText()).trim());
  assert.deepEqual(said, ["configured", "other-model", "configured"], "the chip names the model, not the connection");
});

/* Redesign: the + menu is the prototype's POPS.plusmenu (public/app/chat/plus.js). "Temporary conversation" is a switch
   in it (#pm-temp) that the next new conversation carries (POST /api/run temporary); "Ask me questions first" (#pm-ask,
   sw:askqs) is live since parity B1 (the engine's ask-first setting; design/redesign/tools/verify-parity-b1.cjs drives it),
   so only Temporary is checked here. The calm/full split is replaced by
   the new window (one window), so the full variant stays skipped. */
test("the plus menu changes the real conversation choices in the calm window (the new window)", async (t) => {
  const page = await fixture(t);
  const plus = page.locator('#composer [data-act="plusmenu"]');
  const menu = page.locator("#app > .pop");
  await plus.click();
  await menu.waitFor({ state: "visible" });
  assert.equal(await menu.locator("#pm-ask").getAttribute("aria-disabled"), null, "control: Ask me questions first is live (parity B1)");
  await menu.getByRole("checkbox", { name: "Temporary conversation", exact: true }).check();
  await page.keyboard.press("Escape");
  await plus.click();
  assert.equal(await menu.getByRole("checkbox", { name: "Temporary conversation", exact: true }).isChecked(), true, "the menu shows the real choice");
  await page.keyboard.press("Escape");
  const sent = page.waitForRequest((request) => request.url().endsWith("/api/run"));
  await page.locator("#prompt").fill("Forget this afterwards");
  await page.locator("#send").click();
  assert.equal((await sent).postDataJSON().temporary, true, "the new conversation is started as a temporary one");
});

// Redesign: replaced by the new window (the calm and full windows are one window); the calm variant is ported above.
for (const everything of [false, true]) {
  test.skip(`the plus menu changes the real conversation choices in the ${everything ? "full" : "calm"} window`, async (t) => {
    const page = await fixture(t, undefined, { everything });
    for (const [name, target] of [
      ["Ask me questions first", "#ask-first-toggle"],
      ["Temporary: forget this conversation afterwards", "#temporary-toggle"],
    ]) {
      await page.locator("#lx-plus").click();
      await page.locator("#lx-plus-menu").getByRole("menuitem", { name, exact: true }).dispatchEvent("click");
      assert.equal(await page.locator(target).isChecked(), true, `${name} presses its existing control`);
      assert.equal(await page.locator("#lx-plus-menu").isHidden(), true);
    }
  });
}

// Redesign: Coming soon (sw:askqs, "Ask me questions first" in the + menu), checked at ef021c57.
test.skip("a refresh that began before Ask first changed cannot put the old choice back", async (t) => {
  const page = await fixture(t);
  let captured, release;
  const responseCaptured = new Promise((resolve) => { captured = resolve; });
  const released = new Promise((resolve) => { release = resolve; });
  let held = false;
  await page.route("**/api/ask-first/settings", async (route) => {
    if (route.request().method() !== "GET" || held) return route.continue();
    held = true;
    const response = await route.fetch();
    captured();
    await released;
    await route.fulfill({ response });
  });
  const refreshing = page.evaluate(() => globalThis.branchMisc.render());
  await responseCaptured;
  await page.locator("#lx-plus").click();
  await page.locator("#lx-plus-menu").getByRole("menuitem", { name: "Ask me questions first", exact: true }).dispatchEvent("click");
  assert.equal(await page.locator("#ask-first-toggle").isChecked(), true, "the new choice is visible immediately");
  release();
  await refreshing;
  assert.equal(await page.locator("#ask-first-toggle").isChecked(), true, "the stale refresh cannot overwrite the new choice");
});

/* Redesign: the new window draws an open conversation again when the questions waiting change (it looks every four
   seconds), so a question arriving from another task while someone types is the redraw here. */
test("typing, focus and selection survive the three-second redraw", async (t) => {
  const page = await fixture(t);
  const run = page.app.store.createRun("local", "Earlier");
  page.app.store.message(run.sessionId, { role: "user", content: "Earlier question" });
  page.app.store.message(run.sessionId, { role: "assistant", content: "Earlier answer" });
  page.app.store.finish(run.id, "completed", "Earlier answer");
  await page.reload();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120_000 });
  await page.locator(`#side [data-act="chat"][data-id="${run.sessionId}"]`).click();
  await page.locator("#conversation").getByText("Earlier answer").waitFor();
  const prompt = page.locator("#prompt");
  await prompt.click();
  const draws = await page.evaluate(() => { globalThis.__draws = 0; new MutationObserver(() => globalThis.__draws++).observe(document.getElementById("main"), { childList: true }); });
  void draws;
  const typed = "Compare the three supplier quotes and flag delivery";
  await prompt.fill(typed);
  await prompt.evaluate((node) => node.setSelectionRange(8, 16));
  await page.evaluate(async () => { await fetch("/api/policy", { method: "POST", headers: { authorization: "Bearer " + sessionStorage.getItem("branch-token"), "content-type": "application/json" }, body: JSON.stringify({ preset: "ask-before-changes" }) }); });
  await page.app.runtime.run({ prompt: "write elsewhere.txt" });
  await page.waitForTimeout(7_000);
  assert.ok(await page.evaluate(() => globalThis.__draws) > 0, "control: the conversation was drawn again meanwhile");
  assert.equal(await prompt.inputValue(), typed);
  assert.deepEqual(
    await prompt.evaluate((node) => ({ start: node.selectionStart, end: node.selectionEnd, focused: document.activeElement === node })),
    { start: 8, end: 16, focused: true },
  );
});

/* A new conversation's first answer shows before the window has read what the ended task left (its questions, the
   picture, the extras). A caret the person puts in the box meanwhile stays there: it used to be taken back to where it
   was when the conversation got its id (chat/chat.js adoptDraft), which lost the caret desktop-hot-update keeps. */
test("a caret put in the box after a new conversation's first answer shows stays where it was put", async (t) => {
  const page = await fixture(t);
  let ran = false, held = false, released;
  const answered = new Promise((done) => { released = done; });
  page.on("request", (request) => { if (request.method() === "POST" && new URL(request.url()).pathname === "/api/run") ran = true; });
  await page.route("**/api/policy", async (route) => {
    if (ran && !held) { held = true; await new Promise((done) => setTimeout(done, 2000)); await route.continue(); released(); return; }
    await route.continue();
  });
  const prompt = page.locator("#prompt");
  await prompt.fill("Say hello");
  await page.locator("#send").click();
  await page.waitForFunction(() => document.getElementById("conversation")?.textContent.includes("Done."), undefined, { timeout: 20_000 });
  /* Typed and the caret put in one step on the page, each on the box drawn at that moment. The box is drawn again while
     the window reads what the task left, and typing can draw it again (Stop turns back into Send), so a box found
     first and changed later can be one no longer on the page (CI: the caret went to a replaced box, and the live one
     kept the end of the words, 20). */
  await page.evaluate(() => {
    const typed = document.getElementById("prompt");
    typed.focus();
    typed.value = "a half-typed thought";
    typed.dispatchEvent(new Event("input", { bubbles: true }));
    const box = document.getElementById("prompt");
    box.focus();
    box.setSelectionRange(2, 6);
  });
  await answered; // the held read is answered; the window then reads the picture and the extras, and its send ends
  await page.waitForTimeout(1500);
  assert.deepEqual(
    await prompt.evaluate((node) => ({ value: node.value, start: node.selectionStart, end: node.selectionEnd, focused: document.activeElement === node })),
    { value: "a half-typed thought", start: 2, end: 6, focused: true },
  );
});
