import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer, offLimitsToShortLivedKeys } from "../dist/server.js";
import { COMMANDS, lookup, parseLine, surfaces } from "../dist/commands/catalog.js";
import { commandsFor, commandSettings, saveCommandSettings } from "../dist/commands/settings.js";
import { HANDLERS, parseGoal } from "../dist/commands/handlers.js";
import { executeCommand, refusalFor } from "../dist/commands/execute.js";
import { commandHost } from "../dist/commands/host.js";
import { PARITY } from "../dist/commands/parity.js";
import { findPassages, answerFromHandbook } from "../dist/commands/docs-answer.js";
import { tokenReport, tokenLines } from "../dist/commands/tokens.js";
import { helpText } from "../dist/commands/help-text.js";
import { TERMINAL_COMMANDS, terminalCommands, runCommand, helpLines } from "../dist/terminal-command-table.js";
import { chatCommands, chatCommandsFor, chatCommandHelp, parseChatCommand, runChatCommand } from "../dist/channels/chat-commands.js";
import { lockdownState } from "../dist/lockdown.js";
import { policyPresets, readPolicy } from "../dist/policy.js";

/* Wave mac3 (commands): one slash-command table for every surface. Model and chat services are stand-ins. */

const PUBLIC = join(import.meta.dirname, "..", "public");
/** The new window's files (public/app/**) and the dashboard's command file, relative to public/. */
const windowFiles = async () => ["dashboard/commands.js", ...(await readdir(join(PUBLIC, "app"), { recursive: true }))
  .filter((name) => name.endsWith(".js")).map((name) => join("app", name))];
const reply = (text) => ({ name: "scripted", async complete() { return { content: text, toolCalls: [] }; } });

async function fixture(t, provider = reply("Done.")) {
  const root = await mkdtemp(join(tmpdir(), "branch-commands-"));
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

// ---- the table itself ---------------------------------------------------------------------------

test("the table has one entry per name, and no name or other name is used twice", () => {
  const seen = new Set();
  for (const command of COMMANDS) {
    for (const name of [command.name, ...command.aliases]) {
      assert.ok(!seen.has(name), `/${name} is used twice`);
      seen.add(name);
    }
    assert.ok(command.surfaces.length, command.name);
    for (const place of command.legacy) assert.ok(command.surfaces.includes(place), `${command.name} was on ${place} but is not listed there`);
    for (const [place, names] of Object.entries(command.newAliases ?? {})) {
      assert.ok(command.legacy.includes(place), `${command.name}: new names on ${place}, which never had it`);
      for (const alias of names) assert.ok(command.aliases.includes(alias), `${command.name}: ${alias}`);
    }
    assert.equal(command.key, `commands.${command.name}`);
  }
  assert.deepEqual(surfaces, ["window", "phone", "terminal", "chat", "dashboard"]);
  assert.equal(lookup("/stop@BranchBot").name, "stop");
  assert.deepEqual(parseLine("  /BTW what now "), { command: lookup("btw"), argument: "what now" });
  assert.equal(parseLine("please /stop"), null);
  assert.equal(lookup("clear", true), undefined, "a name this table added is not read while the switch is off");
  assert.equal(lookup("reset", true).name, "new", "an old name still is");
});

test("every command has words in English and real French", async () => {
  const en = JSON.parse(await readFile(join(PUBLIC, "locales", "en.json"), "utf8"));
  const fr = JSON.parse(await readFile(join(PUBLIC, "locales", "fr.json"), "utf8"));
  for (const command of COMMANDS) {
    assert.equal(typeof en[command.key], "string", `${command.key} has no English`);
    assert.equal(typeof fr[command.key], "string", `${command.key} has no French`);
    assert.notEqual(fr[command.key], en[command.key], `${command.key} is English in the French file`);
  }
  // Redesign: the old window's public/commands.js is gone; the words the new window and the dashboard use for commands
  // are read from every file of theirs.
  const used = new Set();
  for (const file of await windowFiles()) {
    const source = await readFile(join(PUBLIC, file), "utf8");
    for (const m of source.matchAll(/"(commands\.[\w.]+)"/g)) used.add(m[1]);
  }
  assert.ok(used.size >= 1, "the window's command words were found");
  for (const key of used) {
    assert.equal(typeof en[key], "string", `${key} has no English`);
    assert.notEqual(fr[key], en[key], `${key} is not in French`);
  }
  assert.ok(!Object.keys(en).some((key) => key.startsWith("terminal.command.")), "the terminal's old keys moved to the shared table");
});

test("a command that changes permissions or settings asks at least what its route asks, and never runs from a chat", () => {
  for (const command of COMMANDS) {
    if (command.level === "owner") assert.ok(!command.surfaces.includes("chat"), `/${command.name} is offered to chat apps`);
    if (!command.route) continue;
    const routeRefuses = offLimitsToShortLivedKeys(command.route.method, command.route.path) !== null;
    if (routeRefuses) assert.equal(command.level, "owner", `/${command.name} stands for ${command.route.path}, which a short-lived key may not use`);
  }
  assert.equal(lookup("lockdown").level, "owner");
  assert.equal(lookup("preset").level, "owner");
  assert.match(refusalFor("owner", "run", "window"), /key of this computer/);
  assert.match(refusalFor("run", "read", "phone"), /only look/);
  assert.match(refusalFor("owner", "full", "chat"), /not from a chat/);
  assert.equal(refusalFor("look", "read", "dashboard"), null);
});

test("every command resolves to a real action on every surface it claims", async (t) => {
  const { app } = await fixture(t);
  on(app);
  const all = (surface) => new Set(commandsFor(surface, "on", true).map((command) => command.name));
  for (const command of COMMANDS) {
    for (const surface of command.surfaces) {
      assert.ok(all(surface).has(command.name), `/${command.name} is not offered on ${surface} with the switch on`);
      if (["window", "phone", "dashboard"].includes(surface)) assert.equal(typeof HANDLERS[command.name], "function", `/${command.name} on ${surface}`);
    }
  }
  /* The terminal: each command really runs, and none is answered with "I do not know". */
  const said = [];
  const context = terminalContext(app, said);
  for (const command of terminalCommands("on", true)) {
    said.length = 0;
    if (["exit", "attach", "theme"].includes(command.name)) { assert.equal(typeof command.run, "function"); continue; }
    await runCommand(context, `/${command.name}`);
    assert.ok(!said.some(([, text]) => /I do not know/.test(text)), `terminal /${command.name}: ${JSON.stringify(said)}`);
  }
  /* The chat apps: the same. */
  const chat = chatContext(app);
  for (const command of chatCommandsFor("on", true)) {
    const answer = await runChatCommand({ name: command.name, argument: "" }, chat);
    assert.equal(typeof answer, "string", command.name);
    assert.doesNotMatch(answer, /I do not know that command/, `chat /${command.name}`);
  }
  assert.deepEqual(chatCommandsFor("on", true).map((c) => c.name).sort(), COMMANDS.filter((c) => c.surfaces.includes("chat")).map((c) => c.name).sort());
});

function terminalContext(app, said) {
  const conversation = { sessionId: undefined, attachments: [], plan: false, verify: false, dryRun: false, temporary: false, reasoning: null };
  const note = (label) => () => said.push(["note", label]);
  return {
    runtime: app.runtime, conversation, words: { t: (_key, english) => english },
    say: (kind, text) => said.push([kind, text]), open: note("open"), theme: async () => undefined, togglePane: note("pane"),
    lockdown: note("lockdown"), switchSetting: note("switch"), resume: note("resume"), sessions: note("sessions"),
    newConversation: note("new"), quit: note("quit"), keys: note("keys"), host: commandHost(app.runtime, app),
  };
}
function chatContext(app, extra = {}) {
  return {
    runtime: app.runtime, channel: "chat", chatId: "c1", sessionId: undefined, turn: undefined,
    permissions: ["files.read", "memory.search"], dropWaiting: () => false, forget: () => undefined, ...extra,
  };
}

// ---- no surface keeps a list of its own -----------------------------------------------------------

test("each surface's list is the table filtered for it, and the old lists are what they were", async () => {
  assert.deepEqual(TERMINAL_COMMANDS.map((c) => c.name), COMMANDS.filter((c) => c.legacy.includes("terminal")).map((c) => c.name));
  assert.equal(TERMINAL_COMMANDS.length, 28, "the terminal keeps its 28 commands while the switch is off");
  assert.deepEqual(chatCommands.map((c) => c.name).sort(), ["btw", "compact", "help", "new", "status", "stop", "usage"]);
  assert.deepEqual(terminalCommands("on").map((c) => c.name), COMMANDS.filter((c) => c.surfaces.includes("terminal")).map((c) => c.name));
  assert.deepEqual(terminalCommands("when-needed").map((c) => c.name), TERMINAL_COMMANDS.map((c) => c.name), "when needed lists the everyday ones");
  assert.equal(terminalCommands("when-needed", true).length, terminalCommands("on").length);
  const words = { t: (_key, english) => english };
  assert.equal(helpLines(words).length, 2 + TERMINAL_COMMANDS.length);
  assert.match(helpLines(words, "when-needed").at(-1), /\/help all/);
  // Redesign: the old window's public/app.js (SLASH_COMMANDS) is gone. The new window's "/" list is read from the table
  // (public/app/chat/messages.js, GET /api/commands?surface=window), and no file of the window writes a command row.
  const messages = await readFile(join(PUBLIC, "app", "chat", "messages.js"), "utf8");
  assert.match(messages, /api\("commands\?surface=window"\)/, "the window's list is read from the table");
  for (const file of await windowFiles())
    assert.doesNotMatch(await readFile(join(PUBLIC, file), "utf8"), /\["\/model", "|\{ name: "model", /, `no command row is written into ${file}`);
  const chatSource = await readFile(join(import.meta.dirname, "..", "src", "channels", "chat-commands.ts"), "utf8");
  assert.doesNotMatch(chatSource, /\{ name: "stop", aliases:/, "the chat apps' old table is gone");
});

test("/help lists only what that surface can do", () => {
  const chat = helpText("chat", "on");
  assert.match(chat, /^\/tokens/m);
  assert.doesNotMatch(chat, /^\/lockdown/m, "a chat is never offered a command that changes settings");
  assert.doesNotMatch(chat, /^\/go /m);
  const dashboard = helpText("dashboard", "on");
  assert.match(dashboard, /^\/lockdown/m);
  assert.doesNotMatch(dashboard, /^\/model/m);
  assert.doesNotMatch(helpText("window", "off"), /^\/tokens/m, "off: the window keeps its two");
  assert.deepEqual(helpText("window", "off").split("\n").slice(1).map((line) => line.split(" ")[0]), ["/help", "/model", "/goal"]);
  assert.match(helpText("window", "when-needed"), /\/help all/);
  assert.match(chatCommandHelp(), /^\/stop \[task\] \(or \/cancel\)/m);
  assert.doesNotMatch(chatCommandHelp(), /\/clear|\/side|\/cost/, "names this table added are not offered while it is off");
  assert.match(chatCommandHelp("on"), /^\/tokens/m);
});

// ---- the switch -----------------------------------------------------------------------------------

test("the switch ships off: the window keeps /model and /help, and anything else is a message as before", async (t) => {
  const f = await fixture(t);
  assert.equal(commandSettings(f.app.store, f.owner).mode, "off");
  const list = await (await f.call("/api/commands?surface=window")).json();
  assert.deepEqual(list.commands.map((c) => c.name), ["help", "model", "goal"]);
  const model = await (await f.call("/api/commands/run", f.server.token, { surface: "window", line: "/model" })).json();
  assert.equal(model.handled, true);
  assert.match(model.text, /Type \/model followed by a name/);
  const tokens = await (await f.call("/api/commands/run", f.server.token, { surface: "window", line: "/tokens" })).json();
  assert.deepEqual(tokens, { handled: false });
  assert.equal(parseChatCommand("/tokens"), null, "a chat reads /tokens as an ordinary message");
  assert.equal(parseChatCommand("/clear"), null);
  assert.deepEqual(parseChatCommand("/reset"), { name: "new", argument: "" });

  const saved = await f.call("/api/commands/settings", f.server.token, { mode: "when-needed" });
  assert.equal(saved.status, 200);
  const later = await (await f.call("/api/commands?surface=window")).json();
  assert.equal(later.mode, "when-needed");
  assert.ok(later.commands.some((c) => c.name === "tokens" && !c.listed), "when needed: it works but is not listed");
  assert.deepEqual(parseChatCommand("/tokens", "when-needed"), { name: "tokens", argument: "" });
  assert.equal((await f.call("/api/commands/settings", f.server.token, { mode: "always" })).status, 400);
});

test("changing the switch needs the key of this computer", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.call("/api/commands/settings", f.keys.run, { mode: "on" })).status, 401, "off limits to short-lived keys");
  assert.equal((await f.call("/api/commands/settings", f.keys.read, { mode: "on" })).status, 401);
  assert.equal(commandSettings(f.app.store, f.owner).mode, "off");
  assert.deepEqual(await (await f.call("/api/commands/settings", f.keys.read)).json(), { mode: "off", access: "read" });
  assert.equal((await fetch(f.server.url + "/api/commands")).status, 401, "nothing is reachable without a key");
  assert.equal((await f.call("/api/commands?surface=terminal")).status, 400, "the terminal and the chat apps are not web surfaces");
});

// ---- keys and permissions -------------------------------------------------------------------------

test("each key does what its route would let it do, and no more", async (t) => {
  const f = await fixture(t);
  on(f.app);
  const run = (key, line) => f.call("/api/commands/run", key, { surface: "phone", line });
  /* A key that may only look: POST like every key (integration review), and only commands that look. */
  const status = await (await run(f.keys.read, "/status")).json();
  assert.match(status.text, /Nothing is working right now/);
  assert.equal((await (await run(f.keys.read, "/lockdown on")).json()).refused, true);
  assert.match((await (await run(f.keys.read, "/lockdown")).json()).text, /Lockdown is off/);
  assert.match((await (await run(f.keys.read, "/whoami")).json()).text, /may only look/);
  /* A key that may run tasks cannot change settings or permissions. */
  const refused = await (await run(f.keys.run, "/lockdown on")).json();
  assert.equal(refused.refused, true);
  assert.match(refused.text, /key of this computer/);
  assert.equal(lockdownState(f.app.store, f.owner).on, false);
  assert.equal((await (await run(f.keys.run, "/preset read-only")).json()).refused, true);
  assert.equal((await (await run(f.keys.run, "/default x")).json()).refused, true);
  assert.equal((await (await run(f.keys.run, "/stop")).json()).refused, undefined, "stopping is starting's other half");
  /* The key of this computer may, and turning Lockdown on ends the yeses already given, as the route does. */
  let forgot = 0;
  const forgetAll = f.app.runtime.approvals.forgetAll.bind(f.app.runtime.approvals);
  f.app.runtime.approvals.forgetAll = () => { forgot += 1; return forgetAll(); };
  const done = await (await run(f.server.token, "/lockdown on")).json();
  assert.match(done.text, /Lockdown is on/);
  assert.equal(lockdownState(f.app.store, f.owner).on, true);
  assert.equal(forgot, 1);
  /* A conversation that is not the owner's is not found. */
  const other = await f.call("/api/commands/run", f.server.token, { surface: "window", line: "/tokens", sessionId: "00000000-0000-4000-8000-000000000000" });
  assert.equal(other.status, 404);
});

test("settings and permissions stay with the owner's own profile in the terminal and the window alike", async (t) => {
  const f = await fixture(t);
  on(f.app);
  const before = readPolicy(f.app.store, f.owner).preset;
  const target = policyPresets().map((preset) => preset.id).find((id) => id !== before);
  const sam = f.app.store.profiles.create({ name: "Sam", pin: "4321" });
  f.app.store.profiles.switch({ profileId: sam.id, pin: "4321" });
  const said = [];
  await runCommand(terminalContext(f.app, said), `/preset ${target}`);
  assert.ok(said.some(([kind, text]) => kind === "bad" && /belongs to the owner/.test(text)), JSON.stringify(said));
  await runCommand(terminalContext(f.app, said), "/tokens");
  const refused = await (await f.call("/api/commands/run", f.server.token, { surface: "window", line: `/preset ${target}` })).json();
  assert.match(refused.text, /belongs to the owner/);
  const shared = await executeCommand(commandHost(f.app.runtime, f.app), { surface: "terminal", line: "/lockdown on", access: "full" });
  assert.match(shared.text, /belongs to the owner/);
  assert.equal(readPolicy(f.app.store, f.owner).preset, before, "nothing changed");
  assert.equal(lockdownState(f.app.store, f.owner).on, false);
  f.app.store.profiles.switch({ profileId: null });
  said.length = 0;
  await runCommand(terminalContext(f.app, said), `/preset ${target}`);
  assert.equal(readPolicy(f.app.store, f.owner).preset, target, "the owner may");
});

test("a chat sender never gets more than the chat allows", async (t) => {
  const { app } = await fixture(t);
  on(app);
  assert.equal(parseChatCommand("/preset read-only", "on"), null, "a settings command is an ordinary message in a chat");
  assert.equal(parseChatCommand("/lockdown off", "on"), null);
  assert.equal(parseChatCommand("/goal take over", "on"), null, "a goal would run with the owner's tools, so chats cannot start one");
  const direct = await executeCommand(commandHost(app.runtime, app), { surface: "chat", line: "/lockdown off", access: "full" });
  assert.equal(direct, null, "not a chat command even with the strongest key");
  const who = await runChatCommand({ name: "whoami", argument: "" }, chatContext(app));
  assert.match(who, /files\.read, memory\.search/);
  assert.match(who, /may not run programs/);
});

// ---- the commands the table added -----------------------------------------------------------------

test("/help <question> answers from Branch's own handbook", async (t) => {
  assert.ok(findPassages("lockdown every tool waits").length > 0);
  const offline = await answerFromHandbook("how do I pair my phone", null);
  assert.match(offline, /From the handbook:/);
  assert.match(await answerFromHandbook("zzqqxx", null), /says nothing about that/);
  const asked = [];
  const answered = await answerFromHandbook("how do I pair my phone", async (prompt) => { asked.push(prompt); return "Scan the code."; });
  assert.match(answered, /^Scan the code\./);
  assert.match(asked[0], /using only the handbook passages/);
  const { app } = await fixture(t, reply("Open Settings and scan the code."));
  on(app);
  const outcome = await executeCommand(commandHost(app.runtime, app), { surface: "window", line: "/help how do I reach Branch from my phone", access: "full" });
  assert.match(outcome.text, /Open Settings and scan the code\.[\s\S]*From the handbook/);
  const list = await executeCommand(commandHost(app.runtime, app), { surface: "window", line: "/help all", access: "read" });
  assert.match(list.text, /^\/tokens/m);
  const looking = await executeCommand(commandHost(app.runtime, app), { surface: "window", line: "/help what is lockdown", access: "read" });
  assert.equal(looking.refused, true, "a question asks the model, which a key that may only look may not do");
});

test("/tokens reports what the last task measured, and /usage what it cost", async (t) => {
  const { app } = await fixture(t);
  on(app);
  const run = await app.runtime.run({ prompt: "hello there", permissions: [] });
  const report = tokenReport(app.runtime, run.sessionId);
  assert.equal(report.measured, "last task");
  assert.ok(report.instructions > 0 && report.conversation > 0, JSON.stringify(report));
  assert.equal(report.messages >= 2, true);
  const lines = tokenLines(report).join("\n");
  assert.match(lines, /instructions/);
  assert.match(lines, /would cost/);
  const host = commandHost(app.runtime, app);
  const tokens = await executeCommand(host, { surface: "terminal", line: "/tokens", sessionId: run.sessionId, access: "full" });
  assert.match(tokens.text, /conversation\s+\d/);
  const usage = await executeCommand(host, { surface: "window", line: "/usage", sessionId: run.sessionId, access: "read" });
  assert.match(usage.text, /This conversation: \d+ tokens in/);
  assert.match(usage.text, /This month/);
  const none = await executeCommand(host, { surface: "window", line: "/tokens", access: "read" });
  assert.match(none.text, /Start a conversation first/);
});

test("/goal uses goal mode when this copy has it, and says so when it does not", async (t) => {
  {
    const { app } = await fixture(t);
    on(app);
    const real = await executeCommand(commandHost(app.runtime, app), { surface: "terminal", line: "/goal the tests pass", access: "full" });
    assert.match(real.text, /Goal mode is off/, "this copy has goal mode, which has its own switch and ships off");
  }
  assert.deepEqual(parseGoal("tests pass --max 4"), { objective: "tests pass", maxRounds: 4 });
  assert.deepEqual(parseGoal("tests pass"), { objective: "tests pass" });
  assert.throws(() => parseGoal("--max 3"), /Say what the goal is/);
  assert.throws(() => parseGoal("x --max 40"), /1 to 20/);
  const { app } = await fixture(t);
  on(app);
  const bare = commandHost(app.runtime);
  assert.match((await executeCommand(bare, { surface: "window", line: "/goal ship it", access: "run" })).text, /not part of this copy/);
  const started = [];
  const goals = {
    async start(input) { started.push(input); return { status: "working", round: 1, maxRounds: input.maxRounds ?? 6, objective: input.objective, sessionId: "11111111-1111-4111-8111-111111111111" }; },
    status: () => null, pause: () => { throw new Error("no"); }, resume: async () => { throw new Error("no"); }, stop: () => { throw new Error("no"); },
  };
  const outcome = await executeCommand({ ...bare, goals }, { surface: "window", line: "/goal the tests pass --max 3", access: "run" });
  assert.deepEqual(started, [{ objective: "the tests pass", maxRounds: 3 }]);
  assert.match(outcome.text, /Goal \(working, round 1 of 3\): the tests pass/);
  assert.deepEqual(outcome.client, { do: "open-session", id: "11111111-1111-4111-8111-111111111111" });
  assert.equal((await executeCommand({ ...bare, goals }, { surface: "window", line: "/goal x", access: "read" })).refused, true);
});

test("/stop, /status, /whoami, /version and /health answer in words", async (t) => {
  const { app } = await fixture(t);
  on(app);
  const host = commandHost(app.runtime, app);
  const ask = (line, surface = "dashboard", access = "full") => executeCommand(host, { surface, line, access });
  assert.match((await ask("/stop")).text, /Nothing is working right now/);
  assert.match((await ask("/stop abc")).text, /No working task has that id/);
  assert.match((await ask("/status")).text, /When to check with you/);
  assert.match((await ask("/whoami")).text, /key of this computer/);
  assert.match((await ask("/version")).text, /^Branch Agent \d+\.\d+\.\d+/);
  const health = await ask("/doctor");
  assert.equal(health.command, "health");
  assert.match(health.text, /database|Database/);
  assert.deepEqual((await ask("/go inbox finished", "window")).client, { do: "go", home: "inbox:finished" });
  assert.deepEqual((await ask("/settings appearance", "window")).client, { do: "go", home: "settings:appearance" });
  assert.match((await ask("/go nowhere", "window")).text, /no place called/);
  assert.equal(await ask("/model", "dashboard"), null, "the dashboard does not offer /model");
});

// ---- the parity table -----------------------------------------------------------------------------

test("every parity row names a real Branch command or says why there is none", () => {
  assert.ok(PARITY.length >= 40);
  for (const row of PARITY) {
    if (row.branch === "—") { assert.ok(row.note, row.what); assert.notEqual(row.status, "built"); continue; }
    const name = row.branch.split(/\s/)[0];
    assert.ok(lookup(name), `${row.what}: ${name} is not in the table`);
  }
  for (const name of ["tokens", "btw", "goal", "help"]) assert.ok(PARITY.some((row) => row.branch.startsWith(`/${name}`)), name);
});
