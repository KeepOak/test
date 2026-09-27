/**
 * eng-trunk-controls: pausing a Trunk or all of them, a room's answering rule, and the owner's default way for
 * Trunks to work together.
 *
 * - A paused Trunk starts nothing new, whoever asks: its routines and schedules are held, a chat app, a trigger or a
 *   standing order aimed at its conversation is turned away, a message queued for it is not sent, and in a room it
 *   sits the turn out. Each says so in words. A task already running finishes, unless the owner pauses "now".
 *   Every pause and resume is written in the activity log, and only the pause routes change it.
 * - A room answers by mentions only (as always) unless its rule is "everyone, every time" or "a lead Trunk decides".
 * - The owner's way of working together is "Branch picks" until they choose; a room may choose its own. A
 *   multi-worker tool of another way waits for the owner's own yes.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { startServer } from "../dist/server.js";
import { nextRoomTurn } from "../dist/trunks/room-plan.js";
import { patternQuestion, patternNote } from "../dist/team-pattern.js";
import { fixture, on, call } from "./trunks-helpers.mjs";
/** Q257: the fingerprint of the question the window shows for a conversation; a bare answer is refused. */
const shownFingerprint = (app, sessionId) => app.runtime.approvals.questionFor(sessionId)?.fingerprint;

const hour = 3600000;
const inMinutes = (minutes) => new Date(Date.now() + minutes * 60000);

async function served(t, app, root) {
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(() => server.close());
  return async (path, body, method = body === undefined ? "GET" : "POST") => {
    const response = await fetch(server.url + path, { method, headers: { authorization: `Bearer ${server.token}`, origin: server.url, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
}

test("pausing a Trunk: nothing new starts from any source, each says so in words, and resume lets it work again", async (t) => {
  const { app, root } = await fixture(t);
  on(app, "routines", "rooms");
  const fi = app.trunks.create({ name: "Fi" });
  await app.trunks.introduced();
  app.trunks.edit(fi.id, { reach: { channels: ["telegram"], commands: false } });
  const ask = await served(t, app, root);
  const routine = app.trunks.routines.create(fi.id, { name: "News", prompt: "Check NEWS7401", dueAt: inMinutes(1).toISOString(), intervalMs: hour });

  // Only the pause route changes it: the generic edit refuses the field.
  assert.equal((await ask(`/api/trunks/${fi.id}`, { paused: true })).status, 400);
  const paused = await ask(`/api/trunks/${fi.id}/pause`, {});
  assert.equal(paused.status, 200);
  assert.equal(paused.body.trunk.paused, true);
  assert.equal(paused.body.stopped, 0);
  assert.equal((await ask("/api/trunks")).body.trunks.find((one) => one.id === fi.id).paused, true, "the roster shows it paused");
  const words = /Fi is paused, so .+\. Resume it under Customize → Trunks\./;

  // The owner's own message, and anything queued for it.
  await assert.rejects(app.trunks.say(fi.id, "hello"), words);
  assert.throws(() => app.trunks.requireQueueable(fi.chatSessionId), /this message was not sent/);
  // Its routine is held at its turn, and says why.
  const due = new Date(Date.parse(String(app.store.get("schedules", app.runtime.owner, routine.id).data.dueAt)) + 60000);
  await app.scheduler.tick(due);
  const health = app.scheduler.overview(app.runtime.owner).schedules.find((one) => one.id === routine.id).health;
  assert.equal(health.state, "held");
  assert.match(health.heldBecause, /this routine did not run/);
  // A schedule it made, a chat app, a trigger and a standing order in its conversation.
  assert.match(app.scheduler.trunkHeld(fi.id), /this schedule it made did not run/);
  assert.match(app.channels.trunkReach("telegram", fi.chatSessionId), /it did not answer/);
  const trigger = app.triggers.create(app.runtime.context(), { name: "Hook", prompt: "Go", sessionId: fi.chatSessionId });
  await assert.rejects(app.triggers.fire(app.runtime.owner, trigger.id, {}), /this trigger did not start anything/);
  assert.match(JSON.stringify(app.triggers.getLog(trigger.id, app.runtime.owner)), /this trigger did not start anything/, "the refused fire is logged");
  const order = await app.autonomy.runner.turn({ key: "order:x", prompt: "Go", permissions: [], perDay: 4, gapMs: 0, sessionId: fi.chatSessionId });
  assert.deepEqual(order, { ran: false, reason: "Fi is paused, so this did not start. Resume it under Customize → Trunks." });
  // A plain conversation of the owner's is untouched.
  assert.equal((await app.runtime.run({ prompt: "hi" })).status, "completed");

  // Written in the activity log, then resumed.
  assert.equal((await ask(`/api/trunks/${fi.id}/resume`, {})).body.trunk.paused, undefined);
  const log = (await ask("/api/audit")).body;
  const entries = (log.entries ?? log).filter((entry) => entry.action === "trunk.paused");
  assert.deepEqual(entries.map((entry) => entry.outcome).sort(), ["paused", "resumed"]);
  assert.equal((await app.trunks.say(fi.id, "hello")).status, "completed");
  assert.equal(app.channels.trunkReach("telegram", fi.chatSessionId), null);
});

test("pause now stops the running task; a plain pause lets it finish; pause all and resume all", async (t) => {
  let release;
  const slow = ({ request, last }) => (/SLOW7402/.test(String(last?.content ?? ""))
    ? new Promise((resolve, reject) => {
      release = () => resolve({ content: "Finished SLOW7402.", toolCalls: [] });
      request.signal.addEventListener("abort", () => reject(request.signal.reason ?? new Error("aborted")), { once: true });
    }) : null);
  const { app, root } = await fixture(t, [slow]);
  on(app);
  const fi = app.trunks.create({ name: "Fi" }), jo = app.trunks.create({ name: "Jo" });
  await app.trunks.introduced();
  const ask = await served(t, app, root);
  const started = () => new Promise((resolve) => { const wait = () => (release ? resolve() : setTimeout(wait, 5)); wait(); });

  // A plain pause: the task already running finishes.
  const finishing = app.trunks.say(fi.id, "SLOW7402");
  await started();
  assert.equal(app.runtime.runsOfTrunk(fi.id).length, 1);
  assert.equal((await ask(`/api/trunks/${fi.id}/pause`, {})).body.stopped, 0);
  release();
  assert.equal((await finishing).status, "completed");
  await ask(`/api/trunks/${fi.id}/resume`, {});

  // Pause now: the running task is stopped.
  release = undefined;
  const stopping = app.trunks.say(fi.id, "SLOW7402");
  await started();
  const now = await ask(`/api/trunks/${fi.id}/pause`, { now: true });
  assert.equal(now.body.stopped, 1);
  assert.notEqual((await stopping).status, "completed");
  assert.deepEqual(app.runtime.runsOfTrunk(fi.id), []);

  // All of them, and back.
  const all = await ask("/api/trunks/pause-all", {});
  assert.deepEqual(all.body, { paused: 2, stopped: 0 });
  assert.ok(app.trunks.records.list().every((trunk) => trunk.paused));
  await assert.rejects(app.trunks.say(jo.id, "hello"), /Jo is paused/);
  assert.deepEqual((await ask("/api/trunks/resume-all", {})).body, { resumed: 2 });
  assert.ok(app.trunks.records.list().every((trunk) => !trunk.paused));
  const outcomes = app.store.audit.list(app.runtime.owner, { action: "trunk.paused" }).map((entry) => `${entry.subject}:${entry.outcome}`);
  assert.ok(outcomes.includes("All Trunks:paused") && outcomes.includes("All Trunks:resumed"));
  assert.ok(app.store.audit.list(app.runtime.owner, { action: "trunk.paused" }).some((entry) => /1 running task was stopped/.test(entry.reason)));
});

test("a room's rule: mentions only by default, everyone every time, or a lead Trunk decides", async (t) => {
  const members = [{ id: "a", handle: "ann", name: "Ann" }, { id: "b", handle: "bo", name: "Bo" }, { id: "c", handle: "cy", name: "Cy" }];
  const said = (text) => [{ seq: 1, kind: "user", text, at: "2026-09-26T00:00:00Z" }];
  const first = (text, options) => {
    const decision = nextRoomTurn("R", members, said(text), "", options);
    return decision.status === "task" ? decision.task : null;
  };
  const whoAnswers = (text, options) => {
    const events = said(text), out = [];
    for (let step = 0; step < 6; step++) {
      const decision = nextRoomTurn("R", members, events, "", options);
      if (decision.status !== "task") break;
      out.push(decision.task.memberId);
      events.push({ seq: events.length + 1, kind: "pass", text: "", at: "2026-09-26T00:00:00Z", memberId: decision.task.memberId, round: decision.task.round, discussion: 1, seen: decision.task.seen });
    }
    return out;
  };
  // Mentions only, as it always was, with or without the option.
  assert.deepEqual(whoAnswers("@bo what now?"), ["b"]);
  assert.deepEqual(whoAnswers("what now?"), ["a", "b", "c"]);
  assert.deepEqual(whoAnswers("@bo what now?", { rule: "mention" }), ["b"]);
  // Everyone, every time.
  assert.deepEqual(whoAnswers("@bo what now?", { rule: "all" }), ["a", "b", "c"]);
  // The lead answers, and is told it leads; a Trunk the owner named still answers.
  assert.deepEqual(whoAnswers("what now?", { rule: "lead", lead: "c" }), ["c"]);
  assert.match(first("what now?", { rule: "lead", lead: "c" }).prompt, /You lead this room/);
  assert.doesNotMatch(first("what now?").prompt, /You lead this room/);
  assert.deepEqual(whoAnswers("@ann what now?", { rule: "lead", lead: "c" }), ["a"]);

  // Saved on the room, shown on it, and changed by the owner.
  const { app, root } = await fixture(t);
  on(app, "rooms");
  const fi = app.trunks.create({ name: "Fi" }), jo = app.trunks.create({ name: "Jo" });
  await app.trunks.introduced();
  const ask = await served(t, app, root);
  const made = await ask("/api/trunks/rooms", { name: "Quotes", members: [fi.id, jo.id] });
  assert.equal(made.body.room.rule, "mention");
  assert.equal(made.body.room.pattern, null);
  assert.equal((await ask(`/api/trunks/rooms/${made.body.room.id}`, { rule: "lead", pattern: "swarm" })).body.room.rule, "lead");
  const room = (await ask("/api/trunks")).body.rooms.find((one) => one.id === made.body.room.id);
  assert.deepEqual([room.rule, room.pattern], ["lead", "swarm"]);
  assert.equal((await ask(`/api/trunks/rooms/${made.body.room.id}`, { rule: "loudest" })).status, 400);
  const lead = await ask("/api/trunks/rooms", { name: "Led", members: [fi.id, jo.id], rule: "lead" });
  assert.equal(lead.body.room.rule, "lead");
});

test("a paused Trunk sits out its turn in a room and says so; the room carries on", async (t) => {
  const { app } = await fixture(t);
  on(app, "rooms");
  const fi = app.trunks.create({ name: "Fi" }), jo = app.trunks.create({ name: "Jo" });
  await app.trunks.introduced();
  const room = app.trunks.rooms.create({ name: "Both", members: [fi.id, jo.id] });
  app.trunks.pause.pause(fi.id, {});
  app.trunks.rooms.send(room.id, { text: "hello both" });
  await app.trunks.rooms.settled(room.id);
  const events = app.trunks.rooms.get(room.id).events;
  assert.deepEqual(events.filter((e) => e.memberId === fi.id).map((e) => [e.kind, e.text]), [["failed", "Fi is paused, so it did not answer. Resume it under Customize → Trunks."]]);
  assert.deepEqual(events.filter((e) => e.memberId === jo.id).map((e) => e.kind), ["member"]);
});

test("how Trunks work together: Branch picks until the owner chooses, a room may choose its own, and another way asks the owner", async (t) => {
  const swarmCall = call("delegate.swarm", { specialists: ["Helper"], items: ["one"] });
  const { app, root, provider } = await fixture(t, [({ last }) => (/PATTERN7403/.test(String(last?.content ?? "")) ? swarmCall : null)]);
  on(app, "rooms");
  const ask = await served(t, app, root);
  assert.equal((await ask("/api/orchestration")).body.pattern, "auto");
  assert.equal(patternQuestion("auto", "delegate.swarm"), null);
  assert.equal(patternNote("auto"), "");

  // A partial save keeps the other settings.
  await ask("/api/orchestration", { verify: true });
  const saved = (await ask("/api/orchestration", { pattern: "super" })).body;
  assert.deepEqual([saved.verify, saved.pattern], [true, "super"]);
  assert.equal((await ask("/api/orchestration", { pattern: "teams" })).status, 400, "teams has no engine form");
  assert.match(patternQuestion("super", "delegate.swarm"), /You chose "A lead and helpers".+"Swarm"/);
  assert.equal(patternQuestion("super", "delegate.supervise"), null);
  assert.equal(patternQuestion("one", "specialists.delegate"), null, "one specialist at a time fits every way");

  // A room's own choice wins inside it; elsewhere the owner's default holds.
  const fi = app.trunks.create({ name: "Fi" }), jo = app.trunks.create({ name: "Jo" });
  await app.trunks.introduced();
  const room = app.trunks.rooms.create({ name: "Swarmy", members: [fi.id, jo.id], pattern: "swarm" });
  assert.equal(app.runtime.teamPattern(room.sessionId), "swarm");
  assert.equal(app.runtime.teamPattern(room.memberSessions[fi.id]), "swarm", "a member's side of the room follows the room");
  assert.equal(app.runtime.teamPattern(fi.chatSessionId), "super");

  // The task is told the owner's way, and a tool of another way waits for the owner's yes.
  const run = await app.runtime.run({ prompt: "PATTERN7403" });
  const system = provider.requests.at(-1).messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
  assert.match(system, /the owner wants them to work this way: A lead and helpers/);
  assert.equal(run.status, "needs_input");
  assert.ok(app.store.events(run.id).some((event) => event.kind === "pattern.asked"));
  assert.match(JSON.stringify(app.runtime.waitingApprovals(run.sessionId)), /You chose \\"A lead and helpers\\"/);

  // Only the owner's answer counts. A no, even "just this once", keeps the tool refused in this conversation.
  const eventsIn = (sessionId) => app.store.runs(app.runtime.owner).filter((one) => one.sessionId === sessionId).flatMap((one) => app.store.events(one.id));
  const swarmed = (sessionId) => eventsIn(sessionId).some((event) => event.kind === "swarm.finished");
  assert.equal((await ask("/api/policy/approve", { sessionId: run.sessionId, fingerprint: shownFingerprint(app, run.sessionId), decision: "deny", remember: "never", carryOn: true })).status, 200);
  const again = await app.runtime.run({ prompt: "PATTERN7403", sessionId: run.sessionId });
  assert.notEqual(again.status, "needs_input", "it is not asked again");
  assert.equal(swarmed(run.sessionId), false, "the swarm never ran after the no");
  assert.match(JSON.stringify(app.store.messages(run.sessionId)), /The owner said no to working together this way/);
  // A yes, in another conversation, lets it go ahead.
  const other = await app.runtime.run({ prompt: "PATTERN7403" });
  assert.equal(other.status, "needs_input");
  assert.equal((await ask("/api/policy/approve", { sessionId: other.sessionId, fingerprint: shownFingerprint(app, other.sessionId), decision: "allow", remember: "never" })).status, 200);
  const next = await app.runtime.run({ prompt: "PATTERN7403", sessionId: other.sessionId });
  assert.notEqual(next.status, "needs_input", "the yes holds: it is not asked again");
  const ran = swarmed(other.sessionId);
  assert.equal(ran, true, "after the owner's yes the swarm ran");
});
