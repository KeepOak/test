/**
 * Attachment follow-ups (#479), through the window's own routes:
 * - A household person at the window opens the files they attached to their own conversations, and never the owner's,
 *   another person's, or a file of another conversation named under their own conversation's id.
 * - A message may be only files, with no words; with no words and no files it is still refused.
 * - Duplicating a conversation copies files of any size, off the engine thread, and keeps the disk's reserve free.
 * - What a PDF, a Word document and a text file say reaches the model's own request, through a real connection's
 *   adapter (OpenAI-shaped, and Branch's own Ollama connection), on the turn they came with and on the turns after it
 *   (the evals' attach-file task).
 * Mutations, each turns a test here red:
 * - src/attachments.ts attachmentForWindow: let anybody through (drop the ownsConversation check): Sam opens the owner's.
 * - src/household-routes.ts: drop the /api/attachments/file read: Sam cannot open his own file.
 * - src/contracts.ts RunInputSchema: accept no words without files: the empty message is taken.
 * - src/session-library.ts duplicate: copy with copyFileSync inside the transaction: the engine stops answering while a
 *   copy is held.
 * - src/session-library.ts duplicate: drop the reserve check: a copy that would eat into it is made.
 * - src/runtime.ts: drop `this.store.saveRead(...)`, or src/store.ts: stop adding the reads to the model's messages: the
 *   words of the files are missing from the model's request.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { providerFromEnv } from "../dist/providers.js";
import { OllamaProvider } from "../dist/providers/ollama.js";

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
  let copies = 0, started;
  const copyStarted = new Promise((done) => { started = done; });
  const f = await branch(t);
  const copy = f.app.attachments.copier;
  f.app.attachments.copier = async (from, to) => { copies++; started(); await held; return copy(from, to); };
  const big = Buffer.alloc(65 * 1024 * 1024 + 7, 3);
  const staged = await f.upload("film.bin", "application/octet-stream", big);
  assert.equal(staged.status, 200, JSON.stringify(staged.body));
  const run = await f.post("/api/run", { prompt: "keep this", uploads: [staged.body.upload] });
  assert.equal(run.status, 200, JSON.stringify(run.body));
  const duplicating = f.post(`/api/sessions/${run.body.sessionId}/duplicate`, {});
  // The copy starts once the request has been read and the file looked at, however long that takes; a duplicate that
  // answers without copying fails here at once, with what it said.
  await Promise.race([copyStarted, duplicating.then((answer) => { throw new Error(`answered before any copy: ${answer.status} ${JSON.stringify(answer.body)}`); })]);
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

/* ---------- what a document says reaches the model ---------- */

function zip(entries) {
  const locals = [], central = [];
  let offset = 0;
  for (const [name, text] of entries) {
    const raw = Buffer.from(text, "utf8"), body = deflateRawSync(raw), nameBytes = Buffer.from(name, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(body.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, body);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0); entry.writeUInt16LE(20, 6); entry.writeUInt16LE(8, 10);
    entry.writeUInt32LE(body.length, 20); entry.writeUInt32LE(raw.length, 24); entry.writeUInt16LE(nameBytes.length, 28); entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBytes);
    offset += local.length + nameBytes.length + body.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
const docx = (words) => zip([
  ["[Content_Types].xml", `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`],
  ["word/document.xml", `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${words}</w:t></w:r></w:p></w:body></w:document>`],
]);
function pdf(words) {
  const content = `BT /F1 12 Tf 72 712 Td (${words}) Tj ET`;
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  let body = "%PDF-1.4\n";
  const offsets = objects.map((object, at) => { const here = body.length; body += `${at + 1} 0 obj\n${object}\nendobj\n`; return here; });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}
/** A model service on this computer, OpenAI-shaped, that keeps every request it is sent and answers each in a few words. */
async function modelService(t) {
  const requests = [];
  const service = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => { raw += chunk; });
    request.on("end", () => {
      let body = {};
      try { body = JSON.parse(raw); } catch { /* not a request with a body */ }
      if (Array.isArray(body.messages)) requests.push(body);
      const say = (delta, finish) => `data: ${JSON.stringify({ id: "r", object: "chat.completion.chunk", created: 0, model: "stand-in", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      if (body.stream) {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(say({ role: "assistant", content: "Answered." }, null) + say({}, "stop") + "data: [DONE]\n\n");
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: "r", object: "chat.completion", created: 0, model: "stand-in",
        choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "Answered." } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    });
  });
  await new Promise((done) => service.listen(0, "127.0.0.1", done));
  t.after(() => new Promise((done) => service.close(done)));
  const provider = providerFromEnv({ BRANCH_PROVIDER: "openai", BRANCH_ENDPOINT: `http://127.0.0.1:${service.address().port}/v1`, BRANCH_MODEL: "stand-in", BRANCH_API_KEY: "stand-in" });
  return { requests, provider };
}
const userWords = (request) => JSON.stringify(request.messages.filter((one) => one.role === "user"));

test("what a PDF, a Word document and a text file say reaches the model's own request, now and on the next turn", async (t) => {
  const service = await modelService(t);
  const f = await branch(t, service.provider);
  const inPdf = await f.upload("figures.pdf", "application/pdf", pdf("The vault code is PELICAN7731"));
  const inDocx = await f.upload("plan.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", docx("The ferry leaves at HARBOR0942"));
  assert.equal(inPdf.status, 200, JSON.stringify(inPdf.body));
  assert.equal(inDocx.status, 200, JSON.stringify(inDocx.body));
  // The evals' attach-file task, as it sends one: a text file inside the message.
  const willow = { name: "willow.txt", mediaType: "text/plain", data: Buffer.from("Project Willow: the launch code word is TANGERINE.").toString("base64") };
  const run = await f.post("/api/run", { prompt: "What is the vault code, when does the ferry leave, and what is the launch code word?",
    uploads: [inPdf.body.upload, inDocx.body.upload], attachments: [willow] });
  assert.equal(run.status, 200, JSON.stringify(run.body));
  assert.equal(run.body.status, "completed", run.body.output);
  const first = userWords(service.requests.at(-1));
  for (const words of ["PELICAN7731", "HARBOR0942", "TANGERINE"]) assert.ok(first.includes(words), `${words} is in the model's request`);
  const next = await f.post("/api/run", { prompt: "Say the vault code again.", sessionId: run.body.sessionId });
  assert.equal(next.status, 200, JSON.stringify(next.body));
  const later = userWords(service.requests.at(-1));
  for (const words of ["PELICAN7731", "HARBOR0942", "TANGERINE"]) assert.ok(later.includes(words), `${words} is still in the model's request on the next turn`);
  const kept = JSON.stringify(f.app.store.messages(run.body.sessionId));
  assert.equal(kept.includes("PELICAN7731"), false, "the words read out of a file are for the model only, never in the message itself");
});

test("the same words reach a model running in Ollama on this computer, through Branch's own Ollama connection", async (t) => {
  // The evals' attach-file task runs on Ollama. Its own request (POST /api/chat) is kept here instead of sent.
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url: String(url), body: JSON.parse(String(init.body)) });
    const line = JSON.stringify({ message: { role: "assistant", content: "Answered." }, done: true, prompt_eval_count: 1, eval_count: 1 });
    return new Response(`${line}\n`, { status: 200, headers: { "content-type": "application/x-ndjson" } });
  };
  const provider = new OllamaProvider({ endpoint: "http://127.0.0.1:11434/v1", model: "qwen2.5:7b", fetchImpl });
  const f = await branch(t, provider);
  const inPdf = await f.upload("figures.pdf", "application/pdf", pdf("The vault code is PELICAN7731"));
  const inDocx = await f.upload("plan.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", docx("The ferry leaves at HARBOR0942"));
  const run = await f.post("/api/run", { prompt: "What is the vault code and when does the ferry leave?", uploads: [inPdf.body.upload, inDocx.body.upload] });
  assert.equal(run.status, 200, JSON.stringify(run.body));
  assert.equal(run.body.status, "completed", run.body.output);
  const sent = requests.filter((one) => one.url.endsWith("/api/chat")).at(-1);
  assert.ok(sent, "control: Branch asked the model through Ollama's own route");
  const words = JSON.stringify(sent.body.messages.filter((one) => one.role === "user"));
  for (const expected of ["PELICAN7731", "HARBOR0942"]) assert.ok(words.includes(expected), `${expected} is in the request Ollama was sent`);
});
