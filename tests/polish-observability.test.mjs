/**
 * Wave 7: the screens the earlier waves left as routes, and the observability leftovers.
 * What is allowed right now, approval buttons in a chat app, signing in with Google for Gemini,
 * label chips, markdown everywhere, "/model" without its module, comparing two tasks, saving a
 * trajectory, the live event feed, the month view and the metering export.
 */
import test from "node:test";
import { finishFirstRun, openPlace, openSettingFor, showEverything } from "./places.mjs";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { chromium } from "playwright";
import { createBranch, modelsUrl, probeProvider, googleRefusedSignIn } from "../dist/index.js";
import { GeminiProvider } from "../dist/providers/gemini.js";
import { startServer } from "../dist/server.js";

/** A workspace and a server, cleaned up when the test ends. */
export async function served(t, provider) {
  const scratch = join(tmpdir(), "Codex-session-files");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "branch-wave7-"));
  const app = await createBranch({
    workspace: join(root, "workspace"),
    dataDir: join(root, "data"),
    ...(provider ? { provider } : {}),
  });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  await fetch(new URL("/api/onboarding", server.url), { method: "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify({ done: true }) });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const api = async (method, path, body) => {
    const response = await fetch(server.url + path, {
      method,
      headers: { authorization: `Bearer ${server.token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  return { app, server, api, root };
}

/**
 * A connected browser page on the app. `block` names public files the browser must not get, so a
 * screen can be proven to still work when one of its modules is missing.
 */
export async function onPage(t, options = {}) {
  const { app, server, api, root } = await served(t, options.provider);
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); });
  const page = await browser.newPage({ viewport: options.viewport ?? { width: 1280, height: 800 }, serviceWorkers: "block" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  for (const file of options.block ?? []) await page.route("**" + file, (route) => route.abort());
  await page.goto(server.url, { timeout: 120000, waitUntil: "domcontentloaded" });
  const token = page.getByLabel("Session token", { exact: true });
  await token.waitFor({ state: "visible", timeout: 120000 });
  await token.fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).evaluate((button) => button.click());
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  /* Redesign: the new window (public/app/**) opens on the conversation; there is no first-run panel or calm window. */
  return { app, server, api, page, errors, root };
}

/* ---------- G3: the Gemini sign-in honours the bearer flag ---------- */

test("G3 a signed-in Gemini connection is checked with an Authorization header, not the key header", () => {
  const key = new GeminiProvider({ endpoint: "https://generativelanguage.googleapis.com", model: "gemini-2.5-flash", apiKey: "AIza-test" });
  const signedIn = new GeminiProvider({ endpoint: "https://generativelanguage.googleapis.com", model: "gemini-2.5-flash", apiKey: "ya29-token", bearer: true });
  const withKey = modelsUrl(key);
  const withToken = modelsUrl(signedIn);
  assert.equal(withKey.headers["x-goog-api-key"], "AIza-test", "a key still goes in Google's key header");
  assert.equal(withKey.headers.authorization, undefined);
  assert.equal(withToken.headers.authorization, "Bearer ya29-token", "a sign-in token goes in the ordinary header");
  assert.equal(withToken.headers["x-goog-api-key"], undefined, "a sign-in token is never put in the key header");
  assert.equal(withToken.url, withKey.url, "both ask the same address");
});

test("G3 when Google refuses a sign-in the card says so plainly and keeps the key flow", async (t) => {
  const { app } = await served(t);
  app.runtime.models.register({
    id: "google-gemini", name: "Gemini (signed in with Google)", model: "gemini-2.5-flash",
    provider: new GeminiProvider({ endpoint: "https://generativelanguage.googleapis.com", model: "gemini-2.5-flash", apiKey: "ya29-token", bearer: true }),
  });
  let sentHeaders = null;
  const refusing = async (_url, init) => { sentHeaders = init.headers; return new Response("{}", { status: 403 }); };
  const probe = await probeProvider(app.runtime.models, "google-gemini", app.web.policy, refusing);
  assert.equal(sentHeaders.authorization, "Bearer ya29-token");
  assert.equal(probe.signedIn, false);
  assert.equal(probe.signedInWithGoogle, true);
  assert.equal(probe.summary, googleRefusedSignIn, "the card repeats Google's answer in plain words");
  assert.match(probe.summary, /your own Google Cloud project/);
  assert.match(probe.fix, /Paste a Gemini API key/, "the ordinary key flow is still offered");
  assert.doesNotMatch(probe.summary, /403/, "no status code is put in front of the person");
});

test("G3 the Gemini card has a route that reports whether a sign-in is set up", async (t) => {
  const { api } = await served(t);
  const before = await api("GET", "/api/models/gemini-signin");
  assert.equal(before.status, 200);
  assert.equal(before.body.connected, false);
  assert.match(before.body.note, /Google Cloud project/);
  /* With no client id there is nothing to sign in to, and it says so rather than failing silently. */
  const refused = await api("POST", "/api/models/gemini-signin", { clientId: "", model: "gemini-2.5-flash" });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /No Google sign-in is set up/);
  /* The model the owner typed is remembered even though the sign-in itself did not happen. */
  const after = await api("GET", "/api/models/gemini-signin");
  assert.equal(after.body.settings.model, "gemini-2.5-flash");
});

/* ---------- G6: "/model" and "/help" without public/model-profiles.js ---------- */

// Redesign: replaced by the new window (public/app.js and public/model-profiles.js are the old window's; the new
// message box is public/app/chat/chat.js, checked in "typing /model … still lists the choices" below).
test.skip("G6 the message box knows its own commands, so /model and /help work without the module", async () => {
  const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(source, /export function parseSlashCommand/, "the parser lives in app.js, not only in the module");
  assert.match(source, /switchModelWithoutModule/, "app.js can change the model on its own");
  const module = await readFile(new URL("../public/model-profiles.js", import.meta.url), "utf8");
  assert.match(module, /branchSlashCommand/, "the module is still the handler when it is loaded");
  assert.match(module, /presetName/, "profile cards read connection names rather than ids");
});

/* ---------- G2: approval buttons in a chat app ---------- */

/** A stand-in for api.telegram.org: queued updates come out of getUpdates; sends are recorded. */
async function fakeTelegram(t) {
  const { createServer } = await import("node:http");
  const { setTimeout: delay } = await import("node:timers/promises");
  const state = { queue: [], sent: [], calls: [] };
  const server = createServer(async (req, res) => {
    let raw = ""; for await (const part of req) raw += part;
    const body = raw ? JSON.parse(raw) : {};
    const method = req.url.split("/").pop();
    state.calls.push(method);
    const reply = (result) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: true, result })); };
    if (method === "getMe") return reply({ id: 999, is_bot: true, first_name: "Branch", username: "BranchTestBot" });
    if (method === "getUpdates") {
      const pending = state.queue.filter((u) => u.update_id >= (body.offset ?? 0));
      if (!pending.length) await delay(40);
      return reply(pending);
    }
    if (method === "sendMessage") { state.sent.push(body); return reply({ message_id: 1000 + state.sent.length }); }
    if (method === "answerCallbackQuery") return reply(true);
    res.writeHead(404); res.end(JSON.stringify({ ok: false, description: "unknown method" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { state, apiBase: `http://127.0.0.1:${server.address().port}` };
}
async function until(check, label) {
  const { setTimeout: delay } = await import("node:timers/promises");
  for (let i = 0; i < 400; i++) { if (check()) return; await delay(25); }
  assert.fail(`Timed out: ${label}`);
}

test("G2 the letters and the buttons say the same thing, and a yes is tied to the exact request", async () => {
  const { approvalButtons, readApprovalAnswer, approvalFallbackNote } = await import("../dist/channels/router.js");
  const fingerprint = "a".repeat(32);
  const three = approvalButtons(fingerprint, true);
  assert.deepEqual(three.map((b) => b.label), ["Yes", "Yes always", "No"]);
  assert.deepEqual(three.map((b) => b.value), [`y:${fingerprint}`, `a:${fingerprint}`, `n:${fingerprint}`]);
  /* Telegram allows 64 bytes in a button's own value, so every one of them has to fit. */
  for (const button of three) assert.ok(Buffer.byteLength(button.value) <= 64, button.value);
  /* A task somebody else started cannot be given a standing yes, so that button is not offered. */
  assert.deepEqual(approvalButtons(fingerprint, false).map((b) => b.label), ["Yes", "No"]);
  assert.deepEqual(readApprovalAnswer(`y:${fingerprint}`), { decision: "allow", remember: "session", fingerprint });
  assert.deepEqual(readApprovalAnswer(`a:${fingerprint}`), { decision: "allow", remember: "always", fingerprint });
  assert.deepEqual(readApprovalAnswer(`n:${fingerprint}`), { decision: "deny", remember: "session", fingerprint });
  assert.equal(readApprovalAnswer("write the file"), null, "an ordinary message is not an answer");
  assert.equal(readApprovalAnswer(""), null);
  /* mac7/chat-approvals (integration review): the note is only ever sent to a chat, and a chat may
     never give a standing yes, so the letter for one is not offered there. "a" is still read, for
     the window and the API that may give one. */
  assert.match(approvalFallbackNote, /reply y for yes, or n for no/i);
  assert.equal(/yes always/i.test(approvalFallbackNote), false);
});

test("G2 Discord's component payload is an action row of buttons carrying the same answers", async () => {
  const { DiscordAdapter } = await import("../dist/channels/discord.js");
  const { approvalButtons } = await import("../dist/channels/router.js");
  const components = DiscordAdapter.components(approvalButtons("b".repeat(32), true));
  assert.equal(components.length, 1);
  assert.equal(components[0].type, 1, "one action row");
  const buttons = components[0].components;
  assert.deepEqual(buttons.map((b) => b.type), [2, 2, 2], "each is a button");
  assert.deepEqual(buttons.map((b) => b.label), ["Yes", "Yes always", "No"]);
  assert.deepEqual(buttons.map((b) => b.custom_id), [`y:${"b".repeat(32)}`, `a:${"b".repeat(32)}`, `n:${"b".repeat(32)}`]);
  assert.deepEqual(buttons.map((b) => b.style), [1, 1, 4], "No is the danger button");
  for (const button of buttons) assert.ok(button.custom_id.length <= 100, "Discord's own limit is honoured");
});

test("G2 a paused task asks in Telegram with buttons, and a pressed button answers it", async (t) => {
  const { TelegramAdapter } = await import("../dist/index.js");
  const { app } = await served(t, writesAFile("gated.txt"));
  const { state, apiBase } = await fakeTelegram(t);
  const adapter = new TelegramAdapter({ id: "telegram", token: "123:abc", apiBase, pollTimeoutSeconds: 1 });
  await app.channels.attach(adapter, { activation: "always", pairing: false, allowlist: ["42"] });
  t.after(async () => { await app.channels.detachAll(); });
  const chat = { id: 501, type: "private" };
  const from = { id: 42, first_name: "Alice", username: "alice" };
  app.store.save("settings", app.runtime.owner, "policy", { preset: "ask-before-changes", rules: [{ tool: "*", applies: "changes", decision: "ask", remember: "session" }], limits: {} });
  // mac7/chat-approvals: writing a file is not on the short list every chat has, so the owner's own
  // line is what puts a Yes in this chat at all — and only because they ticked its box. Without it
  // the chat gets No alone; the test below this one is that half.
  app.channels.setPermissionSettings({ extras: true,
    rules: [{ channel: "telegram", sender: "42", allow: ["files.write"], note: "my own phone", approvals: true }] });

  state.queue.push({ update_id: 1, message: { message_id: 10, text: "write the notes", from, chat } });
  await until(() => state.sent.some((sent) => sent.reply_markup), "the question went out with buttons");
  const asked = state.sent.find((sent) => sent.reply_markup);
  assert.match(asked.text, /Before I go ahead/, "the question is put in words too");
  const row = asked.reply_markup.inline_keyboard[0];
  // mac7/chat-source: a chat cannot prove who is typing, so its task is never offered a standing yes.
  assert.deepEqual(row.map((b) => b.text), ["Yes", "No"]);
  const waiting = app.runtime.waitingApprovals()[0];
  assert.ok(waiting.fingerprint, "the question has a fingerprint of the exact request");
  for (const button of row) assert.equal(button.callback_data.split(":")[1], waiting.fingerprint);

  /* Pressing "Yes" routes through the same approval path, bound to the same exact bytes. */
  const sessionId = waiting.sessionId;
  state.queue.push({ update_id: 2, callback_query: { id: "cb1", data: row[0].callback_data, from, message: { message_id: 11, chat, from } } });
  await until(() => app.runtime.waitingApprovals(sessionId).length === 0, "the press answered the question");
  await until(() => state.calls.includes("answerCallbackQuery"), "Telegram is told the press landed");
  assert.equal(app.runtime.allowedNow(sessionId)[0].tool, "files.write", "the yes is remembered for this conversation");
  await until(() => state.sent.some((sent) => /I will carry on/.test(sent.text ?? "")), "the chat is told the answer landed");

  /* The record of what the assistant was allowed to do says which chat app answered. */
  const decided = app.store.audit.list(app.runtime.owner, { action: "approval.decided" });
  assert.ok(decided.length >= 1);
  assert.match(decided[0].reason, /answered on telegram/);
  assert.equal(decided[0].outcome, "allowed");
});

test("G2 a button pressed by a bot answers nothing, the same as a message from one", async (t) => {
  /* mac7/chat-approvals (integration review): an ordinary message from a bot is dropped before it is
     anything, but a pressed button was not, so a bot posting as somebody the owner named on a line
     would have carried that person's yes. The two ways in have to agree. */
  const { TelegramAdapter } = await import("../dist/index.js");
  const { app } = await served(t, writesAFile("gated.txt"));
  const { state, apiBase } = await fakeTelegram(t);
  const adapter = new TelegramAdapter({ id: "telegram", token: "123:abc", apiBase, pollTimeoutSeconds: 1 });
  await app.channels.attach(adapter, { activation: "always", pairing: false, allowlist: ["42"] });
  t.after(async () => { await app.channels.detachAll(); });
  const chat = { id: 501, type: "private" };
  const person = { id: 42, first_name: "Alice", username: "alice" };
  app.store.save("settings", app.runtime.owner, "policy", { preset: "ask-before-changes", rules: [{ tool: "*", applies: "changes", decision: "ask", remember: "session" }], limits: {} });
  app.channels.setPermissionSettings({ extras: true,
    rules: [{ channel: "telegram", sender: "42", allow: ["files.write"], note: "my own phone", approvals: true }] });

  state.queue.push({ update_id: 1, message: { message_id: 10, text: "write the notes", from: person, chat } });
  await until(() => state.sent.some((sent) => sent.reply_markup), "the question went out with buttons");
  const row = state.sent.find((sent) => sent.reply_markup).reply_markup.inline_keyboard[0];
  const waiting = app.runtime.waitingApprovals()[0];
  const sessionId = waiting.sessionId;

  /* The same id, the same chat, the same button — but Telegram says it is a bot. */
  state.queue.push({ update_id: 2, callback_query: { id: "cb1", data: row[0].callback_data,
    from: { ...person, is_bot: true }, message: { message_id: 11, chat, from: person } } });
  await until(() => state.calls.filter((call) => call === "getUpdates").length >= 3, "the update was taken off the queue");
  assert.equal(app.runtime.waitingApprovals(sessionId).length, 1, "a bot's press answered the question");
  assert.equal(app.runtime.allowedNow(sessionId).length, 0, "and something was allowed by it");
  assert.equal(app.store.audit.list(app.runtime.owner, { action: "approval.decided" }).length, 0);

  /* The person's own press still lands, so this refuses bots and nothing else. */
  state.queue.push({ update_id: 3, callback_query: { id: "cb2", data: row[0].callback_data, from: person,
    message: { message_id: 12, chat, from: person } } });
  await until(() => app.runtime.waitingApprovals(sessionId).length === 0, "the person's own press stopped working");
});

test("G2 a button press is refused from another chat, from a stranger, with the wrong fingerprint, and a second time", async (t) => {
  const { app } = await served(t, writesAFile("gated.txt"));
  const sent = [];
  /* A channel that does have buttons, so the pressed-button path is the one being exercised. */
  const chatty = {
    id: "telegram", kind: "telegram", botName: () => "Branch",
    async start(onMessage) { chatty.deliver = onMessage; },
    async send(chatId, text, replyTo) { sent.push({ chatId, text, replyTo }); return "m" + sent.length; },
    async sendButtons(chatId, text, buttons) { sent.push({ chatId, text, buttons }); return "b" + sent.length; },
    async stop() {},
  };
  await app.channels.attach(chatty, { activation: "always", pairing: false, allowlist: ["42"] });
  t.after(async () => { await app.channels.detachAll(); });
  app.store.save("settings", app.runtime.owner, "policy", { preset: "ask-before-changes", rules: [{ tool: "*", applies: "changes", decision: "ask", remember: "session" }], limits: {} });
  // mac7/chat-approvals: the line that lets 42 answer for what it granted. Everything refused below
  // is refused on top of it — another chat, a stranger, a wrong fingerprint and a second press are
  // all still refused for somebody the owner did name.
  app.channels.setPermissionSettings({ extras: true,
    rules: [{ channel: "telegram", sender: "42", allow: ["files.write"], note: "my own phone", approvals: true }] });
  const press = (chatId, senderId, text, messageId) => chatty.deliver({
    channel: "telegram", chatId, chatKind: "direct", senderId, senderName: "Someone",
    text, addressed: true, messageId,
  });

  await press("501", "42", "write the notes", "1");
  await until(() => app.runtime.waitingApprovals().length === 1, "the task stopped to ask");
  const waiting = app.runtime.waitingApprovals()[0];
  const sessionId = waiting.sessionId;
  const yes = `y:${waiting.fingerprint}`;
  assert.ok(sent.some((m) => m.buttons), "the question went out with buttons");

  /* A press from a chat that is not the one carrying this conversation answers nothing. */
  await press("777", "42", yes, "2");
  assert.equal(app.runtime.waitingApprovals(sessionId).length, 1, "another chat cannot answer it");
  assert.equal(app.runtime.allowedNow(sessionId).length, 0, "and nothing was allowed");

  /* A press from somebody who is not on the list never reaches the approval at all. */
  await press("501", "99", yes, "3");
  assert.equal(app.runtime.waitingApprovals(sessionId).length, 1, "a stranger cannot answer it");
  assert.match(sent.at(-1).text, /private/i, "they are told the assistant is private");

  /* A press carrying the fingerprint of some other request is refused by the binding, and the chat
     is told the button does not fit rather than being told a yes landed. */
  const { staleButtonNote } = await import("../dist/channels/router.js");
  await press("501", "42", `y:${"f".repeat(32)}`, "4");
  assert.equal(app.runtime.waitingApprovals(sessionId).length, 1, "a different request's answer is refused");
  assert.equal(app.runtime.allowedNow(sessionId).length, 0);
  await until(() => sent.at(-1)?.text === staleButtonNote, "the chat is told the button does not fit");
  assert.doesNotMatch(staleButtonNote, /already been answered/, "it never claims an answer landed");

  /* The real press works once. */
  await press("501", "42", yes, "5");
  await until(() => app.runtime.waitingApprovals(sessionId).length === 0, "the right press answered it");
  const allowed = app.runtime.allowedNow(sessionId).length;
  const runsBefore = app.store.runs(app.runtime.owner).length;

  /* Pressing it again changes nothing, and is not run as if somebody had typed it. */
  await press("501", "42", yes, "6");
  await until(() => sent.at(-1)?.text === staleButtonNote, "the second press is answered with words");
  assert.equal(app.runtime.allowedNow(sessionId).length, allowed, "no second yes was remembered");
  assert.equal(app.store.runs(app.runtime.owner).length, runsBefore, "and no task was started from the button");

  /* Every yes that did land is in the record, and says which chat app it was pressed in. */
  const decided = app.store.audit.list(app.runtime.owner, { action: "approval.decided" });
  assert.equal(decided.length, 1, "exactly one answer was recorded");
  assert.match(decided[0].reason, /answered on telegram/);
});

test("G2 without the owner's switch the chat gets No alone and is told where the yes belongs", async (t) => {
  /* mac7/chat-approvals: the other half of the two tests above. Writing a file is something one of
     the owner's lines granted, and by default the yes for it is the owner's to give in the window:
     the chat is never shown a Yes it cannot press, and is told in words where to press it. */
  const { app } = await served(t, writesAFile("gated.txt"));
  const sent = [];
  const chatty = {
    id: "telegram", kind: "telegram", botName: () => "Branch",
    async start(onMessage) { chatty.deliver = onMessage; },
    async send(chatId, text, replyTo) { sent.push({ chatId, text, replyTo }); return "m" + sent.length; },
    async sendButtons(chatId, text, buttons) { sent.push({ chatId, text, buttons }); return "b" + sent.length; },
    async stop() {},
  };
  await app.channels.attach(chatty, { activation: "always", pairing: false, allowlist: ["42"] });
  t.after(async () => { await app.channels.detachAll(); });
  app.store.save("settings", app.runtime.owner, "policy", { preset: "ask-before-changes", rules: [{ tool: "*", applies: "changes", decision: "ask", remember: "session" }], limits: {} });
  /* The line grants the writing, and its box is not ticked — which is how every line starts. */
  app.channels.setPermissionSettings({ extras: true,
    rules: [{ channel: "telegram", sender: "42", allow: ["files.write"], note: "my own phone" }] });
  assert.equal(app.channels.permissionSettings().rules[0].approvals, false, "a fresh line may already say yes");
  const press = (text, messageId) => chatty.deliver({
    channel: "telegram", chatId: "501", chatKind: "direct", senderId: "42", senderName: "Alice",
    text, addressed: true, messageId,
  });

  await press("write the notes", "1");
  await until(() => app.runtime.waitingApprovals().length === 1, "the task stopped to ask");
  const waiting = app.runtime.waitingApprovals()[0];
  const sessionId = waiting.sessionId;

  /* Only No, and the sentence saying where the yes belongs. */
  const asked = sent.find((m) => m.buttons);
  assert.ok(asked, "the question went out with buttons");
  assert.deepEqual(asked.buttons.map((b) => b.label), ["No"], "a Yes was offered that the chat cannot give");
  assert.match(asked.text, /approved in the Branch app window/, "the chat was not told where the yes belongs");

  /* Pressing the Yes anyway, by sending its value, changes nothing and says the same thing again. */
  await press(`y:${waiting.fingerprint}`, "2");
  await until(() => /approved in the Branch app window/.test(sent.at(-1).text ?? ""), "the yes was not refused in words");
  assert.equal(app.runtime.waitingApprovals(sessionId).length, 1, "the chat's own yes went ahead");
  assert.equal(app.runtime.allowedNow(sessionId).length, 0, "and something was allowed by it");
  assert.equal(app.store.audit.list(app.runtime.owner, { action: "approval.decided" }).length, 0);

  /* No always works from the chat, so nothing is left waiting for ever. */
  await press(`n:${waiting.fingerprint}`, "3");
  await until(() => app.runtime.waitingApprovals(sessionId).length === 0, "the no did not answer it");
  const decided = app.store.audit.list(app.runtime.owner, { action: "approval.decided" });
  assert.equal(decided.length, 1);
  assert.equal(decided[0].outcome, "refused");
});

test("G2 a channel with no buttons gets the same question with reply y / n", async (t) => {
  const { app } = await served(t, writesAFile("gated.txt"));
  const sent = [];
  /* A plain adapter: it can send words and nothing else, which is WhatsApp and email. */
  const plain = {
    id: "whatsapp", kind: "whatsapp", botName: () => "Branch",
    async start(onMessage) { plain.deliver = onMessage; },
    async send(chatId, text, replyTo) { sent.push({ chatId, text, replyTo }); return "m1"; },
    async stop() {},
  };
  await app.channels.attach(plain, { activation: "always", pairing: false, allowlist: ["42"] });
  t.after(async () => { await app.channels.detachAll(); });
  app.store.save("settings", app.runtime.owner, "policy", { preset: "ask-before-changes", rules: [{ tool: "*", applies: "changes", decision: "ask", remember: "session" }], limits: {} });
  // mac7/chat-approvals: the same line again, on the app that has no buttons, so the letters offered
  // are the full set rather than "Reply n for no." alone.
  app.channels.setPermissionSettings({ extras: true,
    rules: [{ channel: "whatsapp", sender: "42", allow: ["files.write"], note: "my own phone", approvals: true }] });

  await plain.deliver({ channel: "whatsapp", chatId: "9", chatKind: "direct", senderId: "42", senderName: "Alice", text: "write the notes", addressed: true, messageId: "1" });
  await until(() => sent.some((m) => /reply y for yes/i.test(m.text)), `the letters were offered: ${JSON.stringify(sent)}`);
  assert.match(sent.at(-1).text, /Before I go ahead/, "the question is there too");
  const sessionId = app.runtime.waitingApprovals()[0].sessionId;

  /* Typing "n" answers it; anything longer is an ordinary message, not an answer. */
  await plain.deliver({ channel: "whatsapp", chatId: "9", chatKind: "direct", senderId: "42", senderName: "Alice", text: "n", addressed: true, messageId: "2" });
  await until(() => app.runtime.waitingApprovals(sessionId).length === 0, "the letter answered the question");
  assert.match(sent.at(-1).text, /I will not do that/);
  const decided = app.store.audit.list(app.runtime.owner, { action: "approval.decided" });
  assert.match(decided[0].reason, /answered on whatsapp/);
  assert.equal(decided[0].outcome, "refused");
});

/* ---------- D1: two tasks side by side, and the statistics card ---------- */

/** A provider whose answer depends on what was asked, so two tasks really do differ. */
const answersTheQuestion = { name: "scripted", async complete(request) {
  const asked = [...request.messages].reverse().find((m) => m.role === "user")?.content ?? "";
  return { content: `The answer for ${asked}.\nSame second line.`, toolCalls: [] };
} };

test("D1 comparing two tasks shows both sets of figures and the difference between the answers", async (t) => {
  // A model that answers differently each time, even for the same prompt
  let callCount = 0;
  const varyingAnswers = { name: "scripted", async complete(request) {
    callCount++;
    const asked = [...request.messages].reverse().find((m) => m.role === "user")?.content ?? "";
    const variation = callCount === 1 ? "first" : "second";
    return { content: `The ${variation} answer for ${asked}.\nSame line in both.`, toolCalls: [] };
  } };
  const { page, errors } = await onPage(t, { provider: varyingAnswers });
  /* Redesign: the compare button sits beside "Watch a task again" and compares with an earlier run of
     the SAME words. Send the same words twice with a scripted model answering differently each time.
     Then expect exactly one [data-act="compare"], and clicking it opens the "Two tasks side by side" dialog. */
  const prompt = "apples";
  // Send the prompt twice, model answers differently each time
  for (let i = 0; i < 2; i++) {
    await page.locator("#prompt").fill(prompt);
    await page.locator("#composer").evaluate((form) => form.requestSubmit());
    // Wait for the answer to appear
    const expectedAnswer = i === 0 ? "The first answer" : "The second answer";
    await page.waitForFunction((answer) => document.getElementById("conversation").textContent.includes(answer), expectedAnswer, { timeout: 20000 });
    await page.waitForFunction(() => !document.getElementById("send")?.disabled, undefined, { timeout: 120000 });
    // After the first run, create a new conversation for the second run
    if (i === 0) {
      await page.locator('#side [data-act="newmenu"]').click();
      await page.locator('[data-act="newconv"]').click();
    }
  }
  await page.locator('#side [data-act="view"][data-v="inbox"]').click();
  await page.locator('#main [data-act="ptab"][data-place="inbox"][data-v="history"]').click();
  const picks = page.locator('#main [data-act="compare"]');
  await picks.first().waitFor({ timeout: 10000 });
  assert.equal(await picks.count(), 1, "exactly one compare button for comparing runs of the same words");
  await picks.first().click();
  // The prototype opens a dialog with the compare results (class "dlg")
  const dlg = page.locator(".dlg");
  await dlg.waitFor({ timeout: 15000 });
  const table = dlg.locator("table.cmp6");
  await table.waitFor({ timeout: 5000 });
  const rows = dlg.locator("table.cmp6 tbody tr");
  const labels = await rows.locator("th").allTextContents();
  // The compare table has Cost, Time, Rounds, and Tools used
  for (const wanted of ["Cost", "Time", "Rounds", "Tools used"])
    assert.ok(labels.includes(wanted), `${wanted} is compared (${labels.join(", ")})`);
  /* Both answers differ on one line and agree on the other: the older line is marked gone, the newer one added, and the
     line both share is marked neither. */
  const gone = await dlg.locator("pre.diff6 .d-del").allTextContents();
  const added = await dlg.locator("pre.diff6 .d-add").allTextContents();
  assert.deepEqual(gone, ["- The first answer for apples."], "the first answer's own line is marked gone");
  assert.deepEqual(added, ["+ The second answer for apples."], "the second answer's own line is marked added");
  assert.ok((await dlg.locator("pre.diff6").textContent()).includes("  Same line in both."), "the shared line is shown unmarked");
  await dlg.getByRole("button", { name: /Done/ }).click();
  await dlg.waitFor({ state: "hidden", timeout: 5000 });
  assert.deepEqual(errors, []);
});

test("D1 the statistics are counted from the ledger, not guessed", async (t) => {
  const { app, api } = await served(t, writesAFile("stats.txt"));
  await api("POST", "/api/run", { prompt: "write it" });
  const view = (await api("GET", "/api/usage?range=30d&by=day")).body;
  assert.ok(view.statistics, "the usage answer carries the statistics");
  assert.ok(view.statistics.rounds >= 2, "both model rounds were counted");
  assert.ok(view.statistics.medianTokensPerRound === null || view.statistics.medianTokensPerRound > 0);
  assert.equal(view.statistics.toolCalls, 1, "one tool call");
  assert.equal(view.statistics.toolFailures, 0);
  assert.equal(view.statistics.toolSuccessRate, 1);
  assert.equal(typeof view.statistics.compactions, "number");
  /* The same numbers the counters page reports, so the two screens cannot disagree. */
  const metrics = await fetch(app ? "http://invalid" : "", {}).catch(() => null);
  void metrics;
  const direct = app.store.usageStore().statistics(app.runtime.owner, 30);
  assert.equal(direct.toolCalls, view.statistics.toolCalls);
  assert.equal(direct.rounds, view.statistics.rounds);
});

/* ---------- D3: the live event stream ---------- */

test("D3 the event stream needs the key, filters by kind and carries on from the last id", async (t) => {
  const { server, api } = await served(t, writesAFile("streamed.txt"));
  assert.equal((await fetch(server.url + "/api/events/stream")).status, 401, "the stream is behind the local key");

  const run = (await api("POST", "/api/run", { prompt: "write it" })).body;
  const read = async (query) => {
    const response = await fetch(server.url + "/api/events/stream?" + query, { headers: { authorization: `Bearer ${server.token}` } });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/event-stream/);
    return response.text();
  };
  /* Asking from the beginning replays what already happened, filtered to the kinds asked for. */
  const onlyTools = await read("after=0&kind=tool.completed&maxMs=300");
  const kinds = [...onlyTools.matchAll(/^event: (.+)$/gm)].map((m) => m[1]);
  assert.ok(kinds.includes("ready") && kinds.includes("end"), "the stream says when it opened and closed");
  const delivered = kinds.filter((kind) => kind !== "ready" && kind !== "end");
  assert.ok(delivered.length > 0, "something was delivered");
  assert.deepEqual([...new Set(delivered)], ["tool.completed"], "only the kind asked for is delivered");
  const payloads = [...onlyTools.matchAll(/^data: (.+)$/gm)].map((m) => JSON.parse(m[1]));
  const body = payloads.find((p) => p.kind === "tool.completed");
  assert.equal(body.runId, run.id);
  assert.equal(body.data.name, "files.write");
  assert.ok(typeof body.id === "number" && body.createdAt);

  /* Carrying on from the last id delivers nothing that was already seen. */
  const again = await read(`after=${body.id}&kind=tool.completed&maxMs=300`);
  assert.equal([...again.matchAll(/^event: tool\.completed$/gm)].length, 0, "nothing is repeated");
  /* With no kind at all, everything of this owner's comes through. */
  const everything = await read("after=0&maxMs=300");
  assert.ok(new Set([...everything.matchAll(/^event: (.+)$/gm)].map((m) => m[1])).size > 3, "more than one kind arrives");
});

/* Redesign: the Activity screen is the side panel's Activity tab beside the task's conversation (public/app/chat/pane.js,
   design doc 4.6): each tool the task used, in plain words, gone when you leave the conversation. The old Runs page's
   event feed card is replaced by it. */
test("D3 the Activity screen shows the live feed and stops it when you leave (the new window)", async (t) => {
  const { page, api, errors } = await onPage(t, { provider: writesAFile("live.txt") });
  const run = (await api("POST", "/api/run", { prompt: "write it" })).body;
  await page.reload();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  await page.locator(`#side [data-act="chat"][data-id="${run.sessionId}"]`).click();
  await page.locator('[data-act="pane"][data-p="activity"]').first().click();
  await page.locator("#pane .tl li").first().waitFor({ timeout: 25000 });
  const words = (await page.locator("#pane .tl li span").allTextContents()).map((line) => line.trim());
  assert.ok(words.some((line) => /files\.write|live\.txt/i.test(line)), `a tool step arrived: ${words.join(" | ")}`);
  assert.ok(words.every((line) => !/^(run|model|tool|policy)\./.test(line)),
    `each line opens with plain words, not an event name: ${words.join(" | ")}`);
  await page.locator('#side [data-act="view"][data-v="inbox"]').click();
  await page.locator("#pane").waitFor({ state: "hidden" });
  assert.deepEqual(errors, []);
});

// Redesign: replaced by the new window (the old Runs page's event feed card); ported above.
test.skip("D3 the Activity screen shows the live feed and stops it when you leave", async (t) => {
  const { page, api, errors } = await onPage(t, { provider: writesAFile("live.txt") });
  await openPlace(page, "runs");
  await page.locator("#activity-feed-card").waitFor({ state: "visible" });
  await api("POST", "/api/run", { prompt: "write it" });
  await page.locator("#activity-feed .feed-row").first().waitFor({ timeout: 25000 });
  /* The rows arrive one by one; the model's steps come before the tool's. */
  await page.locator("#activity-feed .feed-row strong").filter({ hasText: /tool/i }).first()
    .waitFor({ timeout: 25000 }).catch(() => undefined);
  const words = await page.locator("#activity-feed .feed-row strong").allTextContents();
  assert.ok(words.some((line) => /tool/i.test(line)), `a tool step arrived: ${words.join(" | ")}`);
  assert.ok(words.every((line) => !/^(run|model|tool|policy)\./.test(line)),
    `each line opens with plain words, not an event name: ${words.join(" | ")}`);
  await openPlace(page, "chat");
  await page.locator("#activity-feed-card").waitFor({ state: "hidden" });
  assert.deepEqual(errors, []);
});

/* ---------- D4: the month view, the forecast and the cost columns ---------- */

// Redesign: Coming soon (Settings › Data & usage: the report, rep15 and repopen15), checked at ef021c57.
test.skip("D4 the month card's numbers come from the ledger and the forecast says about", async (t) => {
  const { page, api, errors } = await onPage(t, { provider: answersTheQuestion });
  /* A model with a price on file, so there is money to add up at all. */
  await api("POST", "/api/pricing", { overrides: { configured: { input: 1000, output: 1000 } } });
  await api("POST", "/api/run", { prompt: "apples" });
  await openPlace(page, "usage");
  await page.locator("#usage-month").waitFor({ timeout: 15000 });
  const ledger = (await api("GET", "/api/usage?range=30d&by=day")).body;
  const month = ledger.data.filter((day) => day.date.startsWith(new Date().toISOString().slice(0, 8).slice(0, 7)));
  const cost = month.reduce((total, day) => total + (day.pricedRuns ? day.estimatedCost : 0), 0);
  const priced = month.reduce((total, day) => total + day.pricedRuns, 0);
  const soFar = await page.locator("#usage-month .month-so-far").textContent();
  assert.ok(priced > 0, "the priced model really was used, so there is money to add up");
  assert.ok(cost > 0, "the ledger says the month cost something");
  assert.match(soFar, new RegExp(`${priced} task`), "the task count matches the ledger");
  assert.ok(soFar.includes("$") || soFar.includes("less than"), `the money is shown: ${soFar}`);
  assert.match(await page.locator("#usage-month .month-forecast").textContent(), /At this pace, about \$/);
  /* The same money broken three ways, each its own table. */
  const headings = await page.locator("#usage h2").allTextContents();
  for (const wanted of ["This month", "This month by model", "This month by conversation", "This month by where the task came from", "How it has been going"])
    assert.ok(headings.includes(wanted), `${wanted} is on the screen (${headings.join(", ")})`);
  assert.deepEqual(errors, []);
});

test.skip("D4 the forecast is worked out from the pace so far, and says nothing when nothing is priced", async () => {
  // Redesign: usage.js moved into the backend; calculation no longer exposed as a public module
  const { forecastMonth } = await import("../public/usage.js").catch(() => ({}));
  void forecastMonth;
  /* The page module cannot be imported outside a browser, so the same arithmetic is checked here. */
  const midMonth = new Date(2026, 5, 10);
  const days = [{ date: "2026-06-01", pricedRuns: 2, estimatedCost: 4 }, { date: "2026-06-09", pricedRuns: 3, estimatedCost: 6 }];
  const cost = days.reduce((total, day) => total + (day.pricedRuns ? day.estimatedCost : 0), 0);
  const daysInMonth = new Date(2026, 6, 0).getDate();
  assert.equal(daysInMonth, 30);
  assert.equal((cost / midMonth.getDate()) * daysInMonth, 30, "ten pounds over ten days is thirty over thirty");
  const source = await readFile(new URL("../public/usage.js", import.meta.url), "utf8");
  assert.match(source, /export function forecastMonth/);
  assert.match(source, /At this pace, about/, "the sentence is plain and says about");
  assert.match(source, /nothing to add up|cannot be guessed at/, "an unpriced month says so rather than showing zero");
});

test("D4 the spreadsheet file carries the money columns", async (t) => {
  const { server, api } = await served(t, answersTheQuestion);
  await api("POST", "/api/pricing", { overrides: { configured: { input: 1000, output: 1000 } } });
  await api("POST", "/api/run", { prompt: "apples" });
  const response = await fetch(server.url + "/api/usage/export.csv?range=30d", { headers: { authorization: `Bearer ${server.token}` } });
  assert.equal(response.status, 200);
  const [header, ...rows] = (await response.text()).trim().split("\n");
  for (const column of ["estimatedCostUsd", "costPerRunUsd", "dearestModel", "dearestModelCostUsd", "runsWithPrice", "runsWithoutPrice"])
    assert.ok(header.includes(column), `${column} is a column (${header})`);
  assert.ok(rows.length >= 1, "a day is in the file");
  const cells = rows[0].split(",");
  assert.equal(cells.length, header.split(",").length, "every row has every column");
});

/* ---------- D5: the metering export ---------- */

test("D5 the metering export writes the month's spreadsheet on the scheduled beat", async (t) => {
  const { app, api, root } = await served(t, answersTheQuestion);
  const { meteringTick, meteringDue, meteringSettings, meteringFileName } = await import("../dist/metering.js");
  await api("POST", "/api/pricing", { overrides: { configured: { input: 1000, output: 1000 } } });
  await api("POST", "/api/run", { prompt: "apples" });
  const deps = { store: app.store, owner: app.runtime.owner, workspace: join(root, "workspace"), overrides: () => ({ configured: { input: 1000, output: 1000 } }) };

  /* Off until it is asked for: a beat with it off writes nothing at all. */
  assert.equal(meteringSettings(app.store, app.runtime.owner).enabled, false);
  assert.equal(await meteringTick(deps, new Date()), null);

  const saved = await api("POST", "/api/usage/metering", { enabled: true, folder: "book-keeping", every: "daily" });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.metering.enabled, true);
  assert.equal(saved.body.metering.folder, "book-keeping");

  const now = new Date();
  const written = await meteringTick(deps, now);
  assert.ok(written, "the beat wrote the file");
  assert.ok(written.endsWith(meteringFileName(now)), `the file is named after the month: ${written}`);
  const csv = await readFile(written, "utf8");
  const [header, ...rows] = csv.trim().split("\n");
  for (const column of ["estimatedCostUsd", "costPerRunUsd", "runsWithPrice"])
    assert.ok(header.includes(column), `${column} is a column`);
  assert.ok(rows.length >= 1, "today's figures are in it");
  assert.match(rows[0], new RegExp(now.toISOString().slice(0, 10)));

  /* The next beat is not due yet, so nothing is written twice. */
  assert.equal(meteringDue(meteringSettings(app.store, app.runtime.owner), now), false);
  assert.equal(await meteringTick(deps, now), null);
  /* A day later it is due again. */
  assert.equal(meteringDue(meteringSettings(app.store, app.runtime.owner), new Date(now.getTime() + 25 * 3600 * 1000)), true);
});

test("D5 the folder has to be inside the workspace", async (t) => {
  const { api } = await served(t);
  const { meteringFolder } = await import("../dist/metering.js");
  assert.throws(() => meteringFolder("C:/work", "../elsewhere"), /inside your workspace/);
  assert.throws(() => meteringFolder("C:/work", "C:/somewhere"), /inside your workspace/);
  assert.equal((await api("POST", "/api/usage/metering", { enabled: true, folder: "../escape" })).status, 400);
  /* The route also tells the person which words it wants, rather than failing silently later. */
  const refused = await api("POST", "/api/usage/metering", { enabled: true, folder: "../escape" });
  assert.match(refused.body.error, /inside your workspace/);
});

/* ---------- D2: trajectory export ---------- */

/**
 * The smallest check a reader of these files can make: the name and number of the shape, and that
 * every part the documentation promises is there and of the right kind.
 */
const TRAJECTORY_SHAPE = {
  format: (v) => v === "branch-agent-trajectory",
  formatVersion: (v) => v === 1,
  exportedAt: (v) => typeof v === "string" && !Number.isNaN(Date.parse(v)),
  version: (v) => typeof v === "string" && v.length > 0,
  run: (v) => v && typeof v.id === "string" && typeof v.prompt === "string" && typeof v.status === "string",
  rounds: Array.isArray,
  calls: Array.isArray,
  plan: Array.isArray,
  verdicts: Array.isArray,
  steering: Array.isArray,
  questions: Array.isArray,
  timeline: Array.isArray,
  messages: Array.isArray,
  spans: Array.isArray,
  receiptCounts: (v) => v !== null && typeof v === "object",
};
function shapeProblems(document) {
  return Object.entries(TRAJECTORY_SHAPE).filter(([key, ok]) => !ok(document?.[key])).map(([key]) => key);
}

test("D2 a saved trajectory validates against the documented shape and carries the whole record", async (t) => {
  const { api } = await served(t, writesAFile("notes.txt"));
  const run = (await api("POST", "/api/run", { prompt: "write some notes" })).body;
  assert.equal(run.status, "completed");
  const saved = (await api("GET", `/api/runs/${run.id}/trajectory`)).body;
  assert.deepEqual(shapeProblems(saved), [], "every part the documentation promises is there");
  assert.equal(saved.run.id, run.id);
  assert.ok(saved.calls.some((call) => call.name === "files.write"), "the tool call is in it");
  assert.ok(saved.rounds.length >= 1, "the model rounds are in it");
  assert.ok(saved.messages.some((message) => message.role === "user"), "the conversation is in it");
  assert.ok(saved.messages.some((message) => message.role === "assistant"));
  /* What went into a tool and what came back are clipped, so one enormous result never lands here. */
  for (const call of saved.calls) {
    if (call.input) assert.ok(call.input.length <= 601, "what went in is clipped");
    if (call.output) assert.ok(call.output.length <= 601, "what came back is clipped");
  }
  assert.equal((await api("GET", "/api/runs/00000000-0000-4000-8000-000000000000/trajectory")).status, 404);
});

test("D2 many tasks come back as JSON Lines, one trajectory a line", async (t) => {
  const { server, api } = await served(t, { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } });
  for (const prompt of ["one", "two", "three"]) await api("POST", "/api/run", { prompt });
  const response = await fetch(server.url + "/api/runs/trajectories.jsonl?limit=2", { headers: { authorization: `Bearer ${server.token}` } });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /x-ndjson/);
  const lines = (await response.text()).trim().split("\n");
  assert.equal(lines.length, 2, "the limit is honoured");
  for (const line of lines) assert.deepEqual(shapeProblems(JSON.parse(line)), []);
  assert.equal(JSON.parse(lines[0]).run.prompt, "three", "newest first");
});

test("D2 runs.export hands a model the same record, and refuses a task that is not yours", async (t) => {
  const { app, api } = await served(t, { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } });
  const run = (await api("POST", "/api/run", { prompt: "a thing" })).body;
  const context = app.runtime.context({ runId: run.id });
  const exported = await app.registry.execute("runs.export", { runId: run.id }, context);
  assert.deepEqual(shapeProblems(exported), []);
  assert.equal(exported.run.id, run.id);
  await assert.rejects(
    app.registry.execute("runs.export", { runId: "00000000-0000-4000-8000-000000000000" }, context),
    /no task of yours/,
  );
  /* Every tool has to land in a toolbox, or the catalog piles it into "other". */
  const { inferToolGroup } = await import("../dist/catalog.js");
  assert.equal(inferToolGroup("runs.export"), "memory");
});

/* ---------- G1: what is allowed right now ---------- */

/** A provider that asks to write one file, then answers. Enough to earn a remembered yes. */
function writesAFile(name) {
  let round = 0;
  return {
    name: "scripted",
    async complete() {
      round += 1;
      return round === 1
        ? { content: "", toolCalls: [{ id: "c1", name: "files.write", arguments: JSON.stringify({ path: name, content: "one" }) }] }
        : { content: "done", toolCalls: [] };
    },
  };
}

test("G1 the allowed list shows a grant with its expiry, and taking it back removes it", async (t) => {
  const { app, api } = await served(t, writesAFile("gated.txt"));
  await api("POST", "/api/policy", { preset: "ask-before-changes" });
  const paused = (await api("POST", "/api/run", { prompt: "write it" })).body;
  assert.equal(paused.status, "needs_input");
  // Q257: an answer names the request it was shown for; a bare one is refused.
  await api("POST", "/api/policy/approve", { sessionId: paused.sessionId, fingerprint: app.runtime.approvals.questionFor(paused.sessionId)?.fingerprint, decision: "allow", remember: "session" });

  const listed = (await api("GET", `/api/rules/allowed?session=${paused.sessionId}`)).body;
  assert.equal(listed.grants.length, 1);
  assert.equal(listed.grants[0].tool, "files.write");
  assert.ok(Date.parse(listed.grants[0].expiresAt) > Date.now(), "it says when it runs out");
  assert.ok(listed.grants[0].label, "it says in words what is allowed");
  assert.ok(Array.isArray(listed.standing), "the standing rules that apply come back too");

  const revoked = await api("POST", "/api/rules/allowed/revoke", {
    session: paused.sessionId, tool: "files.write", target: listed.grants[0].target,
  });
  assert.equal(revoked.status, 200);
  assert.equal(revoked.body.revoked, true);
  assert.equal(revoked.body.grants.length, 0, "the answer comes back without it");
  assert.equal((await api("GET", `/api/rules/allowed?session=${paused.sessionId}`)).body.grants.length, 0);
  /* The conversation asks again, which is the whole point of taking it back. */
  assert.equal(app.runtime.allowedNow(paused.sessionId).length, 0);
  const again = await api("POST", "/api/rules/allowed/revoke", { session: paused.sessionId, tool: "files.write", target: "" });
  assert.equal(again.status, 404, "taking back something that is not allowed says so");
});

test("G1 a standing rule that says go ahead is listed beside the conversation's own yeses", async (t) => {
  const { api } = await served(t);
  await api("POST", "/api/rules/add", { tool: "files.read", match: "*", decision: "allow", remember: "always" });
  const view = (await api("GET", "/api/rules/allowed?session=00000000-0000-4000-8000-000000000000")).body;
  assert.equal(view.standing.length, 1);
  assert.equal(view.standing[0].rule.tool, "files.read");
  assert.ok(view.standing[0].sentence.length > 0, "the rule is said in a sentence, not as a shape");
  /* A rule that refuses is not something the conversation is allowed to do, so it is not listed. */
  await api("POST", "/api/rules/add", { tool: "shell.execute", match: "*", decision: "deny", remember: "always" });
  const after = (await api("GET", "/api/rules/allowed?session=00000000-0000-4000-8000-000000000000")).body;
  assert.deepEqual(after.standing.map((entry) => entry.rule.tool), ["files.read"]);
});

// Redesign: replaced by the new window (the side panel is live at ef021c57 but has no allowed list, which is not in the
// prototype's panel; the card's "Yes, for this conversation" and the sentence under each yes are not in the design's card).
test.skip("G1 the context pane lists a grant and the approval card says what a yes leaves behind", async (t) => {
  const { page, errors } = await onPage(t, { provider: writesAFile("gated.txt") });
  await page.evaluate(async (token) => {
    await fetch("/api/policy", { method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" }, body: JSON.stringify({ preset: "ask-before-changes" }) });
    /* Q59: Ask first offers no "Yes, always", so this conversation follows the owner's setting to show all three yeses. */
    await fetch("/api/conversation-mode/settings", { method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" }, body: JSON.stringify({ newConversation: "follow", confirmLoosening: true }) });
    await globalThis.branchConversationMode.refresh();
  }, await page.evaluate(() => sessionStorage.getItem("branch-token")));
  await page.locator("#prompt").fill("write it");
  await page.locator("#send").click();
  await page.locator("#live-ask").waitFor({ state: "visible", timeout: 20000 });
  /* Before pressing anything, each yes says what it will leave behind. */
  const sentences = await page.locator("#live-ask .live-ask-grant").allTextContents();
  assert.equal(sentences.length, 3, "one sentence per yes");
  assert.match(sentences[0], /asks again next time/);
  assert.match(sentences[1], /Remembered for this conversation/);
  assert.match(sentences[2], /standing rule/);

  await page.locator("#live-ask").getByRole("button", { name: "Yes, for this conversation", exact: true }).click();
  /* DG-114: the side panel is a card, closed until asked for, in the full window too. */
  await page.locator("#aside-toggle").click();
  await page.locator("#context-panel").waitFor({ state: "visible" });
  const list = page.locator("#context-allowed");
  await list.locator(".allowed-row").first().waitFor({ timeout: 15000 });
  assert.match(await list.locator(".allowed-row strong").first().textContent(), /gated\.txt|files\.write/);
  assert.match(await list.locator(".allowed-row .meta").first().textContent(), /until/);

  await list.locator(".allowed-revoke").first().click();
  await page.waitForFunction(() => !document.querySelector("#context-allowed .allowed-row"), null, { timeout: 15000 });
  assert.match(await list.locator(".context-empty").textContent(), /Nothing extra is allowed/);
  assert.deepEqual(errors, []);
});

/* ---------- G4: label chips in Recents, in Ctrl+K, and on the conversation title ---------- */

// Redesign: replaced by the new window (conversation labels and their chips are not in the design).
test.skip("G4 label chips filter Recents and the Ctrl+K box through the labels search parameter", async (t) => {
  const answers = { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } };
  const { page, api, errors } = await onPage(t, { provider: answers });
  const first = (await api("POST", "/api/run", { prompt: "the kitchen tiles" })).body;
  const second = (await api("POST", "/api/run", { prompt: "the car insurance" })).body;
  await api("POST", "/api/labels", { target: "conversation", targetId: first.sessionId, label: "house" });

  await page.reload();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  const chips = page.locator("#rail-labels .label-chip");
  await chips.first().waitFor({ timeout: 15000 });
  assert.equal(await chips.count(), 1, "one label is in use");
  assert.equal(await chips.first().textContent(), "house (1)");
  assert.equal(await page.locator("#rail-list .rail-item").count(), 2, "both conversations before filtering");

  await chips.first().click();
  await page.waitForFunction(() => document.querySelectorAll("#rail-list .rail-item").length === 1, null, { timeout: 15000 });
  assert.match(await page.locator("#rail-list .rail-item").first().textContent(), /kitchen tiles/);
  assert.equal(await chips.first().getAttribute("aria-pressed"), "true");

  /* The Ctrl+K box shows the same chips and offers only the conversations they leave. */
  await page.keyboard.press("ControlOrMeta+k");
  await page.locator("#cmd").waitFor({ state: "visible" });
  const paletteChips = page.locator("#cmd-labels .label-chip");
  await paletteChips.first().waitFor();
  assert.equal(await paletteChips.first().getAttribute("aria-pressed"), "true");
  await page.locator("#cmd-input").fill("insurance");
  assert.equal(await page.locator(".cmd-item").count(), 0, "the filtered-out conversation is not offered");

  /* Letting the chip go brings everything back. */
  await paletteChips.first().click();
  await page.waitForFunction(() => document.querySelectorAll("#rail-list .rail-item").length === 2, null, { timeout: 15000 });
  assert.ok(second.sessionId);
  assert.deepEqual(errors, []);
});

// Redesign: replaced by the new window (conversation labels and the label picker are not in the design).
test.skip("G4 the conversation title has a label picker that puts a label on what you are reading", async (t) => {
  const answers = { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } };
  const { page, api, app, errors } = await onPage(t, { provider: answers });
  const run = (await api("POST", "/api/run", { prompt: "the loft hatch" })).body;
  await api("POST", "/api/labels", { target: "conversation", targetId: run.sessionId, label: "house" });
  await page.reload();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  await page.locator("#rail-list .rail-item").first().click();
  /* Opening a conversation reads it from the server first. The picker is for the conversation that
     is open, so pressing Labels before it has arrived only says "open a conversation first". */
  await page.waitForFunction((id) => document.getElementById("conversation")?.dataset.sessionId === id, run.sessionId, { timeout: 15000 });
  await page.locator("#thread-labels").click();
  const picker = page.locator(".label-picker");
  await picker.waitFor();
  /* The label it already carries reads as chosen; pressing it takes it off. */
  const chip = picker.locator(".label-chip").first();
  assert.equal(await chip.getAttribute("aria-pressed"), "true");
  await chip.click();
  /* It was the only thing carrying that label, so the label itself is gone from the picker. */
  await page.waitForFunction(() => document.querySelectorAll(".label-picker .label-chip").length === 0, null, { timeout: 15000 });
  assert.deepEqual(app.store.labels.forTarget(app.runtime.owner, "conversation", run.sessionId), []);
  /* And a new one can be typed in without leaving the screen. */
  await picker.locator(".label-new").fill("loft");
  await picker.locator(".label-add").click();
  await page.waitForFunction(() => document.querySelector(".label-picker .label-chip")?.getAttribute("aria-pressed") === "true", null, { timeout: 15000 });
  assert.equal(await picker.locator(".label-chip").first().textContent(), "loft");
  assert.deepEqual(app.store.labels.forTarget(app.runtime.owner, "conversation", run.sessionId), ["loft"]);
  assert.deepEqual(errors, []);
});

/* ---------- G5: markdown everywhere, and Appearance in French ---------- */

const markdownReply = "## What I did\n\nI read **two** files and found `answer = 42`.\n\n- one\n- two\n";
const scripted = { name: "scripted", async complete() { return { content: markdownReply, toolCalls: [] }; } };

// Redesign: Coming soon (inspect, "Look inside the last reply" in the conversation's More menu), checked at ef021c57; the old
// Runs page's cards are replaced by the new window (Inbox › History).
test.skip("G5 the Activity screen and the inspector render a reply as markdown, never as markup", async (t) => {
  const { page, errors } = await onPage(t, { provider: scripted });
  await page.locator("#prompt").fill("do the thing");
  await page.locator("#chat-form").evaluate((form) => form.requestSubmit());
  await page.locator('#conversation .markdown h2').first().waitFor();
  await openPlace(page, "runs");
  const card = page.locator("#runs-list .item").first();
  await card.locator(".markdown h2").waitFor();
  assert.equal(await card.locator(".markdown h2").textContent(), "What I did");
  assert.equal(await card.locator(".markdown strong").first().textContent(), "two");
  assert.equal(await card.locator(".markdown code").first().textContent(), "answer = 42");
  assert.equal(await card.locator(".markdown li").count(), 2, "the list is a real list");

  await card.getByRole("button", { name: "Look inside", exact: true }).first().click();
  const panel = page.locator("#inspect-panel");
  await panel.locator(".markdown h2").first().waitFor();
  assert.equal(await panel.locator(".markdown h2").first().textContent(), "What I did");
  assert.deepEqual(errors, []);
});

// Redesign: Coming soon (the Language select, sw:lang in Settings › Appearance), checked at ef021c57.
test.skip("G5 Appearance is written in French when French is chosen", async (t) => {
  const { page, errors } = await onPage(t);
  await openSettingFor(page, "#appearance-language");
  assert.equal(await page.locator("#settings-form h2").textContent(), "Appearance");
  assert.equal(await page.locator("#accent-choices .choice").first().textContent(), "Copper");
  await page.locator("#appearance-language").selectOption("fr");
  await page.waitForFunction(() => document.querySelector("#settings-form h2").textContent === "Apparence");
  assert.equal(await page.locator("#accent-label").textContent(), "Couleur de mise en avant");
  assert.equal(await page.locator("#accent-choices .choice").first().textContent(), "Cuivre");
  assert.equal(await page.locator("#text-size-label").textContent(), "Taille du texte");
  assert.equal(await page.locator("#settings-form button[data-t='appearance.save']").textContent(), "Enregistrer l'apparence");
  assert.deepEqual(errors, []);
});

test("G5 every key the page names has words in both languages", async () => {
  const dir = new URL("../public/", import.meta.url);
  const en = JSON.parse(await readFile(new URL("locales/en.json", dir), "utf8"));
  const fr = JSON.parse(await readFile(new URL("locales/fr.json", dir), "utf8"));
  const html = await readFile(new URL("index.html", dir), "utf8");
  const used = new Set([...html.matchAll(/data-t(?:-label|-placeholder|-title)?="([^"]+)"/g)].map((m) => m[1]));
  const missing = [...used].filter((key) => !(key in en));
  assert.deepEqual(missing, [], "these keys are named in the page but have no English words");
  const untranslated = Object.keys(en).filter((key) => !(key in fr));
  assert.deepEqual(untranslated, [], "these keys have no French words");
});

test("G6 typing /model with the models module blocked still lists the choices", async (t) => {
  /* Redesign: the new message box (public/app/chat/chat.js) has no models module to block; a recognised command is
     run, not sent to the model as a message (design doc 4.3, Slash commands). The old toast's words are replaced by
     the new window; what the command does is checked. */
  const { page, errors } = await onPage(t, { block: ["/model-profiles.js"] });
  const runs = [], commands = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/api/run")) runs.push(request.postData());
    if (request.url().endsWith("/api/commands/run")) commands.push(request.postData());
  });
  await page.locator("#prompt").fill("/model");
  await page.locator("#composer").evaluate((form) => form.requestSubmit());
  await page.waitForFunction(() => document.getElementById("prompt").value === "", null, { timeout: 10000 });
  await page.waitForFunction(() => !document.getElementById("send").disabled, null, { timeout: 20000 });
  assert.equal(await page.locator("#prompt").inputValue(), "", "the command is not left in the box");
  assert.deepEqual(runs, [], "nothing was sent to the model");
  assert.equal(await page.locator("#conversation .u").count(), 0, "nothing was sent to the model");

  await page.locator("#prompt").fill("/help");
  await page.locator("#composer").evaluate((form) => form.requestSubmit());
  await page.waitForFunction(() => !document.getElementById("send").disabled, null, { timeout: 20000 });
  assert.deepEqual(runs, [], "/help is not sent to the model either");
  assert.ok(commands.length >= 1, "the commands went to the engine's command route");
  assert.deepEqual(errors, []);
});
