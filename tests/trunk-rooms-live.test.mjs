/**
 * trunk-rooms-live: the owner's room controls. "Everyone answers" (talking freely, each Trunk answers once; a tag addresses
 * that Trunk; a Trunk's @mention brings nobody in), "Only who I tag" (the Trunks tagged, exactly those; an untagged message
 * gets one answer, from the lead; nobody is brought in) and "Work together" (a lead plans, only the Trunks it names add their part, a repeated part is a pass, and the lead
 * writes the one reply, within the round cap). Each message keeps the rule it was sent under. Trunks outside a room see
 * nothing of it, and neither a household person nor a short-lived key can make a room with the owner's Trunks.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { answersAlone, echoes, maxMessagesPerSend, maxRounds, nextRoomTurn } from "../dist/trunks/room-plan.js";
import { TrunkRooms } from "../dist/trunks/rooms.js";
import { fixture, on } from "./trunks-helpers.mjs";

const kim = { id: "k", handle: "kim", name: "Kim" }, lee = { id: "l", handle: "lee", name: "Lee" }, max = { id: "m", handle: "max", name: "Max" };
const members = [kim, lee, max];
const at = "2026-09-26T00:00:00.000Z";
let seq = 0;
const user = (text, rule) => ({ seq: ++seq, kind: "user", text, at, ...(rule ? { rule } : {}) });
const said = (task, text, kind = "member") => ({ seq: ++seq, kind, text: kind === "member" ? text : "", at, memberId: task.memberId, round: task.round, discussion: task.discussion, seen: task.seen });
/** Plays one owner message to its end, each member answering with `answer(task)`; returns the turns taken. */
function play(events, answer, options) {
  const turns = [];
  for (let i = 0; i < 40; i++) {
    const next = nextRoomTurn("Work", members, events, "", options);
    if (next.status !== "task") return { turns, end: next };
    turns.push(next.task);
    const text = answer(next.task);
    events.push(said(next.task, text, text === "(pass)" ? "pass" : "member"));
  }
  throw new Error("the room never settled");
}

test("Everyone answers: talking freely every Trunk answers; a tag addresses only that Trunk", () => {
  seq = 0;
  const free = play([user("hello", "mention")], () => "hi");
  assert.deepEqual(free.turns.map((x) => x.memberId), ["k", "l", "m"]);
  seq = 0;
  const tagged = play([user("@lee what now?", "mention")], () => "this");
  assert.deepEqual(tagged.turns.map((x) => x.memberId), ["l"]);
  // qa-fixes-3 (Q042): every Trunk naming the others still makes one answer each, and nobody is asked to @mention.
  seq = 0;
  const chatty = play([user("hi both", "mention")], (task) => `Hello! ${members.filter((m) => m.id !== task.memberId).map((m) => `@${m.handle}`).join(" ")} what do you think?`);
  assert.deepEqual(chatty.turns.map((x) => `${x.round}:${x.memberId}`), ["0:k", "0:l", "0:m"]);
  assert.deepEqual(chatty.end, { status: "settled", reason: "silent_round", discussion: 1 });
  assert.doesNotMatch(chatty.turns[0].prompt, /bring it into the next round/);
});

test("Only who I tag: exactly the Trunks tagged; an untagged message gets one answer, from the lead", () => {
  seq = 0;
  const events = [user("hello", "tag")];
  let run = play(events, () => "hi", { lead: "k" });
  assert.deepEqual(run.turns.map((x) => x.memberId), ["k"], "untagged: the lead alone");
  events.push(user("@max can you check?", "tag"));
  run = play(events, () => "Sure, and @lee @kim should look too.", { lead: "k" });
  assert.deepEqual(run.turns.map((x) => x.memberId), ["m"], "a member's @mention brings nobody in");
  assert.match(run.turns[0].prompt, /Only you answer this message/);
  assert.doesNotMatch(run.turns[0].prompt, /bring it into the next round/);
  events.push(user("and after that?", "tag"));
  // qa-fixes-3 (Q041, the owner's words): talking freely under this toggle is the lead alone, not the Trunk tagged before.
  // Mutation: under "tag", let an untagged message go to the Trunk tagged last → Max answers, red.
  run = play(events, () => "Then done.", { lead: "k" });
  assert.deepEqual(run.turns.map((x) => x.memberId), ["k"], "untagged again: still the lead alone");
  events.push(user("@kim @lee both of you", "tag"));
  run = play(events, () => "ok", { lead: "k" });
  assert.deepEqual(run.turns.map((x) => x.memberId), ["k", "l"], "tagging always addresses those Trunks");
});

test("a message keeps the rule it was sent under, so changing the rule mid-discussion replans nothing", () => {
  seq = 0;
  const events = [user("hello", "mention")];
  const first = nextRoomTurn("Work", members, events, "", { rule: "tag", lead: "k" });
  assert.equal(first.task.memberId, "k");
  events.push(said(first.task, "hi"));
  // The room is now "Only who I tag", but this message was sent under "Everyone answers": the others still answer it.
  assert.equal(nextRoomTurn("Work", members, events, "", { rule: "tag", lead: "k" }).task.memberId, "l");
  // A message saved before rules were kept on it follows the room's rule.
  seq = 0;
  assert.equal(play([user("hello")], () => "hi", { rule: "mention" }).turns.length, 3);
});

test("Work together: the lead plans, only the Trunks it named add a part, and the lead writes the one reply", () => {
  seq = 0;
  const events = [user("Plan the offsite", "together")];
  const run = play(events, (task) => {
    if (task.role === "plan") return "@lee books the venue, @max checks the budget.";
    if (task.role === "part") return task.memberId === "l" ? "Venue: the lake hall is free." : "Budget: fits, with room to spare.";
    return "Offsite: the lake hall, and it fits the budget.";
  }, { lead: "k" });
  assert.deepEqual(run.turns.map((x) => [x.memberId, x.round, x.role]), [["k", 0, "plan"], ["l", 1, "part"], ["m", 1, "part"], ["k", 2, "final"]]);
  assert.match(run.turns[0].prompt, /gives each Trunk its own part by its @name/);
  assert.match(run.turns[2].prompt, /@lee: Venue: the lake hall is free\./, "a later part sees the parts before it");
  assert.match(run.turns[2].prompt, /nothing another Trunk already wrote above/);
  assert.doesNotMatch(run.turns[2].prompt, /bring it into the next round/);
  assert.match(run.turns[3].prompt, /Write the one reply the owner reads/);
  assert.ok(run.turns.every((x) => x.round < maxRounds));
});

test("Work together: a lead that needs nobody answers alone; the reply still comes when every part passed", () => {
  seq = 0;
  let run = play([user("What time is it?", "together")], () => "Noon.", { lead: "k" });
  assert.deepEqual(run.turns.map((x) => x.role), ["plan"]);
  assert.ok(answersAlone("Noon.", "k", members) && !answersAlone("@lee over to you", "k", members));
  seq = 0;
  run = play([user("Plan it", "together")], (task) => (task.role === "plan" ? "@lee and @max, anything?" : task.role === "part" ? "(pass)" : "Here is the plan."), { lead: "k" });
  assert.deepEqual(run.turns.map((x) => x.role), ["plan", "part", "part", "final"], "the synthesis is not skipped");
  // The owner tagging a Trunk makes it the lead for that message.
  seq = 0;
  run = play([user("@max plan it", "together")], (task) => (task.role === "plan" ? "@kim you do it" : "done"), { lead: "k" });
  assert.deepEqual(run.turns.map((x) => [x.memberId, x.role]), [["m", "plan"], ["k", "part"], ["m", "final"]]);
});

test("Work together: parts that keep @mentioning start no chatter, and the caps hold", () => {
  seq = 0;
  const six = ["a", "b", "c", "d", "e", "f"].map((h) => ({ id: h, handle: h, name: h.toUpperCase() }));
  const events = [user("go", "together")];
  const turns = [];
  for (let i = 0; i < 40; i++) {
    const next = nextRoomTurn("Busy", six, events, "", { lead: "a" });
    if (next.status !== "task") break;
    turns.push(next.task);
    events.push(said(next.task, `@all @a @b @c @d @e @f again ${turns.length}`));
  }
  assert.equal(turns.length, 7, "the plan, five parts and the reply");
  assert.ok(turns.length <= maxMessagesPerSend);
  assert.ok(turns.every((x) => x.round < maxRounds));
  assert.equal(turns.filter((x) => x.role === "final").length, 1);
});

test("the dedupe: the same words, or all of them inside something already said, is an echo", () => {
  assert.ok(echoes("The lake hall is free.", ["@lee: the lake hall is free"]));
  assert.ok(echoes("the lake hall is free on friday", ["Venue: the lake hall is free on Friday, booked."]));
  assert.ok(!echoes("The budget fits.", ["The lake hall is free."]));
  assert.ok(!echoes("ok", ["ok then, we are done here"]), "a short word inside a longer message is not an echo");
});

/** A runtime that answers each turn from `answer(options)`. */
function scripted(answer) {
  const fake = { runs: [], async run(options) {
    fake.runs.push(options);
    options.onStarted?.({ id: `run-${fake.runs.length}` });
    return { id: `run-${fake.runs.length}`, sessionId: options.sessionId, status: "completed", output: answer(options) };
  }, approve: () => ({}), waitingApprovals: () => [], cancel: () => true };
  return fake;
}

test("a room working together: one reply reaches its conversation per message, and a repeated part is kept as a pass", async (t) => {
  const { app } = await fixture(t);
  on(app, "rooms");
  const ann = app.trunks.create({ name: "Ann" }), ben = app.trunks.create({ name: "Ben" }), cy = app.trunks.create({ name: "Cy" });
  await app.trunks.introduced();
  const fake = scripted(({ prompt }) => {
    if (/You lead this piece of work/.test(prompt)) return "@ben find a date, @cy find a place.";
    if (/The parts are in/.test(prompt)) return "Friday, at the lake hall.";
    if (/You are @ben/.test(prompt)) return "Friday works for everyone.";
    return "Friday works for everyone."; // Cy only repeats Ben
  });
  const rooms = new TrunkRooms({ store: app.store, owner: app.runtime.owner, records: app.trunks.records, runtime: fake, notify: () => undefined, changed: () => undefined });
  const room = rooms.create({ name: "Offsite", members: [ann.id, ben.id, cy.id], rule: "together" });
  rooms.send(room.id, { text: "Plan the offsite" });
  await rooms.settled(room.id);
  const events = rooms.get(room.id).events;
  assert.deepEqual(events.map((e) => [e.kind, e.round ?? null, e.final ?? false]),
    [["user", null, false], ["member", 0, false], ["member", 1, false], ["pass", 1, false], ["member", 2, true]]);
  assert.equal(events[0].rule, "together", "the message keeps its rule");
  const replies = app.store.messages(room.sessionId).filter((m) => m.role === "assistant").map((m) => m.content);
  assert.deepEqual(replies, ["@ann: Friday, at the lake hall."], "only the one reply joins the room's conversation");
  // The owner switches the room to "Only who I tag": the next message gets exactly one answer.
  rooms.edit(room.id, { rule: "tag" });
  rooms.send(room.id, { text: "@cy anything else?" });
  await rooms.settled(room.id);
  const after = rooms.get(room.id).events.filter((e) => e.discussion === rooms.get(room.id).events.at(-1).discussion);
  assert.deepEqual(after.map((e) => e.memberId), [cy.id]);
});

test("Trunks outside a room see nothing of it, and a member sees only that room, never another Trunk's own chat", async (t) => {
  const { app, provider } = await fixture(t, [({ last }) => (String(last?.content ?? "").startsWith("[Room") ? "Noted." : null)]);
  on(app, "rooms");
  const ann = app.trunks.create({ name: "Ann" }), ben = app.trunks.create({ name: "Ben" }), cy = app.trunks.create({ name: "Cy" });
  await app.trunks.introduced();
  await app.runtime.run({ prompt: "Ann's secret word is heliotrope", sessionId: ann.chatSessionId });
  const room = app.trunks.rooms.create({ name: "Pair", members: [ann.id, ben.id] });
  app.trunks.rooms.send(room.id, { text: "The room's word is marmalade" });
  await app.trunks.rooms.settled(room.id);
  const text = (request) => request.messages.map((m) => String(m.content ?? "")).join("\n");
  const inRoom = provider.requests.filter((r) => /\[Room "Pair"\]/.test(text(r)));
  assert.equal(inRoom.length, 2, "both members took a turn");
  assert.ok(inRoom.every((r) => !/heliotrope/.test(text(r))), "a room turn never carries a Trunk's own chat");
  const before = provider.requests.length;
  await app.runtime.run({ prompt: "What is the word?", sessionId: cy.chatSessionId });
  const cyRequests = provider.requests.slice(before);
  assert.ok(cyRequests.length > 0);
  assert.ok(cyRequests.every((r) => !/marmalade|Pair/.test(text(r))), "a Trunk outside the room sees nothing of it");
  await app.runtime.run({ prompt: "What is the word?", sessionId: ben.chatSessionId });
  assert.ok(provider.requests.slice(before).every((r) => !/heliotrope/.test(text(r))), "Ben never sees Ann's own chat");
});

test("household people and short-lived keys can neither make a room with the owner's Trunks nor change who answers", async (t) => {
  let closeServer = async () => undefined;
  const made = await fixture({ after: (hook) => t.after(async () => { await closeServer(); await hook(); }) });
  const { app } = made;
  on(app, "rooms");
  const { startServer } = await import("../dist/server.js");
  const server = await startServer(app, { dataDir: join(made.root, "data"), port: 0, host: "127.0.0.1" });
  closeServer = () => server.close();
  const call = async (path, body, token = server.token) => {
    const response = await fetch(new URL(path, server.url), { method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const ann = app.trunks.create({ name: "Ann" }), ben = app.trunks.create({ name: "Ben" });
  await app.trunks.introduced();
  const owned = (await call("/api/trunks/rooms", { name: "Ann and Ben", members: [ann.id, ben.id] })).body.room;
  assert.ok(owned?.id, "the owner makes one");
  const key = app.sessionTokens.create(app.runtime.owner, { name: "script", scope: "run", minutes: 5 }).token;
  const byKey = await call("/api/trunks/rooms", { name: "By key", members: [ann.id, ben.id] }, key);
  assert.ok(byKey.status >= 400, `a key is refused (${byKey.status})`);
  assert.ok((await call(`/api/trunks/rooms/${owned.id}`, { rule: "all" }, key)).status >= 400);
  const sam = app.store.profiles.create({ name: "Sam", pin: "1234" });
  app.store.profiles.switch({ profileId: sam.id, pin: "1234" });
  const byPerson = await call("/api/trunks/rooms", { name: "By Sam", members: [ann.id, ben.id] });
  assert.ok(byPerson.status >= 400, `a household person is refused (${byPerson.status})`);
  assert.ok((await call(`/api/trunks/rooms/${owned.id}`, { rule: "all" })).status >= 400);
  assert.deepEqual(app.trunks.rooms.list().map((r) => [r.name, r.rule]), [["Ann and Ben", "mention"]], "nothing else was made or changed");
});

test("working together: a plan that restates the task, and a part in the plan's own words, are kept; only a repeated part is a pass", async (t) => {
  const { app } = await fixture(t);
  on(app, "rooms");
  const ann = app.trunks.create({ name: "Ann" }), ben = app.trunks.create({ name: "Ben" }), cy = app.trunks.create({ name: "Cy" });
  await app.trunks.introduced();
  const fake = scripted(({ prompt }) => {
    if (/You lead this piece of work/.test(prompt)) return "Plan the offsite with the others: @ben confirm the lake hall is free on Friday, @cy too.";
    if (/The parts are in/.test(prompt)) return "The lake hall is free on Friday.";
    return "The lake hall is free on Friday."; // Ben confirms in the plan's words; Cy says the same as Ben
  });
  const rooms = new TrunkRooms({ store: app.store, owner: app.runtime.owner, records: app.trunks.records, runtime: fake, notify: () => undefined, changed: () => undefined });
  const room = rooms.create({ name: "Offsite", members: [ann.id, ben.id, cy.id], rule: "together" });
  rooms.send(room.id, { text: "Plan the offsite with the others" });
  await rooms.settled(room.id);
  const events = rooms.get(room.id).events.filter((e) => e.kind !== "user");
  assert.deepEqual(events.map((e) => [e.kind, e.memberId, e.round, e.final ?? false]),
    [["member", ann.id, 0, false], ["member", ben.id, 1, false], ["pass", cy.id, 1, false], ["member", ann.id, 2, true]]);
});

test("the engine's own owner check refuses a household person making a room or changing who answers, past the route tables", async (t) => {
  const { app } = await fixture(t);
  on(app, "rooms");
  const { trunksApi } = await import("../dist/trunks/api.js");
  const ann = app.trunks.create({ name: "Ann" }), ben = app.trunks.create({ name: "Ben" });
  await app.trunks.introduced();
  const sam = app.store.profiles.create({ name: "Sam", pin: "1234" });
  const room = app.trunks.rooms.create({ name: "Ann and Ben", members: [ann.id, ben.id], people: [sam.id] });
  app.store.profiles.switch({ profileId: sam.id, pin: "1234" });
  // Straight to src/trunks/api.ts, as the server hands it a request the route tables let through: Sam is in the room.
  const call = (path, body) => trunksApi({ trunks: app.trunks, method: "POST", readBody: async () => body,
    person: { id: sam.id, name: sam.name }, requireOwner: (what) => app.store.profiles.requireOwner(what) }, path);
  await assert.rejects(call("/api/trunks/rooms", { name: "By Sam", members: [ann.id, ben.id] }), "making a room is the owner's");
  await assert.rejects(call(`/api/trunks/rooms/${room.id}`, { rule: "together" }), "changing who answers is the owner's");
  assert.deepEqual(app.trunks.rooms.list().map((r) => [r.name, r.rule]), [["Ann and Ben", "mention"]], "nothing else was made or changed");
});
