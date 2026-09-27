/**
 * Attachments, third round:
 * - Branching a conversation ("Branch from here", POST /api/sessions/<id>/branch) copies its files off the engine
 *   thread, and a branch whose database work fails leaves no files behind.
 * Mutations, each turns a test here red:
 * - src/sessions.ts branch: copy the files inside the transaction with copyFileSync (src/attachments.ts prepareCopies):
 *   the engine stops answering while a copy is held.
 * - src/sessions.ts branch: drop `this.files()?.discard(sessionId)` in the catch: a failed branch leaves its files.
 * - Files sent ahead of a message (a desktop paste sends its files this way) still wait after the engine restarts.
 * - src/attachments.ts sweepIncoming: drop reading the waiting list back: the file no longer waits after a restart.
 * - src/attachments.ts sweepIncoming: drop the size check: a file changed since still waits.
 * - src/attachments.ts StagedRecordSchema: take any id: a name that is not the folder's own waits.
 * - src/attachments.ts sweepIncoming: parse the list without its try: a list that is not whole stops the clearing.
 * - src/attachments.ts saveWaiting: drop its catch: a list that cannot be written fails the send.
 * - src/attachments.ts holdDisk: count every disk's promises together: a copy on one disk refuses a copy on another.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { Attachments, holdDisk, stagedLifeMs } from "../dist/attachments.js";

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

/* ---------- files sent ahead survive a restart ---------- */

test("files still waiting to be sent wait again after a restart, for whoever sent them, and nothing else does", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-attach-3-restart-"));
  t.after(() => discardTemp(root));
  let now = Date.now();
  const first = new Attachments(root, undefined, undefined, undefined, undefined, { now: () => now });
  const kept = await first.stage("local", { name: "pasted.png", mediaType: "image/png" }, [Buffer.from("a copied picture")]);
  const old = await first.stage("local", { name: "old.txt", mediaType: "text/plain" }, [Buffer.from("sent long ago")]);
  const changed = await first.stage("local", { name: "changed.txt", mediaType: "text/plain" }, [Buffer.from("will be changed")]);
  const gone = await first.stage("local", { name: "gone.txt", mediaType: "text/plain" }, [Buffer.from("taken off")]);
  assert.equal(await first.unstage("local", gone.upload), true);
  // What an earlier run left: one file past its time, one whose bytes are not what the list says, and a stray.
  const list = JSON.parse(await readFile(join(root, ".incoming", "waiting.json"), "utf8"));
  list.find((one) => one.id === old.upload).at = now - stagedLifeMs - 1;
  await writeFile(join(root, ".incoming", "waiting.json"), JSON.stringify(list));
  await writeFile(join(root, ".incoming", changed.upload), "different bytes, a different size");
  await writeFile(join(root, ".incoming", "b".repeat(24)), "a stray from a run that stopped");

  const second = new Attachments(root, undefined, undefined, undefined, undefined, { now: () => now });
  await second.sweepIncoming();
  assert.deepEqual(second.staged("local", [kept.upload]).map((one) => one.name), ["pasted.png"], "the waiting file waits again");
  assert.throws(() => second.staged("sam", [kept.upload]), /no longer waiting/, "and only for whoever sent it");
  for (const [what, id] of [["past its time", old.upload], ["changed since", changed.upload], ["taken off", gone.upload]])
    assert.throws(() => second.staged("local", [id]), /no longer waiting/, `a file ${what} does not`);
  assert.deepEqual((await readdir(join(root, ".incoming"))).sort(), [kept.upload, "waiting.json"].sort(), "everything else in the folder is cleared");
  const [ref] = await second.keep("a-conversation", [], { uploads: { who: "local", ids: [kept.upload] } });
  assert.equal((await second.read("a-conversation", ref.id)).bytes.toString(), "a copied picture", "and a message takes it whole");
  now += 1;
});

test("a file sent ahead, as a desktop paste sends one, goes with its message after the engine restarts", async (t) => {
  const scratch = join(tmpdir(), "Codex-session-files");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "branch-attach-3-engine-"));
  const closing = [];
  t.after(async () => { for (const close of closing.reverse()) await close(); await discardTemp(root); });
  const seen = [];
  const start = async () => {
    const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"),
      provider: { name: "scripted", async complete(request) { seen.push(request.messages); return { content: "Got it.", toolCalls: [] }; } } });
    const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
    const headers = { authorization: `Bearer ${server.token}`, host: new URL(server.url).host };
    return { app, server, headers };
  };
  const before = await start();
  const sent = await fetch(`${before.server.url}/api/attachments/upload?name=notes.txt&type=application%2Foctet-stream`,
    { method: "POST", headers: { ...before.headers, "content-type": "application/octet-stream", "x-branch-origin": "window" }, body: Buffer.from("The boat is moored at pier 9."), duplex: "half" });
  const { upload } = await sent.json();
  assert.ok(upload, "control: the file was sent ahead");
  await before.server.close();
  await before.app.close();

  const after = await start();
  closing.push(() => after.app.close(), () => after.server.close());
  const run = await fetch(`${after.server.url}/api/run`, { method: "POST", headers: { ...after.headers, "content-type": "application/json" },
    body: JSON.stringify({ prompt: "Where is the boat?", uploads: [upload] }) });
  const body = await run.json();
  assert.equal(run.status, 200, JSON.stringify(body));
  assert.equal(after.app.store.messages(body.sessionId).find((one) => one.role === "user").attachments.length, 1, "the file went with its message");
  assert.match(JSON.stringify(seen.at(-1)), /moored at pier 9/, "and the model was given it");
});

test("a waiting list that cannot be read back is not trusted, and the folder is still cleared", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-attach-3-unreadable-"));
  t.after(() => discardTemp(root));
  await mkdir(join(root, ".incoming"), { recursive: true });
  await writeFile(join(root, ".incoming", "waiting.json"), "{ not a list");
  await writeFile(join(root, ".incoming", "c".repeat(24)), "a stray from a run that stopped");
  const files = new Attachments(root);
  await files.sweepIncoming();
  assert.deepEqual(await readdir(join(root, ".incoming")), ["waiting.json"], "the stray is cleared");
  assert.deepEqual(JSON.parse(await readFile(join(root, ".incoming", "waiting.json"), "utf8")), [], "and the list is written again, empty");
});

test("only files under the folder's own names are taken back from the waiting list", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-attach-3-names-"));
  t.after(() => discardTemp(root));
  const now = Date.now();
  await mkdir(join(root, ".incoming"), { recursive: true });
  const outside = join(root, "kept.txt");
  await writeFile(outside, "not a file sent ahead");
  const record = { who: "local", name: "kept.txt", mediaType: "text/plain", kind: "document", bytes: Buffer.byteLength("not a file sent ahead"), at: now };
  // Control: the same record under a name of the folder's own shape waits again.
  const own = "d".repeat(24);
  await writeFile(join(root, ".incoming", own), "not a file sent ahead");
  await writeFile(join(root, ".incoming", "waiting.json"), JSON.stringify([{ ...record, id: own }]));
  const control = new Attachments(root, undefined, undefined, undefined, undefined, { now: () => now });
  await control.sweepIncoming();
  assert.equal(control.staged("local", [own]).length, 1, "control: a record of this shape is taken back");

  await writeFile(join(root, ".incoming", "waiting.json"), JSON.stringify([{ ...record, id: "../kept.txt" }]));
  const files = new Attachments(root, undefined, undefined, undefined, undefined, { now: () => now });
  await files.sweepIncoming();
  assert.throws(() => files.staged("local", ["../kept.txt"]), /no longer waiting/, "a name that is not the folder's own does not wait");
  assert.equal(await readFile(outside, "utf8"), "not a file sent ahead", "and the file it names is untouched");
});

test("a waiting list that cannot be written does not fail a send or its message", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-attach-3-unwritable-"));
  t.after(() => discardTemp(root));
  // A folder where the list goes: moving the list into place fails every time.
  await mkdir(join(root, ".incoming", "waiting.json"), { recursive: true });
  const files = new Attachments(root);
  const sent = await files.stage("local", { name: "pasted.png", mediaType: "image/png" }, [Buffer.from("a copied picture")]);
  assert.ok(sent.upload, "the file was sent ahead");
  const [ref] = await files.keep("a-conversation", [], { uploads: { who: "local", ids: [sent.upload] } });
  assert.equal((await files.read("a-conversation", ref.id)).bytes.toString(), "a copied picture", "and its message took it");
});

test("copies being made on one disk never count against another disk's reserve", () => {
  const reserve = 1024 ** 3, copy = 8192;
  // Each disk has room for its reserve and one copy and a half.
  const free = reserve + copy + copy / 2;
  const first = holdDisk("A working copy of this file", "disk-a", free, copy);
  const other = holdDisk("A copy of this conversation's files", "disk-b", free, copy);
  assert.throws(() => holdDisk("A working copy of this file", "disk-a", free, copy), /does not fit/, "control: a second copy on the same disk is refused");
  first(); other();
  holdDisk("A working copy of this file", "disk-a", free, copy)();
});
