/**
 * mac5/manual-actions: a tool run outside a conversation — pressed by hand in the app window, a
 * saved workflow's step, "Try a tool" — goes through the same guards a task's call does: Branch's
 * own files, Lockdown, folder trust, the rules and the OS sandbox wall. Temporary folders only.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { discardTemp } from "./temp-dir.mjs";
import {
  ApprovalRequiredError, PolicyRefusedError, createBranch, decideFolder, saveFolderTrustSettings,
  savePolicy, saveWallSettings, setLockdown,
} from "../dist/index.js";
import { tryTool } from "../dist/playground.js";
import { startServer } from "../dist/server.js";
import { manualVerdict } from "../dist/tool-gate.js";
import { argumentFingerprint } from "../dist/runtime.js";

const owner = { mode: "owner" };

async function app(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-manual-gate-"));
  const provider = { name: "scripted", async complete() { return { content: "done", toolCalls: [] }; } };
  const branch = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  t.after(async () => { await branch.close(); await discardTemp(root); });
  // A stand-in for the command tool, so nothing real is ever started; it notes what it was handed.
  const ran = [];
  branch.registry.unregister("shell.execute");
  branch.registry.register({
    name: "shell.execute", permission: "shell.execute", description: "stand-in",
    parameters: z.object({ executable: z.string(), args: z.array(z.string()).default([]) }),
    execute: async (args, context) => { ran.push({ args, context }); return { exitCode: 0 }; },
  });
  return { branch, root, ran };
}
const denials = (branch) => branch.store.runs("local")
  .flatMap((run) => branch.store.events(run.id)).filter((event) => event.kind === "policy.denied");

test("a manual action may not write Branch's data folder, whatever the rules say", async (t) => {
  const { branch, root } = await app(t);
  savePolicy(branch.store, "local", { preset: "custom", rules: [{ tool: "*", decision: "allow", remember: "always" }] });
  await assert.rejects(branch.runtime.executeTool("files.write", { path: "../data/gateway.json", content: "{}" }, owner),
    (error) => error instanceof PolicyRefusedError && /never lets a task/.test(error.message));
  await assert.rejects(access(join(root, "data", "gateway.json")), "nothing was written");
  assert.ok(denials(branch).length >= 1, "the refusal is on the record");
});

test("a manual action may not rm -rf Branch's data folder", async (t) => {
  const { branch, root, ran } = await app(t);
  await assert.rejects(branch.runtime.executeTool("shell.execute", { executable: "rm", args: ["-rf", join(root, "data")] }, owner),
    /never lets a task/);
  assert.equal(ran.length, 0, "the command never started");
});

test("under Lockdown a changing manual action is refused, and looking still works", async (t) => {
  const { branch, root } = await app(t);
  setLockdown(branch.store, "local", { on: true });
  await assert.rejects(branch.runtime.executeTool("files.write", { path: "note.txt", content: "x" }, owner), /Lockdown is on/);
  await assert.rejects(access(join(root, "workspace", "note.txt")));
  setLockdown(branch.store, "local", { on: false });
  await branch.runtime.executeTool("files.write", { path: "note.txt", content: "x" }, owner);
  setLockdown(branch.store, "local", { on: true });
  const read = await branch.runtime.executeTool("files.read", { path: "note.txt" }, owner);
  assert.match(JSON.stringify(read), /x/, "a look is not a change");
});

test("a deny rule refuses a manual action", async (t) => {
  const { branch, root } = await app(t);
  savePolicy(branch.store, "local", { preset: "custom", rules: [{ tool: "files.write", decision: "deny" }] });
  await assert.rejects(branch.runtime.executeTool("files.write", { path: "note.txt", content: "x" }, owner),
    (error) => error instanceof PolicyRefusedError);
  await assert.rejects(access(join(root, "workspace", "note.txt")));
});

test("an untrusted folder refuses a changing manual action", async (t) => {
  const { branch, root } = await app(t);
  saveFolderTrustSettings(branch.store, "local", { mode: "on" });
  decideFolder(branch.store, "local", join(root, "workspace"), { folder: "", decision: "distrust" });
  await assert.rejects(branch.runtime.executeTool("files.write", { path: "note.txt", content: "x" }, owner), /not trusted/);
});

test("the owner's own 'ask first' rule does not stop what the owner pressed", async (t) => {
  const { branch, root } = await app(t);
  savePolicy(branch.store, "local", { preset: "ask-before-changes" });
  await branch.runtime.executeTool("files.write", { path: "note.txt", content: "mine" }, owner);
  assert.equal(await readFile(join(root, "workspace", "note.txt"), "utf8"), "mine");
});

test("an ordinary allowed manual action still works", async (t) => {
  const { branch, root } = await app(t);
  await branch.runtime.executeTool("files.write", { path: "ok.txt", content: "fine" }, owner);
  assert.equal(await readFile(join(root, "workspace", "ok.txt"), "utf8"), "fine");
  assert.equal(denials(branch).length, 0);
});

test("a manual command runs behind the owner's wall, and a rule only tightens it", { skip: process.platform === "win32" }, async (t) => {
  const { branch, ran } = await app(t);
  saveWallSettings(branch.store, "local", { mode: "on", network: "open" });
  savePolicy(branch.store, "local", { preset: "custom", rules: [{ tool: "shell.execute", decision: "allow", sandbox: "no-internet" }] });
  await branch.runtime.executeTool("shell.execute", { executable: "echo", args: ["hi"] }, owner);
  const wall = ran[0].context.osSandbox;
  assert.ok(wall, "the wall came with the call");
  assert.equal(wall.network, "none", "the rule's 'no internet' tightened the owner's open network");
  assert.equal(ran[0].context.sandbox, "no-internet");
});

test("run by itself, a tool step is held to the full rules and the workflow's own yes", async (t) => {
  const { branch, root } = await app(t);
  savePolicy(branch.store, "local", { preset: "ask-before-changes" });
  await assert.rejects(branch.runtime.executeTool("files.write", { path: "w.txt", content: "a" }, { mode: "policy", approvalKey: "workflow:x" }),
    (error) => error instanceof ApprovalRequiredError);
  await assert.rejects(access(join(root, "workspace", "w.txt")));
  const args = { path: "w.txt", content: "a" };
  const { target, label } = branch.runtime.checkPolicy("files.write", args, branch.runtime.context({ approvalKey: "workflow:x" }));
  branch.runtime.grantApproval("workflow:x", { tool: "files.write", target, label, source: "owner",
    fingerprint: argumentFingerprint("files.write", JSON.stringify(args)) });
  await branch.runtime.executeTool("files.write", { path: "w.txt", content: "a" }, { mode: "policy", approvalKey: "workflow:x" });
  assert.equal(await readFile(join(root, "workspace", "w.txt"), "utf8"), "a");
});

test("a saved workflow's tool step waits for a yes, then runs once it is given", async (t) => {
  const { branch, root } = await app(t);
  savePolicy(branch.store, "local", { preset: "ask-before-changes" });
  const made = branch.workflows.create("local", {
    name: "Write it", steps: [{ name: "Write", kind: "tool", tool: "files.write", args: { path: "flow.txt", content: "z" } }],
  });
  const waiting = await branch.workflows.run("local", made.id);
  assert.equal(waiting.status, "waiting_approval");
  await assert.rejects(access(join(root, "workspace", "flow.txt")));
  const done = await branch.workflows.resume("local", made.id);
  assert.equal(done.status, "completed", done.error ?? "");
  assert.equal(await readFile(join(root, "workspace", "flow.txt"), "utf8"), "z");
});

test("a scheduled workflow step under Lockdown never runs", async (t) => {
  const { branch, root } = await app(t);
  setLockdown(branch.store, "local", { on: true });
  const made = branch.workflows.create("local", {
    name: "Write it", steps: [{ name: "Write", kind: "tool", tool: "files.write", args: { path: "locked.txt", content: "z" } }],
  });
  const waiting = await branch.workflows.run("local", made.id, "schedule");
  assert.notEqual(waiting.status, "completed");
  await assert.rejects(access(join(root, "workspace", "locked.txt")));
});

test("Try a tool keeps its question but obeys Branch's own files and Lockdown", async (t) => {
  const { branch, root } = await app(t);
  const gate = (tool, args, context) => manualVerdict(branch.runtime, tool, args, context, argumentFingerprint(tool, JSON.stringify(args)));
  const attempt = (input) => tryTool(branch.registry, branch.store, "local", branch.runtime.context({}),
    { arguments: {}, confirm: false, ...input }, () => null, gate);
  const guarded = await attempt({ name: "files.write", arguments: { path: "../data/gateway.json", content: "{}" }, confirm: true });
  assert.equal(guarded.status, "refused");
  assert.match(guarded.reason, /never lets a task/);
  savePolicy(branch.store, "local", { preset: "ask-before-changes" });
  assert.equal((await attempt({ name: "files.write", arguments: { path: "t.txt", content: "q" } })).status, "asked");
  setLockdown(branch.store, "local", { on: true });
  const locked = await attempt({ name: "files.write", arguments: { path: "t.txt", content: "q" }, confirm: true });
  assert.equal(locked.status, "refused");
  await assert.rejects(access(join(root, "workspace", "t.txt")));
});

test("left without a mode, a tool run is held to the full rules", async (t) => {
  const { branch, root } = await app(t);
  savePolicy(branch.store, "local", { preset: "ask-before-changes" });
  await assert.rejects(branch.runtime.executeTool("files.write", { path: "d.txt", content: "a" }),
    (error) => error instanceof ApprovalRequiredError);
  await assert.rejects(access(join(root, "workspace", "d.txt")));
});

test("over HTTP: the app's key runs a hand-pressed action, a short-lived key cannot skip the question", async (t) => {
  const { branch, root } = await app(t);
  const server = await startServer(branch, { dataDir: join(root, "data"), port: 0 });
  t.after(() => server.close());
  const post = (token, body) => fetch(`${server.url}/api/action`, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body),
  });
  savePolicy(branch.store, "local", { preset: "ask-before-changes" });
  const mine = await post(server.token, { tool: "files.write", args: { path: "http.txt", content: "owner" } });
  assert.equal(mine.status, 200, JSON.stringify(await mine.clone().json()));
  const key = branch.sessionTokens.create("local", { name: "script", scope: "run", minutes: 5 }).token;
  const scripted = await post(key, { tool: "files.write", args: { path: "script.txt", content: "no" } });
  assert.notEqual(scripted.status, 200);
  assert.match(JSON.stringify(await scripted.json()), /short-lived key cannot say yes/);
  await assert.rejects(access(join(root, "workspace", "script.txt")));
  const guarded = await post(server.token, { tool: "files.write", args: { path: "../data/gateway.json", content: "{}" } });
  assert.notEqual(guarded.status, 200);
  assert.match(JSON.stringify(await guarded.json()), /never lets a task/);
});

test("a profile whose role covers the kind still meets the workflow tool's own owner check", async (t) => {
  const { branch } = await app(t);
  const person = branch.store.profiles.create({ name: "Kim", pin: "1357" });
  branch.runtime.roles.save(person.id, { role: "owner" });
  branch.store.profiles.switch({ profileId: person.id, pin: "1357" });
  await assert.rejects(branch.runtime.executeTool("workflows.list", {}, owner), /belongs to the owner/);
});

/* Integration review: the pull-request hook asks the gate before it touches Git, so a refusal or an
   unanswerable question never leaves a branch pushed with no pull request behind it. */
async function hookDeps(branch, root) {
  const { gateRefusal } = await import("../dist/tool-gate.js");
  const { savePullRequestHookSettings } = await import("../dist/pr-hook.js");
  savePullRequestHookSettings(branch.store, "local", { mode: "on" });
  if (!branch.registry.names().includes("github.open_pull_request"))
    branch.registry.register({ name: "github.open_pull_request", permission: "github.manage", description: "stand-in",
      parameters: z.object({}).passthrough(), execute: async (args) => args });
  const git = [], opened = [];
  const answers = { "remote get-url": "git@github.com:acme/widgets.git", "symbolic-ref": "refs/remotes/origin/main", "status": " M a.txt\n" };
  return {
    git, opened,
    value: {
      store: branch.store, owner: "local", files: branch.files, registry: branch.registry,
      policy: new (await import("../dist/index.js")).NetworkPolicy({ allowPrivateAddresses: true }),
      git: async (options) => {
        git.push(options.args.join(" "));
        const key = Object.keys(answers).find((prefix) => options.args.join(" ").startsWith(prefix));
        return { status: "completed", stdout: key ? answers[key] : "", stderr: "", exitCode: 0, command: "git" };
      },
      runTool: async (name, args, runId) => { opened.push({ name, args, runId }); return branch.runtime.executeTool(name, args, { mode: runId ? "owner" : "policy" }); },
      preflight: (name, args, runId) => gateRefusal(branch.runtime, name, args,
        branch.runtime.context(runId ? { runId } : {}), argumentFingerprint(name, JSON.stringify(args)), runId ? "owner" : "policy"),
    },
  };
}

test("the hook after a task, under 'ask first', pushes nothing and says why", async (t) => {
  const { branch, root } = await app(t);
  const { pullRequestFromChanges } = await import("../dist/pr-hook.js");
  savePolicy(branch.store, "local", { preset: "ask-before-changes" });
  const d = await hookDeps(branch, root);
  await assert.rejects(pullRequestFromChanges(d.value, { name: "task-1", title: "t", summary: "s", paths: ["a.txt"], signal: AbortSignal.timeout(10000) }),
    /ask first/);
  assert.deepEqual(d.git.filter((line) => /^(switch|push|--literal-pathspecs)/.test(line)), [], "no branch was made or pushed");
  assert.equal(d.opened.length, 0);
});

test("a task's own pull request under Lockdown is refused before anything is pushed", async (t) => {
  const { branch, root } = await app(t);
  const { pullRequestFromChanges } = await import("../dist/pr-hook.js");
  const d = await hookDeps(branch, root);
  setLockdown(branch.store, "local", { on: true });
  const run = branch.store.createRun("local", "send it");
  await assert.rejects(pullRequestFromChanges(d.value, { name: "task-2", title: "t", summary: "s", paths: ["a.txt"], signal: AbortSignal.timeout(10000), runId: run.id }),
    /Lockdown is on/);
  assert.deepEqual(d.git.filter((line) => /^(switch|push|--literal-pathspecs)/.test(line)), []);
});

test("the hook with GitHub allowed still opens the pull request", async (t) => {
  const { branch, root } = await app(t);
  const { pullRequestFromChanges } = await import("../dist/pr-hook.js");
  const d = await hookDeps(branch, root);
  const opened = await pullRequestFromChanges(d.value, { name: "task-3", title: "t", summary: "s", paths: ["a.txt"], signal: AbortSignal.timeout(10000) });
  assert.equal(opened.pullRequest.head, "branch/task-3");
  assert.equal(d.git.filter((line) => line.startsWith("push")).length, 1);
});

test("the owner's own press of an address carrying a key is not let past the leak guard", async (t) => {
  const { branch } = await app(t);
  const fetched = [];
  branch.registry.register({ name: "probe.fetch", permission: "web.read", description: "stand-in",
    parameters: z.object({ url: z.string() }), execute: async (args) => { fetched.push(args.url); return { ok: true }; } });
  const leaky = { url: "https://example.com/data?api_key=sk-live-0123456789abcdefghijklmnop" }; // not-a-real-secret
  await assert.rejects(branch.runtime.executeTool("probe.fetch", leaky, owner), /carries a key or password/);
  assert.deepEqual(fetched, [], "nothing was fetched");
  await branch.runtime.executeTool("probe.fetch", { url: "https://example.com/data" }, owner);
  assert.equal(fetched.length, 1, "an ordinary address still works");
});

test("a short-lived key's refusal from the one gate names the key", async (t) => {
  const { branch } = await app(t);
  const { underShortLivedKey } = await import("../dist/key-context.js");
  savePolicy(branch.store, "local", { preset: "custom", rules: [{ tool: "files.write", decision: "deny" }] });
  await assert.rejects(underShortLivedKey(() => branch.runtime.executeTool("files.write", { path: "k.txt", content: "x" }, owner)),
    /short-lived key/);
});
