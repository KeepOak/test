/**
 * R17-A: rooms where Trunks talk together (T-09), and direct messages between Trunks (T-10).
 * The room planner is pure, so its rules are checked on their own first.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { asksForOwner, isPass, nextRoomTurn, resolveMentions } from "../dist/trunks/room-plan.js";
import { TrunkRooms } from "../dist/trunks/rooms.js";
import { TrunkMessages } from "../dist/trunks/messages.js";
import { call, fixture, on } from "./trunks-helpers.mjs";

const kim = { id: "k", handle: "kim", name: "Kim" }, lee = { id: "l", handle: "lee", name: "Lee" }, max = { id: "m", handle: "max", name: "Max" };
const members = [kim, lee, max];
let seq = 0;
const at = "2026-09-17T00:00:00.000Z";
const user = (text) => ({ seq: ++seq, kind: "user", text, at });
const said = (member, text, round, discussion, seen, kind = "member") => ({ seq: ++seq, kind, text, at, memberId: member.id, round, discussion, seen });

test("the planner: mentions pick who answers, later rounds only for those called on, and every cap holds", () => {
  seq = 0;
  assert.deepEqual(resolveMentions(["hello"], members).map((m) => m.id), ["k", "l", "m"]);
  assert.deepEqual(resolveMentions(["@lee and @max, please"], members).map((m) => m.id), ["l", "m"]);
  assert.deepEqual(resolveMentions(["@LEE: @all"], members).map((m) => m.id), ["k", "l", "m"]);
  assert.deepEqual(resolveMentions(["mail me at a@b.com"], members, false), []);
  assert.ok(isPass("(pass)") && isPass(" Pass. ") && isPass("") && !isPass("I pass the salt"));
  assert.ok(asksForOwner("@you decide") && asksForOwner("over to @owner.") && !asksForOwner("@kim decide"));
  assert.deepEqual(nextRoomTurn("r", members, []), { status: "idle" });
  // Round one: only @lee.
  const events = [user("@lee what do you think?")];
  let next = nextRoomTurn("Trip", members, events);
  assert.equal(next.status, "task");
  assert.equal(next.task.memberId, "l");
  assert.equal(next.task.round, 0);
  assert.match(next.task.prompt, /\[Room "Trip"\] You are @lee, talking with @kim, @max and the owner\./);
  assert.match(next.task.prompt, /The owner: @lee what do you think\?/);
  assert.match(next.task.prompt, /exactly "\(pass\)"/);
  // Lee calls on Max; round two is Max alone.
  events.push(said(lee, "Ask @max about trains.", 0, 1, next.task.seen));
  next = nextRoomTurn("Trip", members, events);
  assert.equal(next.task.memberId, "m");
  assert.equal(next.task.round, 1);
  assert.match(next.task.prompt, /@lee: Ask @max about trains\./);
  // Max passes, so the round is silent and the discussion settles.
  events.push(said(max, "", 1, 1, next.task.seen, "pass"));
  assert.deepEqual(nextRoomTurn("Trip", members, events), { status: "settled", reason: "silent_round", discussion: 1 });
  // A new message from the owner opens a new discussion; everyone is asked, from what each has not seen.
  events.push(user("New topic"));
  next = nextRoomTurn("Trip", members, events);
  assert.equal(next.task.memberId, "k");
  assert.match(next.task.prompt, /@lee what do you think/, "Kim has seen nothing yet, so it gets the whole thread");
  events.push(said(kim, "ok", 0, 4, next.task.seen));
  next = nextRoomTurn("Trip", members, events);
  assert.equal(next.task.memberId, "l");
  assert.doesNotMatch(next.task.prompt, /what do you think/, "Lee only gets what is new since its last turn");
  // Stopping closes the discussion.
  assert.deepEqual(nextRoomTurn("Trip", members, [...events, { seq: ++seq, kind: "stopped", text: "", at }]), { status: "idle" });
  // A member waiting for the owner holds the room until the answer.
  const waiting = [...events, { ...said(lee, "may I?", 0, 4, 5, "waiting") }];
  assert.deepEqual(nextRoomTurn("Trip", members, waiting), { status: "waiting", memberId: "l" });
  waiting.at(-1).answered = true;
  assert.equal(nextRoomTurn("Trip", members, waiting).task.memberId, "l", "once answered, the member takes its turn again");
});

test("the planner never goes past three rounds or ten messages for one message from the owner", () => {
  seq = 0;
  const events = [user("go")];
  // Everyone keeps calling on everyone else.
  for (let turns = 0; turns < 30; turns++) {
    const next = nextRoomTurn("Loop", members, events);
    if (next.status !== "task") {
      assert.deepEqual(next, { status: "bounded", reason: "max_rounds", discussion: 1 });
      break;
    }
    const others = members.filter((m) => m.id !== next.task.memberId).map((m) => `@${m.handle}`).join(" ");
    events.push(said(members.find((m) => m.id === next.task.memberId), `over to ${others}`, next.task.round, 1, next.task.seen));
  }
  assert.equal(events.filter((e) => e.kind === "member").length, 9, "three rounds of three");
  const six = [{ id: "a", handle: "a", name: "A" }, { id: "b", handle: "b", name: "B" }, { id: "c", handle: "c", name: "C" },
    { id: "d", handle: "d", name: "D" }, { id: "e", handle: "e", name: "E" }, { id: "f", handle: "f", name: "F" }];
  seq = 0;
  const busy = [user("go")];
  for (let turns = 0; turns < 40; turns++) {
    const next = nextRoomTurn("Busy", six, busy);
    if (next.status !== "task") { assert.deepEqual(next, { status: "bounded", reason: "max_messages", discussion: 1 }); break; }
    busy.push(said(six.find((m) => m.id === next.task.memberId), "@all again", next.task.round, 1, next.task.seen));
  }
  assert.equal(busy.filter((e) => e.kind === "member").length, 10);
});

test("the planner carries the sender's authority onto every room task", () => {
  const byKey = { keyId: "sam-key", sessionId: "phone" };
  const events = [{ seq: 1, kind: "user", text: "@kim help", at,
    personId: "sam-profile", personName: "Sam", byKey }];
  const next = nextRoomTurn("Private", members, events);
  assert.equal(next.status, "task");
  assert.equal(next.task.personId, "sam-profile");
  assert.deepEqual(next.task.byKey, byKey);
});

test("a room of Trunks: each answers as itself, @mentions pull others in, and @you raises needs-you", async (t) => {
  const rules = [({ last, system, request }) => {
    const text = last?.content ?? "";
    if (!text.startsWith("[Room")) return null;
    assert.equal(request.tools?.some((tool) => tool.name === "trunk.message") ?? false, false, "no direct messages from inside a room");
    if (/\nYou are Kim \(@kim\)/.test(system)) return /Plan the trip/.test(text) ? "I will book trains. @lee can you find a hotel?" : "(pass)";
    if (/\nYou are Lee \(@lee\)/.test(system)) return /@kim: I will book/.test(text) ? "Found one. @you please approve the price." : "(pass)";
    return null;
  }];
  const { app } = await fixture(t, rules);
  on(app, "messages");
  const k = app.trunks.create({ name: "Kim" });
  const l = app.trunks.create({ name: "Lee" });
  await app.trunks.introduced();
  app.trunks.setMode("rooms", { mode: "off" }); // ships "when needed" (the owner's rule, 2026-09-26); "off" is tested switched off
  assert.throws(() => app.trunks.require("rooms"), /Rooms where Trunks talk together is switched off/);
  app.trunks.setMode("rooms", { mode: "on" });
  assert.throws(() => app.trunks.rooms.create({ name: "Solo", members: [k.id] }));
  assert.throws(() => app.trunks.rooms.create({ name: "Twice", members: [k.id, k.id] }), /only once/);
  const room = app.trunks.rooms.create({ name: "Trip", members: [k.id, l.id] });
  assert.throws(() => app.trunks.rooms.create({ name: "trip", members: [k.id, l.id] }), /already has that name/);
  assert.equal(app.trunks.keeps(room.sessionId), true);
  app.trunks.rooms.send(room.id, { text: "Plan the trip" });
  await app.trunks.rooms.settled(room.id);
  const view = app.trunks.rooms.view(room.id);
  assert.deepEqual(view.events.filter((e) => e.kind === "member").map((e) => e.text),
    ["I will book trains. @lee can you find a hotel?", "Found one. @you please approve the price."]);
  assert.equal(view.needsYou, true);
  const transcript = app.store.messages(room.sessionId).filter((m) => m.role !== "system").map((m) => m.content);
  assert.deepEqual(transcript, ["Plan the trip", "@kim: I will book trains. @lee can you find a hotel?", "@lee: Found one. @you please approve the price."]);
  // Each member spoke in its own conversation for this room, run as that Trunk.
  const kimRun = app.store.runs(app.runtime.owner).find((run) => run.sessionId === room.memberSessions[k.id]);
  assert.equal(app.store.events(kimRun.id).find((e) => e.kind === "trunk.turn").data.trunkId, k.id);
  // The owner answering clears needs-you; the roster shows the room.
  app.trunks.rooms.send(room.id, { text: "@kim thanks" });
  await app.trunks.rooms.settled(room.id);
  assert.equal(app.trunks.rooms.get(room.id).needsYou, false);
  assert.equal(app.trunks.roster().rooms[0].name, "Trip");
  // Removing a member of a two-seat room removes the room.
  app.trunks.remove(l.id);
  assert.equal(app.trunks.rooms.list().length, 0);
});

/** A runtime that answers from a list, for the parts of a room a real model cannot easily reach. */
function fakeRuntime(answers) {
  const fake = { runs: [], approvals: [], cancelled: [], pending: null,
    async run(options) {
      fake.runs.push(options);
      options.onStarted?.({ id: `run-${fake.runs.length}` });
      const next = answers.shift() ?? { status: "completed", output: "(pass)" };
      if (next === "hang") return new Promise((resolve) => { fake.pending = resolve; });
      return { id: `run-${fake.runs.length}`, sessionId: options.sessionId, ...next };
    },
    approve(sessionId, decision, remember) { fake.approvals.push({ sessionId, decision, remember }); return { decision }; },
    waitingApprovals: () => [],
    cancel(id) { fake.cancelled.push(id); return true; },
  };
  return fake;
}

test("a member waiting for a yes is answered in the room, a stop stops it, and a restart carries on", async (t) => {
  const { app } = await fixture(t);
  on(app, "rooms");
  const a = app.trunks.create({ name: "Ann" }), b = app.trunks.create({ name: "Ben" });
  await app.trunks.introduced();
  const flagged = [];
  const make = (runtime) => new TrunkRooms({ store: app.store, owner: app.runtime.owner, records: app.trunks.records, runtime,
    notify: (room, why) => flagged.push(why), changed: () => undefined });
  const fake = fakeRuntime([{ status: "needs_input", output: "May I send the email?" }, { status: "completed", output: "Sent." }]);
  const rooms = make(fake);
  const sam = app.store.profiles.create({ name: "Sam", pin: "1234" });
  const room = rooms.create({ name: "Mail", members: [a.id, b.id], people: [sam.id] });
  rooms.addArtifact(room.id, { name: "brief.txt", content: "keep this" }, null);
  rooms.send(room.id, { text: "@ann send it" });
  await rooms.settled(room.id);
  assert.equal(rooms.get(room.id).needsYou, true);
  assert.deepEqual(flagged, ["@ann is waiting for your answer", "A Trunk in the room is waiting for your answer"]);
  assert.throws(() => rooms.answer(room.id, { memberId: "00000000-0000-4000-8000-000000000000", decision: "allow" }), /not in this room/);
  rooms.answer(room.id, { memberId: a.id, decision: "allow" });
  assert.deepEqual(fake.approvals, [{ sessionId: room.memberSessions[a.id], decision: "allow", remember: "session" }]); // phase2/rooms: a yes holds for the member in this room
  await rooms.settled(room.id);
  assert.equal(fake.runs.length, 2, "Ann took its turn again");
  assert.deepEqual(rooms.get(room.id).events.filter((e) => e.kind === "member").map((e) => e.text), ["Sent."]);
  // A turn cut off by closing is not written down, so a fresh start takes it again.
  const hanging = fakeRuntime(["hang"]);
  const before = make(hanging);
  before.send(room.id, { text: "@ben one more" });
  await new Promise((resolve) => setImmediate(resolve));
  const closed = before.close();
  hanging.pending({ id: "x", status: "cancelled", output: "Cancelled" });
  await closed;
  assert.deepEqual(hanging.cancelled, ["run-1"]);
  assert.equal(before.get(room.id).events.at(-1).kind, "user");
  const after = make(fakeRuntime([{ status: "completed", output: "Done again." }]));
  assert.deepEqual(after.view(room.id).people, [{ id: sam.id, name: "Sam" }], "people survive a restart");
  assert.equal(after.view(room.id).artifacts[0].content, "keep this", "shared artifacts survive a restart");
  after.resumeAll();
  await after.settled(room.id);
  assert.equal(after.get(room.id).events.at(-1).text, "Done again.");
  // Stop: nobody else is asked.
  const stopper = make(fakeRuntime([]));
  stopper.send(room.id, { text: "everyone" });
  stopper.stop(room.id);
  await stopper.settled(room.id);
  assert.equal(stopper.get(room.id).events.at(-1).kind, "stopped");
});

test("trunk.message: checked against the roster, signed by Branch, answered later, and never from outside a Trunk's own chat", async (t) => {
  const rules = [({ system, last }) => {
    const text = last?.content ?? "";
    if (/\nYou are Ann \(@ann\)/.test(system)) {
      if (text === "ask ben") return call("trunk.message", { to: "@ben", message: "What time?" });
      if (last?.role === "tool") return "Asked.";
      if (text.startsWith("Reply from Ben (@ben)")) return "Thanks.";
    }
    if (/\nYou are Ben \(@ben\)/.test(system) && text.startsWith("Message from Ann (@ann):")) return "Noon.";
    return null;
  }];
  const { app, provider } = await fixture(t, rules);
  on(app, "messages");
  const ann = app.trunks.create({ name: "Ann" }), ben = app.trunks.create({ name: "Ben", title: "Scheduler" });
  await app.trunks.introduced();
  const asked = await app.runtime.run({ prompt: "ask ben", sessionId: ann.chatSessionId });
  assert.equal(asked.output, "Asked.");
  // Every Trunk's own instructions carry the roster with roles, and say how to reach the others.
  const annSystem = provider.requests.find((r) => r.messages.some((m) => m.role === "user" && m.content === "ask ben")).messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
  assert.match(annSystem, /- @ben: Ben, Scheduler/);
  assert.match(annSystem, /- @ann: Ann \(you\)/);
  assert.match(annSystem, /call trunk\.message/);
  for (let i = 0; i < 200 && app.trunks.messages.receipts().filter((r) => r.status === "answered").length < 2; i++)
    await new Promise((resolve) => setTimeout(resolve, 25));
  const receipts = app.trunks.messages.receipts().reverse();
  assert.deepEqual(receipts.map((r) => [r.kind, r.status, r.depth]), [["message", "answered", 1], ["reply", "answered", 1]]);
  assert.equal(receipts[0].reply, "Noon.");
  const benSaw = app.store.messages(ben.chatSessionId).map((m) => m.content);
  assert.ok(benSaw.includes("Message from Ann (@ann):\nWhat time?"));
  assert.ok(benSaw.includes("Noon."));
  const annSaw = app.store.messages(ann.chatSessionId).map((m) => m.content);
  assert.ok(annSaw.includes("Reply from Ben (@ben) to your message:\nNoon."));
  // Outside a Trunk's own conversation the tool refuses; so do unknown names and itself.
  await assert.rejects(app.registry.execute("trunk.message", { to: "@ben", message: "hi" }, app.runtime.context()), /only in a Trunk's own conversation/);
  const own = app.store.runs(app.runtime.owner).find((run) => run.sessionId === ann.chatSessionId);
  const context = { ...app.runtime.context({ runId: own.id }), agent: `trunk:${ann.id}` };
  await assert.rejects(app.registry.execute("trunk.message", { to: "@nobody", message: "hi" }, context), /No Trunk is called "@nobody". The Trunks are: @ann, @ben/);
  await assert.rejects(app.registry.execute("trunk.message", { to: "Ann", message: "hi" }, context), /to itself/);
  // Three messages deep is the end of it.
  const items = app.trunks.messages.receipts().reverse();
  app.store.save("settings", app.runtime.owner, "trunk-receipts", { items: [...items, { ...items[0], id: "deep", runId: own.id, depth: 3 }] });
  await assert.rejects(app.registry.execute("trunk.message", { to: "@ben", message: "again" }, context), /3 deep/);
});

test("a message that failed for a passing reason is tried once more; a second failure is reported to the sender", async (t) => {
  const { app } = await fixture(t);
  on(app, "messages");
  const ann = app.trunks.create({ name: "Ann" }), ben = app.trunks.create({ name: "Ben" });
  await app.trunks.introduced();
  app.trunks.messages.close(); // only the copy under test follows the tasks
  const sent = [];
  const messages = new TrunkMessages(app.store, app.runtime.owner, app.trunks.records, { followUp: (sessionId, prompt) => { sent.push({ sessionId, prompt }); return { id: "q", position: 1, queued: 1 }; } });
  t.after(() => messages.close());
  const own = await app.runtime.run({ prompt: "hi", sessionId: ann.chatSessionId });
  const context = { ...app.runtime.context({ runId: own.id }), agent: `trunk:${ann.id}` };
  app.trunks.setMode("messages", { mode: "on" });
  messages.send(context, { to: "ben", message: "ping" });
  const fail = (output) => {
    const run = app.store.createRun(app.runtime.owner, sent.at(-1).prompt, ben.chatSessionId);
    app.store.event(run.id, "run.started", {});
    app.store.event(run.id, "run.finished", { status: "failed", output });
  };
  fail("The provider said 429: rate limit reached");
  assert.equal(sent.length, 2, "tried once more");
  assert.equal(messages.receipts()[0].attempts, 2);
  fail("The provider said 429: rate limit reached");
  const receipt = messages.receipts().find((r) => r.kind === "message");
  assert.equal(receipt.status, "failed");
  assert.equal(sent.length, 3);
  assert.equal(sent[2].sessionId, ann.chatSessionId);
  assert.match(sent[2].prompt, /^Your message to @ben could not be answered/);
  // A failure no retry can fix is not retried.
  messages.send(context, { to: "ben", message: "pong" });
  fail("Your API key was refused");
  assert.equal(messages.receipts().find((r) => r.prompt.endsWith("pong")).status, "failed");
});
