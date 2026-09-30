/**
 * mac7/r17-d integration review: the holes found in the adversarial pass, each pinned by a test.
 * Fake programs and temporary folders only; Git is the owner's own, used only in temporary folders.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { EditChecks, formatterWall, unwalledNote, untrustedNote } from "../dist/coding/format-on-edit.js";
import { parseCapture } from "../dist/coding/shell-snapshot.js";
import { expandImports, importReader } from "../dist/coding/imports.js";
import { LargeOutputs, maxKeptCharacters } from "../dist/coding/large-output.js";
import { ciSnippet } from "../dist/coding/ci.js";
import { saveWallSettings } from "../dist/sandbox.js";
import { locateGit, GitRunner } from "../dist/integrations/git-run.js";

const scripted = () => ({ name: "scripted", complete: async () => ({ content: "Done.", toolCalls: [] }) });

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-coding-holes-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: scripted() });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const workspace = app.runtime.workspace;
  const put = async (name, body) => { await mkdir(join(workspace, name, ".."), { recursive: true }); await writeFile(join(workspace, name), body); };
  const context = (extra = {}) => ({ ...app.runtime.context({ runId: app.store.createRun(app.runtime.owner, "test").id }), ...extra });
  return { app, root, workspace, put, context };
}

async function fakeFormatter(root) {
  const path = join(root, "bin", "fmt");
  await mkdir(join(root, "bin"), { recursive: true });
  await writeFile(path, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  return path;
}

test("hole: a formatter never starts without the wall, nor for an untrusted folder", async (t) => {
  const { app, root, put, context } = await fixture(t);
  const program = await fakeFormatter(root);
  await put("src/a.ts", "const  a = 1;\n");
  const calls = [];
  const deps = (over) => ({ store: app.store, owner: app.runtime.owner, files: app.coding["deps"].files,
    runner: async (run) => { calls.push(run); return { exitCode: 0, stdout: "", stderr: "", timedOut: false }; },
    areas: () => app.runtime.protectedAreas, servers: { enabled: () => false }, ...over });
  app.coding.setMode("format-on-edit", "on");
  await app.coding.edits.save({ formatters: { fmt: { path: program, extensions: [".ts"] } } });

  const unwalled = new EditChecks(deps({ trusted: () => true, wall: () => undefined }));
  assert.equal((await unwalled.check("src/a.ts", context())).note, unwalledNote);
  const untrusted = new EditChecks(deps({ trusted: () => false, wall: () => ({ network: "none" }) }));
  assert.equal((await untrusted.check("src/a.ts", context())).note, untrustedNote);
  assert.equal(calls.length, 0, "nothing was started");

  // The app's own checks, with the wall switched off (the default): refused before anything starts.
  assert.equal((await app.coding.edits.check("src/a.ts", context())).note, unwalledNote);
  // An edit's own context never carries a wall, so the formatter's wall is worked out as a command's.
  const wallOf = formatterWall(app.runtime);
  assert.equal(wallOf(context(), program), undefined, "the wall is off, so there is none");
  saveWallSettings(app.store, app.runtime.owner, { mode: "on" });
  const wall = wallOf(context(), program);
  if (process.platform === "win32") assert.equal(wall, undefined, "Windows has no wall, so no formatter runs there");
  else assert.equal(wall?.network, "none", "a formatter gets no internet");
});

test("hole: behind the real wall the formatter is wrapped, not started bare", { skip: process.platform !== "darwin" }, async (t) => {
  const { app, root, put, context } = await fixture(t);
  const program = await fakeFormatter(root);
  await put("src/a.ts", "const a = 1;\n");
  saveWallSettings(app.store, app.runtime.owner, { mode: "on" });
  app.coding.setMode("format-on-edit", "on");
  const calls = [];
  const checks = new EditChecks({ store: app.store, owner: app.runtime.owner, files: app.coding["deps"].files,
    runner: async (run) => { calls.push(run); return { exitCode: 0, stdout: "", stderr: "", timedOut: false }; },
    areas: () => app.runtime.protectedAreas, servers: { enabled: () => false }, trusted: () => true, wall: formatterWall(app.runtime) });
  await checks.save({ formatters: { fmt: { path: program, extensions: [".ts"] } } });
  const check = await checks.check("src/a.ts", context());
  assert.equal(check.note, undefined);
  assert.equal(calls.length, 1);
  assert.notEqual(calls[0].executable, program, "the program is started through the wall");
  assert.ok(calls[0].args.includes(program));
});

test("hole: the shell snapshot drops key-like assignments and PATH folders a task could plant in", () => {
  const mark = (name) => `\0__BRANCH_${name}__\0`;
  const output = `${mark("functions")}\ndbup () {\n\texport DB_PASSWORD=correct-horse\n\tpsql\n}\nmkcd () {\n\tmkdir -p "$1"\n}\n`
    + `${mark("aliases")}\nalias pub='NPM_TOKEN=abc123 npm publish'\nalias ll='ls -la'\n${mark("env")}\n`
    + ["PATH=/opt/homebrew/bin:/work/project/node_modules/.bin:/work/project:/usr/../tmp/bin:/usr/bin"].join("\0") + `\0${mark("end")}`;
  const snapshot = parseCapture(output, "/bin/zsh", new Date("2026-09-17T00:00:00Z"), ["/work/project"]);
  assert.deepEqual(snapshot.path, ["/opt/homebrew/bin", "/usr/bin"]);
  assert.equal(snapshot.functions.includes("correct-horse"), false);
  assert.match(snapshot.functions, /mkcd/);
  assert.equal(snapshot.aliases, "alias ll='ls -la'");
  assert.deepEqual(snapshot.dropped.sort(), ["alias pub", "function dbup"]);
});

test("hole: @imports never bring in what .branchignore hides", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-imports-"));
  t.after(() => discardTemp(root));
  await mkdir(join(root, "private"), { recursive: true });
  await writeFile(join(root, ".branchignore"), "private/\nhidden.md\n");
  await writeFile(join(root, "private", "plan.md"), "SECRET PLAN");
  await writeFile(join(root, "hidden.md"), "HIDDEN NOTE");
  await writeFile(join(root, "open.md"), "OPEN NOTE");
  const text = expandImports("See @private/plan.md and @hidden.md and @open.md", root, importReader(root));
  assert.equal(text.includes("SECRET PLAN"), false);
  assert.equal(text.includes("HIDDEN NOTE"), false);
  assert.match(text, /OPEN NOTE/);
});

test("hole: a schedule file may only look, and cannot widen what its schedule may do", async (t) => {
  const { app, put } = await fixture(t);
  app.coding.setMode("path-rules", "on");
  await put(".agents/schedules/wide.md", "---\nevery: 1h\npermissions: [files.read, shell.execute]\n---\nClean up.\n");
  await put(".agents/schedules/narrow.md", "---\nevery: 1h\npermissions: [files.read]\n---\nLook around.\n");
  await assert.rejects(app.coding.rules.scheduleInput("wide.md"), /shell\.execute.*may only look/);
  assert.deepEqual((await app.coding.rules.scheduleInput("narrow.md")).permissions, ["files.read"]);
  const { codingApi } = await import("../dist/coding/api.js");
  const call = (name) => codingApi({ coding: app.coding, runtime: app.runtime, method: "POST", query: new URLSearchParams(), readBody: async () => ({ name }) }, "/api/coding/rules/schedule");
  await assert.rejects(call("wide.md"), /may only look/);
  assert.equal(app.store.list("schedules", app.runtime.owner).length, 0);
});

test("hole: a very long answer is kept only up to its cap", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-output-"));
  t.after(() => discardTemp(root));
  const store = { folder: root, get: (_k, _o, key) => (key === "coding-large-output" ? { data: { mode: "on" } } : undefined) };
  const outputs = new LargeOutputs(store, "owner", (text) => text);
  const kept = outputs.keep("test.huge", "y".repeat(maxKeptCharacters + 5), { owner: "owner" });
  assert.equal(kept.characters, maxKeptCharacters);
  assert.match(kept.note, /Only the first/);
});

test("hole: the CI lines and the action never leave the job's token in Git settings", async () => {
  const github = ciSnippet({ kind: "github", model: "m", endpoint: "https://x.test", keyVariable: "K" });
  assert.match(github.text, /actions\/checkout@v4\n {8}with:\n {10}persist-credentials: false/);
  const action = await readFile(new URL("../extras/ci/github/action.yml", import.meta.url), "utf8");
  for (const block of action.split("- uses: actions/checkout").slice(1)) assert.match(block.split("- ")[0], /persist-credentials: false/);
  assert.equal(/pull_request_target/.test(github.text + action), false);
});

const git = await locateGit();
test("hole: removing a fork keeps a copy that holds unsaved work", { skip: git ? false : "Git is not installed" }, async (t) => {
  const { app, workspace } = await fixture(t);
  const runner = new GitRunner();
  const run = async (args) => { const out = await runner.run({ cwd: workspace, args }, AbortSignal.timeout(30_000)); assert.equal(out.exitCode, 0, out.stderr); };
  await run(["init", "--initial-branch=main"]);
  await run(["config", "user.name", "Test Owner"]);
  await run(["config", "user.email", "owner@example.invalid"]);
  await writeFile(join(workspace, "README.md"), "# Falcon\n");
  await run(["add", "."]);
  await run(["commit", "-m", "start"]);
  const first = app.store.createRun(app.runtime.owner, "hi");
  app.store.message(first.sessionId, { role: "user", content: "hi" });
  const messageId = app.runtime.store.sqlite.prepare("SELECT source_id FROM messages WHERE session_id=?").get(first.sessionId)?.source_id;
  app.coding.setMode("worktrees", "on");
  app.store.save("settings", app.runtime.owner, "coding-worktrees", { mode: "on", forks: true }); // forks ship off (2026-09-30)
  const fork = await app.coding.worktrees.fork({ sessionId: first.sessionId, messageId }, AbortSignal.timeout(30_000));
  await writeFile(join(workspace, fork.path, "unsaved.txt"), "work");
  await assert.rejects(app.coding.worktrees.remove(fork.sessionId, AbortSignal.timeout(30_000)), /not saved yet/);
  assert.ok(existsSync(join(workspace, fork.path, "unsaved.txt")), "the work is still there");
  assert.equal(app.coding.worktrees.forks().length, 1);
  await discardTemp(join(workspace, fork.path, "unsaved.txt"));
  await app.coding.worktrees.remove(fork.sessionId, AbortSignal.timeout(30_000));
  assert.equal(existsSync(join(workspace, fork.path)), false, "a clean copy is removed");
});
