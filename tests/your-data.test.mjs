/**
 * privacy: Settings › Your data (src/your-data.ts). What is kept, counted for whoever is at the window; one .zip of all
 * of it, with no secret value in it; and deleting all of it, which needs the typed words, is refused under Lockdown and
 * to a short-lived key, touches only the person's own, and is written to the owner's record.
 *
 * Mutations (each applied to dist/your-data.js or dist/zip-write.js, this file run, the file put back), and the test
 * each turns red:
 *   M1 ownKinds counted under app.runtime.owner instead of the person at the window        → "counts"
 *   M2 the owner's parts (keys, logs, backup) exported for a household person too            → "export"
 *   M3 the Lockdown check in deleteEverything removed                                       → "delete"
 *   M4 deleteEverything deletes under app.runtime.owner instead of the person at the window  → "delete"
 *   M5 zipName keeps ".." in a name                                                          → "zip"
 *   M6 memory_outside_forgotten put back in memoryTables (the forgotten marks deleted)       → "outside memory: delete"
 *   M7 deleteEverything skips forgetEverythingOutside                                        → "outside memory: delete"
 *   M8 a failed listing on the outside service swallowed instead of stopping the delete     → "outside memory: refused"
 *   M9 memoryLeaves / everybodysLeaves left out of leaves()                                  → "leaves"
 *   M10 the short-lived key refusal narrowed back to POST export and delete                  → "short-lived keys"
 *   M11 the whole-app backup.json put back in the owner's export                             → "export (review)"
 *   M12 file names split on "/" only (Windows paths collapse to one name)                    → "export (review)"
 *   M13 the record exported as the newest 1,000 entries again                                → "export (review)"
 *   M14 the word index left in place when memory_terms is deleted                            → "delete (review)"
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateRawSync, crc32 } from "node:zlib";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { savePolicy } from "../dist/policy.js";
import { runForCurrentPerson } from "../dist/collab-server.js";
import { buildZip, zipName } from "../dist/zip-write.js";
import { saveTraceExportSettings } from "../dist/tracing-export.js";
import { folderFor } from "../dist/attachments.js";
import { audit } from "../dist/audit.js";
import { createServer } from "node:http";

const secretValue = "zq-secret-value-7a41c0";

/** Writes one file when asked to (so the task has a signed receipt), then answers. */
const writer = { name: "writer", async complete(request) {
  const last = request.messages.at(-1), text = String(last?.content ?? "");
  if (last?.role === "user" && /write /.test(text))
    return { content: "", toolCalls: [{ id: `w${randomUUID()}`, name: "files.write", arguments: JSON.stringify({ path: "zq-file.txt", content: "zq" }) }] };
  return { content: /zqsam/.test(JSON.stringify(request.messages)) ? "zqsam-answer" : "zqowner-answer", toolCalls: [] };
} };

function unzip(buffer) {
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buffer.readUInt16LE(end + 10);
  let at = buffer.readUInt32LE(end + 16);
  const out = {};
  for (let i = 0; i < count; i++) {
    const size = buffer.readUInt32LE(at + 20), nameLength = buffer.readUInt16LE(at + 28), local = buffer.readUInt32LE(at + 42);
    const name = buffer.subarray(at + 46, at + 46 + nameLength).toString("utf8");
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const data = inflateRawSync(buffer.subarray(start, start + size));
    assert.equal(crc32(data), buffer.readUInt32LE(at + 16), `${name}: its checksum`);
    out[name] = data.toString("utf8");
    at += 46 + nameLength + buffer.readUInt16LE(at + 30) + buffer.readUInt16LE(at + 32);
  }
  return out;
}

async function served(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-your-data-"));
  const dataDir = join(root, "data");
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir, provider: writer });
  savePolicy(app.store, app.runtime.owner, { preset: "workspace" });
  const server = await startServer(app, { dataDir, port: 0 });
  t.after(async () => { app.store.profiles.switch({ profileId: null }); await server.close(); await app.close(); await discardTemp(root); });
  const owner = app.runtime.owner;
  await app.runtime.run({ prompt: "zqowner-prompt please write the file" });
  app.store.save("memory", owner, "zqowner-fact-id", { text: "zqowner-fact", source: "owner" });
  await app.store.secrets.put(owner, "default", "ZQ_TOKEN", secretValue, { expiresInDays: 0 });
  const sam = app.store.profiles.create({ name: "Sam", pin: "2468" });
  app.runtime.roles.save(sam.id, { role: "adult" });
  const asOwner = () => app.store.profiles.switch({ profileId: null });
  const asSam = () => app.store.profiles.switch({ profileId: sam.id, pin: "2468" });
  asSam();
  await runForCurrentPerson(app, { prompt: "zqsam-prompt hello", onTextDelta: () => undefined });
  app.store.save("memory", `profile:${sam.id}`, "zqsam-fact-id", { text: "zqsam-fact", source: "sam" });
  asOwner();
  const call = async (method, path, body, key = server.token) => {
    const response = await fetch(server.url + path, {
      method, headers: { authorization: `Bearer ${key}`, origin: server.url, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const bytes = Buffer.from(await response.arrayBuffer());
    let json = {};
    try { json = JSON.parse(bytes.toString("utf8")); } catch { json = {}; }
    return { status: response.status, bytes, body: json };
  };
  return { app, server, call, asOwner, asSam };
}
const kind = (summary, name) => summary.kinds.find((k) => k.kind === name);

async function exportAll(call) {
  let job = (await call("POST", "/api/your-data/export", {})).body;
  assert.ok(job.id, JSON.stringify(job));
  const seen = new Set();
  for (let i = 0; i < 200 && !job.ready && !job.error; i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    job = (await call("GET", `/api/your-data/export/${job.id}`)).body;
    seen.add(job.done);
  }
  assert.equal(job.error, null);
  assert.equal(job.done, job.total, "the bar ends at the number of parts written");
  const file = await call("GET", `/api/your-data/export/${job.id}/file`);
  assert.equal(file.status, 200);
  return unzip(file.bytes);
}

test("counts: each person sees only their own, and only the owner sees keys, logs and the folder", async (t) => {
  const { call, asSam } = await served(t);
  const owner = (await call("GET", "/api/your-data")).body;
  assert.equal(kind(owner, "conversations").count, 1);
  assert.equal(kind(owner, "memory").count, 1);
  assert.ok(kind(owner, "receipts").count >= 1, "the file the task wrote has a signed receipt");
  assert.ok(kind(owner, "keys").count >= 1 && kind(owner, "logs"), "the owner sees keys and logs");
  assert.ok(owner.folder && !JSON.stringify(owner).includes(secretValue), "counted and named, never a value");
  asSam();
  const sam = (await call("GET", "/api/your-data")).body;
  assert.equal(kind(sam, "conversations").count, 1, "Sam's own conversation, not the owner's");
  assert.equal(kind(sam, "memory").count, 1);
  assert.equal(kind(sam, "keys"), undefined);
  assert.equal(kind(sam, "logs"), undefined);
  assert.equal(sam.folder, null);
  assert.ok(!/zqowner/.test(JSON.stringify(sam)), "nothing of the owner's reaches Sam");
});

test("export: one real .zip of the person's own things, with no secret value in it", async (t) => {
  const { call, asSam } = await served(t);
  const files = await exportAll(call);
  const all = Object.values(files).join("\n");
  assert.ok(Object.keys(files).some((n) => /^conversations\/.+\.md$/.test(n)));
  assert.match(all, /zqowner-prompt/);
  assert.match(files["memory.json"], /zqowner-fact/);
  assert.match(files["keys-and-connections.json"], /ZQ_TOKEN/, "the key's name is listed");
  assert.ok(!all.includes(secretValue), "the key's value never is");
  assert.ok(JSON.parse(files["receipts.json"]).length >= 1);
  asSam();
  const theirs = await exportAll(call);
  const text = Object.values(theirs).join("\n");
  assert.match(text, /zqsam-prompt/);
  assert.ok(!/zqowner/.test(text), "Sam's export has nothing of the owner's");
  assert.equal(theirs["keys-and-connections.json"], undefined);
  assert.equal(theirs["backup.json"], undefined);
});

test("delete: typed words, never under Lockdown or with a short-lived key, only the person's own, written down", async (t) => {
  const { app, call, asOwner, asSam } = await served(t);
  assert.equal((await call("POST", "/api/your-data/delete", { confirm: "yes" })).status, 400);
  const script = app.sessionTokens.create(app.runtime.owner, { name: "script", scope: "run", minutes: 5 }).token;
  assert.equal((await call("POST", "/api/your-data/delete", { confirm: "delete everything" }, script)).status, 401);
  assert.equal((await call("POST", "/api/lockdown", { on: true })).status, 200);
  const refused = await call("POST", "/api/your-data/delete", { confirm: "delete everything" });
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /Lockdown/);
  assert.equal((await call("POST", "/api/lockdown", { on: false })).status, 200);
  assert.equal(kind((await call("GET", "/api/your-data")).body, "conversations").count, 1, "nothing went under Lockdown");
  asSam();
  const done = await call("POST", "/api/your-data/delete", { confirm: " Delete Everything " });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.deepEqual(done.body.deleted, { conversations: 1, memory: 1 });
  const sam = (await call("GET", "/api/your-data")).body;
  assert.equal(kind(sam, "conversations").count, 0);
  assert.equal(kind(sam, "memory").count, 0);
  asOwner();
  const owner = (await call("GET", "/api/your-data")).body;
  assert.equal(kind(owner, "conversations").count, 1, "the owner's conversation stays");
  assert.equal(kind(owner, "memory").count, 1);
  const record = app.store.audit.list(app.runtime.owner, { action: "history.pruned" });
  assert.ok(record.some((entry) => /Your data: deleted 1 conversations/.test(entry.reason)), "the delete is written down");
  const again = await call("POST", "/api/your-data/delete", { confirm: "delete everything" });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(kind((await call("GET", "/api/your-data")).body, "conversations").count, 0);
});

test("zip: names stay inside the archive and every entry reads back with its checksum", () => {
  assert.equal(zipName("../../evil/../a.txt"), "evil/a.txt");
  assert.equal(zipName("C:\\x\\y.md"), "C_/x/y.md");
  const files = unzip(buildZip([{ name: "a/b.txt", data: Buffer.from("hello") }, { name: "c.json", data: Buffer.from("{}") }]));
  assert.deepEqual(files, { "a/b.txt": "hello", "c.json": "{}" });
});

/** An outside memory service on 127.0.0.1, with the contract src/memory-provider.ts expects; `refuse` answers its own way. */
async function outsideService(t) {
  const facts = new Map(); // `${owner}\n${id}` -> record
  const double = { refuse: null, facts };
  const server = createServer(async (request, response) => {
    const parts = new URL(request.url, "http://x").pathname.split("/").filter(Boolean).map(decodeURIComponent);
    const send = (status, body) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(body)); };
    const custom = double.refuse?.(request.method, parts);
    if (custom) return send(...custom);
    const [, owner, id] = parts;
    if (request.method === "GET" && parts.length === 2) return send(200, [...facts.values()].filter((record) => record.owner === owner));
    if (request.method === "DELETE" && parts.length === 3) return send(200, { deleted: facts.delete(`${owner}\n${id}`) });
    return send(404, { error: "not found" });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const now = new Date().toISOString();
  double.add = (owner, id) => facts.set(`${owner}\n${id}`, { id, owner, data: { text: id, source: "owner", sourceRunId: "" }, createdAt: now, updatedAt: now, revision: 1 });
  double.url = `http://127.0.0.1:${server.address().port}`;
  return double;
}
const marks = (app, owner) => app.store.sqlite.prepare("SELECT id FROM memory_outside_forgotten WHERE owner=? ORDER BY id").all(owner).map((row) => row.id);

test("outside memory: delete forgets every fact the service keeps, keeps the forgotten marks, and says what it could not delete", async (t) => {
  const { app, call } = await served(t);
  const owner = app.runtime.owner, service = await outsideService(t);
  app.web.policy.configure({ allowPrivateAddresses: true }); // the service lives on 127.0.0.1
  app.memory.backend.configure(owner, { mode: "outside", url: service.url });
  service.add(owner, "zq-kept-outside");
  service.add(owner, "zq-forgotten-before"); // forgotten earlier, but the service never deleted it
  service.add(owner, "zq-will-not-go");
  app.store.sqlite.prepare("INSERT INTO memory_outside_forgotten VALUES(?,?,?)").run(owner, "zq-forgotten-before", new Date().toISOString());
  service.refuse = (method, parts) => (method === "DELETE" && parts[2] === "zq-will-not-go" ? [500, { error: "no" }] : null);
  const done = await call("POST", "/api/your-data/delete", { confirm: "delete everything" });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.deepEqual(done.body.deleted, { conversations: 1, memory: 2 }, "the fact here and the one in use outside; not the one it kept");
  assert.equal(done.body.notRemoved, 1);
  assert.match(done.body.problem, /could not be deleted from the outside memory service/);
  assert.deepEqual([...service.facts.values()].map((record) => record.id), ["zq-will-not-go"], "everything else is gone from the service");
  assert.deepEqual(marks(app, owner), ["zq-forgotten-before", "zq-kept-outside", "zq-will-not-go"], "every mark stays");
  assert.deepEqual(await app.memory.backend.list(owner), [], "what the service kept is never read back");
  app.memory.backend.configure(owner, { mode: "built-in" });
  app.memory.backend.configure(owner, { mode: "outside" });
  assert.deepEqual(await app.memory.backend.list(owner), [], "not after switching away and back either");
  const record = app.store.audit.list(owner, { action: "history.pruned" });
  assert.ok(record.some((entry) => /and 2 remembered facts\. One fact could not be deleted/.test(entry.reason)), "the record says so too");
});

test("outside memory: refused when the service cannot say what it keeps, and nothing here is deleted", async (t) => {
  const { app, call } = await served(t);
  const owner = app.runtime.owner, service = await outsideService(t);
  app.web.policy.configure({ allowPrivateAddresses: true });
  app.memory.backend.configure(owner, { mode: "outside", url: service.url });
  service.add(owner, "zq-kept-outside");
  service.refuse = (method, parts) => (method === "GET" && parts.length === 2 ? [503, { error: "down" }] : null);
  const refused = await call("POST", "/api/your-data/delete", { confirm: "delete everything" });
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.match(refused.body.error, /could not be asked what it keeps, so nothing was deleted/);
  const summary = (await call("GET", "/api/your-data")).body;
  assert.equal(kind(summary, "conversations").count, 1, "the conversation stays");
  assert.equal(kind(summary, "memory").count, 1, "the fact here stays");
  assert.equal(service.facts.size, 1, "and so does the one outside");
});

test("leaves: where facts, steps and messages go is listed, and a household person is not told the owner's addresses", async (t) => {
  const { app, call, asOwner, asSam } = await served(t);
  const owner = app.runtime.owner;
  app.memory.backend.configure(owner, { mode: "outside", url: "https://memory.example" });
  app.memoryHistory.configure(owner, { mode: "on", remote: "git@git.example:me/memory.git" });
  saveTraceExportSettings(app.store, owner, { enabled: true, endpoint: "https://collector.example" });
  app.moderation.configure({ enabled: true, endpoint: "https://check.example/v1/moderations" });
  app.voice.engines.save(owner, { mode: "on", listen: "deepgram" });
  const leaving = (await call("GET", "/api/your-data")).body.leaves;
  const find = (id) => leaving.find((row) => row.id === id);
  assert.equal(find("memory:outside")?.name, "memory.example", JSON.stringify(leaving));
  assert.equal(find("memory:history")?.name, "git.example");
  assert.equal(find("traces")?.name, "collector.example");
  assert.equal(find("model:moderation")?.name, "check.example");
  assert.equal(find("voice:Deepgram")?.kind, "voice");
  asSam();
  const theirs = (await call("GET", "/api/your-data")).body.leaves;
  assert.equal(theirs.find((row) => row.id === "memory:outside"), undefined, "the owner's memory service is not where Sam's facts go");
  assert.deepEqual(theirs.filter((row) => ["traces", "model:moderation"].includes(row.id)).map((row) => [row.id, row.name, row.page]),
    [["traces", "", null], ["model:moderation", "", null]], "Sam's words go there too, without the owner's addresses");
  assert.ok(!/example/.test(JSON.stringify(theirs)), "no address of the owner's reaches Sam");
  asOwner();
  app.memory.backend.configure(owner, { mode: "outside", url: "http://127.0.0.1:9" });
  assert.equal((await call("GET", "/api/your-data")).body.leaves.find((row) => row.id === "memory:outside"), undefined, "a service on this computer keeps facts here");
});

test("short-lived keys: no short-lived key reads the summary, an export's progress or its file", async (t) => {
  const { app, call } = await served(t);
  const job = (await call("POST", "/api/your-data/export", {})).body;
  assert.ok(job.id, JSON.stringify(job));
  for (const scope of ["read", "run"]) {
    const key = app.sessionTokens.create(app.runtime.owner, { name: `zq-${scope}`, scope, minutes: 5 }).token;
    for (const path of ["/api/your-data", `/api/your-data/export/${job.id}`, `/api/your-data/export/${job.id}/file`]) {
      const answer = await call("GET", path, undefined, key);
      assert.equal(answer.status, 401, `${scope} key, GET ${path}`);
      assert.match(answer.body.error, /short-lived key/);
    }
  }
  assert.equal((await call("GET", "/api/your-data")).status, 200, "the app window still reads it");
});

test("export (review): the owner's .zip holds nothing of a household person's, every file keeps its own name, the whole record and put-away facts", async (t) => {
  const { app, call } = await served(t);
  const owner = app.runtime.owner;
  const [session] = app.store.sqlite.prepare("SELECT id FROM sessions WHERE owner=?").all(owner);
  const folder = join(app.store.folder, "attachments", folderFor(session.id), "notes");
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "zq-one.txt"), "zq-one");
  writeFileSync(join(folder, "zq-two.txt"), "zq-two");
  app.store.sqlite.prepare("INSERT INTO memory_archive(id, owner, data, created_at, updated_at, revision, archived_at) VALUES(?,?,?,?,?,?,?)")
    .run("zq-put-away", owner, JSON.stringify({ text: "zq-put-away-fact" }), "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z", 1, "2026-01-02T00:00:00.000Z");
  for (let i = 0; i < 1005; i++) audit(app.store, owner, { action: "data.exported", actor: owner, subject: `zq-entry-${i}`, reason: "zq", outcome: "saved" });
  const files = await exportAll(call);
  const all = Object.values(files).join("\n");
  assert.ok(!/zqsam/.test(all), "Sam's conversation and fact are not in the owner's export");
  assert.equal(files["backup.json"], undefined);
  const prefix = `files/${session.id.slice(0, 8)}/notes/`;
  assert.equal(files[`${prefix}zq-one.txt`], "zq-one", Object.keys(files).join(", "));
  assert.equal(files[`${prefix}zq-two.txt`], "zq-two");
  assert.match(files["logs/record.csv"], /"zq-entry-0"/, "the oldest entry is there too");
  assert.match(files["memory-archive.json"], /zq-put-away-fact/);
});

test("delete (review): no remembered text is left in the word index", async (t) => {
  const { app, call } = await served(t);
  const owner = app.runtime.owner;
  if (!app.memory.retrieval.ranked) return t.skip("this SQLite has no word index");
  app.memory.retrieval.syncIndex(owner);
  const indexed = () => app.store.sqlite.prepare("SELECT count(*) AS n FROM memory_search WHERE fact_text LIKE '%zqowner-fact%'").get().n;
  assert.ok(indexed() >= 1, "the fact was indexed");
  const done = await call("POST", "/api/your-data/delete", { confirm: "delete everything" });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(indexed(), 0, "its text is gone from the index");
});
