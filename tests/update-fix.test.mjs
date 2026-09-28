/**
 * Owner item 21: "Fix update". One press hands what Branch recorded about an update that did not go
 * through to the Trunk the owner assigned to updates (the Update keeper, made the first time), in its
 * own conversation, as the owner's own visible message. It explains and proposes; it never changes
 * anything without asking. Nothing is spawned here.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { activationJournalName, openActivationJournal, settleActivation } from "../dist/never-break/activation.js";
import { trunkMode } from "../dist/trunks/settings.js";
import { boundPrompt, keeperInstructions, keeperName, updateFixApi } from "../dist/update-fix.js";

const secret = "sk-ant-api03-" + "y".repeat(48);
const provider = { name: "scripted", async complete() { return { content: "Looking at it.", toolCalls: [] }; } };

/** A Branch whose last update did not go through; the browser, if any, is launched before TEMP moves. */
async function failedUpdate(t, before = async () => {}, model = provider) {
  const root = await mkdtemp(join(tmpdir(), "branch-update-fix-"));
  const dataDir = join(root, "data"), temp = join(root, "temp");
  await mkdir(join(temp, "branch-agent-update"), { recursive: true });
  await writeFile(join(temp, "branch-agent-update", "apply-update.log"),
    ["[10:00:01] app closed", `[10:00:02] copying with ${secret}`, "[10:00:03] copy failed; putting the previous version back"].join("\r\n"));
  const saved = { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR };
  Object.assign(process.env, { TEMP: temp, TMP: temp, TMPDIR: temp });
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir, provider: model });
  const server = await startServer(app, { dataDir, port: 0 });
  t.after(async () => {
    await before();
    await app.trunks.introduced();
    await server.close(); await app.close();
    for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    // The browser's own helper can hold TEMP a while after it closes on a slow Windows machine.
    await discardTemp(root, { tries: 60, pause: 100 });
  });
  const { journal } = openActivationJournal(join(dataDir, activationJournalName));
  journal.stage({ kind: "update", fromVersion: "1.0.0", toVersion: "2.0.0", target: join(root, "installed"), previous: null, candidate: null,
    launcher: null, executableName: "Branch Agent.exe", understood: 1, databases: [], backups: [] });
  journal.close();
  settleActivation(join(dataDir, activationJournalName), "1.0.0");
  const call = async (path, body, key = server.token) => {
    const response = await fetch(server.url + "/api/" + path, { method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${key}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  return { app, server, dataDir, call };
}

test("the first Fix update makes the Update keeper, switches Trunks on and says so, and hands it the cleaned record", async (t) => {
  const { app, call } = await failedUpdate(t);
  const owner = app.runtime.owner;
  // #327 (the owner's rule): Trunks ship "when needed"; the Fix is tested from off, as a switched-off install has it.
  app.trunks.setMode("trunks", { mode: "off" });
  assert.equal(trunkMode(app.store, owner, "trunks"), "off", "Trunks switched off");
  const fix = (await call("updates/fix", {})).body;
  assert.deepEqual([fix.name, fix.made, fix.trunksSwitchedOn], [keeperName, true, true]);
  assert.equal(trunkMode(app.store, owner, "trunks"), "when-needed");
  const keeper = app.trunks.records.get(fix.trunkId);
  assert.equal(fix.sessionId, keeper.chatSessionId, "its own conversation, so it remembers every update it looked at");
  assert.equal(keeper.instructions, keeperInstructions);
  assert.match(keeper.instructions, /Never change files, settings, installs or accounts yourself/);
  assert.equal(keeper.sharedFacts, false, "its memory is its own");
  assert.match(fix.prompt, /^The update from 1\.0\.0 to 2\.0\.0 didn't go through/);
  assert.match(fix.prompt, /copy failed; putting the previous version back/);
  assert.match(fix.prompt, /Don't change anything without asking me first/);
  assert.ok(!fix.prompt.includes(secret), "cleaned");
  assert.ok(fix.prompt.length < 13_000, "bounded");
  const again = (await call("updates/fix", {})).body;
  assert.deepEqual([again.trunkId, again.made, again.trunksSwitchedOn], [fix.trunkId, false, false], "the same keeper, next time");
});

test("the owner can give updates to another Trunk, and back to the Update keeper without making a second one", async (t) => {
  const { app, call } = await failedUpdate(t);
  const first = (await call("updates/fix", {})).body;
  const before = app.trunks.records.list().map((trunk) => trunk.id);
  const other = app.trunks.create({ name: "Ops", title: "", description: "" });
  const listed = (await call("updates/keeper")).body;
  assert.equal(listed.trunkId, first.trunkId);
  assert.deepEqual(listed.trunks.map((trunk) => trunk.id).sort(), [...new Set([...before, other.id, first.trunkId])].sort(), "the existing default and the two named choices, with no duplicate keeper");
  assert.equal((await call("updates/keeper", { trunkId: other.id })).body.trunkId, other.id);
  assert.equal((await call("updates/fix", {})).body.trunkId, other.id, "the chosen Trunk does it");
  assert.equal((await call("updates/keeper", { trunkId: "11111111-2222-4333-8444-555555555555" })).status, 400, "only a Trunk that exists");
  await call("updates/keeper", { trunkId: null });
  assert.equal((await call("updates/fix", {})).body.trunkId, first.trunkId, "back to the same Update keeper");
  assert.equal(app.trunks.records.list().filter((trunk) => trunk.name === keeperName).length, 1);
});

test("a household profile and a short-lived key can neither fix an update nor choose who does", async (t) => {
  const { app, call, dataDir } = await failedUpdate(t);
  const key = app.sessionTokens.create(app.runtime.owner, { name: "phone", scope: "run" }).token;
  assert.ok([401, 403].includes((await call("updates/fix", {}, key)).status));
  assert.ok([401, 403].includes((await call("updates/keeper", undefined, key)).status));
  assert.ok([401, 403].includes((await call("updates/keeper", { trunkId: null }, key)).status));
  const person = app.store.profiles.create({ name: "Sam", pin: "1234" });
  app.store.profiles.switch({ profileId: person.id, pin: "1234" });
  t.after(() => app.store.profiles.switch({ profileId: null }));
  assert.notEqual((await call("updates/fix", {})).status, 200);
  const ctx = { app, dataDir, installType: "test", startedAt: Date.now() };
  for (const [method, path] of [["POST", "/api/updates/fix"], ["GET", "/api/updates/keeper"], ["POST", "/api/updates/keeper"]])
    await assert.rejects(updateFixApi(ctx, method, path, async () => ({ trunkId: null })), /^Error: Fixing an update belongs to the owner/);
  app.store.profiles.switch({ profileId: null });
  assert.equal(app.trunks.records.list().length, 0, "nothing was made");
});

test("a new keeper has introduced itself before the record is handed over, so the report is never refused as a second task", async (t) => {
  const slowHello = { name: "scripted", async complete(request) {
    if (/Introduce yourself/.test(request.messages.at(-1)?.content ?? "")) await new Promise((r) => setTimeout(r, 800));
    return { content: "Hello, I look after updates.", toolCalls: [] };
  } };
  const { app, call } = await failedUpdate(t, undefined, slowHello);
  const fix = (await call("updates/fix", {})).body;
  assert.equal(fix.made, true);
  const running = app.store.runs(app.runtime.owner).filter((run) => run.sessionId === fix.sessionId && run.status === "running");
  assert.deepEqual(running, [], "nothing is still working in the keeper's conversation");
  assert.ok(app.store.messages(fix.sessionId).some((m) => m.role === "assistant"), "its introduction is there");
  const handed = await app.runtime.run({ prompt: fix.prompt, sessionId: fix.sessionId });
  assert.equal(handed.status, "completed", "the record is taken straight away");
});

test("the update's own steps always reach the keeper, their end kept, however long the other items are", () => {
  const long = (mark) => `${mark}-START\n` + "x".repeat(9000) + `\n${mark}-END`;
  const steps = { title: "What the last update did", text: long("STEPS").replace("STEPS-END", "copy failed; putting the previous version back") };
  const text = boundPrompt("Head.\n", [{ title: "About", text: long("ABOUT") }, { title: "Activity", text: long("ACTIVITY") }], steps);
  assert.ok(text.length <= 12_000, `bounded: ${text.length}`);
  assert.match(text, /copy failed; putting the previous version back/, "where the update stopped is there");
  assert.match(text, /ABOUT-START/, "an earlier item is cut short, not left out");
  assert.ok(!text.includes("ABOUT-END"), "and it is cut");
  assert.match(text, /## What the last update did/);
});
