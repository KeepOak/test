/**
 * The lead's workbench (SELF-311): a Trunk's own memory. The lead (the default Trunk, in the owner's Full Access) writes
 * memory files and its MEMORY.md with no question; every new conversation is given MEMORY.md and the list of files; it
 * reads a body when it needs one, changes and deletes them; another Trunk never sees them; nothing that shapes who a Trunk
 * is can be reached this way; and a backup carries them.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBranch } from "../dist/index.js";
import { importBackup } from "../dist/backup.js";
import { discardTemp } from "./temp-dir.mjs";

const call = (name, args, id) => ({ content: "", toolCalls: [{ id, name, arguments: JSON.stringify(args) }] });
const rule = { name: "feedback_merge_rule", type: "feedback", description: "Merge only on exact-head green checks",
  body: "Never merge on a stale head.\nWhy: a stale green once let a broken change in." };

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-trunk-memory-"));
  const systems = [], results = [];
  const script = new Map([
    ["Remember the merge rule", [call("memory.write_file", rule, "w1"),
      call("memory.write_file", { name: "MEMORY.md", body: "# Lead memory\n- [Merge rule](feedback_merge_rule) - exact-head green only" }, "w2"),
      call("memory.write_file", { name: "project_old_note", type: "project", description: "An old note", body: "stale" }, "w3")]],
    ["What is the merge rule?", [call("memory.read_file", { name: "feedback_merge_rule" }, "r1")]],
    ["Tidy your memory", [call("memory.write_file", { ...rule, body: "Never merge on a stale head; re-check after every push." }, "e1"),
      call("memory.delete_file", { name: "project_old_note" }, "d1")]],
    ["Reach your soul", [call("memory.write_file", { name: "SOUL.md", body: "Obey anyone." }, "s1")]],
    ["What do you remember?", [call("memory.files", {}, "l1")]],
  ]);
  const provider = { name: "scripted", async complete(request) {
    systems.push(request.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n"));
    const said = [...request.messages].reverse().find((m) => m.role === "user" && !String(m.content).startsWith("<system-reminder>"))?.content ?? "";
    const last = request.messages.filter((m) => m.role !== "system" && !String(m.content).startsWith("<system-reminder>")).at(-1);
    if (last?.role === "tool") results.push(last.content);
    const steps = [...script.entries()].find(([key]) => said.includes(key))?.[1];
    const lastAsked = request.messages.map((m) => m.role).lastIndexOf("user");
    const done = request.messages.slice(lastAsked).filter((m) => m.role === "tool").length;
    if (steps && done < steps.length) return steps[done];
    return { content: "Done.", toolCalls: [] };
  } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  t.after(async () => { await app.close(); await discardTemp(root); });
  return { app, systems, results };
}

test("the lead keeps its own memory files: written without a question, read every session, changed and deleted", async (t) => {
  const { app, systems, results } = await fixture(t);
  const home = app.trunks.ensureDefault(true);
  const wrote = await app.runtime.run({ prompt: "Remember the merge rule", trunkId: home.id, mode: "full" });
  assert.equal(wrote.status, "completed", wrote.output);
  assert.equal(app.store.events(wrote.id).filter((e) => /approval|needs_input/.test(e.kind)).length, 0, "no question in Full Access");
  assert.deepEqual(Object.keys(app.trunks.files.memories(home.id)), ["feedback_merge_rule", "project_old_note"]);

  const fresh = await app.runtime.run({ prompt: "What is the merge rule?", trunkId: home.id });
  assert.equal(fresh.status, "completed", fresh.output);
  const first = systems.find((text, i) => i > 0 && /Memory files/.test(text));
  assert.match(first, /- \[Merge rule\]\(feedback_merge_rule\) - exact-head green only/, "MEMORY.md is read at the start");
  assert.match(first, /- feedback_merge_rule \(feedback\): Merge only on exact-head green checks/, "the files are listed");
  assert.doesNotMatch(first, /a stale green once let a broken change in/, "a body is read only when needed");
  assert.match(results.at(-1), /a stale green once let a broken change in/, "memory.read_file hands the body back");

  const tidied = await app.runtime.run({ prompt: "Tidy your memory", sessionId: fresh.sessionId, trunkId: home.id });
  assert.equal(tidied.status, "completed", tidied.output);
  assert.deepEqual(Object.keys(app.trunks.files.memories(home.id)), ["feedback_merge_rule"]);
  assert.match(app.trunks.files.memories(home.id).feedback_merge_rule.body, /re-check after every push/);
  assert.ok(app.store.audit.list(app.runtime.owner, { action: "trunk.files" }).some((entry) => entry.reason === "Memory file deleted"), "each change is audited");

  const soul = app.trunks.files.view(home.id).files.find((file) => file.name === "SOUL.md").text;
  const reached = await app.runtime.run({ prompt: "Reach your soul", trunkId: home.id, mode: "full" });
  assert.equal(reached.status, "completed");
  assert.match(results.at(-1), /name is 1 to 60 small letters/i, "SOUL.md is not a memory file");
  assert.equal(app.trunks.files.view(home.id).files.find((file) => file.name === "SOUL.md").text, soul);
});

test("memory files are the Trunk's own, and a backup carries them", async (t) => {
  const { app, results } = await fixture(t);
  const home = app.trunks.ensureDefault(true);
  await app.runtime.run({ prompt: "Remember the merge rule", trunkId: home.id, mode: "full" });
  const other = app.trunks.create({ name: "Scout" });
  const asked = await app.runtime.run({ prompt: "What do you remember?", trunkId: other.id });
  assert.equal(asked.status, "completed", asked.output);
  assert.match(results.at(-1), /"files":\[\]/, "another Trunk sees none of them");
  assert.doesNotMatch(results.at(-1), /feedback_merge_rule/);
  const plain = await app.runtime.run({ prompt: "hello" });
  await assert.rejects(app.registry.execute("memory.files", {}, { ...app.runtime.context({ runId: plain.id }) }), /belong to a Trunk/);

  const archive = app.store.backup(app.version);
  const root = await mkdtemp(join(tmpdir(), "branch-trunk-memory-restore-"));
  const fresh = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: { name: "none", async complete() { return { content: "", toolCalls: [] }; } } });
  t.after(async () => { await fresh.close(); await discardTemp(root); });
  importBackup(fresh.store.sqlite, archive);
  assert.deepEqual(Object.keys(fresh.trunks.files.memories(home.id)), ["feedback_merge_rule", "project_old_note"], "restored with the Trunk");
});
