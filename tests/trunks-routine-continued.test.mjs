/**
 * Q050 review: a Trunk's routine writes its note only while the Trunk's conversation is quiet. A task there that stopped
 * to ask and carries on once answered ("run.continued") is a turn in progress again, so a routine finishing meanwhile
 * waits and writes its note after that turn, never in the middle of it.
 * Mutation, turns it red: src/trunks/routines.ts observe: stop treating "run.continued" as busy.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { fixture, on } from "./trunks-helpers.mjs";

const rules = [({ last }) => (/NEWS7401/.test(String(last?.content ?? "")) ? "Checked NEWS7401." : null)];

test("a routine's note waits while a task in the Trunk's conversation carries on after its question", async (t) => {
  const { app } = await fixture(t, rules);
  on(app, "routines");
  const fi = app.trunks.create({ name: "Fi" });
  await app.trunks.introduced();
  const routine = app.trunks.routines.create(fi.id, { name: "News", prompt: "Check NEWS7401", dueAt: new Date(Date.now() + 60000).toISOString(), intervalMs: 3600000 });
  const reports = () => app.store.messages(fi.chatSessionId).filter((message) => /^Routine "News"/.test(String(message.content)));
  // A task in Fi's conversation stopped to ask, and is now carrying on after the answer.
  const asking = app.store.createRun(app.runtime.owner, "plan the week", fi.chatSessionId);
  app.store.event(asking.id, "run.started", { source: "owner" });
  app.store.finish(asking.id, "needs_input", "Which days?");
  app.store.event(asking.id, "run.finished", { status: "needs_input" });
  app.store.event(asking.id, "run.continued", { answer: "replied" });
  const due = Date.parse(String(app.store.get("schedules", app.runtime.owner, routine.id).data.dueAt));
  await app.scheduler.tick(new Date(due + 5 * 60000));
  assert.deepEqual(reports(), [], "the note waits while the carried-on turn works");
  app.store.event(asking.id, "run.finished", { status: "completed" });
  assert.deepEqual(reports().map((message) => message.content), ['Routine "News": Checked NEWS7401.'], "and is written once it ends");
});
