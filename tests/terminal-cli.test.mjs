import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { discardTemp } from "./temp-dir.mjs";
import { cliCommands } from "../dist/cli-completion.js";
import { PARITY, TERMINAL_ALIASES, TERMINAL_CLI_COMMANDS } from "../dist/terminal-parity.js";
import { terminalArgv } from "../dist/terminal-cli.js";
import { allHomes } from "../dist/terminal-places.js";
import { stripAnsi } from "../dist/terminal-style.js";
import { fixtureModel } from "./fixtures/fixture-model.mjs";

const run = promisify(execFile);
async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-term-cli-"));
  t.after(() => discardTemp(root));
  // The tests' scripted model (tests/fixtures/fixture-model.mjs): without a model named, Branch has none and refuses every task.
  return { ...process.env, ...(await fixtureModel()).env, BRANCH_WORKSPACE: join(root, "ws"), BRANCH_DATA_DIR: join(root, "data"), FORCE_TTY: "0", NO_COLOR: undefined, BRANCH_PORT: "0" };
}

test("with no model set up, branch run is refused in plain words and no model is listed", async (t) => {
  const env = { ...(await workspace(t)), BRANCH_PROVIDER: undefined, BRANCH_MODEL_PRESETS: undefined };
  const task = await branch(env, "run", "say hello");
  assert.notEqual(task.code, 0);
  assert.match(task.out + task.err, /No model yet\. Choose one in setup or in Settings › Models\./);
  assert.doesNotMatch((await branch(env, "models")).out, /demo|Test fixture/i);
  assert.match((await branch(env, "demo")).err, /I do not know the command "demo"/);
});
async function branch(env, ...args) {
  try {
    const { stdout, stderr } = await run(process.execPath, ["dist/cli.js", ...args], { env, maxBuffer: 20e6 });
    return { code: 0, out: stdout, err: stderr };
  } catch (error) {
    return { code: error.code ?? 1, out: error.stdout ?? "", err: error.stderr ?? "" };
  }
}
async function until(read, pattern, what) {
  for (let attempt = 0; attempt < 1200 && !pattern.test(read()); attempt++) await delay(25);
  assert.match(read(), pattern, what);
}

test("names from Hermes and OpenClaw become Branch commands, and nothing at all means the view in a terminal", () => {
  assert.deepEqual(terminalArgv([], true), ["chat"]);
  assert.deepEqual(terminalArgv([], false), ["start"], "a launcher with no terminal still starts the web app");
  assert.deepEqual(terminalArgv(["mcp", "serve"], true), ["mcp-serve"]);
  assert.deepEqual(terminalArgv(["pause"], false), ["lockdown", "on"]);
  assert.deepEqual(terminalArgv(["config", "models"], false), ["settings", "models"]);
  assert.deepEqual(terminalArgv(["--version"], false), ["version"]);
  assert.deepEqual(terminalArgv(["run", "hello"], false), ["run", "hello"]);
  const known = new Set(cliCommands.map((entry) => entry.name));
  for (const entry of TERMINAL_CLI_COMMANDS) assert.ok(known.has(entry.name), `${entry.name} is in the command list, help and completion`);
  for (const [alias, target] of Object.entries(TERMINAL_ALIASES)) assert.ok(known.has(target[0]), `${alias} means a real command`);
});

test("every row of the Hermes and OpenClaw table names a Branch command that exists, or says why not", () => {
  const known = new Set([...cliCommands.map((entry) => entry.name), ...Object.keys(TERMINAL_ALIASES), "branch", "help"]);
  assert.ok(PARITY.length >= 50);
  for (const row of PARITY) {
    assert.ok(["built", "existed", "window", "not applicable"].includes(row.status), row.what);
    if (row.status === "not applicable") { assert.ok(row.note.length > 10, `${row.what} says why`); continue; }
    for (const part of row.branch.split(";")) {
      const words = part.trim().split(/\s+/);
      const name = words[0] === "branch" ? (words[1] ?? "branch").replace(/^<command>$/, "help") : words[0];
      assert.ok(known.has(name) || name === undefined, `${row.what}: ${part.trim()} is not a command`);
    }
    if (row.status === "window") assert.match(`${row.branch} ${row.note}`, /settings|customize|automations|library|inbox/, `${row.what} names its home`);
  }
});

test("bare branch opens the designed view in a terminal and leaves cleanly on Ctrl+D", async (t) => {
  const env = await workspace(t);
  const child = spawn(process.execPath, ["dist/cli.js"], { env: { ...env, FORCE_TTY: "1", COLUMNS: "100", LINES: "26", COLORTERM: "truecolor" } });
  let raw = "";
  child.stdout.on("data", (chunk) => { raw += chunk; });
  child.stderr.on("data", (chunk) => { raw += chunk; });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  await until(() => stripAnsi(raw), /1 Conversation +2 Inbox +3 Automations +4 Library +5 Customize/, "the five places are on the tab row");
  assert.ok(raw.includes("\x1b[?1049h"), "the view is drawn on the terminal's second screen");
  assert.match(raw, /\x1b\[[0-9;]*38;2;/, "a true-colour terminal gets the theme's own colours");
  child.stdin.write("\x04");
  assert.equal(await new Promise((resolve) => child.once("exit", resolve)), 0);
  assert.ok(raw.includes("\x1b[?1049l"), "the terminal's own screen is put back");
  assert.match(raw, /Goodbye/);
});

test("bare branch with no terminal still starts the web app, as launchers expect", async (t) => {
  const env = await workspace(t);
  const child = spawn(process.execPath, ["dist/cli.js"], { env });
  let raw = "";
  child.stdout.on("data", (chunk) => { raw += chunk; });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  await until(() => raw, /listening at http/, "the web app started");
  assert.ok(!raw.includes("\x1b"), "and nothing was drawn");
  child.kill("SIGINT");
  await new Promise((resolve) => child.once("exit", resolve));
});

test("places and Settings pages print by name when there is no terminal", async (t) => {
  const env = await workspace(t);
  const places = JSON.parse((await branch(env, "places", "--json")).out);
  assert.deepEqual(places.homes.map((entry) => entry.home), allHomes());
  const inbox = await branch(env, "inbox", "history");
  assert.equal(inbox.code, 0, inbox.err);
  assert.match(inbox.out, /^Inbox › History\nNothing here yet\./, "headed by the window's names, never an internal id");
  const models = await branch(env, "config", "models", "defaults");
  assert.match(models.out, /^Settings › Models › [^\n]+\n/);
  assert.doesNotMatch(models.out, /settings:models|^#/m);
  const appearance = JSON.parse((await branch(env, "settings", "appearance", "--json")).out);
  assert.equal(appearance.rows[0].command, "/theme list");
  assert.match(appearance.rows[0].title, /Theme: Slate/, "redesign phase 1: a new install wears Slate (owner decision)");
  assert.equal((await branch(env, "overview", "here")).code, 0, "a command advertised by branch places runs");
  assert.equal((await branch(env, "household", "people")).code, 0, "the People command advertised by branch places runs");
  const nowhere = await branch(env, "settings", "nowhere");
  assert.notEqual(nowhere.code, 0);
  assert.match(nowhere.err, /branch places/);
});

test("theme, version, lockdown, permissions and model work from the command line", async (t) => {
  const env = await workspace(t);
  assert.match((await branch(env, "theme", "nord")).out, /Theme: Nord · dark/);
  assert.match((await branch(env, "theme", "light")).out, /Theme: Nord · light/);
  const listed = (await branch(env, "skin")).out;
  assert.match(listed, /^\* nord +Nord$/m, "`skin` lists the 44 with the chosen one marked");
  assert.equal(listed.split("\n").filter((line) => /^[ *] [a-z]/.test(line)).length, 44);
  const bogus = await branch(env, "theme", "neon-nonsense");
  assert.notEqual(bogus.code, 0);
  assert.match(bogus.err, /no theme called neon-nonsense/);
  assert.match((await branch(env, "--version")).out, /^Branch Agent \d+\.\d+\.\d+/);
  assert.match((await branch(env, "pause")).out, /^Lockdown is on/);
  assert.match((await branch(env, "lockdown", "off")).out, /^Lockdown is off\./);
  assert.match((await branch(env, "permissions", "read-only")).out, /When to check with me: Read only/);
  assert.match((await branch(env, "approvals")).out, /\* read-only/);
  assert.match((await branch(env, "models")).out, /^\* default\tDefault connection\tfixture/m);
  const wrong = await branch(env, "model", "use", "nope");
  assert.match(wrong.err, /no model called nope/);
});

test("sessions, resume, tools, usage and the lists print what the window shows", async (t) => {
  const env = await workspace(t);
  const task = await branch(env, "run", "say hello");
  assert.equal(task.code, 0, task.err);
  const sessions = await branch(env, "sessions");
  assert.match(sessions.out, /say hello/);
  // A model's first answer ends setup, which opens the default Trunk's greeting conversation; that one is the newest,
  // so this conversation is named by its number.
  const said = sessions.out.split("\n").find((line) => line.includes("say hello")) ?? "";
  assert.match((await branch(env, "resume", said.slice(0, 8))).out, /you: say hello/, "without a terminal, resume prints the conversation");
  assert.match((await branch(env, "sessions", "show", said.slice(0, 8))).out, /you: say hello/);
  const tools = JSON.parse((await branch(env, "tools", "--json")).out);
  assert.ok(Object.values(tools.toolboxes).flat().includes("files.write"));
  assert.match((await branch(env, "usage")).out, /^Since \d{4}-\d\d-\d\d: \d+ tokens used, about \$\d+\.\d\d\./m);
  const finished = await branch(env, "inbox", "finished");
  assert.match(finished.out, /say hello\tcompleted/);
  for (const name of ["memory", "skills", "channels", "mcp", "projects", "snapshots", "kanban", "hooks", "setup"]) {
    const result = await branch(env, name);
    assert.equal(result.code, 0, `${name}: ${result.err}`);
  }
});

// ---------------------------------------------------------------- B5: the command surface and its words

test("B5 every command cli.ts runs is a command it accepts, so none is refused before it can run", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../src/cli.ts", import.meta.url), "utf8");
  const dispatched = new Set([...source.matchAll(/command === "([a-z][a-z-]*)"/g)].map((match) => match[1]));
  const known = new Set(cliCommands.map((entry) => entry.name));
  for (const name of dispatched) assert.ok(known.has(name), `${name} is run by cli.ts but missing from cliCommands`);
  assert.ok(dispatched.has("qa") && known.has("qa") && known.has("gateway"));
});

test("B5 qa can run, plugins lists, and report --help shows report's own usage", async (t) => {
  const env = await workspace(t);
  const qa = await branch(env, "qa", "list");
  assert.doesNotMatch(qa.err, /I do not know the command/);
  assert.ok((qa.out + qa.err).trim().length > 0, "qa answered");
  const plugins = await branch(env, "plugins");
  assert.equal(plugins.code, 0, plugins.err);
  assert.doesNotMatch(plugins.err, /Provide a plugin id/);
  assert.match((await branch(env, "report", "--help")).out, /branch report --save <file\.zip>/);
});

test("B5 plain output has no internal ids or raw JSON, and --json keeps the machine shape", async (t) => {
  const env = { ...(await workspace(t)), BRANCH_PROVIDER: undefined, BRANCH_MODEL_PRESETS: undefined };
  const doctor = await branch(env, "doctor");
  assert.equal(doctor.code, 0, doctor.err);
  assert.ok(!doctor.out.trimStart().startsWith("{"), "doctor prints lines, not JSON");
  assert.match(doctor.out, /^(Everything checks out\.|Some checks need attention:)$/m);
  assert.ok(JSON.parse((await branch(env, "doctor", "--json")).out).health.items.length);
  const task = await branch(env, "run", "say hello");
  assert.notEqual(task.code, 0);
  assert.ok(!task.out.trimStart().startsWith("{"), "run with no model is not a JSON dump");
  assert.match(task.out, /No model yet\. Choose one in setup or in Settings › Models\./);
  assert.match((await branch(env, "model")).out, /^No model yet\./, "model says there is none rather than nothing");
  const language = await branch(env, "theme", "language", "xx");
  assert.notEqual(language.code, 0);
  assert.match(language.err, /^Choose a language: auto, en, fr, es, de\./);
  assert.doesNotMatch(language.err, /"code"|invalid_enum|\[\s*\{/);
  const status = await branch(env, "status");
  assert.match(status.out, /^When to check with me: [A-Z]/m, "the preset by its name, not its id");
  const places = await branch(env, "places");
  assert.doesNotMatch(places.out, /^inbox:|^settings:/m);
});

test("B5 status, usage, lockdown and empty lists follow the language", async (t) => {
  const env = { ...(await workspace(t)), LANG: "de_DE.UTF-8", LC_ALL: "", LC_MESSAGES: "" };
  const status = await branch(env, "status");
  assert.match(status.out, /^Wann bei mir nachfragen: (Ohne Freigaben|Vor Änderungen fragen|In meinem Arbeitsbereich einfach machen|Deine eigenen Regeln|Nur lesen)$/m,
    "CL-05d: the preset by its German name");
  assert.match(status.out, /^(Alles ist in Ordnung\.|Einige Prüfungen brauchen Aufmerksamkeit:)$/m);
  const presets = (await branch(env, "permissions")).out;
  assert.match(presets, /^ {2}read-only — Nur lesen: Branch Agent darf sich Dinge ansehen/m, "CL-05d: each preset's name and what it does, in German");
  assert.match(presets, /^ {2}careful — Vorsichtig: Alles, was eine Datei ändert/m);
  assert.match((await branch(env, "settings", "permissions")).out, /^Nur lesen	Branch Agent darf sich Dinge ansehen/m, "Settings › Permissions too");
  assert.match((await branch(env, "permissions", "read-only")).out, /^\[Wann bei mir nachfragen: Nur lesen\]$/m);
  assert.match((await branch({ ...env, LANG: "es_ES.UTF-8" }, "status")).out, /^Cuándo consultarme: Solo lectura$/m);
  assert.match((await branch(env, "usage")).out, /Tokens verbraucht/);
  assert.match((await branch(env, "lockdown", "on")).out, /^Der Sperrmodus ist an, seit /);
  assert.match((await branch(env, "status")).out, /^Der Sperrmodus ist an, seit /m, "status says Lockdown is on");
  assert.match((await branch(env, "lockdown", "off")).out, /^Der Sperrmodus ist aus\./);
  assert.match((await branch(env, "inbox", "history")).out, /\nHier ist noch nichts\./);
  assert.match((await branch({ ...env, LANG: "es_ES.UTF-8" }, "lockdown")).out, /^El bloqueo está desactivado\./);
  assert.match((await branch({ ...env, LANG: "fr_FR.UTF-8" }, "lockdown")).out, /^Le verrouillage est désactivé\./);
});

test("B5 branch gateway shows and switches the gateway on or off, with no database opened", async (t) => {
  const env = await workspace(t);
  assert.match((await branch(env, "gateway")).out, /^The gateway is off$/m);
  const on = await branch(env, "gateway", "on");
  assert.equal(on.code, 0, on.err);
  assert.match(on.out, /^The gateway is on\nSaved\. This takes effect the next time Branch starts\./);
  assert.equal(JSON.parse((await branch(env, "gateway", "--json")).out).on, true);
  assert.match((await branch(env, "gateway", "off")).out, /^The gateway is off/);
  const wrong = await branch(env, "gateway", "when-needed");
  assert.notEqual(wrong.code, 0);
  assert.match(wrong.err, /Choose on or off/);
});

test("B5 shell completion offers every command, the names people bring, and each command's action words", async () => {
  const { completionScript, completionWords, completionActions } = await import("../dist/cli-completion.js");
  const words = completionWords();
  for (const entry of cliCommands) assert.ok(words.includes(entry.name), entry.name);
  for (const alias of ["models", "plugins", "config", "approvals", "pause"]) assert.ok(words.includes(alias), alias);
  assert.ok(!words.includes("--version"), "flags are not offered as commands");
  for (const shell of ["bash", "zsh", "fish", "powershell"]) {
    const script = completionScript(shell);
    for (const name of words) assert.match(script, new RegExp(`\\b${name}\\b`), `${shell} offers ${name}`);
    for (const [name, actions] of Object.entries(completionActions))
      assert.ok(script.includes(actions.join(shell === "powershell" ? "', '" : " ")), `${shell} offers ${name}'s ${actions.join(" ")}`);
  }
});
