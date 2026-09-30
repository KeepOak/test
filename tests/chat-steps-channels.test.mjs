/**
 * The steps in every chat app Branch has (src/channels/steps-caps.ts): each of the 56 adapters is built with stand-in
 * settings (tests/chat-steps-adapters.mjs), its row in the capability table is checked against the adapter itself, and
 * one fixed task (tests/chat-steps-fixture.mjs) is rendered the way the router sends it there: one message edited in
 * place with code where the app edits, one summary line in plain words where it cannot, nothing where each message
 * costs money. The apps that send over the web with a stand-in chat address carry those exact words to the wire.
 * Then, through the router, the per-app knobs: an app turned off, a message a step on an app that cannot edit, and no
 * steps message in a group. Every service is a stand-in on this computer.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { compactSummary, fenced, matrixHtml, pageChatSteps, telegramEntities } from "../dist/channels/progress-render.js";
import { STEPS_CAPS, stepsBehaviour, stepsCapsTable } from "../dist/channels/steps-caps.js";
import { stepsDisplayDefaults } from "../dist/channels/steps-display.js";
import { STEP_ICONS } from "../dist/live-steps.js";
import { everyAdapter } from "./chat-steps-adapters.mjs";
import { screenshotView } from "./chat-steps-fixture.mjs";

const adapters = await everyAdapter();
/** The apps whose send goes straight to a web address with a stand-in chat, so their wire can be read here. */
const OVER_THE_WEB = ["gotify", "webex", "flock", "pumble", "mastodon", "nextcloud-talk", "ntfy", "homeassistant", "guilded", "revolt",
  "mattermost", "rocketchat", "googlechat", "msteams", "feishu", "dingtalk", "wecom", "line", "viber", "telegram", "discord"];

test("the capability table has one row for each of the 56 chat adapters, and each row says what its adapter does", () => {
  const kinds = adapters.map((one) => one.kind).sort();
  assert.equal(kinds.length, 56);
  assert.deepEqual(STEPS_CAPS.map((caps) => caps.kind).sort(), kinds, "no adapter without a row, no row without an adapter");
  for (const { kind, adapter } of adapters) {
    const caps = STEPS_CAPS.find((row) => row.kind === kind);
    assert.equal(caps.edit, !!adapter.edit, `${kind}: edits`);
    assert.equal(caps.reactions, !!adapter.react, `${kind}: reactions`);
    assert.equal(caps.typing, !!adapter.sendTyping, `${kind}: typing`);
    assert.equal(caps.maxText, adapter.maxTextLength ?? 3500, `${kind}: longest message`);
    assert.equal(!!caps.paid, !!adapter.paidPerMessage, `${kind}: paid per message`);
    if (caps.edit) assert.equal(typeof adapter.deleteMessage, "function", `${kind}: an app that edits can remove the steps too`);
    assert.equal(caps.code !== "plain", ["telegram", "discord", "slack", "matrix"].includes(kind), `${kind}: code only where the adapter renders it`);
  }
});

/** What the router sends for the fixed task in one app, with the knobs as shipped. */
function sentFor(caps) {
  const view = screenshotView(), limit = Math.min(caps.maxText, 3500);
  if (caps.paid) return { behaviour: stepsBehaviour(caps, stepsDisplayDefaults), messages: [] };
  if (caps.edit) return { behaviour: stepsBehaviour(caps, stepsDisplayDefaults), messages: pageChatSteps(view, { limit, final: "done" }) };
  return { behaviour: stepsBehaviour(caps, stepsDisplayDefaults), messages: [{ text: compactSummary(view, "done"), spans: [] }] };
}
const wire = { telegram: (m) => JSON.stringify(telegramEntities(m.spans)), discord: (m) => fenced(m.text, m.spans, { tag: true }),
  slack: (m) => fenced(m.text, m.spans, { tag: false }), matrix: (m) => matrixHtml(m.text, m.spans) };

test("every app: the fixed task as it goes out there, within the app's own length, in code only where the app has it", () => {
  const seen = new Map();
  for (const caps of STEPS_CAPS) {
    const { behaviour, messages } = sentFor(caps);
    seen.set(behaviour, (seen.get(behaviour) ?? 0) + 1);
    if (caps.paid) { assert.deepEqual(messages, [], `${caps.kind}: nothing added where each message costs money`); continue; }
    assert.ok(messages.length >= 1, caps.kind);
    for (const message of messages) {
      assert.ok(message.text.length <= caps.maxText, `${caps.kind}: ${message.text.length} > ${caps.maxText}`);
      if (caps.code === "plain") {
        assert.deepEqual(message.spans, [], `${caps.kind}: plain words`);
        assert.match(message.text, new RegExp(`^${STEP_ICONS.find}×4 ${STEP_ICONS.command}×2 .* · ${STEP_ICONS.done} Done · 13 steps · 42 s$`), caps.kind);
        assert.doesNotMatch(message.text, /MEMORY\.md|python3|workspace\//, `${caps.kind}: the summary names no file or command`);
      } else {
        const marked = wire[caps.kind](message);
        if (caps.code === "telegram") assert.match(marked, /"type":"pre".*"language":"shell"/);
        if (caps.code === "fence") assert.match(marked, /```shell\n/);
        if (caps.code === "fence-plain") assert.ok(marked.includes("```\n") && !marked.includes("```shell"), caps.kind);
        if (caps.code === "html") assert.match(marked, /<pre><code class="language-shell">/);
      }
    }
    if (caps.edit) assert.ok(messages.at(-1).text.endsWith("Done · 13 steps · 42 s"), caps.kind);
  }
  assert.deepEqual(Object.fromEntries(seen), {
    "One message, edited in place, a new one when it is full": 4,
    "One summary line above the reply (plain words)": 51,
    "Nothing added: each message costs money": 1,
  });
});

test("the apps that send over the web carry the steps' exact words to the wire, with no marks added in plain apps", async () => {
  for (const kind of OVER_THE_WEB) {
    const { adapter, calls } = adapters.find((one) => one.kind === kind);
    const caps = STEPS_CAPS.find((row) => row.kind === kind);
    const [message] = sentFor(caps).messages;
    calls.length = 0;
    await adapter.send("room", message.text, undefined, message.spans.length ? { spans: message.spans } : {});
    const carried = calls.map((call) => call.raw + JSON.stringify(call.body ?? "")).join("\n");
    const words = caps.code === "plain" ? message.text : message.text.split("\n")[0];
    assert.ok(carried.includes(JSON.stringify(words).slice(1, -1)) || carried.includes(encodeURIComponent(words)) || carried.includes(words), `${kind}: ${carried.slice(0, 300)}`);
    if (caps.code === "plain") assert.ok(!/```|<pre>|<code>/.test(carried), `${kind}: no code marks in an app without code`);
  }
});

test("docs/chat-parity.md holds the capability table exactly as the code has it", async () => {
  const { readFile } = await import("node:fs/promises");
  const doc = await readFile(new URL("../docs/chat-parity.md", import.meta.url), "utf8");
  const start = "<!-- steps-caps:start -->", end = "<!-- steps-caps:end -->";
  const inDoc = doc.slice(doc.indexOf(start) + start.length, doc.indexOf(end)).replace(/\r\n/g, "\n").trim();
  assert.equal(inDoc, stepsCapsTable(stepsDisplayDefaults), "regenerate the table from src/channels/steps-caps.ts");
});

// ---- through the router: the knobs for one app -----------------------------------------------------------------------

async function world(t, parts = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-steps-channels-"));
  await mkdir(join(root, "workspace"), { recursive: true });
  await writeFile(join(root, "workspace", "notes.md"), "ship it\n");
  const provider = { name: "scripted", async complete(request) {
    const lastUser = request.messages.findLastIndex((m) => m.role === "user");
    const tools = request.messages.slice(lastUser + 1).filter((m) => m.role === "tool").length;
    await delay(40);
    if (tools < 2) return { content: "", toolCalls: [{ id: `c${tools}`, name: tools ? "files.list" : "files.read", arguments: JSON.stringify(tools ? { path: "." } : { path: "notes.md" }) }] };
    return { content: "Ship it.", toolCalls: [] };
  } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  t.after(async () => { await app.close(); await discardTemp(root); });
  app.channels.mergeWindowMs = 0;
  app.channels.liveTiming = { progressAfterMs: 0, editEveryMs: 10, typingEveryMs: 50, reactEveryMs: 5 };
  app.channels.groupEditEveryMs = 10;
  app.channels.setSwitches({ liveStatus: "on", steps: "on" });
  const sent = [];
  const adapter = { id: "app1", kind: "fake", botName: () => "B", async start() {}, async stop() {},
    async send(chatId, words) { sent.push(words); return String(sent.length); }, ...parts(sent) };
  await app.channels.attach(adapter, { activation: "always", pairing: false, allowlist: ["owner"] });
  const say = (words, extra = {}) => app.channels.handle({ channel: "app1", chatId: "c1", chatKind: "direct", senderId: "owner", senderName: "Sam",
    text: words, addressed: true, messageId: `m${Math.random()}`, ...extra });
  return { app, sent, say };
}
const editing = (sent) => ({ async edit(chatId, id, words) { sent.push(`edit:${words}`); }, async sendTyping() {} });

test("an app turned off shows no steps message while every other app keeps them", async (t) => {
  const { app, sent, say } = await world(t, editing);
  app.channels.setStepsSettings({ apps: { app1: { detail: "off" } } });
  assert.equal(await say("check the notes"), "replied");
  assert.ok(sent.every((words) => !words.includes("Reading notes.md")), sent.join(" | "));
  assert.equal(sent.at(-1), "Ship it.");
});

test("an app that cannot edit, set to a message a step, gets each step as its own message, then the reply", async (t) => {
  const { app, sent, say } = await world(t, () => ({}));
  app.channels.setStepsSettings({ all: { noEdit: "each" } });
  await say("check the notes");
  assert.ok(sent.some((words) => words === `${STEP_ICONS.read} Reading notes.md`), sent.join(" | "));
  assert.ok(sent.every((words) => !words.startsWith("edit:")));
  assert.equal(sent.at(-1), "Ship it.", "the reply, with no summary line as well");
});

test("no steps message in groups when the owner turns group counts off", async (t) => {
  const { app, sent, say } = await world(t, editing);
  app.channels.setStepsSettings({ all: { groups: "off" } });
  await say("check the notes", { chatKind: "group", chatTitle: "Team" });
  assert.deepEqual(sent.filter((words) => words !== "Ship it."), [], sent.join(" | "));
});
