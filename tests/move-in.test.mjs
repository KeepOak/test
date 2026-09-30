import test from "node:test";
import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { placesFor, recognise } from "../dist/migrate/detect.js";
import { archiveTree, folderTree, openSource, unzip, untar } from "../dist/migrate/source-tree.js";
import { scanSource, placeInput, previewOf, foundSources, offerSentence } from "../dist/migrate/scan.js";
import { bringOver, broughtServers, broughtSettings } from "../dist/migrate/apply.js";
import { parseToml } from "../dist/migrate/toml.js";
import { normaliseSkill, serverFrom } from "../dist/migrate/common.js";
import { zipWrite } from "../dist/skill-package.js";
import {
  SECRET, claudeHome, codexHome, hermesHome, openclawHome, opencodeHome, tarOf, skillDocument,
} from "./move-in-fixtures.mjs";

/**
 * Moving in from another assistant. Every home folder here is a made-up one written in that
 * assistant's own format (tests/move-in-fixtures.mjs); the owner's real folders are never read.
 */

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-move-in-"));
  const provider = { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const home = join(root, "home");
  await mkdir(home, { recursive: true });
  return { app, root, home, owner: app.runtime.owner };
}

const inputs = { platform: process.platform, env: {} };
const placeOf = (home, source) => placesFor({ ...inputs, home }).find((place) => place.source === source);

async function scanned(home, source) {
  const scan = await scanSource(source, placeInput(placeOf(home, source)));
  return scan;
}

const byKind = (scan, kind) => scan.items.filter((item) => item.kind === kind);
const everything = (scan) => scan.items.map((item) => item.key);

/** Everything Branch keeps, as one string, so a secret anywhere in it is found. */
function wholeDatabase(app) {
  return JSON.stringify(app.store.backup("test").tables);
}

// ------------------------------------------------------------------ where each assistant lives

test("each assistant's folder is found from the platform, the environment and the home folder alone", () => {
  const mac = placesFor({ platform: "darwin", env: {}, home: "/Users/sam" });
  assert.deepEqual(mac.map((place) => [place.source, place.root]), [
    ["claude-code", "/Users/sam/.claude"], ["codex", "/Users/sam/.codex"], ["hermes", "/Users/sam/.hermes"],
    ["openclaw", "/Users/sam/.openclaw"], ["opencode", "/Users/sam/.local/share/opencode"],
  ]);
  assert.deepEqual(mac[0].extras, [{ name: "claude-json", folder: "/Users/sam", only: [".claude.json"] }]);
  assert.equal(mac[1].extras[0].folder, "/Users/sam/.agents/skills");
  assert.equal(mac[4].extras[0].folder, "/Users/sam/.config/opencode");

  const linux = placesFor({ platform: "linux", home: "/home/sam", env: {
    XDG_DATA_HOME: "/data", XDG_CONFIG_HOME: "/conf", CODEX_HOME: "/opt/codex", CLAUDE_CONFIG_DIR: "/opt/claude",
    HERMES_HOME: "/opt/hermes", OPENCLAW_STATE_DIR: "/opt/claw" } });
  assert.deepEqual(linux.map((place) => place.root), ["/opt/claude", "/opt/codex", "/opt/hermes", "/opt/claw", "/data/opencode"]);
  assert.equal(linux[4].extras[0].folder, "/conf/opencode");

  const windows = placesFor({ platform: "win32", home: "C:\\Users\\sam", env: { LOCALAPPDATA: "C:\\Users\\sam\\AppData\\Local" } });
  assert.deepEqual(windows.map((place) => place.root), [
    "C:\\Users\\sam\\.claude", "C:\\Users\\sam\\.codex", "C:\\Users\\sam\\AppData\\Local\\hermes",
    "C:\\Users\\sam\\.openclaw", "C:\\Users\\sam\\.local\\share\\opencode",
  ]);
  // Hermes falls back to ~/.hermes on Windows when LOCALAPPDATA is missing, and a blank override is ignored.
  assert.equal(placesFor({ platform: "win32", home: "C:\\u", env: { CODEX_HOME: "  " } })[2].root, "C:\\u\\.hermes");
  assert.equal(placesFor({ platform: "win32", home: "C:\\u", env: { CODEX_HOME: "  " } })[1].root, "C:\\u\\.codex");
});

test("a folder is recognised by what is inside it, not by its name", async (t) => {
  const { home } = await fixture(t);
  await Promise.all([claudeHome(home), codexHome(home), hermesHome(home), openclawHome(home), opencodeHome(home)]);
  assert.equal(await recognise(folderTree(join(home, ".claude"))), "claude-code");
  assert.equal(await recognise(folderTree(join(home, ".codex"))), "codex");
  assert.equal(await recognise(folderTree(join(home, ".hermes"))), "hermes");
  assert.equal(await recognise(folderTree(join(home, ".openclaw"))), "openclaw");
  assert.equal(await recognise(folderTree(join(home, ".local/share/opencode"))), "opencode");
  assert.equal(await recognise(folderTree(join(home, ".agents"))), null);
  // A Codex folder without its settings file is still Codex, even though it has a `memories` folder.
  const bare = zipWrite([["sessions/2026/01/01/rollout-a.jsonl", "{}"], ["memories/MEMORY.md", "x"]]);
  assert.equal(await recognise(archiveTree("codex.zip", bare)), "codex");
  assert.equal(await recognise(archiveTree("hermes.zip", zipWrite([["memories/USER.md", "x"], ["SOUL.md", "calm"]]))), "hermes");
});

// ------------------------------------------------------------------ reading safely

test("a source folder cannot be climbed out of, and links inside it are not followed", async (t) => {
  const { root, home } = await fixture(t);
  await writeFile(join(root, "outside.txt"), "OUTSIDE");
  await mkdir(join(home, "src"), { recursive: true });
  await writeFile(join(home, "src", "inside.txt"), "inside");
  const tree = folderTree(join(home, "src"));
  assert.equal(await tree.read("inside.txt"), "inside");
  assert.equal(await tree.read("../../outside.txt"), null);
  assert.equal(await tree.read("/etc/hosts"), null, "a leading slash still means inside the folder");
  assert.equal(await tree.read("inside.txt", 3), null, "a file over the limit is not read");
  const only = folderTree(home, ["src"]);
  assert.deepEqual((await only.list("")).map((entry) => entry.name), ["src"]);
  assert.equal(await folderTree(home, [".claude.json"]).read("src/inside.txt"), null);
  if (process.platform === "win32") return; // making a link needs extra rights on Windows
  await symlink(join(root, "outside.txt"), join(home, "src", "link.txt"));
  assert.equal(await tree.read("link.txt"), null);
  assert.ok(!(await tree.list("")).some((entry) => entry.name === "link.txt"));
});

test("zip and tar copies are opened in memory, keep to their limits, and drop names that climb out", async () => {
  const zip = zipWrite([[".claude/CLAUDE.md", "Be brief."], [".claude/settings.json", "{}"], ["../../evil.txt", "x"]]);
  const files = unzip(zip);
  assert.deepEqual([...files.keys()].sort(), [".claude/CLAUDE.md", ".claude/settings.json"]);
  const tree = archiveTree("claude.zip", zip);
  assert.equal(await tree.read("CLAUDE.md"), "Be brief.", "the one folder everything sits in becomes the top");
  assert.equal(await recognise(tree), "claude-code");

  const long = `.codex/sessions/${"deep/".repeat(25)}rollout-x.jsonl`;
  const tar = tarOf([[".codex/config.toml", 'model = "m"'], ["../escape", "x"], ["/abs/../../escape", "y"], [long, "{}\n"]]);
  const unpacked = untar(tar);
  assert.ok(unpacked.has(".codex/config.toml"));
  assert.ok(unpacked.has(long), "a pax long name is honoured");
  assert.ok(![...unpacked.keys()].some((name) => name.includes("escape")));
  assert.equal(untar(tarOf([["a.txt", "plain"]], false)).get("a.txt").data.toString(), "plain");
  assert.equal(await recognise(archiveTree("codex.tgz", tar)), "codex");
  assert.throws(() => archiveTree("notes.txt", Buffer.from("hello")), /zip, .tar or .tar.gz/);
  assert.throws(() => unzip(Buffer.from("not a zip at all, not at all")), /not a zip/);
});

test("openSource takes a folder or an archive file and refuses anything else", async (t) => {
  const { root } = await fixture(t);
  const file = join(root, "copy.zip");
  await writeFile(file, zipWrite([["CLAUDE.md", "Hi"]]));
  assert.equal(await (await openSource(file)).read("CLAUDE.md"), "Hi");
  assert.equal((await openSource(root)).label, root);
  await assert.rejects(openSource(join(root, "missing")), /nothing at that place/);
});

test("the small TOML reader understands what Codex writes, and gives up rather than guess", () => {
  const parsed = parseToml([
    "# comment", 'model = "gpt" # trailing', "count = 1_000", "ratio = 0.5", "on = true", "when = 2026-01-02",
    "[a.b]", "x = 'literal\\n'", '"quoted key" = "tab\\there \\u00e9"', "list = [1, 2,", "  3,]",
    "inline = { k = \"v\", n.m = 2 }", "[[arr]]", "dropped = 1", "[c]", 'multi = """', "one", 'two"""', "d.e = 5",
  ].join("\n"));
  assert.equal(parsed.model, "gpt");
  assert.equal(parsed.count, 1000);
  assert.equal(parsed.ratio, 0.5);
  assert.equal(parsed.on, true);
  assert.equal(parsed.when, "2026-01-02");
  assert.equal(parsed.a.b.x, "literal\\n");
  assert.equal(parsed.a.b["quoted key"], "tab\there é");
  assert.deepEqual(parsed.a.b.list, [1, 2, 3]);
  assert.deepEqual(parsed.a.b.inline, { k: "v", n: { m: 2 } });
  assert.equal(parsed.arr, undefined);
  assert.equal(parsed.dropped, undefined);
  assert.equal(parsed.c.multi, "one\ntwo");
  assert.equal(parsed.c.d.e, 5);
  assert.throws(() => parseToml('x = "open'), /could not be read/);
  assert.throws(() => parseToml("x = 1\n[x]"), /both a value and a table/);
});

test("skills are reshaped into Branch's fields, and a risky one is held back in the preview", () => {
  const shaped = normaliseSkill(skillDocument("Tidy Notes", "Sort.", "user-invocable: true\nallowed-tools:\n  - Read\n"), "x");
  assert.match(shaped.document, /^---\nname: tidy-notes\ndescription: Does a careful thing\nallowed-tools: Read\n---/);
  assert.ok(!shaped.document.includes("user-invocable"));
  assert.match(normaliseSkill("Just instructions, no heading.", "My Folder").document, /name: my-folder\ndescription: Just instructions/);
  assert.match(normaliseSkill("---\nname: x\n---\n", "x").refusal, /no instructions/);
  assert.match(normaliseSkill(`---\nname: x\n---\nuse token=${SECRET}`, "x").refusal, /safety check held it back: line \d+ looks like an API key/);
  assert.ok(!normaliseSkill(`---\nname: x\n---\nuse token=${SECRET}`, "x").refusal.includes(SECRET));
  assert.match(normaliseSkill("---\nname: [unclosed\n---\nbody", "x").refusal, /heading could not be read/);
});

test("a tool server keeps its shape and names its keys, never their values", () => {
  const keys = [];
  const local = serverFrom("Files", { command: "npx", args: ["-y", "pkg", SECRET], env: { files_token: SECRET, "bad name!": "x" } }, keys);
  assert.deepEqual(local, { transport: "stdio", name: "Files", command: "npx", args: ["-y", "pkg", "[removed before sharing]"], envKeys: ["FILES_TOKEN", "BAD_NAME_"] });
  const remote = serverFrom("web", { url: "https://x.example.com/mcp?key=1#f", headers: { Authorization: `Bearer ${SECRET}`, "X-Api-Key": SECRET } }, keys);
  assert.deepEqual(remote, { transport: "http", name: "web", url: "https://x.example.com/mcp", envKeys: [], bearerEnv: "WEB_TOKEN" });
  assert.equal(serverFrom("plain", { url: "http://example.com/mcp" }, keys), "Its address is not https, which Branch requires.");
  assert.equal(serverFrom("loop", { url: "http://localhost:3000/mcp" }, keys).transport, "http");
  assert.equal(serverFrom("none", {}, keys), "It names neither a program nor a web address.");
  assert.deepEqual(keys.map((key) => key.name), ["FILES_TOKEN", "BAD_NAME_", "WEB_TOKEN", "X_API_KEY"]);
  assert.ok(!JSON.stringify([local, remote, keys]).includes(SECRET));
});

// ------------------------------------------------------------------ Claude Code, end to end

test("Claude Code: the preview lists everything, holds back what cannot come, and changes nothing", async (t) => {
  const { app, home, owner } = await fixture(t);
  await claudeHome(home);
  const before = wholeDatabase(app);
  const scan = await scanned(home, "claude-code");
  const preview = previewOf(app.store, owner, "claude-code", "here", scan);
  assert.deepEqual(preview.groups.map((group) => group.kind), ["chat", "project", "memory", "instructions", "skill", "mcp", "setting"]);
  const chats = byKind(scan, "chat");
  assert.equal(chats.length, 2);
  assert.equal(chats.find((chat) => !chat.blocked).title, "Watering schedule");
  assert.match(chats.find((chat) => chat.blocked).detail, /no messages in plain words/);
  assert.deepEqual(byKind(scan, "skill").map((skill) => [skill.title, skill.blocked]), [["Tidy Notes", false], ["leaky", true]]);
  assert.match(byKind(scan, "skill")[0].detail, /1 other file beside it stays behind/);
  assert.deepEqual(byKind(scan, "mcp").map((server) => [server.title, server.blocked]),
    [["files", false], ["search", false], ["plain", true], ["local", false]]);
  assert.deepEqual(byKind(scan, "mcp")[0].needsKeys, ["FILES_TOKEN"]);
  assert.deepEqual(preview.keys.map((key) => key.name), ["ANTHROPIC_API_KEY", "FILES_TOKEN", "SEARCH_TOKEN"]);
  assert.equal(byKind(scan, "project")[0].title, "garden-app");
  assert.match(byKind(scan, "project")[0].detail, /2 chats in \/work\/garden-app/);
  assert.ok(preview.notes.some((note) => /sign-in stays with Claude Code/.test(note)));
  assert.ok(preview.notes.some((note) => /custom commands and subagents are not brought over/.test(note)));
  assert.ok(!JSON.stringify(preview).includes(SECRET), "a key's value never reaches the preview");
  assert.equal(wholeDatabase(app), before, "looking changes nothing in Branch");
});

test("Claude Code: bringing it over fills Branch's own stores, once", async (t) => {
  const { app, home, owner } = await fixture(t);
  await claudeHome(home);
  const scan = await scanned(home, "claude-code");
  const receipt = await bringOver(app.store, owner, "claude-code", scan, everything(scan), new Set(["FILES_TOKEN"]));
  assert.deepEqual(receipt.brought.map((entry) => entry.kind).sort(),
    ["chat", "instructions", "mcp", "mcp", "mcp", "memory", "project", "setting", "skill"]);
  assert.deepEqual(receipt.skipped.map((entry) => entry.title).sort(), ["A chat", "leaky", "plain"]);
  assert.match(receipt.skipped.find((entry) => entry.title === "A chat").reason, /no messages in plain words/);
  assert.deepEqual(receipt.keys.map((key) => key.name), ["SEARCH_TOKEN"], "only keys a brought thing needs and the locker lacks");

  const chat = receipt.brought.find((entry) => entry.kind === "chat");
  const sessionId = chat.target.replace("conversation ", "");
  const messages = app.store.messages(sessionId);
  assert.deepEqual(messages.map((message) => message.role), ["user", "assistant", "user"]);
  assert.equal(messages[0].content, "Add a watering schedule");
  assert.equal(messages[1].content, "I will add it.\n\nDone: the schedule is in place.");
  assert.equal(messages[2].content, "Thanks  my key is ANTHROPIC_API_KEY=[removed before sharing]");
  for (const hidden of ["HIDDEN-REASONING", "TOOL-OUTPUT", "ABANDONED-BRANCH", "SIDECHAIN", "META", "/clear", "REMINDER", "SYNTHETIC-ERROR"])
    assert.ok(!JSON.stringify(messages).includes(hidden), `${hidden} was brought over`);
  assert.deepEqual(app.store.labels.forTarget(owner, "conversation", sessionId), ["from claude code"]);

  const facts = app.store.exportMemory(owner).records;
  const instruction = facts.find((fact) => fact.data.kind === "preference");
  assert.match(instruction.data.text, /Keep answers short/);
  assert.equal(instruction.data.source, "Instructions brought over from Claude Code (CLAUDE.md)");
  const note = facts.find((fact) => fact.data.kind === "project-note");
  assert.equal(note.data.project, "moved-garden-app");
  assert.match(note.data.text, /uses SQLite/);

  assert.ok(app.store.projects.list(owner).some((project) => project.id === "moved-garden-app" && project.name === "garden-app"));
  assert.deepEqual(app.store.skills.list(owner).map((skill) => [skill.name, skill.activeVersion]), [["tidy-notes", 1]]);
  const servers = broughtServers(app.store, owner);
  assert.deepEqual(servers.map((entry) => entry.name), ["files", "search", "local"]);
  assert.deepEqual(servers[0].server.connection,
    { id: "files", tools: [], expectedVersion: "", transport: "stdio", command: "npx", args: ["-y", "@example/files"], envKeys: ["FILES_TOKEN"] });
  assert.deepEqual(servers[1].server.connection,
    { id: "search", tools: [], expectedVersion: "", transport: "http", url: "https://search.example.com/mcp", bearerEnv: "SEARCH_TOKEN" });
  // Once the owner fills in what the try showed, the entry is one the connections file accepts as it is.
  const { McpConfigSchema } = await import("../dist/integrations/mcp-config.js");
  for (const entry of servers)
    assert.doesNotThrow(() => McpConfigSchema.parse({ ...entry.server.connection, tools: ["read"], expectedVersion: "1.0.0" }), entry.name);
  assert.deepEqual(broughtSettings(app.store, owner), { model: { value: "claude-opus-4", source: "Claude Code" } });
  assert.ok(!wholeDatabase(app).includes(SECRET), "no key's value is kept anywhere in Branch");

  const sessions = app.store.recentSessions(owner, 100).sessions.length, factCount = facts.length;
  const again = await bringOver(app.store, owner, "claude-code", await scanned(home, "claude-code"), everything(scan), new Set());
  assert.equal(again.brought.length, 0);
  assert.ok(again.skipped.filter((entry) => entry.reason === "It was brought over before.").length >= 9);
  assert.equal(app.store.recentSessions(owner, 100).sessions.length, sessions, "no chat was brought twice");
  assert.equal(app.store.exportMemory(owner).records.length, factCount);
  const later = previewOf(app.store, owner, "claude-code", "here", await scanned(home, "claude-code"));
  assert.ok(later.groups.flatMap((group) => group.items).filter((item) => !item.blocked).every((item) => item.alreadyMoved));

  const unknown = await bringOver(app.store, owner, "claude-code", scan, ["f".repeat(32)], new Set());
  assert.deepEqual(unknown.skipped, [{ key: "f".repeat(32), title: "f".repeat(32), reason: "It is no longer there to bring over." }]);
});

test("a thing Branch refuses is reported and the rest still come", async (t) => {
  const { app, home, owner } = await fixture(t);
  await claudeHome(home);
  app.store.skills.install(owner, { document: skillDocument("tidy-notes", "Already here.") });
  app.store.configureMemory(owner, { maxFacts: 1 });
  const scan = await scanned(home, "claude-code");
  const wanted = scan.items.filter((item) => ["skill", "memory", "instructions", "setting"].includes(item.kind)).map((item) => item.key);
  const receipt = await bringOver(app.store, owner, "claude-code", scan, wanted, new Set());
  // Things are brought in the order the preview lists them, so the instructions take the one free place.
  assert.deepEqual(receipt.brought.map((entry) => entry.kind), ["instructions", "setting"]);
  assert.ok(receipt.skipped.some((entry) => entry.title === "Tidy Notes" && /already uses that name/.test(entry.reason)));
  assert.ok(receipt.skipped.some((entry) => /MEMORY\.md/.test(entry.title)));
  // What was refused is not in the record, so it can be tried again once there is room.
  app.store.configureMemory(owner, { maxFacts: 50 });
  const retry = await bringOver(app.store, owner, "claude-code", await scanned(home, "claude-code"), wanted, new Set());
  assert.deepEqual(retry.brought.map((entry) => entry.kind), ["memory"]);
});

// ------------------------------------------------------------------ the other four

test("Codex CLI: typed prompts, the fullest copy of a resumed chat, config.toml servers and both skill folders", async (t) => {
  const { app, home, owner } = await fixture(t);
  await codexHome(home);
  const scan = await scanned(home, "codex");
  const chats = byKind(scan, "chat");
  assert.deepEqual(chats.map((chat) => chat.title).sort(), ["An older chat without typed prompts", "Tracker bug"]);
  assert.match(chats.find((chat) => chat.title === "Tracker bug").detail, /^2 messages, in \/work\/tracker/);
  assert.deepEqual(byKind(scan, "skill").map((skill) => skill.title).sort(), ["review", "shared-helper"]);
  assert.deepEqual(byKind(scan, "mcp").map((server) => [server.title, server.needsKeys]),
    [["docs", ["LITERAL_TOKEN", "DOCS_API_KEY"]], ["remote", ["REMOTE_TOKEN"]]]);
  assert.deepEqual(byKind(scan, "setting").map((item) => item.title), ["Model: gpt-5-codex"]);
  assert.deepEqual(byKind(scan, "project").map((item) => item.title), ["tracker"]);
  assert.ok(scan.notes.some((note) => /sign-in stays with Codex/.test(note)));
  const receipt = await bringOver(app.store, owner, "codex", scan, everything(scan), new Set());
  assert.equal(receipt.skipped.length, 0, JSON.stringify(receipt.skipped));
  const session = receipt.brought.find((entry) => entry.title === "Tracker bug").target.replace("conversation ", "");
  assert.deepEqual(app.store.messages(session).map((message) => [message.role, message.content]),
    [["user", "Why does the tracker crash?"], ["assistant", "A missing null check."]]);
  const older = receipt.brought.find((entry) => entry.title.startsWith("An older")).target.replace("conversation ", "");
  assert.equal(app.store.messages(older)[0].content, "An older chat without typed prompts");
  assert.ok(!wholeDatabase(app).includes(SECRET));
  for (const hidden of ["HIDDEN-REASONING", "TOOL-OUTPUT", "INJECTED"]) assert.ok(!wholeDatabase(app).includes(hidden), hidden);
});

test("Hermes Agent: chats from its database, § memory entries, the active profile and .env names only", async (t) => {
  const { app, home, owner } = await fixture(t);
  const root = await hermesHome(home);
  const scan = await scanned(home, "hermes");
  assert.deepEqual(byKind(scan, "chat").map((chat) => [chat.title, chat.detail]), [["Garden plan", "2 messages, in /work/garden."]]);
  assert.deepEqual(byKind(scan, "memory").map((item) => item.title), ["What Hermes knew about you", "What Hermes remembered"]);
  assert.deepEqual(byKind(scan, "skill").map((item) => item.title), ["airtable"]);
  assert.deepEqual(byKind(scan, "mcp").map((item) => item.title), ["time", "api"]);
  assert.deepEqual(scan.keys.map((key) => key.name), ["API_TOKEN", "OPENAI_API_KEY", "TELEGRAM_BOT_TOKEN"]);
  assert.ok(scan.notes.some((note) => /scheduled jobs are not brought over/.test(note)));
  const receipt = await bringOver(app.store, owner, "hermes", scan, everything(scan), new Set());
  await scan.close();
  assert.equal(receipt.skipped.length, 0, JSON.stringify(receipt.skipped));
  const session = receipt.brought.find((entry) => entry.kind === "chat").target.replace("conversation ", "");
  assert.deepEqual(app.store.messages(session).map((message) => message.content), ["Plan the beds", "Three beds."]);
  const remembered = app.store.exportMemory(owner).records.find((fact) => /zone 7/.test(fact.data.text));
  assert.equal(remembered.data.text, "The user's garden is in zone 7.\n\nThe dog is called Rex.");
  assert.equal(remembered.data.kind, "fact-about-world");
  const database = wholeDatabase(app);
  for (const hidden of [SECRET, "HIDDEN-REASONING", "TOOL-OUTPUT", "SUPERSEDED", "HIDDEN-SESSION", "SYSTEM-PROMPT"])
    assert.ok(!database.includes(hidden), hidden);

  await mkdir(join(root, "profiles/work/memories"), { recursive: true });
  await writeFile(join(root, "profiles/work/memories/USER.md"), "Work profile person.");
  await writeFile(join(root, "active_profile"), "work\n");
  const profiled = await scanned(home, "hermes");
  assert.deepEqual(profiled.items.map((item) => item.title), ["What Hermes knew about you"]);
  await profiled.close?.();
});

test("OpenClaw: JSON5 settings, the workspace, and chats from the agent database and older files", async (t) => {
  const { app, home, owner } = await fixture(t);
  await openclawHome(home);
  const scan = await scanned(home, "openclaw");
  assert.deepEqual(byKind(scan, "chat").map((chat) => [chat.title, chat.detail]).sort(),
    [["Bakery orders", "3 messages, with the main agent."], ["Old question", "2 messages, with the main agent."]]);
  assert.deepEqual(byKind(scan, "memory").map((item) => item.title), ["What OpenClaw knew about you", "What OpenClaw remembered", "Notes: 2026-01-01.md"]);
  assert.deepEqual(byKind(scan, "instructions").map((item) => item.title), ["Your instructions (AGENTS.md)"]);
  assert.deepEqual(byKind(scan, "skill").map((item) => item.title), ["bake"]);
  assert.deepEqual(byKind(scan, "setting").map((item) => item.title), ["Model: anthropic/claude-sonnet"]);
  assert.deepEqual(scan.keys.map((key) => key.name), ["ANTHROPIC_API_KEY", "GITHUB_TOKEN", "NOTES_KEY", "SLACK_BOT_TOKEN"]);
  assert.ok(scan.notes.some((note) => /sign-ins and chat-app pairings stay with OpenClaw/.test(note)));
  const receipt = await bringOver(app.store, owner, "openclaw", scan, everything(scan), new Set());
  await scan.close();
  assert.equal(receipt.skipped.length, 0, JSON.stringify(receipt.skipped));
  const session = receipt.brought.find((entry) => entry.title === "Bakery orders").target.replace("conversation ", "");
  assert.deepEqual(app.store.messages(session).map((message) => message.content), ["How much flour?", "Ten kilograms.", "Thanks"]);
  const database = wholeDatabase(app);
  for (const hidden of [SECRET, "HIDDEN-REASONING", "TOOL-OUTPUT", "ABANDONED-BRANCH"]) assert.ok(!database.includes(hidden), hidden);
});

test("OpenCode: the database and the older storage folder, text parts only, and the config folder beside it", async (t) => {
  const { app, home, owner } = await fixture(t);
  await opencodeHome(home);
  const scan = await scanned(home, "opencode");
  assert.deepEqual(byKind(scan, "chat").map((chat) => chat.title), ["Fix the header", "Old notes chat"]);
  assert.deepEqual(byKind(scan, "mcp").map((item) => [item.title, item.needsKeys]), [["fs", ["FS_TOKEN"]], ["web", ["WEB_TOKEN"]]]);
  assert.deepEqual(byKind(scan, "project").map((item) => item.title).sort(), ["notes", "site"]);
  assert.deepEqual(byKind(scan, "skill").map((item) => item.title), ["lint"]);
  assert.deepEqual(byKind(scan, "instructions").map((item) => item.title), ["Your instructions (AGENTS.md)"]);
  const receipt = await bringOver(app.store, owner, "opencode", scan, everything(scan), new Set());
  await scan.close();
  assert.equal(receipt.skipped.length, 0, JSON.stringify(receipt.skipped));
  const header = receipt.brought.find((entry) => entry.title === "Fix the header").target.replace("conversation ", "");
  assert.deepEqual(app.store.messages(header).map((message) => message.content), ["The header overlaps", "Fixed with a z-index."]);
  const notes = receipt.brought.find((entry) => entry.title === "Old notes chat").target.replace("conversation ", "");
  assert.deepEqual(app.store.messages(notes).map((message) => message.content), ["Summarise my notes", "Here is the summary."]);
  const database = wholeDatabase(app);
  for (const hidden of [SECRET, "HIDDEN-REASONING", "TOOL-OUTPUT", "SUBTASK", "SYNTHETIC-NOTE"]) assert.ok(!database.includes(hidden), hidden);
});

test("the original database is left exactly as it was, and the private copy is removed", async (t) => {
  const { home } = await fixture(t);
  const root = await hermesHome(home);
  const before = await readFile(join(root, "state.db"));
  const scan = await scanned(home, "hermes");
  await byKind(scan, "chat")[0].load();
  await scan.close();
  assert.deepEqual(await readFile(join(root, "state.db")), before);
});

// ------------------------------------------------------------------ what the owner sees

test("a context file's text goes to the loader that owns such files, when there is one", async (t) => {
  const { app, home, owner } = await fixture(t);
  await claudeHome(home);
  const scan = await scanned(home, "claude-code");
  const handed = [];
  const sink = async (file) => { handed.push(file); return `context file ${file.name}`; };
  const wanted = scan.items.filter((item) => item.kind === "memory" || item.kind === "instructions").map((item) => item.key);
  const receipt = await bringOver(app.store, owner, "claude-code", scan, wanted, new Set(), sink);
  assert.deepEqual(receipt.brought.map((entry) => entry.target).sort(), ["context file CLAUDE.md", "context file MEMORY.md"]);
  assert.deepEqual(handed.map((file) => [file.name, file.home, file.source, file.about, file.project]).sort(),
    [["CLAUDE.md", "project", "claude-code", undefined, undefined], ["MEMORY.md", "library:memory", "claude-code", "project", "moved-garden-app"]]);
  const { contextFileHome } = await import("../dist/migrate/types.js");
  assert.deepEqual(["SOUL.md", "IDENTITY.md", "USER.md", "AGENTS.md", "MEMORY.md"].map(contextFileHome),
    ["settings:assistant", "settings:assistant", "settings:assistant", "project", "library:memory"]);
  assert.match(handed.find((file) => file.name === "CLAUDE.md").text, /Keep answers short/);
  assert.equal(app.store.exportMemory(owner).records.length, 0, "nothing was kept on a path of this feature's own");
});

test("the running app hands context files to the loader: where it reads them, the owner's own kept, switches untouched", async (t) => {
  const { app, root, home, owner } = await fixture(t);
  await claudeHome(home);
  await hermesHome(home);
  const { contextFileSinkFor } = await import("../dist/migrate-api.js");
  const { contextFileSettings, contextFileStatus, saveContextFileSettings, slotForName, writeContextFile } = await import("../dist/context-files.js");
  const workspace = join(root, "workspace");
  await writeFile(join(workspace, "AGENTS.md"), "The owner's own rule.\n");
  const sink = contextFileSinkFor(app);
  const claude = await scanned(home, "claude-code");
  const texts = claude.items.filter((item) => item.kind === "memory" || item.kind === "instructions").map((item) => item.key);
  const receipt = await bringOver(app.store, owner, "claude-code", claude, texts, new Set(), sink);
  assert.deepEqual(receipt.brought.map((entry) => entry.target).sort(), [
    "1 saved fact",
    // Every context file ships "when needed" (the ship-on rule), so a file brought over is read once a task needs it.
    "added to AGENTS.md in the workspace; it is read when a task needs it",
  ], "a project's own memory stays a saved fact; the instructions join the file the loader reads");
  const agents = await readFile(join(workspace, "AGENTS.md"), "utf8");
  assert.ok(agents.startsWith("The owner's own rule.\n"), "the owner's file is added to, never replaced");
  assert.match(agents, /<!-- Brought over from Claude Code -->\n# How I like to work/);
  await assert.rejects(lstat(join(workspace, "CLAUDE.md")), "no second file the loader would never read");
  assert.deepEqual(contextFileSettings(app.store, owner).files, {}, "bringing a file over switches nothing on");
  saveContextFileSettings(app.store, owner, { files: { agents: "on" } });
  const report = contextFileStatus(app.store, owner, workspace).find((entry) => entry.key === "agents");
  assert.deepEqual([report.name, report.outcome], ["AGENTS.md", "carried"]);

  const hermes = await scanned(home, "hermes");
  const personal = hermes.items.filter((item) => item.kind === "memory" || item.kind === "instructions").map((item) => item.key);
  try {
    const moved = await bringOver(app.store, owner, "hermes", hermes, personal, new Set(), sink);
    assert.equal(moved.skipped.length, 0);
    assert.ok(moved.brought.some((entry) => entry.target === "written to SOUL.md in Branch's own folder; it is read when a task needs it"),
      JSON.stringify(moved.brought));
  } finally { await hermes.close?.(); }
  assert.equal(await readFile(join(app.store.folder, "SOUL.md"), "utf8"), "You are calm and precise.\n");
  assert.equal(await readFile(join(app.store.folder, "USER.md"), "utf8"), "Prefers metric units.\n");
  assert.match(await readFile(join(workspace, "MEMORY.md"), "utf8"), /zone 7[\s\S]*Rex/);
  await assert.rejects(lstat(join(workspace, "SOUL.md")), "a file about the owner is kept where the owner's files are");
  assert.equal(app.store.exportMemory(owner).records.filter((record) => /calm and precise|metric/.test(record.data.text)).length, 0);

  const again = writeContextFile(app.store, owner, workspace, { name: "SOUL.md", text: "You are calm and precise.", from: "Hermes Agent" });
  assert.equal(again.outcome, "already there");
  assert.equal(slotForName("GEMINI.md"), "agents");
  assert.equal(slotForName("NOTES.md"), null);
  // A link where a context file would go is never written through.
  const outside = join(root, "outside.md");
  await writeFile(outside, "untouched");
  await symlink(outside, join(workspace, "TOOLS.md"));
  assert.throws(() => writeContextFile(app.store, owner, workspace, { name: "TOOLS.md", text: "x", from: "Codex CLI" }), /not a plain file/);
  assert.equal(await readFile(outside, "utf8"), "untouched");

  // Folder trust: an owner file skips a workspace the owner has not trusted, and a work file says it is not read.
  const { decideFolder, saveFolderTrustSettings } = await import("../dist/folder-trust.js");
  saveFolderTrustSettings(app.store, owner, { mode: "on" });
  decideFolder(app.store, owner, workspace, { folder: "", decision: "distrust" });
  await writeFile(join(workspace, "IDENTITY.md"), "A workspace identity.\n");
  const identity = writeContextFile(app.store, owner, workspace, { name: "IDENTITY.md", text: "Called Fern.", from: "OpenClaw" });
  assert.deepEqual([identity.folder, identity.outcome, identity.readable], [app.store.folder, "created", true]);
  assert.equal(await readFile(join(workspace, "IDENTITY.md"), "utf8"), "A workspace identity.\n");
  const heartbeat = await sink({ name: "HEARTBEAT.md", home: "project", text: "Check the plants.", source: "openclaw" });
  assert.equal(heartbeat, "written to HEARTBEAT.md in the workspace; the workspace folder is not trusted, so it is not read until you trust it");
});

/** Every file under a folder, so a key anywhere on disk is found. */
async function everyFile(folder) {
  const found = [];
  for (const entry of await readdir(folder, { withFileTypes: true }).catch(() => [])) {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) found.push(...await everyFile(path));
    else if (entry.isFile()) found.push(path);
  }
  return found;
}

test("after an import no key is anywhere Branch writes, every import is on the record, and no tool server can run", async (t) => {
  const { app, root, home } = await fixture(t);
  await Promise.all([claudeHome(home), codexHome(home), hermesHome(home), openclawHome(home), opencodeHome(home)]);
  // A password inside an address, which only the leak guard's patterns know, in a memory file.
  const hidden = "Hunter22deploy";
  await writeFile(join(home, ".codex", "memories", "MEMORY.md"), `Deploys use postgres://bot:${hidden}@db.example.com/app for the bot.`);
  const { startServer } = await import("../dist/server.js");
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, presence: "daemon" });
  const previous = process.env.BRANCH_MOVE_IN_HOME;
  process.env.BRANCH_MOVE_IN_HOME = home;
  t.after(async () => {
    if (previous === undefined) delete process.env.BRANCH_MOVE_IN_HOME; else process.env.BRANCH_MOVE_IN_HOME = previous;
    await server.close();
  });
  const api = async (path, body) => {
    const response = await fetch(server.url + path, { method: "POST",
      headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const tools = app.registry.names().sort();
  await api("/api/move-in/switch", { mode: "on" });
  for (const source of ["claude-code", "codex", "hermes", "openclaw", "opencode"]) {
    const preview = await api("/api/move-in/preview", { source });
    assert.equal(preview.status, 200, source);
    const keys = preview.body.groups.flatMap((group) => group.items).filter((item) => !item.blocked).map((item) => item.key);
    const brought = await api("/api/move-in/import", { source, items: keys });
    assert.equal(brought.status, 200, `${source}: ${JSON.stringify(brought.body)}`);
    assert.ok(brought.body.brought.length > 0, source);
  }
  const imports = app.store.audit.list(app.runtime.owner, { limit: 50 }).filter((entry) => entry.action === "data.imported");
  assert.equal(imports.length, 5, "every import is on the record");
  assert.ok(imports.every((entry) => /brought over, \d+ left behind$/.test(entry.subject)));
  const backup = JSON.stringify(app.store.backup("test").tables);
  assert.ok(!backup.includes(SECRET) && !backup.includes(hidden), "a key reached the database");
  // Everything on disk that is not the made-up home folder: the database, logs, traces, the workspace.
  const written = (await everyFile(root)).filter((path) => !path.startsWith(home));
  assert.ok(written.some((path) => path.startsWith(join(root, "data"))));
  for (const file of written) {
    const bytes = await readFile(file);
    assert.ok(!bytes.includes(SECRET) && !bytes.includes(hidden), `a key reached ${file}`);
  }
  assert.match(await readFile(join(root, "workspace", "MEMORY.md"), "utf8"), /Deploys use postgres:\/\/bot:\[hidden key-like value/);
  // Tool servers wait to be tried: none of their tools exist, and each still lacks its tool list and version.
  assert.deepEqual(app.registry.names().sort(), tools);
  const servers = broughtServers(app.store, app.runtime.owner);
  assert.ok(servers.length >= 6, `${servers.length} servers`);
  for (const entry of servers)
    assert.deepEqual([entry.server.connection.tools, entry.server.connection.expectedVersion], [[], ""]);
});

test("hostile input: prototype names and deep nesting in TOML, links out of a folder, damaged archives and fake databases", async (t) => {
  assert.throws(() => parseToml("[__proto__]\npolluted = 1\n"), /does not accept/);
  assert.throws(() => parseToml("a.constructor.prototype.polluted = 1\n"), /not a name Branch accepts/);
  assert.throws(() => parseToml("x = { __proto__ = { polluted = 1 } }\n"), /not a name Branch accepts/);
  assert.equal({}.polluted, undefined);
  assert.throws(() => parseToml(`x = ${"[".repeat(5000)}${"]".repeat(5000)}\n`), /nested too deeply/);
  assert.deepEqual(parseToml(`x = ${"[".repeat(10)}1${"]".repeat(10)}\n`).x.flat(20), [1]);

  const { app, root, home } = await fixture(t);
  const claude = join(home, ".claude");
  await mkdir(join(root, "elsewhere"), { recursive: true });
  await writeFile(join(root, "elsewhere", "secret.md"), "OUTSIDE");
  await writeFile(join(root, "elsewhere", "journal"), "OUTSIDE");
  await mkdir(join(claude, "projects"), { recursive: true });
  await symlink(join(root, "elsewhere"), join(claude, "projects", "linked"));
  await writeFile(join(claude, "state.db"), "not a database at all");
  await symlink(join(root, "elsewhere", "journal"), join(claude, "state.db-wal"));
  const tree = folderTree(claude);
  assert.equal(await tree.read("projects/linked/secret.md"), null, "a linked folder is not followed");
  assert.deepEqual(await tree.list("projects/linked"), []);
  const copy = await tree.copyOut("state.db");
  assert.deepEqual(await readdir(join(copy.path, "..")), ["state.db"], "a linked journal is not copied");
  await copy.discard();
  await assert.rejects(lstat(join(copy.path, "..")));
  const { openCopy } = await import("../dist/migrate/sqlite.js");
  let made = "";
  const watching = { ...tree, copyOut: async (path) => { const opened = await tree.copyOut(path); made = opened.path; return opened; } };
  assert.equal(await openCopy(watching, "state.db"), null);
  await assert.rejects(lstat(made), "the copy of a file that is not a database is removed at once");

  const { startServer } = await import("../dist/server.js");
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, presence: "daemon" });
  t.after(() => server.close());
  const post = (path, body) => fetch(server.url + path, { method: "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  await post("/api/move-in/switch", { mode: "when-needed" });
  // An end-of-contents record that points at a list far past the end of the file.
  const broken = Buffer.alloc(22);
  broken.writeUInt32LE(0x06054b50, 0);
  broken.writeUInt16LE(1, 10);
  broken.writeUInt32LE(0xfffff0, 16);
  const response = await post("/api/move-in/preview", { archive: { name: "broken.zip", data: broken.toString("base64") } });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /damaged|could not/);
});

test("the move-in switch ships at when needed and keeps only the three settings", async (t) => {
  const { app, owner } = await fixture(t);
  const { moveInMode, saveMoveInMode, requireMoveInAllowed } = await import("../dist/migrate/switch.js");
  // p17: it ships at "when needed" (it looks at nothing until asked). Mutation note: returning "off" as the
  // default in moveInMode (src/migrate/switch.ts) turns this line and the API test below red.
  assert.equal(moveInMode(app.store, owner), "when-needed");
  assert.throws(() => requireMoveInAllowed("off"), /switched off/);
  assert.doesNotThrow(() => requireMoveInAllowed("when-needed"));
  assert.equal(saveMoveInMode(app.store, owner, { mode: "on" }), "on");
  assert.equal(moveInMode(app.store, owner), "on");
  assert.throws(() => saveMoveInMode(app.store, owner, { mode: "always" }));
  assert.throws(() => saveMoveInMode(app.store, owner, { mode: "on", extra: 1 }));
});

test("the first-run offer names only the assistants found that nothing has come from yet", async (t) => {
  const { app, home, owner } = await fixture(t);
  await claudeHome(home);
  await codexHome(home);
  const sources = await foundSources(app.store, owner, { ...inputs, home });
  assert.deepEqual(sources.filter((entry) => entry.found).map((entry) => entry.source), ["claude-code", "codex"]);
  assert.equal(offerSentence(sources), "Bring your chats and memory from Claude Code or Codex CLI.");
  const scan = await scanned(home, "codex");
  await bringOver(app.store, owner, "codex", scan, [byKind(scan, "skill")[0].key], new Set());
  const after = await foundSources(app.store, owner, { ...inputs, home });
  assert.deepEqual(after.find((entry) => entry.source === "codex").moved, { skill: 1 });
  assert.equal(offerSentence(after), "Bring your chats and memory from Claude Code.");
  assert.equal(offerSentence([]), null);
});

test("pointing the search at another home folder switches off this computer's own overrides", async () => {
  const { defaultMoveInOptions } = await import("../dist/migrate-api.js");
  const elsewhere = defaultMoveInOptions({ BRANCH_MOVE_IN_HOME: "/Volumes/old/Users/sam", CODEX_HOME: "/real/codex" });
  assert.deepEqual({ env: elsewhere.env, home: elsewhere.home }, { env: {}, home: "/Volumes/old/Users/sam" });
  const here = defaultMoveInOptions({ CODEX_HOME: "/real/codex" });
  assert.equal(here.env.CODEX_HOME, "/real/codex");
});

test("the move-in screens: list, preview, bring over, and what came, behind the owner's key", async (t) => {
  const made = await fixture(t);
  await claudeHome(made.home);
  const { startServer } = await import("../dist/server.js");
  const server = await startServer(made.app, { dataDir: join(made.root, "data"), port: 0, presence: "daemon" });
  const previous = process.env.BRANCH_MOVE_IN_HOME;
  process.env.BRANCH_MOVE_IN_HOME = made.home;
  t.after(async () => {
    if (previous === undefined) delete process.env.BRANCH_MOVE_IN_HOME; else process.env.BRANCH_MOVE_IN_HOME = previous;
    await server.close();
  });
  const api = async (method, path, body, token = server.token) => {
    const response = await fetch(server.url + path, { method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  assert.equal((await api("GET", "/api/move-in", undefined, "wrong")).status, 401);
  // p17: it ships at "when needed": nothing is looked at or offered until asked. Off refuses a preview.
  assert.deepEqual((await api("GET", "/api/move-in/switch")).body, { mode: "when-needed" });
  assert.deepEqual((await api("GET", "/api/move-in")).body, { mode: "when-needed", sources: [], offer: null });
  assert.deepEqual((await api("POST", "/api/move-in/switch", { mode: "off" })).body, { mode: "off" });
  assert.deepEqual((await api("GET", "/api/move-in")).body, { mode: "off", sources: [], offer: null });
  const refused = await api("POST", "/api/move-in/preview", { source: "claude-code" });
  assert.equal(refused.status, 403);
  assert.match(refused.body.error, /switched off/);
  assert.equal((await api("POST", "/api/move-in/import", { source: "claude-code", items: ["a".repeat(32)] })).status, 403);
  // When needed: it looks only when asked, and never offers on its own.
  assert.deepEqual((await api("POST", "/api/move-in/switch", { mode: "when-needed" })).body, { mode: "when-needed" });
  assert.deepEqual((await api("GET", "/api/move-in")).body, { mode: "when-needed", sources: [], offer: null });
  const asked = await api("GET", "/api/move-in?look=1");
  assert.equal(asked.body.sources.find((entry) => entry.source === "claude-code").found, true);
  assert.equal(asked.body.offer, null);
  assert.equal((await api("POST", "/api/move-in/switch", { mode: "sometimes" })).status, 400);
  await api("POST", "/api/move-in/switch", { mode: "on" });
  const listed = await api("GET", "/api/move-in");
  assert.equal(listed.status, 200);
  assert.equal(listed.body.sources.find((entry) => entry.source === "claude-code").found, true);
  assert.equal(listed.body.offer, "Bring your chats and memory from Claude Code.");

  const preview = await api("POST", "/api/move-in/preview", { source: "claude-code" });
  assert.equal(preview.status, 200);
  assert.equal(preview.body.name, "Claude Code");
  assert.ok(!JSON.stringify(preview.body).includes(SECRET));
  const keys = preview.body.groups.flatMap((group) => group.items).filter((item) => !item.blocked).map((item) => item.key);

  const zip = zipWrite([[".claude/CLAUDE.md", "From a copy."]]);
  const uploaded = await api("POST", "/api/move-in/preview", { archive: { name: "old.zip", data: zip.toString("base64") } });
  assert.equal(uploaded.status, 200);
  assert.equal(uploaded.body.source, "claude-code");
  assert.equal(uploaded.body.from, "old.zip");
  const byPath = await api("POST", "/api/move-in/preview", { path: join(made.home, ".claude") });
  assert.equal(byPath.body.groups.find((group) => group.kind === "mcp").items.length, 4, "the .claude.json beside a chosen .claude folder is read");
  assert.equal((await api("POST", "/api/move-in/preview", { path: "relative/folder" })).status, 400);
  assert.equal((await api("POST", "/api/move-in/preview", {})).status, 400);
  const unknown = await api("POST", "/api/move-in/preview", { path: made.root });
  assert.equal(unknown.status, 400);
  assert.match(unknown.body.error, /could not tell which assistant/);

  const brought = await api("POST", "/api/move-in/import", { source: "claude-code", items: keys });
  assert.equal(brought.status, 200);
  assert.equal(brought.body.brought.length, keys.length);
  assert.deepEqual(brought.body.keys.map((key) => key.name), ["FILES_TOKEN", "SEARCH_TOKEN"]);
  const record = await api("GET", "/api/move-in/brought");
  assert.equal(record.body.counts["claude-code"], keys.length);
  assert.equal(record.body.servers.length, 3);
  assert.equal(record.body.settings.model.value, "claude-opus-4");
  assert.equal((await api("POST", "/api/move-in/import", { source: "claude-code", items: [] })).status, 400);
  assert.equal((await api("GET", "/api/move-in/nothing")).status, 404);
  // The old window's move-in script is checked on its own below (the new window has no move-in card).
});

