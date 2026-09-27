import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir } from "node:fs/promises";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { inflateRawSync } from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { parseBackupArchive } from "../dist/backup.js";
import { writeUpdateBackup } from "../dist/install/update-backup.js";
import { discardTemp } from "./temp-dir.mjs";

const original = Buffer.from('\ufeffcategory,amount\r\n"A,one",6\r\nB,10\r\n');
const provider = { name: "fixture", async complete() { return { content: "Read.", toolCalls: [] }; } };
async function fixture(t) {
  const parent = join(tmpdir(), "Codex-session-files");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "library-lifecycle-"));
  const dataDir = join(root, "data");
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir, provider });
  const server = await startServer(app, { dataDir, port: 0 });
  t.after(async () => { app.store.profiles.switch({ profileId: null }); await server.close(); await app.close(); await discardTemp(root); });
  const call = async (method, path, body, key = server.token) => {
    const r = await fetch(server.url + path, { method, headers: { authorization: `Bearer ${key}`, origin: server.url,
      ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const bytes = Buffer.from(await r.arrayBuffer());
    let json = {}; try { json = JSON.parse(bytes); } catch {}
    return { status: r.status, body: json, bytes };
  };
  const added = await call("POST", "/api/documents", { name: "direct.csv", content: original.toString("base64") });
  assert.equal(added.status, 200, JSON.stringify(added.body));
  const direct = added.body;
  const addAttached = async () => {
    await app.runtime.run({ prompt: "Read the CSV.", attachments: [{ name: "attached.csv", mediaType: "text/csv", data: original.toString("base64") }], permissions: [] });
    return app.documents.list("local").find((d) => d.name === "attached.csv");
  };
  return { app, call, root, dataDir, direct, addAttached };
}
function unzip(buffer) {
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  let at = buffer.readUInt32LE(end + 16);
  const files = new Map();
  for (let i = 0; i < buffer.readUInt16LE(end + 10); i++) {
    const size = buffer.readUInt32LE(at + 20), length = buffer.readUInt16LE(at + 28), local = buffer.readUInt32LE(at + 42);
    const name = buffer.subarray(at + 46, at + 46 + length).toString();
    const begin = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    files.set(name, inflateRawSync(buffer.subarray(begin, begin + size)));
    at += 46 + length + buffer.readUInt16LE(at + 30) + buffer.readUInt16LE(at + 32);
  }
  return files;
}
async function exported(call) {
  let job = (await call("POST", "/api/your-data/export", {})).body;
  for (let i = 0; i < 200 && !job.ready && !job.error; i++) {
    await new Promise((go) => setTimeout(go, 20)); job = (await call("GET", `/api/your-data/export/${job.id}`)).body;
  }
  assert.equal(job.ready, true, JSON.stringify(job));
  return unzip((await call("GET", `/api/your-data/export/${job.id}/file`)).bytes);
}
async function deleted(call) {
  const answer = await call("POST", "/api/your-data/delete", { confirm: "delete everything" });
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  for (let i = 0; i < 200; i++) {
    const state = (await call("GET", "/api/your-data")).body;
    if (state.delete?.id === answer.body.journal && !state.delete.working) { assert.deepEqual(state.delete.waiting, []); return; }
    await new Promise((go) => setTimeout(go, 20));
  }
  assert.fail("delete did not finish");
}

test("full export includes exact direct and attached Library originals, scoped to the person", async (t) => {
  const { app, call, direct, addAttached } = await fixture(t);
  const attached = await addAttached();
  const sam = app.store.profiles.create({ name: "Sam", pin: "2468" }), scope = `profile:${sam.id}`;
  const other = await app.documents.add(scope, { name: "household.csv", content: Buffer.from("secret_household,2\n").toString("base64") });
  await app.store.secrets.put("local", "default", "TEST_TOKEN", "fixture-api-secret-no-export", { expiresInDays: 0 });
  const files = await exported(call);
  for (const doc of [direct, attached]) assert.deepEqual(files.get(`library/${doc.id}/original/${doc.name}`), original);
  assert.equal(files.has(`library/${other.id}/original/household.csv`), false);
  assert.ok(!Buffer.concat([...files.values()]).includes(Buffer.from("fixture-api-secret-no-export")));
  app.store.profiles.switch({ profileId: sam.id, pin: "2468" });
  const household = await exported(call);
  assert.equal(household.has(`library/${direct.id}/original/direct.csv`), false);
  assert.ok(household.has(`library/${other.id}/original/household.csv`));
});

test("backup JSON roundtrip restores exact original cells and searchable passages, without app credentials", async (t) => {
  const source = await fixture(t), attached = await source.addAttached();
  const withText = await source.app.documents.add("local", { name: "pasted-and-original.csv", text: "Separately pasted words.", content: original.toString("base64") });
  const vector = Buffer.from(new Float32Array([0.5, -0.25, 1]).buffer);
  source.app.store.sqlite.prepare("UPDATE document_chunks SET embedding=? WHERE document_id=?").run(vector, source.direct.id);
  await source.app.store.secrets.put("local", "default", "TEST_TOKEN", "fixture-api-secret-no-export", { expiresInDays: 0 });
  const answer = await source.call("GET", "/api/backup");
  assert.equal(answer.status, 200);
  const archive = answer.body.archive ?? answer.body;
  assert.equal(archive.tables.document_uploads.length, 3);
  assert.ok(!JSON.stringify(archive).includes("fixture-api-secret-no-export"));
  const target = await fixture(t); target.app.documents.remove("local", target.direct.id);
  const restored = await target.call("POST", "/api/restore", archive);
  assert.equal(restored.status, 200, JSON.stringify(restored.body));
  assert.deepEqual(target.app.documents.uploadedBytes("local", withText.id), original);
  for (const doc of [source.direct, attached]) {
    assert.deepEqual(target.app.documents.uploadedBytes("local", doc.id), original);
    const query = await target.call("POST", "/api/data/ask", { document: doc.id, sql: `SELECT SUM(amount) AS total FROM ${doc.name.replace(".csv", "")}` });
    assert.deepEqual(query.body.rows, [[16]]);
  }
  assert.ok((await target.app.documents.search("local", { query: "one" })).length > 0);
  const savedVector = target.app.store.sqlite.prepare("SELECT embedding FROM document_chunks WHERE document_id=?").get(source.direct.id);
  assert.deepEqual(Buffer.from(savedVector.embedding), vector);
  const changed = structuredClone(archive); changed.tables.document_uploads[0].owner = "someone-else";
  assert.throws(() => parseBackupArchive(changed), /owner|document/i);
  const corrupt = structuredClone(archive); corrupt.tables.document_uploads[0].bytes = "!!!!";
  assert.throws(() => parseBackupArchive(corrupt), /base64|bytes|original/i);
});

test("full delete removes Library originals, passages and private copies while retaining another person", async (t) => {
  const { app, call, dataDir, addAttached, direct } = await fixture(t); await addAttached();
  const other = await app.documents.add("profile:kept", { name: "kept.csv", content: Buffer.from("kept,2\n").toString("base64") });
  const privateFact = "fixture-private-outside-memory-fact";
  app.store.sqlite.exec(`CREATE TABLE IF NOT EXISTS memory_proposal_receipts(owner TEXT NOT NULL,proposal_id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(owner,proposal_id));
    CREATE TABLE IF NOT EXISTS memory_outside_archive(owner TEXT NOT NULL,id TEXT NOT NULL,destination TEXT NOT NULL,record TEXT NOT NULL,note TEXT NOT NULL,status TEXT NOT NULL,PRIMARY KEY(owner,id));`);
  for (const owner of ["local", "profile:kept"]) {
    app.store.sqlite.prepare("INSERT INTO memory_proposal_receipts VALUES(?,?,?)").run(owner, "fixture", owner === "local" ? privateFact : "kept");
    app.store.sqlite.prepare("INSERT INTO memory_outside_archive VALUES(?,?,?,?,?,?)").run(owner, "fixture", "fixture", owner === "local" ? privateFact : "kept", "", "held");
  }
  assert.equal(app.store.backup(app.version).tables.memory_proposal_receipts, undefined);
  assert.equal(app.store.backup(app.version).tables.memory_outside_archive, undefined);
  await writeUpdateBackup(dataDir, app.store.backup(app.version), app.version);
  const copies = join(dataDir, "update-backups"), dbCopy = join(copies, "before-format-7.sqlite");
  app.store.sqlite.exec(`VACUUM INTO '${dbCopy.replace(/'/g, "''")}'`);
  await deleted(call);
  for (const table of ["documents", "document_uploads", "document_chunks"])
    assert.equal(app.store.sqlite.prepare(`SELECT count(*) AS n FROM ${table} WHERE owner=?`).get("local").n, 0, table);
  for (const table of ["memory_proposal_receipts", "memory_outside_archive"]) {
    assert.equal(app.store.sqlite.prepare(`SELECT count(*) AS n FROM ${table} WHERE owner=?`).get("local").n, 0, table);
    assert.equal(app.store.sqlite.prepare(`SELECT count(*) AS n FROM ${table} WHERE owner=?`).get("profile:kept").n, 1, table);
  }
  assert.equal(app.documents.uploadedBytes("local", direct.id), null);
  assert.ok(app.documents.uploadedBytes("profile:kept", other.id));
  const copy = new DatabaseSync(dbCopy);
  try { assert.equal(copy.prepare("SELECT count(*) AS n FROM document_uploads WHERE owner=?").get("local").n, 0); }
  finally { copy.close(); }
  for (const file of readdirSync(copies).filter((name) => name.endsWith(".json"))) {
    const archive = JSON.parse(readFileSync(join(copies, file), "utf8"));
    for (const table of ["documents", "document_uploads", "document_chunks"])
      assert.ok(!(archive.tables[table] ?? []).some((row) => row.owner === "local"));
  }
  assert.ok(!readFileSync(dbCopy).includes(original));
  assert.ok(!readFileSync(dbCopy).includes(Buffer.from(privateFact)), "private memory review archives leave safety copies");
  assert.ok(!readFileSync(dbCopy).includes(Buffer.from("A,one")), "private extracted text leaves safety copies too");
  assert.ok(!readFileSync(join(dataDir, "branch.sqlite")).includes(Buffer.from("A,one")), "private bytes leave the live database");
  assert.ok(!readFileSync(join(dataDir, "branch.sqlite")).includes(Buffer.from(privateFact)), "private memory review archives leave the live database");
  const session = app.store.sqlite.prepare("SELECT count(*) AS n FROM sessions WHERE owner=?").get("local");
  assert.equal(session.n, 0);
});

test("old backups stay readable; a Library-only install cannot be silently replaced", async (t) => {
  const { app, call } = await fixture(t), archive = app.store.backup(app.version);
  for (const table of ["documents", "document_chunks", "document_uploads"]) delete archive.tables[table];
  assert.equal(parseBackupArchive(archive).version, 1);
  const held = await call("POST", "/api/restore", archive);
  assert.ok(held.status >= 400);
  assert.equal(app.documents.list("local").length, 1);
});

test("new original lifecycle endpoints retain short-key and Lockdown restrictions", async (t) => {
  const { app, call, direct } = await fixture(t);
  for (const scope of ["read", "run"]) {
    const key = app.sessionTokens.create("local", { name: "fixture", scope, minutes: 5 }).token;
    for (const [method, path, body] of [["GET", "/api/backup"], ["POST", "/api/documents", { name: "x.csv", content: original.toString("base64") }],
      ["POST", "/api/data/ask", { document: direct.id, sql: "SELECT * FROM direct" }], ["POST", "/api/your-data/export", {}],
      ["POST", "/api/your-data/delete", { confirm: "delete everything" }]])
      assert.equal((await call(method, path, body, key)).status, 401, `${scope}: ${path}`);
  }
  app.store.save("settings", "local", "lockdown", { on: true });
  assert.equal((await call("POST", "/api/your-data/delete", { confirm: "delete everything" })).status, 409);
  assert.deepEqual(app.documents.uploadedBytes("local", direct.id), original);
  const refused = await call("POST", "/api/data/ask", { document: direct.id, sql: "DELETE FROM direct" });
  assert.ok(refused.status >= 400);
  assert.deepEqual(app.documents.uploadedBytes("local", direct.id), original);
});
