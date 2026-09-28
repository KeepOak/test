import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./trunks-helpers.mjs";
import { asPerson } from "../dist/people/context.js";
import { profileScope } from "../dist/profiles.js";
import { runForCurrentPerson } from "../dist/collab-server.js";
import { startServer } from "../dist/server.js";
import { readPolicy, savePolicy } from "../dist/policy.js";
import { call } from "./trunks-helpers.mjs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createBranch } from "../dist/index.js";
import { brain } from "./trunks-helpers.mjs";
import { discardTemp } from "./temp-dir.mjs";
import { importBackup } from "../dist/backup.js";

test("the default Trunk carries on an exactly approved file request", async (t) => {
  const { app, root } = await fixture(t, [({ last, system }) => {
    const allowed = /The call you asked about did not run/.test(system) && !/"ok":true/.test(String(last?.content ?? ""));
    if (last?.role === "tool" && !allowed) return "Written.";
    if (last?.role === "user" || allowed) return call("files.write", { path: "note.txt", content: "hello" });
  }]);
  const home = app.trunks.ensureDefault(true), policy = readPolicy(app.store, app.runtime.owner);
  savePolicy(app.store, app.runtime.owner, { ...policy, rules: [{ tool: "files.write", decision: "ask" }, ...policy.rules] });
  const run = await app.runtime.run({ prompt: "write the note", trunkId: home.id });
  const question = app.runtime.approvals.questionFor(run.sessionId);
  assert.ok(question);
  app.runtime.approve(run.sessionId, "allow", "never", question.fingerprint);
  await app.runtime.continueAsked(run.id);
  const results = app.store.events(run.id).filter((event) => /^tool\./.test(event.kind));
  assert.ok(results.some((event) => event.kind === "tool.completed" && event.data.name === "files.write"), JSON.stringify(results));
  assert.equal(await readFile(join(root, "workspace", "note.txt"), "utf8"), "hello", "default files resolve in the person's workspace");
});

test("the default files are written, other Trunks blank with hints, and edits apply on the next turn", async (t) => {
  const { app, provider } = await fixture(t);
  const home = app.trunks.ensureDefault(true);
  assert.notEqual(home.character, "branch", "a generated default has its own character");
  app.store.save("governance", app.runtime.owner, `trunk:${home.id}`, { ...app.trunks.records.get(home.id), character: "branch" }); // legacy stored record, never a valid new edit
  assert.notEqual(app.trunks.ensureDefault(true).character, "branch", "a legacy mascot default gets its own character");
  const other = app.trunks.create({ name: "Blank" });
  await app.trunks.introduced();
  const files = app.trunks.files.view(home.id).files;
  assert.equal(files.length, 7);
  assert.ok(files.every((file) => file.text.length > 70));
  assert.ok(app.trunks.files.view(other.id).files.every((file) => !file.text && file.hint.length > 8));
  app.trunks.files.edit(home.id, { name: "USER.md", text: "Call this person River. TEST-LIVE-7719" });
  app.trunks.files.edit(home.id, { name: "SOUL.md", text: "Speak plainly. TEST-SOUL-5521" });
  await app.runtime.run({ prompt: "hello", trunkId: home.id });
  const system = provider.requests.at(-1).messages.filter((message) => message.role === "system").map((message) => message.content).join("\n");
  assert.match(system, /TEST-LIVE-7719/);
  assert.match(system, /TEST-SOUL-5521/);
  assert.throws(() => app.trunks.files.edit(home.id, { name: "../../secrets", text: "x" }));
  assert.throws(() => app.trunks.files.edit(home.id, { name: "USER.md", text: "x".repeat(8001) }));
  assert.equal(app.store.audit.list(app.runtime.owner, { action: "trunk.files" }).length, 2);
});

test("each household person gets their own persistent default and isolated threads, memory and files", async (t) => {
  const { app } = await fixture(t);
  const home = app.trunks.ensureDefault(true);
  const sam = app.store.profiles.create({ name: "Sam", pin: "2468" });
  const river = app.store.profiles.create({ name: "River", pin: "1357" });
  const forPerson = (person, work) => asPerson({ profileId: person.id, keyId: `test:${person.id}` }, work);
  const samHome = forPerson(sam, () => app.trunks.personDefault());
  const riverHome = forPerson(river, () => app.trunks.personDefault());
  assert.notEqual(samHome.trunk.id, home.id);
  assert.notEqual(samHome.trunk.id, riverHome.trunk.id);
  assert.equal(app.trunks.records.list().length, 1, "people never appear on the owner roster");
  assert.equal(forPerson(sam, () => app.trunks.homeForNew()), samHome.trunk.id);
  const run = await forPerson(sam, () => runForCurrentPerson(app, { prompt: "personal hello", trunkId: samHome.trunk.id }));
  assert.equal(app.store.ownsSession(profileScope(sam.id), run.sessionId), true);
  assert.equal(samHome.threads.get(run.sessionId)?.trunkId, samHome.trunk.id);
  assert.equal(riverHome.threads.get(run.sessionId), undefined);
  assert.equal(app.trunks.threads.get(run.sessionId), undefined);
  assert.equal(app.store.events(run.id).find((event) => event.kind === "trunk.turn")?.data.trunkId, samHome.trunk.id);
  assert.equal(forPerson(sam, () => app.trunks.personDefault()).trunk.id, samHome.trunk.id);
  const canonical = await forPerson(sam, () => runForCurrentPerson(app, { prompt: "canonical hello", sessionId: samHome.trunk.chatSessionId }));
  assert.equal(app.store.events(canonical.id).find((event) => event.kind === "trunk.turn")?.data.trunkId, samHome.trunk.id);
  app.store.profiles.switch({ profileId: sam.id, pin: "2468" });
  assert.equal(app.trunks.shapeOf({ prompt: "channel", trunkId: home.id, source: "channel" }).owners, true);
});

test("edited files and every person's default survive restarting the engine", async () => {
  const root = await mkdtemp(join(tmpdir(), "branch-default-files-restart-"));
  const open = () => createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: brain() });
  let app = await open();
  try {
    const home = app.trunks.ensureDefault(true), person = app.store.profiles.create({ name: "Sam", pin: "2468" });
    const mark = { profileId: person.id, keyId: "test:restart" };
    const personal = asPerson(mark, () => app.trunks.personDefault());
    app.trunks.files.edit(home.id, { name: "USER.md", text: "OWNER-RESTART-7711" });
    personal.files.edit(personal.trunk.id, { name: "USER.md", text: "PERSON-RESTART-8833" });
    await app.close(); app = await open();
    assert.equal(app.trunks.ensureDefault(true).id, home.id);
    assert.equal(app.trunks.files.view(home.id).files.find((file) => file.name === "USER.md").text, "OWNER-RESTART-7711");
    const again = asPerson(mark, () => app.trunks.personDefault());
    assert.equal(again.trunk.id, personal.trunk.id);
    assert.equal(again.files.view(again.trunk.id).files.find((file) => file.name === "USER.md").text, "PERSON-RESTART-8833");
  } finally { await app.close(); await discardTemp(root); }
});

test("backup restores only validated files with their held Trunk and matching owner", async (t) => {
  const { app } = await fixture(t), home = app.trunks.ensureDefault(true);
  app.trunks.files.edit(home.id, { name: "USER.md", text: "RESTORED-NOTES-4422" });
  const archive = app.store.backup(app.version), fresh = await fixture(t);
  const file = archive.tables.governance.find((row) => row.id === `trunk-files:${home.id}`);
  assert.ok(file);
  importBackup(fresh.app.store.sqlite, archive);
  assert.equal(fresh.app.trunks.files.view(home.id).files.find((entry) => entry.name === "USER.md").text, "RESTORED-NOTES-4422");
  assert.equal(fresh.app.trunks.records.get(home.id).paused, true);
  assert.equal(fresh.app.trunks.defaultTrunk(), undefined, "imported notes never select a default");
  for (const changed of [
    { ...file, owner: "somebody-else" },
    { ...file, id: `trunk-files:${crypto.randomUUID()}` },
    { ...file, data: JSON.stringify({ files: { "../secrets": "bad" } }) },
    { ...file, data: JSON.stringify({ files: { "USER.md": "x".repeat(8001) } }) },
    { ...file, data: JSON.stringify({ files: { "USER.md": "bad" }, permissions: ["*"] }) },
  ]) {
    const rejected = await fixture(t);
    const input = structuredClone(archive);
    input.tables.governance = input.tables.governance.filter((row) => row.id !== file.id);
    input.tables.governance.push(changed);
    importBackup(rejected.app.store.sqlite, input);
    assert.equal(rejected.app.store.get("governance", String(changed.owner), String(changed.id)), undefined);
  }
  const existing = await fixture(t);
  importBackup(existing.app.store.sqlite, archive, { replaceExisting: true });
  assert.equal(existing.app.store.get("governance", app.runtime.owner, file.id), undefined, "replace never replaces this computer's files");
});

test("personality files are owner-only except a person's own default; foreign files and short-lived writes are refused", async (t) => {
  const { app, root } = await fixture(t);
  const home = app.trunks.ensureDefault(true);
  const sam = app.store.profiles.create({ name: "Sam", pin: "2468" });
  const server = await startServer(app, { dataDir: root, port: 0 });
  t.after(() => server.close());
  const headers = { authorization: `Bearer ${server.token}`, origin: server.url, "content-type": "application/json" };
  const request = async (id, text) => fetch(`${server.url}/api/trunks/${id}/files`, { method: text === undefined ? "GET" : "POST", headers,
    ...(text === undefined ? {} : { body: JSON.stringify({ name: "USER.md", text }) }) });
  assert.equal((await request(home.id)).status, 200);
  app.store.profiles.switch({ profileId: sam.id, pin: "2468" });
  assert.ok([400, 403].includes((await request(home.id)).status));
  const personal = app.trunks.personDefault();
  const personalResponse = await request(personal.trunk.id, "Sam's preferences");
  assert.equal(personalResponse.status, 200, await personalResponse.text());
  assert.equal(personal.files.view(personal.trunk.id).files.find((file) => file.name === "USER.md").text, "Sam's preferences");
  assert.doesNotMatch(app.trunks.files.view(home.id).files.find((file) => file.name === "USER.md").text, /Sam's preferences/);
  app.store.profiles.switch({ profileId: null });
  const key = app.sessionTokens.create(app.runtime.owner, { name: "script", scope: "run", minutes: 5 }).token;
  const response = await fetch(`${server.url}/api/trunks/${home.id}/files`, { method: "POST",
    headers: { ...headers, authorization: `Bearer ${key}` }, body: JSON.stringify({ name: "USER.md", text: "unauthorized" }) });
  assert.equal(response.status, 401);
  const privateRead = await fetch(`${server.url}/api/trunks/${home.id}/files`, { headers: { ...headers, authorization: `Bearer ${key}` } });
  assert.equal(privateRead.status, 401);
});
