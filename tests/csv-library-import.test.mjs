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
  await f.app.runtime.run({ prompt: "Read privately.", temporary: true,
    attachments: [{ name: "sample.csv", mediaType: "text/csv", data: Buffer.from(csv).toString("base64") }], permissions: [] });
  assert.deepEqual(f.app.documents.list("local"), []);
});
