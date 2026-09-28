import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";

/**
 * mac7/walk-rules: a tool that walks a folder obeys the owner's rules for every file and folder it
 * lists or reads, not only for the folder it starts from (docs/agents/STATUS-walk-rules.md).
 * Every model is a scripted fake; nothing opens a window.
 */

const secretText = "SECRET-LEDGER-4417";
const openText = "OPEN-NOTE-2231";

async function fixture(t, steps) {
  const root = await mkdtemp(join(tmpdir(), "branch-walk-rules-"));
  const provider = { name: "scripted", requests: [], async complete(request) {
    provider.requests.push(request);
    const step = steps?.[Math.min(provider.requests.length - 1, steps.length - 1)];
    return step ? step(request) : { content: "done", toolCalls: [] };
  } };
  const workspace = join(root, "workspace");
  const app = await createBranch({ workspace, dataDir: join(root, "data"),
    presets: [{ id: "alpha", name: "Alpha", provider, model: "a" }] });
  t.after(async () => { await app.close(); await discardTemp(root); });
  await mkdir(join(workspace, "finance", "2026"), { recursive: true });
  await mkdir(join(workspace, "notes"), { recursive: true });
  await writeFile(join(workspace, "finance", "q1.txt"), `total ${secretText}\n`);
  await writeFile(join(workspace, "finance", "2026", "q2.md"), `# Q2\n\n${secretText}\n`);
  await writeFile(join(workspace, "notes", "open.txt"), `plan ${openText}\n`);
  await writeFile(join(workspace, "readme.md"), `# Readme\n\n${openText}\n`);
  return { app, root, workspace, provider };
}
const call = (name, args) => () => ({ content: "", toolCalls: [{ id: `c${Math.random().toString(36).slice(2, 8)}`, name, arguments: JSON.stringify(args) }] });
const say = (content) => () => ({ content, toolCalls: [] });
/** "Never allow anything under finance", as the owner writes it. */
async function financeRule(app, decision = "deny", extra = {}) {
  const { addPolicyRule } = await import("../dist/policy.js");
  addPolicyRule(app.store, "local", { tool: "*", match: "*", decision, remember: "always", resource: { kind: "path", pattern: "finance" }, ...extra });
}
/** Runs one tool call through a model's turn and returns what the tool answered, or the refusal. */
async function runTool(t, name, args, setup = financeRule) {
  const context = await fixture(t, [call(name, args), say("done")]);
  await setup(context.app);
  const run = await context.app.runtime.run({ prompt: "look" });
  const completed = context.app.store.events(run.id).filter((event) => event.kind === "tool.completed");
  const denied = context.app.store.events(run.id).filter((event) => event.kind === "policy.denied");
  const failed = context.app.store.events(run.id).filter((event) => event.kind === "tool.failed");
  return { ...context, run, result: completed[0]?.data.result, denied: denied[0]?.data, failed: failed[0]?.data };
}
const text = (value) => JSON.stringify(value ?? null);
function assertLeftOut(result, what) {
  assert.ok(result, `${what}: the tool answered`);
  assert.doesNotMatch(text(result), new RegExp(secretText), `${what}: nothing from finance is in the answer`);
  assert.doesNotMatch(text(result).replace(/the folder finance/g, ""), /q1\.txt|q2\.md|finance\//, `${what}: no finance file is named`);
  assert.match(result.leftOut ?? "", /left out because the owner's rules/, `${what}: the answer says something was left out`);
  assert.match(result.leftOut, /the folder finance/, `${what}: the refused folder is named`);
}

// ------------------------------------------------------------------ the walkers, one by one

test("files.grep of the whole workspace leaves finance out and says so; the rest is still searched", async (t) => {
  const { result } = await runTool(t, "files.grep", { query: "-" , path: "." });
  assertLeftOut(result, "files.grep");
  assert.match(text(result), new RegExp(openText), "allowed files are still searched");
});

test("files.list of the top folder does not list finance; listing notes still works", async (t) => {
  const { result } = await runTool(t, "files.list", { path: "." });
  assertLeftOut(result, "files.list");
  assert.deepEqual(result.entries.map((entry) => entry.name).sort(), ["notes", "readme.md"]);
});

test("files.search leaves finance's files unread", async (t) => {
  const { result } = await runTool(t, "files.search", { query: "-" });
  assertLeftOut(result, "files.search");
  assert.match(text(result), new RegExp(openText));
});

test("files.glob does not name finance's files", async (t) => {
  const { result } = await runTool(t, "files.glob", { patterns: ["**/*"] });
  assertLeftOut(result, "files.glob");
  assert.deepEqual(result.files.map((file) => file.path).sort(), ["notes/open.txt", "readme.md"]);
});

test("files.find does not offer finance's files", async (t) => {
  const { result } = await runTool(t, "files.find", { query: "q" });
  assertLeftOut(result, "files.find");
});

test("workspace.map and code.map leave finance out", async (t) => {
  const map = await runTool(t, "workspace.map", { path: "." });
  assertLeftOut(map.result, "workspace.map");
  const code = await runTool(t, "code.map", { path: "." });
  assertLeftOut(code.result, "code.map");
  assert.ok(code.result.files.some((file) => file.path === "readme.md"));
});

test("a walk that starts inside the refused folder is refused outright", async (t) => {
  for (const [name, args] of [["files.grep", { query: "-", path: "finance" }], ["files.list", { path: "finance/2026" }],
    ["files.glob", { patterns: ["*"], path: "finance" }], ["files.search", { query: "-", path: "finance" }]]) {
    const { result, denied } = await runTool(t, name, args);
    assert.equal(result, undefined, `${name}: nothing was answered`);
    assert.ok(denied, `${name}: refused`);
  }
});

test("a rule that only asks before reading finance keeps a walk out of it too (a walk cannot stop to ask)", async (t) => {
  const { result } = await runTool(t, "files.grep", { query: "-", path: "." }, (app) => financeRule(app, "ask"));
  assertLeftOut(result, "files.grep under an ask rule");
});

test("a read-only folder (changes refused) is still searched: reading it is allowed", async (t) => {
  const { result } = await runTool(t, "files.grep", { query: "-", path: "." }, (app) => financeRule(app, "deny", { applies: "changes" }));
  assert.match(text(result), new RegExp(secretText));
  assert.equal(result.leftOut, undefined);
});

test("with no rules at all nothing is left out and there is no note", async (t) => {
  const { result } = await runTool(t, "files.grep", { query: "-", path: "." }, async () => {});
  assert.match(text(result), new RegExp(secretText));
  assert.equal(result.leftOut, undefined);
});

// ------------------------------------------------------------------ knowledge bases and the document library

test("a knowledge base of the whole workspace is read without finance, and the reading says so", async (t) => {
  const { app } = await fixture(t);
  await financeRule(app);
  const base = app.knowledgeBases.create("local", { name: "Everything", sources: [{ kind: "folder", path: "." }, { kind: "file", path: "finance/q1.txt" }] });
  const progress = await app.knowledgeBases.reindex("local", base.id);
  const files = await app.knowledgeBases.filesIn("local", base.id);
  assert.deepEqual(files.sort(), ["notes/open.txt", "readme.md"]);
  assert.match(progress.status, /left out because the owner's rules/);
  const found = await app.knowledgeBases.search("local", { collection: base.id, query: "SECRET LEDGER total" });
  assert.doesNotMatch(text(found), new RegExp(secretText));
  // A knowledge base pointed straight at the refused folder reads nothing from it.
  const only = app.knowledgeBases.create("local", { name: "Money", sources: [{ kind: "folder", path: "finance" }] });
  assert.deepEqual(await app.knowledgeBases.filesIn("local", only.id), []);
});

test("passages read in before a rule was written are never handed back: search, the task's context, summaries, the map", async (t) => {
  const { app, provider } = await fixture(t, [call("knowledge.search", { query: "SECRET LEDGER total" }), say("done")]);
  const base = app.knowledgeBases.create("local", { name: "Everything", sources: [{ kind: "folder", path: "." }] });
  await app.knowledgeBases.reindex("local", base.id);
  const before = await app.knowledgeBases.search("local", { collection: base.id, query: "SECRET LEDGER total" });
  assert.match(text(before), new RegExp(secretText), "without a rule the passage is found (the test can see it)");
  app.knowledgeBases.attach("local", base.id, true);
  await financeRule(app);
  const run = await app.runtime.run({ prompt: "SECRET LEDGER total OPEN NOTE plan" });
  const [completed] = app.store.events(run.id).filter((event) => event.kind === "tool.completed");
  assert.doesNotMatch(text(completed?.data.result), new RegExp(secretText), "knowledge.search in a task");
  assert.match(completed?.data.result.note ?? "", /left out because the owner's rules/);
  assert.doesNotMatch(text(provider.requests[0]?.messages), new RegExp(secretText), "the passages put in front of the task");
  const summary = await app.knowledgeParts.summaries.summarise("local", { collection: base.id });
  assert.doesNotMatch(text(summary.citations), new RegExp(secretText), "a summary");
  await app.knowledgeParts.graph.build("local", base.id);
  assert.doesNotMatch(text(app.knowledgeParts.graph.passagesAround("local", base.id, "SECRET-LEDGER-4417", 10)), new RegExp(secretText));
});

test("the document library does not hand back a document read in from a file that is now refused", async (t) => {
  const { app } = await fixture(t);
  await app.documents.add("local", { path: "finance/q1.txt" });
  await app.documents.add("local", { path: "notes/open.txt" });
  assert.match(text(await app.documents.search("local", { query: "SECRET LEDGER total" })), new RegExp(secretText));
  await financeRule(app);
  const after = await app.documents.search("local", { query: "SECRET LEDGER total OPEN NOTE plan" });
  assert.doesNotMatch(text(after), new RegExp(secretText));
  assert.match(text(after), new RegExp(openText));
});

// ------------------------------------------------------------------ snapshots and what leaves the computer

test("a snapshot a task takes leaves finance out and says so; one the owner takes from the window keeps everything", async (t) => {
  const { app, result } = await runTool(t, "workspace.snapshot", { label: "before" });
  assert.equal(result.files, 2, "only the two allowed files");
  assert.match(result.leftOut ?? "", /the folder finance/);
  const kept = app.store.sqlite.prepare("SELECT path FROM file_versions WHERE snapshot_id=?").all(result.id).map((row) => row.path).sort();
  assert.deepEqual(kept, ["notes/open.txt", "readme.md"]);
  const owners = await app.store.openWorkspaceHistory(app.files, "local").snapshot({ label: "mine" });
  assert.equal(owners.files, 4, "the owner's own snapshot from the window is unaffected");
  assert.equal(owners.leftOut, undefined);
});

test("a pull request made from the workspace's changes never sends a refused file", async (t) => {
  const { app } = await fixture(t);
  await financeRule(app);
  const { z } = await import("zod");
  const { pullRequestFromChanges, savePullRequestHookSettings } = await import("../dist/pr-hook.js");
  const { NetworkPolicy } = await import("../dist/index.js");
  savePullRequestHookSettings(app.store, "local", { mode: "on" });
  app.registry.register({ name: "github.open_pull_request", permission: "github.manage", description: "stand-in",
    parameters: z.object({}).passthrough(), execute: async (args) => args });
  const calls = [];
  const answers = { "remote get-url": "git@github.com:acme/widgets.git", "symbolic-ref": "refs/remotes/origin/main",
    "status": " M finance/q1.txt\n M notes/open.txt\n" };
  const git = async (options) => {
    calls.push(options.args.join(" "));
    const key = Object.keys(answers).find((prefix) => options.args.join(" ").startsWith(prefix));
    return { status: "completed", stdout: key === undefined ? "" : answers[key], stderr: "", exitCode: 0, command: "git" };
  };
  const opened = await pullRequestFromChanges({ store: app.store, owner: "local", files: app.files, git, registry: app.registry,
    policy: new NetworkPolicy({ allowPrivateAddresses: true }), runTool: async () => ({ number: 7 }) },
  { name: "x", title: "t", summary: "s", paths: null, signal: AbortSignal.timeout(10000) });
  assert.deepEqual(opened.files, ["notes/open.txt"]);
  assert.ok(!calls.some((command) => command.includes("finance")), "git was never handed a finance file");
});

// ------------------------------------------------------------------ the other walkers

test("another program reading the workspace through the MCP server's file list does not see finance", async (t) => {
  const { app, root } = await fixture(t);
  await financeRule(app);
  // The MCP door offers nothing while sharing is off, so the owner shares (no tools) first.
  app.store.save("settings", app.runtime.owner, "mcp-sharing", { enabled: true, exposedTools: [], a2a: false });
  const { startServer } = await import("../dist/server.js");
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); });
  const ask = async (body) => (await fetch(`${server.url}/mcp`, { method: "POST", body: JSON.stringify(body),
    headers: { authorization: `Bearer ${server.token}`, origin: server.url, "content-type": "application/json", "mcp-session-id": "walk" } })).json();
  await ask({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", clientInfo: { name: "t", version: "1" } } });
  const read = await ask({ jsonrpc: "2.0", id: 2, method: "resources/read", params: { uri: "workspace://files" } });
  const listing = JSON.parse(read.result.contents[0].text);
  assert.deepEqual(listing.entries.map((entry) => entry.name).sort(), ["notes", "readme.md"]);
  assert.match(listing.leftOut, /the folder finance/);
});

test("comments for the assistant in a refused file never start a task", async (t) => {
  const { app, workspace } = await fixture(t);
  await financeRule(app);
  await writeFile(join(workspace, "finance", "calc.py"), "x = 1  # make this faster AI!\n");
  await writeFile(join(workspace, "notes", "calc.py"), "y = 2  # explain this AI?\n");
  const { AICommentScanner } = await import("../dist/ai-comments.js");
  const report = await new AICommentScanner(app.files).scan(["finance/calc.py", "notes/calc.py"]);
  assert.deepEqual(report.comments.map((comment) => comment.file), ["notes/calc.py"]);
  assert.doesNotMatch(report.taskText, /finance/);
});

test("the facts a new project's instructions are drafted from leave out a refused folder", async (t) => {
  const { app } = await fixture(t);
  await financeRule(app);
  const { projectFacts } = await import("../dist/coding/init.js");
  const { underTask } = await import("../dist/task-scope.js");
  const run = app.store.createRun("local", "draft instructions");
  const facts = await underTask(run.id, () => projectFacts(app.files), "code.init");
  assert.deepEqual(facts.folders, ["notes"]);
});

test("a language server's list of problems leaves out a file the rules now refuse", async (t) => {
  const { app, workspace } = await fixture(t);
  const { saveLanguageServerSettings } = await import("../dist/index.js");
  const fake = join(import.meta.dirname, "fixtures", "fake-language-server.mjs");
  await saveLanguageServerSettings(app.store, "local", { enabled: true, timeoutMs: 10000,
    servers: { fake: { path: process.execPath, args: [fake], languages: ["TypeScript"] } } });
  t.after(() => app.languageServers.stopAll());
  await writeFile(join(workspace, "finance", "sums.ts"), "export const total = 1;\nconsole.log(total);\n");
  await app.runtime.executeTool("code.diagnostics", { path: "finance/sums.ts", waitMs: 300 });
  const before = await app.runtime.executeTool("code.diagnostics", { waitMs: 0 });
  assert.equal(before.diagnostics.length, 1, "the server's complaint about the file is there before the rule");
  await financeRule(app);
  const after = await app.runtime.executeTool("code.diagnostics", { waitMs: 0 });
  assert.equal(after.diagnostics.length, 0);
  assert.match(after.leftOut ?? "", /1 file in finance/);
});

test("obsidian.read does not read a tagged note in a refused folder when the notes folder is the workspace", async (t) => {
  const { app, workspace } = await fixture(t, [call("obsidian.read", {}), say("done")]);
  await writeFile(join(workspace, "finance", "ledger.md"), `#branch\n${secretText}\n`);
  await writeFile(join(workspace, "notes", "plan.md"), `#branch\n${openText}\n`);
  const { saveObsidianSettings } = await import("../dist/obsidian.js");
  await saveObsidianSettings(app.store, "local", { enabled: true, vault: workspace });
  await financeRule(app);
  const run = await app.runtime.run({ prompt: "read my notes" });
  const [completed] = app.store.events(run.id).filter((event) => event.kind === "tool.completed");
  assert.match(text(completed?.data.result), new RegExp(openText));
  assert.doesNotMatch(text(completed?.data.result), new RegExp(secretText));
});

test("a place under the workspace is judged by the rules however the disk spells the workspace's path", async (t) => {
  const { realpathSync } = await import("node:fs");
  const { byFullAddress } = await import("../dist/walk-rules.js");
  const { workspace } = await fixture(t);
  // The notes walker's paths come from fs/promises realpath: on a Windows build machine TEMP is
  // C:\Users\RUNNER~1\..., and that spells it C:\Users\runneradmin\... (ci-flakes-3).
  const spelled = realpathSync.native(workspace);
  const rules = { folder: (path) => path !== "finance", file: (path) => !path.startsWith("finance/") };
  const may = byFullAddress(rules, workspace);
  assert.equal(may(join(spelled, "finance", "ledger.md"), false), false, "a refused file, by the disk's own spelling");
  assert.equal(may(join(spelled, "finance"), true), false);
  assert.equal(may(join(spelled, "notes", "plan.md"), false), true);
});

// ------------------------------------------------------------------ the check itself

test("the check: a broad question already answered for the walk does not hide anything; a question about one folder does", async () => {
  const { walkCheck, WalkRules } = await import("../dist/walk-rules.js");
  const { PolicySchema } = await import("../dist/policy.js");
  const { resourceOf } = await import("../dist/policy-resources.js");
  const check = (rules, scope = "") => walkCheck({ policy: PolicySchema.parse({ rules }), tool: "files.grep", scope,
    // As the registry answers: with the path as written from the workspace when a project folder is active.
    resourceOf: (tool, path) => ({ ...resourceOf(tool, "files.read", path, { path }), ...(scope ? { inWorkspace: `${scope}/${path}` } : {}) }) });
  const everything = { tool: "*", match: "*", decision: "ask" };
  const finance = (decision, pattern = "finance") => ({ tool: "*", match: "*", decision, resource: { kind: "path", pattern } });
  assert.equal(check([everything])("finance/q1.txt", "read"), true, "every call asks: the walk itself was asked about");
  assert.equal(check([finance("ask"), everything])("finance/q1.txt", "read"), false, "a question about finance itself");
  assert.equal(check([finance("deny")])("notes/open.txt", "read"), true);
  assert.equal(check([finance("deny")])("Finance/Q1.TXT", "read"), false, "rules match whatever the letter case");
  // An allow for a folder inside, written first, still lets that folder through (the rules' own order).
  const inner = { tool: "*", match: "*", decision: "allow", resource: { kind: "path", pattern: "finance/public" } };
  assert.equal(check([inner, finance("deny")])("finance/public/a.txt", "read"), true);
  assert.equal(check([inner, finance("deny")])("finance/q1.txt", "read"), false);
  // A pattern, not a folder: every folder is weighed.
  assert.equal(check([finance("deny", "*.csv")])("notes/deep/a.csv", "read"), false);
  assert.equal(check([finance("deny", "*.csv")])("notes/deep/a.txt", "read"), true);
  // A rule about reading only, not listing, lets the name be listed but not the file be read.
  const readOnlyRule = { tool: "files.read", match: "*", decision: "deny", resource: { kind: "path", pattern: "finance" } };
  assert.equal(check([readOnlyRule])("finance/q1.txt", "list"), true);
  assert.equal(check([readOnlyRule])("finance/q1.txt", "read"), false);
  // Inside the active project's folder "finance", "q1.txt" is finance/q1.txt to the rules.
  assert.equal(check([finance("deny")], "finance")("q1.txt", "read"), false);
  assert.equal(check([finance("deny")], "notes")("q1.txt", "read"), true);
  // The note names the folder and counts files, never naming a file.
  const walk = new WalkRules(check([finance("deny"), finance("deny", "notes/*.key")]));
  walk.folder("finance"); walk.file("notes/a.key"); walk.file("notes/b.key"); walk.file("notes/a.key");
  assert.equal(walk.note(), "Some things were left out because the owner's rules keep this task out of them: the folder finance; 2 files in notes. Nothing from them is shown here.");
  assert.throws(() => walk.start("finance/2026"), /do not allow looking in finance\/2026/);
});

test("a task started from outside (a trigger) is held to the same folder rule during a walk", async (t) => {
  const { app } = await fixture(t, [call("files.grep", { query: "-", path: "." }), say("done")]);
  await financeRule(app);
  const run = await app.runtime.run({ prompt: "look", source: "trigger" });
  const [completed] = app.store.events(run.id).filter((event) => event.kind === "tool.completed");
  assertLeftOut(completed?.data.result, "files.grep for a trigger's task");
});

test("a rule against reading finance (listing allowed): walkers name its files but never read them", async (t) => {
  const readRule = (app) => financeRule(app, "deny", { tool: "files.read" });
  const grep = await runTool(t, "files.grep", { query: "-", path: "." }, readRule);
  assert.doesNotMatch(text(grep.result), new RegExp(secretText), "files.grep");
  assert.match(grep.result.leftOut ?? "", /1 file in finance/);
  const search = await runTool(t, "files.search", { query: "-" }, readRule);
  assert.doesNotMatch(text(search.result), new RegExp(secretText), "files.search");
  assert.match(text(search.result), new RegExp(openText));
  const listed = await runTool(t, "files.list", { path: "." }, readRule);
  assert.ok(listed.result.entries.some((entry) => entry.name === "finance"), "listing is still allowed");
  // The notes folder inside the workspace: a tagged note in finance is not read.
  const { app, workspace } = await fixture(t, [call("obsidian.read", {}), say("done")]);
  await writeFile(join(workspace, "finance", "ledger.md"), `#branch\n${secretText}\n`);
  await writeFile(join(workspace, "notes", "plan.md"), `#branch\n${openText}\n`);
  const { saveObsidianSettings } = await import("../dist/obsidian.js");
  await saveObsidianSettings(app.store, "local", { enabled: true, vault: workspace });
  await readRule(app);
  const run = await app.runtime.run({ prompt: "read my notes" });
  const [completed] = app.store.events(run.id).filter((event) => event.kind === "tool.completed");
  assert.match(text(completed?.data.result), new RegExp(openText));
  assert.doesNotMatch(text(completed?.data.result), new RegExp(secretText), "obsidian.read");
});

test("the map of names built before a rule no longer hands back finance's passages or links", async (t) => {
  const { app, workspace } = await fixture(t);
  await writeFile(join(workspace, "finance", "deal.md"), `# Deal\n\nAcme Holdings paid Zenith Partners. ${secretText}\n`);
  const base = app.knowledgeBases.create("local", { name: "Everything", sources: [{ kind: "folder", path: "." }] });
  await app.knowledgeBases.reindex("local", base.id);
  const graph = app.knowledgeParts.graph;
  await graph.build("local", base.id);
  assert.match(text(graph.passagesAround("local", base.id, "Acme Holdings", 10)), new RegExp(secretText), "before the rule (control)");
  await financeRule(app);
  assert.doesNotMatch(text(graph.passagesAround("local", base.id, "Acme Holdings", 10)), new RegExp(secretText));
});

// ------------------------------------------------------------------ integration (adversarial review)

test("integration: a walk of a folder the owner was asked about and said yes to shows what is inside", async (t) => {
  const walk = call("files.list", { path: "finance" });
  const { app } = await fixture(t, [walk, walk, say("done")]);
  await financeRule(app, "ask");
  // A refusal written for one file inside still holds after the yes.
  const { addPolicyRule } = await import("../dist/policy.js");
  addPolicyRule(app.store, "local", { tool: "*", match: "*", decision: "deny", remember: "always", resource: { kind: "path", pattern: "finance/q1.txt" } });
  const first = await app.runtime.run({ prompt: "look" });
  assert.equal(first.status, "needs_input", "the walk of finance is asked about");
  app.runtime.approve(first.sessionId, "allow", "session");
  const second = await app.runtime.run({ prompt: "look", sessionId: first.sessionId });
  const failed = app.store.events(second.id).filter((event) => event.kind === "tool.failed");
  assert.deepEqual(failed, [], "the owner's yes is not overruled by the walk");
  const [completed] = app.store.events(second.id).filter((event) => event.kind === "tool.completed");
  assert.deepEqual(completed.data.result.entries.map((entry) => entry.name), ["2026"]);
  assert.match(completed.data.result.leftOut ?? "", /1 file in finance/);
});

test("integration: documents.list and the MCP document library do not name a document read from a refused file", async (t) => {
  const { app, root } = await fixture(t, [call("documents.list", {}), say("done")]);
  await app.documents.add("local", { path: "finance/q1.txt" });
  await app.documents.add("local", { path: "notes/open.txt" });
  await app.documents.add("local", { name: "pasted", text: "just text" });
  await financeRule(app);
  const run = await app.runtime.run({ prompt: "what documents do I have" });
  const [completed] = app.store.events(run.id).filter((event) => event.kind === "tool.completed");
  assert.deepEqual(completed.data.result.documents.map((document) => document.name).sort(), ["open.txt", "pasted"]);
  assert.doesNotMatch(text(completed.data.result.documents), /q1/);
  assert.match(completed.data.result.leftOut ?? "", /1 file in finance/);
  assert.equal(app.documents.list("local").length, 3, "the owner's own window still lists everything");
  // The MCP door offers nothing while sharing is off, so the owner shares (no tools) first.
  app.store.save("settings", app.runtime.owner, "mcp-sharing", { enabled: true, exposedTools: [], a2a: false });
  const { startServer } = await import("../dist/server.js");
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); });
  const ask = async (body) => (await fetch(`${server.url}/mcp`, { method: "POST", body: JSON.stringify(body),
    headers: { authorization: `Bearer ${server.token}`, origin: server.url, "content-type": "application/json", "mcp-session-id": "docs" } })).json();
  await ask({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", clientInfo: { name: "t", version: "1" } } });
  const read = await ask({ jsonrpc: "2.0", id: 2, method: "resources/read", params: { uri: "documents://library" } });
  const listed = JSON.parse(read.result.contents[0].text);
  assert.deepEqual(listed.map((document) => document.name).sort(), ["open.txt", "pasted"]);
});

test("integration: only tools that do not walk (git) refuse a whole folder; a walker is never a whole-folder target", async (t) => {
  const { app } = await fixture(t);
  const shapes = [{ folder: "." }, { folder: ".", message: "m" }, { folder: ".", name: "copy" }, { path: "." },
    { name: "x", sources: [{ kind: "folder", path: "." }] }, { collection: "c", source: { kind: "folder", path: "." } }];
  const judged = new Map();
  for (const name of app.registry.names()) {
    for (const args of shapes) {
      try { judged.set(name, app.registry.targetsOf(name, args, {})); break; } catch { /* not this tool's shape */ }
    }
  }
  assert.ok(judged.get("knowledge.create")?.length && judged.get("knowledge.add")?.length, "the knowledge tools were judged");
  const whole = [...judged].filter(([, targets]) => (targets ?? []).some((target) => target.folder)).map(([name]) => name);
  assert.ok(whole.includes("git.diff"), "git still refuses a whole folder holding a refused one");
  assert.deepEqual(whole.filter((name) => !/^(git|plans|github)\./.test(name)), [],
    "a walking tool filters what is inside (src/walk-rules.ts); declaring a whole folder would refuse the walk instead");
});

test("integration: a knowledge base of the whole workspace made by a task is made, and read without finance", async (t) => {
  const { app } = await fixture(t, [call("knowledge.create", { name: "All", sources: [{ kind: "folder", path: "." }] }), say("done")]);
  await financeRule(app);
  const run = await app.runtime.run({ prompt: "make a knowledge base of everything" });
  assert.deepEqual(app.store.events(run.id).filter((event) => event.kind === "policy.denied"), [], "not refused whole");
  const [base] = app.knowledgeBases.list("local");
  assert.ok(base, "the base was made");
  assert.deepEqual((await app.knowledgeBases.filesIn("local", base.id)).sort(), ["notes/open.txt", "readme.md"]);
});
