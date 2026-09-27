import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { addPolicyRule, savePolicy } from "../dist/policy.js";

/**
 * mac7/multi-target: a permission rule judges every file, folder or address a call touches, not just
 * one (docs/agents/STATUS-multi-target.md). Every model here is a scripted fake; nothing opens a window.
 */

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-multi-target-"));
  const provider = options.provider ?? { name: "scripted", async complete() { return { content: "done", toolCalls: [] }; } };
  const workspace = join(root, "workspace");
  const app = await createBranch({
    workspace, dataDir: join(root, "data"),
    presets: [{ id: "alpha", name: "Alpha", provider, model: "a" }],
  });
  app.coding.setMode("read-first", "off"); // read-first ships on (Q250); these tests are about targets, not reading first
  t.after(async () => { await app.close(); await discardTemp(root); });
  await mkdir(join(workspace, "src"), { recursive: true });
  await mkdir(join(workspace, "finance"), { recursive: true });
  await writeFile(join(workspace, "src", "a.ts"), "one\n");
  await writeFile(join(workspace, "finance", "b.csv"), "1\n");
  return { app, root, workspace };
}
function scripted(steps) {
  const provider = { name: "scripted", requests: [], async complete(request) {
    provider.requests.push(request);
    return steps[Math.min(provider.requests.length - 1, steps.length - 1)](request);
  } };
  return provider;
}
const say = (content) => () => ({ content, toolCalls: [] });
const call = (name, args) => () => ({ content: "", toolCalls: [{ id: `c${Math.random().toString(36).slice(2, 8)}`, name, arguments: JSON.stringify(args) }] });
const eventsOf = (app, run, kind) => app.store.events(run.id).filter((event) => event.kind === kind);
/** "Never allow anything under finance" (or "ask before anything under finance"). */
const financeRule = (app, decision = "deny", applies = "any") =>
  addPolicyRule(app.store, "local", { tool: "*", match: "*", applies, decision, remember: "always", resource: { kind: "path", pattern: "finance" } });
const judge = (app, tool, args) => app.runtime.checkPolicy(tool, args, app.runtime.context({}));

const srcPart = "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-one\n+ONE\n";
const financePart = "--- a/finance/b.csv\n+++ b/finance/b.csv\n@@ -1 +1 @@\n-1\n+2\n";
const bothFiles = srcPart + financePart;

/** A refusal that names the target refused, as the model and the record are told it. */
function refusedNaming(check, path) {
  assert.equal(check.decision, "deny", `${path} should be refused`);
  assert.match(check.reason ?? "", new RegExp(path.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")), "the refusal names the file refused");
}

// ------------------------------------------------------------------ every multi-file tool

test("code.patch across an allowed and a refused file is refused naming the refused one, and nothing is written", async (t) => {
  const provider = scripted([call("code.patch", { patch: bothFiles }), say("done")]);
  const { app, workspace } = await fixture(t, { provider });
  financeRule(app);
  const run = await app.runtime.run({ prompt: "patch them" });
  const [denied] = eventsOf(app, run, "policy.denied");
  assert.ok(denied, "the call was refused");
  assert.match(denied.data.reason, /finance\/b\.csv/);
  assert.doesNotMatch(denied.data.reason, /change src\/a\.ts/, "the allowed file is not the one named");
  assert.equal(await readFile(join(workspace, "src", "a.ts"), "utf8"), "one\n", "the allowed file was not changed either");
  assert.equal(await readFile(join(workspace, "finance", "b.csv"), "utf8"), "1\n");
  assert.equal(eventsOf(app, run, "tool.completed").length, 0);
});

test("code.patch whose files are all allowed goes through as before", async (t) => {
  const provider = scripted([call("code.patch", { patch: srcPart }), say("done")]);
  const { app, workspace } = await fixture(t, { provider });
  financeRule(app);
  const run = await app.runtime.run({ prompt: "patch it" });
  assert.equal(eventsOf(app, run, "policy.denied").length, 0);
  assert.equal(await readFile(join(workspace, "src", "a.ts"), "utf8"), "ONE\n");
});

test("files.patch now has targets: every file in the patch, and a refused one refuses the call", async (t) => {
  const { app } = await fixture(t);
  assert.deepEqual(app.registry.targetsOf("files.patch", { patch: bothFiles }, {}),
    [{ kind: "write", path: "src/a.ts" }, { kind: "write", path: "finance/b.csv" }]);
  assert.equal(app.registry.targetOf("files.patch", { patch: bothFiles }, {}), "2 files: src/a.ts, finance/b.csv");
  financeRule(app);
  refusedNaming(judge(app, "files.patch", { patch: bothFiles }), "finance/b.csv");
  assert.equal(judge(app, "files.patch", { patch: srcPart }).decision, "allow");
});

test("code.change_set: one refused file in the set refuses the set, naming it", async (t) => {
  const { app } = await fixture(t);
  financeRule(app);
  const edits = [{ path: "src/a.ts", find: "one", replace: "ONE" }, { path: "finance/b.csv", find: "1", replace: "2" }];
  refusedNaming(judge(app, "code.change_set", { reason: "tidy", edits }), "finance/b.csv");
  assert.equal(judge(app, "code.change_set", { reason: "tidy", edits: edits.slice(0, 1) }).decision, "allow");
});

test("documents.compare: the second file (`against`) is judged too", async (t) => {
  const { app } = await fixture(t);
  financeRule(app);
  refusedNaming(judge(app, "documents.compare", { file: "public/a.md", against: "finance/b.md" }), "finance/b.md");
  refusedNaming(judge(app, "documents.compare", { file: "finance/b.md", against: "public/a.md" }), "finance/b.md");
  assert.equal(judge(app, "documents.compare", { file: "public/a.md", against: "public/b.md" }).decision, "allow");
});

test("knowledge.create: every source in the list is judged", async (t) => {
  const { app } = await fixture(t);
  financeRule(app);
  const sources = [{ kind: "folder", path: "notes" }, { kind: "folder", path: "finance" }];
  refusedNaming(judge(app, "knowledge.create", { name: "Work", sources }), "finance");
  assert.equal(judge(app, "knowledge.create", { name: "Work", sources: sources.slice(0, 1) }).decision, "allow");
});

test("documents.edit with saveAs: the source it reads is judged as well as the file it writes", async (t) => {
  const { app } = await fixture(t);
  financeRule(app);
  const changes = [{ op: "replace-text", find: "a", replaceWith: "b" }];
  refusedNaming(judge(app, "documents.edit", { path: "finance/q1.docx", changes, saveAs: "public/copy.docx" }), "finance/q1.docx");
});

test("a patch that renames into a refused folder is refused, and so is one that renames out of it", async (t) => {
  const { app } = await fixture(t);
  financeRule(app);
  const into = "--- a/src/a.ts\n+++ b/finance/a.ts\n@@ -1 +1 @@\n-one\n+ONE\n";
  assert.deepEqual(app.registry.targetsOf("code.patch", { patch: into }, {}),
    [{ kind: "write", path: "finance/a.ts" }, { kind: "write", path: "src/a.ts" }], "both the old and the new path");
  refusedNaming(judge(app, "code.patch", { patch: into }), "finance/a.ts");
  refusedNaming(judge(app, "files.patch", { patch: into }), "finance/a.ts");
  const outOf = "diff --git a/finance/b.csv b/src/b.csv\n--- a/finance/b.csv\n+++ b/src/b.csv\n@@ -1 +1 @@\n-1\n+2\n";
  refusedNaming(judge(app, "code.patch", { patch: outOf }), "finance/b.csv");
  // The other form some models write, read by the same reader the tool applies it with.
  const envelope = "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-one\n+ONE\n*** Add File: finance/new.csv\n+3\n*** End Patch\n";
  refusedNaming(judge(app, "code.patch", { patch: envelope }), "finance/new.csv");
});

test("a patch whose files cannot be told is refused, not waved through", async (t) => {
  const { app } = await fixture(t);
  for (const patch of ["just some words", "*** Begin Patch\n*** Delete File: src/a.ts\n*** End Patch\n", "--- a/src/a.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-one\n"]) {
    for (const tool of ["code.patch", "files.patch"]) {
      const check = judge(app, tool, { patch });
      assert.equal(check.decision, "deny", `${tool} with ${JSON.stringify(patch.slice(0, 30))}`);
      assert.match(check.reason, /could not tell every file/);
    }
  }
});

test("git tools: a repository folder under a refused folder is refused, and so is a file named inside it", async (t) => {
  const { app } = await fixture(t);
  financeRule(app);
  refusedNaming(judge(app, "git.status", { folder: "finance" }), "finance");
  refusedNaming(judge(app, "git.commit", { folder: "finance/books", message: "save" }), "finance/books");
  refusedNaming(judge(app, "git.log", { folder: ".", path: "finance/q1.csv" }), "finance/q1.csv");
  refusedNaming(judge(app, "git.commit", { folder: ".", message: "save", paths: ["src/a.ts", "finance/b.csv"] }), "finance/b.csv");
  assert.equal(judge(app, "git.status", { folder: "src" }).decision, "allow", "a repository folder outside finance");
});

// ------------------------------------------------------------------ kinds: a read-only folder

test("a read-only folder: reading from it is allowed, changing anything in it is not", async (t) => {
  const { app } = await fixture(t);
  financeRule(app, "deny", "changes");
  const changes = [{ op: "replace-text", find: "a", replaceWith: "b" }];
  assert.equal(judge(app, "documents.compare", { file: "finance/a.md", against: "public/b.md" }).decision, "allow");
  assert.equal(judge(app, "documents.edit", { path: "finance/q1.docx", changes, saveAs: "public/copy.docx" }).decision, "allow",
    "copying out of a read-only folder only reads it");
  refusedNaming(judge(app, "documents.edit", { path: "public/a.docx", changes, saveAs: "finance/copy.docx" }), "finance/copy.docx");
  refusedNaming(judge(app, "code.patch", { patch: bothFiles }), "finance/b.csv");
  assert.equal(judge(app, "git.status", { folder: "finance" }).decision, "allow", "looking at a repository only reads it");
  refusedNaming(judge(app, "git.commit", { folder: "finance", message: "save" }), "finance");
  // A dry run only reads the files, so it is not held by a read-only folder...
  assert.equal(judge(app, "code.patch", { patch: bothFiles, dryRun: true }).decision, "allow");
  // ...but "never anything under finance" covers reading too: a dry run shows the file's lines.
  financeRule(app, "deny", "any");
  refusedNaming(judge(app, "code.patch", { patch: bothFiles, dryRun: true }), "finance/b.csv");
});

// ------------------------------------------------------------------ asking: the card and standing answers

test("an ask about a file in the call puts the question with every file listed", async (t) => {
  const provider = scripted([call("code.patch", { patch: bothFiles }), say("done")]);
  const { app } = await fixture(t, { provider });
  financeRule(app, "ask");
  const run = await app.runtime.run({ prompt: "patch them" });
  assert.equal(run.status, "needs_input");
  const [question] = eventsOf(app, run, "policy.ask");
  assert.deepEqual(question.data.files, [{ kind: "write", path: "src/a.ts" }, { kind: "write", path: "finance/b.csv" }]);
  assert.equal(question.data.target, "2 files: src/a.ts, finance/b.csv");
  const [waiting] = app.runtime.approvals.waiting(run.sessionId);
  assert.deepEqual(waiting.files, question.data.files, "the card is given the list");
});

test("a standing yes for the whole call still counts for each file; a folder rule still beats it", async (t) => {
  const { app } = await fixture(t);
  savePolicy(app.store, "local", { preset: "ask-before-changes" });
  const first = judge(app, "code.patch", { patch: bothFiles });
  assert.equal(first.decision, "ask");
  addPolicyRule(app.store, "local", { tool: "code.patch", match: first.target, decision: "allow", remember: "always" });
  assert.equal(judge(app, "code.patch", { patch: bothFiles }).decision, "allow", "Always is not asked again");
  financeRule(app, "ask");
  assert.equal(judge(app, "code.patch", { patch: bothFiles }).decision, "ask", "a rule about the folder is weighed before it");
});

// ------------------------------------------------------------------ the other places a call is judged

test("another AI tool's dry run and \"Try a tool\" weigh every file and list them", async (t) => {
  const { app, workspace } = await fixture(t);
  financeRule(app);
  const { dryRunPlan } = await import("../dist/mcp-policy.js");
  const plan = dryRunPlan(app.registry, app.store, "local", workspace, { name: "code.patch", arguments: { patch: bothFiles } });
  assert.equal(plan.decision, "deny");
  assert.ok(plan.files.includes("src/a.ts") && plan.files.includes("finance/b.csv"), "both files are listed");
  const unreadable = dryRunPlan(app.registry, app.store, "local", workspace, { name: "files.patch", arguments: { patch: "nothing" } });
  assert.equal(unreadable.decision, "deny");
  const { tryTool } = await import("../dist/playground.js");
  const tried = await tryTool(app.registry, app.store, "local", app.runtime.context({ permissions: ["files.write"] }),
    { name: "files.patch", arguments: { patch: bothFiles } });
  assert.equal(tried.status, "refused");
  assert.equal(await readFile(join(workspace, "src", "a.ts"), "utf8"), "one\n");
});

// ------------------------------------------------------------------ no change for single-target tools

test("only the tools that touch several things declare them; every other tool is judged exactly as before", async (t) => {
  const { app } = await fixture(t);
  const declared = app.registry.names().filter((name) => {
    try { return app.registry.targetsOf(name, {}, {}) !== null; } catch { return true; }
  }).sort();
  const expected = ["channels.broadcast", "channels.digest", "code.change_set", "code.patch", "documents.compare", "documents.edit", "files.patch", "knowledge.add", "knowledge.create",
    "git.branch", "git.commit", "git.diff", "git.log", "git.status", "git.worktree_add", "git.worktree_list", "git.worktree_remove",
    "plans.diff", "plans.merge", "plans.try", "research.run",
    // The wiki: a page is named like a path so a rule can be written about one page or about all of
    // them, and a read that follows links names every page it would hand a piece of back (src/wiki.ts).
    "wiki.history", "wiki.read", "wiki.search", "wiki.write",
    // Handing a coding job to Claude Code or Codex names the folder it may change (src/coding/hand-off.ts).
    "code.hand_off"];
  // git.push / git.pull / github.publish_repo are registered only when the owner switches them on.
  assert.deepEqual(declared.filter((name) => !expected.includes(name)), [], "no other tool declares targets");
  assert.deepEqual(expected.filter((name) => !declared.includes(name)), [], "every multi-target tool declares them");
  // A repository folder is read by the git tools that only look (`git.read`) and changed by the others.
  const fits = (name) => [{ folder: "x" }, { folder: "x", name: "copy" }, { folder: "x", message: "m" }]
    .find((args) => app.registry.runArgs(name, args) !== args);
  for (const name of declared.filter((one) => /^(git|plans)\./.test(one))) {
    const [folder] = app.registry.targetsOf(name, fits(name), {});
    assert.equal(folder.kind === "read", app.registry.permissionOf(name) === "git.read", name);
  }
});

// ------------------------------------------------------------------ the conversation's own mode (redesign phase 1)

test("Auto mode lets workspace changes through, but a refused folder in a patch still refuses the patch", async (t) => {
  const provider = scripted([call("code.patch", { patch: bothFiles }), say("done")]);
  const { app, workspace } = await fixture(t, { provider });
  financeRule(app);
  const run = await app.runtime.run({ prompt: "patch them", conversationMode: "auto" });
  const [denied] = eventsOf(app, run, "policy.denied");
  assert.match(denied?.data.reason ?? "", /finance\/b\.csv/);
  assert.equal(await readFile(join(workspace, "src", "a.ts"), "utf8"), "one\n");
});

test("Plan mode: looking at two files is fine, unless one of them is in a refused folder", async (t) => {
  const { app } = await fixture(t);
  financeRule(app);
  const run = app.store.createRun("local", "compare", undefined, false);
  app.runtime.startMode(run.sessionId, "plan");
  const context = app.runtime.context({ runId: run.id });
  assert.equal(app.runtime.checkPolicy("documents.compare", { file: "public/a.md", against: "public/b.md" }, context).decision, "allow");
  refusedNaming(app.runtime.checkPolicy("documents.compare", { file: "public/a.md", against: "finance/b.md" }, context), "finance/b.md");
  assert.equal(app.runtime.checkPolicy("code.patch", { patch: srcPart }, context).decision, "deny", "Plan changes nothing");
});

// ------------------------------------------------------------------ integration review (adversarial)

const partFor = (path) => `--- a/${path}
+++ b/${path}
@@ -1 +1 @@
-1
+2
`;
const patchOf = (paths) => paths.map(partFor).join("");

test("integration: an Always for a long list of files never covers another list that starts the same way", async (t) => {
  const { app } = await fixture(t);
  savePolicy(app.store, "local", { preset: "ask-before-changes" });
  const listA = Array.from({ length: 8 }, (_, i) => `src/f${i}.ts`);
  const listB = [...listA.slice(0, 7), "finance/secret.csv"];
  const first = judge(app, "code.patch", { patch: patchOf(listA) });
  assert.equal(first.decision, "ask");
  addPolicyRule(app.store, "local", { tool: "code.patch", match: first.target, decision: "allow", remember: "always" });
  assert.equal(judge(app, "code.patch", { patch: patchOf(listA) }).decision, "allow", "the same list is not asked again");
  const other = judge(app, "code.patch", { patch: patchOf(listB) });
  assert.notEqual(other.target, first.target, "a different list has a different name");
  assert.equal(other.decision, "ask", "the eighth file was never seen by the owner, so it is asked about");
  // Seven long names still make a name a standing answer can be saved under (500 characters at most).
  const long = Array.from({ length: 7 }, (_, i) => `src/${"x".repeat(90)}${i}.ts`);
  const named = judge(app, "code.patch", { patch: patchOf(long) }).target;
  assert.ok(named.length <= 500, `${named.length} characters`);
  addPolicyRule(app.store, "local", { tool: "code.patch", match: named, decision: "allow", remember: "always" });
});

test("integration: an Always given for a dry run is not a standing yes for every patch", async (t) => {
  const { app } = await fixture(t);
  savePolicy(app.store, "local", { preset: "ask-before-changes" });
  const look = judge(app, "code.patch", { patch: srcPart, dryRun: true });
  assert.equal(look.target, "look at 1 file: src/a.ts");
  addPolicyRule(app.store, "local", { tool: "code.patch", match: look.target || "*", decision: "allow", remember: "always" });
  assert.equal(judge(app, "code.patch", { patch: bothFiles }).decision, "ask", "a real change is still asked about");
  assert.equal(judge(app, "code.patch", { patch: srcPart }).decision, "ask", "even to the same file");
  const edits = [{ path: "src/a.ts", find: "one", replace: "ONE" }];
  assert.equal(app.registry.targetOf("code.change_set", { reason: "r", edits, dryRun: true }, {}), "look at 1 file: src/a.ts");
});

test("integration: a star in an Always is a star, not any file", async (t) => {
  const { app } = await fixture(t);
  savePolicy(app.store, "local", { preset: "ask-before-changes" });
  const starred = judge(app, "code.patch", { patch: srcPart + partFor("*") });
  assert.equal(starred.target, "2 files: src/a.ts, *");
  addPolicyRule(app.store, "local", { tool: "code.patch", match: starred.target, decision: "allow", remember: "always" });
  assert.equal(judge(app, "code.patch", { patch: srcPart + partFor("finance/b.csv") }).decision, "ask");
});

test("integration: a whole folder holding a refused folder is refused; naming a file inside it is judged on the file", async (t) => {
  const { app } = await fixture(t);
  financeRule(app);
  refusedNaming(judge(app, "git.diff", { folder: "." }), "finance");
  refusedNaming(judge(app, "git.status", {}), "finance");
  refusedNaming(judge(app, "git.commit", { folder: ".", message: "save" }), "finance");
  assert.equal(judge(app, "git.commit", { folder: ".", message: "save", paths: ["src/a.ts"] }).decision, "allow", "only src/a.ts is saved");
  assert.equal(judge(app, "git.log", { folder: ".", path: "src/a.ts" }).decision, "allow");
  assert.equal(judge(app, "git.diff", { folder: "src" }).decision, "allow", "a folder beside finance");
  // Integration (walk-rules): a knowledge base walks its folders and leaves out what the rules refuse
  // (tests/walk-rules.test.mjs), so a base of the whole workspace is not refused whole; the folder
  // named itself still is.
  assert.equal(judge(app, "knowledge.create", { name: "All", sources: [{ kind: "folder", path: "." }] }).decision, "allow");
  assert.equal(judge(app, "knowledge.create", { name: "One", sources: [{ kind: "file", path: "notes.md" }] }).decision, "allow");
  assert.equal(judge(app, "knowledge.add", { collection: "c", source: { kind: "folder", path: "./" } }).decision, "allow");
  refusedNaming(judge(app, "knowledge.add", { collection: "c", source: { kind: "folder", path: "finance" } }), "finance");
  addPolicyRule(app.store, "local", { tool: "*", match: "*", decision: "deny", remember: "always", resource: { kind: "path", pattern: "sr" } });
  assert.equal(judge(app, "git.diff", { folder: "src" }).decision, "allow", "a folder called sr is not inside src");
});

test("integration: a read-only folder inside a repository stops saving the whole copy, not looking at it", async (t) => {
  const { app } = await fixture(t);
  financeRule(app, "deny", "changes");
  assert.equal(judge(app, "git.diff", { folder: "." }).decision, "allow");
  refusedNaming(judge(app, "git.commit", { folder: ".", message: "save" }), "finance");
  // A rule that only asks makes the whole folder a question, not a refusal.
  const { app: other } = await fixture(t);
  financeRule(other, "ask");
  assert.equal(judge(other, "git.diff", { folder: "." }).decision, "ask");
});

test("integration: every file is judged as written from the workspace while a project's folder is active", async (t) => {
  const { app, workspace } = await fixture(t);
  // "Never anything under work/finance", while the active project's folder is work: "finance/q1.csv" in a
  // patch is work/finance/q1.csv on disk.
  addPolicyRule(app.store, "local", { tool: "*", match: "*", decision: "deny", remember: "always", resource: { kind: "path", pattern: "work/finance" } });
  app.store.projects.save("local", { id: "work", name: "Work", folder: "work" });
  app.store.projects.setActive("local", { active: "work" });
  const patch = partFor("notes.txt") + partFor("finance/q1.csv");
  refusedNaming(judge(app, "code.patch", { patch }), "finance/q1.csv");
  refusedNaming(judge(app, "documents.compare", { file: "a.md", against: "finance/b.md" }), "finance/b.md");
  refusedNaming(judge(app, "git.diff", { folder: "." }), "work/finance");
  assert.equal(judge(app, "git.diff", { folder: "notes" }).decision, "allow", "a folder of the project beside finance");
  const { dryRunPlan } = await import("../dist/mcp-policy.js");
  assert.equal(dryRunPlan(app.registry, app.store, "local", workspace, { name: "files.patch", arguments: { patch } }).decision, "deny");
  // In another project, the same names are not under work/finance.
  app.store.projects.save("local", { id: "garden", name: "Garden", folder: "garden" });
  app.store.projects.setActive("local", { active: "garden" });
  assert.equal(judge(app, "code.patch", { patch }).decision, "allow");
  assert.equal(judge(app, "git.diff", { folder: "." }).decision, "allow", "garden does not hold work/finance");
});
