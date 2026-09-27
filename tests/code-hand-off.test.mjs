import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { ContractBook } from "../dist/self-development-contract.js";
import { HandOff, claudeAllowedCommands, handOffReason, linksOut, programCall, readClaude, readCodex, repoOwnSettings } from "../dist/coding/hand-off.js";
import { addPolicyRule } from "../dist/policy.js";

/**
 * Branch builds Branch: a coding job handed to the owner's own Claude Code or Codex, inside one folder. The program
 * is a stand-in here (it edits files the way the real one would, and prints what the real one prints), so what is
 * proved is Branch's side: which program is started and how it is held, what is read back, and that inside Branch's
 * own source nothing outside the contract survives the job.
 */

const owner = "local";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-hand-off-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"),
    provider: { name: "scripted", async complete() { return { content: "Noted.", toolCalls: [] }; } } });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const git = async ({ cwd, args }) => {
    try { return { status: "completed", stdout: execFileSync("git", args, { cwd, encoding: "utf8" }), stderr: "" }; }
    catch (error) { return { status: "failed", stdout: "", stderr: String(error.stderr ?? error.message) }; }
  };
  const calls = [];
  const handOff = (run) => new HandOff({ store: app.store, owner, workspace: join(root, "workspace"), dataDir: join(root, "data"),
    book: new ContractBook(app.store.sqlite), git, run: async (call, prompt, env, signal, timeoutMs, onLine) => {
      calls.push({ call, prompt, env });
      return run(call, onLine);
    } });
  return { app, root, workspace: join(root, "workspace"), dataDir: join(root, "data"), handOff, calls };
}

async function repository(folder, files = { "README.md": "hello\n", "src/a.ts": "export const a = 1;\n" }) {
  await mkdir(join(folder, "src"), { recursive: true });
  for (const [name, text] of Object.entries(files)) await writeFile(join(folder, name), text);
  const git = (...args) => execFileSync("git", args, { cwd: folder });
  git("init", "-q"); git("config", "core.autocrlf", "false"); git("-c", "user.email=t@example.invalid", "-c", "user.name=t", "add", ".");
  git("-c", "user.email=t@example.invalid", "-c", "user.name=t", "commit", "-qm", "start");
}

const context = (app, extra = {}) => ({ owner, workspace: "", runId: app.store.createRun(owner, "a job for Claude Code").id,
  signal: new AbortController().signal, ...extra });
const claudeLines = (text) => [
  JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Edit" }, { type: "text", text: "Editing." }] } }),
  JSON.stringify({ type: "result", subtype: "success", is_error: false, result: text }),
];

test("Claude Code may edit in the folder and run only the checks and read-only Git; Codex writes only in its folder", () => {
  const claude = programCall("claude-code", "/work/repo");
  assert.equal(claude.cwd, "/work/repo");
  assert.deepEqual(claude.args.slice(claude.args.indexOf("--permission-mode"), claude.args.indexOf("--permission-mode") + 2), ["--permission-mode", "acceptEdits"]);
  assert.ok(!claude.args.includes("bypassPermissions") && !claude.args.some((arg) => /dangerously/.test(arg)));
  // NAS 454af77: the folder's own hooks (.claude/settings*.json) and MCP servers (.mcp.json) are never loaded.
  const sources = claude.args[claude.args.indexOf("--setting-sources") + 1];
  assert.equal(sources, "user", "only the account's own settings, never the folder's (project, local)");
  assert.ok(claude.args.includes("--strict-mcp-config"), "and no MCP server from the folder");
  assert.deepEqual(JSON.parse(claude.args[claude.args.indexOf("--settings") + 1]), { disableAllHooks: true }, "no hook runs at all");
  assert.equal(claude.args[claude.args.indexOf("--disallowedTools") + 1], "Bash", "and Bash is refused, whatever allows it");
  for (const allowed of claudeAllowedCommands) assert.doesNotMatch(allowed, /push|commit|curl|rm |npm install|gh /, `${allowed} does nothing that sends or removes`);
  const codex = programCall("codex", "/work/repo");
  assert.deepEqual(codex.args.slice(codex.args.indexOf("--sandbox"), codex.args.indexOf("--sandbox") + 2), ["--sandbox", "workspace-write"]);
  assert.deepEqual(codex.args.slice(codex.args.indexOf("--cd"), codex.args.indexOf("--cd") + 2), ["--cd", "/work/repo"]);
  assert.ok(!codex.args.some((arg) => /danger|bypass/.test(arg)));
});

test("what each program printed is read back: its last words, its steps, and a plan limit said as one", () => {
  const claude = readClaude(claudeLines("Fixed the typo; the tests pass."));
  assert.deepEqual([claude.summary, claude.steps, claude.failed, claude.limitReached], ["Fixed the typo; the tests pass.", ["Edit"], null, false]);
  const limited = readClaude([JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, result: "Claude usage limit reached" })]);
  assert.equal(limited.limitReached, true);
  const codex = readCodex([
    JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "node --test tests/a.test.mjs" } }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Done." } }),
    "not json at all",
  ]);
  assert.deepEqual([codex.summary, codex.steps, codex.failed], ["Done.", ["node --test tests/a.test.mjs"], null]);
  assert.equal(readCodex([JSON.stringify({ type: "turn.failed", error: { message: "You've hit your usage limit" } })]).limitReached, true);
});

test("a job in a workspace repository is done by the program in that folder, and the answer names what changed", async (t) => {
  const f = await fixture(t);
  await repository(join(f.workspace, "site"));
  const job = context(f.app);
  const result = await f.handOff(async (call, onLine) => {
    await writeFile(join(call.cwd, "src", "a.ts"), "export const a = 2;\n");
    const lines = claudeLines("Changed a to 2.");
    lines.forEach(onLine);
    return { code: 0, lines, stderr: "", timedOut: false, missing: false };
  }).run({ program: "claude-code", folder: "site", task: "Set a to 2.", minutes: 5 }, job);
  assert.equal(result.status, "done");
  assert.equal(result.summary, "Changed a to 2.");
  assert.deepEqual(result.changed, ["src/a.ts"]);
  // The code reads the folder with realpathSync.native, which on Windows also expands a short 8.3 name (RUNNER~1).
  assert.equal(f.calls[0].call.cwd, realpathSync.native(join(f.workspace, "site")), "the folder where it really is");
  assert.equal(f.calls[0].prompt, "Set a to 2.");
  const steps = f.app.store.events(job.runId).filter((event) => event.kind === "code.hand_off.step");
  assert.equal(steps.length, 2, "each line the program printed is shown on the task as it comes");
});

test("the model and how hard it thinks are passed to each program in its own words", () => {
  const claude = programCall("claude-code", "/work/repo", "claude-opus-5-5", "medium");
  assert.deepEqual(claude.args.slice(claude.args.indexOf("--model"), claude.args.indexOf("--model") + 2), ["--model", "claude-opus-5-5"]);
  assert.deepEqual(claude.args.slice(claude.args.indexOf("--effort"), claude.args.indexOf("--effort") + 2), ["--effort", "medium"]);
  const codex = programCall("codex", "/work/repo", "gpt-6-astra", "medium");
  assert.deepEqual(codex.args.slice(codex.args.indexOf("--model"), codex.args.indexOf("--model") + 2), ["--model", "gpt-6-astra"]);
  assert.ok(codex.args.includes('model_reasoning_effort="medium"'));
  assert.equal(codex.args.at(-1), "-", "the job itself still comes in on the program's input");
  assert.ok(!programCall("codex", "/work/repo").args.includes("--model"), "with none chosen, the program's own setting stands");
});

test("an expired sign-in is said as one, so the owner knows to sign in again", async (t) => {
  const f = await fixture(t);
  await repository(join(f.workspace, "site"));
  const expired = await f.handOff(async () => ({ code: 1, stderr: "", timedOut: false, missing: false, lines: [JSON.stringify({
    type: "result", subtype: "success", is_error: true, result: "Failed to authenticate. API Error: 401 OAuth access token has expired." })] }))
    .run({ program: "claude-code", folder: "site", task: "x", minutes: 1 }, context(f.app));
  assert.equal(expired.status, "sign in again");
});

test("a folder outside the workspace, or one that is not a Git repository, is refused before anything starts", async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.workspace, "plain"), { recursive: true });
  const never = f.handOff(async () => { throw new Error("the program was started"); });
  await assert.rejects(never.run({ program: "codex", folder: "../outside", task: "x", minutes: 1 }, context(f.app)), /inside the workspace/);
  await assert.rejects(never.run({ program: "codex", folder: "plain", task: "x", minutes: 1 }, context(f.app)), /not a Git repository/);
  assert.equal(f.calls.length, 0);
});

test("a chosen account's own sign-in folder is the one the program is given; an unknown account is refused", async (t) => {
  const f = await fixture(t);
  await repository(join(f.workspace, "site"));
  f.app.store.save("settings", owner, "accounts", { mode: "on", pools: [{ pool: "cli-claude-code", kind: "cli", accounts: [{ id: "a1b2c3d4", label: "Work", createdAt: new Date().toISOString() }] }] });
  const quiet = f.handOff(async () => ({ code: 0, lines: claudeLines("ok"), stderr: "", timedOut: false, missing: false }));
  await quiet.run({ program: "claude-code", folder: "site", task: "x", account: "a1b2c3d4", minutes: 1 }, context(f.app));
  assert.equal(f.calls[0].env.CLAUDE_CONFIG_DIR, join(f.dataDir, "accounts", "cli-claude-code", "a1b2c3d4"));
  assert.equal(f.calls[0].env.OPENAI_API_KEY, undefined, "nothing else of the owner's environment is passed on");
  await assert.rejects(quiet.run({ program: "claude-code", folder: "site", task: "x", account: "ffffffff", minutes: 1 }, context(f.app)), /no Claude Code account called "ffffffff"/);
});

test("inside Branch's own source, whatever the job changed outside the contract is put back and named", async (t) => {
  const f = await fixture(t);
  const worktree = "branch-agent-source/.branch-worktrees/self-typo";
  await repository(join(f.workspace, worktree));
  new ContractBook(f.app.store.sqlite).create(owner, { taskRunId: "0".repeat(8), sourceSha: "0".repeat(40), worktreePath: worktree,
    terms: { allowedPaths: ["src/**"], permissions: ["code.hand_off"], expectedTests: ["tests/a.test.mjs"],
      definitionOfDone: "a is 2", sideEffects: [], rollbackPlan: "revert the commit" } });
  const result = await f.handOff(async (call) => {
    await writeFile(join(call.cwd, "src", "a.ts"), "export const a = 2;\n");
    await writeFile(join(call.cwd, "README.md"), "changed\n");
    await writeFile(join(call.cwd, "planted.txt"), "new\n");
    return { code: 0, lines: claudeLines("ok"), stderr: "", timedOut: false, missing: false };
  }).run({ program: "claude-code", folder: worktree, task: "Set a to 2.", minutes: 1 }, context(f.app));
  assert.deepEqual(result.changed, ["src/a.ts"]);
  assert.deepEqual(result.undone.sort(), ["README.md", "planted.txt"]);
  assert.equal(await readFile(join(f.workspace, worktree, "README.md"), "utf8"), "hello\n");
  assert.equal(existsSync(join(f.workspace, worktree, "planted.txt")), false);
  assert.equal(await readFile(join(f.workspace, worktree, "src", "a.ts"), "utf8"), "export const a = 2;\n");
});

test("a plan limit, a failure and a stop are each said as what they are", async (t) => {
  const f = await fixture(t);
  await repository(join(f.workspace, "site"));
  const limited = await f.handOff(async () => ({ code: 1, stderr: "", timedOut: false, missing: false,
    lines: [JSON.stringify({ type: "turn.failed", error: { message: "You've hit your usage limit." } })] }))
    .run({ program: "codex", folder: "site", task: "x", minutes: 1 }, context(f.app));
  assert.equal(limited.status, "limit reached");
  const failed = await f.handOff(async () => ({ code: 2, lines: [], stderr: "boom", timedOut: false, missing: false }))
    .run({ program: "codex", folder: "site", task: "x", minutes: 1 }, context(f.app));
  assert.equal(failed.status, "failed");
  assert.equal(failed.summary, "boom");
  const stopping = new AbortController();
  stopping.abort();
  const stopped = await f.handOff(async () => ({ code: null, lines: [], stderr: "", timedOut: false, missing: false }))
    .run({ program: "codex", folder: "site", task: "x", minutes: 1 }, context(f.app, { signal: stopping.signal }));
  assert.equal(stopped.status, "stopped");
});

test("a specialist or a Trunk never reaches the owner's Claude Code or Codex", async (t) => {
  const f = await fixture(t);
  await repository(join(f.workspace, "site"));
  const never = f.handOff(async () => { throw new Error("the program was started"); });
  await assert.rejects(never.run({ program: "claude-code", folder: "site", task: "x", minutes: 1 }, context(f.app, { agent: "trunk:ada" })), /owner's own/);
  assert.equal(f.calls.length, 0);
});

test("somebody else in the household never reaches the owner's Claude Code or Codex either", async (t) => {
  const f = await fixture(t);
  await repository(join(f.workspace, "site"));
  const person = f.app.store.profiles.create({ name: "Sam", pin: "1234" });
  f.app.store.profiles.switch({ profileId: person.id, pin: "1234" });
  const never = f.handOff(async () => { throw new Error("the program was started"); });
  await assert.rejects(never.run({ program: "codex", folder: "site", task: "x", minutes: 1 }, context(f.app)), /Claude Code or Codex/);
  assert.equal(f.calls.length, 0);
});

test("the hand-off is a tool in the code toolbox that reaches outside this computer and names its folder whole", async (t) => {
  const f = await fixture(t);
  assert.equal(f.app.registry.permissionOf("code.hand_off"), "code.handoff");
  assert.equal(f.app.registry.reachOf("code.hand_off"), "outbound");
  assert.equal(f.app.registry.groupOf("code.hand_off"), "code");
  assert.deepEqual(f.app.registry.targetsOf("code.hand_off", { program: "codex", folder: "site", task: "x" }, context(f.app)),
    [{ kind: "write", path: "site", folder: true }]);
});

test("Claude Code runs no commands of its own: nothing walls them in, so Branch runs the checks afterwards (NAS 22aa6e3)", () => {
  assert.deepEqual([...claudeAllowedCommands], []);
  const claude = programCall("claude-code", "/work/repo");
  assert.ok(claude.args.includes("acceptEdits"));
  assert.equal(claude.args.includes("--allowedTools"), false, "no command is allowed by name");
  assert.equal(claude.args.some((arg) => /^Bash\(/.test(arg)), false);
});

test("a link in the workspace that leads out of it is refused, not followed (NAS 22aa6e3)", async (t) => {
  const f = await fixture(t);
  const outside = join(f.root, "outside-repo");
  await mkdir(outside, { recursive: true });
  await repository(outside);
  await mkdir(f.workspace, { recursive: true });
  await symlink(outside, join(f.workspace, "link"));
  const never = f.handOff(async () => { throw new Error("the program was started"); });
  await assert.rejects(never.run({ program: "codex", folder: "link", task: "x", minutes: 1 }, context(f.app)), /leads out of it/);
  assert.equal(f.calls.length, 0);
});

test("handing a job over is asked every time, just this once, even with a standing yes for it", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-hand-off-ask-"));
  let asked = false;
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: { name: "scripted", async complete() {
    if (asked) return { content: "Done.", toolCalls: [] };
    asked = true;
    return { content: "", toolCalls: [{ id: "h1", name: "code.hand_off", arguments: JSON.stringify({ program: "codex", folder: "site", task: "fix it" }) }] };
  } } });
  t.after(async () => { await app.close(); await discardTemp(root); });
  addPolicyRule(app.store, owner, { tool: "code.hand_off", match: "*", decision: "allow", remember: "always" });
  const run = await app.runtime.run({ prompt: "hand it over" });
  const question = app.runtime.approvals.questionFor(run.sessionId);
  assert.ok(question, "asked, although a standing yes names it");
  assert.equal(question.onceOnly, true);
  assert.throws(() => app.runtime.approve(run.sessionId, "allow", "always", question.fingerprint));
  assert.ok(handOffReason.length > 0);
});

/**
 * The after-check runs Git in the folder as the owner. A job could write the folder's own Git settings so that a
 * later `git diff` or `git checkout` would run a program the job chose. So Branch reads the folder's own settings
 * before the job and again after, and if the job changed them it runs no more Git there: nothing is checked or kept.
 * The stand-in "program" here writes those settings the way a real one could, and leaves a marker the planted
 * program would write; the marker staying absent is the proof that no such program ran.
 */

test("a job that plants a Git filter in the folder's own settings gets no program run by the after-check, and the owner is told", async (t) => {
  const f = await fixture(t);
  await repository(join(f.workspace, "site"));
  const marker = join(f.root, "FILTER_RAN");
  const result = await f.handOff(async (call) => {
    const git = (...a) => execFileSync("git", a, { cwd: call.cwd });
    git("config", "filter.x.clean", `sh -c 'echo ran > ${marker}; cat'`);
    git("config", "filter.x.smudge", `sh -c 'echo ran > ${marker}; cat'`);
    git("config", "filter.x.required", "true");
    await writeFile(join(call.cwd, ".gitattributes"), "README.md filter=x\n");
    await writeFile(join(call.cwd, "README.md"), "tampered\n");
    return { code: 0, lines: claudeLines("done"), stderr: "", timedOut: false, missing: false };
  }).run({ program: "claude-code", folder: "site", task: "x", minutes: 1 }, context(f.app));
  assert.equal(existsSync(marker), false, "the after-check ran no Git, so the planted filter never ran");
  assert.equal(result.status, "repository settings changed");
  assert.deepEqual([result.changed, result.undone], [[], []], "nothing is reported as checked or kept");
  assert.match(result.summary, /settings|config/i);
});

test("a job that writes the folder's own Claude Code settings or MCP servers ends the same way (NAS 4b4812a)", async (t) => {
  for (const [file, text] of [[".claude/settings.json", '{"hooks":{"SessionStart":[]}}'], [".mcp.json", '{"mcpServers":{}}'],
    [".codex/config.toml", "[mcp_servers.x]\ncommand = \"sh\"\n"], [".agents/hooks/start.sh", "echo hi\n"]]) {
    const f = await fixture(t);
    await repository(join(f.workspace, "site"));
    const result = await f.handOff(async (call) => {
      await mkdir(dirname(join(call.cwd, file)), { recursive: true });
      await writeFile(join(call.cwd, file), text);
      return { code: 0, lines: claudeLines("done"), stderr: "", timedOut: false, missing: false };
    }).run({ program: "claude-code", folder: "site", task: "x", minutes: 1 }, context(f.app));
    assert.equal(result.status, "repository settings changed", `${file} written by the job`);
    assert.deepEqual([result.changed, result.undone], [[], []]);
  }
});

test("the same holds for a diff textconv program planted in the folder's own settings", async (t) => {
  const f = await fixture(t);
  await repository(join(f.workspace, "site"));
  const marker = join(f.root, "TEXTCONV_RAN");
  const result = await f.handOff(async (call) => {
    const git = (...a) => execFileSync("git", a, { cwd: call.cwd });
    git("config", "diff.x.textconv", `sh -c 'echo ran > ${marker}; cat'`);
    await writeFile(join(call.cwd, ".gitattributes"), "README.md diff=x\n");
    await writeFile(join(call.cwd, "README.md"), "tampered\n");
    return { code: 0, lines: claudeLines("done"), stderr: "", timedOut: false, missing: false };
  }).run({ program: "claude-code", folder: "site", task: "x", minutes: 1 }, context(f.app));
  assert.equal(existsSync(marker), false, "no diff text was produced in the folder, so no textconv program ran");
  assert.equal(result.status, "repository settings changed");
  assert.deepEqual(result.changed, [], "nothing is reported as checked");
});

test("a job that points the folder's config at a file it planted is caught the same way", async (t) => {
  const f = await fixture(t);
  await repository(join(f.workspace, "site"));
  const marker = join(f.root, "INCLUDE_RAN");
  const result = await f.handOff(async (call) => {
    const git = (...a) => execFileSync("git", a, { cwd: call.cwd });
    const planted = join(call.cwd, ".git", "planted.inc");
    git("config", "--file", planted, "filter.x.clean", `sh -c 'echo ran > ${marker}; cat'`);
    git("config", "--file", planted, "filter.x.required", "true");
    git("config", "include.path", "planted.inc");
    await writeFile(join(call.cwd, ".gitattributes"), "README.md filter=x\n");
    await writeFile(join(call.cwd, "README.md"), "tampered\n");
    return { code: 0, lines: claudeLines("done"), stderr: "", timedOut: false, missing: false };
  }).run({ program: "claude-code", folder: "site", task: "x", minutes: 1 }, context(f.app));
  assert.equal(existsSync(marker), false, "the after-check ran no Git, so the pulled-in filter never ran");
  assert.equal(result.status, "repository settings changed");
});

test("an untouched folder whose owner-level Git config has a filter still hands off and is checked as usual", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-hand-off-ok-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"),
    provider: { name: "scripted", async complete() { return { content: "Noted.", toolCalls: [] }; } } });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const globalConfig = join(root, "owner.gitconfig");
  await writeFile(globalConfig, `[filter "lfs"]\n\tclean = cat\n\tsmudge = cat\n[credential]\n\thelper = store\n`);
  const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_SYSTEM: "/dev/null" };
  const calls = [];
  const git = async ({ cwd, args }) => {
    try { return { status: "completed", stdout: execFileSync("git", args, { cwd, encoding: "utf8", env: gitEnv }), stderr: "" }; }
    catch (error) { return { status: "failed", stdout: "", stderr: String(error.stderr ?? error.message) }; }
  };
  const handOff = (run) => new HandOff({ store: app.store, owner, workspace: join(root, "workspace"), dataDir: join(root, "data"),
    book: new ContractBook(app.store.sqlite), git, run: async (call, prompt, env, signal, timeoutMs, onLine) => { calls.push({ call }); return run(call, onLine); } });
  await repository(join(root, "workspace", "site"));
  const result = await handOff(async (call, onLine) => {
    await writeFile(join(call.cwd, "src", "a.ts"), "export const a = 2;\n");
    const lines = claudeLines("changed a"); lines.forEach(onLine);
    return { code: 0, lines, stderr: "", timedOut: false, missing: false };
  }).run({ program: "claude-code", folder: "site", task: "x", minutes: 1 }, context(app));
  assert.equal(result.status, "done", "an owner-level filter does not trip the refusal");
  assert.deepEqual(result.changed, ["src/a.ts"]);
  assert.equal(calls.length, 1, "the program still ran");
});

// Legion's adversarial of R19: a job left its folder through a link it made in it, or by writing next to it, and the
// after-check (which only sees the folder's own repository) said "done".
test("a job that makes a link out of its folder and writes through it ends as left its folder, and the link is removed", async (t) => {
  const f = await fixture(t);
  await repository(join(f.workspace, "site"));
  const outside = join(f.root, "outside");
  await mkdir(outside, { recursive: true });
  const result = await f.handOff(async (call, onLine) => {
    await symlink(outside, join(call.cwd, "escape"), process.platform === "win32" ? "junction" : "dir");
    await writeFile(join(call.cwd, "escape", "pwned.txt"), "x");
    claudeLines("Done.").forEach(onLine);
    return { code: 0, lines: claudeLines("Done."), stderr: "", timedOut: false, missing: false };
  }).run({ program: "claude-code", folder: "site", task: "Anything.", minutes: 5 }, context(f.app));
  assert.equal(result.status, "left its folder");
  assert.match(result.summary, /made a link out of the folder/);
  assert.equal(existsSync(join(f.workspace, "site", "escape")), false, "the link is removed");
  assert.equal(existsSync(join(outside, "pwned.txt")), true, "what it points at is left alone for the owner to look at");
  assert.deepEqual(result.changed, [], "nothing from the run is kept as done");
});

test("a link out of the folder made inside its .git is caught and removed too (Q241)", async (t) => {
  const f = await fixture(t);
  await repository(join(f.workspace, "site"));
  const outside = join(f.root, "outside");
  await mkdir(outside, { recursive: true });
  const result = await f.handOff(async (call, onLine) => {
    await symlink(outside, join(call.cwd, ".git", "refs", "escape"), process.platform === "win32" ? "junction" : "dir");
    claudeLines("Done.").forEach(onLine);
    return { code: 0, lines: claudeLines("Done."), stderr: "", timedOut: false, missing: false };
  }).run({ program: "claude-code", folder: "site", task: "Anything.", minutes: 5 }, context(f.app));
  assert.equal(result.status, "left its folder");
  assert.match(result.summary, /made a link out of the folder \(\.git[\\/]refs[\\/]escape -> /);
  assert.equal(existsSync(join(f.workspace, "site", ".git", "refs", "escape")), false, "the link is removed");
  assert.ok(existsSync(outside), "what it points at is left alone");
});

test("object stores, a submodule's too, are looked at one level deep; the rest of .git, submodules included, in full (Q243)", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-links-in-git-"));
  t.after(() => discardTemp(root));
  const folder = join(root, "site"), outside = join(root, "outside");
  const kind = process.platform === "win32" ? "junction" : "dir";
  for (const dir of [outside, join(folder, ".git", "objects", "ab"), join(folder, ".git", "modules", "sub", "objects", "cd"), join(folder, ".git", "modules", "sub", "refs")])
    await mkdir(dir, { recursive: true });
  await symlink(outside, join(folder, ".git", "objects", "ab", "deep"), kind);
  await symlink(outside, join(folder, ".git", "modules", "sub", "objects", "cd", "deep"), kind);
  await symlink(outside, join(folder, ".git", "modules", "sub", "objects", "top"), kind);
  await symlink(outside, join(folder, ".git", "modules", "sub", "refs", "escape"), kind);
  // Mac mini's re-check: .github is working tree, not .git, so a store-shaped path there is walked in full.
  await mkdir(join(folder, ".github", "modules", "x", "objects", "deep"), { recursive: true });
  await symlink(outside, join(folder, ".github", "modules", "x", "objects", "deep", "escape"), kind);
  const found = [...linksOut(folder).links].map((link) => link.split(" -> ")[0].replaceAll("\\", "/")).sort();
  assert.deepEqual(found, [".git/modules/sub/objects/top", ".git/modules/sub/refs/escape", ".github/modules/x/objects/deep/escape"]);
});

test("a job that writes next to its folder ends as left its folder, naming what it wrote", async (t) => {
  const f = await fixture(t);
  await repository(join(f.workspace, "site"));
  const result = await f.handOff(async (call, onLine) => {
    await writeFile(join(call.cwd, "..", "escape.txt"), "x");
    claudeLines("Done.").forEach(onLine);
    return { code: 0, lines: claudeLines("Done."), stderr: "", timedOut: false, missing: false };
  }).run({ program: "claude-code", folder: "site", task: "Anything.", minutes: 5 }, context(f.app));
  assert.equal(result.status, "left its folder");
  assert.match(result.summary, /added escape\.txt next to the folder/);
});

test("a link that already led out before the job, and neighbours it did not touch, are not the job's", async (t) => {
  const f = await fixture(t);
  await repository(join(f.workspace, "site"));
  const outside = join(f.root, "outside");
  await mkdir(outside, { recursive: true });
  await symlink(outside, join(f.workspace, "site", "shared"), process.platform === "win32" ? "junction" : "dir");
  await writeFile(join(f.workspace, "notes.txt"), "the owner's own file next to the folder");
  const result = await f.handOff(async (call, onLine) => {
    await writeFile(join(call.cwd, "src", "a.ts"), "export const a = 2;\n");
    claudeLines("Changed a to 2.").forEach(onLine);
    return { code: 0, lines: claudeLines("Changed a to 2."), stderr: "", timedOut: false, missing: false };
  }).run({ program: "claude-code", folder: "site", task: "Set a to 2.", minutes: 5 }, context(f.app));
  assert.equal(result.status, "done");
  assert.ok(existsSync(join(f.workspace, "site", "shared")), "the owner's own link stays");
});

// NAS 448815a: a folder's settings file can be a link to /dev/zero or a huge file; the fingerprint never reads through it.
test("a settings file that is a link is noted by where it points, never read, and a change of target still counts", { skip: process.platform === "win32" }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-handoff-links-"));
  t.after(() => discardTemp(root));
  await symlink("/dev/zero", join(root, ".mcp.json"));
  const before = repoOwnSettings(root);
  assert.match(before, /link:\/dev\/zero/, "the link is noted, and reading it would never have ended");
  assert.equal(repoOwnSettings(root), before, "and it is the same each time");
  await rm(join(root, ".mcp.json"));
  await symlink("/dev/urandom", join(root, ".mcp.json"));
  assert.notEqual(repoOwnSettings(root), before, "pointing it elsewhere is a change");
});

test("past its bound the look at .agents never matches itself, so a change beyond it is not hidden", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-handoff-many-"));
  t.after(() => discardTemp(root));
  await mkdir(join(root, ".agents"), { recursive: true });
  for (let i = 0; i < 501; i++) await writeFile(join(root, ".agents", `f${String(i).padStart(3, "0")}`), "x");
  assert.notEqual(repoOwnSettings(root), repoOwnSettings(root), "an incomplete look counts as a change");
});
