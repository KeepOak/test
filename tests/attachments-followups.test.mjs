/**
 * Attachment follow-ups (#479), through the window's own routes:
 * - A household person at the window opens the files they attached to their own conversations, and never the owner's,
 *   another person's, or a file of another conversation named under their own conversation's id.
 * - A message may be only files, with no words; with no words and no files it is still refused.
 * - Duplicating a conversation copies files of any size, off the engine thread, and keeps the disk's reserve free.
 * Mutations, each turns a test here red:
 * - src/attachments.ts attachmentForWindow: let anybody through (drop the ownsConversation check): Sam opens the owner's.
 * - src/household-routes.ts: drop the /api/attachments/file read: Sam cannot open his own file.
 * - src/contracts.ts RunInputSchema: accept no words without files: the empty message is taken.
 * - src/session-library.ts duplicate: copy with copyFileSync inside the transaction: the engine stops answering while a
 *   copy is held.
 * - src/session-library.ts duplicate: drop the reserve check: a copy that would eat into it is made.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const picture = { name: "photo.png", mediaType: "image/png", data: png.toString("base64") };

async function branch(t, provider) {
  const scratch = join(tmpdir(), "Codex-session-files");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "branch-attach-followups-"));
  const closing = [];
  t.after(async () => { for (const close of closing.reverse()) await close(); await discardTemp(root); });
  const app = await createBranch({
    workspace: join(root, "workspace"), dataDir: join(root, "data"),
    provider: provider ?? { name: "scripted", async complete() { return { content: "Got it.", toolCalls: [] }; } },
  });
  closing.push(() => app.close());
  closing.push(() => app.store.profiles.switch({ profileId: null }));
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  closing.push(() => server.close());
  const headers = (token = server.token) => ({ authorization: `Bearer ${token}`, host: new URL(server.url).host });
  const post = async (path, body, token) => {
    const answer = await fetch(server.url + path, { method: "POST", headers: { ...headers(token), "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: answer.status, body: await answer.json().catch(() => ({})) };
  };
  const get = (path, token) => fetch(server.url + path, { headers: headers(token) });
  const upload = async (name, type, body) => {
    const answer = await fetch(`${server.url}/api/attachments/upload?name=${encodeURIComponent(name)}&type=${encodeURIComponent(type)}`,
      { method: "POST", headers: { ...headers(), "content-type": "application/octet-stream" }, body, duplex: "half" });
    return { status: answer.status, body: await answer.json().catch(() => ({})) };
  };
  const fileOf = (sessionId) => app.store.messages(sessionId).find((one) => one.role === "user").attachments[0];
  const open = (sessionId, id, token) => get(`/api/attachments/file?session=${sessionId}&id=${id}`, token);
  return { app, root, server, post, get, upload, fileOf, open };
}
/** Sends one message with a picture as whoever is at the window, and answers the conversation and its file. */
async function sendPicture(f, words) {
  const run = await f.post("/api/run", { prompt: words, attachments: [picture] });
  assert.equal(run.status, 200, JSON.stringify(run.body));
  return { sessionId: run.body.sessionId, id: f.fileOf(run.body.sessionId).id };
}

/* ---------- household reopen ---------- */

test("a household person opens their own attached file, and never the owner's or another person's", async (t) => {
  const f = await branch(t);
  const owners = await sendPicture(f, "the owner's picture");
  const sam = f.app.store.profiles.create({ name: "Sam", pin: "1234" });
  const alex = f.app.store.profiles.create({ name: "Alex", pin: "5678" });
  f.app.store.profiles.switch({ profileId: alex.id, pin: "5678" });
  const alexs = await sendPicture(f, "Alex's picture");
  f.app.store.profiles.switch({ profileId: sam.id, pin: "1234" });
  const sams = await sendPicture(f, "Sam's picture");

  const own = await f.open(sams.sessionId, sams.id);
  assert.equal(own.status, 200, "Sam reopens his own file");
  assert.ok(Buffer.from(await own.arrayBuffer()).equals(png));
  for (const [what, session, id] of [
    ["the owner's file", owners.sessionId, owners.id],
    ["Alex's file", alexs.sessionId, alexs.id],
    ["the owner's file named under Sam's own conversation", sams.sessionId, owners.id],
    ["Sam's file named under the owner's conversation", owners.sessionId, sams.id],
  ]) {
    const refused = await f.open(session, id);
    assert.equal(refused.status, 404, `${what} is refused, the same way as a file that is not there`);
  }

  f.app.store.profiles.switch({ profileId: null });
  assert.equal((await f.open(owners.sessionId, owners.id)).status, 200, "the owner still opens their own");
});

test("a person's own key and a short-lived key still never open an attached file", async (t) => {
  const f = await branch(t);
  const sam = f.app.store.profiles.create({ name: "Sam", pin: "1234" });
  f.app.store.profiles.switch({ profileId: sam.id, pin: "1234" });
  const sams = await sendPicture(f, "Sam's picture");
  f.app.store.profiles.switch({ profileId: null });
  assert.equal((await f.post("/api/people/settings", { mode: "on" })).status, 200);
  const samsKey = f.app.people.keys.issue(sam.id, 60, "pin", "test").key;
  const shortLived = f.app.sessionTokens.create(f.app.runtime.owner, { name: "script", scope: "run", minutes: 5 }).token;
  for (const [who, key] of [["Sam's own key", samsKey], ["a short-lived key", shortLived]]) {
    const answer = await f.open(sams.sessionId, sams.id, key);
    assert.ok(answer.status >= 400 && answer.status < 500, `${who}: ${answer.status}`);
  }
});

/* ---------- file-only messages ---------- */

test("a message may be only files; with neither words nor files it is still refused", async (t) => {
  const seen = [];
  const f = await branch(t, { name: "scripted", async complete(request) { seen.push(request.messages); return { content: "Looked.", toolCalls: [] }; } });
  const staged = await f.upload("notes.md", "text/markdown", Buffer.from("# The roof was fixed on Tuesday\n"));
  assert.equal(staged.status, 200, JSON.stringify(staged.body));
  const run = await f.post("/api/run", { prompt: "", uploads: [staged.body.upload] });
  assert.equal(run.status, 200, JSON.stringify(run.body));
  const said = f.app.store.messages(run.body.sessionId).find((one) => one.role === "user");
  assert.equal(said.attachments.length, 1, "the file went with it");
  assert.equal(said.content, said.content.trim(), "no blank lines stand in for the missing words");
  assert.match(JSON.stringify(seen.at(-1)), /roof was fixed/, "and the model was given what the file says");
  for (const empty of [{ prompt: "" }, { prompt: "   " }, { prompt: "", uploads: [] }]) {
    const refused = await f.post("/api/run", empty);
    assert.equal(refused.status, 400, `${JSON.stringify(empty)} is refused`);
  }
});

/* ---------- big duplicates ---------- */

test("Duplicate copies a file over 64 MB, and the engine keeps answering while it copies", async (t) => {
  let release;
  const held = new Promise((done) => { release = done; });
  let copies = 0;
  const f = await branch(t);
  const copy = f.app.attachments.copier;
  f.app.attachments.copier = async (from, to) => { copies++; await held; return copy(from, to); };
  const big = Buffer.alloc(65 * 1024 * 1024 + 7, 3);
  const staged = await f.upload("film.bin", "application/octet-stream", big);
  assert.equal(staged.status, 200, JSON.stringify(staged.body));
  const run = await f.post("/api/run", { prompt: "keep this", uploads: [staged.body.upload] });
  assert.equal(run.status, 200, JSON.stringify(run.body));
  const duplicating = f.post(`/api/sessions/${run.body.sessionId}/duplicate`, {});
  for (let i = 0; i < 200 && !copies; i++) await new Promise((done) => setImmediate(done));
  assert.equal(copies, 1, "the copy started");
  assert.equal((await f.get("/api/state")).status, 200, "the engine answers while the copy is held");
  release();
  const copied = await duplicating;
  assert.equal(copied.status, 200, JSON.stringify(copied.body));
  const ref = f.fileOf(copied.body.sessionId);
  assert.notEqual(ref.id, f.fileOf(run.body.sessionId).id, "the copy has its own name for it");
  const answer = await f.open(copied.body.sessionId, ref.id);
  assert.equal(answer.status, 200);
  assert.equal(Buffer.from(await answer.arrayBuffer()).length, big.length, "every byte was copied");
});

test("Duplicate refuses a copy that would eat into the disk's reserve, and leaves nothing behind", async (t) => {
  const f = await branch(t);
  const staged = await f.upload("film.bin", "application/octet-stream", Buffer.alloc(4096, 5));
  const run = await f.post("/api/run", { prompt: "keep this", uploads: [staged.body.upload] });
  assert.equal(run.status, 200, JSON.stringify(run.body));
  // The disk now has a little over the reserve free: the 4 KB copy would eat into it.
  f.app.attachments.disk.free = async () => 1024 ** 3 + 1024;
  const kept = join(f.root, "data", "attachments");
  const folders = await readdir(kept);
  const refused = await f.post(`/api/sessions/${run.body.sessionId}/duplicate`, {});
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /does not fit: Branch keeps 1 GB of this computer's disk free/);
  assert.deepEqual(await readdir(kept), folders, "no folder for a copy that was not made");
  assert.equal((await (await f.get("/api/sessions?limit=50")).json()).sessions.length, 1, "and no conversation");
});
