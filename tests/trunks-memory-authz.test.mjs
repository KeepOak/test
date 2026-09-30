/**
 * FQ-routing.isolated-agents: memory.update, memory.delete and memory.keep took a bare memory id
 * inside the owner's overall scope and never checked the record's own scope (`agent:trunk:<id>`,
 * `shared`, `private`) against `context.agent` — unlike memory.at/search/timeline, which already
 * filter by it (`visibleTo`, src/memory.ts). A Trunk that somehow obtained another Trunk's (or the
 * owner's) memory id — read aloud, guessed, leaked another way — could edit, delete or promote it.
 * `writableTo` (src/memory.ts) closes that: it mirrors what memory.put is already allowed to save
 * under (its own agent scope, or `shared` only when it is not a Trunk, R17-A), and every id-based
 * write is refused exactly as a missing id is, so an unauthorised Trunk learns nothing about whether
 * the id even exists.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { call, fixture, on } from "./trunks-helpers.mjs";
import { writableTo } from "../dist/memory.js";

/** The result (or error) of one named tool call on a run, from its own event trail. */
function toolOutcome(app, runId, name) {
  const events = app.store.events(runId);
  const done = events.find((e) => e.kind === "tool.completed" && e.data.name === name);
  if (done) return { ok: true, result: done.data.result };
  const failed = events.find((e) => (e.kind === "tool.failed" || e.kind === "tool.stalled") && e.data.name === name);
  if (failed) return { ok: false, error: String(failed.data.error ?? "") };
  throw new Error(`${name} never ran in run ${runId}`);
}

test("writableTo: an agent's memory.write reaches its own scope, and shared only when it is not a Trunk", () => {
  const record = (scope) => ({ data: { scope } });
  assert.equal(writableTo(record("agent:trunk:ada"), "trunk:ada"), true, "its own fact");
  assert.equal(writableTo(record("agent:trunk:ada"), "trunk:bo"), false, "another Trunk's fact");
  assert.equal(writableTo(record("agent:trunk:ada"), undefined), true, "the owner's own turn reaches anything");
  assert.equal(writableTo(record("shared"), "trunk:ada"), false, "a Trunk never writes a shared fact (R17-A)");
  assert.equal(writableTo(record("shared"), "researcher"), true, "a non-Trunk delegated specialist may");
  assert.equal(writableTo(record(undefined), "trunk:ada"), false, "private (the default) is never another agent's to write");
  assert.equal(writableTo(record("private"), "trunk:ada"), false);
  assert.equal(writableTo(undefined, "trunk:ada"), true, "a missing record: let the normal not-found path answer");
});

test("a Trunk cannot update or delete another Trunk's memory by id", async (t) => {
  const rules = [({ last }) => {
    if (last?.role !== "user") return null;
    const text = String(last.content ?? "");
    if (text.startsWith("remember ")) return call("memory.put", { text: text.slice("remember ".length), source: "Ada" });
    if (text.startsWith("update ")) { const [id, rev] = text.slice("update ".length).split(" "); return call("memory.update", { id, text: "overwritten", source: "attacker", expectedRevision: Number(rev) }); }
    if (text.startsWith("delete ")) return call("memory.delete", { id: text.slice("delete ".length) });
    return null;
  }, ({ last }) => (last?.role === "tool" ? "Done." : null)];
  const { app } = await fixture(t, rules);
  on(app);
  const ada = app.trunks.create({ name: "Ada" });
  const bo = app.trunks.create({ name: "Bo" });
  app.trunks.edit(ada.id, { permissions: ["memory.write", "memory.read"] });
  app.trunks.edit(bo.id, { permissions: ["memory.write", "memory.read"] });
  await app.trunks.introduced();

  // Two of Ada's own long-lasting facts (not task-scratch, so they outlive the run that made them),
  // one per operation under test.
  const putU = await app.trunks.say(ada.id, "remember target-for-update");
  const factU = toolOutcome(app, putU.runId, "memory.put").result;
  const putD = await app.trunks.say(ada.id, "remember target-for-delete");
  const factD = toolOutcome(app, putD.runId, "memory.put").result;
  for (const fact of [factU, factD]) assert.equal(fact.data.scope, `agent:trunk:${ada.id}`);

  // Bo's update is refused with the same message a missing id gives — nothing about whether the id
  // exists leaks to him — and Ada's fact is untouched.
  const boUpdate = await app.trunks.say(bo.id, `update ${factU.id} ${factU.revision}`);
  const boUpdateOutcome = toolOutcome(app, boUpdate.runId, "memory.update");
  assert.equal(boUpdateOutcome.ok, false);
  assert.match(boUpdateOutcome.error, /not found/i);
  assert.equal(app.store.get("memory", "local", factU.id).data.text, "target-for-update");

  // Bo's delete quietly does nothing, exactly like deleting an id that was never there.
  const boDelete = await app.trunks.say(bo.id, `delete ${factD.id}`);
  assert.deepEqual(toolOutcome(app, boDelete.runId, "memory.delete").result, false);
  assert.ok(app.store.get("memory", "local", factD.id), "still saved");

  // Ada, on her own facts, is unaffected.
  const adaUpdate = await app.trunks.say(ada.id, `update ${factU.id} ${factU.revision}`);
  const adaUpdateOutcome = toolOutcome(app, adaUpdate.runId, "memory.update");
  assert.equal(adaUpdateOutcome.ok, true);
  assert.equal(adaUpdateOutcome.result.data.text, "overwritten");

  const adaDelete = await app.trunks.say(ada.id, `delete ${factD.id}`);
  assert.deepEqual(toolOutcome(app, adaDelete.runId, "memory.delete").result, true);
  assert.equal(app.store.get("memory", "local", factD.id), undefined);
});

test("a Trunk cannot keep another Trunk's memory by id, even one not otherwise keepable", async (t) => {
  // memory.keep normally refuses a fact outside the "task" layer ("Only a note made while doing a
  // job can be kept this way"). This proves the new scope check runs first: Bo's attempt on a
  // long-lasting fact of Ada's fails with the same "no longer saved" refusal an unknown id gets, not
  // with the layer message — an unauthorised Trunk learns nothing about the fact at all.
  const rules = [({ last }) => {
    if (last?.role !== "user") return null;
    const text = String(last.content ?? "");
    if (text.startsWith("remember ")) return call("memory.put", { text: text.slice("remember ".length), source: "Ada" });
    if (text.startsWith("keep ")) return call("memory.keep", { id: text.slice("keep ".length) });
    return null;
  }, ({ last }) => (last?.role === "tool" ? "Done." : null)];
  const { app } = await fixture(t, rules);
  on(app);
  const ada = app.trunks.create({ name: "Ada" });
  const bo = app.trunks.create({ name: "Bo" });
  app.trunks.edit(ada.id, { permissions: ["memory.write", "memory.read"] });
  app.trunks.edit(bo.id, { permissions: ["memory.write", "memory.read"] });
  await app.trunks.introduced();

  const put = await app.trunks.say(ada.id, "remember a long-lasting fact");
  const fact = toolOutcome(app, put.runId, "memory.put").result;
  assert.equal(fact.data.layer, "long-term", "not task");

  const boKeep = await app.trunks.say(bo.id, `keep ${fact.id}`);
  const boKeepOutcome = toolOutcome(app, boKeep.runId, "memory.keep");
  assert.equal(boKeepOutcome.ok, false);
  assert.match(boKeepOutcome.error, /no longer saved/i);
  assert.doesNotMatch(boKeepOutcome.error, /job/i, "not the layer refusal — Bo never gets that far");

  // Ada's own attempt on the very same fact reaches the (pre-existing, unrelated) layer refusal
  // instead, proving the new check does not block her own facts.
  const adaKeep = await app.trunks.say(ada.id, `keep ${fact.id}`);
  const adaKeepOutcome = toolOutcome(app, adaKeep.runId, "memory.keep");
  assert.equal(adaKeepOutcome.ok, false);
  assert.match(adaKeepOutcome.error, /job/i);
});

test("memory.versions and memory.version_note refuse a Trunk or a delegated specialist outright", async (t) => {
  const rules = [({ last }) => {
    if (last?.role !== "user") return null;
    const text = String(last.content ?? "");
    if (text === "versions") return call("memory.versions", {});
    if (text === "note") return call("memory.version_note", { version: "0".repeat(7), kind: "preference" });
    return null;
  }, ({ last }) => (last?.role === "tool" ? "Done." : null)];
  const { app } = await fixture(t, rules);
  on(app);
  const ada = app.trunks.create({ name: "Ada" });
  app.trunks.edit(ada.id, { permissions: ["memory.read"] });
  await app.trunks.introduced();

  // Whether or not the history feature is even on, a Trunk's turn is refused for the reason that its
  // one note mixes every agent's facts — not the (also true here) "switched off" reason, which would
  // suggest the owner could fix this by turning a switch on.
  // Memory history ships "when needed" (the ship-on rule); the owner switches it off so both refusals can be told apart.
  app.memoryHistory.configure("local", { mode: "off" });
  assert.equal(app.memoryHistory.settings("local").mode, "off");
  const versions = await app.trunks.say(ada.id, "versions");
  const versionsOutcome = toolOutcome(app, versions.runId, "memory.versions");
  assert.equal(versionsOutcome.ok, false);
  assert.match(versionsOutcome.error, /mixes every agent's facts/);
  const note = await app.trunks.say(ada.id, "note");
  const noteOutcome = toolOutcome(app, note.runId, "memory.version_note");
  assert.equal(noteOutcome.ok, false);
  assert.match(noteOutcome.error, /mixes every agent's facts/);

  // The owner's own call (no agent) is unaffected: it still gets the plain "switched off" refusal.
  await assert.rejects(app.runtime.executeTool("memory.versions", {}), /switched off/);
});
