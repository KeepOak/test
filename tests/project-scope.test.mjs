/**
 * dogfood-ux-2 (security tier: secrets scope): a task reaches the folder and saved secrets of ITS conversation's project,
 * never those of a project picked anywhere else while it runs. Before this, "the active project" was one global setting:
 * pressing New conversation in one place (or opening a project) moved every running task into another project's folder
 * and secrets mid-task. src/project-scope.ts, src/projects.ts active/chosen, src/runtime.ts execute.
 *
 * Mutations checked by hand (each turns a test here red):
 *   M1  Projects.active ignores the task's project (returns `chosen`)        → "mid-task", "helper", "secrets"
 *   M2  a removed project falls back to the owner's pick, not the default     → "removed"
 *   M3  execute does not run the task inside underProject                     → "mid-task", "secrets"
 *   M4  the practice files are written by switching the owner's pick again   → "practice"
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { underProject, currentProject } from "../dist/project-scope.js";

const exists = (path) => access(path).then(() => true, () => false);

/** An app whose model runs `during(request, round)` inside each model call, then answers from `steps`. */
async function branch(t, steps, during = () => undefined) {
  const root = await mkdtemp(join(tmpdir(), "branch-project-scope-"));
  let round = 0;
  const provider = { name: "scripted", async complete(request) {
    const step = steps[Math.min(round, steps.length - 1)];
    await during(request, round++);
    return step;
  } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  t.after(async () => { await app.close().catch(() => undefined); await discardTemp(root); });
  const owner = app.runtime.owner;
  app.store.projects.save(owner, { id: "garden", name: "Garden", instructions: "", modelPreset: null, repository: "", folder: "garden" });
  app.store.projects.save(owner, { id: "taxes", name: "Taxes", instructions: "", modelPreset: null, repository: "", folder: "taxes" });
  return { app, owner, root };
}
const write = (path, content) => ({ content: "", toolCalls: [{ id: `w${Math.random().toString(36).slice(2, 8)}`, name: "files.write", arguments: JSON.stringify({ path, content }) }] });
const done = { content: "Done.", toolCalls: [] };

test("mid-task: the owner picking another project moves nothing a running task reaches", async (t) => {
  const seen = [];
  const { app, owner, root } = await branch(t, [write("note.txt", "for the garden"), done], (_request, round) => {
    // While the task works, the owner picks Taxes somewhere else (a new conversation, a project page, the phone).
    if (round === 0) app.store.projects.setActive(owner, { active: "taxes" });
    seen.push(app.store.projects.active(owner).id);
  });
  const run = await app.runtime.run({ prompt: "write a note", conversationProject: "garden", permissions: ["files.write", "files.read"] });
  assert.equal(run.status, "completed", run.output);
  assert.deepEqual([...new Set(seen)], ["garden"], "every model call of the task sees its own project");
  assert.equal(await readFile(join(root, "workspace", "garden", "note.txt"), "utf8"), "for the garden");
  assert.equal(await exists(join(root, "workspace", "taxes", "note.txt")), false, "nothing lands in the project picked meanwhile");
  assert.equal(app.store.projects.active(owner).id, "taxes", "outside any task, the owner's pick; the task's project did not leak out");
  assert.equal(currentProject(), undefined);
});

test("secrets: a task resolves its own project's saved secrets, whatever is picked", async (t) => {
  let resolved = null;
  const { app, owner } = await branch(t, [done], async () => {
    app.store.projects.setActive(owner, { active: "taxes" });
    resolved = (await app.store.locker.resolve(owner, app.store.projects.active(owner).id, ["TOKEN"])).TOKEN;
  });
  await app.store.locker.set(owner, "garden", "TOKEN", "garden-value");
  await app.store.locker.set(owner, "taxes", "TOKEN", "taxes-value");
  await app.runtime.run({ prompt: "use the token", conversationProject: "garden" });
  assert.equal(resolved, "garden-value");
});

test("helper: work a task starts is filed under the task's project, not the owner's pick", async (t) => {
  const { app, owner } = await branch(t, [done]);
  app.store.projects.setActive(owner, { active: "taxes" });
  const helper = underProject("garden", () => app.store.createRun(owner, "a helper's task"));
  assert.equal(helper.project, "garden");
  assert.equal(app.store.createRun(owner, "started outside any task").project, "taxes", "outside a task, the owner's pick files it");
});

test("removed: a project removed while its task runs reads as the default, never another project", async (t) => {
  const seen = [];
  const { app, owner } = await branch(t, [done], () => {
    app.store.projects.setActive(owner, { active: "taxes" });
    app.store.projects.remove(owner, "garden");
    seen.push(app.store.projects.active(owner).id);
  });
  await app.runtime.run({ prompt: "carry on", conversationProject: "garden" });
  assert.deepEqual(seen, ["default"]);
});

test("a conversation carried on keeps its project although another one is picked now", async (t) => {
  const seen = [];
  const { app, owner } = await branch(t, [done], () => { seen.push(app.store.projects.active(owner).id); });
  const first = await app.runtime.run({ prompt: "one", conversationProject: "garden" });
  app.store.projects.setActive(owner, { active: "taxes" });
  await app.runtime.run({ prompt: "two", sessionId: first.sessionId });
  assert.deepEqual(seen, ["garden", "garden"]);
});

test("practice: its files are written into its folder without moving the owner's pick", async (t) => {
  const { app, owner, root } = await branch(t, [done]);
  app.store.projects.setActive(owner, { active: "taxes" });
  const picks = [];
  const stop = app.store.projects.onSwitched((_owner, project) => picks.push(project.id));
  t.after(stop);
  const made = await app.practice.create(owner);
  assert.ok(made.created.length > 0);
  assert.ok(await exists(join(root, "workspace", made.created[0])), made.created[0]);
  assert.deepEqual(picks, [], "the owner's pick never moved, not even for a moment");
  assert.equal(app.store.projects.chosen(owner).id, "taxes");
});
