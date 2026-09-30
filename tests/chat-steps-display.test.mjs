/**
 * Settings › Chat apps › Show steps in chats: the knobs behind the Hermes Agent-style steps message
 * (src/channels/steps-display.ts), how one fixed task renders with them (src/channels/progress-render.ts), what each of
 * the four apps that edit in place puts on the wire, and the steps message going on in a new message, one a step, and
 * removed after a good answer (src/channels/live-status.ts). Every service is a stand-in on this computer.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, DiscordAdapter, MatrixAdapter, SlackAdapter, TelegramAdapter } from "../dist/index.js";
import { pageChatSteps, renderChatSteps } from "../dist/channels/progress-render.js";
import { LiveStatus } from "../dist/channels/live-status.js";
import { saveStepsSettings, stepsDisplayDefaults, stepsDisplayFor, stepsSettings } from "../dist/channels/steps-display.js";
import { STEP_ICONS } from "../dist/live-steps.js";
import { heredoc, longPattern, screenshotView } from "./chat-steps-fixture.mjs";

const fast = { progressAfterMs: 5, editEveryMs: 10, typingEveryMs: 50, reactEveryMs: 5 };
async function until(check, label, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const value = await check(); if (value) return value; await delay(5); }
  assert.fail(`Timed out: ${label}`);
}
async function branch(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-steps-display-"));
  const app = await createBranch({ workspace: join(root, "w"), dataDir: join(root, "d"),
    provider: { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } } });
  t.after(async () => { await app.close(); await discardTemp(root); });
  return app;
}
/** A stand-in web service that records every call and answers with a new id. */
function service(answer = (n) => ({ ok: true, result: { message_id: n } })) {
  const calls = [];
  return { calls, fetch: async (url, init) => {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
    calls.push({ url: String(url), method: init?.method ?? "GET", body });
    return new Response(JSON.stringify(answer(calls.length, url)), { status: 200, headers: { "content-type": "application/json" } });
  } };
}

// ---- the knobs ----------------------------------------------------------------------------------------------------

test("every knob ships on; an app's own knobs win over every app's, its id over its kind; null follows every app again", async (t) => {
  const app = await branch(t), owner = app.runtime.owner;
  assert.deepEqual(stepsDisplayDefaults, { detail: "all", grouping: "one", lineChars: 120, commands: "show", overflow: "roll",
    cleanup: false, noEdit: "summary", groups: "kinds", pictures: "browser" });
  assert.deepEqual(stepsDisplayFor(stepsSettings(app.store, owner), { id: "telegram", kind: "telegram" }), stepsDisplayDefaults);
  saveStepsSettings(app.store, owner, { all: { detail: "new", lineChars: 80 }, apps: { telegram: { detail: "verbose" }, "tg-work": { detail: "off" } } });
  const settings = stepsSettings(app.store, owner);
  assert.equal(stepsDisplayFor(settings, { id: "telegram", kind: "telegram" }).detail, "verbose");
  assert.equal(stepsDisplayFor(settings, { id: "tg-work", kind: "telegram" }).detail, "off", "the connection's id wins over its kind");
  assert.equal(stepsDisplayFor(settings, { id: "discord", kind: "discord" }).detail, "new", "every app's choice");
  assert.equal(stepsDisplayFor(settings, { id: "telegram", kind: "telegram" }).lineChars, 80, "a knob the app did not set follows every app");
  saveStepsSettings(app.store, owner, { apps: { "tg-work": null } });
  assert.equal(stepsDisplayFor(stepsSettings(app.store, owner), { id: "tg-work", kind: "telegram" }).detail, "verbose", "back to its kind's");
  for (const bad of [{ all: { lineChars: 39 } }, { all: { lineChars: 401 } }, { all: { detail: "loud" } }, { apps: { "Bad Name": { detail: "all" } } }, { every: {} }])
    assert.throws(() => saveStepsSettings(app.store, owner, bad), undefined, JSON.stringify(bad));
});

test("the settings route reads and saves the knobs, and says what each connected app will show", async (t) => {
  const app = await branch(t);
  const adapter = { id: "wa", kind: "whatsapp", botName: () => "B", async start() {}, async stop() {}, async send() { return "1"; } };
  await app.channels.attach(adapter, { activation: "always", pairing: false, allowlist: ["*"] });
  assert.equal(app.channels.summary().steps.apps[0].shows, "One summary line above the reply (plain words)");
  app.channels.setStepsSettings({ apps: { whatsapp: { noEdit: "each" } } });
  assert.equal(app.channels.stepsView().apps[0].shows, "A message per step (plain words)");
});

// ---- one task, rendered ---------------------------------------------------------------------------------------------

test("the screenshot's task: an emoji per kind, commands as shell code (first line only), paths as code, repeats folded", () => {
  const { text, spans } = renderChatSteps(screenshotView(), { limit: 3500, final: "done" });
  const lines = text.split("\n");
  assert.equal(lines[0], `${STEP_ICONS.find} Searching files for state.db`);
  assert.equal(lines[2], `${STEP_ICONS.command} Running`);
  assert.equal(lines[3], "python3 - <<'PY' …", "a heredoc shows its first line and says there is more");
  assert.ok(lines.includes(`${STEP_ICONS.find} Searching files for website-pusher (×2)`));
  assert.ok(lines.includes(`${STEP_ICONS.process} Checking proc_21edec94482`));
  assert.ok(lines.includes(`${STEP_ICONS.edit} Editing notes/routes.md`));
  assert.equal(lines.at(-1), `${STEP_ICONS.done} Done · 13 steps · 42 s`);
  const code = spans.map((span) => [span.kind, span.language ?? "", text.slice(span.offset, span.offset + span.length)]);
  assert.deepEqual(code.filter(([kind]) => kind === "block").map(([, language, words]) => [language, words]),
    [["shell", "python3 - <<'PY' …"], ["python", "from hermes_tools import write_file …"], ["shell", "ps -o pid,ppid,stat,etime,%cpu,%mem,command -p 4242"]]);
  assert.ok(code.some(([kind, , words]) => kind === "inline" && words === "MEMORY.md"));
  assert.deepEqual([STEP_ICONS.find, STEP_ICONS.edit, STEP_ICONS.process], ["🔎", "🔧", "⚙️"], "Hermes Agent's own pictures");
});

test("line length: a sentence is cut at its end, a path in the middle so its file name stays, a command at its end", () => {
  const { text, spans } = renderChatSteps(screenshotView(), { limit: 3500, lineChars: 50 });
  const lines = text.split("\n");
  const search = lines.find((line) => line.includes("repair-routing"));
  assert.ok(search.endsWith("…") && search.length <= 50 + "🔎 ".length && !search.includes("SessionDB"), search);
  const path = spans.find((span) => span.kind === "inline" && text.slice(span.offset, span.offset + span.length).includes("…"));
  const shown = text.slice(path.offset, path.offset + path.length);
  assert.ok(shown.startsWith("workspace/") && shown.endsWith("route-repair.py"), shown);
  assert.ok(lines.includes("ps -o pid,ppid,stat,etime,%cpu,%mem,command -p 42…"));
  assert.ok(!text.includes(longPattern));
});

test("detail: changes only drops a repeat of the same tool; everything shows whole commands and each tool's input", () => {
  const changes = renderChatSteps(screenshotView(), { limit: 3500, detail: "new" }).text;
  assert.equal((changes.match(/Searching files/g) ?? []).length, 2, "the second of two searches in a row is left out");
  assert.ok(!changes.includes("USER.md"), "a read right after a read is left out");
  const verbose = renderChatSteps(screenshotView(), { limit: 3500, detail: "verbose" });
  assert.ok(verbose.text.includes(heredoc), "the whole heredoc");
  assert.ok(verbose.text.includes('"content":"print(1)"'), "the tool's input as code");
  assert.ok(verbose.spans.some((span) => span.language === "json"));
  const hidden = renderChatSteps(screenshotView(), { limit: 3500, commands: "hide" });
  assert.ok(!hidden.text.includes("python3 - <<") && hidden.text.includes(`${STEP_ICONS.command} Running a command`));
});

test("a list too long for one message carries on in the next, nothing lost; each puts one step a message; trim keeps the newest", () => {
  const pages = pageChatSteps(screenshotView(), { limit: 300, final: "done" });
  assert.ok(pages.length >= 2);
  for (const page of pages) {
    assert.ok(page.text.length <= 300, `${page.text.length}`);
    for (const span of page.spans) assert.ok(span.offset + span.length <= page.text.length);
  }
  const all = renderChatSteps(screenshotView(), { limit: 3500, final: "done" }).text;
  assert.equal(pages.map((page) => page.text).join("\n"), all, "the pages are the whole list, in order");
  assert.ok(pages.at(-1).text.endsWith("Done · 13 steps · 42 s"));
  const each = pageChatSteps(screenshotView(), { limit: 3500, each: true, final: "done" });
  assert.equal(each.length, 12, "twelve lines (the two searches folded), no ending line");
  const trimmed = renderChatSteps(screenshotView(), { limit: 300, final: "done" }).text;
  assert.match(trimmed, /^\(\d+ earlier\)/);
});

// ---- the four apps that edit, on the wire ------------------------------------------------------------------------

const rendered = () => renderChatSteps(screenshotView(), { limit: 3500, final: "done" });

test("Telegram: a pre entity labelled shell for a command, code for a path, quiet", async () => {
  const api = service();
  const telegram = new TelegramAdapter({ id: "telegram", token: "1:not-a-real-secret", apiBase: "http://telegram.test", fetch: api.fetch });
  const { text, spans } = rendered();
  await telegram.send("5", text, undefined, { spans, quiet: true });
  const sent = api.calls.find((call) => call.url.endsWith("/sendMessage")).body;
  assert.equal(sent.text, text);
  assert.equal(sent.disable_notification, true);
  const entity = (words) => sent.entities.find((one) => text.slice(one.offset, one.offset + one.length) === words);
  assert.deepEqual({ ...entity("python3 - <<'PY' …") }, { type: "pre", offset: text.indexOf("python3 - <<"), length: 18, language: "shell" });
  assert.equal(entity("MEMORY.md").type, "code");
});

test("Discord: fences with the language; Slack: fences without one; Matrix: HTML code", async () => {
  const { text, spans } = rendered();
  const discordApi = service(() => ({ id: "m1" }));
  await new DiscordAdapter({ id: "discord", token: "not-a-real-secret", apiBase: "http://discord.test/api", fetch: discordApi.fetch })
    .send("c1", text, undefined, { spans, quiet: true });
  const content = discordApi.calls[0].body.content;
  assert.ok(content.includes("```shell\npython3 - <<'PY' …\n```"), content);
  assert.ok(content.includes("`MEMORY.md`"));
  const slackApi = service(() => ({ ok: true, ts: "1.1" }));
  await new SlackAdapter({ id: "slack", token: "not-a-real-secret", appToken: "not-a-real-secret", apiBase: "http://slack.test/api", fetch: slackApi.fetch })
    .send("C1", text, undefined, { spans });
  const posted = slackApi.calls.find((call) => call.url.endsWith("/chat.postMessage")).body.text;
  assert.ok(posted.includes("```\npython3 - &lt;&lt;'PY' …\n```") || posted.includes("```\npython3 - <<'PY' …\n```"), posted);
  assert.ok(!posted.includes("```shell"), "Slack would print the language as a line of code");
  const matrixApi = service(() => ({ event_id: "$e1" }));
  await new MatrixAdapter({ id: "matrix", homeserver: "http://matrix.test", accessToken: "not-a-real-secret", userId: "@b:matrix.test", fetch: matrixApi.fetch })
    .send("!room:matrix.test", text, undefined, { spans });
  const html = matrixApi.calls[0].body.formatted_body;
  assert.ok(html.includes(`<pre><code class="language-shell">python3 - &lt;&lt;'PY' …</code></pre>`), html);
  assert.ok(html.includes("<code>MEMORY.md</code>"));
});

// ---- the steps message over a task -----------------------------------------------------------------------------------

/** A stand-in app that can edit and remove, recording every call. */
function editingApp({ edit = true } = {}) {
  const log = [];
  let next = 0;
  return { log, adapter: { id: "chat", kind: "chat", maxTextLength: 300,
    async send(chatId, text, reply, format) { log.push({ op: "send", text, reply, quiet: format?.quiet }); return `m${++next}`; },
    ...(edit ? { async edit(chatId, id, text) { log.push({ op: "edit", id, text }); } } : {}),
    async deleteMessage(chatId, id) { log.push({ op: "delete", id }); } } };
}
function source(view, options) {
  return { render: (limit, final) => renderChatSteps(view(), { limit, ...(final ? { final } : {}) }),
    pages: (limit, final) => pageChatSteps(view(), { limit, ...options, ...(final ? { final } : {}) }), each: options.each === true };
}

test("roll: the first message fills, the list goes on in a second, and only the changed message is edited", async () => {
  const { log, adapter } = editingApp();
  const steps = screenshotView().steps;
  let shown = 3;
  const live = new LiveStatus({ adapter, chatId: "c", messageId: "q" }, async (text) => ({ text, blocked: false }), fast, false,
    source(() => ({ steps: steps.slice(0, shown), seconds: 42 }), {}), true);
  live.start(); live.thinking();
  await until(() => log.some((one) => one.op === "send"), "the first message");
  assert.equal(log[0].reply, "q", "the steps answer the person's message");
  assert.equal(log[0].quiet, true);
  shown = steps.length;
  live.event("tool.started", { id: "x", name: "memory.save", label: "Updating memory" });
  await until(() => log.filter((one) => one.op === "send").length === 2, "a second message for the rest");
  await live.finish("done");
  await until(() => log.at(-1)?.text?.endsWith("Done · 13 steps · 42 s"), "the ending on the last message");
  const second = log.filter((one) => one.op === "send")[1];
  assert.equal(second.reply, undefined, "the second continues the list rather than replying again");
  assert.ok(log.filter((one) => one.op === "edit").every((one) => one.text.length <= 300));
  await live.remove();
  assert.deepEqual(log.filter((one) => one.op === "delete").map((one) => one.id), ["m1", "m2"], "cleanup removes every steps message");
});

test("each: a message per step, never edited, also on an app that cannot edit", async () => {
  const { log, adapter } = editingApp({ edit: false });
  const steps = screenshotView().steps;
  let shown = 1;
  const live = new LiveStatus({ adapter, chatId: "c", messageId: "q" }, async (text) => ({ text, blocked: false }), fast, false,
    source(() => ({ steps: steps.slice(0, shown), seconds: 1 }), { each: true }), true);
  live.start(); live.thinking();
  await until(() => log.length === 1, "the first step");
  shown = 3;
  live.event("tool.started", { id: "y", name: "shell.execute" });
  await until(() => log.length === 3, "the next steps, each as its own message");
  await live.finish("done");
  await delay(50);
  assert.equal(log.length, 3, "no ending message and no edit");
  assert.ok(log.every((one) => one.op === "send"), JSON.stringify(log));
  assert.equal(log[2].text, `${STEP_ICONS.command} Running\npython3 - <<'PY' …`);
});
