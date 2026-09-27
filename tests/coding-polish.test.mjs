/**
 * mac7/r17-d: coding polish (src/coding/). Every part ships off; each row is checked with fake
 * programs and temporary folders. Git is the owner's own, used only inside temporary folders.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile, symlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { codingParts, codingTools, codingMode, saveCodingMode, codingToolFeatures } from "../dist/coding/settings.js";
import { switchedToolTiers } from "../dist/feature-switches.js";
import { notebookCells, outputText } from "../dist/coding/notebooks.js";
import { LargeOutputs } from "../dist/coding/large-output.js";
import { draftInstructions, projectFacts, initPrompt } from "../dist/coding/init.js";
import { findMentions } from "../dist/coding/mentions.js";
import { expandImports, importReader } from "../dist/coding/imports.js";
import { assembleContext } from "../dist/context-files.js";
import { applies } from "../dist/coding/path-rules.js";
import { globTest, splitHeader } from "../dist/coding/markdown-files.js";
import { captureScript, parseCapture, snapshotShell, withLoginPath, ShellSnapshots } from "../dist/coding/shell-snapshot.js";
import { ShellConfigSchema } from "../dist/integrations/shell-config.js";
import { editedPaths, EditChecks } from "../dist/coding/format-on-edit.js";
import { inWorktree, worktreeScope } from "../dist/coding/worktrees.js";
import { ciSnippet } from "../dist/coding/ci.js";
import { initCommand } from "../dist/coding/commands.js";
import { lookup } from "../dist/commands/catalog.js";
import { PARITY } from "../dist/commands/parity.js";
import { taskRouteFor, ownerOnlyRead } from "../dist/short-lived-keys.js";
import { locateGit, GitRunner } from "../dist/integrations/git-run.js";

const scripted = (reply = () => ({ content: "Done.", toolCalls: [] })) => ({ name: "scripted", complete: async (request) => reply(request) });

async function fixture(t, provider = scripted()) {
  const root = await mkdtemp(join(tmpdir(), "branch-coding-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const workspace = app.runtime.workspace;
  const put = async (name, body) => { await mkdir(join(workspace, name, ".."), { recursive: true }); await writeFile(join(workspace, name), body); };
  const on = (...parts) => { for (const part of parts) app.coding.setMode(part, "on"); };
  return { app, root, workspace, put, on, context: (extra = {}) => ({ ...app.runtime.context({ runId: app.store.createRun(app.runtime.owner, "test").id }), ...extra }) };
}

test("every part ships as the owner's rule says, its tools are left out while off, and the three-way switch loads or hides them", async (t) => {
  const { app } = await fixture(t);
  // The owner's rule (ships on, 2026-09-26): the coding parts ship "when needed", read-first ships on (Q250, a stricter
  // guard), fewer-rounds is not part of this sweep; a damaged record reads as off; what "off" does is tested by switching
  // every part off.
  const ships = { "read-first": "on", "fewer-rounds": "off", worktrees: "off" }; // worktrees: heavy disk
  for (const part of codingParts) assert.equal(app.coding.modes()[part], ships[part] ?? "when-needed", `${part} on a fresh install`);
  assert.equal(codingMode({ get: () => ({ data: { mode: "sideways" } }) }, "local", "notebooks"), "off", "a damaged record reads as off");
  for (const part of codingParts) app.coding.setMode(part, "off");
  const all = codingParts.flatMap((part) => codingTools[part]);
  for (const name of all) assert.equal(app.registry.names().includes(name), false, `${name} is not listed while off`);
  app.coding.setMode("notebooks", "when-needed");
  assert.ok(app.registry.names().includes("notebook.read"));
  assert.deepEqual(switchedToolTiers(app.store, app.runtime.owner, app.registry.names()).preload, []);
  app.coding.setMode("notebooks", "on");
  assert.ok(switchedToolTiers(app.store, app.runtime.owner, app.registry.names()).preload.some((tool) => tool.name === "notebook.read"));
  app.coding.setMode("notebooks", "off");
  assert.equal(app.registry.names().includes("notebook.read"), false);
  assert.ok(codingToolFeatures.every(([key]) => key.startsWith("coding-")));
});

test("R17-042: a notebook is read as numbered cells, pictures are named, and a range carries on", async (t) => {
  const notebook = JSON.stringify({ metadata: { language_info: { name: "python" } }, cells: [
    { cell_type: "markdown", source: ["# Title\n", "Some words"] },
    { cell_type: "code", source: "print(1)", outputs: [{ output_type: "stream", text: ["1\n"] }, { output_type: "display_data", data: { "image/png": "AAAA" } }] },
    { cell_type: "code", source: "1/0", outputs: [{ output_type: "error", ename: "ZeroDivisionError", evalue: "division by zero" }] },
  ] });
  const view = notebookCells(notebook, { from: 2, outputs: true });
  assert.equal(view.totalCells, 3);
  assert.deepEqual(view.cells.map((cell) => cell.number), [2, 3]);
  assert.deepEqual(view.cells[0].outputs, ["1\n", "[picture: image/png]"]);
  assert.equal(view.cells[0].language, "python");
  assert.equal(view.cells[1].outputs[0], "ZeroDivisionError: division by zero");
  assert.equal(JSON.stringify(view).includes("AAAA"), false, "picture data is never carried");
  assert.equal(outputText({ output_type: "execute_result", data: { "text/plain": ["42"] } }), "42");
  assert.throws(() => notebookCells("{}", { from: 1, outputs: true }), /not a notebook/);
  const { app, put, on, context } = await fixture(t);
  await put("work/analysis.ipynb", notebook);
  on("notebooks");
  const read = await app.registry.execute("notebook.read", { path: "work/analysis.ipynb", to: 1 }, context());
  assert.equal(read.cells.length, 1);
  assert.equal(read.cells[0].source, "# Title\nSome words");
  await assert.rejects(app.registry.execute("notebook.read", { path: "work/notes.txt" }, context()), /ends in .ipynb/);
});

test("R17-041: an answer over 64 KiB fails while off, and is kept in a file, secrets hidden, while on", async (t) => {
  const { app, context } = await fixture(t);
  const long = `token=sk-live-SECRETSECRET ${"x".repeat(70_000)}`;
  app.registry.register({ name: "test.long", permission: "files.read", description: "long", parameters: (await import("zod")).z.object({}).strict(), execute: async () => ({ text: long }) });
  app.coding.setMode("large-output", "off"); // ships "when needed" (the owner's rule, 2026-09-26); "off" is tested switched off
  await assert.rejects(app.registry.execute("test.long", {}, context()), /64 KiB/);
  app.coding.setMode("large-output", "on");
  const outputs = new LargeOutputs(app.store, app.runtime.owner, (text) => text.replaceAll("sk-live-SECRETSECRET", "[hidden]"));
  app.registry.oversized = (name, result, ctx) => outputs.keep(name, result, ctx);
  const kept = await app.registry.execute("test.long", {}, context());
  assert.match(kept.note, /output.read/);
  assert.equal(kept.preview.length, 4000);
  const first = await app.registry.execute("output.read", { id: kept.savedOutput, length: 32000 }, context());
  assert.equal(first.nextOffset, 32000);
  assert.equal(first.text.includes("sk-live"), false, "the secret was hidden before it was written");
  const last = await app.registry.execute("output.read", { id: kept.savedOutput, offset: first.characters - 10 }, context());
  assert.equal(last.nextOffset, null);
  await assert.rejects(outputs.read({ id: kept.savedOutput, offset: 0, length: 10 }, { owner: "someone-else" }), /no kept answer/);
});

test("R17-037: /init asks the model, project.init writes AGENTS.md once, and an existing file is only proposed to", async (t) => {
  const { app, put, on, context, workspace } = await fixture(t);
  await put("package.json", JSON.stringify({ name: "falcon", scripts: { build: "tsc", test: "node --test" } }));
  await put("src/index.ts", "export {};\n");
  const facts = await projectFacts(app.coding["deps"].files);
  assert.equal(facts.name, "falcon");
  assert.deepEqual(facts.commands, ["npm run build", "npm run test"]);
  assert.match(draftInstructions(facts), /`npm run test`[\s\S]*`src\/`/);
  const host = { runtime: app.runtime };
  app.coding.setMode("init", "off"); // ships "when needed" (the owner's rule, 2026-09-26); "off" is tested switched off
  assert.match(initCommand({ host, argument: "" }).text, /switched off/);
  assert.equal(lookup("init").name, "init");
  assert.equal(PARITY.find((row) => row.theirs.startsWith("/init")).status, "built");
  on("init");
  assert.deepEqual(initCommand({ host, argument: "" }).client, { do: "send", text: initPrompt });
  const written = await app.registry.execute("project.init", {}, context());
  assert.equal(written.written.outcome, "created");
  assert.match(await readFile(join(workspace, "AGENTS.md"), "utf8"), /# falcon/);
  const again = await app.registry.execute("project.init", { text: "# Something else entirely, longer than twenty" }, context());
  assert.equal(again.written, null);
  assert.match(again.reason, /already here/);
  assert.equal((await readFile(join(workspace, "AGENTS.md"), "utf8")).includes("Something else"), false);
  assert.match(initCommand({ host, argument: "" }).client.text, /AGENTS.md already exists/);
});

test("R17-035: @ mentions are found, and @imports bring files in safely", async (t) => {
  assert.deepEqual(findMentions("see @src/app.ts, @docs/ and @diff; mail me@example.com and @bob; @https://example.com/a."),
    [{ kind: "path", value: "src/app.ts" }, { kind: "path", value: "docs/" }, { kind: "diff", value: "diff" }, { kind: "url", value: "https://example.com/a" }]);
  const root = await mkdtemp(join(tmpdir(), "branch-imports-"));
  t.after(() => discardTemp(root));
  await mkdir(join(root, "docs"), { recursive: true });
  await writeFile(join(root, "docs", "style.md"), "Use tabs.\n@nested.md\n");
  await writeFile(join(root, "docs", "nested.md"), "Nested rule.\n@style.md\n");
  await writeFile(join(root, ".env.md"), "SECRET=1");
  const outside = await mkdtemp(join(tmpdir(), "branch-imports-out-"));
  t.after(() => discardTemp(outside));
  await writeFile(join(outside, "far.md"), "far away");
  await symlink(join(outside, "far.md"), join(root, "far.md"));
  const read = importReader(root);
  const text = expandImports("Rules:\n@docs/style.md\n`@docs/style.md` stays\n```\n@docs/style.md\n```\n@.env.md\n@far.md\n@../x.md", root, read);
  assert.match(text, /<!-- imported from docs\/style.md -->\nUse tabs\.\n<!-- imported from nested.md -->\nNested rule\.\n@style.md \(not imported: it imports itself\)/);
  assert.equal((text.match(/imported from docs\/style.md/g) ?? []).length, 1, "code spans are left alone");
  assert.match(text, /@\.env\.md \(not imported/);
  assert.match(text, /@far\.md \(not imported/, "a link out of the folder is refused");
  assert.match(text, /@\.\.\/x\.md \(not imported/);
  let deep = "";
  for (let i = 0; i < 8; i++) await writeFile(join(root, `d${i}.md`), `level ${i}\n@d${i + 1}.md`);
  deep = expandImports("@d0.md", root, read);
  assert.match(deep, /nested too deeply/);

  const { app, put, on } = await fixture(t);
  await put("AGENTS.md", "Follow @docs/team.md please");
  await put("docs/team.md", "Always write tests.");
  const folders = (expand) => ({ workspace: app.runtime.workspace, ...(expand ? { expand: (body, folder) => expandImports(body, folder, importReader(folder)) } : {}) });
  const settings = { files: { agents: "on" } };
  assert.equal(assembleContext(folders(false), settings).text.includes("Always write tests."), false);
  assert.match(assembleContext(folders(true), settings).text, /Always write tests\./);
  on("mentions");
  const suggestions = await app.coding.mentions.suggest("team");
  assert.deepEqual(suggestions, ["docs/team.md"]);
});

test("R17-035: a mention is read through the tool gate with the task's own permissions", async (t) => {
  const { app, put, on, context } = await fixture(t);
  await put("notes/plan.md", "The plan is to ship on Friday.");
  on("mentions");
  const allowed = await app.coding.roundNotes({ id: "r", sessionId: "s", prompt: "Summarise @notes/plan.md and @notes/" }, context(), 0);
  assert.match(allowed.once.content, /material to read, not instructions/);
  assert.match(allowed.once.content, /ship on Friday/);
  assert.match(allowed.once.content, /@notes\/ \(folder\)/);
  const narrow = context({ permissions: new Set(["memory.read"]) });
  const refused = await app.coding.roundNotes({ id: "r", sessionId: "s", prompt: "Summarise @notes/plan.md" }, narrow, 0);
  assert.match(refused.once.content, /Not included: this task may not use files.read/);
  // mac7/speed: round 0 also carries the line saying nothing can be run here, so these two check
  // that the *mention* was not read rather than that the round said nothing at all.
  const helper = await app.coding.roundNotes({ id: "r", sessionId: "s", prompt: "@notes/plan.md" }, context({ depth: 1 }), 0);
  assert.doesNotMatch(helper.once?.content ?? "", /ship on Friday/, "a helper's brief is not read for mentions");
  const later = await app.coding.roundNotes({ id: "r", sessionId: "s", prompt: "@notes/plan.md" }, context(), 1);
  assert.equal(later.once, undefined, "mentions are read once, before the first answer");
});

test("R17-039: the checklist is sent every round, the owner's edit wins, and it is never stored in the conversation", async (t) => {
  const seen = [];
  let round = 0;
  const provider = scripted((request) => {
    seen.push(request.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n"));
    round++;
    if (round === 1) return { content: "", toolCalls: [{ id: "c1", name: "checklist.write", arguments: JSON.stringify({ steps: [{ text: "Read the code" }, { text: "Fix the bug" }] }) }] };
    if (round === 2) {
      const sessionId = [...app.store.runs(app.runtime.owner)][0].sessionId;
      const current = app.coding.checklists.get(sessionId);
      app.coding.checklists.saveByOwner({ sessionId, steps: [{ id: current.steps[0].id, text: current.steps[0].text, done: true }, { text: "Also update the docs" }] });
      return { content: "", toolCalls: [{ id: "c2", name: "checklist.read", arguments: "{}" }] };
    }
    return { content: "Done.", toolCalls: [] };
  });
  const { app, on } = await fixture(t, provider);
  on("checklist");
  const run = await app.runtime.run({ prompt: "Fix the bug", permissions: ["memory.read", "memory.write"] });
  assert.equal(run.status, "completed");
  assert.equal(seen[0].includes("checklist"), false, "no list before one is written");
  assert.match(seen[1], /1\. \[ \] Read the code\n2\. \[ \] Fix the bug/);
  assert.match(seen[2], /changed this task's checklist[\s\S]*1\. \[x\] Read the code\n2\. \[ \] Also update the docs/);
  const stored = app.store.messages(run.sessionId).filter((m) => m.role === "system").map((m) => m.content).join("\n");
  assert.equal(stored.includes("checklist"), false, "the list rides with each round, not in the stored conversation");
  const list = app.coding.checklists.get(run.sessionId);
  assert.deepEqual(list.steps.map((s) => s.by), ["assistant", "owner"]);
  assert.equal(app.coding.checklists.roundNote(run.sessionId).content.includes("changed"), false, "the owner's change is announced once");
  app.coding.setMode("checklist", "off");
  assert.equal(app.coding.checklists.roundNote(run.sessionId), null);
  assert.throws(() => app.coding.checklists.saveByOwner({ sessionId: run.sessionId, steps: [] }), /switched off/);
});

test("R17-040: folder rules apply by path, each has a switch, and schedule files become schedules only on request", async (t) => {
  assert.equal(applies(null, []), true);
  assert.equal(applies([], ["src/a.ts"]), false);
  assert.equal(applies(["src/**/*.ts"], ["src/deep/a.ts"]), true);
  assert.equal(applies(["src/**"], ["docs/a.md"]), false);
  assert.equal(globTest("*.md")("docs/readme.md"), true);
  assert.deepEqual(splitHeader("---\npaths:\n  - src/**\n  - \"test/*\"\ndescription: Hi\n---\nBody\n").header, { paths: ["src/**", "test/*"], description: "Hi" });
  const { app, put, on, context } = await fixture(t);
  await put(".agents/rules/api.md", "---\npaths: [src/api/**]\n---\nEvery route needs a test.\n");
  await put(".agents/rules/always.md", "Write plain English.\n");
  await put(".agents/rules/never.md", "---\npaths: []\n---\nNever shown.\n");
  await put(".agents/schedules/tidy.md", "---\nevery: 6h\nkind: task\n---\nTidy the notes folder.\n");
  await put(".agents/schedules/broken.md", "---\nevery: 5s\n---\nToo often.\n");
  on("path-rules");
  const ctx = context();
  assert.match((await app.coding.rules.roundNote(ctx.runId)).content, /always\.md/);
  assert.equal((await app.coding.rules.roundNote(ctx.runId)).content.includes("Every route"), false);
  app.store.event(ctx.runId, "tool.started", { name: "files.read", path: "src/api/users.ts" });
  const note = (await app.coding.rules.roundNote(ctx.runId)).content;
  assert.match(note, /api\.md \(for src\/api\/\*\*\)\nEvery route needs a test\./);
  assert.equal(note.includes("Never shown"), false);
  app.coding.rules.setRule({ name: "api.md", on: false });
  assert.equal((await app.coding.rules.roundNote(ctx.runId)).content.includes("Every route"), false);
  assert.deepEqual((await app.registry.execute("rules.for_path", { path: "src/api/x.ts" }, ctx)).rules.map((r) => r.name), ["always.md"]);
  const input = await app.coding.rules.scheduleInput("tidy.md", new Date("2026-09-17T10:00:00Z"));
  const { permissions, ...rest } = input;
  assert.deepEqual(rest, { prompt: "Tidy the notes folder.", kind: "task", dueAt: "2026-09-17T10:00:00.000Z", intervalMs: 21_600_000 });
  assert.ok(permissions.includes("files.read") && !permissions.includes("files.write"), "a schedule file looks only, unless it narrows further");
  await assert.rejects(app.coding.rules.scheduleInput("broken.md"), /at least a minute/);
  assert.equal(app.store.list("schedules", app.runtime.owner).length, 0, "a schedule file schedules nothing by itself");
});

test("R17-034: the snapshot reads the login shell once, drops anything key-like, and gives commands its PATH", async (t) => {
  assert.match(captureScript("zsh"), /\.zshrc[\s\S]*__BRANCH_functions__[\s\S]*functions\n[\s\S]*alias -L[\s\S]*env -0/);
  assert.match(captureScript("bash"), /\.bashrc[\s\S]*declare -f[\s\S]*alias -p/);
  assert.throws(() => snapshotShell("", {}, "win32"), /macOS and Linux/);
  assert.equal(snapshotShell("", { SHELL: "/opt/homebrew/bin/fish" }, "darwin"), "/bin/zsh");
  assert.equal(snapshotShell("", { SHELL: "/usr/bin/bash" }, "linux"), "/usr/bin/bash");
  assert.throws(() => snapshotShell("/usr/bin/python3", {}, "linux"), /not a shell/);
  const mark = (name) => `\0__BRANCH_${name}__\0`;
  const output = `${mark("functions")}\nmkcd () {\n\tmkdir -p "$1" && cd "$1"\n}\ndeploy () {\n\tcurl -H "Authorization: $API_TOKEN" x\n}\n${mark("aliases")}\nalias ll='ls -la'\nalias gh-login='echo ghp_abcdefghijklmnopqrstuvwxyz0123456789'\n${mark("env")}\n` // not-a-real-secret
    + ["PATH=/opt/homebrew/bin:relative/bin:/usr/bin:/opt/homebrew/bin", "PYENV_ROOT=/Users/o/.pyenv", "AWS_SECRET_ACCESS_KEY=abc", "GITHUB_TOKEN_HOME=/x", "HOME=/Users/o", "JAVA_HOME=/Library/Java"].join("\0")
    + `\0${mark("end")}`;
  const snapshot = parseCapture(output, "/bin/zsh", new Date("2026-09-17T00:00:00Z"));
  assert.deepEqual(snapshot.path, ["/opt/homebrew/bin", "/usr/bin"]);
  assert.deepEqual(snapshot.env, { PYENV_ROOT: "/Users/o/.pyenv", JAVA_HOME: "/Library/Java" });
  assert.match(snapshot.functions, /mkcd/);
  assert.equal(snapshot.functions.includes("deploy"), false);
  assert.equal(snapshot.aliases, "alias ll='ls -la'");
  assert.deepEqual(snapshot.dropped.sort(), ["alias gh-login", "function deploy", "variable GITHUB_TOKEN_HOME"]);

  const { app, on } = await fixture(t);
  const calls = [];
  const runner = async (run) => { calls.push(run); return { exitCode: 0, stdout: output, stderr: "", timedOut: false }; };
  const snapshots = new ShellSnapshots(app.store, app.runtime.owner, { runner, env: { SHELL: "/bin/zsh" }, platform: "darwin", home: "/Users/o" });
  app.coding.setMode("shell-snapshot", "off"); // ships "when needed" (the owner's rule, 2026-09-26); "off" is tested switched off
  await assert.rejects(snapshots.take(), /switched off/);
  on("shell-snapshot");
  await snapshots.take();
  assert.equal(calls.length, 1);
  assert.deepEqual([calls[0].executable, calls[0].args[0], calls[0].args[1], calls[0].cwd], ["/bin/zsh", "-l", "-c", "/Users/o"]);
  assert.deepEqual(calls[0].env, { HOME: "/Users/o", SHELL: "/bin/zsh", TERM: "dumb" });
  const replay = await readFile(snapshots.replayFile(), "utf8");
  assert.match(replay, /export PATH='\/opt\/homebrew\/bin:\/usr\/bin'/);
  assert.equal(replay.includes("ghp_"), false);
  const config = ShellConfigSchema.parse({ executables: { node: { path: process.execPath } } });
  assert.equal(withLoginPath(config, app.store, app.runtime.owner).env.PATH, "/opt/homebrew/bin:/usr/bin");
  const own = ShellConfigSchema.parse({ executables: { node: { path: process.execPath } }, env: { PATH: "/mine" } });
  assert.equal(withLoginPath(own, app.store, app.runtime.owner).env.PATH, "/mine", "a PATH the owner wrote wins");
  app.coding.setMode("shell-snapshot", "off");
  assert.equal(withLoginPath(config, app.store, app.runtime.owner).env.PATH, undefined);
  await assert.rejects(new ShellSnapshots(app.store, app.runtime.owner, { runner: async () => ({ exitCode: null, stdout: "", stderr: "", timedOut: true }), env: {}, platform: "linux", home: "/h" })
    .take().catch((e) => { throw e; }), /switched off/);
});

test("R17-033: after an edit the file is tidied by the owner's formatter and the language server's errors come back", async (t) => {
  assert.deepEqual(editedPaths("files.write", { path: "a.ts" }), ["a.ts"]);
  assert.deepEqual(editedPaths("files.patch", { patch: "--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-a\n+b\n--- /dev/null\n+++ b/y.md\n@@ -0,0 +1 @@\n+hi\n" }), ["x.ts", "y.md"]);
  assert.deepEqual(editedPaths("files.read", { path: "a.ts" }), []);
  const { app, on, context, workspace, root } = await fixture(t);
  const fakeFormatter = join(root, "bin", "fmt");
  await mkdir(join(root, "bin"), { recursive: true });
  await writeFile(fakeFormatter, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const calls = [];
  const runner = async (run) => {
    calls.push(run);
    const file = run.args.at(-1);
    await writeFile(file, (await readFile(file, "utf8")).replace(/  +/g, " "));
    return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
  };
  const servers = { enabled: () => true, diagnostics: async ({ path }) => ({ diagnostics: [
    { path, line: 1, character: 1, severity: "error", message: "Cannot find name 'x'.", source: "ts" },
    { path, line: 2, character: 1, severity: "hint", message: "unused", source: "ts" }] }) };
  const walls = [];
  const wall = { network: "none" };
  const checks = new EditChecks({ store: app.store, owner: app.runtime.owner, files: app.coding["deps"].files, runner, areas: () => app.runtime.protectedAreas, servers,
    trusted: () => true, wall: () => wall, walled: async (run, start, given) => { walls.push(given); return run(start); } });
  on("format-on-edit");
  await assert.rejects(checks.save({ formatters: { mine: { path: join(workspace, "fmt"), extensions: [".ts"] } } }), /no program|inside the workspace/);
  await writeFile(join(workspace, "fmt"), "#!/bin/sh\n", { mode: 0o755 });
  await assert.rejects(checks.save({ formatters: { mine: { path: join(workspace, "fmt"), extensions: [".ts"] } } }), /inside the workspace/);
  await checks.save({ formatters: { prettier: { path: fakeFormatter, args: ["--write", "{file}"], extensions: [".ts"] } } });
  app.registry.afterTool = (name, args, result, ctx) => checks.after(name, args, result, ctx);
  const result = await app.registry.execute("files.write", { path: "src/a.ts", content: "const  a =  1;\n" }, context());
  assert.equal(result.afterEdit.files[0].formatter, "prettier");
  assert.equal(result.afterEdit.files[0].reformatted, true);
  assert.deepEqual(result.afterEdit.files[0].problems, [{ line: 1, severity: "error", message: "Cannot find name 'x'." }]);
  assert.equal(await readFile(join(workspace, "src", "a.ts"), "utf8"), "const a = 1;\n");
  assert.deepEqual(calls[0].args, ["--write", join(workspace, "src", "a.ts")]);
  assert.equal(calls[0].executable, fakeFormatter);
  assert.equal(walls[0], wall, "the formatter was started behind the wall");
  const md = await app.registry.execute("files.write", { path: "notes.md", content: "x  y" }, context());
  assert.equal(md.afterEdit.files[0].formatter, null, "no formatter for that ending");
  const practice = await app.registry.execute("files.write", { path: "src/b.ts", content: "b" }, context({ dryRun: true }));
  assert.equal(practice.afterEdit, undefined, "a practice run is not tidied");
  app.coding.setMode("format-on-edit", "off");
  const plain = await app.registry.execute("files.write", { path: "src/c.ts", content: "c  c" }, context());
  assert.equal(plain.afterEdit, undefined);
});

test("R17-033: Branch's own files are never tidied, and the real hook is wired into the registry", async (t) => {
  const { app, on, context } = await fixture(t);
  assert.equal(typeof app.registry.afterTool, "function");
  assert.equal(typeof app.registry.oversized, "function");
  on("format-on-edit");
  const calls = [];
  const checks = new EditChecks({ store: app.store, owner: app.runtime.owner, files: app.coding["deps"].files,
    runner: async (run) => { calls.push(run); return { exitCode: 0, stdout: "", stderr: "", timedOut: false }; },
    areas: () => ({ ...app.runtime.protectedAreas, noChange: [join(app.runtime.workspace, "guarded")] }), servers: { enabled: () => false },
    trusted: () => true, wall: () => ({ network: "none" }) });
  const check = await checks.check("guarded/x.ts", context());
  assert.match(check.note, /Branch's own files/);
  assert.equal(calls.length, 0);
});

const git = await locateGit();
const needsGit = { skip: git ? false : "Git is not installed on this computer" };

async function repository(app) {
  const runner = new GitRunner();
  const run = async (args, cwd = app.runtime.workspace) => {
    const out = await runner.run({ cwd, args }, AbortSignal.timeout(30_000));
    assert.equal(out.exitCode, 0, `${args.join(" ")}: ${out.stderr}`);
    return out.stdout;
  };
  await run(["init", "--initial-branch=main"]);
  await run(["config", "user.name", "Test Owner"]);
  await run(["config", "user.email", "owner@example.invalid"]);
  await writeFile(join(app.runtime.workspace, "README.md"), "# Falcon\n");
  await mkdir(join(app.runtime.workspace, "src"), { recursive: true });
  await writeFile(join(app.runtime.workspace, "src", "api.ts"), "export const x = 0;\n");
  await run(["add", "."]);
  await run(["commit", "-m", "start"]);
  return run;
}

test("R17-036: a forked conversation works in its own copy, and a helper's copy is removed only when it holds nothing", needsGit, async (t) => {
  const { app, on, context } = await fixture(t);
  const run = await repository(app);
  app.store.message(app.store.createRun(app.runtime.owner, "hi").sessionId, { role: "user", content: "hi" });
  const first = app.store.runs(app.runtime.owner)[0];
  const messageId = app.runtime.store.sqlite.prepare("SELECT source_id FROM messages WHERE session_id=?").get(first.sessionId)?.source_id;
  app.coding.setMode("worktrees", "off"); // ships off (heavy disk); switched off explicitly all the same
  await assert.rejects(app.coding.worktrees.fork({ sessionId: first.sessionId, messageId }, AbortSignal.timeout(30_000)), /switched off/);
  on("worktrees");
  const fork = await app.coding.worktrees.fork({ sessionId: first.sessionId, messageId }, AbortSignal.timeout(30_000));
  assert.match(fork.path, /^\.branch-worktrees\/fork-[a-f0-9]{8}$/);
  assert.ok(existsSync(join(app.runtime.workspace, fork.path, "README.md")));
  const place = await app.coding.placeTask({ id: first.id, sessionId: fork.sessionId }, context(), undefined);
  assert.equal(place.scope, fork.path);
  const inside = await app.coding.inPlace(place.scope, async () => {
    await app.registry.execute("files.write", { path: "made-in-fork.txt", content: "fork" }, context({ workspace: place.workspace }));
    return worktreeScope();
  });
  assert.equal(inside, fork.path);
  assert.ok(existsSync(join(app.runtime.workspace, fork.path, "made-in-fork.txt")));
  assert.equal(existsSync(join(app.runtime.workspace, "made-in-fork.txt")), false, "the main folder is left alone");
  assert.equal(await app.coding.placeTask({ id: first.id, sessionId: first.sessionId }, context(), undefined), null);
  const forkedRun = await app.runtime.run({ prompt: "carry on", sessionId: fork.sessionId });
  assert.ok(app.store.events(forkedRun.id).some((event) => event.kind === "worktree.used" && event.data.path === fork.path),
    "a task in the forked conversation works in its copy");

  const parent = context();
  const helperRun = () => app.store.createRun(app.runtime.owner, "helper").id;
  assert.equal(await app.coding.placeTask({ id: helperRun(), sessionId: "x" }, context(), parent), null, "helpers share the folder unless asked");
  app.coding.worktrees["deps"].store.save("settings", app.runtime.owner, "coding-worktrees", { mode: "on", perHelper: true });
  const empty = await app.coding.placeTask({ id: helperRun(), sessionId: "x" }, context(), parent);
  assert.ok(existsSync(empty.workspace));
  await empty.release();
  assert.equal(existsSync(empty.workspace), false, "an untouched helper copy is removed");
  const busy = await app.coding.placeTask({ id: helperRun(), sessionId: "x" }, context(), parent);
  await writeFile(join(busy.workspace, "work.txt"), "unsaved");
  await busy.release();
  assert.ok(existsSync(busy.workspace), "a helper copy with work in it is kept");
  assert.ok(app.store.events(parent.runId).length >= 0);
  assert.equal(await inWorktree("elsewhere", async () => app.coding.placeTask({ id: helperRun(), sessionId: "x" }, context(), parent)), null,
    "a task already in a copy never makes another");
  await app.coding.worktrees.remove(fork.sessionId, AbortSignal.timeout(30_000)).catch(() => undefined);
  void run;
});

test("R17-043: the project's review checks run as read-only helpers against the changes", needsGit, async (t) => {
  const asked = [];
  const provider = scripted((request) => {
    const prompt = request.messages.filter((m) => m.role === "user").map((m) => m.content).join("\n");
    asked.push({ prompt, tools: (request.tools ?? []).map((tool) => tool.name) });
    if (/Review check "tests"/.test(prompt)) return { content: JSON.stringify({ passed: false, findings: ["src/api.ts:1 has no test"] }), toolCalls: [] };
    return { content: JSON.stringify({ passed: true, findings: [] }), toolCalls: [] };
  });
  const { app, on, put, context } = await fixture(t, provider);
  await repository(app);
  await put(".agents/checks/tests.md", "---\nname: tests\npaths: [src/**]\n---\nEvery changed source file has a test.\n");
  await put(".agents/checks/docs.md", "---\nname: docs\npaths: [docs/**]\n---\nDocs are in plain English.\n");
  await put(".agents/checks/logging.md", "No passwords in logs.\n");
  await put("README.md", "# Falcon\n\nChanged.\n");
  await put("src/api.ts", "export const x = 1;\n");
  app.coding.setMode("review-checks", "off"); // ships "when needed" (the owner's rule, 2026-09-26); "off" is tested switched off
  await assert.rejects(app.coding.checks.run({ only: [] }, context()), /switched off/);
  on("review-checks");
  const outcome = await app.runtime.executeTool("review.checks", {}, { mode: "owner" });
  assert.deepEqual(outcome.changed, ["README.md", "src/api.ts"]);
  const byName = Object.fromEntries(outcome.checks.map((c) => [c.title, c]));
  assert.equal(byName.docs.status, "skipped", "no change under docs/");
  assert.equal(byName.tests.status, "failed", "a change under src/ ran the tests check, which found something");
  assert.deepEqual(byName.tests.findings, ["src/api.ts:1 has no test"]);
  assert.ok(asked.some((call) => /Review check "tests"[\s\S]*export const x = 1/.test(call.prompt)), "the helper was handed the changes");
  assert.equal(byName.logging.status, "passed");
  assert.ok(byName.logging.runId, "the check ran as a helper task of its own");
  assert.ok(asked.every((call) => !call.tools.some((name) => /write|shell|patch|edit/.test(name))), "helpers only read");
  await app.runtime.executeTool("files.read", { path: "README.md" }, { mode: "owner" });
  const runOne = await app.coding.checks.run({ only: ["tests.md"] }, { ...context(), permissions: new Set(["files.read"]) })
    .catch((error) => error);
  assert.match(String(runOne.message ?? runOne), /may not use git.diff/);
});

test("R17-038: the CI lines carry only the name of the key, and the action never pastes an input into a shell line", async () => {
  const github = ciSnippet({ kind: "github", model: "claude-sonnet-4-5", endpoint: "https://api.anthropic.com/v1", keyVariable: "ANTHROPIC_API_KEY", prompt: "Review \"this\"\nnow: yes" });
  assert.equal(github.file, ".github/workflows/branch.yml");
  assert.match(github.text, /prompt: "Review \\"this\\"\\nnow: yes"/);
  assert.match(github.text, /ANTHROPIC_API_KEY: \$\{\{ secrets.ANTHROPIC_API_KEY \}\}/);
  assert.match(github.text, /preset: read-only/);
  const gitlab = ciSnippet({ kind: "gitlab", model: "gpt-5", endpoint: "https://api.openai.com/v1", keyVariable: "OPENAI_KEY", provider: "openai" });
  assert.match(gitlab.text, /api-key-variable: OPENAI_KEY/);
  assert.throws(() => ciSnippet({ kind: "github", model: "m; rm -rf /", endpoint: "https://x.test", keyVariable: "K" }), /model name/);
  assert.throws(() => ciSnippet({ kind: "github", model: "m", endpoint: "https://x.test", keyVariable: "sk-live-123" }), /variable name/);
  const action = await readFile(new URL("../extras/ci/github/action.yml", import.meta.url), "utf8");
  const runBlocks = [...action.matchAll(/run: \|\n((?: {8}.*\n)+)/g)].map((m) => m[1]).join("");
  assert.ok(runBlocks.includes("headless"));
  assert.equal(/\$\{\{/.test(runBlocks), false, "inputs reach the shell only as environment variables");
  assert.match(action, /default: read-only/);
  const component = await readFile(new URL("../extras/ci/gitlab/branch.yml", import.meta.url), "utf8");
  assert.match(component, /^spec:\n  inputs:/m);
  assert.equal(/script:[\s\S]*\$\[\[/.test(component.split("  script:")[1] ?? ""), false, "the script reads variables, not inputs");
});

test("routes: a run key may run the checks and fork, the snapshot is the owner's, and switches stay closed", () => {
  assert.ok(taskRouteFor("POST", "/api/coding/checks/run"));
  assert.ok(taskRouteFor("POST", "/api/coding/worktrees/fork"));
  assert.equal(taskRouteFor("POST", "/api/coding/switch"), null);
  assert.equal(taskRouteFor("POST", "/api/coding/shell/take"), null);
  assert.ok(ownerOnlyRead("/api/coding/shell"));
  assert.equal(ownerOnlyRead("/api/coding/rules"), null);
});

test("the API: switches, settings and refusals in plain words", async (t) => {
  const { app } = await fixture(t);
  const { codingApi } = await import("../dist/coding/api.js");
  const call = (method, path, body) => codingApi({ coding: app.coding, runtime: app.runtime, method, query: new URLSearchParams(), readBody: async () => body }, path);
  // The owner's rule (ships on, 2026-09-26): the parts ship "when needed"; "off" is tested by switching it off.
  assert.equal((await call("GET", "/api/coding")).modes.checklist, "when-needed");
  await call("POST", "/api/coding/switch", { part: "init", mode: "off" });
  await assert.rejects(call("GET", "/api/coding/init"), (error) => error.status === 409 && /switched off/.test(error.message));
  assert.equal((await call("POST", "/api/coding/switch", { part: "init", mode: "when-needed" })).mode, "when-needed");
  assert.match((await call("GET", "/api/coding/init")).prompt, /project.init/);
  await assert.rejects(call("POST", "/api/coding/switch", { part: "nope", mode: "on" }), (error) => error.status === 400);
  await assert.rejects(call("GET", "/api/coding/nowhere"), (error) => error.status === 404);
  assert.equal(codingMode(app.store, app.runtime.owner, "init"), "when-needed");
  saveCodingMode(app.store, app.runtime.owner, "worktrees", "on");
  assert.deepEqual((await call("POST", "/api/coding/worktrees", { perHelper: true })).settings, { perHelper: true });
  assert.equal(codingMode(app.store, app.runtime.owner, "worktrees"), "on", "saving a part's settings keeps its switch");
});
