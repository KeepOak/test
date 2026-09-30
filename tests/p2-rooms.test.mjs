/**
 * Redesign phase 2 "rooms": several Trunks in one conversation. The room's own conversation is where
 * the mode (the phase 1 chip) lives; each member's turn follows it, capped by that Trunk's own limits.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { call, fixture, on } from "./trunks-helpers.mjs";
import { runOrigin } from "../dist/key-context.js";

/** Whether a Trunk wrote room.txt: a Trunk's own turn works in its own folder under .branch-agents (isolated-agents),
 *  so the file is looked for there as well as in the shared project. */
const roomFileWritten = (app) => existsSync(join(app.runtime.workspace, "room.txt"))
  || (existsSync(join(app.runtime.workspace, ".branch-agents")) && readdirSync(join(app.runtime.workspace, ".branch-agents"))
    .some((id) => existsSync(join(app.runtime.workspace, ".branch-agents", id, "room.txt"))));
/** Ann writes `room.txt` when the owner's message says "write"; a tool result is answered with "Done". */
const writer = [({ system, last }) => {
  const text = String(last?.content ?? "");
  if (last?.role === "tool") return "Done.";
  if (text.startsWith("[Room") && /write/.test(text) && /\nYou are Ann \(@ann\)/.test(system))
    return call("files.write", { path: "room.txt", content: "x" }, `w${Math.random().toString(36).slice(2, 8)}`);
  if (text.startsWith("[Room") && /run it/.test(text))
    return call("shell.execute", { command: "echo hi" }, `s${Math.random().toString(36).slice(2, 8)}`);
  return text.startsWith("[Room") ? "(pass)" : null;
}];

async function room(t) {
  const made = await fixture(t, writer);
  on(made.app, "rooms");
  const ann = made.app.trunks.create({ name: "Ann" }), ben = made.app.trunks.create({ name: "Ben" });
  await made.app.trunks.introduced();
  const r = made.app.trunks.rooms.create({ name: "Work", members: [ann.id, ben.id] });
  return { ...made, ann, ben, room: r };
}

test("piece 1: a Trunk's turn in an Ask first room asks, although the owner's own setting is No approvals", async (t) => {
  const { app, room: r, ann } = await room(t);
  const { pickConversationMode } = await import("../dist/conversation-mode-api.js");
  pickConversationMode(app, r.sessionId, "ask");
  app.trunks.rooms.send(r.id, { text: "@ann write it" });
  await app.trunks.rooms.settled(r.id);
  assert.equal(roomFileWritten(app), false, "nothing written without a yes");
  const waiting = app.trunks.rooms.view(r.id).waiting;
  assert.equal(waiting.length, 1);
  assert.equal(waiting[0].memberId, ann.id);
  // Changing the room's mode applies to the member's next check straight away.
  const memberRun = app.store.runs(app.runtime.owner).find((run) => run.sessionId === r.memberSessions[ann.id] && run.status === "needs_input");
  const context = app.runtime.context({ runId: memberRun.id });
  assert.equal(app.runtime.checkPolicy("files.write", { path: "room.txt", content: "x" }, context).decision, "ask");
  pickConversationMode(app, r.sessionId, "plan");
  assert.equal(app.runtime.checkPolicy("files.write", { path: "room.txt", content: "x" }, context).decision, "deny");
});

test("piece 1: a Full access room lets its Trunks act, but never past a Trunk's own limits", async (t) => {
  const { app, room: r, ann } = await room(t);
  const { savePolicy } = await import("../dist/policy.js");
  const { pickConversationMode } = await import("../dist/conversation-mode-api.js");
  savePolicy(app.store, app.runtime.owner, { preset: "ask-before-changes" });
  pickConversationMode(app, r.sessionId, "full");
  app.trunks.rooms.send(r.id, { text: "@ann write it" });
  await app.trunks.rooms.settled(r.id);
  assert.equal(roomFileWritten(app), true, "the owner's Full access room did not ask");
  // Ann may not run commands (a Trunk's reach starts off), so the room's Full access does not give it any.
  const shape = app.runtime.trunkShape({ sessionId: r.memberSessions[ann.id] });
  assert.equal(shape.permissions.includes("shell.execute"), false);
  assert.equal(shape.roomTurn, true);
});

test("piece 1: a short-lived key's message in a Full access room is held to the owner's setting", async (t) => {
  const { app, room: r } = await room(t);
  const { savePolicy } = await import("../dist/policy.js");
  const { pickConversationMode } = await import("../dist/conversation-mode-api.js");
  const { underShortLivedKey } = await import("../dist/key-context.js");
  savePolicy(app.store, app.runtime.owner, { preset: "ask-before-changes" });
  pickConversationMode(app, r.sessionId, "full");
  // The owner's own discussion is still going when the key's message arrives, so the key's turn runs
  // on the owner's drive: who sent the message has to travel with the message, not with the drive.
  app.trunks.rooms.send(r.id, { text: "@ben hello" });
  underShortLivedKey(() => app.trunks.rooms.send(r.id, { text: "@ann write it" }));
  await app.trunks.rooms.settled(r.id);
  assert.equal(roomFileWritten(app), false, "the key's message did not get Full access");
  assert.equal(app.trunks.rooms.view(r.id).waiting.length, 1, "it asks, as the owner's setting says");
});

test("a queued room message keeps the household person who sent it", async (t) => {
  let began, release;
  const started = new Promise((resolve) => { began = resolve; });
  const held = new Promise((resolve) => { release = resolve; });
  const { app, call: request } = await served(t, seesAnn);
  on(app, "rooms");
  const ann = app.trunks.create({ name: "Ann" }), ben = app.trunks.create({ name: "Ben" });
  await app.trunks.introduced();
  const run = app.runtime.run.bind(app.runtime);
  app.runtime.run = async (options) => {
    if (options.prompt.includes("@ann start")) { began(); await held; }
    return run(options);
  };
  const room = app.trunks.rooms.create({ name: "Queued", members: [ann.id, ben.id] });
  app.trunks.rooms.send(room.id, { text: "@ann start" });
  await started;
  const sam = app.store.profiles.create({ name: "Sam", pin: "1234" });
  app.trunks.rooms.edit(room.id, { people: [sam.id] });
  app.store.profiles.switch({ profileId: sam.id, pin: "1234" });
  assert.equal((await request(`/api/trunks/rooms/${room.id}/send`, { text: "@ben continue" })).status, 200);
  app.store.profiles.switch({ profileId: null });
  release();
  await app.trunks.rooms.settled(room.id);
  const answer = app.store.runs(app.runtime.owner)
    .find((entry) => entry.sessionId === room.memberSessions[ben.id] && entry.prompt.includes("@ben continue"));
  assert.ok(answer, "Ben answered Sam's queued discussion");
  assert.equal(runOrigin(app.store, answer.id).personProfileId, sam.id);
});

test("a queued room message keeps both its household person and short-lived key", async (t) => {
  let began, release;
  const started = new Promise((resolve) => { began = resolve; });
  const held = new Promise((resolve) => { release = resolve; });
  const { app } = await served(t, seesAnn);
  on(app, "rooms");
  const ann = app.trunks.create({ name: "Ann" }), ben = app.trunks.create({ name: "Ben" });
  await app.trunks.introduced();
  const run = app.runtime.run.bind(app.runtime);
  app.runtime.run = async (options) => {
    if (options.prompt.includes("@ann start")) { began(); await held; }
    return run(options);
  };
  const sam = app.store.profiles.create({ name: "Sam", pin: "1234" });
  const room = app.trunks.rooms.create({ name: "Queued", members: [ann.id, ben.id], people: [sam.id] });
  app.trunks.rooms.send(room.id, { text: "@ann start" });
  await started;
  const { underShortLivedKey } = await import("../dist/key-context.js");
  underShortLivedKey(() => app.trunks.rooms.send(room.id, { text: "@ben continue" }, { id: sam.id, name: "Sam" }),
    { keyId: "sam-key" });
  release();
  await app.trunks.rooms.settled(room.id);
  const answer = app.store.runs(app.runtime.owner)
    .find((entry) => entry.sessionId === room.memberSessions[ben.id] && entry.prompt.includes("@ben continue"));
  const origin = runOrigin(app.store, answer.id);
  assert.equal(origin.personProfileId, sam.id);
  assert.equal(origin.shortLivedKey, true);
  assert.deepEqual(origin.keyIds, ["sam-key"]);
});

test("an artifact shared after a Trunk has spoken reaches its next turn", async (t) => {
  const { app, provider } = await served(t, seesAnn);
  on(app, "rooms");
  const ann = app.trunks.create({ name: "Ann" }), ben = app.trunks.create({ name: "Ben" });
  await app.trunks.introduced();
  const room = app.trunks.rooms.create({ name: "Late brief", members: [ann.id, ben.id] });
  app.trunks.rooms.send(room.id, { text: "@ann hello" });
  await app.trunks.rooms.settled(room.id);
  const before = provider.requests.length;
  app.trunks.rooms.addArtifact(room.id, { name: "brief.txt", content: "late private oak plan" }, null);
  app.trunks.rooms.send(room.id, { text: "@ann use the late brief" });
  await app.trunks.rooms.settled(room.id);
  const later = provider.requests.slice(before).flatMap((request) => request.messages).map((message) => String(message.content));
  assert.ok(later.some((content) => content.includes("Shared artifact brief.txt:") && content.includes("late private oak plan")));
});

test("a household artifact is visible only to turns run as that household person", async (t) => {
  const { app, call: request, provider } = await served(t, seesAnn);
  on(app, "rooms");
  const ann = app.trunks.create({ name: "Ann" }), ben = app.trunks.create({ name: "Ben" });
  await app.trunks.introduced();
  const sam = app.store.profiles.create({ name: "Sam", pin: "1234" });
  const room = app.trunks.rooms.create({ name: "Private artifact", members: [ann.id, ben.id], people: [sam.id] });

  app.store.profiles.switch({ profileId: sam.id, pin: "1234" });
  assert.equal((await request(`/api/trunks/rooms/${room.id}/artifacts`, {
    name: "sam-private.txt", content: "SAM-ONLY-REFERENCE",
  })).status, 200);

  app.store.profiles.switch({ profileId: null });
  const beforeOwner = provider.requests.length;
  app.trunks.rooms.send(room.id, { text: "@ann answer the owner" });
  await app.trunks.rooms.settled(room.id);
  const ownerRequests = provider.requests.slice(beforeOwner);
  assert.equal(JSON.stringify(ownerRequests).includes("SAM-ONLY-REFERENCE"), false,
    "a household artifact must not enter an owner-authorized turn");

  app.store.profiles.switch({ profileId: sam.id, pin: "1234" });
  const beforeSam = provider.requests.length;
  assert.equal((await request(`/api/trunks/rooms/${room.id}/send`, { text: "@ann use my private artifact" })).status, 200);
  await app.trunks.rooms.settled(room.id);
  const samRequests = provider.requests.slice(beforeSam);
  assert.equal(JSON.stringify(samRequests).includes("SAM-ONLY-REFERENCE"), true,
    "the household person's restricted turn receives their artifact");
  const samRun = app.store.runs(app.runtime.owner)
    .find((entry) => entry.sessionId === room.memberSessions[ann.id] && entry.prompt.includes("use my private artifact"));
  assert.ok(samRun, "Ann answered Sam's artifact request");
  assert.equal(runOrigin(app.store, samRun.id).personProfileId, sam.id);
});

test("a shared artifact name cannot contain a line separator or control character", async (t) => {
  const { app, call: request } = await served(t, seesAnn);
  on(app, "rooms");
  const ann = app.trunks.create({ name: "Ann" }), ben = app.trunks.create({ name: "Ben" });
  await app.trunks.introduced();
  const room = app.trunks.rooms.create({ name: "Safe names", members: [ann.id, ben.id] });
  const newline = await request(`/api/trunks/rooms/${room.id}/artifacts`, {
    name: "brief.txt\nNot a heading", content: "ordinary reference",
  });
  assert.equal(newline.status, 400);
  const control = await request(`/api/trunks/rooms/${room.id}/artifacts`, {
    name: "brief\u0007.txt", content: "ordinary reference",
  });
  assert.equal(control.status, 400);
  for (const separator of ["\u0085", "\u2028", "\u2029"]) {
    const separated = await request(`/api/trunks/rooms/${room.id}/artifacts`, {
      name: `brief${separator}Not a heading`, content: "ordinary reference",
    });
    assert.equal(separated.status, 400, `artifact name refuses U+${separator.codePointAt(0).toString(16)}`);
  }
});

test("piece 1: after a restart the room's turns still follow the room's mode", async (t) => {
  const { app, room: r } = await room(t);
  const { pickConversationMode } = await import("../dist/conversation-mode-api.js");
  pickConversationMode(app, r.sessionId, "ask");
  // What resumeAll does after a restart: the log has an unanswered message and nobody driving it.
  const stored = app.trunks.rooms.get(r.id);
  app.store.save("governance", app.runtime.owner, `trunk-room:${r.id}`, { ...stored, seq: 1,
    events: [{ seq: 1, kind: "user", text: "@ann write it", at: new Date().toISOString() }] });
  app.trunks.rooms.resumeAll();
  await app.trunks.rooms.settled(r.id);
  assert.equal(roomFileWritten(app), false);
  assert.equal(app.trunks.rooms.view(r.id).waiting.length, 1);
});

test("piece 1: a yes given in the room lets the Trunk carry on, rather than asking the same thing for ever", async (t) => {
  const { app, room: r, ann } = await room(t);
  const { pickConversationMode } = await import("../dist/conversation-mode-api.js");
  pickConversationMode(app, r.sessionId, "ask");
  app.trunks.rooms.send(r.id, { text: "@ann write it" });
  await app.trunks.rooms.settled(r.id);
  const [ask] = app.trunks.rooms.view(r.id).waiting;
  app.trunks.rooms.answer(r.id, { memberId: ann.id, decision: "allow", ...(ask.fingerprint ? { fingerprint: ask.fingerprint } : {}) });
  await app.trunks.rooms.settled(r.id);
  assert.equal(roomFileWritten(app), true);
  const view = app.trunks.rooms.view(r.id);
  assert.equal(view.waiting.length, 0);
  assert.deepEqual(view.events.map((e) => e.kind), ["user", "waiting", "member"]);
});

/* ---------------------------------------------------------------- piece 2: who answers in a conversation */

async function served(t, rules = []) {
  // The server closes before the app and before its folder is thrown away (fixture's own after-hook
  // runs first otherwise, and Windows refuses to delete a folder the server still holds).
  let closeServer = async () => undefined;
  const made = await fixture({ after: (hook) => t.after(async () => { await closeServer(); await hook(); }) }, rules);
  const { startServer } = await import("../dist/server.js");
  const server = await startServer(made.app, { dataDir: join(made.root, "data"), port: 0, host: "127.0.0.1" });
  closeServer = () => server.close();
  const call = async (path, body, token = server.token) => {
    const response = await fetch(new URL(path, server.url), { method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  return { ...made, server, call };
}
const seesAnn = [({ system, last }) => (/\nYou are Ann \(@ann\)/.test(system) && last?.role === "user" && !/Introduce/.test(last.content) ? "Ann here." : null)];

test("piece 2: choosing a Trunk for a conversation ships when needed, and while off nothing changes", async (t) => {
  const { app, call } = await served(t, seesAnn);
  on(app);
  // The ship-on rule: it ships "when needed" (src/trunks/settings.ts); the owner switches it off.
  assert.equal(app.trunks.modes().conversations, "when-needed");
  app.trunks.setMode("conversations", { mode: "off" });
  assert.equal(app.trunks.modes().conversations, "off");
  const ann = app.trunks.create({ name: "Ann" });
  await app.trunks.introduced();
  const plain = await app.runtime.run({ prompt: "hello" });
  const refused = await call(`/api/trunks/conversations/${plain.sessionId}`, { trunkId: ann.id });
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /Choosing a Trunk to answer in any conversation is switched off/);
  assert.equal((await call("/api/trunks/conversations", { trunkId: ann.id })).status, 409);
  assert.equal((await call(`/api/trunks/conversations/${plain.sessionId}`)).body.kind, "plain", "looking is fine");
});

test("piece 2: a conversation the owner chose a Trunk for runs as that Trunk, and each reply says who gave it", async (t) => {
  const { app, call, provider } = await served(t, seesAnn);
  on(app, "conversations", "rooms");
  const defaultTrunk = app.trunks.ensureDefault(true);
  const ann = app.trunks.create({ name: "Ann", title: "Travel" }), ben = app.trunks.create({ name: "Ben" });
  await app.trunks.introduced();
  app.trunks.edit(ann.id, { permissions: ["files.read"] });
  const first = await app.runtime.run({ prompt: "hello" });
  assert.equal(first.output, "Done.", "your assistant answered before the choice");
  const chosen = await call(`/api/trunks/conversations/${first.sessionId}`, { trunkId: ann.id });
  assert.equal(chosen.status, 200);
  assert.equal(chosen.body.kind, "trunk");
  assert.equal(chosen.body.trunk.name, "Ann");
  assert.equal(chosen.body.trunk.instructions, undefined, "the window is never handed a Trunk's instructions");
  assert.deepEqual(chosen.body.authors.map((a) => [a.from, a.trunkId]), [[0, null], [1, ann.id]]);
  const second = await app.runtime.run({ prompt: "and now?", sessionId: first.sessionId });
  assert.equal(second.output, "Ann here.");
  assert.ok(app.store.events(second.id).some((e) => e.kind === "trunk.turn" && e.data.trunkId === ann.id));
  const shape = app.runtime.trunkShape({ sessionId: first.sessionId });
  assert.deepEqual(shape.permissions, ["files.read"], "Ann's own limits hold");
  assert.equal(shape.roomTurn, false, "an ordinary turn, with its own plan and review");
  assert.equal(provider.requests.at(-1).tools?.some((tool) => tool.name === "files.write") ?? false, false);
  // Kinds, and what may not be chosen for.
  assert.equal((await call(`/api/trunks/conversations/${ann.chatSessionId}`)).body.kind, "trunk-chat");
  assert.equal((await call(`/api/trunks/conversations/${ann.chatSessionId}`, { trunkId: ben.id })).status, 400);
  // Back to your assistant; the earlier replies keep their author.
  const back = await call(`/api/trunks/conversations/${first.sessionId}`, { trunkId: null });
  assert.deepEqual(back.body.authors.map((a) => [a.from, a.trunkId]), [[0, null], [1, ann.id], [2, defaultTrunk.id]]);
  assert.equal(back.body.kind, "trunk");
  assert.equal(app.runtime.trunkShape({ sessionId: first.sessionId }).trunkId, defaultTrunk.id);
  // Starting a conversation with a Trunk before anything is said.
  const started = await call("/api/trunks/conversations", { trunkId: ben.id });
  assert.equal(started.status, 200);
  assert.equal((await call(`/api/trunks/conversations/${started.body.sessionId}`)).body.trunk.name, "Ben");
  // Removing a Trunk gives its conversations back to your assistant.
  await call(`/api/trunks/${ben.id}/remove`, {});
  assert.equal((await call(`/api/trunks/conversations/${started.body.sessionId}`)).body.trunk.id, defaultTrunk.id);
});

test("piece 2: bringing a second Trunk in makes a room that knows what was said before", async (t) => {
  const { app, call, provider } = await served(t, seesAnn);
  on(app, "conversations", "rooms");
  const ann = app.trunks.create({ name: "Ann" }), ben = app.trunks.create({ name: "Ben" });
  await app.trunks.introduced();
  const started = (await call("/api/trunks/conversations", { trunkId: ann.id })).body;
  await app.runtime.run({ prompt: "We are going to Lisbon in May.", sessionId: started.sessionId });
  const made = await call(`/api/trunks/conversations/${started.sessionId}/room`, { trunkId: ben.id });
  assert.equal(made.status, 200);
  assert.equal(made.body.room.name, "Ann and Ben");
  const info = (await call(`/api/trunks/conversations/${made.body.room.sessionId}`)).body;
  assert.equal(info.kind, "room");
  assert.deepEqual(info.room.members.map((m) => m.name), ["Ann", "Ben"]);
  assert.equal((await call(`/api/trunks/conversations/${made.body.room.memberSessions[ann.id]}`)).body.kind, "member");
  app.trunks.rooms.send(made.body.room.id, { text: "@ben what should we see?" });
  await app.trunks.rooms.settled(made.body.room.id);
  const benTurn = provider.requests.flatMap((r) => r.messages).find((m) => String(m.content).startsWith("[Room \"Ann and Ben\"] You are @ben"));
  assert.match(benTurn.content, /Earlier in the conversation this room was made from[\s\S]*The owner: We are going to Lisbon in May\.[\s\S]*Reply: Ann here\./);
  assert.equal((await call(`/api/trunks/conversations/${started.sessionId}`)).body.kind, "trunk", "the conversation stays as it was");
  assert.equal((await call(`/api/trunks/conversations/${started.sessionId}/room`, { trunkId: ann.id })).status, 400, "not the same Trunk twice");
});

test("piece 2: household people, short-lived keys and Talk live cannot use a Trunk's conversation", async (t) => {
  const { app, call } = await served(t, seesAnn);
  on(app, "conversations");
  const ann = app.trunks.create({ name: "Ann" });
  await app.trunks.introduced();
  const started = (await call("/api/trunks/conversations", { trunkId: ann.id })).body;
  const key = app.sessionTokens.create(app.runtime.owner, { name: "script", scope: "run", minutes: 5 }).token;
  assert.equal((await call(`/api/trunks/conversations/${started.sessionId}`, { trunkId: null }, key)).status, 401);
  assert.equal((await call("/api/trunks/conversations", { trunkId: ann.id }, key)).status, 401);
  const live = await call("/api/voice/live", { sessionId: started.sessionId });
  assert.notEqual(live.status, 200);
  assert.match(live.body.error, /not with a Trunk/);
  assert.equal((await call("/api/voice/live", { sessionId: null }, key)).status, 401, "Talk live is the owner's: a key cannot open one");
  const plain = await app.runtime.run({ prompt: "hello" });
  const allowed = await call("/api/voice/live", { sessionId: plain.sessionId });
  assert.doesNotMatch(allowed.body.error ?? "", /Endpoint not found|Trunk/, "the route is there for the owner's own conversation");
  const person = app.store.profiles.create({ name: "Sam", pin: "1234" });
  app.store.profiles.switch({ profileId: person.id, pin: "1234" });
  const household = await call(`/api/trunks/conversations/${started.sessionId}`);
  assert.equal(household.status, 400);
  assert.doesNotMatch(JSON.stringify(household.body), /Ann/, "nothing of the owner's is shown");
});

/* ---------------------------------------------------------------- integration review */

/** Ann waits for a yes to write room.txt in an Ask first room of three (so one can be taken out). */
async function waitingRoom(t) {
  const made = await fixture(t, writer);
  on(made.app, "rooms");
  const ann = made.app.trunks.create({ name: "Ann" }), ben = made.app.trunks.create({ name: "Ben" }), cy = made.app.trunks.create({ name: "Cy" });
  await made.app.trunks.introduced();
  const r = made.app.trunks.rooms.create({ name: "Work", members: [ann.id, ben.id, cy.id] });
  const { pickConversationMode } = await import("../dist/conversation-mode-api.js");
  pickConversationMode(made.app, r.sessionId, "ask");
  made.app.trunks.rooms.send(r.id, { text: "@ann write it" });
  await made.app.trunks.rooms.settled(r.id);
  return { ...made, ann, ben, cy, room: r };
}

test("integration review: a room yes is that Trunk, that thing, this room; shown with Revoke; it ends when the Trunk leaves or the room goes", async (t) => {
  const { app, room: r, ann, ben, cy } = await waitingRoom(t);
  const [ask] = app.trunks.rooms.view(r.id).waiting;
  app.trunks.rooms.answer(r.id, { memberId: ann.id, decision: "allow", ...(ask.fingerprint ? { fingerprint: ask.fingerprint } : {}) });
  await app.trunks.rooms.settled(r.id);
  const annSide = r.memberSessions[ann.id], benSide = r.memberSessions[ben.id];
  const allowed = app.trunks.rooms.view(r.id).allowed;
  assert.equal(allowed.length, 1, "one yes, for Ann");
  assert.equal(allowed[0].memberId, ann.id);
  assert.equal(allowed[0].tool, "files.write");
  assert.match(allowed[0].target, /room\.txt/);
  assert.equal(app.runtime.allowedNow(benSide).length, 0, "Ben holds nothing");
  // Only that exact request: another file for Ann is asked about again.
  const annRun = app.store.runs(app.runtime.owner).find((run) => run.sessionId === annSide);
  const context = app.runtime.context({ runId: annRun.id });
  assert.equal(app.runtime.checkPolicy("files.write", { path: "other.txt", content: "x" }, context).decision, "ask");
  // Revoke.
  assert.deepEqual(app.trunks.rooms.revoke(r.id, { memberId: ann.id, tool: allowed[0].tool, target: allowed[0].target }), { revoked: true });
  assert.equal(app.trunks.rooms.view(r.id).allowed.length, 0);
  // Given again, then Ann is taken out of the room: the yes goes with the seat, and the copy kept for a restart too.
  app.runtime.approvals.remember(annSide, "files.write", allowed[0].target, "allow");
  const { rememberSessionCarry, readSessionCarry } = await import("../dist/session-carry.js");
  rememberSessionCarry({ store: app.store, models: app.runtime.models, approvals: app.runtime.approvals, toolboxes: () => [] }, app.runtime.owner, annSide);
  assert.equal(readSessionCarry(app.store, app.runtime.owner, annSide).grants.length, 1);
  app.trunks.rooms.edit(r.id, { members: [ben.id, cy.id] });
  assert.equal(app.runtime.allowedNow(annSide).length, 0, "Ann's yes ended when Ann left the room");
  assert.equal(readSessionCarry(app.store, app.runtime.owner, annSide).grants.length, 0, "and cannot come back after a restart");
  // Removing the room ends every yes in it.
  app.runtime.approvals.remember(benSide, "files.write", "b.txt", "allow");
  app.trunks.rooms.remove(r.id);
  assert.equal(app.runtime.allowedNow(benSide).length, 0, "the room's yeses ended with the room");
});

test("integration review: a Trunk's side of a room follows the room's mode, even if a mode was put on that side", async (t) => {
  const { app, room: r, ann } = await room(t);
  const { pickConversationMode } = await import("../dist/conversation-mode-api.js");
  pickConversationMode(app, r.sessionId, "ask");
  pickConversationMode(app, r.memberSessions[ann.id], "full");
  app.trunks.rooms.send(r.id, { text: "@ann write it" });
  await app.trunks.rooms.settled(r.id);
  assert.equal(roomFileWritten(app), false, "the room's Ask first holds");
  assert.equal(app.trunks.rooms.view(r.id).waiting.length, 1);
});

test("integration review: Talk live is refused where it opens (every task's socket), not only on its route", async (t) => {
  const { app, room: r, ann } = await room(t);
  const out = { audio: () => undefined, notice: () => undefined };
  const memberRun = app.store.createRun(app.runtime.owner, "A live conversation", r.memberSessions[ann.id]);
  await assert.rejects(app.live.start(memberRun.id, memberRun.sessionId, out), /not with a Trunk/);
  const roomRun = app.store.createRun(app.runtime.owner, "A live conversation", r.sessionId);
  await assert.rejects(app.live.start(roomRun.id, roomRun.sessionId, out), /not in a room/);
  // A conversation that began outside Branch stays held: talking in it would make it the owner's own.
  const outside = app.store.createRun(app.runtime.owner, "from a chat app");
  app.store.event(outside.id, "run.started", { source: "channel" });
  app.store.finish(outside.id, "completed", "ok");
  const liveOutside = app.store.createRun(app.runtime.owner, "A live conversation", outside.sessionId);
  await assert.rejects(app.live.start(liveOutside.id, liveOutside.sessionId, out), /began outside Branch/);
  // Lockdown: the sound would leave this computer.
  const { setLockdown } = await import("../dist/lockdown.js");
  const plain = app.store.createRun(app.runtime.owner, "A live conversation");
  setLockdown(app.store, app.runtime.owner, { on: true });
  await assert.rejects(app.live.start(plain.id, plain.sessionId, out), /Lockdown is on/);
  setLockdown(app.store, app.runtime.owner, { on: false });
  // A household person at the window.
  const person = app.store.profiles.create({ name: "Sam", pin: "1234" });
  app.store.profiles.switch({ profileId: person.id, pin: "1234" });
  await assert.rejects(app.live.start(plain.id, plain.sessionId, out), /for the owner/);
});

test("integration review: a room's inner conversations stay out of Recents; the room itself is there", async (t) => {
  const { app, room: r, ann, ben } = await room(t);
  app.trunks.rooms.send(r.id, { text: "@ann hello" });
  await app.trunks.rooms.settled(r.id);
  assert.ok(app.store.messages(r.memberSessions[ann.id]).length > 0, "Ann's side has the room's instructions in it");
  const listed = app.store.searchSessions(app.runtime.owner, { query: "" }).sessions.map((s) => s.sessionId);
  assert.ok(listed.includes(r.sessionId), "the room is listed");
  assert.equal(listed.includes(r.memberSessions[ann.id]), false, "Ann's side is not");
  assert.equal(listed.includes(r.memberSessions[ben.id]), false);
  assert.equal(app.store.searchSessions(app.runtime.owner, { query: "[Room" }).sessions.some((s) => s.sessionId === r.memberSessions[ann.id]), false);
  const recent = app.store.recentSessions(app.runtime.owner, 50).sessions.map((s) => s.sessionId);
  assert.equal(recent.includes(r.memberSessions[ann.id]), false, "nor on the phone's list");
});

test("integration review: the banner names the Trunk that asked and opens its room; keys give no standing yes in a room", async (t) => {
  const { app, call } = await served(t, writer);
  on(app, "rooms");
  const ann = app.trunks.create({ name: "Ann" }), ben = app.trunks.create({ name: "Ben" });
  await app.trunks.introduced();
  const r = app.trunks.rooms.create({ name: "Work", members: [ann.id, ben.id] });
  const { pickConversationMode } = await import("../dist/conversation-mode-api.js");
  pickConversationMode(app, r.sessionId, "ask");
  const key = app.sessionTokens.create(app.runtime.owner, { name: "script", scope: "run", minutes: 5 }).token;
  assert.equal((await call(`/api/trunks/rooms/${r.id}/send`, { text: "@ann write it" }, key)).status, 200);
  await app.trunks.rooms.settled(r.id);
  const [ask] = app.trunks.rooms.view(r.id).waiting;
  assert.ok(ask, "Ann asks");
  const state = (await call("/api/state")).body;
  const item = state.attention.find((a) => a.sessionId === r.memberSessions[ann.id]);
  assert.equal(item.who, "Ann");
  assert.equal(item.room, "Work");
  assert.equal(item.open, r.sessionId, "Open leads to the room itself");
  // The key started Ann's turn, so it may answer it once, but never leave a yes standing in the room.
  const standing = await call("/api/policy/approve", { sessionId: ask.sessionId, decision: "allow", remember: "session", ...(ask.fingerprint ? { fingerprint: ask.fingerprint } : {}) }, key);
  assert.equal(standing.status, 401);
  assert.match(standing.body.error, /given by the owner, in the room/);
  assert.equal(app.runtime.allowedNow(ask.sessionId).length, 0);
  assert.equal((await call(`/api/trunks/rooms/${r.id}/revoke`, { memberId: ann.id, tool: "files.write", target: "x" }, key)).status, 401, "Revoke is the owner's");
  assert.equal((await call(`/api/trunks/rooms/${r.id}/answer`, { memberId: ann.id, decision: "allow" }, key)).status, 401, "so is the room's yes");
});

test("integration review: with the switch off, a conversation can still be given back to your assistant", async (t) => {
  const { app, call } = await served(t, seesAnn);
  on(app, "conversations");
  const defaultTrunk = app.trunks.ensureDefault(true);
  const ann = app.trunks.create({ name: "Ann" });
  await app.trunks.introduced();
  const started = (await call("/api/trunks/conversations", { trunkId: ann.id })).body;
  const { saveTrunkMode } = await import("../dist/trunks/settings.js");
  saveTrunkMode(app.store, app.runtime.owner, "conversations", { mode: "off" });
  assert.equal((await call(`/api/trunks/conversations/${started.sessionId}`, { trunkId: ann.id })).status, 409, "choosing is off");
  const back = await call(`/api/trunks/conversations/${started.sessionId}`, { trunkId: null });
  assert.equal(back.status, 200);
  assert.equal(back.body.kind, "trunk");
  assert.equal(back.body.trunk.id, defaultTrunk.id);
});

test("a private room admits named people and Trunks, and removal closes its history and artifacts", async (t) => {
  const { app, call, provider } = await served(t, seesAnn);
  on(app, "rooms");
  const ann = app.trunks.create({ name: "Ann" }), ben = app.trunks.create({ name: "Ben" });
  await app.trunks.introduced();
  const sam = app.store.profiles.create({ name: "Sam", pin: "1234" });
  const lee = app.store.profiles.create({ name: "Lee", pin: "5678" });
  const made = await call("/api/trunks/rooms", { name: "Private bench", members: [ann.id, ben.id], people: [sam.id] });
  assert.equal(made.status, 200);
  const id = made.body.room.id;
  const artifact = await call(`/api/trunks/rooms/${id}/artifacts`, { name: "brief.txt", content: "private oak plan" });
  assert.equal(artifact.status, 200);

  app.store.profiles.switch({ profileId: sam.id, pin: "1234" });
  const joined = await call(`/api/trunks/rooms/${id}`);
  assert.equal(joined.status, 200);
  assert.deepEqual(joined.body.people.map((person) => person.name), ["Sam"]);
  assert.deepEqual(joined.body.roster.map((member) => member.name), ["Ann", "Ben"]);
  assert.equal(joined.body.artifacts[0].content, "private oak plan");
  assert.equal((await call(`/api/sessions/${made.body.room.sessionId}`)).status, 200, "the shared room opens as a conversation");
  assert.equal((await call(`/api/trunks/conversations/${made.body.room.sessionId}`)).body.kind, "room");
  assert.equal((await call(`/api/trunks/rooms/${id}/send`, { text: "@ann use the brief" })).status, 200);
  await app.trunks.rooms.settled(id);
  const prompts = provider.requests.flatMap((request) => request.messages).map((message) => String(message.content));
  assert.ok(prompts.some((content) => content.includes("Shared artifact brief.txt:") && content.includes("private oak plan")),
    "the room's agent receives its shared artifact");

  app.store.profiles.switch({ profileId: null });
  const ownerView = await call(`/api/trunks/rooms/${id}`);
  assert.equal(ownerView.body.events.find((event) => event.kind === "user")?.personName, "Sam");
  app.store.profiles.switch({ profileId: lee.id, pin: "5678" });
  const refused = await call(`/api/trunks/rooms/${id}`);
  assert.equal(refused.status, 403);
  assert.doesNotMatch(JSON.stringify(refused.body), /Private bench|private oak plan|Ann|Ben/);

  app.store.profiles.switch({ profileId: null });
  assert.equal((await call(`/api/trunks/rooms/${id}`, { people: [] })).status, 200);
  app.store.profiles.switch({ profileId: sam.id, pin: "1234" });
  const removed = await call(`/api/trunks/rooms/${id}`);
  assert.equal(removed.status, 403);
  assert.doesNotMatch(JSON.stringify(removed.body), /Private bench|private oak plan|Ann|Ben/);
  const removedConversation = await call(`/api/trunks/conversations/${made.body.room.sessionId}`);
  assert.equal(removedConversation.status, 400);
  assert.doesNotMatch(JSON.stringify(removedConversation.body), /Private bench|private oak plan|Ann|Ben/);
});

test("a household room view omits owner-only carried context and internal member sessions", async (t) => {
  const { app, call } = await served(t, seesAnn);
  on(app, "rooms");
  const ann = app.trunks.create({ name: "Ann" }), ben = app.trunks.create({ name: "Ben" });
  await app.trunks.introduced();
  const sam = app.store.profiles.create({ name: "Sam", pin: "1234" });
  const room = app.trunks.rooms.create({ name: "Shared", members: [ann.id, ben.id], people: [sam.id] },
    { context: "OWNER ONLY: before this room existed" });
  app.store.profiles.switch({ profileId: sam.id, pin: "1234" });
  const response = await call(`/api/trunks/rooms/${room.id}`);
  assert.equal(response.status, 200);
  assert.equal("context" in response.body, false);
  assert.equal("memberSessions" in response.body, false);
  assert.doesNotMatch(JSON.stringify(response.body), /OWNER ONLY/);
});
