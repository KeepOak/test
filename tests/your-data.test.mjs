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
 *   M15 deleteEverything skips clearCopies (notes and history keep every fact)                → "delete (review): the memory notes"
 *   M16 settings.json read without the owner predicate (a household person's rows go in)     → "export (follow-up): the owner's own"
 *   M17 settings.json not scrubbed (a saved secret's value goes in)                          → "export (follow-up): the owner's own"
 *   M18 a second export for the same person allowed while the first is being made            → "export (follow-up): one at a time"
 *   M19 the outside service's facts left out of memory.json and the count                    → "export (follow-up): one at a time"
 *   M20 no overall cap on exports                                                            → "no more than two exports"
 *   M21 a purge inside Delete everything commits on its own (no savepoint)                   → "a failure part way"
 *   M22 a purge's file removal not held until the commit                                     → "a failure part way"
 *   M23 Delete everything's purge not run as one transaction                                 → "a failure part way"
 *   M24 unfinished deletes not resumed when the server starts                                → "the next start finishes it"
 *   M25 the outside step sent under Lockdown                                                 → "Lockdown holds it"
 *   M26 a journaled delete sent to whatever service is set up now                            → "never sent to a different service"
 *   M27 secure_delete left off for the purge                                                 → "nothing of what was deleted"
 *   M28 the update safety copies step skipped                                                → "nothing of what was deleted"
 *   M29 the memory history not started again                                                 → "the memory notes and the history"
 *   M31 the files step skipped                                                               → "a journal cut short"
 *   M32 the full-text indexes not merged again after the purge (words stay in their pages)   → "nothing of what was deleted"
 *   M33 the side file's checkpoint counted as done when it did not finish                    → "the side file is cleared"
 *   M34 finished exports of this person kept after the delete                                → "an export of what was deleted"
 *   M35 the history's copy replaced under Lockdown                                           → "under Lockdown the history"
 *   M36 the request waits for the journal's steps                                            → "the answer comes once"
 *   M37 a rollback does not read the Trunks again                                            → "a rollback reads the Trunks"
 *   M38 the copies saved elsewhere not limited to the person                                 → "the copies saved outside"
 *   M39 a rollback does not read the kept answers again                                      → "a rollback reads the Trunks"
 *   (VACUUM after scrubbing a copy survives on its own: the copy's secure_delete already overwrites what is deleted.)
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
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
import { resumeUnfinishedDeletes } from "../dist/your-data.js";
import { openJournal } from "../dist/your-data-forgood.js";
import { writeUpdateBackup } from "../dist/install/update-backup.js";
import { createServer } from "node:http";
import { spawnSync } from "node:child_process";

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
  const ownerRun = await app.runtime.run({ prompt: "zqowner-prompt please write the file" });
  app.store.save("memory", owner, "zqowner-fact-id", { text: "zqowner-fact", source: "owner" });
  await app.store.secrets.put(owner, "default", "ZQ_TOKEN", secretValue, { expiresInDays: 0 });
  const sam = app.store.profiles.create({ name: "Sam", pin: "2468" });
  app.runtime.roles.save(sam.id, { role: "adult" });
  const asOwner = () => app.store.profiles.switch({ profileId: null });
  const asSam = () => app.store.profiles.switch({ profileId: sam.id, pin: "2468" });
  asSam();
  const samRun = await runForCurrentPerson(app, { prompt: "zqsam-prompt hello", onTextDelta: () => undefined });
  const personal = app.trunks.personDefault();
  const samSessions = [...new Set([samRun.sessionId, personal.trunk.chatSessionId])];
  assert.ok(samSessions.every((id) => app.store.ownsSession(`profile:${sam.id}`, id)));
  assert.equal(app.store.ownsSession(`profile:${sam.id}`, ownerRun.sessionId), false);
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
  return { app, server, call, asOwner, asSam, samSessions, ownerRun };
}
const kind = (summary, name) => summary.kinds.find((k) => k.kind === name);
/** Delete everything, then follow the page's view until its steps have run: the answer, and the page after. */
async function deleteAndWait(call, confirm = "delete everything") {
  const done = await call("POST", "/api/your-data/delete", { confirm });
  if (done.status !== 200) return { ...done, after: null };
  let after = null;
  for (let i = 0; i < 500; i++) {
    after = (await call("GET", "/api/your-data")).body;
    if (after.delete?.id === done.body.journal && !after.delete.working) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return { ...done, after };
}

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
  const { call, asSam, samSessions } = await served(t);
  const owner = (await call("GET", "/api/your-data")).body;
  assert.equal(kind(owner, "conversations").count, 1);
  assert.equal(kind(owner, "memory").count, 1);
  assert.ok(kind(owner, "receipts").count >= 1, "the file the task wrote has a signed receipt");
  assert.ok(kind(owner, "keys").count >= 1 && kind(owner, "logs"), "the owner sees keys and logs");
  assert.ok(owner.folder && !JSON.stringify(owner).includes(secretValue), "counted and named, never a value");
  asSam();
  const sam = (await call("GET", "/api/your-data")).body;
  assert.equal(kind(sam, "conversations").count, samSessions.length, "Sam's requested chat and own canonical default, not the owner's");
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
  const { app, call, asOwner, asSam, samSessions, ownerRun } = await served(t);
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
  const done = await deleteAndWait(call, " Delete Everything ");
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.deepEqual(done.body.deleted, { conversations: samSessions.length, memory: 1 });
  assert.ok(samSessions.every((id) => !app.store.sqlite.prepare("SELECT 1 FROM sessions WHERE id=?").get(id)), "both of Sam's exact sessions were removed");
  assert.equal(app.store.ownsSession(app.runtime.owner, ownerRun.sessionId), true, "the exact owner's session survives");
  const sam = (await call("GET", "/api/your-data")).body;
  assert.equal(kind(sam, "conversations").count, 0);
  assert.equal(kind(sam, "memory").count, 0);
  asOwner();
  const owner = (await call("GET", "/api/your-data")).body;
  assert.equal(kind(owner, "conversations").count, 1, "the owner's conversation stays");
  assert.equal(kind(owner, "memory").count, 1);
  const record = app.store.audit.list(app.runtime.owner, { action: "history.pruned" });
  assert.ok(record.some((entry) => entry.reason.includes(`Your data: deleted ${samSessions.length} conversations`)), "the scoped delete count is written down");
  const again = await deleteAndWait(call);
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
    const custom = await double.refuse?.(request.method, parts);
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
  const done = await deleteAndWait(call);
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.deepEqual(done.body.deleted, { conversations: 1, memory: 3 }, "the fact here and both in use outside are out of use for good");
  assert.ok(done.after.delete.removed.some((line) => /^2 facts on the outside memory service at 127\.0\.0\.1/.test(line)), JSON.stringify(done.after.delete));
  assert.match(done.after.delete.waiting.join(" "), /One fact could not be deleted from the outside memory service/);
  assert.deepEqual([...service.facts.values()].map((record) => record.id), ["zq-will-not-go"], "everything else is gone from the service");
  assert.deepEqual(marks(app, owner), ["zq-forgotten-before", "zq-kept-outside", "zq-will-not-go"], "every mark stays");
  assert.deepEqual(await app.memory.backend.list(owner), [], "what the service kept is never read back");
  app.memory.backend.configure(owner, { mode: "built-in" });
  app.memory.backend.configure(owner, { mode: "outside" });
  assert.deepEqual(await app.memory.backend.list(owner), [], "not after switching away and back either");
  const record = app.store.audit.list(owner, { action: "history.pruned" });
  assert.ok(record.some((entry) => /and 3 remembered facts/.test(entry.reason)), "the record says so too");
  assert.match((await call("GET", "/api/your-data")).body.unfinished ?? "", /has not finished yet: One fact could not be deleted/, "the page says what is left");
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
  assert.equal(find("model:moderation")?.name, "check.example", "the check on what goes to the owner's chat apps");
  assert.equal(find("voice:Deepgram")?.kind, "voice");
  asSam();
  const theirs = (await call("GET", "/api/your-data")).body.leaves;
  assert.equal(theirs.find((row) => row.id === "memory:outside"), undefined, "the owner's memory service is not where Sam's facts go");
  assert.deepEqual(theirs.filter((row) => ["traces", "model:moderation"].includes(row.id)).map((row) => [row.id, row.name, row.page]),
    [["traces", "", null]], "Sam's tasks are sent too, without the owner's address; the chat apps' check is the owner's alone");
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
  const done = await deleteAndWait(call);
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(indexed(), 0, "its text is gone from the index");
});

/** Every Markdown file under a folder, joined, or "" when there is none. */
function markdownUnder(folder) {
  if (!existsSync(folder)) return "";
  return readdirSync(folder, { recursive: true }).filter((name) => String(name).endsWith(".md"))
    .map((name) => readFileSync(join(folder, String(name)), "utf8")).join("\n");
}

test("delete (review): the memory notes and the history's newest version no longer hold what was remembered", async (t) => {
  const { app, call } = await served(t);
  const owner = app.runtime.owner;
  const mirror = await app.memoryMirror.regenerate(owner, { force: true });
  const notes = join(app.runtime.workspace, mirror.folder);
  assert.match(markdownUnder(notes), /zqowner-fact/, "the notes were written");
  app.memoryHistory.configure(owner, { mode: "on" });
  await app.memoryHistory.record(owner);
  assert.match(markdownUnder(app.memoryHistory.folder), /zqowner-fact/, "the history recorded it");
  const done = await deleteAndWait(call);
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.doesNotMatch(markdownUnder(notes), /zqowner-fact/, "the notes are written again from what is left");
  assert.doesNotMatch(markdownUnder(app.memoryHistory.folder), /zqowner-fact/, "the history's newest version is without it");
  const log = spawnSync("git", ["log", "--all", "-p"], { cwd: app.memoryHistory.folder, encoding: "utf8" });
  assert.equal(log.status, 0, log.stderr);
  assert.doesNotMatch(log.stdout, /zqowner-fact/, "no earlier version holds it either");
  assert.ok(done.after.delete.removed.some((line) => /history of what is remembered, started again/.test(line)), JSON.stringify(done.after.delete));
  assert.ok(done.after.delete.removed.some((line) => /memory notes in your workspace/.test(line)));
});

test("export (follow-up): the owner's own settings, schedules and workflows, nothing of a household person's, no sign-in and no key", async (t) => {
  const { app, call, asSam } = await served(t);
  const owner = app.runtime.owner;
  const sam = app.store.profiles.scope() === owner ? null : app.store.profiles.scope();
  assert.equal(sam, null, "the fixture ends at the owner");
  app.store.save("settings", owner, "zq-owner-setting", { note: "zq-owner-setting-value", headers: { "x-zq-auth": secretValue }, apiToken: `${secretValue}-2`,
    secret: "secret://default/ZQ_TOKEN", text: "sk-ant-api03-zqzqzqzqzqzqzqzqzqzqzqzqzqzqzqzqzqzqzq" }); // not-a-real-secret
  app.store.save("settings", owner, "people-signin", { zq: "zq-sign-in-setting" });
  app.store.save("schedules", owner, "zq-schedule", { prompt: "zq-owner-schedule" });
  app.store.save("workflows", owner, "zq-workflow", { name: "zq-owner-workflow" });
  asSam();
  const samScope = app.store.profiles.scope();
  app.store.save("settings", samScope, "zq-sam-setting", { note: "zqsam-setting" });
  app.store.save("schedules", samScope, "zq-sam-schedule", { prompt: "zqsam-schedule" });
  app.store.profiles.switch({ profileId: null });
  const files = await exportAll(call);
  const kept = files["settings.json"];
  assert.ok(kept, Object.keys(files).join(", "));
  assert.match(kept, /zq-owner-setting-value/);
  assert.match(kept, /zq-owner-schedule/);
  assert.match(kept, /zq-owner-workflow/);
  assert.doesNotMatch(kept, /zqsam/, "nothing of Sam's");
  assert.doesNotMatch(kept, /zq-sign-in-setting/, "sign-ins stay on this computer");
  assert.ok(!kept.includes(secretValue), "a header's value and a value named like a key are hidden");
  assert.match(kept, /secret:\/\/default\/ZQ_TOKEN/, "a reference to a saved secret names it, so it stays");
  assert.doesNotMatch(kept, /sk-ant-api03-zq/, "and so is anything key-shaped");
  asSam();
  assert.equal((await exportAll(call))["settings.json"], undefined, "a household person's export has no owner settings");
});

test("export (follow-up): one at a time for each person, and an outside service's facts are counted and exported", async (t) => {
  const { app, call, asOwner, asSam } = await served(t);
  const owner = app.runtime.owner, service = await outsideService(t);
  app.web.policy.configure({ allowPrivateAddresses: true });
  app.memory.backend.configure(owner, { mode: "outside", url: service.url });
  service.add(owner, "zq-outside-one");
  service.add(owner, "zq-outside-two");
  assert.equal(kind((await call("GET", "/api/your-data")).body, "memory").count, 3, "the fact here and the two outside");
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  service.refuse = (method, parts) => (method === "GET" && parts.length === 2 ? held.then(() => null) : null);
  const first = await call("POST", "/api/your-data/export", {});
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const second = await call("POST", "/api/your-data/export", {});
  assert.equal(second.status, 409, "a second export waits for the first");
  assert.match(second.body.error, /already being made/);
  asSam();
  assert.equal((await call("POST", "/api/your-data/export", {})).status, 200, "another person's export is theirs to start");
  asOwner();
  service.refuse = null;
  release();
  let job = first.body;
  for (let i = 0; i < 200 && !job.ready && !job.error; i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    job = (await call("GET", `/api/your-data/export/${job.id}`)).body;
  }
  assert.equal(job.error, null);
  const files = unzip((await call("GET", `/api/your-data/export/${job.id}/file`)).bytes);
  const facts = JSON.parse(files["memory.json"]);
  assert.deepEqual(facts.filter((fact) => fact.keptBy).map((fact) => fact.id).sort(), ["zq-outside-one", "zq-outside-two"]);
  assert.ok(facts.some((fact) => fact.id === "zqowner-fact-id" && !fact.keptBy), "the fact here too");
  service.refuse = (method, parts) => (method === "GET" && parts.length === 2 ? [503, { error: "down" }] : null);
  let broken = (await call("POST", "/api/your-data/export", {})).body;
  assert.ok(broken.id, JSON.stringify(broken));
  for (let i = 0; i < 200 && !broken.ready && !broken.error; i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    broken = (await call("GET", `/api/your-data/export/${broken.id}`)).body;
  }
  assert.match(broken.error ?? "", /could not be asked what it keeps, so nothing was saved/, "an export never quietly leaves them out");
});

test("export (for good): no more than two exports are made at once across everybody", async (t) => {
  const { app, call, asOwner, asSam } = await served(t);
  const service = await outsideService(t);
  app.web.policy.configure({ allowPrivateAddresses: true });
  const kim = app.store.profiles.create({ name: "Kim", pin: "1357" });
  app.runtime.roles.save(kim.id, { role: "adult" });
  const asKim = () => app.store.profiles.switch({ profileId: kim.id, pin: "1357" });
  for (const scope of [app.runtime.owner, `profile:${kim.id}`]) app.memory.backend.configure(scope, { mode: "outside", url: service.url });
  asSam();
  app.memory.backend.configure(app.store.profiles.scope(), { mode: "outside", url: service.url });
  asOwner();
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  service.refuse = (method, parts) => (method === "GET" && parts.length === 2 ? held.then(() => null) : null);
  assert.equal((await call("POST", "/api/your-data/export", {})).status, 200, "the owner's");
  asSam();
  assert.equal((await call("POST", "/api/your-data/export", {})).status, 200, "Sam's");
  asKim();
  const third = await call("POST", "/api/your-data/export", {});
  assert.equal(third.status, 409, "a third waits");
  assert.match(third.body.error, /Two exports are already being made/);
  release();
  service.refuse = null;
  asOwner();
});

/* ---------- for good: one transaction, a journal that carries on, and nothing left behind ---------- */
const auditDeletes = (app) => app.store.audit.list(app.runtime.owner, { action: "history.pruned" }).length;
const journalRows = (app) => {
  const exists = app.store.sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='your_data_deletes'").get();
  return exists ? Number(app.store.sqlite.prepare("SELECT count(*) AS n FROM your_data_deletes").get().n) : 0;
};

test("delete (for good): a failure part way leaves everything as it was, and a retry deletes it all", async (t) => {
  const { app, call } = await served(t);
  const owner = app.runtime.owner, service = await outsideService(t);
  await app.runtime.run({ prompt: "zqowner-second please" });
  app.web.policy.configure({ allowPrivateAddresses: true });
  app.memory.backend.configure(owner, { mode: "outside", url: service.url });
  service.add(owner, "zq-kept-outside");
  const sessions = app.store.sqlite.prepare("SELECT id FROM sessions WHERE owner=? ORDER BY created_at").all(owner).map((row) => row.id);
  assert.ok(sessions.length >= 2, "two conversations");
  const folder = join(app.store.folder, "attachments", folderFor(sessions[0]));
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "zq-kept.txt"), "zq");
  const [firstRun] = app.store.sqlite.prepare("SELECT id FROM tasks WHERE session_id=?").all(sessions[0]);
  const kept = join(app.store.folder, "artifacts", firstRun.id);
  mkdirSync(kept, { recursive: true });
  writeFileSync(join(kept, "zq-task-file.txt"), "zq");
  const before = { conversations: sessions.length, audits: auditDeletes(app) };
  const hook = app.store.beforeConversationPurge;
  let calls = 0;
  app.store.beforeConversationPurge = (id) => { if (++calls === 2) throw new Error("zq disk gave out"); hook(id); };
  const failed = await call("POST", "/api/your-data/delete", { confirm: "delete everything" });
  assert.equal(failed.status, 500, JSON.stringify(failed.body));
  assert.match(failed.body.error, /nothing was deleted \(zq disk gave out\)\. Try again\./);
  assert.equal(app.store.sqlite.prepare("SELECT count(*) AS n FROM sessions WHERE owner=?").get(owner).n, before.conversations, "every conversation is still there");
  assert.equal(app.store.sqlite.prepare("SELECT count(*) AS n FROM memory WHERE owner=?").get(owner).n, 1, "and the fact");
  assert.ok(existsSync(join(folder, "zq-kept.txt")), "and the first conversation's file");
  assert.ok(existsSync(join(kept, "zq-task-file.txt")), "and its task's file");
  assert.deepEqual(marks(app, owner), [], "no fact was marked forgotten");
  assert.equal(journalRows(app), 0, "no journal");
  assert.equal(auditDeletes(app), before.audits, "and no record of a delete that did not happen");
  assert.equal(service.facts.size, 1, "nothing was sent to the service");
  app.store.beforeConversationPurge = hook;
  const done = await deleteAndWait(call);
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(app.store.sqlite.prepare("SELECT count(*) AS n FROM sessions WHERE owner=? AND id IN (SELECT value FROM json_each(?))").get(owner, JSON.stringify(sessions)).n, 0);
  assert.ok(!existsSync(folder), "the file went with it");
  assert.ok(!existsSync(kept), "and the task's file");
  assert.equal(service.facts.size, 0);
  assert.equal((await call("GET", "/api/your-data")).body.unfinished, null);
});

/** A Branch that can be closed and opened again on the same folder. */
async function reopenable(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-your-data-restart-"));
  const dataDir = join(root, "data");
  let open = null;
  const start = async () => {
    const app = await createBranch({ workspace: join(root, "workspace"), dataDir, provider: writer });
    app.web.policy.configure({ allowPrivateAddresses: true });
    const server = await startServer(app, { dataDir, port: 0 });
    const call = async (method, path, body) => {
      const response = await fetch(server.url + path, { method, headers: { authorization: `Bearer ${server.token}`, origin: server.url,
        ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, body: await response.json().catch(() => ({})) };
    };
    open = { app, server, call };
    return open;
  };
  const stop = async () => { if (!open) return; const { app, server } = open; open = null; await server.close(); await app.close(); };
  t.after(async () => { await stop(); await discardTemp(root); });
  return { start, stop };
}
async function until(check, what) {
  for (let i = 0; i < 250; i++) { if (await check()) return; await new Promise((resolve) => setTimeout(resolve, 20)); }
  assert.fail(`${what} did not happen`);
}

test("delete (for good): what the service would not delete is journaled; Lockdown holds it; the next start finishes it", async (t) => {
  const service = await outsideService(t);
  const branch = await reopenable(t);
  let { app, call } = await branch.start();
  const owner = app.runtime.owner;
  app.memory.backend.configure(owner, { mode: "outside", url: service.url });
  service.add(owner, "zq-one");
  service.add(owner, "zq-two");
  service.refuse = (method) => (method === "DELETE" ? [503, { error: "down" }] : null);
  const done = await deleteAndWait(call);
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.match(done.after.delete.waiting.join(" "), /2 facts could not be deleted from the outside memory service/);
  assert.equal(service.facts.size, 2);
  service.refuse = null;
  assert.equal((await call("POST", "/api/lockdown", { on: true })).status, 200);
  await resumeUnfinishedDeletes(app);
  assert.equal(service.facts.size, 2, "nothing is sent under Lockdown");
  assert.match((await call("GET", "/api/your-data")).body.unfinished, /Lockdown is on, so the facts on the outside memory service are deleted once it is off/);
  assert.equal((await call("POST", "/api/lockdown", { on: false })).status, 200);
  await branch.stop();
  ({ app, call } = await branch.start());
  await until(() => service.facts.size === 0, "the deletes after the start");
  await until(async () => (await call("GET", "/api/your-data")).body.unfinished === null, "the journal finishing");
});

test("delete (for good): a journaled delete is never sent to a different service", async (t) => {
  const first = await outsideService(t), second = await outsideService(t);
  const { app, call } = await served(t);
  const owner = app.runtime.owner;
  app.web.policy.configure({ allowPrivateAddresses: true });
  app.memory.backend.configure(owner, { mode: "outside", url: first.url });
  first.add(owner, "zq-one");
  first.refuse = (method) => (method === "DELETE" ? [503, { error: "down" }] : null);
  assert.equal((await deleteAndWait(call)).status, 200);
  app.memory.backend.configure(owner, { mode: "outside", url: second.url });
  second.add(owner, "zq-one");
  first.refuse = null;
  await resumeUnfinishedDeletes(app);
  assert.equal(second.facts.size, 1, "the other service is sent nothing");
  assert.equal(first.facts.size, 1);
  assert.match((await call("GET", "/api/your-data")).body.unfinished, /outside memory service was changed/);
  app.memory.backend.configure(owner, { mode: "outside", url: first.url });
  await resumeUnfinishedDeletes(app);
  assert.equal(first.facts.size, 0, "switching back finishes it");
});

/** Every file under a folder, as raw bytes joined, so text in a database page or a side file is found too. */
function rawUnder(folder) {
  return readdirSync(folder, { recursive: true }).map((name) => join(folder, String(name)))
    .filter((path) => { try { return statSync(path).isFile(); } catch { return false; } })
    .map((path) => readFileSync(path).toString("latin1")).join("\n");
}

test("delete (for good): nothing of what was deleted is left in the data folder or any update safety copy", async (t) => {
  const { app, call } = await served(t);
  const owner = app.runtime.owner, dataDir = app.store.folder, copies = join(dataDir, "update-backups");
  app.memoryHistory.configure(owner, { mode: "on" });
  await app.memoryHistory.record(owner);
  app.store.save("settings", owner, "zq-owner-setting", { note: "zq-owner-setting-kept" });
  const [session] = app.store.sqlite.prepare("SELECT id FROM sessions WHERE owner=?").all(owner);
  mkdirSync(join(dataDir, "attachments", folderFor(session.id)), { recursive: true });
  writeFileSync(join(dataDir, "attachments", folderFor(session.id), "zq.txt"), "zqowner-prompt in a file");
  await writeUpdateBackup(dataDir, app.store.backup(app.version), app.version);
  mkdirSync(copies, { recursive: true });
  app.store.sqlite.exec(`VACUUM INTO '${join(copies, "before-format-7.sqlite").replace(/'/g, "''")}'`);
  for (const name of ["data-2026-09-27T01-02-03-004Z-v1.0.0", "replaced-2026-09-27T01-02-03-004Z"]) {
    const folder = join(copies, name);
    mkdirSync(join(folder, "attachments", folderFor(session.id)), { recursive: true });
    app.store.sqlite.exec(`VACUUM INTO '${join(folder, "branch.sqlite").replace(/'/g, "''")}'`);
    writeFileSync(join(folder, "attachments", folderFor(session.id), "zq.txt"), "zqowner-prompt in a copied file");
    mkdirSync(join(folder, "memory-history"), { recursive: true });
    writeFileSync(join(folder, "memory-history", "facts.md"), "- zqowner-fact");
  }
  assert.match(rawUnder(copies), /zqowner-prompt/, "the copies held it");
  const done = await deleteAndWait(call);
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.deepEqual(done.after.delete.waiting, [], JSON.stringify(done.after.delete));
  const everything = rawUnder(dataDir);
  for (const marker of ["zqowner-prompt", "zqowner-fact", "zqowner"]) assert.ok(!everything.includes(marker), `${marker} is gone from every file`);
  assert.ok(done.after.delete.removed.some((line) => /^4 update safety copies, made again without them\.$/.test(line)), JSON.stringify(done.after.delete));
  const copy = rawUnder(copies);
  assert.match(copy, /zqsam-prompt/, "Sam's conversation stays in the copies");
  assert.match(copy, /zq-owner-setting-kept/, "and the owner's settings");
  assert.equal(readdirSync(copies).length, 4, "every copy keeps its name");
});

test("delete (for good): a journal cut short after the commit removes the files at the next resume", async (t) => {
  const { app } = await served(t);
  const scope = app.runtime.owner, session = randomUUID(), run = randomUUID();
  const files = join(app.store.folder, "attachments", folderFor(session)), taskFiles = join(app.store.folder, "artifacts", run);
  mkdirSync(files, { recursive: true });
  writeFileSync(join(files, "zq.txt"), "zq");
  mkdirSync(taskFiles, { recursive: true });
  writeFileSync(join(taskFiles, "zq.txt"), "zq");
  openJournal(app, { scope, sessions: [session], runIds: [run], outside: null, history: false }, []);
  await resumeUnfinishedDeletes(app);
  assert.ok(!existsSync(files), "the conversation's files");
  assert.ok(!existsSync(taskFiles), "and its task's files");
  assert.equal(journalRows(app), 1);
  assert.equal(app.store.sqlite.prepare("SELECT finished FROM your_data_deletes").get().finished, 1, "the journal is finished");
});

test("delete (for good): the side file is cleared only once its checkpoint really finished", async (t) => {
  const { app, call } = await served(t);
  // The store holds its database alone (locking_mode EXCLUSIVE), so a checkpoint that cannot finish is stood in for here.
  const db = app.store.sqlite, prepare = db.prepare.bind(db);
  let busy = true;
  db.prepare = (sql) => (busy && /wal_checkpoint/.test(sql) ? { get: () => ({ busy: 1, log: 5, checkpointed: 0 }) } : prepare(sql));
  t.after(() => { db.prepare = prepare; });
  const done = await deleteAndWait(call);
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.match(done.after.delete.waiting.join(" "), /still being read/, JSON.stringify(done.after.delete));
  assert.match((await call("GET", "/api/your-data")).body.unfinished ?? "", /still being read/);
  busy = false;
  await resumeUnfinishedDeletes(app);
  assert.equal((await call("GET", "/api/your-data")).body.unfinished, null);
  const side = join(app.store.folder, "branch.sqlite-wal");
  assert.ok(!existsSync(side) || !readFileSync(side).toString("latin1").includes("zqowner"), "the side file holds none of it");
});

test("delete (for good): an export of what was deleted cannot be downloaded after, and one being made holds the delete", async (t) => {
  const { app, call } = await served(t);
  const service = await outsideService(t);
  let job = (await call("POST", "/api/your-data/export", {})).body;
  for (let i = 0; i < 200 && !job.ready && !job.error; i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    job = (await call("GET", `/api/your-data/export/${job.id}`)).body;
  }
  assert.equal(job.ready, true);
  app.web.policy.configure({ allowPrivateAddresses: true });
  app.memory.backend.configure(app.runtime.owner, { mode: "outside", url: service.url });
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  service.refuse = (method, parts) => (method === "GET" && parts.length === 2 ? held.then(() => null) : null);
  const making = (await call("POST", "/api/your-data/export", {})).body;
  const refused = await call("POST", "/api/your-data/delete", { confirm: "delete everything" });
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /An export is still being made/);
  release();
  service.refuse = null;
  for (let i = 0; i < 200; i++) {
    const now = (await call("GET", `/api/your-data/export/${making.id}`)).body;
    if (now.ready || now.error) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal((await deleteAndWait(call)).status, 200);
  assert.equal((await call("GET", `/api/your-data/export/${making.id}/file`)).status, 404, "the export of what was deleted is gone");
});

test("delete (for good): under Lockdown the history is started again here, and its copy waits", async (t) => {
  const { app, call } = await served(t);
  const owner = app.runtime.owner;
  app.memoryHistory.configure(owner, { mode: "on" });
  await app.memoryHistory.record(owner);
  app.memoryHistory.configure(owner, { remote: "https://git.example/zq/memory.git" });
  openJournal(app, { scope: owner, sessions: [], runIds: [], outside: null, history: true }, []);
  assert.equal((await call("POST", "/api/lockdown", { on: true })).status, 200);
  await resumeUnfinishedDeletes(app);
  assert.match((await call("GET", "/api/your-data")).body.unfinished ?? "", /Lockdown is on, so the copy of that history at git\.example is replaced once it is off/);
  const log = spawnSync("git", ["log", "--all", "--format=%s"], { cwd: app.memoryHistory.folder, encoding: "utf8" });
  assert.equal(log.stdout.trim(), "Started again: everything remembered before was deleted", "started again here");
  assert.equal((await call("POST", "/api/lockdown", { on: false })).status, 200);
});

test("delete (background): the answer comes once the delete is committed, and the page follows the steps", async (t) => {
  const { app, call } = await served(t);
  const owner = app.runtime.owner, service = await outsideService(t);
  app.web.policy.configure({ allowPrivateAddresses: true });
  app.memory.backend.configure(owner, { mode: "outside", url: service.url });
  service.add(owner, "zq-one");
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  service.refuse = (method) => (method === "DELETE" ? held.then(() => null) : null);
  try {
    const answer = await Promise.race([call("POST", "/api/your-data/delete", { confirm: "delete everything" }),
      new Promise((resolve) => setTimeout(() => resolve("still waiting"), 3000))]);
    assert.notEqual(answer, "still waiting", "the answer does not wait for the outside service");
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    assert.equal(typeof answer.body.journal, "string");
    const during = (await call("GET", "/api/your-data")).body;
    assert.equal(during.delete.id, answer.body.journal);
    assert.equal(during.delete.working, true, "its steps are still running");
    assert.ok(during.delete.done < during.delete.total);
    assert.equal(during.unfinished, null, "a delete that is running is not called unfinished");
    assert.equal(kind(during, "conversations").count, 0, "the conversations are already gone");
  } finally { release(); }
  let after;
  for (let i = 0; i < 500; i++) {
    after = (await call("GET", "/api/your-data")).body;
    if (!after.delete.working) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(after.delete.done, after.delete.total);
  assert.ok(after.delete.removed.some((line) => /One fact on the outside memory service/.test(line)), JSON.stringify(after.delete));
  assert.equal(service.facts.size, 0);
});

test("delete (background): a rollback reads the Trunks' own conversations and kept answers again", async (t) => {
  const { app, call } = await served(t);
  const ed = app.trunks.create({ name: "Ed" });
  await app.runtime.run({ prompt: "zqowner-third please" });
  const chat = ed.chatSessionId;
  assert.equal(app.trunks.trunkForConversation(chat)?.trunkId, ed.id);
  const order = app.store.sqlite.prepare("SELECT id FROM sessions WHERE owner=? ORDER BY created_at").all(app.runtime.owner).map((row) => row.id);
  await until(() => !order.some((id) => app.store.conversations.busy([id, ...app.store.conversationCompanions(id)])), "the Trunk settling");
  const hook = app.store.beforeConversationPurge;
  let calls = 0;
  app.store.beforeConversationPurge = (id) => { hook(id); if (++calls === order.indexOf(chat) + 2) throw new Error("zq disk gave out"); };
  t.after(() => { app.store.beforeConversationPurge = hook; });
  app.runtime["carriedBack"].add(chat); // as if a task had already put Ed's kept answers back in this launch
  const failed = await call("POST", "/api/your-data/delete", { confirm: "delete everything" });
  assert.equal(failed.status, 500, JSON.stringify(failed.body));
  assert.equal(app.runtime["carriedBack"].has(chat), false, "its kept answers are read from what was written down again");
  assert.ok(calls > order.indexOf(chat) + 1, "Ed's conversation was purged before the failure");
  assert.equal(app.trunks.records.get(ed.id).chatSessionId, chat, "the database kept Ed's conversation");
  assert.equal(app.trunks.trunkForConversation(chat)?.trunkId, ed.id, "and so does what is kept in memory");
});

test("delete (background): the copies saved outside Branch's folder are listed after, untouched", async (t) => {
  const { app, call, asSam } = await served(t);
  assert.equal((await call("GET", "/api/backup")).status, 200);
  await exportAll(call);
  const done = await deleteAndWait(call);
  const view = done.after.delete;
  assert.deepEqual(view.elsewhere.map((copy) => copy.what).sort(), ["a full backup", "everything kept for this person"]);
  assert.match(view.elsewhereNote, /Branch did not touch these copies you saved outside its folder/);
  asSam();
  const sam = await deleteAndWait(call);
  assert.deepEqual(sam.after.delete.elsewhere, [], "Sam is not shown the owner's copies");
  assert.equal(sam.after.delete.elsewhereNote, null);
});
