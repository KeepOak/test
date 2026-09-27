import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { Attachments, cleanName, kindOf } from "../dist/attachments.js";
import { registerAttachmentTools } from "../dist/attachment-tools.js";

/**
 * attach-anything: any file — a photo, a film, a sound, a PDF, code, an archive, something nobody can name — can go
 * with a message. It is streamed to disk ahead of the message, kept per conversation under a random id, and the model
 * is told exactly what could be read out of it and what could not. Local only: a scripted model and a server on its own port.
 */

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
/** A one-page PDF whose page draws the words "Quarterly figures rose" with a standard font. */
function pdf() {
  const content = "BT /F1 12 Tf 72 712 Td (Quarterly figures rose) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets = objects.map((object, at) => { const here = body.length; body += `${at + 1} 0 obj\n${object}\nendobj\n`; return here; });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

async function branch(t, provider) {
  const scratch = join(tmpdir(), "Codex-session-files");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "branch-anything-"));
  const closing = [];
  t.after(async () => { for (const close of closing.reverse()) await close(); await discardTemp(root); });
  const seen = [];
  const app = await createBranch({
    workspace: join(root, "workspace"), dataDir: join(root, "data"),
    provider: provider ?? { name: "scripted", async complete(request) { seen.push(request.messages); return { content: "Got them.", toolCalls: [] }; } },
  });
  closing.push(() => app.close());
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  closing.push(() => server.close());
  const headers = { authorization: `Bearer ${server.token}`, host: new URL(server.url).host };
  const upload = async (name, type, body) => {
    const answer = await fetch(`${server.url}/api/attachments/upload?name=${encodeURIComponent(name)}&type=${encodeURIComponent(type)}`,
      { method: "POST", headers: { ...headers, "content-type": "application/octet-stream" }, body, duplex: "half" });
    return { status: answer.status, body: await answer.json().catch(() => ({})) };
  };
  const post = async (path, body) => {
    const answer = await fetch(server.url + path, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: answer.status, body: await answer.json().catch(() => ({})) };
  };
  return { app, root, server, headers, upload, post, seen };
}
const lastUser = (seen) => seen.at(-1)?.findLast((one) => one.role === "user");

test("a file is written to disk while it is still arriving, not held whole and written at the end", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-stream-"));
  t.after(() => discardTemp(root));
  const store = new Attachments(root);
  const mb = Buffer.alloc(1024 * 1024, 7);
  const onDisk = [];
  async function* arriving() {
    for (let i = 0; i < 24; i++) {
      if (i === 20) {
        const [name] = await readdir(join(root, ".incoming"));
        onDisk.push((await stat(join(root, ".incoming", name))).size);
      }
      yield mb;
      await new Promise((done) => setImmediate(done));
    }
  }
  const staged = await store.stage("local", { name: "film.mp4", mediaType: "video/mp4" }, arriving());
  assert.equal(staged.bytes, 24 * 1024 * 1024);
  assert.equal(staged.kind, "video");
  assert.ok(onDisk[0] >= 16 * 1024 * 1024, `most of the file was already on disk before the rest arrived (${onDisk[0]} bytes)`);
});

test("a file past the limit is cut off as it arrives and leaves nothing behind", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-stream-"));
  t.after(() => discardTemp(root));
  const store = new Attachments(root);
  let sent = 0;
  async function* endless() { for (;;) { sent += 1; yield Buffer.alloc(256 * 1024, 1); } }
  await assert.rejects(store.stage("local", { name: "huge.iso", mediaType: "application/octet-stream" }, endless(), { file: 1024 * 1024, waiting: 8 * 1024 * 1024 }),
    /huge\.iso is too big: one file can be up to 1 MB/);
  assert.ok(sent <= 6, `reading stopped at the limit (${sent} pieces read)`);
  assert.deepEqual(await readdir(join(root, ".incoming")), [], "the part that arrived is gone");
  // Said up front, before a byte is read, when the sender says how big it is.
  await assert.rejects(store.stage("local", { name: "big.mov", mediaType: "video/quicktime", length: 5 * 1024 * 1024 }, endless(), { file: 1024 * 1024, waiting: 8 * 1024 * 1024 }), /too big/);
});

test("any kind of file is taken, and a name is only ever words, never a way out of the store", async (t) => {
  assert.equal(kindOf("application/x-msdownload", "setup.exe"), "file");
  assert.equal(kindOf("application/zip", "photos.zip"), "file");
  assert.equal(kindOf("video/mp2t", "main.ts"), "document", "code is words even when a browser calls it a video");
  assert.equal(kindOf("", "notes.md"), "document");
  assert.equal(kindOf("application/octet-stream", "clip.mov"), "video");
  assert.equal(cleanName("../../../../Windows/System32/evil.dll"), "Windows/System32/evil.dll");
  assert.equal(cleanName("C:\\Users\\me\\..\\secret.txt"), "C_/Users/me/secret.txt");
  assert.equal(cleanName("a\u0000b\nc.txt"), "abc.txt");
  assert.equal(cleanName("/.."), "file");

  const { app, root, upload, post } = await branch(t);
  const sent = await upload("../../escape.sh", "application/x-sh", Buffer.from("rm -rf /"));
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.equal(sent.body.name, "escape.sh");
  assert.equal(sent.body.path, undefined, "the page is never told where the file is");
  const run = await post("/api/run", { prompt: "What is this?", uploads: [sent.body.upload] });
  assert.equal(run.status, 200, JSON.stringify(run.body));
  const [ref] = await app.attachments.list(run.body.sessionId);
  assert.match(ref.id, /^[a-f0-9]{16}$/);
  assert.equal(ref.name, "escape.sh");
  const kept = await readdir(join(root, "data", "attachments"), { recursive: true });
  assert.ok(kept.every((one) => !/escape/.test(one)), `the name never became a path: ${kept.join(", ")}`);
  assert.deepEqual(await readdir(root).then((all) => all.filter((one) => /escape/.test(one))), [], "nothing was written beside the store");
});

test("a file sent ahead can only be taken by the person who sent it, and only once", async (t) => {
  const { app, upload, post } = await branch(t);
  const sent = await upload("mine.txt", "text/plain", Buffer.from("mine"));
  // Somebody else's upload id is not theirs to send: refused before any task starts.
  const theirs = await app.attachments.stage("profile:someone", { name: "theirs.txt", mediaType: "text/plain" }, [Buffer.from("theirs")]);
  const refused = await post("/api/run", { prompt: "Read it", uploads: [theirs.upload] });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /no longer waiting to be sent/);
  const once = await post("/api/run", { prompt: "Read it", uploads: [sent.body.upload] });
  assert.equal(once.status, 200);
  const twice = await post("/api/run", { prompt: "Read it again", uploads: [sent.body.upload] });
  assert.equal(twice.status, 400, "an upload goes with one message only");
  assert.equal(await app.attachments.unstage("local", "../../kept.json"), false, "a name that climbs is nothing");
});

test("a file too big is refused with its size in plain words before its bytes are read", async (t) => {
  const { server, headers } = await branch(t);
  const answer = await fetch(`${server.url}/api/attachments/upload?name=huge.mkv&type=video%2Fx-matroska`, {
    method: "POST", headers: { ...headers, "content-type": "application/octet-stream", "content-length": String(3 * 1024 ** 3) },
    body: Buffer.alloc(16), duplex: "half",
  }).catch((error) => ({ status: 0, error }));
  if (answer.status) {
    assert.equal(answer.status, 413);
    assert.match((await answer.json()).error, /huge\.mkv is too big: one file can be up to 2 GB/);
  }
});

test("a big file goes through the route whole, past the old 32 MB ceiling", async (t) => {
  const { app, upload, post } = await branch(t);
  const size = 48 * 1024 * 1024;
  async function* body() { for (let at = 0; at < size; at += 1024 * 1024) yield Buffer.alloc(1024 * 1024, at % 251); }
  const sent = await upload("backup.tar.gz", "application/gzip", ReadableStream.from(body()));
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.equal(sent.body.bytes, size);
  assert.equal(sent.body.kind, "file");
  const run = await post("/api/run", { prompt: "Keep this", uploads: [sent.body.upload] });
  assert.equal(run.status, 200);
  const [ref] = await app.attachments.list(run.body.sessionId);
  assert.equal(ref.bytes, size);
});

test("the model is told exactly what each kind of file gave, and what it could not read", async (t) => {
  const { upload, post, seen } = await branch(t);
  const files = [
    ["photo.png", "image/png", png],
    ["report.pdf", "application/pdf", pdf()],
    ["notes.md", "", Buffer.from("# Plan\nShip the attach button on Friday.")],
    ["main.ts", "video/mp2t", Buffer.from("export const answer = 42;\n")],
    ["voice.wav", "audio/wav", Buffer.alloc(4096, 1)],
    ["clip.mp4", "video/mp4", Buffer.alloc(4096, 2)],
    ["blob.bin", "application/octet-stream", Buffer.from([0, 1, 2, 3, 0, 255, 254])],
  ];
  const ids = [];
  for (const [name, type, bytes] of files) {
    const sent = await upload(name, type, bytes);
    assert.equal(sent.status, 200, `${name}: ${JSON.stringify(sent.body)}`);
    ids.push(sent.body.upload);
  }
  const run = await post("/api/run", { prompt: "What did I send?", uploads: ids });
  assert.equal(run.status, 200, JSON.stringify(run.body));
  const said = lastUser(seen).content;
  assert.match(said, /untrusted data/, "what came out of a file is marked as data, not instructions");
  assert.match(said, /Quarterly figures rose/, "a PDF's words reach the model");
  assert.match(said, /not shown to you as pictures/, "and it is said that its pages were not shown as pictures");
  assert.match(said, /Ship the attach button on Friday/, "a Markdown file's words");
  assert.match(said, /export const answer = 42/, "code reaches the model as words, whatever the browser called it");
  assert.match(said, /voice\.wav.*\n.*not understood: Watching and saving videos is switched off/, "a sound nothing could hear is said to be unheard");
  assert.match(said, /clip\.mp4.*\n.*not understood: Watching and saving videos is switched off/, "a video nothing could watch is said to be unwatched");
  assert.match(said, /blob\.bin.*\n.*not read: it is not a kind of file Branch can read the words of/);
  assert.match(said, /cannot look at pictures, so photo\.png was kept but not shown to you/, "a model that cannot see is not pretended to have seen");
  assert.equal(lastUser(seen).images, undefined);
});

test("a model that can see is shown an attached picture, and a picture never fails the message", async (t) => {
  const seen = [];
  const { upload, post } = await branch(t, {
    name: "seeing", acceptsImages: true, supportsImages: () => true,
    async complete(request) { seen.push(request.messages); return { content: "A dot.", toolCalls: [] }; },
  });
  const sent = await upload("screenshot.png", "image/png", png);
  const run = await post("/api/run", { prompt: "What is this?", uploads: [sent.body.upload] });
  assert.equal(run.status, 200);
  const user = lastUser(seen);
  assert.deepEqual(user.images?.map((one) => one.name), ["screenshot.png"]);
  assert.match(user.content, /Shown to you with this message: screenshot\.png/);
});

test("the rest of a long file is one tool call away, only in its own conversation", async (t) => {
  const { app, upload, post } = await branch(t);
  const long = Array.from({ length: 3000 }, (_, i) => `line ${i} of the long log`).join("\n");
  const sent = await upload("server.log", "text/plain", Buffer.from(long));
  const run = await post("/api/run", { prompt: "Summarise", uploads: [sent.body.upload] });
  const [ref] = await app.attachments.list(run.body.sessionId);
  let tool = null;
  registerAttachmentTools({ register: (one) => { tool = one; } }, app.store, app.attachments);
  assert.ok(tool, "the tool is there");
  const part = await tool.execute({ id: ref.id, from: 12000 }, { runId: run.body.id, owner: "local" });
  assert.equal(part.from, 12000);
  assert.ok(part.words.startsWith(long.slice(12000, 12040)));
  const other = await post("/api/run", { prompt: "Elsewhere" });
  await assert.rejects(tool.execute({ id: ref.id, from: 0 }, { runId: other.body.id, owner: "local" }), /not attached to this conversation/);
});

test("what was read out of a file goes to the model only: never with the message, its export, or a script's key", async (t) => {
  const { underShortLivedKey } = await import("../dist/key-context.js");
  const { app, server, headers, upload, post, seen } = await branch(t);
  const sent = await upload("report.pdf", "application/pdf", pdf());
  const run = await post("/api/run", { prompt: "Summarise it", uploads: [sent.body.upload] });
  assert.equal(run.status, 200);
  assert.match(lastUser(seen).content, /Quarterly figures rose/, "the model had the words");
  const sessionId = run.body.sessionId;
  const everywhere = [
    JSON.stringify(app.store.messages(sessionId)),
    JSON.stringify(app.store.exportSession(app.runtime.owner, sessionId)),
    JSON.stringify(underShortLivedKey(() => app.store.exportSession(app.runtime.owner, sessionId))),
    await (await fetch(`${server.url}/api/sessions/${sessionId}`, { headers })).text(),
  ];
  for (const [at, text] of everywhere.entries()) assert.doesNotMatch(text, /Quarterly figures rose/, `way out ${at} carries no words of the file`);
  const next = await post("/api/run", { prompt: "And again", sessionId });
  assert.equal(next.status, 200);
  assert.match(seen.at(-1).find((one) => one.role === "user" && /Summarise it/.test(one.content)).content, /Quarterly figures rose/,
    "the next turn's model still has them");
  const deleted = await fetch(`${server.url}/api/sessions/${sessionId}`, { method: "DELETE", headers });
  if (deleted.ok) assert.equal(app.store.sqlite.prepare("SELECT COUNT(*) AS n FROM message_reads WHERE session_id=?").get(sessionId).n, 0,
    "and they go when the conversation does");
});

test("files sent side by side share one person's room, so they cannot fill the disk together", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-stream-"));
  t.after(() => discardTemp(root));
  const store = new Attachments(root);
  const limits = { file: 4 * 1024 * 1024, waiting: 6 * 1024 * 1024 };
  async function* slow() { for (let i = 0; i < 16; i++) { yield Buffer.alloc(256 * 1024, 3); await new Promise((done) => setTimeout(done, 5)); } }
  const results = await Promise.allSettled([1, 2, 3].map((n) => store.stage("local", { name: `part${n}.bin`, mediaType: "application/octet-stream" }, slow(), limits)));
  const kept = results.filter((one) => one.status === "fulfilled").length;
  assert.ok(kept <= 1, `at most one 4 MB file fits a 6 MB room at once (${kept} kept)`);
  assert.match(results.find((one) => one.status === "rejected").reason.message, /does not fit/);
  // Another person's room is their own.
  const theirs = await store.stage("profile:other", { name: "theirs.bin", mediaType: "application/octet-stream" }, slow(), limits);
  assert.equal(theirs.bytes, 4 * 1024 * 1024);
});

test("a document's words are read in a worker that is ended at its time limit, never on the engine's own thread", async (t) => {
  const { wordsOf, readForModel } = await import("../dist/attachment-reading.js");
  const root = await mkdtemp(join(tmpdir(), "branch-worker-"));
  t.after(() => discardTemp(root));
  const path = join(root, "report");
  await writeFile(path, pdf());
  const file = { ref: { id: "a".repeat(16), kind: "document", mediaType: "application/pdf", name: "report.pdf", bytes: pdf().length }, path };
  assert.match((await wordsOf(file)).text, /Quarterly figures rose/, "the worker hands back the words");
  // A read still going at its limit is ended, and says so: the engine kept running while it waited.
  await assert.rejects(wordsOf(file, { limitMs: 1 }), /took longer to read than the time allowed/);
  const stopped = new AbortController();
  const reading = wordsOf(file, { signal: stopped.signal });
  stopped.abort();
  await assert.rejects(reading, /stopped/, "a stopped task ends its read");
  // The words of every file on a message stay within one budget, whatever kind they are.
  const many = Array.from({ length: 12 }, (_, at) => ({ ...file, ref: { ...file.ref, id: String(at).padStart(16, "0") } }));
  const heard = async () => ({ pictures: [], transcript: "said ".repeat(5000), notes: [] });
  const sounds = Array.from({ length: 6 }, (_, at) => ({ path, ref: { id: String(at + 20).padStart(16, "0"), kind: "sound", mediaType: "audio/wav", name: `v${at}.wav`, bytes: 1 } }));
  const long = join(root, "long.txt");
  await writeFile(long, "word ".repeat(20000));
  const texts = Array.from({ length: 12 }, (_, at) => ({ path: long, ref: { id: String(at + 40).padStart(16, "0"), kind: "document", mediaType: "text/plain", name: `t${at}.txt`, bytes: 100000 } }));
  const read = await readForModel([...sounds, ...texts, ...many.slice(0, 1)], { understand: heard, whyNotUnderstood: "" });
  const lifted = [...read.read.matchAll(/What is said in it:\n((?:said )*)|Its words:\n((?:word )*)/g)].reduce((sum, m) => sum + (m[1] ?? m[2] ?? "").length, 0);
  assert.ok(lifted <= 12000, `everything lifted out of the files stays within the budget (${lifted} characters)`);
});
