import test from "node:test";
import assert from "node:assert/strict";
import { fixture, on } from "./trunks-helpers.mjs";
import { conversationPathsApi } from "../dist/conversation-paths-api.js";
import { underShortLivedKey } from "../dist/key-context.js";
import { asPerson } from "../dist/people/context.js";
import { setLockdown } from "../dist/lockdown.js";
import { createBranch, savePolicy } from "../dist/index.js";
import { TrunkRooms } from "../dist/trunks/rooms.js";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

const branch = (app, room, messageId, name, preset = null) => conversationPathsApi(app, { method: "POST" },
  `/api/sessions/${room.sessionId}/branch`, async () => ({ messageId, name, preset }));
const messages = (app, room) => app.store.sessionView(app.runtime.owner, room.sessionId).messages;
async function setup(t, rules = []) {
  const f = await fixture(t, rules); on(f.app, "rooms");
  const ann = f.app.trunks.create({ name: "Ann" }), ben = f.app.trunks.create({ name: "Ben" });
  await f.app.trunks.introduced();
  const room = f.app.trunks.rooms.create({ name: "Original", members: [ann.id, ben.id], rule: "all" });
  f.app.trunks.rooms.send(room.id, { text: "Remember the codeword acorn." });
  await f.app.trunks.rooms.settled(room.id);
  return { ...f, room, ann, ben };
}

test("room branch keeps a bounded visible transcript and both named seats really answer its next message", async (t) => {
  const f = await setup(t, [({ last }) => /What was the codeword/.test(last?.content ?? "")
    ? /acorn/.test(last.content) ? "The codeword was acorn." : "I forgot." : null]);
  const { app, room, ann, ben } = f, owner = app.runtime.owner;
  app.trunks.rooms.addArtifact(room.id, { name: "Original artifact", content: "private work" }, null);
  app.store.save("settings", owner, `conversation-mode:${room.sessionId}`, { mode: "ask" });
  app.store.save("settings", owner, `session-model:${room.memberSessions[ann.id]}`, { reasoning: "high" });
  app.store.save("settings", owner, `pinned-skill:${room.memberSessions[ben.id]}`, { name: "careful" });
  app.store.setMemorySuppressed(owner, room.sessionId, true);
  const before = JSON.stringify(app.trunks.rooms.get(room.id)), history = messages(app, room);
  const made = await branch(app, room, history.at(-1).messageId, "Alternative");
  const copy = app.trunks.rooms.list().find((r) => r.sessionId === made.sessionId);
  assert.ok(copy, "the path is an actual room");
  assert.equal(app.trunks.conversations.kind(made.sessionId), "room");
  assert.equal(made.roomId, copy.id);
  assert.equal(made.split, "after"); assert.equal(made.again, null);
  assert.deepEqual(messages(app, copy).map((m) => m.content), history.map((m) => m.content));
  assert.deepEqual(copy.members, room.members); assert.deepEqual(copy.people, room.people);
  assert.equal(copy.rule, "all"); assert.deepEqual(copy.pattern, room.pattern);
  assert.deepEqual(copy.events, []); assert.deepEqual(copy.artifacts, []); assert.equal(copy.needsYou, false);
  for (const id of room.members) {
    assert.notEqual(copy.memberSessions[id], room.memberSessions[id]);
    assert.deepEqual(app.store.messages(copy.memberSessions[id]), []);
    assert.equal(app.runtime.approvals.questionFor(copy.memberSessions[id]), undefined);
    assert.deepEqual(app.runtime.allowedNow(copy.memberSessions[id]), []);
    assert.equal(app.store.memorySuppressed(owner, copy.memberSessions[id]), true);
  }
  assert.equal(app.store.get("settings", owner, `session-model:${copy.memberSessions[ann.id]}`).data.reasoning, "high");
  assert.equal(app.store.get("settings", owner, `pinned-skill:${copy.memberSessions[ben.id]}`).data.name, "careful");
  assert.deepEqual(app.store.get("settings", owner, `conversation-mode:${copy.sessionId}`).data, { mode: "ask" });
  app.trunks.rooms.send(copy.id, { text: "What was the codeword?" }); await app.trunks.rooms.settled(copy.id);
  assert.deepEqual(messages(app, copy).slice(-2).map((m) => m.content),
    ["@ann: The codeword was acorn.", "@ben: The codeword was acorn."]);
  assert.equal(JSON.stringify(app.trunks.rooms.get(room.id)), before, "original room immutable");
  assert.deepEqual(messages(app, room), history, "original transcript immutable");
  const tree = app.store.paths.list(owner, copy.sessionId);
  assert.equal(tree.paths.find((p) => p.sessionId === copy.sessionId).parentSessionId, room.sessionId);
});

test("before-user branch returns the selected words without later replies, and new rooms do not replay history", async (t) => {
  const { app, room, provider } = await setup(t);
  app.trunks.rooms.send(room.id, { text: "Future secret" }); await app.trunks.rooms.settled(room.id);
  const point = messages(app, room).find((m) => m.content === "Future secret");
  const made = await branch(app, room, point.messageId, "Replay");
  const copy = app.trunks.rooms.get(made.roomId);
  assert.equal(made.split, "before"); assert.equal(made.again, "Future secret");
  assert.ok(!messages(app, copy).some((m) => m.content === "Future secret"));
  assert.doesNotMatch(copy.context, /Future secret/);
  const n = provider.requests.length;
  app.trunks.rooms.resumeAll(); await app.trunks.rooms.settled(copy.id);
  assert.equal(provider.requests.length, n, "restart does not answer inherited history");
  app.trunks.rooms.send(copy.id, { text: made.again }); await app.trunks.rooms.settled(copy.id);
  assert.equal(messages(app, copy).filter((m) => m.content === "Future secret").length, 1);
});

test("room branches reject seat paths, scoped keys and nonowners without creating rooms", async (t) => {
  const { app, room, ann } = await setup(t), point = messages(app, room).at(-1).messageId;
  const count = app.trunks.rooms.list().length;
  const member = { sessionId: room.memberSessions[ann.id] };
  const seatPoint = messages(app, member).find((m) => m.role === "assistant").messageId;
  await assert.rejects(branch(app, member, seatPoint, "Seat"), /room.*conversation|seat/i);
  await assert.rejects(underShortLivedKey(() => branch(app, room, point, "Key")), /owner|key/i);
  const person = app.store.profiles.create({ name: "Housemate", pin: "493816" });
  app.trunks.rooms.edit(room.id, { people: [person.id] });
  await assert.rejects(asPerson({ profileId: person.id, keyId: "person" }, () => branch(app, room, point, "Housemate")), /not found|owner/i);
  assert.equal(app.trunks.rooms.list().length, count);
});

test("local branches keep Lockdown, concurrent duplicate names leave exactly one complete room", async (t) => {
  const { app, room } = await setup(t), point = messages(app, room).at(-1).messageId;
  setLockdown(app.store, app.runtime.owner, { on: true });
  const outcomes = await Promise.allSettled([branch(app, room, point, "Same"), branch(app, room, point, "Same")]);
  assert.equal(outcomes.filter((r) => r.status === "fulfilled").length, 1);
  assert.match(outcomes.find((r) => r.status === "rejected").reason.message, /name|branch.*progress/i);
  assert.equal(app.trunks.rooms.list().length, 2);
  assert.equal(app.store.paths.list(app.runtime.owner, room.sessionId).paths.length, 2, "no orphan path");
  assert.equal(app.store.get("settings", app.runtime.owner, "lockdown").data.on, true);
  const copy = app.trunks.rooms.get(outcomes.find((r) => r.status === "fulfilled").value.roomId);
  app.trunks.rooms.send(copy.id, { text: "Say hello" }); await app.trunks.rooms.settled(copy.id);
  assert.equal(messages(app, copy).filter((m) => m.role === "assistant").length, 4);
});

test("left-out history stays visible but is withheld from the branched seats, and preset applies to both", async (t) => {
  const { app, room, provider } = await setup(t);
  const history = messages(app, room), point = history.at(-1);
  app.store.leftOut.set(room.sessionId, { messageId: history.find((m) => m.role === "user").messageId, out: true });
  const preset = [...app.runtime.models.presets.keys()][0];
  const made = await branch(app, room, point.messageId, "Left out", preset), copy = app.trunks.rooms.get(made.roomId);
  assert.ok(messages(app, copy).find((m) => m.content.includes("acorn")).leftOut);
  assert.doesNotMatch(copy.context, /acorn/);
  for (const seat of Object.values(copy.memberSessions)) assert.equal(app.runtime.models.session(app.runtime.owner, seat).preset, preset);
  app.trunks.rooms.send(copy.id, { text: "What did I omit?" }); await app.trunks.rooms.settled(copy.id);
  for (const request of provider.requests.slice(-2)) assert.doesNotMatch(JSON.stringify(request.messages), /acorn/);
  const nested = await branch(app, copy, messages(app, copy).at(-1).messageId, "Nested exclusions");
  assert.doesNotMatch(app.trunks.rooms.get(nested.roomId).context, /acorn/);
});

test("a room path survives a real store reopen without replaying prior tasks, and retains its sharing", async (t) => {
  const { app, root, room, provider } = await setup(t);
  const person = app.store.profiles.create({ name: "Sam", pin: "3826" });
  const stranger = app.store.profiles.create({ name: "Lee", pin: "4937" });
  app.trunks.rooms.edit(room.id, { people: [person.id], pattern: "one" });
  const made = await branch(app, room, messages(app, room).at(-1).messageId, "Persistent");
  await app.close();
  const reopened = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  t.after(() => reopened.close());
  const copy = reopened.trunks.rooms.get(made.roomId), n = provider.requests.length;
  await reopened.trunks.rooms.settled(copy.id);
  assert.equal(provider.requests.length, n);
  assert.equal(copy.pattern, "one"); assert.deepEqual(copy.people, [person.id]);
  assert.equal("contextBeforeRoom" in reopened.trunks.rooms.view(copy.id), false);
  assert.throws(() => reopened.trunks.rooms.requireAccess(copy.id, stranger.id), /private room/);
  assert.equal(reopened.trunks.rooms.requireAccess(copy.id, person.id).id, copy.id);
  reopened.trunks.rooms.send(copy.id, { text: "Next after restart" }); await reopened.trunks.rooms.settled(copy.id);
  assert.deepEqual(messages(reopened, copy).slice(-2).map((m) => m.content), ["@ann: Done.", "@ben: Done."]);
  assert.equal(messages(reopened, room).at(-1).content, "@ben: Done.");
  await reopened.close();
});

test("an original approval and its granted permissions never appear on the branch", async (t) => {
  const { app, room, ann } = await setup(t, [({ last }) => {
    if (last?.role === "tool") return "Written.";
    if (/Please write proof/.test(last?.content ?? "")) return { content: "", toolCalls: [{ id: "write-proof", name: "files.write",
      arguments: JSON.stringify({ path: "proof.txt", content: "branch proof" }) }] };
  }]);
  savePolicy(app.store, app.runtime.owner, { preset: "ask-before-changes" });
  app.trunks.rooms.edit(room.id, { rule: "tag" });
  const point = messages(app, room).at(-1).messageId;
  app.trunks.rooms.send(room.id, { text: "@ann Please write proof" }); await app.trunks.rooms.settled(room.id);
  const question = app.trunks.rooms.waiting(room.id)[0]; assert.ok(question);
  const made = await branch(app, room, point, "No question"), copy = app.trunks.rooms.get(made.roomId);
  assert.deepEqual(app.trunks.rooms.waiting(copy.id), []);
  assert.throws(() => app.trunks.rooms.answer(copy.id, { memberId: ann.id, decision: "allow", fingerprint: question.fingerprint }), /no.*question|not.*waiting|no pending/i);
  assert.equal(app.trunks.rooms.waiting(room.id)[0].fingerprint, question.fingerprint);
  app.trunks.rooms.answer(room.id, { memberId: ann.id, decision: "allow", fingerprint: question.fingerprint });
  await app.trunks.rooms.settled(room.id);
  assert.ok(app.runtime.allowedNow(room.memberSessions[ann.id]).length);
  assert.deepEqual(app.runtime.allowedNow(copy.memberSessions[ann.id]), []);
  const again = await branch(app, room, messages(app, room).at(-1).messageId, "No grants");
  assert.deepEqual(app.runtime.allowedNow(app.trunks.rooms.get(again.roomId).memberSessions[ann.id]), []);
});

test("Stop cancels only the new room's seat and never touches the original's active turn", async (t) => {
  const { app, room } = await setup(t), cancels = [], pending = new Map();
  const rooms = new TrunkRooms({ store: app.store, owner: app.runtime.owner, records: app.trunks.records,
    runtime: { run: async (options) => {
      const id = options.sessionId; options.onStarted({ id });
      return new Promise((resolve) => pending.set(id, resolve));
    }, cancel: (id) => { cancels.push(id); pending.get(id)({ id, status: "cancelled", output: "Stopped" }); return true; },
    waitingApprovals: () => [], approve: () => undefined }, notify: () => undefined, changed: () => undefined });
  const made = await rooms.branch(room.sessionId, messages(app, room).at(-1).messageId, "Stop alone", false);
  const copy = rooms.get(made.roomId);
  rooms.send(room.id, { text: "Original working" }); rooms.send(copy.id, { text: "Branch working" });
  await new Promise((resolve) => setImmediate(resolve));
  rooms.stop(copy.id); await rooms.settled(copy.id);
  assert.deepEqual(cancels, [copy.memberSessions[copy.members[0]]]);
  assert.equal(rooms.get(room.id).events.at(-1).text, "Original working");
  assert.ok(pending.has(room.memberSessions[room.members[0]]));
  rooms.stop(room.id); await rooms.settled(room.id); await rooms.close();
});

test("outside-agent branches start a fresh context; disconnected seats and Lockdown fail before copying", async (t) => {
  const { app, room } = await setup(t), id = randomUUID(), requests = [];
  let connected = true;
  app.trunks.rooms.outside = { byId: (wanted) => connected && wanted === id ? { id, name: "Remote", url: "https://remote.example/a2a" } : undefined,
    converse: async (_id, text, options) => { requests.push({ text, options }); return { answer: "Remote answer", state: "completed", contextId: `fresh-${requests.length}` }; },
    online: () => true, probe: () => undefined };
  app.trunks.rooms.edit(room.id, { agents: [id] });
  app.trunks.rooms.send(room.id, { text: "@remote answer first" }); await app.trunks.rooms.settled(room.id);
  const point = messages(app, room).find((m) => m.role === "assistant").messageId;
  assert.equal(app.trunks.rooms.get(room.id).agentContexts[id], "fresh-1");
  const made = await branch(app, room, point, "Fresh remote"), copy = app.trunks.rooms.get(made.roomId);
  assert.deepEqual(copy.agentContexts, {}); assert.deepEqual(copy.agents, [id]);
  app.trunks.rooms.send(copy.id, { text: "@remote next" }); await app.trunks.rooms.settled(copy.id);
  assert.equal(requests[1].options.contextId, undefined);
  assert.equal(app.trunks.rooms.get(room.id).agentContexts[id], "fresh-1");
  const count = app.trunks.rooms.list().length;
  setLockdown(app.store, app.runtime.owner, { on: true });
  await assert.rejects(branch(app, room, point, "Locked remote"), /Lockdown/i);
  setLockdown(app.store, app.runtime.owner, { on: false }); connected = false;
  await assert.rejects(branch(app, room, point, "Disconnected"), /not connected/);
  assert.equal(app.trunks.rooms.list().length, count);
  assert.equal(requests.length, 2);
});

test("a membership change or profile switch during copying removes the uncompleted path", async (t) => {
  const { app, room } = await setup(t), point = messages(app, room).at(-1).messageId;
  const person = app.store.profiles.create({ name: "Sam", pin: "4832" });
  const original = app.store.branchSession.bind(app.store);
  let release, started;
  const entered = new Promise((resolve) => { started = resolve; });
  app.store.branchSession = async (...args) => { const made = await original(...args); started(); await new Promise((resolve) => { release = resolve; }); return made; };
  const pending = branch(app, room, point, "Changed");
  await entered; app.trunks.rooms.edit(room.id, { people: [person.id] }); release();
  await assert.rejects(pending, /room changed/);
  assert.equal(app.store.paths.list(app.runtime.owner, room.sessionId).paths.length, 1);
  let enteredAgain;
  const copied = new Promise((resolve) => { enteredAgain = resolve; });
  app.store.branchSession = async (...args) => { const made = await original(...args); enteredAgain(); await new Promise((resolve) => { release = resolve; }); return made; };
  const switched = branch(app, room, point, "Switched");
  await copied; app.store.profiles.switch({ profileId: person.id, pin: "4832" }); release();
  await assert.rejects(switched, /owner/i);
  app.store.profiles.switch({ profileId: null });
  assert.equal(app.store.paths.list(app.runtime.owner, room.sessionId).paths.length, 1);
  assert.equal(app.trunks.rooms.list().length, 1);
  app.store.branchSession = original;
});

test("room paths refuse invalid points, disabled rooms and overlarge transcripts before creating seats", async (t) => {
  const { app, room } = await setup(t), history = messages(app, room);
  await assert.rejects(branch(app, room, history[0].messageId, "System"), /user message|assistant reply/);
  await assert.rejects(branch(app, room, 999999, "Missing"), /message not found/);
  await assert.rejects(branch(app, room, history.at(-1).messageId, "x".repeat(61)), /60/);
  app.trunks.setMode("rooms", { mode: "off" });
  await assert.rejects(branch(app, room, history.at(-1).messageId, "Off"), /off/i);
  app.trunks.setMode("rooms", { mode: "on" });
  for (let n = 0; n < 1000; n++) app.store.message(room.sessionId, { role: "user", content: `bounded ${n}` });
  await assert.rejects(branch(app, room, history.at(-1).messageId, "Too large"), /1000 messages|4 MiB/);
  assert.equal(app.trunks.rooms.list().length, 1);
});

test("room branches keep prior room context as inert history, capped for every fresh seat", async (t) => {
  const { app, room } = await setup(t);
  const record = app.trunks.rooms.get(room.id);
  app.store.save("governance", app.runtime.owner, `trunk-room:${room.id}`, { ...record, context: "Earlier seed was oak." });
  const made = await branch(app, room, messages(app, room).at(-1).messageId, "Earlier context");
  const copy = app.trunks.rooms.get(made.roomId);
  assert.match(copy.context, /Earlier seed was oak/); assert.match(copy.context, /acorn/);
  assert.ok(copy.context.length <= 3000);
  assert.deepEqual(copy.events, []);
});
