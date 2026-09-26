/* Redesign phase 2 "rooms" (critique #33): the dictation bar and Talk live in its own view.
   No test here may open a real microphone: getUserMedia is replaced before the page loads and only
   counted, the dictation routes are answered by the test, and the live view is driven by the same
   events public/voice-live.js sends. Headless only. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

const model = { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } };

async function fixture(t, { liveView = "off", liveAvailable = false, dictation = null } = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-p2-voice-ui-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: model });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  const browser = await chromium.launch({ headless: true });
  let page = null;
  t.after(async () => {
    /* A route still answering when the test ends (its route.fetch) failed on the closed browser. */
    await page?.unrouteAll({ behavior: "ignoreErrors" }).catch(() => undefined);
    await browser.close(); await server.close(); await app.close(); await discardTemp(root);
  });
  const call = (path, body) => fetch(new URL(path, server.url), { method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    .then((response) => response.json());
  await call("/api/onboarding", { done: true });
  await call("/api/conversation-mode/settings", { newConversation: "follow", confirmLoosening: true });
  await call("/api/deployment/suggestion", { id: "updates", answer: "never" }).catch(() => undefined);
  if (liveView !== "off") await call("/api/voice/settings", { liveView });
  page = await (await browser.newContext({ viewport: { width: 1440, height: 950 } })).newPage();
  await page.addInitScript(() => {
    globalThis.__microphoneAsked = 0;
    const devices = navigator.mediaDevices ?? {};
    devices.getUserMedia = async () => { globalThis.__microphoneAsked += 1; throw new Error("No microphone in tests"); };
    Object.defineProperty(navigator, "mediaDevices", { value: devices, configurable: true });
  });
  if (liveAvailable) await page.route("**/api/voice/plan", async (route) => {
    const real = await (await route.fetch()).json();
    await route.fulfill({ json: { ...real, live: { ...real.live, available: true, service: "openai", reason: "A live conversation runs on the test connection." } } });
  });
  if (dictation) await dictationRoutes(page, dictation);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("body.lx-ready").waitFor({ state: "attached" });
  // layout.js marks lx-ready as the page loads, before the key is taken: the window is open once #workspace shows.
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  await page.waitForFunction(() => globalThis.branchVoiceView);
  await page.evaluate(() => globalThis.branchVoiceView.refresh());
  return { app, call, page, errors };
}
/** The dictation routes, answered here: the test decides when "the microphone" is open and what it heard. */
async function dictationRoutes(page, state) {
  await page.route("**/api/voice/dictation/listen", async (route) => {
    state.open = JSON.parse(route.request().postData() ?? "{}").on === true;
    state.presses.push(state.open);
    await route.fulfill({ json: { open: state.open, refusal: "" } });
  });
  await page.route("**/api/voice/dictation", async (route) => {
    const json = { settings: { mode: "on", silenceSeconds: 4 }, mode: "on", canDictate: true, refusal: "", isOwner: true,
      engine: { how: "A test engine.", available: true }, open: state.open, words: state.words, settled: !state.open };
    await route.fulfill({ json }).catch(() => undefined);
  });
}
const microphoneAsked = (page) => page.evaluate(() => globalThis.__microphoneAsked);

/* ---------- the new window (public/app/**, design/redesign/prototype.html) ---------- */
/* Redesign: the composer's microphone (data-act="dict") dictates; while it listens the prototype shows "Listening… speak
   naturally" with Done (data-act="dict-done"). Talk live (data-act="voice") is drawn Coming soon. */
async function signedIn(t, { dictation = null } = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-p2-voice-ui-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: model });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  // The first-run card (#323) opens under automation on purpose and would catch the Done click; this is about dictation.
  await fetch(new URL("/api/onboarding", server.url), { method: "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify({ done: true }) });
  const browser = await chromium.launch({ headless: true });
  let page = null;
  t.after(async () => {
    await page?.unrouteAll({ behavior: "ignoreErrors" }).catch(() => undefined);
    await browser.close(); await server.close(); await app.close(); await discardTemp(root);
  });
  const call = (path, body) => fetch(new URL(path, server.url), { method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    .then((response) => response.json());
  page = await (await browser.newContext({ viewport: { width: 1440, height: 950 }, serviceWorkers: "block" })).newPage();
  await page.addInitScript(() => {
    globalThis.__microphoneAsked = 0;
    const devices = navigator.mediaDevices ?? {};
    devices.getUserMedia = async () => { globalThis.__microphoneAsked += 1; throw new Error("No microphone in tests"); };
    Object.defineProperty(navigator, "mediaDevices", { value: devices, configurable: true });
  });
  if (dictation) await dictationRoutes(page, dictation);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  return { app, call, page, errors };
}

/* Redesign: Talk live is drawn Coming soon (data-act="voice"); pressed anyway, it opens nothing and asks for nothing. */
test("Talk live in its own view ships off: the send button stays Send, and nothing asks for the microphone", async (t) => {
  const f = await signedIn(t);
  assert.equal((await f.call("/api/voice/plan")).settings.liveView, "off");
  const talk = f.page.locator('#composer [data-act="voice"]');
  assert.equal(await talk.getAttribute("aria-disabled"), "true", "Talk live is greyed out");
  assert.equal(await f.page.locator("#send").getAttribute("aria-label"), "Send");
  await talk.evaluate((button) => button.click());
  await f.page.waitForTimeout(500);
  assert.equal(await microphoneAsked(f.page), 0);
  assert.equal(f.app.store.runs(f.app.runtime.owner).length, 0, "nothing was sent");
  assert.deepEqual(f.errors, []);
});

// Redesign: Coming soon (voice, Talk live with voice in the composer), checked at fc541c24.
test.skip("switched on: the empty box offers Talk live on the send button, and typing gives Send back", async (t) => {
  const f = await fixture(t, { liveView: "on", liveAvailable: true });
  await f.page.waitForFunction(() => document.getElementById("send").classList.contains("voice-send"));
  assert.equal(await f.page.locator("#send").getAttribute("aria-label"), "Talk live");
  assert.equal(await microphoneAsked(f.page), 0, "switching it on asks for nothing");
  await f.page.locator("#prompt").fill("hello");
  await f.page.locator("#prompt").dispatchEvent("input");
  assert.equal(await f.page.locator("#send.voice-send").count(), 0);
  assert.equal(await f.page.locator("#send").getAttribute("aria-label"), "Send");
  await f.page.locator("#prompt").fill("");
  await f.page.locator("#prompt").dispatchEvent("input");
  // Pressing it starts Talk live; here the server cannot hold one, so it says why and the view closes.
  await f.page.locator("#send").click();
  await f.page.waitForFunction(() => !document.getElementById("voice-view"));
  assert.equal(await microphoneAsked(f.page), 0, "the microphone is never asked for before the conversation is open");
  assert.equal(await f.page.locator("#prompt").inputValue(), "", "and nothing was sent");
  assert.deepEqual(f.errors, []);
});

// Redesign: Coming soon (voice, Talk live with voice in the composer), checked at fc541c24.
test.skip("the view follows the live conversation: status, both sides as they are said, a question folds it away, End closes it", async (t) => {
  const f = await fixture(t, { liveView: "on", liveAvailable: true });
  const fire = (kind, detail) => f.page.evaluate(([k, d]) => document.dispatchEvent(new CustomEvent(k, { detail: d })), [kind, detail]);
  await fire("branch-live-state", { state: "listening-live" });
  const view = f.page.locator("#voice-view");
  await view.waitFor({ state: "visible" });
  assert.match(await view.innerText(), /Talk live[\s\S]*Listening[\s\S]*Mute[\s\S]*Show the chat[\s\S]*End[\s\S]*Your voice goes to OpenAI/);
  await fire("branch-live-transcript", { who: "you", text: "Has the price", final: false });
  await fire("branch-live-transcript", { who: "you", text: "Has the price moved?", final: true });
  await fire("branch-live-state", { state: "speaking" });
  await fire("branch-live-transcript", { who: "them", text: "It went up.", final: true });
  assert.match(await f.page.locator("#voice-view-captions").innerText(), /You\s+Has the price moved\?[\s\S]*Your assistant\s+It went up\./);
  assert.equal(await f.page.locator("#voice-view-cut").isVisible(), true, "Cut in while it answers");
  await fire("branch-live-ask", { tool: "files.write" });
  assert.equal(await view.evaluate((node) => node.classList.contains("mini")), true, "folded away so the question can be answered");
  await f.page.locator("#voice-view-chat").click();
  assert.equal(await view.evaluate((node) => node.classList.contains("mini")), false);
  await f.page.getByRole("button", { name: "End", exact: true }).click();
  assert.equal(await f.page.locator("#voice-view").count(), 0);
  assert.equal(await microphoneAsked(f.page), 0);
  assert.deepEqual(f.errors, []);
});

// Redesign: Coming soon (voice, Talk live with voice in the composer), checked at fc541c24.
test.skip("Talk live is not offered in a conversation a Trunk answers in", async (t) => {
  const f = await fixture(t, { liveView: "on", liveAvailable: true });
  for (const part of ["trunks", "conversations"]) await f.call("/api/trunks/switch", { part, mode: "on" });
  const scout = (await f.call("/api/trunks", { name: "Scout" })).trunk;
  await f.app.trunks.introduced();
  const started = await f.call("/api/trunks/conversations", { trunkId: scout.id });
  await f.page.evaluate(async (id) => { const { openConversation } = await import("/app.js"); await openConversation(id); }, started.sessionId);
  await f.page.waitForFunction(() => globalThis.branchRooms.liveAllowed() === false);
  await f.page.waitForFunction(() => !document.getElementById("send").classList.contains("voice-send"));
  await f.page.waitForFunction(() => document.getElementById("voice-live").hidden, null, { timeout: 5000 }); // the button asks the server first
  assert.deepEqual(f.errors, []);
});

/* Redesign: the prototype's listening row has Done only (the words stay).
   WINDOW BUG: public/app/chat/dictate.js records in the browser (getUserMedia + MediaRecorder, then POST
   /api/voice/transcribe) instead of the engine's dictation (POST /api/voice/dictation/listen, FEATURE-AUDIT dict), and
   draws no listening row. */
test("dictation: the microphone in the box, the listening row, and Done keeps the words", async (t) => {
  const state = { open: false, words: "compare the two quotes", presses: [] };
  const f = await signedIn(t, { dictation: state });
  const button = f.page.locator('#composer [data-act="dict"]');
  await button.waitFor({ state: "visible" });
  assert.equal(await button.getAttribute("aria-label"), "Dictate into the box");
  assert.equal(await button.locator("svg").count(), 1, "a microphone, not a word");
  await f.page.locator("#prompt").fill("Please");
  await button.click();
  const bar = f.page.locator(".dict");
  await bar.filter({ hasText: "Listening" }).waitFor({ state: "visible", timeout: 10000 });
  await f.page.waitForFunction(() => document.getElementById("prompt")?.value.includes("compare the two quotes"));
  await f.page.locator('[data-act="dict-done"]').click();
  await bar.waitFor({ state: "detached" });
  assert.match(await f.page.locator("#prompt").inputValue(), /Please compare the two quotes/);
  assert.deepEqual(state.presses, [true, false]);
  assert.equal(await microphoneAsked(f.page), 0, "the window itself never touches a microphone for dictation");
  assert.deepEqual(f.errors, []);
});

// Redesign: replaced by the new window (the prototype's listening row has Done only; checked in the test above).
test.skip("dictation: a microphone in the box, a bar while it listens, and throwing the words away puts the box back", async (t) => {
  const state = { open: false, words: "compare the two quotes", presses: [] };
  const f = await fixture(t, { dictation: state });
  const button = f.page.locator("#voice-dictate");
  await button.waitFor({ state: "visible" });
  assert.equal(await button.getAttribute("aria-label"), "Dictate");
  assert.equal(await button.locator("svg").count(), 1, "a microphone, not a word");
  await f.page.locator("#prompt").fill("Please");
  await button.click();
  const bar = f.page.locator("#dictation-bar");
  await bar.waitFor({ state: "visible" });
  assert.match(await bar.innerText(), /Listening[\s\S]*On this computer\. Nothing leaves it\./);
  await f.page.waitForFunction(() => document.getElementById("prompt").value.includes("compare the two quotes"));
  await bar.getByRole("button", { name: "Stop and throw the words away" }).click();
  await f.page.waitForFunction(() => !document.getElementById("dictation-bar"));
  assert.equal(await f.page.locator("#prompt").inputValue(), "Please", "the box is as it was");
  // Keep: the words stay.
  await button.click();
  await bar.waitFor({ state: "visible" });
  await f.page.waitForFunction(() => document.getElementById("prompt").value.includes("compare the two quotes"));
  await f.page.getByRole("button", { name: "Stop and keep the words" }).click();
  await f.page.waitForFunction(() => !document.getElementById("dictation-bar"));
  assert.match(await f.page.locator("#prompt").inputValue(), /Please compare the two quotes/);
  assert.deepEqual(state.presses, [true, false, true, false]);
  assert.equal(await microphoneAsked(f.page), 0, "the window itself never touches a microphone for dictation");
  assert.deepEqual(f.errors, []);
});

