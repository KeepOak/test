/* Browser pictures in a chat's live steps (Telegram, Discord and Slack send files): while a task started from a chat
   works in Branch's browser, the chat gets a picture of the page after the first browser step, with the step as its
   caption, then at most one now and again and never more than a few, beside the steps message. Only in a direct chat,
   only where the owner's "Show steps in chats" and its pictures are on, never in a group. Password boxes are covered,
   as in the window's live view. Real headless Chromium against a local page; the chat app is a stand-in. */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright"; // a real headless Chromium opens these pages (CI installs it for this file)
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, savePolicy } from "../dist/index.js";
import { BranchBrowser, registerBrowser } from "../dist/integrations/browser.js";
import { saveStepsSettings } from "../dist/channels/steps-display.js";
import { pictureTiming } from "../dist/channels/live-status.js";

assert.equal(typeof chromium.launch, "function");

const fast = { progressAfterMs: 30, editEveryMs: 10, typingEveryMs: 20, reactEveryMs: 5 };
async function until(check, label, tries = 600) {
  for (let i = 0; i < tries; i++) { const value = await check(); if (value) return value; await delay(20); }
  assert.fail(`Timed out: ${label}`);
}
function fakeChat() {
  const calls = [];
  let next = 100;
  const adapter = { id: "chat", kind: "telegram", botName: () => "Branch", maxFileBytes: 10_000_000,
    async start() {}, async stop() {},
    async send(chatId, text) { calls.push({ op: "send", chatId, text }); return String(next++); },
    async edit(chatId, messageId, text) { calls.push({ op: "edit", chatId, messageId, text }); },
    async sendTyping() {},
    async sendFile(chatId, file, replyTo) { calls.push({ op: "file", chatId, file, replyTo }); return String(next++); } };
  return { adapter, calls, files: () => calls.filter((c) => c.op === "file") };
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-chat-browser-pictures-"));
  const site = createServer((request, response) => response.writeHead(200, { "content-type": "text/html" })
    .end(`<!doctype html><title>Page ${request.url}</title><h1>Page ${request.url}</h1><label>Password <input type="password" value="hunter2-secret"></label>`));
  site.listen(0, "127.0.0.1"); await once(site, "listening");
  const origin = `http://127.0.0.1:${site.address().port}`;
  let pages = 0;
  // Each round thinks a little, as a model does, so the page is at rest between two steps.
  const provider = { name: "scripted", async complete(request) {
    await delay(150);
    const last = request.messages.at(-1);
    if (last?.role === "tool" || /look \d/.test(String(last?.content ?? ""))) {
      if (pages < Number(/look (\d+)/.exec(String(request.messages.find((m) => m.role === "user")?.content ?? ""))?.[1] ?? 1))
        return { content: "", toolCalls: [{ id: `nav${++pages}`, name: "browser.navigate", arguments: JSON.stringify({ url: `${origin}/p${pages}` }) }] };
    }
    return { content: "Looked.", toolCalls: [] };
  } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  const browser = new BranchBrowser({ allowedOrigins: [origin] });
  browser.store = app.store; app.browser = browser;
  registerBrowser(app.registry, browser);
  savePolicy(app.store, app.runtime.owner, { preset: "off" });
  t.after(async () => { await browser.close(); await app.close(); site.close(); await discardTemp(root); });
  app.channels.mergeWindowMs = 0;
  app.channels.liveTiming = fast;
  app.channels.setSwitches({ liveStatus: "on", commands: "on", steering: "on", splitting: "on", steps: "on" });
  const chat = fakeChat();
  await app.channels.attach(chat.adapter, { activation: "always", pairing: true, allowlist: ["owner"] });
  // A chat's task reads pages only where the owner allowed it for this app and person (src/channels/chat-permissions.ts).
  app.channels.setPermissionSettings({ extras: true, rules: [{ channel: "chat", sender: "owner", allow: ["browser.read"], note: "Me" }] });
  let id = 1;
  const message = (text, extra = {}) => ({ channel: "chat", chatId: "c1", chatKind: "direct", senderId: "owner", senderName: "Sam",
    text, addressed: true, messageId: `m${id++}`, ...extra });
  return { app, chat, message, reset: () => { pages = 0; chat.calls.length = 0; } };
}

test("a chat task working in the browser sends a picture of the page with its step, secrets covered, a few at most", async (t) => {
  const f = await fixture(t);
  const saved = { ...pictureTiming };
  t.after(() => Object.assign(pictureTiming, saved));
  pictureTiming.everyMs = 0; // every browser step may send one here, so the cap is what is tested
  assert.equal(await f.app.channels.handle(f.message("look 8")), "replied");
  const files = await until(() => (f.chat.files().length >= 1 ? f.chat.files() : null), "a picture");
  assert.equal(files[0].file.mediaType, "image/jpeg");
  assert.ok(files[0].file.bytes.length > 1000, "a real frame");
  assert.match(files[0].file.caption, /127\.0\.0\.1/, "the step is its caption");
  assert.equal(files[0].replyTo, "m1", "beside the person's own message");
  assert.ok(f.chat.files().length <= pictureTiming.most, `never more than ${pictureTiming.most}`);
  assert.ok(f.chat.calls.every((c) => !JSON.stringify(c.file?.caption ?? c.text ?? "").includes("hunter2-secret")));
  // The browser's warm-up picture of its empty first page (browser-session.ts open) never reaches the chat: every
  // picture sent shows one of the task's pages and says which.
  assert.ok(f.chat.files().every((c) => /Page \/p\d+ · 127\.0\.0\.1:\d+$/.test(c.file.caption)), "only the task's own pages are sent");
});

test("no pictures in a group, when the owner turns them off, or when steps in chats are off", async (t) => {
  const f = await fixture(t);
  const used = [];
  f.app.store.onEvent((_runId, kind, data) => { if (kind === "tool.completed") used.push(data.name); });
  await f.app.channels.handle(f.message("look 1", { chatKind: "group", chatId: "g1" }));
  await delay(500);
  assert.ok(used.includes("browser.navigate"), "the group's task did work in the browser");
  assert.equal(f.chat.files().length, 0, "a group never sees the page");
  f.reset();
  saveStepsSettings(f.app.store, f.app.runtime.owner, { all: { pictures: "off" } });
  await f.app.channels.handle(f.message("look 1"));
  await delay(500);
  assert.equal(f.chat.files().length, 0, "pictures off");
  f.reset();
  saveStepsSettings(f.app.store, f.app.runtime.owner, { all: { pictures: "browser" } });
  f.app.channels.setSwitches({ liveStatus: "on", commands: "on", steering: "on", splitting: "on", steps: "off" });
  await f.app.channels.handle(f.message("look 1"));
  await delay(500);
  assert.equal(f.chat.files().length, 0, "steps in chats off");
});

/* An app that can replace a picture (Telegram, Discord) keeps one picture up to date in place, with Take over and Hand
   back under it; a press pauses the task at its next browser step and a second lets it carry on. */
test("one picture kept up to date in place, with Take over and Hand back that really pause and resume the task", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-chat-browser-hold-"));
  const site = createServer((request, response) => response.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><title>Page ${request.url}</title><h1>${request.url}</h1>`));
  site.listen(0, "127.0.0.1"); await once(site, "listening");
  const origin = `http://127.0.0.1:${site.address().port}`;
  let release, rounds = 0;
  const held = new Promise((done) => { release = done; });
  const provider = { name: "scripted", async complete() {
    rounds++;
    if (rounds === 1) return { content: "", toolCalls: [{ id: "a", name: "browser.navigate", arguments: JSON.stringify({ url: `${origin}/one` }) }] };
    if (rounds === 2) { await held; return { content: "", toolCalls: [{ id: "b", name: "browser.navigate", arguments: JSON.stringify({ url: `${origin}/two` }) }] }; }
    return { content: "Both pages seen.", toolCalls: [] };
  } };
  t.after(() => release()); // first, so a failed test never leaves its task waiting while the engine closes
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  const browser = new BranchBrowser({ allowedOrigins: [origin] });
  browser.store = app.store; app.browser = browser;
  registerBrowser(app.registry, browser);
  savePolicy(app.store, app.runtime.owner, { preset: "off" });
  t.after(async () => { await browser.close(); await app.close(); site.close(); await discardTemp(root); });
  app.channels.mergeWindowMs = 0; app.channels.liveTiming = fast;
  app.channels.setSwitches({ liveStatus: "on", commands: "on", steering: "on", splitting: "on", steps: "on" });
  const calls = [];
  let next = 500;
  const adapter = { id: "chat", kind: "telegram", botName: () => "Branch", maxFileBytes: 10_000_000, async start() {}, async stop() {},
    async send(chatId, text) { calls.push({ op: "send", text }); return String(next++); },
    async edit() {}, async sendTyping() {}, async sendFile() { calls.push({ op: "file" }); return String(next++); },
    async sendPicture(chatId, file, buttons, replyTo) { const id = String(next++); calls.push({ op: "picture", id, file, buttons, replyTo }); return id; },
    async editPicture(chatId, messageId, file, buttons) { calls.push({ op: "repicture", messageId, file, buttons }); } };
  await app.channels.attach(adapter, { activation: "always", pairing: true, allowlist: ["owner"] });
  app.channels.setPermissionSettings({ extras: true, rules: [{ channel: "chat", sender: "owner", allow: ["browser.read"], note: "Me" }] });
  const say = (text, messageId) => app.channels.handle({ channel: "chat", chatId: "c1", chatKind: "direct", senderId: "owner", senderName: "Sam", text, addressed: true, messageId });
  const task = say("look at both", "m1");
  const first = await until(() => calls.find((c) => c.op === "picture"), "the picture");
  assert.equal(first.buttons.length, 1);
  assert.match(first.buttons[0].label, /Take over/);
  assert.match(first.buttons[0].value, /^br:t:/);
  // Someone else pressing it, or the owner in another chat, changes nothing.
  await app.channels.handle({ channel: "chat", chatId: "c2", chatKind: "direct", senderId: "owner", senderName: "Sam", text: first.buttons[0].value, addressed: true, messageId: "x1" });
  assert.equal(calls.filter((c) => c.op === "send").some((c) => /You have the browser/.test(c.text)), false);
  await say(first.buttons[0].value, "p1");
  await until(() => calls.some((c) => c.op === "send" && /You have the browser/.test(c.text)), "taken over");
  const handBack = await until(() => calls.filter((c) => c.op === "repicture").find((c) => c.buttons[0]?.value?.startsWith("br:g:")), "Hand back under the picture");
  assert.equal(handBack.messageId, first.id, "the same picture, replaced in place");
  release(); // the task's next step, while the owner holds the browser
  await delay(1500);
  assert.equal(app.store.runs(app.runtime.owner).some((run) => run.status === "completed"), false, "the task waits for Hand back");
  await say(handBack.buttons[0].value, "p2");
  assert.equal(await task, "replied");
  assert.ok(calls.some((c) => c.op === "send" && /Both pages seen/.test(c.text)), "the task carried on and finished");
  assert.equal(calls.filter((c) => c.op === "picture").length, 1, "one picture message, kept in place");
  assert.deepEqual(calls.filter((c) => c.op === "repicture").at(-1).buttons, [], "no buttons once the task is over");
  const run = app.store.runs(app.runtime.owner).find((r) => r.status === "completed");
  const hands = app.store.events(run.id).filter((e) => e.kind === "browser.hands").map((e) => `${e.data.pressed}:${e.data.holder}`);
  assert.deepEqual(hands, ["take over:owner", "hand back:task"], "each press that changed hands is on the task's record");
});
