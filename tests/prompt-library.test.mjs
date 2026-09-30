import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, ToolRegistry, Budget } from "../dist/index.js";
import { startServer, offLimitsToShortLivedKeys } from "../dist/server.js";
import {
  blanksIn, fillPrompt, readArguments, savePrompt, listPrompts, savePromptLibrarySettings, promptLibrarySettings,
  exportPrompts, importPrompts, removePrompt, promptGroups,
} from "../dist/prompt-library.js";
import { EXAMPLES, addExamples, exampleMcpConfig, exampleServerId } from "../dist/prompt-examples.js";
import { savedCommandFor, savedLine, takenByCatalog, runSavedCommand, savedCommandRows } from "../dist/commands/saved.js";
import { executeCommand } from "../dist/commands/execute.js";
import { commandHost } from "../dist/commands/host.js";
import { saveCommandSettings } from "../dist/commands/settings.js";
import { lookup } from "../dist/commands/catalog.js";
import { runCommand } from "../dist/terminal-command-table.js";
import { startTerminal } from "../dist/terminal.js";
import { connectMcp, mcpToolName } from "../dist/integrations/mcp.js";
import { loadIntegrations } from "../dist/integrations/bootstrap.js";

/* Bucket 12: the owner's saved prompts, their own commands on every surface, the starter examples and
   the example tool server. Every model and chat service here is a stand-in. */

const lastUser = (request) => String(request.messages.filter((m) => m.role === "user").at(-1)?.content ?? "");
function recording(reply = (request) => `Echo: ${lastUser(request)}`) {
  const model = { name: "scripted", seen: [] };
  model.complete = async (request) => { model.seen.push(lastUser(request)); return { content: reply(request), toolCalls: [] }; };
  return model;
}
async function fixture(t, model = recording()) {
  const root = await mkdtemp(join(tmpdir(), "branch-prompts-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: model });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const call = (path, body, key = server.token) => fetch(server.url + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${key}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = async (path, body, key) => { const response = await call(path, body, key); return { status: response.status, body: await response.json() }; };
  return { app, server, call, json, model, root, owner: app.runtime.owner, store: app.store };
}
const on = (store, owner, mode = "on") => savePromptLibrarySettings(store, owner, { mode });
const weekly = { title: "Weekly review", body: "Review the week since {{day}}. {{input}}", group: "Routines", command: "weekly" };

// ---- A2001: the library itself ------------------------------------------------------------------

test("A2001: blanks are found, filled from name=value and free words, and a half-filled prompt is refused", () => {
  assert.deepEqual(blanksIn("Hi {{ name }}, today is {{today}}; {{input}} {{name}} {{topic}}"), ["name", "topic"]);
  assert.deepEqual(readArguments('day=monday tone="very short" and the rest'), { named: { day: "monday", tone: "very short" }, rest: "and the rest" });
  const now = new Date("2026-09-17T10:00:00Z");
  assert.equal(fillPrompt("Summarise {{address}}", {}, "https://example.test", now), "Summarise https://example.test");
  assert.equal(fillPrompt("Plain words", {}, "extra", now), "Plain words\n\nextra");
  assert.equal(fillPrompt("On {{today}}: {{input}}", {}, "go", now), "On 2026-09-17: go");
  assert.equal(fillPrompt("{{a}} and {{b}}", { a: "x" }, "y", now), "x and y");
  assert.throws(() => fillPrompt("{{a}} and {{b}}", {}, "", now), /needs a=… b=…/);
  assert.throws(() => fillPrompt("{{a}} and {{b}}", {}, "only one", now), /needs a=… b=…/, "free words never guess between two blanks");
});

test("A2001: the switch ships on; switched off it refuses in one sentence; on, prompts are saved in groups with earlier wordings", async (t) => {
  const { store, owner } = await fixture(t);
  assert.equal(promptLibrarySettings(store, owner).mode, "on", "the owner's rule (ships on, 2026-09-26)");
  on(store, owner, "off");
  assert.equal(promptLibrarySettings(store, owner).mode, "off", "an explicit off stays off");
  assert.throws(() => savePrompt(store, owner, weekly, takenByCatalog), /switched off/);
  on(store, owner);
  const first = savePrompt(store, owner, weekly, takenByCatalog);
  savePrompt(store, owner, { title: "Loose one", body: "Say hi" }, takenByCatalog);
  const second = savePrompt(store, owner, { ...weekly, id: first.id, body: "Review the week since {{day}}, briefly." }, takenByCatalog);
  assert.equal(second.id, first.id);
  assert.deepEqual(second.versions.map((v) => v.body), [weekly.body], "the earlier wording is kept");
  assert.deepEqual(promptGroups(listPrompts(store, owner)), [{ name: "Routines", count: 1 }, { name: "", count: 1 }]);
  assert.throws(() => savePrompt(store, owner, { title: "Key", body: "use sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789" }, takenByCatalog), /not saved/); // not-a-real-secret
  assert.throws(() => savePrompt(store, owner, { title: "Slash", body: "/stop now" }, takenByCatalog), /cannot start with \//);
  assert.deepEqual(removePrompt(store, owner, first.id), { removed: true });
  assert.equal(listPrompts(store, owner).length, 1);
});

test("A2001: a library file carries prompts to another install, without keys and without stealing commands", async (t) => {
  const { store, owner } = await fixture(t);
  on(store, owner);
  savePrompt(store, owner, weekly, takenByCatalog);
  const file = exportPrompts(store, owner);
  assert.equal(file.format, "branch-prompt-library");
  const other = await fixture(t);
  on(other.store, other.owner);
  savePrompt(other.store, other.owner, { title: "Mine", body: "Mine", command: "weekly" }, takenByCatalog);
  const result = importPrompts(other.store, other.owner, file, takenByCatalog);
  assert.deepEqual(result.added, ["Weekly review"]);
  assert.match(result.notes.join(" "), /without its command \/weekly/);
  assert.deepEqual(importPrompts(other.store, other.owner, file, takenByCatalog).skipped, ["Weekly review"]);
});

// ---- family custom-commands: the owner's own commands on every surface ---------------------------

test("custom commands: a shipped name can never be taken, and a saved command is at most a 'run' command", async (t) => {
  const { store, owner, app } = await fixture(t);
  on(store, owner);
  for (const shipped of ["stop", "lockdown", "cancel", "prompts", "help", "preset", "approvals"])
    assert.throws(() => savePrompt(store, owner, { title: shipped, body: "x", command: shipped }, takenByCatalog), /already one of Branch's own commands/, shipped);
  savePrompt(store, owner, weekly, takenByCatalog);
  assert.throws(() => savePrompt(store, owner, { title: "Again", body: "x", command: "weekly" }, takenByCatalog), /already opens/);
  assert.equal(lookup("weekly"), undefined, "the shipped table itself is unchanged");
  const host = commandHost(app.runtime, app);
  assert.equal(runSavedCommand(host, { surface: "window", line: "/weekly day=monday", access: "read" }).refused, true, "a key that may only look cannot start a task this way");
  const chat = runSavedCommand(host, { surface: "chat", line: "/weekly day=monday", access: "run" });
  assert.equal(chat.refused, undefined, "a chat may use it: it is only a message");
  assert.equal(runSavedCommand(host, { surface: "dashboard", line: "/weekly day=monday", access: "full" }), null, "the dashboard has no message box");
  assert.ok(savedCommandRows(store, owner).every((row) => row.level === "run"));
});

test("custom commands: the window turns one into the message it stands for, and the switch decides the menus", async (t) => {
  const { store, owner, json } = await fixture(t);
  on(store, owner);
  savePrompt(store, owner, weekly, takenByCatalog);
  const ran = await json("/api/commands/run", { surface: "window", line: "/weekly day=monday keep it short" });
  assert.equal(ran.status, 200);
  assert.deepEqual(ran.body.client, { do: "send", text: "Review the week since monday. keep it short" });
  const missing = await json("/api/commands/run", { surface: "phone", line: "/weekly" });
  assert.match(missing.body.text, /needs day=…/);
  assert.equal(missing.body.client, undefined, "nothing is sent while a blank is empty");
  let listed = (await json("/api/commands?surface=window")).body.commands.find((row) => row.name === "weekly");
  assert.equal(listed.listed, true);
  on(store, owner, "when-needed");
  listed = (await json("/api/commands?surface=window")).body.commands.find((row) => row.name === "weekly");
  assert.equal(listed.listed, false, "when needed: it works but menus leave it out");
  assert.equal((await json("/api/commands/run", { surface: "window", line: "/weekly day=monday" })).body.handled, true);
  on(store, owner, "off");
  assert.equal((await json("/api/commands?surface=window")).body.commands.some((row) => row.name === "weekly"), false);
  assert.equal((await json("/api/commands/run", { surface: "window", line: "/weekly day=monday" })).body.handled, false, "off: a typed /weekly is what it always was");
  assert.equal(savedCommandFor(store, owner, "/weekly"), null);
});

test("custom commands: the terminal views send the finished message, and say what is missing", async (t) => {
  const { app, store, owner, model } = await fixture(t);
  on(store, owner);
  savePrompt(store, owner, weekly, takenByCatalog);
  const sent = [], said = [];
  const conversation = { sessionId: undefined, send: async (text) => { sent.push(text); } };
  const context = { runtime: app.runtime, conversation, words: { t: (_k, english) => english }, say: (kind, text) => said.push([kind, text]) };
  await runCommand(context, "/weekly day=friday");
  await runCommand(context, "/weekly");
  await runCommand(context, "/nothing-here");
  assert.deepEqual(sent, ["Review the week since friday."]);
  assert.match(said[0][1], /needs day=…/);
  assert.match(said[1][1], /I do not know \/nothing-here/);

  const input = new PassThrough(), output = new PassThrough();
  let printed = "";
  output.on("data", (chunk) => { printed += chunk.toString(); });
  const done = startTerminal(app.runtime, { input, output, signals: new EventEmitter(), terminal: false, pollIntervalMs: 5 });
  input.write("/weekly day=sunday\n");
  for (let i = 0; i < 300 && !model.seen.length; i++) await delay(10);
  input.write("/exit\n");
  input.end();
  await done;
  assert.deepEqual(model.seen, ["Review the week since sunday."]);
  assert.match(printed, /Echo: Review the week since sunday\./);
});

test("custom commands: a chat app sends the message it stands for, only while chat commands are read", async (t) => {
  const { app, store, owner, model } = await fixture(t);
  on(store, owner);
  savePrompt(store, owner, weekly, takenByCatalog);
  const replies = [];
  const adapter = { id: "chat", kind: "fake", botName: () => "Branch", async start() {}, async stop() {},
    async send(_chatId, text) { replies.push(text); return String(replies.length); } };
  app.channels.mergeWindowMs = 0;
  await app.channels.attach(adapter, { activation: "always", pairing: true, allowlist: ["owner"] });
  let id = 0;
  const say = (text) => app.channels.handle({ channel: "chat", chatId: "c1", chatKind: "direct", senderId: "owner", senderName: "Sam", text, addressed: true, messageId: `m${++id}` });
  app.channels.setSwitches({ liveStatus: "off", commands: "on", steering: "off", splitting: "off" });
  await say("/weekly");
  assert.match(replies.at(-1), /needs day=…/);
  await say("/weekly day=tuesday");
  for (let i = 0; i < 300 && !model.seen.length; i++) await delay(10);
  assert.deepEqual(model.seen, ["Review the week since tuesday."]);
  app.channels.setSwitches({ liveStatus: "off", commands: "off", steering: "off", splitting: "off" });
  await say("/weekly day=wednesday");
  for (let i = 0; i < 300 && model.seen.length < 2; i++) await delay(10);
  assert.equal(model.seen[1], "/weekly day=wednesday", "with chat commands off, the line is an ordinary message");
});

// ---- A0147: browsing and loading saved prompts and procedures -------------------------------------

test("A0147: /prompts lists saved prompts and procedures, and loads one into the message box without sending it", async (t) => {
  const { app, store, owner } = await fixture(t);
  saveCommandSettings(store, owner, { mode: "on" });
  store.save("procedures", owner, "11111111-1111-4111-8111-111111111111", {
    version: 1, status: "verified", history: [],
    definition: { name: "Tidy downloads", preconditions: [], parameters: { folder: { type: "string", required: true } }, steps: [{ tool: "files.list", args: {}, expected: {} }] },
  });
  // The ship-on rule turns saved prompts on; this test starts with them off to see procedures listed alone.
  on(store, owner, "off");
  const host = commandHost(app.runtime, app);
  const list = await executeCommand(host, { surface: "terminal", line: "/prompts", access: "full" });
  assert.match(list.text, /Saved prompts are switched off/);
  assert.match(list.text, /Tidy downloads \(verified, 1 steps, needs folder\)/);
  const one = await executeCommand(host, { surface: "window", line: "/procedures tidy downloads", access: "read" });
  assert.equal(one.refused, undefined, "looking needs any key");
  assert.deepEqual(one.client, { do: "fill", text: 'Run my saved procedure "Tidy downloads" with folder = ….' });
  on(store, owner);
  savePrompt(store, owner, weekly, takenByCatalog);
  const prompt = await executeCommand(host, { surface: "chat", line: "/prompts weekly", access: "run" });
  assert.match(prompt.text, /Weekly review \(\/weekly\)[\s\S]*Fill in: day\./);
  assert.equal(prompt.client.do, "fill");
  assert.match((await executeCommand(host, { surface: "window", line: "/prompts", access: "full" })).text, /\[Routines\] \/weekly — Weekly review/);
});

test("A0147: with Typed commands left off, saved prompts on still gives /weekly and /prompts on every surface", async (t) => {
  const { app, store, owner, json } = await fixture(t);
  on(store, owner, "when-needed");
  savePrompt(store, owner, weekly, takenByCatalog);
  const window = await json("/api/commands/run", { surface: "window", line: "/prompts" });
  assert.equal(window.body.handled, true);
  assert.match(window.body.text, /\/weekly — Weekly review/);
  assert.equal((await json("/api/commands/run", { surface: "phone", line: "/prompts weekly" })).body.client.do, "fill");
  assert.equal((await json("/api/commands/run", { surface: "window", line: "/weekly day=monday" })).body.client.do, "send");
  const rows = (await json("/api/commands?surface=window")).body.commands.filter((row) => row.name === "prompts");
  assert.equal(rows.length, 1, "one /prompts row while the shipped one is not offered");
  assert.match(savedLine(store, owner, "/procedures").reply, /Your saved prompts/);
  const said = [];
  const context = { runtime: app.runtime, conversation: { send: async () => assert.fail("nothing is sent") }, words: { t: (_k, english) => english }, say: (kind, text) => said.push(text) };
  await runCommand(context, "/prompts");
  assert.ok(said.some((line) => /Weekly review/.test(line)));
  saveCommandSettings(store, owner, { mode: "on" });
  const both = (await json("/api/commands?surface=window")).body.commands.filter((row) => row.name === "prompts");
  assert.equal(both.length, 1, "with the shipped one offered, no second row");
  on(store, owner, "off");
  saveCommandSettings(store, owner, { mode: "off" });
  assert.equal((await json("/api/commands/run", { surface: "window", line: "/prompts" })).body.handled, false, "both off: /prompts is what it always was");
});

// ---- A1882: writing and trying a prompt ---------------------------------------------------------

test("A1882: the prompt editor's routes save, try on two models side by side with no tools, and stay the owner's", async (t) => {
  const model = recording((request) => `${request.tools?.length ?? 0} tools · ${lastUser(request)}`);
  const { app, json, call } = await fixture(t, model);
  assert.equal((await json("/api/prompts")).body.settings.mode, "on", "the owner's rule (ships on, 2026-09-26)");
  assert.equal((await json("/api/prompts/settings", { mode: "off" })).status, 200);
  assert.equal((await json("/api/prompts")).body.settings.mode, "off", "switched off through its own route");
  assert.match((await json("/api/prompts", weekly)).body.error, /switched off/);
  assert.equal((await json("/api/prompts/settings", { mode: "on" })).status, 200);
  const saved = await json("/api/prompts", weekly);
  assert.equal(saved.status, 200);
  const view = (await json("/api/prompts")).body;
  assert.deepEqual(view.prompts[0].blanks, ["day"]);
  assert.equal(view.groups[0].name, "Routines");
  const presets = app.runtime.models.summary(app.runtime.owner).presets.map((preset) => preset.id);
  const tried = await json("/api/prompts/try", { body: weekly.body, values: { day: "monday" }, input: "short", models: presets.slice(0, 2) });
  assert.equal(tried.status, 200, JSON.stringify(tried.body));
  assert.equal(tried.body.message, "Review the week since monday. short");
  assert.equal(tried.body.answers.length, Math.min(2, presets.length));
  for (const answer of tried.body.answers) assert.equal(answer.output, "0 tools · Review the week since monday. short", "a try carries no tools");
  assert.equal(app.store.recentSessions(app.runtime.owner, 10).sessions.length, 0, "a try keeps no conversation");
  // A short-lived key may read the list but change nothing, try nothing and switch nothing.
  const key = app.sessionTokens.create(app.runtime.owner, { name: "script", scope: "run" }).token;
  assert.equal((await call("/api/prompts", undefined, key)).status, 200);
  for (const path of ["/api/prompts", "/api/prompts/settings", "/api/prompts/remove", "/api/prompts/import", "/api/prompts/examples", "/api/prompts/try"]) {
    assert.ok(offLimitsToShortLivedKeys("POST", path), path);
    assert.equal((await call(path, {}, key)).status, 401, path);
  }
});

// ---- family examples (A1282): starter prompts and the example tool server -------------------------

test("examples: the starter prompts are added on request, keep clear of shipped names, and the example server's snippet is exact", async (t) => {
  const { store, owner, json } = await fixture(t);
  assert.equal(listPrompts(store, owner).length, 0, "nothing is added by itself");
  on(store, owner);
  const added = (await json("/api/prompts/examples", {})).body;
  assert.deepEqual(added.added, EXAMPLES.map((example) => example.title));
  assert.ok(EXAMPLES.every((example) => !takenByCatalog(example.command)));
  assert.equal((await json("/api/prompts/examples", {})).body.added.length, 0, "adding twice adds nothing");
  const config = added.mcp.mcp[0];
  assert.deepEqual(config, exampleMcpConfig());
  assert.equal(config.id, exampleServerId);
  assert.deepEqual(config.tools, ["add_note", "list_notes"]);
  assert.ok(savedLine(store, owner, "/notes-example buy milk").text.includes("keep this note: buy milk"));
});

test("examples (A1282): the shipped tool server connects through the integrations file and a saved command uses its tools", async (t) => {
  const direct = new ToolRegistry();
  const connection = await connectMcp(direct, exampleMcpConfig(), {});
  const context = (permissions) => ({ owner: "test", workspace: ".", runId: "test", signal: new AbortController().signal, budget: new Budget(), permissions: new Set(permissions), depth: 0 });
  try {
    const add = mcpToolName(exampleServerId, "add_note"), list = mcpToolName(exampleServerId, "list_notes");
    assert.deepEqual(connection.tools.sort(), [add, list].sort());
    await direct.execute(add, { text: "first" }, context([add]));
    const listed = await direct.execute(list, {}, context([list]));
    assert.deepEqual(JSON.parse(listed.content[0].text), { notes: ["first"] });
    await assert.rejects(direct.execute(add, { text: "" }, context([add])));
  } finally { await connection.close(); }

  // The same server, connected the way the card says, used by a task started from the saved command.
  const add = mcpToolName(exampleServerId, "add_note");
  let round = 0;
  const model = { name: "scripted", async complete(request) {
    round += 1;
    // A task reaches a tool it knows the name of by loading it first, as any installed tool.
    if (round === 1) return { content: "", toolCalls: [{ id: "d1", name: "tools.describe", arguments: JSON.stringify({ names: [add] }) }] };
    if (round === 2) {
      assert.ok(request.tools.some((tool) => tool.name === add), "the example server's tool is offered to the task");
      return { content: "", toolCalls: [{ id: "n1", name: add, arguments: JSON.stringify({ text: "buy milk" }) }] };
    }
    return { content: `Kept: ${request.messages.at(-1).content}`, toolCalls: [] };
  } };
  const { app, store, owner, root } = await fixture(t, model);
  const file = join(root, "integrations.json");
  await writeFile(file, JSON.stringify(addExamplesAndConfig(store, owner)));
  const integrations = await loadIntegrations(app.runtime.registry, file, {});
  t.after(() => integrations.close());
  const prompt = savedLine(store, owner, "/notes-example buy milk").text;
  const run = await app.runtime.run({ prompt, permissions: [add] });
  assert.equal(run.status, "completed", run.output);
  assert.match(run.output, /buy milk/);
});
function addExamplesAndConfig(store, owner) {
  on(store, owner);
  return addExamples(store, owner, takenByCatalog).mcp;
}

// ---- integrator adversarial pass (bucket 12) ------------------------------------------------------

test("integrator: what fills a blank can never turn a saved prompt into another command", async (t) => {
  assert.throws(() => fillPrompt("{{input}} please", {}, "/stop"), /read as a command/);
  assert.throws(() => fillPrompt("{{topic}}", { topic: "/exit" }), /read as a command/);
  assert.throws(() => fillPrompt("{{topic}}", { topic: "​ /exit" }), /read as a command/);
  assert.throws(() => fillPrompt("{{topic}}", { topic: "／exit" }), /read as a command/);
  assert.equal(fillPrompt("Look at {{topic}}", { topic: "/etc/hosts" }), "Look at /etc/hosts", "a slash inside the text is fine");

  const { app, store, owner, model } = await fixture(t);
  on(store, owner);
  savePrompt(store, owner, { title: "Echo", body: "{{input}}", command: "echo" }, takenByCatalog);
  const expanded = savedLine(store, owner, "/echo /stop");
  assert.ok("problem" in expanded, "the filled text is refused, not sent");

  // A paired chat sender cannot reach a shipped command through the owner's saved one.
  const replies = [];
  const adapter = { id: "chat", kind: "fake", botName: () => "Branch", async start() {}, async stop() {},
    async send(_chatId, text) { replies.push(text); return String(replies.length); } };
  app.channels.mergeWindowMs = 0;
  await app.channels.attach(adapter, { activation: "always", pairing: true, allowlist: ["owner"] });
  app.channels.setSwitches({ liveStatus: "off", commands: "on", steering: "off", splitting: "off" });
  await app.channels.handle({ channel: "chat", chatId: "c9", chatKind: "direct", senderId: "owner", senderName: "Sam",
    text: "/echo /new", addressed: true, messageId: "x1" });
  assert.match(replies.at(-1), /read as a command/);
  assert.equal(model.seen.length, 0);

  // The terminal conversation stays open when the filled text would have said /exit.
  const input = new PassThrough(), output = new PassThrough();
  let written = "";
  output.on("data", (chunk) => { written += chunk; });
  const done = startTerminal(app.runtime, { input, output, signals: new EventEmitter(), terminal: false, pollIntervalMs: 5 });
  input.write("/echo /exit\n");
  for (let i = 0; i < 100 && !/read as a command/.test(written); i++) await delay(10);
  assert.match(written, /read as a command/);
  input.end();
  await done;
});

test("integrator: a library file with prototype keys or oversized fields is refused whole", async (t) => {
  const { store, owner } = await fixture(t);
  on(store, owner);
  const polluted = JSON.parse('{"format":"branch-prompt-library","version":1,"prompts":[{"title":"A","body":"B","__proto__":{"polluted":true}}]}');
  assert.throws(() => importPrompts(store, owner, polluted, takenByCatalog));
  const outer = JSON.parse('{"format":"branch-prompt-library","version":1,"prompts":[],"__proto__":{"polluted":true}}');
  assert.throws(() => importPrompts(store, owner, outer, takenByCatalog));
  assert.equal({}.polluted, undefined);
  const huge = { format: "branch-prompt-library", version: 1, prompts: [{ title: "x".repeat(100_000), body: "Hello" }] };
  assert.throws(() => importPrompts(store, owner, huge, takenByCatalog));
  assert.equal(listPrompts(store, owner).length, 0);
});

test("integrator: a try is refused once the monthly budget is spent", async (t) => {
  const { store, owner, json, model } = await fixture(t);
  on(store, owner);
  store.save("settings", owner, "usage_budget", { maxMonthlyTokens: 0, pauseAtBudget: true });
  const tried = await json("/api/prompts/try", { body: "Say hello" });
  assert.notEqual(tried.status, 200);
  assert.match(tried.body.error, /budget/i);
  assert.equal(model.seen.length, 0);
});

test("integrator: a try stops after two model steps even when the model keeps asking for tools", async (t) => {
  let calls = 0;
  const looping = { name: "looping", seen: [], complete: async () => {
    calls += 1;
    return { content: "", toolCalls: [{ id: `c${calls}`, name: "workspace_read", arguments: JSON.stringify({ path: "a.txt" }) }] };
  } };
  const { store, owner, json } = await fixture(t, looping);
  on(store, owner);
  const tried = await json("/api/prompts/try", { body: "Keep going" });
  assert.equal(tried.status, 200);
  assert.ok(calls <= 2, `asked the model ${calls} times`);
});
