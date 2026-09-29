/**
 * defaulttrunk: a default Trunk ships with the app, and talking to Branch from nowhere is a thread with it, like
 * iMessage. Exactly one default while any Trunk exists; the window's new conversation and a chat app's chat with no
 * routing of their own go to it; each chat keeps ONE thread and "/new" or "/reset" starts a fresh one, the old kept; and
 * the default's turn is the owner's own (memory, tools, reach), with only its name and persona added.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { startServer } from "../dist/server.js";
import { saveOnboarding } from "../dist/onboarding.js";
import { defaultTrunkId } from "../dist/trunks/defaults.js";
import { chatThread } from "../dist/channels/threads.js";
import { narrowTrunk } from "../dist/trunks/restore-narrow.js";
import { fixture, on, setupTrunk } from "./trunks-helpers.mjs";

function fakeChat(id = "chat") {
  const sent = [];
  const adapter = { id, kind: "fake", botName: () => "Branch", async start() {}, async stop() {},
    async send(chatId, text) { sent.push({ chatId, text }); return String(sent.length); } };
  return { adapter, sent };
}
async function withChat(t, app, id = "chat") {
  app.channels.mergeWindowMs = 0;
  const chat = fakeChat(id);
  await app.channels.attach(chat.adapter, { activation: "always", pairing: false, allowlist: ["sam"] });
  t.after(() => app.channels.detachAll());
  let next = 1;
  const say = async (text, chatId = "c1") => {
    await app.channels.handle({ channel: id, chatId, chatKind: "direct", senderId: "sam", senderName: "Sam", text, addressed: true, messageId: `m${next++}` });
    return chatThread(app.store, app.runtime.owner, id, chatId);
  };
  return { chat, say };
}
const setupOver = (app) => saveOnboarding(app.store, app.runtime.owner, { done: true });

test("exactly one default while any Trunk exists: the first, the owner's pick, the next when it goes; a file's Trunk never by itself", async (t) => {
  const { app } = await fixture(t);
  on(app);
  assert.equal(app.trunks.defaultTrunk(), undefined, "no Trunk, no default");
  const ada = setupTrunk(app, { name: "Ada" }), bo = app.trunks.create({ name: "Bo" });
  await app.trunks.introduced();
  setupOver(app);
  assert.equal(app.trunks.defaultTrunk().id, ada.id, "the first Trunk (setup's) is the default");
  assert.equal(defaultTrunkId(app.store, app.runtime.owner), ada.id);
  app.trunks.setDefault(bo.id);
  assert.equal(app.trunks.defaultTrunk().id, bo.id);
  assert.equal(app.store.audit.list(app.runtime.owner, { action: "trunk.default" }).length >= 1, true, "the pick is written down");
  app.trunks.remove(bo.id);
  assert.equal(app.trunks.defaultTrunk().id, ada.id, "removing the default hands it on at once");
  app.trunks.remove(ada.id);
  assert.equal(app.trunks.defaultTrunk(), undefined);
  // A Trunk brought in from a file is never the default by being oldest; the owner may still pick it.
  const file = { format: "branch-trunk/1", exportedAt: new Date().toISOString(), trunk: { name: "Imported" } };
  const imported = app.trunks.importFile(file);
  assert.equal(app.trunks.defaultTrunk(), undefined, "a file's Trunk is not the default by itself");
  setupOver(app);
  const made = app.trunks.ensureDefault();
  assert.ok(made && made.id !== imported.id, "the engine makes a default of its own instead");
  assert.equal(app.trunks.ensureDefault().id, made.id, "and only one");
  // Whatever happens, there is never more than one.
  for (let i = 0; i < 6; i++) {
    const trunk = app.trunks.create({ name: `T${i}` });
    if (i % 2) app.trunks.setDefault(trunk.id);
    if (i % 3 === 2) app.trunks.remove(app.trunks.defaultTrunk().id);
    const ids = app.trunks.records.list().map((one) => one.id);
    assert.equal(ids.filter((id) => id === app.trunks.defaultTrunk()?.id).length, ids.length ? 1 : 0);
  }
  await app.trunks.introduced();
});

test("the engine makes the default quietly once setup is over or skipped, never before, and never with a model call", async (t) => {
  const { app, provider } = await fixture(t);
  assert.equal(app.trunks.ensureDefault(), null, "setup not over: setup's own first Trunk will be the default");
  saveOnboarding(app.store, app.runtime.owner, { skipped: true });
  const calls = provider.requests.length;
  const made = app.trunks.ensureDefault();
  assert.equal(made.name, "Branch Agent", "named as the owner's assistant is named");
  assert.equal(provider.requests.length, calls, "no introduction is asked of a model");
  // QA 2026-09-28 (Pass 2): its conversation opens with a written greeting, as a template Trunk's does, still asking no model.
  assert.deepEqual(app.store.messages(made.chatSessionId).map((m) => m.role), ["assistant"], "one greeting");
  assert.match(app.store.messages(made.chatSessionId)[0].content, /^Hi, I'm Branch Agent\./);
  assert.equal(app.trunks.ensureDefault().id, made.id);
  assert.equal(app.store.messages(made.chatSessionId).length, 1, "greeted once");
  // With Trunks switched off there is no default and nothing is made.
  app.trunks.setMode("trunks", { mode: "off" });
  assert.equal(app.trunks.ensureDefault(), null);
});

test("the window's new conversation is a thread with the default Trunk; a temporary one stays nobody's", async (t) => {
  const { app, root } = await fixture(t);
  setupOver(app);
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(() => server.close());
  const post = async (path, body) => (await fetch(server.url + path, { method: "POST",
    headers: { authorization: `Bearer ${server.token}`, origin: server.url, "content-type": "application/json" }, body: JSON.stringify(body) })).json();
  await post("/api/onboarding", { done: true }); // trusted setup settles authority; run routing never does
  const run = await post("/api/run", { prompt: "hello" });
  const home = app.trunks.defaultTrunk();
  assert.ok(home, "trusted setup created the default before task routing");
  assert.equal(app.trunks.trunkForConversation(run.sessionId)?.trunkId, home.id);
  assert.equal(app.trunks.conversations.kind(run.sessionId), "trunk");
  const again = await post("/api/run", { prompt: "and again", sessionId: run.sessionId });
  assert.equal(again.sessionId, run.sessionId);
  const temp = await post("/api/run", { prompt: "just this once", temporary: true });
  assert.equal(app.trunks.trunkForConversation(temp.sessionId), undefined, "a temporary conversation is nobody's thread");
  const list = await (await fetch(`${server.url}/api/sessions?limit=10`, { headers: { authorization: `Bearer ${server.token}`, origin: server.url } })).json();
  assert.equal(list.sessions.find((s) => s.sessionId === run.sessionId)?.trunkId, home.id, "the list says whose thread it is");
  const trunks = await (await fetch(`${server.url}/api/trunks`, { headers: { authorization: `Bearer ${server.token}`, origin: server.url } })).json();
  assert.equal(trunks.defaultId, home.id);
});

test("the default's turn is the owner's own: the same memory scope and tools as a conversation with nobody, plus who it is", async (t) => {
  const { app, provider } = await fixture(t);
  on(app, "messages");
  setupOver(app);
  const plain = app.runtime.trunkShape({ prompt: "x" });
  assert.equal(plain, null);
  const main = setupTrunk(app, { name: "Main" }), other = app.trunks.create({ name: "Other" });
  await app.trunks.introduced();
  app.trunks.ensureDefault(); // trusted setup settlement records the authority designation
  const shape = app.runtime.trunkShape({ prompt: "x", trunkId: main.id });
  assert.equal(shape.owners, true);
  assert.equal(shape.keepsReach, true, "the owner's reach is left exactly as it was");
  const run = await app.runtime.run({ prompt: "remember this", trunkId: main.id });
  const turn = app.store.events(run.id).find((e) => e.kind === "trunk.turn");
  assert.equal(turn.data.trunkId, main.id);
  const tools = (request) => (request.tools ?? []).map((tool) => tool.name).sort();
  const asDefault = tools(provider.requests.at(-1));
  await app.runtime.run({ prompt: "remember this" });
  const asNobody = tools(provider.requests.at(-1));
  assert.deepEqual(asDefault, asNobody, "the default Trunk is given exactly the tools a conversation with nobody is");
  const system = provider.requests.at(-2).messages.find((m) => m.role === "system").content;
  assert.match(system, /You are Main \(@main\), the owner's own assistant/);
  // Another Trunk is still narrowed as before: its own memory, no commands.
  const narrow = app.runtime.trunkShape({ prompt: "x", trunkId: other.id });
  assert.equal(narrow.owners, undefined);
  assert.equal(narrow.agent, `trunk:${other.id}`);
  assert.ok(!narrow.permissions.includes("shell.execute"));
});

test("a chat with no routing keeps ONE thread with the default; /new and /reset start a fresh one and keep the old", async (t) => {
  const { app } = await fixture(t);
  setupOver(app);
  app.trunks.ensureDefault(); // trusted setup boundary, before external chat resolution
  const { say, chat } = await withChat(t, app);
  const first = await say("hi");
  const home = app.trunks.defaultTrunk();
  assert.equal(first.trunkId, home.id);
  assert.equal(app.trunks.trunkForConversation(first.sessionId).trunkId, home.id);
  await say("how are you");
  const third = await say("and now");
  assert.equal(third.sessionId, first.sessionId, "every message carries on the same conversation");
  assert.equal(app.store.messages(first.sessionId).filter((m) => m.role === "user").length, 3);
  await say("/new");
  assert.match(chat.sent.at(-1).text, /next message starts a new conversation/, JSON.stringify(chat.sent.at(-1)));
  const fresh = await say("start over");
  assert.notEqual(fresh.sessionId, first.sessionId);
  assert.deepEqual(fresh.earlier, [first.sessionId], "the old thread is kept");
  assert.equal(app.store.messages(first.sessionId).length > 0, true, "and nothing of it was deleted");
  await say("/reset");
  const after = await say("once more");
  assert.deepEqual(after.earlier, [fresh.sessionId, first.sessionId]);
  // Another chat is another thread.
  const other = await say("hello from elsewhere", "c2");
  assert.notEqual(other.sessionId, after.sessionId);
});

test("a chat's binding wins over the default; a bound Trunk answers only where it may reach, the default everywhere", async (t) => {
  const { app } = await fixture(t);
  on(app);
  setupOver(app);
  const main = app.trunks.create({ name: "Main" }), io = app.trunks.create({ name: "Io" });
  await app.trunks.introduced();
  app.trunks.setDefault(main.id); // the owner's explicit choice grants default reach
  const { say, chat } = await withChat(t, app);
  app.channels.bindingFor = (channel, chatId) => (chatId === "bound" ? io.id : null);
  const refused = await say("hello", "bound");
  assert.equal(refused?.sessionId, undefined, "nothing was started for a Trunk that does not answer here");
  assert.match(chat.sent.at(-1).text, /Io does not answer on chat/);
  app.trunks.edit(io.id, { reach: { channels: ["chat"], commands: false } });
  const bound = await say("hello again", "bound");
  assert.equal(app.trunks.trunkForConversation(bound.sessionId).trunkId, io.id);
  assert.equal(bound.trunkId, io.id);
  const plain = await say("hi", "free");
  assert.equal(plain.trunkId, main.id, "no binding: the default, which never needs reach");
});

test("only a Trunk setup's own request makes may become the default by being oldest; no edit or restore can claim it", async (t) => {
  const { app, root } = await fixture(t);
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(() => server.close());
  const post = async (path, body, origin) => (await fetch(server.url + path, { method: "POST", headers: { authorization: `Bearer ${server.token}`,
    origin: server.url, "content-type": "application/json", "x-branch-origin": origin }, body: JSON.stringify(body) }));
  const handMade = (await (await post("/api/trunks", { name: "Before" }, "window")).json()).trunk;
  const first = (await (await post("/api/trunks", { name: "First" }, "setup")).json()).trunk;
  const later = (await (await post("/api/trunks", { name: "Later" }, "window")).json()).trunk;
  await app.trunks.introduced();
  const saved = (id) => app.store.get("governance", app.runtime.owner, `trunk:${id}`).data;
  assert.equal(saved(first.id).fromSetup, true, "setup's first Trunk is marked by setup's own request");
  assert.equal(saved(handMade.id).fromSetup, undefined);
  assert.equal(saved(later.id).fromSetup, undefined, "setup's mark ends with the window's next request");
  assert.equal((await post(`/api/trunks/${later.id}`, { fromSetup: true }, "window")).status, 400, "the edit route cannot claim it");
  assert.equal(saved(later.id).fromSetup, undefined);
  assert.equal((await post("/api/onboarding", { done: true }, "setup")).status, 200);
  assert.equal(app.trunks.ownerDefault().id, first.id, "setup's first Trunk is the default, though an older one was made by hand");
  assert.equal(app.trunks.records.list().length, 3, "no Trunk was made beside it");
  assert.equal(app.trunks.shapeOf({ prompt: "x", trunkId: handMade.id }).owners, undefined, "the hand-made Trunk keeps its narrowing");
  const narrowed = JSON.parse(narrowTrunk(JSON.stringify(saved(first.id))).data);
  assert.equal(narrowed.fromSetup, undefined, "a restored Trunk is never setup's first Trunk on this computer");
});
