import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createBranch } from "../dist/index.js";
import { askSpreadsheet } from "../dist/data-ask.js";
import { discardTemp } from "./temp-dir.mjs";

const csv = "category,amount\nA,6\nB,10\n";
const provider = { name: "scripted", async complete() { return { content: "Read the file.", toolCalls: [] }; } };
async function fixture(t) {
  const parent = join(tmpdir(), "Codex-session-files");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "csv-library-"));
  const options = { workspace: join(root, "workspace"), dataDir: join(root, "data"), provider };
  let app = await createBranch(options);
  t.after(async () => { await app.close(); await discardTemp(root); });
  return { get app() { return app; }, async restart() { await app.close(); app = await createBranch(options); } };
}
const ask = (app, doc, sql = "SELECT SUM(amount) AS total FROM sample") => askSpreadsheet({
  documents: app.documents.list("local"), tables: app.dataTables,
  uploadedBytes: (id) => app.documents.uploadedBytes("local", id),
}, { document: doc.id, sql });

test("attached CSV enters Library and its original cells remain queryable after restart", async (t) => {
  const f = await fixture(t);
  await f.app.runtime.run({ prompt: "Read this CSV.", attachments: [{ name: "sample.csv", mediaType: "text/csv", data: Buffer.from(csv).toString("base64") }], permissions: [] });
  const docs = f.app.documents.list("local");
  assert.equal(docs.length, 1);
  assert.equal(docs[0].uploaded, true);
  assert.deepEqual((await ask(f.app, docs[0])).rows, [[16]]);
  assert.equal(f.app.documents.uploadedBytes("someone-else", docs[0].id), null);
  await f.restart();
  assert.deepEqual((await ask(f.app, docs[0], "SELECT * FROM sample")).rows, [["A", 6], ["B", 10]]);
  await assert.rejects(ask(f.app, docs[0], "DELETE FROM sample"), /Only questions/);
  f.app.documents.remove("local", docs[0].id);
  assert.equal(f.app.documents.uploadedBytes("local", docs[0].id), null);
});

test("temporary conversations never put their attachments in lasting Library", async (t) => {
  const f = await fixture(t);
  let filed = 0;
  const original = f.app.runtime.attachmentsFiled;
  f.app.runtime.attachmentsFiled = async (...args) => { filed++; return original(...args); };
  await f.app.runtime.run({ prompt: "Read privately.", temporary: true,
    attachments: [{ name: "sample.csv", mediaType: "text/csv", data: Buffer.from(csv).toString("base64") }], permissions: [] });
  assert.deepEqual(f.app.documents.list("local"), []);
  assert.equal(filed, 0, "temporary bytes never reach the lasting import callback");
});

test("a reply never waits on the embeddings service, and attaching the same file again keeps one entry", async (t) => {
  const f = await fixture(t);
  let asked = 0;
  // An embeddings service that never answers: the file must still be listed and the reply must still come.
  f.app.documents.client = () => ({ embed: () => { asked++; return new Promise(() => {}); } });
  const attachments = [{ name: "sample.csv", mediaType: "text/csv", data: Buffer.from(csv).toString("base64") }];
  const first = await f.app.runtime.run({ prompt: "Read this CSV.", attachments, permissions: [] });
  assert.equal(first.status, "completed");
  assert.equal(asked, 1, "meaning comparison was started, in the background");
  await f.app.runtime.run({ prompt: "And again.", sessionId: first.sessionId, attachments, permissions: [] });
  const docs = f.app.documents.list("local");
  assert.equal(docs.length, 1, "the identical file is not listed twice");
  assert.deepEqual((await ask(f.app, docs[0])).rows, [[16]]);
  const changed = [{ name: "sample.csv", mediaType: "text/csv", data: Buffer.from(`${csv}C,1\n`).toString("base64") }];
  await f.app.runtime.run({ prompt: "Updated.", sessionId: first.sessionId, attachments: changed, permissions: [] });
  assert.equal(f.app.documents.list("local").length, 2, "a changed file with the same name is its own entry");
});

test("a file that came with a task started from outside never enters lasting Library", async (t) => {
  const f = await fixture(t);
  const attachments = [{ name: "sample.csv", mediaType: "text/csv", data: Buffer.from(csv).toString("base64") }];
  for (const source of ["a2a", "mcp", "trigger", "schedule", "channel"])
    await f.app.runtime.run({ prompt: `From ${source}.`, source, attachments, permissions: [] });
  assert.deepEqual(f.app.documents.list("local"), [], "only the owner's own conversation files into Library");
  await f.app.runtime.run({ prompt: "Mine.", attachments, permissions: [] });
  assert.equal(f.app.documents.list("local").length, 1);
});
