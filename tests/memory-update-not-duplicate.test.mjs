/**
 * SELF-202 (nightly mem-update-not-duplicate, 1/10 with qwen2.5:7b): "Remember: I live in Atlanta", then "Update where I
 * live: I moved to Denver", left Atlanta current beside Denver in 6 of 10 tries, and even when Atlanta was ended the
 * model was still shown it, so it answered "you live in both". A newer fact ends an earlier one only when both name the
 * same entity and attribute, and qwen named them loosely. The scripted model here sends qwen's own calls, as recorded.
 * Mutations, each turns a test here red (each was built and run):
 * - src/memory.ts memory.put: use `canonicalDetail(value)` without withImpliedDetail: "qwen's loose calls…".
 * - src/memory.ts withImpliedDetail: drop the owner-or-none check: "a fact about someone else…".
 * - src/memory.ts memory.put: read the request whatever the source: "a chat's request is not read…".
 * - src/memory.ts plainAttribute: drop the leading "current": "…current residence…".
 * - src/memory-review.ts sessionSnapshot, and src/index.ts orderFacts: drop isCurrentFact: "an ended fact is never shown…".
 * - src/memory.ts search: drop isCurrentFact: "an ended fact is never shown…" (memory.search).
 * - src/memory.ts memory.put: drop withSaidStart: "a start date is kept only when…".
 * - src/memory.ts PutMemorySchema: make source required again: "a fact saved without a source…".
 * - src/memory.ts memory.put: drop the ownersOwn gate (read the request in every task): "a household person's task…".
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { canonicalDetail, isCurrentFact, ownerNames, withImpliedDetail } from "../dist/memory.js";

const detail = (value, about) => { const { entity, attribute } = canonicalDetail(withImpliedDetail(value, about)); return { entity, attribute }; };

test("what the fact and the owner's own words say fills in what the model left out", () => {
  const about = { ownerNames: ["Taofiks"], request: "Remember: I live in Atlanta." };
  assert.deepEqual(detail({ text: "lives in Atlanta", entity: "Taofiks" }, about), { entity: "me", attribute: "home" }, "the owner's own name, and the request's detail");
  assert.deepEqual(detail({ text: "Atlanta", entity: "Taofiks", attribute: "location" }, about), { entity: "me", attribute: "home" });
  assert.deepEqual(detail({ text: "I live in Atlanta.", entity: "owner" }, {}), { entity: "me", attribute: "home" }, "the fact's own words");
  assert.deepEqual(detail({ text: "Denver", entity: "person", attribute: "current residence" }, {}), { entity: "me", attribute: "home" });
  assert.deepEqual(detail({ text: "Denver", entity: "person", attribute: "Current_Residence" }, {}), { entity: "me", attribute: "home" });
  assert.deepEqual(detail({ text: "I moved to Denver.", entity: "Alice" }, about), { entity: "Alice", attribute: undefined }, "someone else stays someone else");
  assert.deepEqual(detail({ text: "Pizza", entity: "owner" }, about), { entity: "me", attribute: undefined }, "a fact that shares no word with the request gets nothing from it");
  assert.deepEqual(ownerNames("Taofiks_Legion"), ["Taofiks_Legion", "Taofiks"]);
  assert.deepEqual(detail({ text: "I live in Atlanta", entity: "Taofiks_Legion" }, { ownerNames: ownerNames("Taofiks_Legion") }), { entity: "me", attribute: "home" },
    "the whole computer name, as qwen wrote it");
  assert.deepEqual(ownerNames("DESKTOP-4KQ7"), [], "a machine's generic name is nobody's");
  assert.equal(isCurrentFact({ data: { validTo: null } }), true);
  assert.equal(isCurrentFact({ data: { validTo: new Date(Date.now() - 1000).toISOString() } }), false);
});

/** Replays calls recorded from qwen2.5:7b: one memory.put per message, then says it is done. */
function replaying(calls) {
  const seen = [];
  return { seen, provider: { name: "scripted", async complete(request) {
    seen.push(request.messages);
    const last = request.messages.at(-1);
    if (last?.role === "tool") return { content: "Saved.", toolCalls: [] };
    const next = calls.shift();
    return next ? { content: "", toolCalls: [{ id: `m${calls.length}`, name: "memory.put", arguments: JSON.stringify(next) }] } : { content: "ok", toolCalls: [] };
  } } };
}
async function branch(t, calls) {
  const root = await mkdtemp(join(tmpdir(), "branch-mem-update-"));
  const script = replaying(calls);
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: script.provider });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const current = () => app.store.exportMemory(app.runtime.owner).records.filter((r) => isCurrentFact(r)).map((r) => r.data.text);
  return { app, seen: script.seen, current };
}

test("qwen's loose calls: the move to Denver ends Atlanta", async (t) => {
  for (const calls of [
    [{ entity: "owner", text: "I live in Atlanta.", source: "owner" }, { attribute: "location", kind: "fact-about-person", text: "I moved to Denver.", source: "owner update", entity: "person" }],
    [{ entity: "owner", text: "Atlanta", source: "owner" }, { entity: "person", attribute: "current residence", text: "Denver", source: "owner update" }],
  ]) {
    const { app, current } = await branch(t, calls);
    await app.runtime.run({ prompt: "Remember: I live in Atlanta." });
    assert.equal(current().filter((text) => /Atlanta/.test(text)).length, 1, "control: Atlanta was saved");
    await app.runtime.run({ prompt: "Update where I live: I moved to Denver." });
    assert.deepEqual(current().filter((text) => /Atlanta/.test(text)), [], `Atlanta is no longer current (${JSON.stringify(calls[0])})`);
    assert.equal(current().filter((text) => /Denver/.test(text)).length, 1);
  }
});

test("a fact about someone else is never taken for the owner's", async (t) => {
  const { app, current } = await branch(t, [{ entity: "owner", text: "I live in Atlanta.", source: "owner" }, { entity: "Alice", text: "I moved to Denver.", source: "owner" }]);
  await app.runtime.run({ prompt: "Remember: I live in Atlanta." });
  await app.runtime.run({ prompt: "Remember what Alice told me: I moved to Denver." });
  assert.equal(current().filter((text) => /Atlanta/.test(text)).length, 1, "Alice's move ended nothing of the owner's");
});

test("a chat's request is not read for the detail: there, \"I\" may be somebody else", async (t) => {
  const { app } = await branch(t, []);
  const saved = {};
  for (const source of ["owner", "channel"]) {
    const run = app.store.createRun(app.runtime.owner, "Remember: I live in Atlanta.");
    const context = { ...app.runtime.context({ runId: run.id }), ...(source === "owner" ? {} : { source }) };
    const put = await app.registry.execute("memory.put", { entity: "owner", text: `Atlanta (${source})`, source: "said so" }, context);
    saved[source] = app.store.exportMemory(app.runtime.owner).records.find((r) => r.id === (put.id ?? put.record?.id))
      ?? app.store.exportMemory(app.runtime.owner).records.find((r) => r.data.text === `Atlanta (${source})`);
  }
  assert.equal(saved.owner.data.attribute, "home", "control: the owner's own request names the detail");
  assert.equal(saved.channel.data.attribute, undefined, "a chat's words are not read for it");
});

test("an ended fact is never shown to the model as current: not in a new conversation's snapshot, nor in memory.search", async (t) => {
  const { app, seen } = await branch(t, [{ entity: "owner", text: "I live in Atlanta.", source: "owner" }, { entity: "person", attribute: "location", text: "I moved to Denver.", source: "owner" }]);
  await app.runtime.run({ prompt: "Remember: I live in Atlanta." });
  await app.runtime.run({ prompt: "Update where I live: I moved to Denver." });
  const ended = app.store.exportMemory(app.runtime.owner).records.find((r) => /Atlanta/.test(r.data.text));
  assert.ok(ended && !isCurrentFact(ended), "control: Atlanta was ended, and kept in the record");
  await app.runtime.run({ prompt: "Where do I live now?" });
  const shown = seen.at(-1).map((m) => String(m.content)).join("\n");
  assert.match(shown, /Denver/, "the current fact is shown");
  assert.doesNotMatch(shown, /Atlanta/, "the ended one is not");
  const search = (query) => app.registry.execute("memory.search", { query }, app.runtime.context());
  assert.equal((await search("Atlanta")).length, 0, "memory.search finds only what is still true");
  assert.equal((await search("Denver")).length, 1);
});

test("a start date is kept only when the owner's words name that year; a day is taken, not refused", async (t) => {
  const { withSaidStart } = await import("../dist/memory.js");
  assert.deepEqual(withSaidStart({ text: "x", validFrom: "2023-10-01" }, "Update where I live: I moved to Denver."), { text: "x" }, "a made-up date is dropped");
  assert.deepEqual(withSaidStart({ text: "x", validFrom: "2019-05-01" }, "Remember: I lived in Paris from 2019."), { text: "x", validFrom: "2019-05-01T00:00:00.000Z" });
  assert.deepEqual(withSaidStart({ text: "x", validFrom: "2019-05-01T10:00:00Z" }, "since May 2019"), { text: "x", validFrom: "2019-05-01T10:00:00.000Z" });
  assert.deepEqual(withSaidStart({ text: "x", validFrom: "now" }, "Remember: I live in Atlanta."), { text: "x" }, "\"now\" is taken as now");
  assert.deepEqual(withSaidStart({ text: "x", validFrom: "2024-01-01" }, undefined), { text: "x", validFrom: "2024-01-01T00:00:00.000Z" }, "a call from outside a task keeps its date");
  assert.deepEqual(withSaidStart({ text: "x", validFrom: "now" }, undefined), { text: "x" });
  assert.deepEqual(withSaidStart({ text: "x", validFrom: "2019-05-01T14:29:00-04:00" }, "in 2019"), { text: "x", validFrom: "2019-05-01T18:29:00.000Z" }, "an offset is read");
  assert.deepEqual(detail({ text: "Denver", entity: "person", attribute: "currentCity" }, {}), { entity: "me", attribute: "home" }, "camelCase");
  // qwen2.5:7b's own call: a day nobody said. It used to be refused ("validFrom is not in the right format") until the loop
  // guard stopped it, and nothing was saved; now the move is saved and ends Atlanta.
  const { app, current } = await branch(t, [{ entity: "owner", text: "I live in Atlanta.", source: "owner" },
    { entity: "person", attribute: "location", text: "Now living in Denver", source: "owner update", validFrom: "2023-10-01" }]);
  await app.runtime.run({ prompt: "Remember: I live in Atlanta." });
  await app.runtime.run({ prompt: "Update where I live: I moved to Denver." });
  assert.deepEqual(current().filter((text) => /Atlanta|Denver/.test(text)), ["Now living in Denver"]);
});

test("a fact saved without a source is still saved, from where the task came; a generic word for the owner is the owner", async (t) => {
  // qwen2.5:7b's own calls: no source at all (refused before, so nothing was remembered), and "personal" as the entity.
  const { app, current } = await branch(t, [{ entity: "Taofiks_Legion", text: "Resides in Atlanta", kind: "fact-about-person" },
    { entity: "personal", text: "I live in Denver.", source: "owner" }]);
  await app.runtime.run({ prompt: "Remember: I live in Atlanta." });
  const saved = app.store.exportMemory(app.runtime.owner).records.find((r) => /Atlanta/.test(r.data.text));
  assert.ok(saved, "saved without a source");
  assert.equal(saved.data.source, "The owner said so");
  assert.deepEqual(detail({ text: "I live in Denver.", entity: "personal" }, {}), { entity: "me", attribute: "home" });
});

test("a household person's task never reads the owner's words or names: \"me\" there is that person", async (t) => {
  const saved = {};
  for (const who of ["owner", "Sam"]) {
    const { app } = await branch(t, []);
    if (who === "Sam") {
      const { savePeopleSettings } = await import("../dist/people/settings.js");
      savePeopleSettings(app.store, app.runtime.owner, { mode: "on" });
      const sam = app.store.profiles.create({ name: "Sam", pin: "2468" });
      app.store.profiles.switch({ profileId: sam.id, pin: "2468" });
      t.after(() => app.store.profiles.switch({ profileId: null }));
      assert.notEqual(app.store.profiles.scope(), app.runtime.owner, "control: Sam's own memory");
    }
    // A task whose words are "Remember: I live in Atlanta.", and the model's save with no detail of its own.
    const run = app.store.createRun(app.runtime.owner, "Remember: I live in Atlanta.");
    const put = await app.registry.execute("memory.put", { text: "Atlanta", source: "said so" }, app.runtime.context({ runId: run.id }));
    saved[who] = app.store.exportMemory(app.store.profiles.scope()).records.find((r) => r.id === put.id);
  }
  assert.equal(saved.owner?.data.attribute, "home", "control: the owner's own task reads the owner's words");
  assert.ok(saved.Sam, "control: Sam's fact was saved");
  assert.equal(saved.Sam.data.attribute, undefined, "Sam's save does not read the words as the owner's");
});
