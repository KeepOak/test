/**
 * FQ-routing.isolated-agents: files.history and files.restore leaked another Trunk's (or the
 * owner's) exact file content. file_versions kept every version by owner and bare relative path
 * alone, with no column saying which scope wrote it — even though files.checked() already resolves
 * every path against a folder of its own for a Trunk's own turn (.branch-agents/<id>,
 * src/trunks/file-root.ts). A Trunk with files.read could call files.history for a path another
 * Trunk happened to use too (a plausible name like "note.md" or "plan.md") and see that Trunk's
 * exact earlier bytes; files.restore could then write them into its own folder. workspace.snapshot
 * had the same shape from the other direction: it walked the whole shared workspace regardless of
 * who called it, so a Trunk taking a snapshot of "its own work" actually kept every other Trunk's
 * (and the owner's) files too, all stamped with its own scope and so readable back through its own
 * files.history afterwards.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { call, fixture, on } from "./trunks-helpers.mjs";

/** The result (or error) of one named tool call on a run, from its own event trail. */
function toolOutcome(app, runId, name) {
  const events = app.store.events(runId);
  const done = events.find((e) => e.kind === "tool.completed" && e.data.name === name);
  if (done) return { ok: true, result: done.data.result };
  const failed = events.find((e) => (e.kind === "tool.failed" || e.kind === "tool.stalled") && e.data.name === name);
  if (failed) return { ok: false, error: String(failed.data.error ?? "") };
  throw new Error(`${name} never ran in run ${runId}`);
}

test("a Trunk's files.history and files.restore never reach another Trunk's kept versions", async (t) => {
  // Q250: read before edit ships on, so the second write reads note.md first, then writes it.
  let readForV2 = false;
  const rules = [({ last }) => {
    if (last?.role === "tool" && readForV2) { readForV2 = false; return call("files.write", { path: "note.md", content: "Ada v2" }); }
    if (last?.role !== "user") return null;
    const text = String(last.content ?? "");
    if (text === "write v1") return call("files.write", { path: "note.md", content: "Ada v1" });
    if (text === "write v2") { readForV2 = true; return call("files.read", { path: "note.md" }); }
    if (text === "history") return call("files.history", { path: "note.md" });
    if (text.startsWith("restore ")) return call("files.restore", { versionId: text.slice("restore ".length) });
    return null;
  }, ({ last }) => (last?.role === "tool" ? "Done." : null)];
  const { app } = await fixture(t, rules);
  on(app);
  const ada = app.trunks.create({ name: "Ada" });
  const bo = app.trunks.create({ name: "Bo" });
  app.trunks.edit(ada.id, { permissions: ["files.read", "files.write"] });
  app.trunks.edit(bo.id, { permissions: ["files.read", "files.write"] });
  await app.trunks.introduced();

  // Ada writes the same relative path twice, so files.history has a real kept version (the bytes
  // just before the second write) to find, with a real id files.restore can act on.
  await app.trunks.say(ada.id, "write v1");
  await app.trunks.say(ada.id, "write v2");
  const adaHistory = await app.trunks.say(ada.id, "history");
  const adaVersions = toolOutcome(app, adaHistory.runId, "files.history").result;
  assert.equal(adaVersions.length, 2, "before the first write (did not exist) and before the second (v1)");
  assert.equal(adaVersions[0].existed, true, "most recent: the bytes just before the second write");
  const versionId = adaVersions[0].id;

  // Bo asks for the very same path's history: he has never written it himself, so his own folder has
  // no history for it — not Ada's.
  const boHistory = await app.trunks.say(bo.id, "history");
  assert.deepEqual(toolOutcome(app, boHistory.runId, "files.history").result, []);

  // Bo tries to restore Ada's version id directly (guessed, overheard, however it reached him): it is
  // refused exactly as an unknown id would be, not written into his own folder.
  const boRestore = await app.trunks.say(bo.id, `restore ${versionId}`);
  const boRestoreOutcome = toolOutcome(app, boRestore.runId, "files.restore");
  assert.equal(boRestoreOutcome.ok, false);
  assert.match(boRestoreOutcome.error, /not kept/i);
  const boNote = app.store.sqlite.prepare(
    "SELECT content FROM file_versions WHERE owner='local' AND scope=? AND path='note.md'",
  ).all(`.branch-agents/${bo.id}`);
  assert.deepEqual(boNote, [], "nothing of Ada's ever landed under Bo's own scope");

  // Ada can still restore her own version.
  const adaRestore = await app.trunks.say(ada.id, `restore ${versionId}`);
  assert.deepEqual(toolOutcome(app, adaRestore.runId, "files.restore").result, { path: "note.md", bytes: "Ada v1".length, restored: true });
});

test("a Trunk's workspace.snapshot captures only its own folder, never another Trunk's or the owner's files", async (t) => {
  const rules = [({ last }) => {
    if (last?.role !== "user") return null;
    const text = String(last.content ?? "");
    if (text === "write") return call("files.write", { path: "private-notes.md", content: "Ada's private note" });
    if (text === "snapshot") return call("workspace.snapshot", { label: "mine" });
    return null;
  }, ({ last }) => (last?.role === "tool" ? "Done." : null)];
  const { app, root } = await fixture(t, rules);
  on(app);
  const ada = app.trunks.create({ name: "Ada" });
  const bo = app.trunks.create({ name: "Bo" });
  app.trunks.edit(ada.id, { permissions: ["files.read", "files.write"] });
  app.trunks.edit(bo.id, { permissions: ["files.read", "files.write"] });
  await app.trunks.introduced();

  await app.trunks.say(ada.id, "write");
  const snap = await app.trunks.say(bo.id, "snapshot");
  const result = toolOutcome(app, snap.runId, "workspace.snapshot").result;
  assert.equal(result.files, 0, "Bo's own folder is empty; Ada's file is not his to snapshot");
  const rows = app.store.sqlite.prepare("SELECT path, scope FROM file_versions WHERE snapshot_id=?").all(result.id);
  assert.deepEqual(rows, [], "nothing was captured at all, least of all Ada's file");
});
