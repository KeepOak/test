import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer, offLimitsToShortLivedKeys } from "../dist/server.js";
import { COMMANDS, lookup } from "../dist/commands/catalog.js";
import { saveCommandSettings } from "../dist/commands/settings.js";
import { executeCommand } from "../dist/commands/execute.js";
import { commandHost } from "../dist/commands/host.js";
import { findCommand, terminalCommands } from "../dist/terminal-command-table.js";
import { chatCommandHelp, parseChatCommand, runChatCommand } from "../dist/channels/chat-commands.js";
import { lockdownState } from "../dist/lockdown.js";
import { policyPresets, readPolicy } from "../dist/policy.js";

/* Integration review of mac3/commands: the holes found in the adversarial pass, each tested first. */

const PUBLIC = join(import.meta.dirname, "..", "public");
const reply = (text) => ({ name: "scripted", async complete() { return { content: text, toolCalls: [] }; } });

async function fixture(t, provider = reply("Done.")) {
  const root = await mkdtemp(join(tmpdir(), "branch-commands-review-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const call = (path, key = server.token, body) => fetch(server.url + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${key}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const keys = {
    read: app.sessionTokens.create(app.runtime.owner, { name: "wall", scope: "read" }).token,
    run: app.sessionTokens.create(app.runtime.owner, { name: "phone", scope: "run" }).token,
  };
  return { app, server, call, keys, owner: app.runtime.owner };
}
const on = (app, mode = "on") => saveCommandSettings(app.store, app.runtime.owner, { mode });
const otherPreset = (app) => policyPresets().map((p) => p.id).find((id) => id !== readPolicy(app.store, app.runtime.owner).preset);

// ---- 1. short-lived keys and what Branch is allowed to do ------------------------------------------

test("a short-lived key cannot change the approval preset, the default model or the commands switch", async (t) => {
  for (const path of ["/api/policy", "/api/models", "/api/commands/settings", "/api/lockdown"])
    assert.ok(offLimitsToShortLivedKeys("POST", path), `POST ${path} must be off limits to short-lived keys`);
  assert.equal(offLimitsToShortLivedKeys("GET", "/api/policy"), null);
  assert.equal(offLimitsToShortLivedKeys("POST", "/api/policy/approve"), null, "answering a question stays a run key's job");
  assert.equal(offLimitsToShortLivedKeys("POST", "/api/models/switch"), null, "one conversation's model stays a run key's job");
  assert.equal(offLimitsToShortLivedKeys("POST", "/api/commands/run"), null);
  assert.deepEqual(lookup("default").route, { method: "POST", path: "/api/models" }, "/default names the route it stands for");

  const f = await fixture(t);
  const before = readPolicy(f.app.store, f.owner).preset, target = otherPreset(f.app);
  const refused = await f.call("/api/policy", f.keys.run, { preset: target });
  assert.notEqual(refused.status, 200);
  assert.match((await refused.json()).error, /short-lived key/);
  assert.equal(readPolicy(f.app.store, f.owner).preset, before, "the preset did not change");
  const active = f.app.runtime.models.summary(f.owner).activePreset;
  const model = await f.call("/api/models", f.keys.run, { activePreset: active });
  assert.notEqual(model.status, 200);
  assert.equal((await f.call("/api/policy", f.server.token, { preset: target })).status, 200, "the key of this computer may");
  assert.equal(readPolicy(f.app.store, f.owner).preset, target);
});

// ---- 2. typed text never goes into an address -----------------------------------------------------

test("every key sends commands with POST, and a key that may only look can only look", async (t) => {
  const f = await fixture(t);
  on(f.app);
  const run = async (key, line) => f.call("/api/commands/run", key, { surface: "phone", line });
  const status = await run(f.keys.read, "/status");
  assert.equal(status.status, 200);
  assert.match((await status.json()).text, /Nothing is working right now/);
  assert.match((await (await run(f.keys.read, "/lockdown")).json()).text, /Lockdown is off/);
  const lock = await (await run(f.keys.read, "/lockdown on")).json();
  assert.equal(lock.refused, true);
  assert.equal(lockdownState(f.app.store, f.owner).on, false);
  assert.equal((await (await run(f.keys.read, "/stop")).json()).refused, true);
  assert.equal((await (await run(f.keys.read, "/btw what now")).json()).refused, true);
  assert.equal((await (await run(f.keys.read, "/help what is lockdown")).json()).refused, true);
  /* The exception is this one route: a read key still cannot POST anywhere else. */
  assert.equal((await f.call("/api/commands/settings", f.keys.read, { mode: "off" })).status, 401);
  assert.equal((await f.call("/api/run", f.keys.read, { prompt: "hi" })).status, 401);
  /* No key may put a command line into an address. */
  const query = `/api/commands/run?${new URLSearchParams({ surface: "window", line: "/status" })}`;
  assert.equal((await f.call(query)).status, 405);
  assert.equal((await f.call(query, f.keys.read)).status, 405);
  // Redesign: the old window's public/commands.js is gone; the new window sends commands from public/app/** (chat.js,
  // bg.js), so every one of its files is read, with the dashboard's, and at least one of them really sends commands.
  const files = ["dashboard/commands.js", ...(await readdir(join(PUBLIC, "app"), { recursive: true }))
    .filter((name) => name.endsWith(".js")).map((name) => join("app", name))];
  let senders = 0;
  for (const file of files) {
    const source = await readFile(join(PUBLIC, file), "utf8");
    if (/api\("commands\/run", \{/.test(source)) senders++;
    assert.doesNotMatch(source, /commands\/run\?/, `${file} still puts a command into an address`);
  }
  assert.ok(senders >= 1, "the window's command senders were found");
});

test("a command that asks the model counts as a task started, like /api/run", async (t) => {
  const f = await fixture(t);
  on(f.app);
  const take = f.app.executions.take.bind(f.app.executions);
  f.app.executions.take = () => null;
  t.after(() => { f.app.executions.take = take; });
  const busy = await f.call("/api/commands/run", f.keys.run, { surface: "window", line: "/btw what now" });
  assert.equal(busy.status, 429);
});

// ---- 3. switch off = exactly the old command sets ---------------------------------------------------

/* Written out from the sources before this branch (76c5540): src/terminal-command-table.ts,
   src/channels/chat-commands.ts, and the window's app.js + goal.js. */
const OLD_TERMINAL = {
  help: ["?"], model: ["models"], think: ["reasoning"], preset: ["permissions"], memory: [], skills: [], plan: [], verify: [],
  "dry-run": ["practice"], temporary: ["incognito"], attach: ["image"], history: [], export: ["save"], new: ["clear", "reset"],
  sessions: ["resume"], go: ["open"], inbox: [], automations: ["cron"], library: [], customize: ["tools"], settings: ["config"],
  theme: ["skin"], default: [], switch: [], pane: ["details"], lockdown: ["pause"], keys: [], exit: ["quit"],
};
const OLD_CHAT = { stop: ["cancel"], status: [], new: ["reset"], compact: [], usage: [], btw: [], help: [] };
const OLD_WINDOW = { help: [], model: [], goal: [] };
const everyName = COMMANDS.flatMap((c) => [c.name, ...c.aliases]);

test("switch off: the terminal answers to exactly the names it had", () => {
  assert.deepEqual(terminalCommands("off").map((c) => c.name), Object.keys(OLD_TERMINAL));
  const known = new Map(Object.entries(OLD_TERMINAL).flatMap(([name, aliases]) => [[name, name], ...aliases.map((a) => [a, name])]));
  for (const word of everyName) {
    const found = findCommand(`/${word}`, "off");
    if (known.has(word)) assert.equal(found?.name, known.get(word), `/${word} worked in the terminal before`);
    else assert.equal(found, undefined, `/${word} is new to the terminal and must wait for the switch`);
  }
  assert.equal(findCommand("/clear", "on")?.name, "new");
  assert.equal(findCommand("/shortcuts", "on")?.name, "keys");
});

test("switch off: a chat answers to exactly the names it had", () => {
  const known = new Map(Object.entries(OLD_CHAT).flatMap(([name, aliases]) => [[name, name], ...aliases.map((a) => [a, name])]));
  for (const word of everyName) {
    const found = parseChatCommand(`/${word}`, "off");
    if (known.has(word)) assert.equal(found?.name, known.get(word), `/${word} worked in chats before`);
    else assert.equal(found, null, `/${word} is new to chats and must wait for the switch`);
  }
  assert.doesNotMatch(chatCommandHelp("off"), /\/\?/);
  assert.equal(parseChatCommand("/?", "on")?.name, "help");
});

test("switch off: the window and the phone list exactly what they had, with no other names", async (t) => {
  const f = await fixture(t);
  for (const surface of ["window", "phone"]) {
    const list = await (await f.call(`/api/commands?surface=${surface}`)).json();
    assert.deepEqual(Object.fromEntries(list.commands.map((c) => [c.name, c.aliases])), OLD_WINDOW, surface);
  }
  const models = await (await f.call("/api/commands/run", f.server.token, { surface: "window", line: "/models" })).json();
  assert.deepEqual(models, { handled: false }, "/models was a message in the window before");
  on(f.app);
  const later = await (await f.call("/api/commands?surface=window")).json();
  assert.deepEqual(later.commands.find((c) => c.name === "model").aliases, ["models"]);
});

// ---- 4. chat senders --------------------------------------------------------------------------------

const DISGUISES = [
  "/preset {p}", " /preset {p}", "\t/preset {p}", "/PRESET {p}", "/Preset@BranchBot {p}", "／preset {p}", "/pre​set {p}",
  "​/preset {p}", "﻿/preset {p}", "/preset​ {p}", "/permissions {p}", "/approvals {p}", "/lockdown on",
  "/LOCKDOWN@bot on", "/pause on", "/default x", "/switch mouse on", "/goal take over", "/GOAL@bot take over", "/preset\n{p}",
];

test("a chat sender cannot reach an owner-only command however it is spelt", async (t) => {
  for (const command of COMMANDS) {
    if (command.level === "owner" || command.name === "goal") assert.ok(!command.surfaces.includes("chat"), command.name);
  }
  const f = await fixture(t);
  const before = readPolicy(f.app.store, f.owner).preset, target = otherPreset(f.app);
  const lines = DISGUISES.map((line) => line.replace("{p}", target));
  const host = commandHost(f.app.runtime, f.app);
  for (const mode of ["off", "when-needed", "on"]) {
    on(f.app, mode);
    for (const line of lines) {
      const parsed = parseChatCommand(line, mode);
      assert.ok(parsed === null || !["preset", "lockdown", "default", "switch", "goal"].includes(parsed.name), `${mode}: ${JSON.stringify(line)}`);
      const direct = await executeCommand(host, { surface: "chat", line, access: "full" });
      assert.ok(direct === null || direct.refused, `${mode}: ${JSON.stringify(line)}`);
    }
  }
  assert.equal(readPolicy(f.app.store, f.owner).preset, before);
  assert.equal(lockdownState(f.app.store, f.owner).on, false);
});

test("through a real chat, commands and captions leave settings alone", async (t) => {
  const f = await fixture(t);
  on(f.app);
  const before = readPolicy(f.app.store, f.owner).preset, target = otherPreset(f.app);
  const sent = [];
  const adapter = { id: "chat", kind: "fake", botName: () => "Branch", async start() {}, async stop() {},
    async send(chatId, text) { sent.push(text); return String(sent.length); } };
  f.app.channels.mergeWindowMs = 0;
  f.app.channels.setSwitches({ liveStatus: "off", commands: "on", steering: "off", splitting: "off" });
  await f.app.channels.attach(adapter, { activation: "always", pairing: true, allowlist: ["owner"] });
  let id = 0;
  const message = (text, extra = {}) => ({ channel: "chat", chatId: "c1", chatKind: "direct", senderId: "owner",
    senderName: "Sam", text, addressed: true, messageId: `m${id++}`, ...extra });
  for (const line of [`/preset ${target}`, "/lockdown on", "/default x", `/Preset@BranchBot ${target}`])
    await f.app.channels.handle(message(line));
  await f.app.channels.handle(message("/lockdown on", { voice: { mediaType: "audio/ogg", bytes: async () => new Uint8Array([1]) } }));
  await f.app.channels.idle?.();
  assert.equal(readPolicy(f.app.store, f.owner).preset, before);
  assert.equal(lockdownState(f.app.store, f.owner).on, false);
});

// ---- 5. side questions and handbook answers ---------------------------------------------------------

test("/btw and /help <question> ask with no tools, in a conversation that is not kept, and never join the task", async (t) => {
  const f = await fixture(t, reply("An answer."));
  on(f.app);
  const first = await f.app.runtime.run({ prompt: "remember the file is notes.txt", permissions: [] });
  const stored = f.app.store.messages(first.sessionId).length;
  const asked = [];
  const real = f.app.runtime.run.bind(f.app.runtime);
  f.app.runtime.run = (options) => { asked.push(options); return real(options); };
  const chat = { runtime: f.app.runtime, channel: "chat", chatId: "c1", sessionId: first.sessionId, turn: undefined,
    permissions: ["files.read"], dropWaiting: () => false, forget: () => undefined };
  assert.match(await runChatCommand({ name: "btw", argument: "what was the file?" }, chat), /\(on the side\) An answer\./);
  assert.match(await runChatCommand({ name: "help", argument: "what is lockdown" }, chat), /An answer\.[\s\S]*From the handbook/);
  const host = commandHost(f.app.runtime, f.app);
  await executeCommand(host, { surface: "window", line: "/btw and now?", sessionId: first.sessionId, access: "run" });
  await executeCommand(host, { surface: "terminal", line: "/help how do schedules work", sessionId: first.sessionId, access: "full" });
  assert.equal(asked.length, 4);
  for (const options of asked) {
    assert.deepEqual(options.permissions, [], "no tools");
    assert.equal(options.temporary, true, "not kept");
    assert.equal(options.sessionId, undefined, "not the task's conversation");
  }
  assert.match(asked[1].prompt, /using only the handbook passages/);
  assert.match(asked[3].prompt, /using only the handbook passages/);
  assert.equal(f.app.store.messages(first.sessionId).length, stored, "the conversation is unchanged");
});

test("/help <question> from a chat waits for a free slot, like /btw", async (t) => {
  const f = await fixture(t, reply("An answer."));
  on(f.app);
  const sent = [];
  const adapter = { id: "chat", kind: "fake", botName: () => "Branch", async start() {}, async stop() {},
    async send(chatId, text) { sent.push(text); return String(sent.length); } };
  f.app.channels.mergeWindowMs = 0;
  f.app.channels.setSwitches({ liveStatus: "off", commands: "on", steering: "off", splitting: "off" });
  await f.app.channels.attach(adapter, { activation: "always", pairing: true, allowlist: ["owner"] });
  let slots = 0;
  const withSlot = f.app.channels.withSlot.bind(f.app.channels);
  f.app.channels.withSlot = (work) => { slots += 1; return withSlot(work); };
  const base = { channel: "chat", chatId: "c1", chatKind: "direct", senderId: "owner", senderName: "Sam", addressed: true };
  await f.app.channels.handle({ ...base, text: "/help", messageId: "h1" });
  assert.equal(slots, 0, "the plain list asks nobody");
  await f.app.channels.handle({ ...base, text: "/help what is lockdown", messageId: "h2" });
  assert.equal(slots, 1);
  assert.ok(sent.some((text) => /From the handbook/.test(text)), JSON.stringify(sent));
});

test("/tokens reports sizes and a price, never what the conversation says", async (t) => {
  const f = await fixture(t);
  on(f.app);
  const secret = "hunter2-do-not-show";
  const first = await f.app.runtime.run({ prompt: `my password is ${secret}`, permissions: [] });
  const host = commandHost(f.app.runtime, f.app);
  for (const surface of ["chat", "window", "terminal"]) {
    const outcome = await executeCommand(host, { surface, line: "/tokens", sessionId: first.sessionId, access: surface === "terminal" ? "full" : "run" });
    assert.match(outcome.text, /room left/);
    assert.doesNotMatch(outcome.text, new RegExp(secret));
    assert.doesNotMatch(outcome.text, new RegExp(f.server.token));
  }
});

// ---- 6. the API description -------------------------------------------------------------------------

test("the web API description lists the commands and dashboard routes, and docs/api.md matches it", async () => {
  const { apiRoutes, apiMarkdown, openApiDocument } = await import("../dist/api-openapi.js");
  const listed = new Set(apiRoutes.map((route) => `${route.method} ${route.path}`));
  for (const route of ["get /api/commands", "get /api/commands/table", "post /api/commands/run", "get /api/commands/settings",
    "post /api/commands/settings", "get /api/dashboard", "get /api/dashboard/settings", "post /api/dashboard/settings",
    "post /api/dashboard/automations", "post /api/dashboard/restart"])
    assert.ok(listed.has(route), route);
  assert.ok(!listed.has("get /api/commands/run"), "commands are never sent in an address");
  const run = openApiDocument("1.0.0").paths["/api/commands/run"].post;
  assert.deepEqual(Object.keys(run.requestBody.content["application/json"].schema.properties).sort(), ["line", "sessionId", "surface"]);
  const written = await readFile(join(import.meta.dirname, "..", "docs", "api.md"), "utf8");
  const version = /^Version (\S+)\. /m.exec(written)[1];
  assert.equal(written, apiMarkdown(openApiDocument(version)), "docs/api.md is what scripts/write-api-docs.mjs writes");
});

// ---- 7. looking stays looking ---------------------------------------------------------------------------

test("a key that may only look keeps looking: its commands do not keep the session awake", async (t) => {
  const f = await fixture(t);
  on(f.app);
  let touched = 0;
  const touch = f.app.sessionLock.touch.bind(f.app.sessionLock);
  f.app.sessionLock.touch = (...args) => { touched += 1; return touch(...args); };
  const send = (key) => f.call("/api/commands/run", key, { surface: "window", line: "/status" });
  assert.equal((await send(f.keys.read)).status, 200);
  assert.equal(touched, 0, "a wall screen asking /status every few seconds must not stop the lock");
  assert.equal((await send(f.keys.run)).status, 200);
  assert.equal(touched, 1, "a key that may act still counts as activity");
});

test("the dashboard's commands follow the dashboard's own switch", async (t) => {
  const { saveDashboardSettings } = await import("../dist/dashboard-api.js");
  const f = await fixture(t);
  on(f.app);
  saveDashboardSettings(f.app.store, f.owner, { mode: "off" });
  assert.equal((await f.call("/api/commands?surface=dashboard")).status, 404);
  assert.equal((await f.call("/api/commands/run", f.server.token, { surface: "dashboard", line: "/status" })).status, 404);
  assert.equal((await f.call("/api/commands/run", f.server.token, { surface: "window", line: "/status" })).status, 200);
  saveDashboardSettings(f.app.store, f.owner, { mode: "on" });
  assert.equal((await f.call("/api/commands?surface=dashboard")).status, 200);
  assert.equal((await f.call("/api/commands/run", f.server.token, { surface: "dashboard", line: "/status" })).status, 200);
});
