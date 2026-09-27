import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { z } from "zod";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

async function fixture(t, provider) {
  const scratch = join(tmpdir(), "Codex-session-files");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "branch-sessions-"));
  const options = { workspace: join(root, "workspace"), dataDir: join(root, "data"), provider };
  const app = await createBranch(options);
  t.after(async () => { await app.close(); await discardTemp(root); });
  return { app, options };
}
function seed(store, owner = "local", content = "Source decision") {
  const run = store.createRun(owner, content);
  store.message(run.sessionId, { role: "user", content });
  store.finish(run.id, "completed", "Seeded");
  return store.sessionView(owner, run.sessionId);
}
const point = (view, index = 0) => ({ sessionId: view.sessionId, messageId: view.messages[index].messageId });



test("a branch gets its own copy of the files, under its own names, and keeps them when the parent's are gone", async (t) => {
  // A branch used to copy message bodies across verbatim, references and all. The new conversation
  // has no folder of its own, so every card it showed was one that could not be opened — and had it
  // shared the parent's names, deleting the parent would have broken the branch as well.
  const onePixel = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const bytes = Buffer.from(onePixel, "base64");
  const { app } = await fixture(t, { name: "branch-attachment-fixture",
    async complete() { return { content: "Looked at it.", toolCalls: [] }; } });
  const run = await app.runtime.run({ prompt: "What is in this?",
    attachments: [{ mediaType: "image/png", name: "chart.png", data: onePixel }] });
  assert.equal(run.status, "completed", run.output);
  const asked = app.store.sessionView("local", run.sessionId).messages.find((one) => one.role === "user");
  const source = asked.attachments[0];

  const branch = (await app.store.branchSession("local", { sessionId: run.sessionId, messageId: asked.messageId }));
  const carried = app.store.sessionView("local", branch.sessionId).messages
    .find((one) => one.role === "user").attachments[0];
  assert.notEqual(carried.id, source.id, "the branch knows the file by a name of its own");
  assert.equal(carried.name, "chart.png");
  assert.ok((await app.attachments.read(branch.sessionId, carried.id)).bytes.equals(bytes), "and it opens");

  await app.attachments.forget(run.sessionId);
  await assert.rejects(app.attachments.read(run.sessionId, source.id), "the parent's own file is gone");
  assert.ok((await app.attachments.read(branch.sessionId, carried.id)).bytes.equals(bytes),
    "the branch is not a pointer into the conversation it came off");
});


test("conversation branch preserves exact prefix, tool evidence and original while continuing independently", async (t) => {
  let effects = 0, branchedRequest;
  const provider = { name: "branch-fixture", async complete(request) {
    const prompt = request.messages.findLast(message => message.role === "user").content;
    if (prompt === "Original task" && !request.messages.some(message => message.role === "tool"))
      return { content: "", toolCalls: [{ id: "effect", name: "fixture.effect", arguments: "{}" }] };
    if (prompt === "Explore another option") branchedRequest = request.messages;
    return { content: prompt === "Original task" ? "Emerald decision" : "Reply: " + prompt, toolCalls: [] };
  } };
  const { app, options } = await fixture(t, provider);
  app.registry.register({ name: "fixture.effect", permission: "fixture.effect", description: "A real effect",
    parameters: z.object({}), execute: async (_input, context) => {
      const written = await app.files.write("effect.txt", "once", context.signal);
      effects++;
      return written;
    } });
  const original = await app.runtime.run({ prompt: "Original task" });
  assert.equal(original.status, "completed", original.output);
  const first = app.store.sessionView("local", original.sessionId);
  const selected = point(first, first.messages.length - 1);
  await app.runtime.run({ sessionId: original.sessionId, prompt: "Later original turn" });
  const before = app.store.sessionView("local", original.sessionId);
  const fork = await app.runtime.executeTool("sessions.branch", selected);
  const copied = app.store.sessionView("local", fork.sessionId);
  assert.equal(fork.copiedMessages, first.messages.length);
  const stripId = ({ messageId, ...message }) => message;
  assert.deepEqual(copied.messages.map(stripId), first.messages.map(stripId));
  assert.ok(copied.messages.every(message => !first.messages.some(old => old.messageId === message.messageId)));
  const continued = await app.runtime.run({ sessionId: fork.sessionId, prompt: "Explore another option" });
  assert.equal(continued.status, "completed", continued.output);
  assert.ok(!branchedRequest.some(message => message.content.includes("Later original turn")));
  assert.equal(effects, 1);
  assert.equal(await readFile(join(options.workspace, "effect.txt"), "utf8"), "once");
  assert.deepEqual(app.store.sessionView("local", original.sessionId), before);
  assert.equal(copied.branch.parentSessionId, original.sessionId);
  assert.equal(copied.branch.branchPointMessageId, selected.messageId);
  await app.close();
  const reopened = await createBranch(options);
  try {
    assert.equal(reopened.store.sessionView("local", fork.sessionId).branch.parentSessionId, original.sessionId);
    assert.deepEqual(reopened.store.sessionView("local", original.sessionId), before);
    assert.equal(reopened.store.searchHistory("local", { query: "Emerald" }).length, 2);
  } finally { await reopened.close(); }
});

test("branching requires both grants and refuses other owners or mismatched message identities", async (t) => {
  const { app } = await fixture(t);
  const own = seed(app.store), other = seed(app.store, "other");
  for (const permissions of [["history.read"], ["sessions.branch"]])
    await assert.rejects(app.registry.execute("sessions.branch", point(own), app.runtime.context({ permissions })), /Permission denied/);
  await assert.rejects(app.store.branchSession("local", point(other)), /Conversation not found/);
  assert.throws(() => app.store.sessionView("local", other.sessionId), /Conversation not found/);
  await assert.rejects(app.store.branchSession("local", { sessionId: own.sessionId, messageId: other.messages[0].messageId }), /Branch message not found/);
});

test("unsafe branch boundaries are rejected without repairing or mutating the source", async (t) => {
  const { app } = await fixture(t);
  const view = seed(app.store);
  app.store.message(view.sessionId, { role: "assistant", content: "Pending", toolCalls: [{ id: "pending", name: "files.write", arguments: "{}" }] });
  app.store.message(view.sessionId, { role: "user", content: "After missing result" });
  const source = app.store.sessionView("local", view.sessionId);
  await assert.rejects(app.store.branchSession("local", point(source, 1)), /without tool requests/);
  await assert.rejects(app.store.branchSession("local", point(source, 2)), /unfinished tool requests/);
  assert.deepEqual(app.store.sessionView("local", view.sessionId), source);
  assert.equal((await app.store.branchSession("local", point(source))).copiedMessages, 1);
});

test("branch copying is atomic on write failure and checks size only through its chosen point", async (t) => {
  const { app } = await fixture(t);
  const view = seed(app.store);
  const db = app.store.db; // Fault injection at SQLite write boundary.
  const count = () => Number(db.prepare("SELECT COUNT(*) AS n FROM sessions").get().n);
  const before = count();
  db.exec("CREATE TRIGGER fail_branch_copy BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT,'fixture copy failure'); END");
  await assert.rejects(app.store.branchSession("local", point(view)), /fixture copy failure/);
  assert.equal(count(), before);
  assert.equal(Number(db.prepare("SELECT COUNT(*) AS n FROM session_branches").get().n), 0);
  db.exec("DROP TRIGGER fail_branch_copy");
  app.store.message(view.sessionId, { role: "user", content: "x".repeat(4 * 1024 * 1024) });
  const large = db.prepare("SELECT source_id FROM messages WHERE session_id=? ORDER BY id DESC LIMIT 1").get(view.sessionId);
  await assert.rejects(app.store.branchSession("local", { sessionId: view.sessionId, messageId: Number(large.source_id) }), /4 MiB/);
  assert.equal(count(), before);
  assert.equal((await app.store.branchSession("local", point(view))).copiedMessages, 1);
});

test("authenticated session API exposes branch history and rejects other owners", async (t) => {
  const { app, options } = await fixture(t);
  const own = seed(app.store), other = seed(app.store, "other");
  const server = await startServer(app, { dataDir: options.dataDir, port: 0 });
  t.after(() => server.close());
  const headers = { authorization: "Bearer " + server.token };
  assert.equal((await fetch(server.url + "/api/sessions/" + own.sessionId)).status, 401);
  const response = await fetch(server.url + "/api/sessions/" + own.sessionId, { headers });
  assert.equal(response.status, 200);
  // #505 (Dogfood D14): the owner is told which project the conversation is filed under, so the window can say so.
  assert.deepEqual(await response.json(), { ...own, project: app.store.sessionProject(own.sessionId) ?? null });
  assert.equal(app.store.sessionProject(own.sessionId), "default", "a conversation begun with no project named is the default project's");
  const denied = await fetch(server.url + "/api/sessions/" + other.sessionId, { headers });
  assert.equal(denied.status, 400);
  assert.match((await denied.json()).error, /Conversation not found/);
});
