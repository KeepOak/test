/* A document sent to the Library (POST /api/documents) is kept only if the owner is still at an unlocked window when it
   is about to be kept: checked again after its body arrives and again after its words are read, before anything is
   written. Branch locking, or the window switching to a household person, while the request is on its way leaves the
   Library as it was.
   Mutations: drop the check after the body -> the first two cases fail; drop the check after the words are read (in
   src/documents.ts add) -> the third case fails. */
import test from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

const note = { name: "Kettle notes.md", text: "The blue kettle holds 1.7 litres." };

async function fixture(t) {
  const scratch = join(tmpdir(), "Codex-session-files"); await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "branch-documents-lock-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { app.store.profiles.switch({ profileId: null }); await server.close(); await app.close(); await discardTemp(root); });
  const kept = () => ({
    documents: Number(app.store.sqlite.prepare("SELECT COUNT(*) AS n FROM documents").get().n),
    uploads: Number(app.store.sqlite.prepare("SELECT COUNT(*) AS n FROM document_uploads").get().n),
  });
  return { app, server, kept };
}
/** Sends the headers, lets `meanwhile` run while the body is still on its way, then sends the body. */
function post(server, body, meanwhile) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(new URL("/api/documents", server.url), { method: "POST",
      headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" } }, (res) => {
      let text = ""; res.setEncoding("utf8"); res.on("data", (c) => { text += c; }); res.on("end", () => resolve({ status: res.statusCode, text }));
    });
    req.on("error", reject);
    req.flushHeaders();
    setTimeout(() => { meanwhile(); req.end(JSON.stringify(body)); }, 50);
  });
}

test("with the owner at an unlocked window the document is kept, with the owner as who added it", async (t) => {
  const { server, kept } = await fixture(t);
  const made = await post(server, note, () => {});
  assert.equal(made.status, 200, made.text);
  assert.equal(JSON.parse(made.text).addedBy?.role, "owner");
  assert.deepEqual(kept(), { documents: 1, uploads: 0 });
});

test("Branch locking while the document is still arriving refuses it and keeps nothing", async (t) => {
  const { app, server, kept } = await fixture(t);
  const locked = await post(server, note, () => app.sessionLock.lock());
  assert.equal(locked.status, 423, locked.text);
  assert.deepEqual(kept(), { documents: 0, uploads: 0 });
});

test("the window switching to a household person while the document is arriving refuses it and keeps nothing", async (t) => {
  const { app, server, kept } = await fixture(t);
  const sam = app.store.profiles.create({ name: "Sam", pin: "2468" });
  const switched = await post(server, note, () => app.store.profiles.switch({ profileId: sam.id, pin: "2468" }));
  assert.notEqual(switched.status, 200, switched.text);
  assert.match(switched.text, /belongs to the owner/);
  assert.deepEqual(kept(), { documents: 0, uploads: 0 });
});

test("Branch locking while an uploaded file's words are read keeps neither the document nor its file", async (t) => {
  const { app, server, kept } = await fixture(t);
  const read = app.documents.sourceOf.bind(app.documents);
  let reached, release;
  const atRead = new Promise((resolve) => { reached = resolve; }), held = new Promise((resolve) => { release = resolve; });
  app.documents.sourceOf = async (value) => { reached(); await held; return read(value); };
  const upload = { name: "kettle.txt", content: Buffer.from("The blue kettle holds 1.7 litres.").toString("base64") };
  const sent = post(server, upload, () => {});
  await atRead;
  app.sessionLock.lock();
  release();
  const locked = await sent;
  assert.equal(locked.status, 423, locked.text);
  assert.deepEqual(kept(), { documents: 0, uploads: 0 });
});
