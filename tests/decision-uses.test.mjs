/**
 * Settings › Models › Decision models, what they are used for (src/decision-models.ts pickTrunk and urgency):
 * - "Send each message to the right Trunk": in a room under "Everyone answers" or "Only who I tag", a message that names
 *   nobody goes to the one member whose job fits it; a tagged message, @all, an unsure or failed pick, and the switch off
 *   all leave the room's own rule. The pick is written on the message, so a replay never asks again.
 * - "Sort the Inbox by urgency": a 1-10 score per waiting row, asked once per row and words, a few per call; refused off.
 * Both ship off: every use is a model call the owner did not make.
 *
 * Mutation notes (each turns this file red):
 * - room-plan.ts firstResponders: ignore `options.picked`                -> "only the picked Trunk answers" fails.
 * - room-plan.ts wantsPick: drop the named-nobody check                   -> "a tagged message is never re-routed" fails.
 * - rooms.ts pickFor: drop writing `picked` on the message                -> "asked once" fails.
 * - decision-models.ts pickTrunk: drop the `!settings.route` check         -> "off: nobody is asked" fails.
 * - decision-models.ts pickTrunk: drop the minConfidence check             -> "an unsure pick" fails.
 * - decision-models.ts urgency: drop the kept-score lookup                 -> "asked once per row" fails.
 * - decision-models.ts urgency: drop the per-request cap                   -> "a few per call" fails.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { nextRoomTurn, wantsPick } from "../dist/trunks/room-plan.js";
import { DecisionModels, urgencyPerRequest } from "../dist/decision-models.js";
import { startServer } from "../dist/server.js";
import { fixture, on } from "./trunks-helpers.mjs";

const at = "2026-09-27T00:00:00.000Z";
const kim = { id: "k", handle: "kim", name: "Kim" }, lee = { id: "l", handle: "lee", name: "Lee" }, max = { id: "m", handle: "max", name: "Max" };
const members = [kim, lee, max];
const user = (text, rule, extra = {}) => ({ seq: 1, kind: "user", text, at, rule, ...extra });

test("the plan: a picked member answers alone; tagged messages, @all, 'lead', 'all' and 'together' are never asked", () => {
  assert.equal(wantsPick([user("did we pay the invoice?", "mention")], members, "mention")?.seq, 1);
  assert.equal(wantsPick([user("did we pay the invoice?", "tag")], members, "tag")?.seq, 1);
  for (const [text, rule] of [["@lee did we pay?", "mention"], ["@all did we pay?", "mention"], ["@everyone hi", "tag"], ["hi", "lead"], ["hi", "all"], ["hi", "together"]])
    assert.equal(wantsPick([user(text, rule)], members, rule), undefined, `${rule}: ${text}`);
  assert.equal(wantsPick([user("hi", "mention", { picked: null })], members, "mention"), undefined, "asked already");
  assert.equal(wantsPick([user("hi", "mention")], [kim], "mention"), undefined, "one Trunk: nothing to choose");
  const picked = nextRoomTurn("Work", members, [user("did we pay?", "mention", { picked: "l" })], "", { rule: "mention" });
  assert.equal(picked.task.memberId, "l");
  const none = nextRoomTurn("Work", members, [user("did we pay?", "mention", { picked: null })], "", { rule: "mention" });
  assert.equal(none.task.memberId, "k", "nobody picked: the rule answers (everyone, in turn)");
  const gone = nextRoomTurn("Work", members.filter((m) => m.id !== "l"), [user("did we pay?", "tag", { picked: "l" })], "", { rule: "tag", lead: "k" });
  assert.equal(gone.task.memberId, "k", "a picked Trunk no longer seated: the lead answers");
});

const pickRule = (choice, confidence = 0.9) => ({ request }) => {
  const text = request.messages.map((m) => String(m.content ?? "")).join("\n");
  return /Pick exactly one/.test(text) ? JSON.stringify({ choice, confidence, why: "Money is Ben's job." }) : null;
};

async function room(t, rules) {
  const { app, provider } = await fixture(t, rules);
  on(app, "rooms");
  const ann = app.trunks.create({ name: "Ann", description: "Plans trips and travel." });
  const ben = app.trunks.create({ name: "Ben", description: "Looks after invoices, bills and money." });
  await app.trunks.introduced();
  const made = app.trunks.rooms.create({ name: "Home", members: [ann.id, ben.id] });
  const say = async (text) => { app.trunks.rooms.send(made.id, { text }); await app.trunks.rooms.settled(made.id); };
  const answered = (text) => { const room = app.trunks.rooms.get(made.id), msg = room.events.findLast((e) => e.kind === "user" && e.text === text);
    return { msg, who: room.events.filter((e) => e.discussion === msg.seq && e.kind === "member").map((e) => e.memberId) }; };
  const asked = () => provider.requests.filter((r) => r.messages.some((m) => /Pick exactly one/.test(String(m.content ?? "")))).length;
  return { app, ann, ben, say, answered, asked };
}

test("on: a room message that names nobody goes to the Trunk whose job fits it, asked once", async (t) => {
  const r = await room(t, [pickRule("Ben")]);
  r.app.decisionModels.configure({ route: true });
  await r.say("Did we pay the plumber's invoice?");
  const first = r.answered("Did we pay the plumber's invoice?");
  assert.deepEqual(first.who, [r.ben.id], "only the picked Trunk answers");
  assert.equal(first.msg.picked, r.ben.id, "the pick is written on the message");
  assert.equal(r.asked(), 1);
  r.app.trunks.rooms.kick(r.app.trunks.rooms.list()[0].id);
  await r.app.trunks.rooms.settled(r.app.trunks.rooms.list()[0].id);
  assert.equal(r.asked(), 1, "a replay reads the pick from the log and never asks again");
  await r.say("@ann where should we go in May?");
  assert.deepEqual(r.answered("@ann where should we go in May?").who, [r.ann.id], "a tagged message is never re-routed");
  assert.equal(r.asked(), 1, "and nobody is asked about it");
});

test("off (as shipped): nobody is asked and everyone answers", async (t) => {
  const r = await room(t, [pickRule("Ben")]);
  assert.equal(r.app.decisionModels.settings().route, false);
  await r.say("Did we pay the invoice?");
  assert.equal(r.asked(), 0);
  assert.deepEqual(r.answered("Did we pay the invoice?").who.sort(), [r.ann.id, r.ben.id].sort());
});

test("an unsure pick, or one that is not a member, leaves the room's own rule", async (t) => {
  const unsure = await room(t, [pickRule("Ben", 0.4)]);
  unsure.app.decisionModels.configure({ route: true });
  await unsure.say("Hmm, what about this?");
  const was = unsure.answered("Hmm, what about this?");
  assert.equal(was.msg.picked, null, "asked, nobody picked");
  assert.equal(was.who.length, 2, "everyone answers");
  const stranger = await room(t, [pickRule("Zed")]);
  stranger.app.decisionModels.configure({ route: true });
  await stranger.say("Who is on this?");
  assert.equal(stranger.answered("Who is on this?").msg.picked, null);
  assert.equal(stranger.answered("Who is on this?").who.length, 2);
});

test("a full room's question keeps the message whole and names every member", async (t) => {
  const { app } = await fixture(t);
  const asked = [];
  const models = new DecisionModels(app.store, app.runtime.owner, app.runtime.models, async (text) => { asked.push(text); return { status: "resolved", value: { choice: "Member number five of this room!", confidence: 0.9, why: "" } }; });
  models.configure({ route: true });
  const members = Array.from({ length: 6 }, (_, i) => ({ id: `m${i}`, name: `Member number ${["one", "two", "three", "four", "five", "six"][i]} of this room!`.slice(0, 40), job: "x".repeat(300) }));
  const picked = await models.pickTrunk("Please check whether the plumber's invoice from March was paid in full.", members);
  assert.equal(picked.id, "m4");
  assert.match(asked[0], /The message: Please check whether the plumber's invoice from March was paid in full\./, "the message is never cut off");
  for (const member of members) assert.ok(asked[0].includes(member.name.slice(0, 20)), `${member.name} is named`);
});

test("a message tagging a paused Trunk names somebody, so nobody is asked", async (t) => {
  const r = await room(t, [pickRule("Ben")]);
  r.app.decisionModels.configure({ route: true });
  const cy = r.app.trunks.create({ name: "Cy", description: "Paused one." });
  const made = r.app.trunks.rooms.list()[0];
  r.app.trunks.rooms.edit(made.id, { members: [...made.members, cy.id] });
  r.app.trunks.pause.pause(cy.id, {});
  await r.say(`@${cy.handle} are you there?`);
  assert.equal(r.asked(), 0, "a tag is read against every seat");
});

test("Sort the Inbox by urgency: refused off; scores asked once per row and words, a few per call; a refusal is said", async (t) => {
  const { app } = await fixture(t);
  const asked = [];
  const models = new DecisionModels(app.store, app.runtime.owner, app.runtime.models, async (text) => {
    asked.push(text);
    if (/broken/.test(text)) return { status: "refused", reason: "The model gave no score." };
    return { status: "resolved", value: { score: /due tomorrow|\$/.test(text) ? 9 : 2, confidence: 0.9, why: "" } };
  });
  await assert.rejects(models.urgency({ items: [{ key: "a", text: "x" }] }), (error) => error.status === 409);
  models.configure({ inbox: true });
  const first = await models.urgency({ items: [{ key: "ask:1", text: "Pay the $1,340 invoice, due tomorrow" }, { key: "tmsg:2", text: "Lunch on Friday?" }] });
  assert.deepEqual(first.scores, { "ask:1": 9, "tmsg:2": 2 });
  assert.equal(asked.length, 2);
  const again = await models.urgency({ items: [{ key: "ask:1", text: "Pay the $1,340 invoice, due tomorrow" }, { key: "tmsg:2", text: "Lunch on Friday?" }] });
  assert.deepEqual(again.scores, first.scores);
  assert.equal(asked.length, 2, "asked once per row and words");
  await models.urgency({ items: [{ key: "tmsg:2", text: "Lunch on Saturday instead?" }] });
  assert.equal(asked.length, 3, "new words are asked again");
  const many = Array.from({ length: 12 }, (_, i) => ({ key: `install:${i}`, text: `Request ${i}` }));
  const capped = await models.urgency({ items: many });
  assert.equal(Object.keys(capped.scores).length, urgencyPerRequest);
  assert.equal(capped.pending, 12 - urgencyPerRequest, "the rest wait for the next read");
  const bad = await models.urgency({ items: [{ key: "x", text: "a broken one" }] });
  assert.equal(bad.problem, "The model gave no score.");
  assert.deepEqual(bad.scores, {}, "left without a score");
});

test("over HTTP: the switches save through the settings route, and urgency is the owner's route", async (t) => {
  const { app, root } = await fixture(t);
  const server = await startServer(app, { dataDir: `${root}/data`, port: 0, host: "127.0.0.1" });
  t.after(() => server.close());
  const ask = (path, body) => fetch(new URL(path, server.url), { method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    .then(async (response) => ({ status: response.status, body: await response.json() }));
  const read = (await ask("/api/decisions")).body.settings;
  assert.equal(read.route, false);
  assert.equal(read.inbox, false);
  assert.equal((await ask("/api/decisions/urgency", { items: [] })).status, 409, "off: refused");
  assert.equal((await ask("/api/decisions/settings", { route: true, inbox: true })).status, 200);
  const now = (await ask("/api/decisions")).body.settings;
  assert.equal(now.route, true);
  assert.equal(now.inbox, true);
  const empty = await ask("/api/decisions/urgency", { items: [] });
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body.scores, {});
  assert.equal((await ask("/api/decisions/urgency", { items: [{ key: "", text: "x" }] })).status, 400);
});
