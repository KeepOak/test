/**
 * Attachments, third round:
 * - Branching a conversation ("Branch from here", POST /api/sessions/<id>/branch) copies its files off the engine
 *   thread, and a branch whose database work fails leaves no files behind.
 * Mutations, each turns a test here red:
 * - src/sessions.ts branch: copy the files inside the transaction with copyFileSync (src/attachments.ts prepareCopies):
 *   the engine stops answering while a copy is held.
 * - src/sessions.ts branch: drop `this.files()?.discard(sessionId)` in the catch: a failed branch leaves its files.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

async function branch(t) {
  const scratch = join(tmpdir(), "Codex-session-files");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "branch-attach-3-"));
  const closing = [];
  t.after(async () => { for (const close of closing.reverse()) await close(); await discardTemp(root); });
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"),
    provider: { name: "scripted", async complete() { return { content: "Got it.", toolCalls: [] }; } } });
  closing.push(() => app.close());
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  closing.push(() => server.close());
  const headers = { authorization: `Bearer ${server.token}`, host: new URL(server.url).host };
  const post = async (path, body) => {
    const answer = await fetch(server.url + path, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: answer.status, body: await answer.json().catch(() => ({})) };
  };
  const get = (path) => fetch(server.url + path, { headers });
  const upload = async (name, type, body) => {
    const answer = await fetch(`${server.url}/api/attachments/upload?name=${encodeURIComponent(name)}&type=${encodeURIComponent(type)}`,
      { method: "POST", headers: { ...headers, "content-type": "application/octet-stream" }, body, duplex: "half" });
    return { status: answer.status, body: await answer.json().catch(() => ({})) };
  };
  const fileOf = (sessionId) => app.store.messages(sessionId).find((one) => one.role === "user").attachments[0];
  return { app, root, server, post, get, upload, fileOf };
}
/** A conversation with one file and a reply to branch from. */
async function withFile(f, bytes) {
  const staged = await f.upload("film.bin", "application/octet-stream", bytes);
  assert.equal(staged.status, 200, JSON.stringify(staged.body));
  const run = await f.post("/api/run", { prompt: "keep this", uploads: [staged.body.upload] });
  assert.equal(run.status, 200, JSON.stringify(run.body));
  const view = f.app.store.sessionView(f.app.runtime.owner, run.body.sessionId);
  const reply = view.messages.findLast((one) => one.role === "assistant");
  return { sessionId: run.body.sessionId, messageId: reply.messageId };
}

test("branching copies a big file off the engine thread: the engine keeps answering while it copies", async (t) => {
  const f = await branch(t);
  const big = Buffer.alloc(65 * 1024 * 1024 + 11, 4);
  const from = await withFile(f, big);
  let release, copies = 0;
  const held = new Promise((done) => { release = done; });
  const copy = f.app.attachments.copier;
  f.app.attachments.copier = async (a, b) => { copies++; await held; return copy(a, b); };
  const branching = f.post(`/api/sessions/${from.sessionId}/branch`, { messageId: from.messageId, name: "another way" });
  let early = null;
  branching.then((answer) => { early = answer; });
  for (let i = 0; i < 500 && !copies && !early; i++) await new Promise((done) => setTimeout(done, 10));
  assert.equal(copies, 1, `the copy started ${early ? JSON.stringify(early) : ""}`);
  assert.equal((await f.get("/api/state")).status, 200, "the engine answers while the copy is held");
  release();
  const made = await branching;
  assert.equal(made.status, 200, JSON.stringify(made.body));
  const ref = f.fileOf(made.body.sessionId);
  assert.notEqual(ref.id, f.fileOf(from.sessionId).id, "the branch has its own name for the file");
  const answer = await f.get(`/api/attachments/file?session=${made.body.sessionId}&id=${ref.id}`);
  assert.equal(answer.status, 200);
  assert.equal(Buffer.from(await answer.arrayBuffer()).length, big.length, "every byte was copied");
});

test("a branch whose database work fails leaves no files behind", async (t) => {
  const f = await branch(t);
  const from = await withFile(f, Buffer.alloc(4096, 6));
  const kept = join(f.root, "data", "attachments");
  const folders = (await readdir(kept)).sort();
  f.app.store.db.exec("CREATE TRIGGER refuse_branch BEFORE INSERT ON session_branches BEGIN SELECT RAISE(ABORT, 'no room'); END");
  t.after(() => { try { f.app.store.db.exec("DROP TRIGGER IF EXISTS refuse_branch"); } catch { /* closed */ } });
  await assert.rejects(f.app.store.branchSession(f.app.runtime.owner, { sessionId: from.sessionId, messageId: from.messageId }), /no room/);
  assert.deepEqual((await readdir(kept)).sort(), folders, "no folder for a branch that does not exist");
});
