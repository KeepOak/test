/* Parity B2 (the side panel's Terminal and Files tabs): each command that ran says who let it (the owner's yes to its
   question, or the rules without asking), and the files a task only read are listed beside the ones it changed. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { panelsWork } from "../dist/panels-work.js";

async function world(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-panels-b2-"));
  const quiet = { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: quiet });
  t.after(async () => { await app.close(); await discardTemp(root); });
  return app;
}

test("a command that ran says whether the owner's yes or the rules let it; one refused or waiting says neither", async (t) => {
  const app = await world(t);
  const run = app.store.createRun(app.runtime.owner, "Tidy the folder");
  app.store.message(run.sessionId, { role: "assistant", content: "", toolCalls: [
    { id: "a1", name: "shell.execute", arguments: JSON.stringify({ executable: "git", args: ["status"] }) },
    { id: "a2", name: "shell.execute", arguments: JSON.stringify({ executable: "npm", args: ["test"] }) },
    { id: "a3", name: "shell.execute", arguments: JSON.stringify({ executable: "rm", args: ["-rf", "old"] }) },
    { id: "a4", name: "shell.execute", arguments: JSON.stringify({ executable: "git", args: ["push"] }) },
    { id: "a5", name: "shell.execute", arguments: JSON.stringify({ executable: "npm", args: ["test"] }) },
  ] });
  const ev = (kind, data) => app.store.event(run.id, kind, data);
  ev("tool.started", { name: "shell.execute", id: "a1" });
  ev("tool.completed", { name: "shell.execute", id: "a1", result: { exitCode: 0, stdout: "clean" } });
  ev("policy.ask", { name: "shell.execute", id: "a2", target: "npm test" });
  ev("tool.started", { name: "shell.execute", id: "a2" });
  ev("tool.failed", { name: "shell.execute", id: "a2", error: "1 failing" });
  ev("policy.denied", { name: "shell.execute", id: "a3", target: "rm -rf old" });
  ev("policy.ask", { name: "shell.execute", id: "a4", target: "git push" });
  // The same command again: the yes already given in the conversation answers it (src/runtime.ts gate).
  ev("policy.answered", { name: "shell.execute", id: "a5", target: "npm test" });
  ev("tool.started", { name: "shell.execute", id: "a5" });
  ev("tool.completed", { name: "shell.execute", id: "a5", result: { exitCode: 0, stdout: "ok" } });
  app.store.finish(run.id, "completed", "Done.");
  const entries = panelsWork(app.store, app.runtime.owner, run.sessionId).terminal.entries;
  assert.deepEqual(entries.map((e) => [e.what, e.state, e.allowed]), [
    ["git status", "done", "rules"], ["npm test", "failed", "owner"], ["rm -rf old", "refused", null], ["git push", "waiting", null], ["npm test", "done", "owner"]]);
});

test("the files a task read and did not change are listed once, whichever way their path was written", async (t) => {
  const app = await world(t);
  const run = app.store.createRun(app.runtime.owner, "Read the notes");
  app.store.message(run.sessionId, { role: "assistant", content: "", toolCalls: [
    { id: "r1", name: "files.read", arguments: JSON.stringify({ path: "./notes/a.md" }) },
    { id: "r2", name: "files.read_many", arguments: JSON.stringify({ paths: ["notes/a.md", "notes/b.md", "notes/c.md"] }) },
    { id: "r3", name: "files.read", arguments: JSON.stringify({ path: "notes/never.md" }) },
  ] });
  const ev = (kind, data) => app.store.event(run.id, kind, data);
  ev("tool.completed", { name: "files.read", id: "r1", result: { content: "a" } });
  ev("tool.completed", { name: "files.read_many", id: "r2", result: { files: [] } });
  ev("tool.failed", { name: "files.read", id: "r3", error: "missing" });
  ev("file.changed", { path: "notes/c.md", versionId: null, existed: true, added: 1, removed: 0, diff: "+x" });
  app.store.finish(run.id, "completed", "Read them.");
  const work = panelsWork(app.store, app.runtime.owner, run.sessionId);
  assert.deepEqual(work.files.read, ["notes/a.md", "notes/b.md"], "read once each; the changed one and the failed read are left out");
  assert.deepEqual(panelsWork(app.store, "somebody-else", run.sessionId).files.read, [], "another owner's conversation lists nothing");
});
