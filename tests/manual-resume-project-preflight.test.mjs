import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBranch } from "../dist/index.js";
import { discardTemp } from "./temp-dir.mjs";

for (const availableTo of ["person", "assistant", "neither"]) {
  test(`manual lending preflight refuses ${availableTo}-only project before ownership changes`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "branch-resume-project-preflight-"));
    let completions = 0;
    const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"),
      provider: { name: "scripted", async complete() { completions++; return { content: "fixture", toolCalls: [] }; } } });
    t.after(async () => { await app.close(); await discardTemp(root); });
    const person = app.store.profiles.create({ name: "Ada", pin: "1234" });
    const owner = `profile:${person.id}`;
    const project = "recorded-project";
    if (availableTo !== "neither") app.store.projects.save(availableTo === "person" ? owner : app.runtime.owner,
      { id: project, name: "Recorded project" });
    const run = app.store.createRun(owner, "interrupted task", undefined, false, "web", project);
    app.store.event(run.id, "run.started", { source: "owner", personProfileId: person.id, lentTo: owner,
      permissions: [], deadlineMs: 30_000, depth: 0, delegates: false });
    app.store.finish(run.id, "interrupted", "fixture interruption");
    const count = () => app.store.sqlite.prepare("SELECT COUNT(*) AS n FROM tasks").get().n;
    const before = count();
    let reassignments = 0;
    t.mock.method(app.store, "reassignSession", () => { reassignments++; assert.fail("must refuse before changing any owner"); });
    await assert.rejects(app.runtime.resume(run.id), /original task's project.*Reconcile/);
    assert.equal(reassignments, 0);
    assert.equal(count(), before, "refusal creates no continuation task");
    assert.equal(app.store.run(run.id).owner, owner);
    assert.equal(app.store.run(run.id).status, "interrupted");
    assert.equal(app.store.ownsSession(owner, run.sessionId), true);
    assert.equal(app.store.sessionProject(run.sessionId), project);
    assert.equal(completions, 0, "no model request follows failed preflight");
  });
}