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
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateRawSync, crc32 } from "node:zlib";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { savePolicy } from "../dist/policy.js";
import { runForCurrentPerson } from "../dist/collab-server.js";
import { buildZip, zipName } from "../dist/zip-write.js";

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
