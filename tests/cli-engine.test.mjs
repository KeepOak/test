/**
 * B5 (CL-04): `branch approve`, `lockdown`, `permissions`, `theme`, `model` and `gateway` beside a
 * Branch that is already open. They used to refuse whenever Branch was open ("close it and try
 * again"), so a waiting question could not be answered from a terminal at exactly the moment it waited,
 * and Lockdown could not even be read. They now go through the open Branch's own routes, with the
 * window's guards.
 *
 * Security tier: approving, Lockdown and the approval settings over the local API. What must hold:
 *  - an answer is given once, bound to the exact request's fingerprint; never a standing rule from here;
 *  - a short-lived key (read or run) cannot switch Lockdown, change the approval settings, the model or
 *    the gateway, and cannot answer a question of a task it did not start;
 *  - with the window switched to a household profile, the same local key is refused Lockdown (on or off),
 *    the approval settings, the model and the gateway, and never finds the owner's waiting question.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { clientFor } from "../dist/cli-attach.js";
import { engineApprove, engineLockdown, engineModel, enginePermissions, engineTheme, gatewayCommand } from "../dist/cli-engine.js";
import { lockdownActive } from "../dist/lockdown.js";
import { readPolicy, savePolicy } from "../dist/policy.js";
import { readLook } from "../dist/terminal-theme.js";
import { loadGatewayConfig } from "../dist/never-break/gateway-config.js";
import { householdRefusal } from "../dist/household-routes.js";

/**
 * A model that writes the file it is asked to write, then says it is done. After it stopped to ask, the window's
 * carry-on has the engine make the approved write itself (QA R1).
 */
const pending = { path: null };
const writer = { name: "writer", async complete(request) {
  const last = request.messages.at(-1);
  const write = (path) => ({ content: "", toolCalls: [{ id: `w${randomUUID()}`, name: "files.write", arguments: JSON.stringify({ path, content: "hello" }) }] });
  if (last?.role === "user" && /^write /.test(String(last.content))) { pending.path = String(last.content).slice(6).trim(); return write(pending.path); }
  if (last?.role === "user" && pending.path) { const path = pending.path; pending.path = null; return write(path); }
  return { content: "Done.", toolCalls: [] };
} };

/** An open Branch, as the app window opens it: its door announced in the data folder. */
async function openBranch(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-b5-"));
  const dataDir = join(root, "data"), workspace = join(root, "workspace");
  const app = await createBranch({ workspace, dataDir, provider: writer });
  savePolicy(app.store, app.runtime.owner, { preset: "ask-before-changes" });
  const server = await startServer(app, { dataDir, port: 0, presence: "app" });
  t.after(async () => { app.store.profiles.switch({ profileId: null }); await server.close(); await app.close(); await discardTemp(root); });
  return { root, app, server, dataDir, workspace };
}
/** The real `branch <command>` in another process, reading the same saved work the open Branch holds. */
async function branchCli(opened, args) {
  const home = join(opened.root, "home");
  await mkdir(home, { recursive: true });
  const env = { ...process.env, HOME: home, BRANCH_DATA_DIR: opened.dataDir, BRANCH_WORKSPACE: opened.workspace, LANG: "en_GB.UTF-8", LC_ALL: "", LC_MESSAGES: "" };
  for (const name of ["FORCE_TTY", "DISPLAY", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME"]) delete env[name];
  return new Promise((resolve) => execFile(process.execPath, ["dist/cli.js", ...args], { env, timeout: 120_000 },
    (error, stdout, stderr) => resolve({ code: error ? error.code ?? 1 : 0, stdout, stderr })));
}
const quiet = () => { const lines = []; return { lines, io: { json: false, env: {}, write: (line) => lines.push(line) } }; };
/** A client of the open Branch that carries the given key instead of this computer's own. */
const clientWith = (server, token) => clientFor({ url: server.url, token, instance: { port: 0, pid: process.pid, url: server.url, mode: "app", version: "t", startedAt: new Date().toISOString() } });

test("B5 beside an open Branch, lockdown is read and switched through its door, as the owner", async (t) => {
  const opened = await openBranch(t);
  const { app } = opened, owner = app.runtime.owner;
  const read = await branchCli(opened, ["lockdown"]);
  assert.equal(read.code, 0, read.stderr);
  assert.doesNotMatch(read.stderr, /already open/);
  assert.match(read.stdout, /^Lockdown is off\.$/m);
  const on = await branchCli(opened, ["pause"]);
  assert.equal(on.code, 0, on.stderr);
  assert.match(on.stdout, /^Lockdown is on, since \d{4}-\d\d-\d\d \d\d:\d\d\./);
  assert.equal(lockdownActive(app.store, owner), true, "the open Branch really is in Lockdown");
  assert.equal(JSON.parse((await branchCli(opened, ["lockdown", "--json"])).stdout).on, true);
  // Under Lockdown the approval settings cannot be changed, from here as from the window.
  const refused = await branchCli(opened, ["permissions", "read-only"]);
  assert.equal(refused.code, 1);
  assert.equal(readPolicy(app.store, owner).preset !== "read-only", true, "nothing was changed");
  const off = await branchCli(opened, ["lockdown", "off"]);
  assert.equal(off.code, 0, off.stderr);
  assert.match(off.stdout, /^Lockdown is off\./);
  assert.equal(lockdownActive(app.store, owner), false);
});

test("B5 beside an open Branch, permissions, theme, model and the gateway change what the window shows", async (t) => {
  const opened = await openBranch(t);
  const { app, dataDir } = opened, owner = app.runtime.owner;
  assert.match((await branchCli(opened, ["permissions"])).stdout, /^\* ask-before-changes — Ask before changes: /m);
  assert.match((await branchCli(opened, ["permissions", "read-only"])).stdout, /\[When to check with me: Read only\]/);
  assert.equal(readPolicy(app.store, owner).preset, "read-only");
  const looser = await branchCli(opened, ["permissions", "off"]);
  assert.equal(looser.code, 1, "a less careful preset needs the owner's separate yes");
  assert.match(looser.stderr, /Run branch permissions off confirm to go ahead\./);
  assert.doesNotMatch(looser.stderr, /Tick /, "the window's tick box is not what a terminal is told to press");
  assert.equal(readPolicy(app.store, owner).preset, "read-only");
  assert.match((await branchCli(opened, ["permissions", "off", "confirm"])).stdout, /\[When to check with me: No approvals\]/);
  assert.equal(readPolicy(app.store, owner).preset, "off");

  assert.match((await branchCli(opened, ["theme", "nord"])).stdout, /^Theme: Nord · dark/m);
  assert.equal(readLook(app.store, owner).theme, "nord");
  const before = app.store.get("settings", owner, "preferences")?.data ?? {};
  assert.match((await branchCli(opened, ["theme", "light"])).stdout, /^Theme: Nord · light/m);
  const after = app.store.get("settings", owner, "preferences").data;
  assert.equal(after.appearance, "daylight");
  for (const [key, value] of Object.entries(before)) if (!["appearance", "followSystem"].includes(key)) assert.deepEqual(after[key], value, `${key} kept`);
  const language = await branchCli(opened, ["theme", "language", "xx"]);
  assert.equal(language.code, 1);
  assert.match(language.stderr, /^Choose a language: auto, en, fr, es, de\./);

  const models = app.runtime.models.summary(owner);
  assert.match((await branchCli(opened, ["model"])).stdout, new RegExp(`^\\* ${models.defaultPreset}\\t`, "m"));
  const used = await branchCli(opened, ["model", "use", models.defaultPreset]);
  assert.equal(used.code, 0, used.stderr);
  assert.match(used.stdout, /^New conversations start with /);
  assert.equal(app.runtime.models.summary(owner).activePreset, models.defaultPreset);

  assert.match((await branchCli(opened, ["gateway"])).stdout, /^The gateway is off$/m);
  assert.match((await branchCli(opened, ["gateway", "on"])).stdout, /^The gateway is on\nSaved\./);
  assert.equal((await loadGatewayConfig(dataDir)).config.mode, "on");
  await branchCli(opened, ["gateway", "off"]);
  assert.equal((await loadGatewayConfig(dataDir)).config.mode, "off");
});

test("B5 approve answers the exact question waiting, once, and the task carries on", async (t) => {
  const opened = await openBranch(t);
  const { app, workspace } = opened, owner = app.runtime.owner;
  const rulesBefore = readPolicy(app.store, owner).rules.length;
  const waiting = await app.runtime.run({ prompt: "write owner.txt" });
  assert.equal(waiting.status, "needs_input", "control: the task stopped to ask");
  const asked = app.runtime.approvals.questionFor(waiting.sessionId);
  assert.match(asked.fingerprint, /^[a-f0-9]{32}$/);

  assert.match((await branchCli(opened, ["status"])).stdout, new RegExp(`waiting for you: ${waiting.id} — `));
  const approved = await branchCli(opened, ["approve", waiting.id, "yes"]);
  assert.equal(approved.code, 0, approved.stderr);
  assert.match(approved.stdout, /^Allowed, just this once: /);
  assert.match(approved.stdout, /^The task carries on\.$/m);
  for (let i = 0; i < 200 && !existsSync(join(workspace, "owner.txt")); i++) await delay(25);
  assert.ok(existsSync(join(workspace, "owner.txt")), "the task carried on and wrote its file");
  assert.equal(readPolicy(app.store, owner).rules.length, rulesBefore, "no standing rule was written from the terminal");
  assert.equal(app.runtime.approvals.questionFor(waiting.sessionId, asked.fingerprint)?.fingerprint === asked.fingerprint, false, "that question is answered");

  const again = await branchCli(opened, ["approve", waiting.id, "yes"]);
  assert.equal(again.code, 1);
  assert.match(again.stderr, /Nothing in that task is waiting for your answer\./);
  const nonsense = await branchCli(opened, ["approve", waiting.id, "maybe"]);
  assert.match(nonsense.stderr, /Answer yes or no/);
});

test("B5 approve refuses a waiting question with no fingerprint and asks for one when there are several", async (t) => {
  const { lines, io } = quiet();
  const fake = (waiting) => ({ url: "x", get: async (path) => (path === "/api/look" ? { language: "en" } : { waiting, presets: [], policy: null }),
    post: async () => { throw new Error("must not answer"); } });
  const one = { runId: "r1", sessionId: "s1", tool: "files.write", target: "a", label: "Write a" };
  await assert.rejects(engineApprove(fake([one]), ["r1", "yes"], { json: false }, io), /not tied to an exact request/);
  const two = [{ ...one, fingerprint: "a".repeat(32) }, { ...one, label: "Write b", fingerprint: "b".repeat(32) }];
  await assert.rejects(engineApprove(fake(two), ["r1", "yes"], { json: false }, io), (error) =>
    /more than one question/.test(error.message) && error.message.includes("aaaaaaaa  Write a") && error.message.includes("bbbbbbbb  Write b"));
  let sent = null;
  const picking = { ...fake(two), post: async (_path, body) => { sent = body; return { task: "carrying-on" }; } };
  await engineApprove(picking, ["r1", "no"], { json: false, request: "bbbb" }, io);
  assert.deepEqual(sent, { sessionId: "s1", decision: "deny", remember: "never", fingerprint: "b".repeat(32), carryOn: true });
  assert.equal(lines[0], "Refused: Write b");
});

test("B5 security: a short-lived key cannot switch Lockdown, change the settings, model or gateway, or answer another task's question", async (t) => {
  const { app, server, dataDir } = await openBranch(t);
  const owner = app.runtime.owner;
  const waiting = await app.runtime.run({ prompt: "write owner.txt" });
  const asked = app.runtime.approvals.questionFor(waiting.sessionId);
  const presetBefore = readPolicy(app.store, owner).preset;
  for (const scope of ["read", "run"]) {
    const client = clientWith(server, app.sessionTokens.create(owner, { name: "script", scope, minutes: 5 }).token);
    const { io } = quiet();
    await assert.rejects(engineLockdown(client, ["on"], io), /./, `${scope}: Lockdown on`);
    assert.equal(lockdownActive(app.store, owner), false, `${scope}: Lockdown stayed off`);
    await assert.rejects(enginePermissions(client, ["read-only"], io), /./, `${scope}: permissions`);
    assert.equal(readPolicy(app.store, owner).preset, presetBefore, `${scope}: the settings stayed`);
    await assert.rejects(engineModel(client, ["use", app.runtime.models.summary(owner).defaultPreset], io), /./, `${scope}: model use`);
    assert.equal(app.runtime.models.summary(owner).activePreset ?? null, null, `${scope}: the model stayed`);
    await assert.rejects(gatewayCommand(client, dataDir, ["on"], io), /./, `${scope}: gateway on`);
    assert.equal((await loadGatewayConfig(dataDir)).config.mode, "off", `${scope}: the gateway stayed off`);
    await assert.rejects(engineApprove(client, [waiting.id, "yes"], { json: false }, io), /./, `${scope}: approve the owner's task`);
    assert.equal(app.runtime.approvals.questionFor(waiting.sessionId, asked.fingerprint)?.fingerprint, asked.fingerprint, `${scope}: still waiting`);
    assert.equal(app.store.run(waiting.id).status, "needs_input", `${scope}: the task still waits`);
  }
  // Turning Lockdown off is the owner's too: with Lockdown on, a run key cannot end it.
  app.store.profiles.switch({ profileId: null });
  const ownerClient = clientWith(server, server.token);
  await engineLockdown(ownerClient, ["on"], quiet().io);
  const runKey = clientWith(server, app.sessionTokens.create(owner, { name: "script", scope: "run", minutes: 5 }).token);
  await assert.rejects(engineLockdown(runKey, ["off"], quiet().io), /short-lived key cannot switch Lockdown/);
  assert.equal(lockdownActive(app.store, owner), true, "Lockdown stayed on");
});

test("B5 security: with the window on a household profile, the local key is refused Lockdown, settings, model and gateway, and never finds the owner's question", async (t) => {
  const opened = await openBranch(t);
  const { app, dataDir } = opened, owner = app.runtime.owner;
  const waiting = await app.runtime.run({ prompt: "write owner.txt" });
  const asked = app.runtime.approvals.questionFor(waiting.sessionId);
  const sam = app.store.profiles.create({ name: "Sam", pin: "2468" });
  app.runtime.roles.save(sam.id, { role: "adult" });
  app.store.profiles.switch({ profileId: sam.id, pin: "2468" });

  const on = await branchCli(opened, ["lockdown", "on"]);
  assert.equal(on.code, 1);
  assert.ok(on.stderr.includes(householdRefusal), on.stderr);
  assert.equal(lockdownActive(app.store, owner), false);
  for (const args of [["permissions", "read-only"], ["model", "use", app.runtime.models.summary(owner).defaultPreset], ["gateway", "on"], ["theme", "nord"]]) {
    const refused = await branchCli(opened, args);
    assert.equal(refused.code, 1, `${args.join(" ")}: ${refused.stdout}`);
  }
  assert.equal(readPolicy(app.store, owner).preset, "ask-before-changes");
  assert.equal((await loadGatewayConfig(dataDir)).config.mode, "off");
  const answer = await branchCli(opened, ["approve", waiting.id, "yes"]);
  assert.equal(answer.code, 1);
  assert.match(answer.stderr, /Nothing in that task is waiting for your answer\./, "the owner's question is not even found");
  assert.equal(app.runtime.approvals.questionFor(waiting.sessionId, asked.fingerprint)?.fingerprint, asked.fingerprint);
  assert.equal(app.store.run(waiting.id).status, "needs_input");

  // Lockdown turned on by the owner cannot be turned off from the household profile either.
  app.store.profiles.switch({ profileId: null });
  assert.equal((await branchCli(opened, ["lockdown", "on"])).code, 0);
  app.store.profiles.switch({ profileId: sam.id, pin: "2468" });
  const off = await branchCli(opened, ["lockdown", "off"]);
  assert.equal(off.code, 1);
  assert.equal(lockdownActive(app.store, owner), true, "Lockdown stayed on");
});

test("B5 security: beside an open Branch that is locked, `branch gateway on` does not write the switch behind its door", async (t) => {
  const opened = await openBranch(t);
  const { app, dataDir } = opened;
  app.sessionLock.setPin({ pin: "2468" });
  app.sessionLock.lock();
  const on = await branchCli(opened, ["gateway", "on"]);
  assert.equal(on.code, 1, on.stdout);
  assert.match(on.stderr, /the gateway was not changed/);
  assert.equal((await loadGatewayConfig(dataDir)).config.mode, "off", "the gateway stayed off");
});
