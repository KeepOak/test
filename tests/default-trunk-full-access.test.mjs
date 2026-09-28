import test from "node:test";
import assert from "node:assert/strict";
import { startServer } from "../dist/server.js";
import { z } from "zod";
import { call as toolCall, fixture, on } from "./trunks-helpers.mjs";

const change = { changes: [{ setting: "messagesPerConversationHour", value: 61 }] };

async function served(t) {
  const seen = [];
  const { app, root } = await fixture(t, [({ last }) => last?.role === "user" && /Work on it/.test(last.content) ? toolCall("probe.full_access", {}) : null]);
  // The context a real tool call in this turn carries, not one rebuilt afterwards.
  app.registry.register({ name: "probe.full_access", permission: "files.read", description: "test probe", parameters: z.object({}).strict(),
    execute: async (_input, context) => { seen.push({ context, full: app.runtime.ownerFullAccessFor(context, true),
      decision: app.runtime.checkPolicy("settings.change", change, context).decision, defaultTurn: app.runtime.ownersDefaultTurn(context) }); return "seen"; } });
  const server = await startServer(app, { dataDir: `${root}/data`, port: 0, host: "127.0.0.1" });
  t.after(() => server.close());
  const call = async (path, body) => {
    const response = await fetch(new URL(`/api/${path}`, server.url), { method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  on(app);
  return { app, call, seen };
}

async function fullTurn({ call, seen }, trunk) {
  assert.equal((await call("conversation-mode", { sessionId: trunk.chatSessionId, mode: "full" })).status, 200);
  const before = seen.length;
  const started = await call("run", { prompt: "Work on it", sessionId: trunk.chatSessionId });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  assert.equal(seen.length, before + 1, "the probe ran inside the turn");
  return seen.at(-1);
}

test("the owner's designated default Trunk in a Full Access conversation is the owner's own Full Access", async (t) => {
  const served_ = await served(t), { app } = served_;
  const ada = app.trunks.create({ name: "Ada" });
  app.trunks.setDefault(ada.id);
  await app.trunks.introduced();
  const turn = await fullTurn(served_, ada);
  assert.ok(turn.context.trunkKeys, "the default Trunk's turn carries its keys");
  assert.equal(turn.context.trunk, undefined, "and is the owner's own turn, not another Trunk's");
  assert.match(turn.full ?? "", new RegExp(ada.chatSessionId));
  assert.equal(turn.decision, "allow");
  assert.equal(turn.defaultTurn, true, "self-development reads the same designated default turn");
});

test("another Trunk, an undesignated fallback and outside callers keep their questions", async (t) => {
  const served_ = await served(t), { app } = served_;
  const ada = app.trunks.create({ name: "Ada" }), bo = app.trunks.create({ name: "Bo" });
  await app.trunks.introduced();
  const fallback = await fullTurn(served_, ada);
  assert.equal(fallback.full, null, "an introduction's routing fallback is not a designation");
  assert.equal(fallback.decision, "ask");
  app.trunks.setDefault(ada.id);
  const other = await fullTurn(served_, bo);
  assert.equal(other.full, null, "a Trunk that is not the default keeps its own boundary");
  assert.equal(other.decision, "ask");
  assert.equal(other.defaultTurn, false);
  const own = await fullTurn(served_, ada);
  assert.notEqual(own.full, null);
  assert.equal(app.runtime.ownerFullAccessFor({ ...own.context, source: "channel" }), null, "a chat source cannot borrow it");
  app.trunks.setDefault(bo.id);
  assert.equal(app.runtime.ownerFullAccessFor(own.context), null, "designation is checked at the call, not remembered from the start");
});

test("a room turn is never the default Trunk's own conversation, even for the default Trunk", async (t) => {
  const { app } = await served(t);
  const ada = app.trunks.create({ name: "Ada" }), bo = app.trunks.create({ name: "Bo" });
  app.trunks.setDefault(ada.id);
  await app.trunks.introduced();
  app.trunks.rooms.create({ name: "Work", members: [ada.id, bo.id] });
  app.trunks.refresh();
  const member = [...app.trunks.rooms.memberConversations()].find(([, trunk]) => trunk === ada.id);
  assert.ok(member, "the room gave Ada a member conversation");
  assert.equal(app.runtime.ownersDefaultIn(member[0], ada.id), false);
  assert.equal(app.runtime.ownersDefaultIn(ada.chatSessionId, ada.id), true);
  assert.equal(app.runtime.ownersDefaultIn(ada.chatSessionId, bo.id), false, "the recorded Trunk must be the one that owns the conversation");
});
