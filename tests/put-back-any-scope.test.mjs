/* parity-b2 (review): the owner's "Put back the earlier version" (POST /api/history/restore) works for a file a Trunk or a
   worktree task changed: the version is written back into the folder it was changed in, and the copy kept first is
   stamped with that folder, while the owner's own file at the same path is left alone. A task's files.restore stays held
   to its own folder, and a folder that is gone is said plainly. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { inWorktree } from "../dist/coding/worktrees.js";

test("Put back restores a file a Trunk or a worktree task changed, in its own folder only", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-put-back-"));
  const quiet = { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } };
  const workspace = join(root, "workspace");
  const app = await createBranch({ workspace, dataDir: join(root, "data"), provider: quiet });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const history = app.store.workspaceHistory;
  const putBack = (versionId) => fetch(new URL("/api/history/restore", server.url), { method: "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify({ versionId }) });
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, "note.md"), "the owner's own\n");
  for (const scope of [".branch-agents/ada", "project/.branch-worktrees/fork-1"]) {
    const folder = join(workspace, ...scope.split("/"));
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "note.md"), "first\n");
    const kept = await inWorktree(scope, () => history.before("note.md", { runId: "task" }));
    await writeFile(join(folder, "note.md"), "second\n");
    const answer = await putBack(kept.version.id);
    assert.equal(answer.status, 200, `${scope}: ${await answer.clone().text()}`);
    assert.deepEqual(await answer.json(), { path: "note.md", bytes: 6, restored: true });
    assert.equal(await readFile(join(folder, "note.md"), "utf8"), "first\n", `${scope}: put back where it was changed`);
    assert.equal(await readFile(join(workspace, "note.md"), "utf8"), "the owner's own\n", "the owner's file at the same path is untouched");
    const there = await inWorktree(scope, async () => history.history("note.md"));
    assert.ok(there.some((v) => v.reason.startsWith("before restore") && v.bytes === 7), `${scope}: what it held is kept, in its own folder`);
    assert.ok(!history.history("note.md").some((v) => v.reason.startsWith("before restore")), "and not in the owner's");
    // A task's own files.restore is still held to its own folder.
    await assert.rejects(app.registry.execute("files.restore", { versionId: kept.version.id }, app.runtime.context()), /not kept/);
  }
  // The folder it was changed in is gone: said plainly, nothing written.
  const scope = ".branch-agents/bo", folder = join(workspace, ".branch-agents", "bo");
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, "plan.md"), "x\n");
  const kept = await inWorktree(scope, () => history.before("plan.md", { runId: "task" }));
  await rm(folder, { recursive: true, force: true });
  const gone = await putBack(kept.version.id);
  assert.ok(gone.status >= 400, `refused (${gone.status})`);
  assert.match((await gone.json()).error, /gone/);
});
