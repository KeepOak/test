/**
 * Owner ruling (2026-09-30): in the owner's Full access the file tools reach the whole computer, as OpenClaw's do with
 * `tools.fs.workspaceOnly` false (its default), Codex's danger-full-access and Claude Code's bypass. Secret names and
 * Branch's own files stay refused, and anything outside Full access keeps the workspace.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBranch } from "../dist/index.js";
import { underShortLivedKey } from "../dist/key-context.js";
import { discardTemp } from "./temp-dir.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-file-reach-"));
  const provider = { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  t.after(async () => { app.store.profiles.switch({ profileId: null }); await app.close(); await discardTemp(root); });
  const elsewhere = join(root, "elsewhere");
  await mkdir(elsewhere, { recursive: true });
  await writeFile(join(elsewhere, "notes.txt"), "outside the workspace");
  await writeFile(join(elsewhere, ".env"), "KEY=secret");
  return { app, root, elsewhere };
}
const use = (app, tool, args, context) => app.registry.execute(tool, args, context);

test("in the owner's Full access the file tools read, list, write and move anywhere, and are not asked about", async (t) => {
  const { app, elsewhere } = await fixture(t);
  const run = await app.runtime.run({ prompt: "work", conversationMode: "full" });
  const own = app.runtime.context({ runId: run.id });
  const notes = join(elsewhere, "notes.txt"), made = join(elsewhere, "made.txt");
  assert.equal(app.runtime.checkPolicy("files.write", { path: made, content: "x" }, own).decision, "allow");
  assert.equal((await use(app, "files.read", { path: notes }, own)).content, "outside the workspace");
  const listed = (await use(app, "files.list", { path: elsewhere }, own)).entries.map((entry) => entry.name);
  assert.deepEqual(listed.sort(), ["notes.txt"], "a secret-looking name is left out of the list");
  await use(app, "files.write", { path: made, content: "written" }, own);
  assert.equal(await readFile(made, "utf8"), "written");
  await use(app, "files.move", { from: made, to: join(elsewhere, "moved.txt") }, own);
  assert.equal(await readFile(join(elsewhere, "moved.txt"), "utf8"), "written");
  await use(app, "files.read", { path: join(elsewhere, "moved.txt") }, own); // the read-before-edit guard holds there too
  await use(app, "files.edit", { path: join(elsewhere, "moved.txt"), find: "written", replace: "edited" }, own);
  assert.equal(await readFile(join(elsewhere, "moved.txt"), "utf8"), "edited", "files.edit reaches it too");
  await assert.rejects(use(app, "files.read", { path: join(elsewhere, ".env") }, own), /secret/, "secret names stay refused");
  await assert.rejects(use(app, "files.write", { path: join(elsewhere, ".ssh", "authorized_keys"), content: "x" }, own), /secret/);
});

test("Branch's own files stay out of reach in Full access, as never-break holds them everywhere", async (t) => {
  const { app, root } = await fixture(t);
  const run = await app.runtime.run({ prompt: "work", conversationMode: "full" });
  const own = app.runtime.context({ runId: run.id });
  const database = join(root, "data", "branch.sqlite");
  const check = app.runtime.checkPolicy("files.write", { path: database, content: "x" }, own);
  assert.equal(check.decision, "deny", JSON.stringify(check));
});

test("outside Full access, a short-lived key's task and a household person keep the workspace", async (t) => {
  const { app, elsewhere } = await fixture(t);
  const notes = join(elsewhere, "notes.txt");
  const plain = await app.runtime.run({ prompt: "work", conversationMode: "auto" });
  await assert.rejects(use(app, "files.read", { path: notes }, app.runtime.context({ runId: plain.id })), /traversal|outside/);
  const keyed = await underShortLivedKey(() => app.runtime.run({ prompt: "work", conversationMode: "full" }));
  await assert.rejects(underShortLivedKey(() => use(app, "files.read", { path: notes }, app.runtime.context({ runId: keyed.id }))), /traversal|outside/);
  const person = app.store.profiles.create({ name: "Sam", pin: "1234" });
  app.store.profiles.switch({ profileId: person.id, pin: "1234" });
  const theirs = await app.runtime.run({ prompt: "work", conversationMode: "full" });
  await assert.rejects(use(app, "files.read", { path: notes }, app.runtime.context({ runId: theirs.id })), /traversal|outside|owner/);
});
