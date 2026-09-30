/**
 * SELF-304 inside Branch's own source: while it is checked out, every command is held to the self-development
 * worktree. A program left running (process.start: a long build, a test run, a watcher) used to be refused then,
 * so the lead could not leave `npm run build` going and be woken when it ended. Now the shell walls it exactly as a
 * held shell.execute (inside WSL on Windows, behind the Linux wall elsewhere), with its writes held to the folder,
 * and the wake-ups work as they do anywhere else.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createBranch, savePolicy } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { BackgroundProcesses } from "../dist/processes.js";
import { ContractBook } from "../dist/self-development-contract.js";
import { wslProbe, wslReadiness } from "../dist/integrations/wsl-held.js";
import { wallReport } from "../dist/sandbox-backends.js";
import { startEngine } from "./fixtures/selfdev-harness.mjs";
import { discardTemp } from "./temp-dir.mjs";

const owner = "local";

/** Waits until the program has ended, reading it as the tool does. */
async function ended(processes, id, sessionId) {
  for (let i = 0; i < 600; i++) {
    const view = processes.read(id, 4000, sessionId);
    if (view.status !== "running") return view;
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error("the program never ended");
}

test("a program held to one folder is walled by the shell before it starts, runs as it said, and is cleaned up when it ends", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-held-bg-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"),
    provider: { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } } });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const processes = new BackgroundProcesses(app.store, owner, join(root, "workspace"));
  t.after(() => processes.stopAll());
  const context = { owner, workspace: join(root, "workspace"), runId: app.store.createRun(owner, "build").id, depth: 0,
    signal: new AbortController().signal, permissions: new Set(["process.manage", "shell.execute"]), writesConfinedTo: join(root, "workspace", "site") };
  await assert.rejects(processes.start({ program: "npm", args: ["run", "build"], cwd: "site", name: "build" }, { ...context, permissions: new Set(["process.manage"]) }),
    /not one of the programs/, "a task that may not run commands never leaves one running");
  await assert.rejects(processes.start({ program: "npm", args: ["run", "build"], cwd: "site", name: "build" }, context),
    /cannot be left running here/, "no shell to wall it, so nothing starts");
  const asked = [];
  let cleaned = 0;
  processes.heldLauncher = async (input, held, timeoutMs) => {
    asked.push({ input, confined: held.writesConfinedTo, timeoutMs });
    return { start: { executable: process.execPath, args: ["-e", "console.log('built')"], env: process.env }, cwd: root,
      cleanup: async () => { cleaned++; return []; } };
  };
  const started = await processes.start({ program: "npm", args: ["run", "build"], cwd: "site", name: "build" }, context);
  assert.equal(started.heldTo, context.writesConfinedTo, "the answer says where its writes are held");
  assert.deepEqual(asked, [{ input: { executable: "npm", args: ["run", "build"], cwd: "site" }, confined: context.writesConfinedTo,
    timeoutMs: processes.settings().maxMinutes * 60_000 }], "the shell is asked by its command name, with the program's time limit");
  const view = await ended(processes, started.id);
  assert.equal(view.status, "finished");
  assert.match(view.output, /built/);
  for (let i = 0; i < 40 && !cleaned; i++) await new Promise((done) => setTimeout(done, 25));
  assert.equal(cleaned, 1, "its wall and scratch folder go once it ends");
  const event = app.store.events(context.runId).find((one) => one.kind === "process.started");
  assert.equal(event.data.heldTo, context.writesConfinedTo);
});

test("the owner's selected Full Access reaches a program left running as it reaches a command, and nothing else does", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-held-bg-full-"));
  const call = { id: "bg", name: "process.start", arguments: JSON.stringify({ program: "npm", args: ["install"] }) };
  let turn = 0;
  const provider = { name: "scripted", async complete() { return ++turn % 2 ? { content: "", toolCalls: [call] } : { content: "Done.", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  const seen = [];
  app.registry.unregister("process.start");
  app.registry.register({ name: "process.start", permission: "process.manage", description: "stand-in", parameters: z.object({}).passthrough(),
    execute: async (_input, context) => { seen.push(context.ownerFullAccess); return { id: "x", status: "running" }; } });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const run = async (body) => (await fetch(new URL("/api/run", server.url), { method: "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify(body) })).json();
  const full = await run({ prompt: "Leave it running", mode: "full" });
  assert.equal(full.status, "completed", full.output);
  assert.deepEqual(seen, [true]);
  savePolicy(app.store, app.runtime.owner, { preset: "off", rules: [], unmatchedCommands: "allow" });
  app.store.save("settings", app.runtime.owner, "conversation-mode-settings", { newConversation: "follow" });
  const loose = await run({ prompt: "Leave it running" });
  assert.equal(loose.status, "completed", loose.output);
  assert.deepEqual(seen, [true, undefined], "an owner's loose setting is not a selected Full Access conversation");
});

/** Windows holds a command inside WSL; macOS and Linux behind their own wall. Either must be there for the real run. */
const ready = process.platform === "win32" ? (await wslReadiness(wslProbe)) === null : (await wallReport()).available;
/** What the held program reports as its platform: Linux inside WSL, the computer's own elsewhere. */
const heldPlatform = process.platform === "win32" ? "linux" : process.platform;

test("in Branch's own worktree a program left running really runs held to its folder, and its end wakes the conversation", { skip: !ready && "needs the OS wall (WSL with Node.js and bubblewrap on Windows)" }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-held-bg-wsl-"));
  const engine = await startEngine(root, { token: "x", npm: true, githubApiBase: "http://127.0.0.1:9/", privateAddresses: true,
    provider: { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } } });
  t.after(async () => { await engine.app.processes.stopAll(); await engine.close(); await discardTemp(root); });
  const source = join(engine.workspace, "branch-agent-source"), worktree = "branch-agent-source/.branch-worktrees/self-x";
  const git = (...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { cwd: source, encoding: "utf8" }).trim();
  await mkdir(source, { recursive: true });
  git("init", "-q", "-b", "redesign/window");
  await writeFile(join(source, "a.txt"), "original\n");
  git("add", "."); git("commit", "-qm", "base");
  git("worktree", "add", "-q", "-b", "branch/self-x", ".branch-worktrees/self-x");
  await mkdir(join(engine.workspace, worktree, "src"), { recursive: true });
  const run = await engine.api("run", { prompt: "work", mode: "full" });
  const book = new ContractBook(engine.app.store.sqlite);
  const contract = (permissions) => book.create(engine.app.runtime.owner, { taskRunId: run.body.id, sourceSha: git("rev-parse", "HEAD"),
    worktreePath: worktree, terms: { allowedPaths: ["**"], permissions, expectedTests: ["tests/a.test.mjs"],
      definitionOfDone: "d", sideEffects: [], rollbackPlan: "r" }, sendRepositories: ["stabrea/branch-agent"] });
  contract(["shell.execute", "process.start"]);
  const context = { ...engine.app.runtime.context({ runId: run.body.id }), permissions: new Set(["process.manage", "process.read", "shell.execute"]) };
  const script = "require('fs').writeFileSync('inside.txt','ok'); let out; try { require('fs').writeFileSync('../../../a.txt','PWNED'); out='wrote' } catch (e) { out=e.code }"
    + "; console.log(process.platform + ' ' + out)";
  const started = await engine.app.registry.execute("process.start",
    { program: "node", args: ["-e", script], cwd: `${worktree}/src`, name: "the build", wakeOnExit: true }, context);
  assert.equal(started.heldTo, join(engine.workspace, worktree, "src"), "held to the folder it runs in");
  const view = await ended(engine.app.processes, started.id);
  assert.equal(view.status, "finished", view.output);
  assert.match(view.output, new RegExp(`^${heldPlatform} `, "m"), "it ran behind the wall");
  assert.equal(await readFile(join(engine.workspace, worktree, "src", "inside.txt"), "utf8"), "ok", "a write inside the folder lands");
  // Outside its folder a write is refused (read-only under WSL), or lands only in the wall's own throwaway view (a
  // temporary folder bubblewrap covers on Linux). Either way the real file is untouched.
  assert.equal(await readFile(join(source, "a.txt"), "utf8"), "original\n", "a write outside its folder never reaches the real file");
  for (let i = 0; i < 100 && !engine.app.store.events(run.body.id).some((event) => event.kind === "process.woke"); i++)
    await new Promise((done) => setTimeout(done, 50));
  assert.ok(engine.app.store.events(run.body.id).some((event) => event.kind === "process.woke"), "its end wakes the conversation");
  // A contract that does not list process.start still refuses it, as it refuses any tool it does not list.
  const other = "branch-agent-source/.branch-worktrees/self-y";
  git("worktree", "add", "-q", "-b", "branch/self-y", ".branch-worktrees/self-y");
  book.create(engine.app.runtime.owner, { taskRunId: run.body.id, sourceSha: git("rev-parse", "HEAD"), worktreePath: other,
    terms: { allowedPaths: ["**"], permissions: ["shell.execute"], expectedTests: ["t"], definitionOfDone: "d", sideEffects: [], rollbackPlan: "r" },
    sendRepositories: ["stabrea/branch-agent"] });
  await assert.rejects(engine.app.registry.execute("process.start", { program: "node", args: ["-e", "1"], cwd: other }, context),
    /process.start is not one of the tools this contract allows/);
});
