/**
 * SELF-083: a handed-off Claude Code runs commands and tests, and only through Branch's own held shell. Its own Bash
 * stays refused. It gets one MCP door on 127.0.0.1 with a key made for that job. Branch weighs every command it
 * sends as the task's own shell.execute and holds its writes to the job's folder.
 *
 * The program is a stand-in (the real Claude Code is never started). It is a real MCP client, though: it reads the
 * --mcp-config file it was handed and speaks JSON-RPC over HTTP to the door, the way Claude Code does. So what these
 * tests prove is the door and Branch's side of each command.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createBranch, savePolicy } from "../dist/index.js";
import { ContractBook } from "../dist/self-development-contract.js";
import { HandOff, programCall } from "../dist/coding/hand-off.js";
import { CommandDoor, doorToolName, commandAnswer } from "../dist/coding/hand-off-door.js";
import { folderCwd, heldHandOffCommands } from "../dist/coding/hand-off-commands.js";
import { wslProbe, wslReadiness } from "../dist/integrations/wsl-held.js";
import { wallReport } from "../dist/sandbox-backends.js";
import { startEngine } from "./fixtures/selfdev-harness.mjs";
import { discardTemp } from "./temp-dir.mjs";

const owner = "local";

/** What the stand-in finds in its arguments: the door's address and key, from the file --mcp-config names. */
async function doorFrom(args) {
  const at = args.indexOf("--mcp-config");
  if (at < 0) return null;
  const config = JSON.parse(await readFile(args[at + 1], "utf8"));
  const server = config.mcpServers.branch;
  return { url: server.url, authorization: server.headers.Authorization, file: args[at + 1] };
}

/** One JSON-RPC exchange with the door, as Claude Code's HTTP transport sends it. */
async function rpc(door, method, params, id = 1) {
  const response = await fetch(door.url, { method: "POST", headers: { authorization: door.authorization,
    "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify(id === null ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", id, method, params }) });
  return { status: response.status, body: response.status === 200 ? await response.json() : null };
}

/**
 * A stand-in Claude Code: it connects to the door it was given, lists its tools, sends each command, and ends with
 * the stream-json lines the real one prints. `seen` collects what it saw, for the test to look at.
 */
function standInClaude(commands, seen) {
  return async (call, onLine) => {
    seen.args = call.args;
    const door = await doorFrom(call.args);
    seen.door = door;
    const lines = [];
    if (door) {
      const hello = await rpc(door, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-code", version: "stand-in" } });
      seen.initialize = hello.body.result;
      seen.initialized = (await rpc(door, "notifications/initialized", {}, null)).status;
      seen.tools = (await rpc(door, "tools/list", {}, 2)).body.result.tools;
      seen.results = [];
      for (const [index, command] of commands.entries()) {
        const answer = (await rpc(door, "tools/call", { name: "run_command", arguments: command }, 10 + index)).body.result;
        seen.results.push(answer);
        lines.push(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: doorToolName }] } }));
      }
    }
    lines.push(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "Ran the checks." }));
    lines.forEach(onLine);
    return { code: 0, lines, stderr: "", timedOut: false, missing: false };
  };
}

async function repository(folder) {
  await mkdir(join(folder, "src"), { recursive: true });
  await writeFile(join(folder, "src", "a.ts"), "export const a = 1;\n");
  const git = (...args) => execFileSync("git", args, { cwd: folder });
  git("init", "-q"); git("config", "core.autocrlf", "false");
  git("-c", "user.email=t@example.invalid", "-c", "user.name=t", "add", ".");
  git("-c", "user.email=t@example.invalid", "-c", "user.name=t", "commit", "-qm", "start");
}

const gitRunner = async ({ cwd, args }) => {
  try { return { status: "completed", stdout: execFileSync("git", args, { cwd, encoding: "utf8" }), stderr: "" }; }
  catch (error) { return { status: "failed", stdout: "", stderr: String(error.stderr ?? error.message) }; }
};

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-hand-off-door-"));
  const workspace = join(root, "workspace");
  const app = await createBranch({ workspace, dataDir: join(root, "data"),
    provider: { name: "scripted", async complete() { return { content: "Noted.", toolCalls: [] }; } } });
  t.after(async () => { await app.close(); await discardTemp(root); });
  await repository(join(workspace, "site"));
  const envs = [];
  const handOff = (run, commands) => new HandOff({ store: app.store, owner, workspace, dataDir: join(root, "data"),
    book: new ContractBook(app.store.sqlite), git: gitRunner, commands,
    run: (call, _prompt, env, _signal, _timeout, onLine) => { envs.push(env); return run(call, onLine); } });
  const context = (permissions = ["code.handoff", "shell.execute"]) =>
    app.runtime.context({ runId: app.store.createRun(owner, "a job for Claude Code").id, permissions });
  return { app, root, workspace, handOff, context, envs };
}

test("Claude Code is given Branch's door as its one MCP server and one extra tool, and its own Bash stays refused", () => {
  const claude = programCall("claude-code", "/work/repo", undefined, undefined, ["--mcp-config", "/private/mcp.json", "--allowedTools", doorToolName]);
  assert.equal(claude.args[claude.args.indexOf("--mcp-config") + 1], "/private/mcp.json", "the key is in a file, never on the command line");
  assert.equal(claude.args[claude.args.indexOf("--allowedTools") + 1], doorToolName);
  assert.equal(doorToolName, "mcp__branch__run_command");
  assert.ok(claude.args.includes("--strict-mcp-config"), "no other MCP server, from the folder or anywhere else");
  assert.equal(claude.args[claude.args.indexOf("--disallowedTools") + 1], "Bash", "its own Bash is still refused");
  assert.ok(claude.args.includes("acceptEdits") && !claude.args.some((arg) => /bypass|dangerously|^Bash\(/.test(arg)));
  assert.equal(programCall("claude-code", "/work/repo").args.includes("--mcp-config"), false, "no door unless one is opened");
});

test("the door speaks MCP only with its own key, at its own address, one command at a time, and is gone once closed", async () => {
  let running = 0, overlapped = false;
  const ran = [];
  const door = await CommandDoor.open(async (command) => {
    running++; overlapped ||= running > 1;
    await new Promise((done) => setTimeout(done, 30));
    ran.push(command); running--;
    return { text: `ran ${command.program}`, isError: false };
  });
  const [, file] = door.claudeArgs();
  assert.equal(file, door.configFile);
  const client = await doorFrom(door.claudeArgs());
  assert.equal(new URL(client.url).hostname, "127.0.0.1");
  if (process.platform !== "win32") assert.equal((await import("node:fs")).statSync(file).mode & 0o077, 0, "only this user can read the key");
  // Without the key, or with another, nothing is answered.
  assert.equal((await rpc({ ...client, authorization: "Bearer nope" }, "tools/list", {})).status, 401);
  assert.equal((await fetch(client.url, { method: "POST", body: "{}" })).status, 401);
  // A page on another site that reaches this port under another name gets nothing either.
  const renamed = await new Promise((done) => {
    const url = new URL(client.url);
    request({ host: "127.0.0.1", port: url.port, path: url.pathname, method: "POST", headers: { host: `evil.example:${url.port}`, authorization: client.authorization } },
      (response) => { response.resume(); done(response.statusCode); }).end("{}");
  });
  assert.equal(renamed, 404);
  assert.equal((await fetch(client.url, { headers: { authorization: client.authorization } })).status, 405, "no stream of its own");
  const hello = await rpc(client, "initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "c", version: "1" } });
  assert.equal(hello.body.result.protocolVersion, "2025-03-26");
  assert.deepEqual(hello.body.result.capabilities, { tools: {} });
  assert.equal((await rpc(client, "notifications/initialized", {}, null)).status, 202);
  const tools = (await rpc(client, "tools/list", {})).body.result.tools;
  assert.deepEqual(tools.map((tool) => tool.name), ["run_command"]);
  assert.deepEqual(Object.keys(tools[0].inputSchema.properties).sort(), ["args", "cwd", "program", "timeoutSeconds"]);
  const bad = (await rpc(client, "tools/call", { name: "run_command", arguments: { program: "rm -rf /" } })).body.result;
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /not run/);
  assert.equal((await rpc(client, "tools/call", { name: "Bash", arguments: { command: "ls" } })).body.result.isError, true);
  const [one, two] = await Promise.all([
    rpc(client, "tools/call", { name: "run_command", arguments: { program: "npm", args: ["test"] } }, 3),
    rpc(client, "tools/call", { name: "run_command", arguments: { program: "git", args: ["status"] } }, 4),
  ]);
  assert.equal(one.body.result.content[0].text, "ran npm");
  assert.equal(two.body.result.content[0].text, "ran git");
  assert.equal(overlapped, false, "two commands sent at once still run one after the other");
  assert.deepEqual(ran.map((command) => [command.program, command.cwd]), [["npm", "."], ["git", "."]]);
  await door.close();
  assert.equal(existsSync(file), false, "the key's file goes with the door");
  await assert.rejects(fetch(client.url, { method: "POST", headers: { authorization: client.authorization }, body: "{}" }), "the door is closed");
});

test("a command's answer says how it ended and what it printed, and a failing one is an error", () => {
  assert.deepEqual(commandAnswer({ status: "completed", exitCode: 0, stdout: "ok\n", stderr: "" }), { text: "exit code 0\n\nstdout:\nok\n", isError: false });
  const failed = commandAnswer({ status: "completed", exitCode: 1, stdout: "", stderr: "1 failing\n" });
  assert.equal(failed.isError, true);
  assert.match(failed.text, /^exit code 1\n\nstderr:\n1 failing/);
  assert.match(commandAnswer({ status: "timeout", exitCode: null, stdout: "", stderr: "" }).text, /^timeout \(exit code none\)/);
});

test("a cwd is held inside the job's folder", () => {
  const folder = { absolute: join(tmpdir(), "w", "site"), fromWorkspace: "site" };
  assert.equal(folderCwd(folder, "."), "site");
  assert.equal(folderCwd(folder, "src/lib"), "site/src/lib");
  assert.equal(folderCwd(folder, "../other"), null);
  assert.equal(folderCwd(folder, join(tmpdir(), "elsewhere")), null);
});

test("a task that may not run commands, or a Codex job, gets no door, exactly as before", async (t) => {
  const f = await fixture(t);
  let asked = 0;
  const commands = async () => { asked++; return { text: "ran", isError: false }; };
  const seen = {};
  await f.handOff(standInClaude([], seen), commands).run({ program: "claude-code", folder: "site", task: "x", minutes: 1 }, f.context(["code.handoff"]));
  assert.equal(seen.door, null, "no shell.execute, no door");
  const codex = {};
  await f.handOff(async (call, onLine) => { codex.args = call.args; return standInClaude([], {})(call, onLine); }, commands)
    .run({ program: "codex", folder: "site", task: "x", minutes: 1 }, f.context());
  assert.equal(codex.args.includes("--mcp-config"), false, "Codex keeps its own workspace-write sandbox");
  assert.equal(asked, 0);
});

test("a handed-off Claude Code's commands reach Branch with the job's folder, are shown on the task, and the door closes with the job", async (t) => {
  const f = await fixture(t);
  const received = [];
  const commands = async (command, folder) => { received.push({ command, folder }); return { text: "exit code 0\n\nstdout:\n1 passing", isError: false }; };
  const seen = {}, job = f.context();
  const result = await f.handOff(standInClaude([{ program: "npm", args: ["test"], cwd: "src" }], seen), commands)
    .run({ program: "claude-code", folder: "site", task: "run the tests", minutes: 1 }, job);
  assert.equal(result.status, "done");
  assert.equal(seen.initialize.serverInfo.name, "branch-hand-off");
  assert.equal(seen.initialized, 202);
  assert.deepEqual(seen.tools.map((tool) => tool.name), ["run_command"]);
  assert.deepEqual(seen.results, [{ content: [{ type: "text", text: "exit code 0\n\nstdout:\n1 passing" }], isError: false }]);
  assert.deepEqual(received.map(({ command, folder }) => [command.program, command.args, command.cwd, folder.fromWorkspace]), [["npm", ["test"], "src", "site"]]);
  assert.deepEqual(result.steps, [doorToolName]);
  assert.equal(f.envs[0].MCP_TOOL_TIMEOUT, "60000", "Claude Code waits for a command as long as the job may take");
  const shown = f.app.store.events(job.runId).filter((event) => event.kind === "code.hand_off.command").map((event) => event.data);
  assert.deepEqual(shown, [{ program: "npm", args: ["test"], cwd: "src", ok: true }]);
  assert.equal(existsSync(seen.door.file), false, "the key's file is gone");
  await assert.rejects(rpc(seen.door, "tools/list", {}), "and so is the door");
});

async function engineFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-hand-off-weigh-"));
  const engine = await startEngine(root, { token: "x", githubApiBase: "http://127.0.0.1:9/", privateAddresses: true,
    provider: { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } } });
  t.after(async () => { await engine.close(); await discardTemp(root); });
  await repository(join(engine.workspace, "site"));
  const ran = [];
  engine.app.registry.unregister("shell.execute");
  engine.app.registry.register({ name: "shell.execute", permission: "shell.execute", description: "stand-in", parameters: z.object({}).passthrough(),
    execute: async (input, context) => { ran.push({ input, confined: context.writesConfinedTo, full: context.ownerFullAccess === true });
      return { status: "completed", exitCode: 0, stdout: "ok", stderr: "" }; } });
  const commands = heldHandOffCommands({ registry: engine.app.registry, store: engine.app.store, runtime: engine.app.runtime });
  const job = async (mode, permissions = ["code.handoff", "shell.execute"]) => {
    const run = await engine.api("run", { prompt: "work", ...(mode ? { mode } : {}) });
    return engine.app.runtime.context({ runId: run.body.id, permissions });
  };
  return { engine, ran, commands, job, folder: { absolute: join(engine.workspace, "site"), fromWorkspace: "site" } };
}

test("a command still running when Claude Code ends is stopped, and has settled before Branch looks at what changed", async (t) => {
  const f = await fixture(t);
  let started, stopped = false, settled = false;
  const begun = new Promise((done) => { started = done; });
  const commands = async (_command, folder, context) => {
    started();
    try {
      await new Promise((done) => { const timer = setTimeout(done, 5000); context.signal.addEventListener("abort", () => { clearTimeout(timer); stopped = true; done(); }, { once: true }); });
      if (!stopped) await writeFile(join(folder.absolute, "late.txt"), "written after the job");
      return { text: stopped ? "stopped" : "exit code 0", isError: stopped };
    } finally { settled = true; }
  };
  // The stand-in sends a slow command and ends without waiting for it, as Claude Code does when it gives up on a call.
  const result = await f.handOff(async (call, onLine) => {
    const door = await doorFrom(call.args);
    void rpc(door, "tools/call", { name: "run_command", arguments: { program: "npm", args: ["test"] } }).catch(() => undefined);
    await begun;
    const lines = [JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "Gave up." })];
    lines.forEach(onLine);
    return { code: 0, lines, stderr: "", timedOut: false, missing: false };
  }, commands).run({ program: "claude-code", folder: "site", task: "run the tests", minutes: 1 }, f.context());
  assert.equal(stopped, true, "the command was stopped with the door");
  assert.equal(settled, true, "and had settled before the hand-off answered");
  assert.equal(existsSync(join(f.workspace, "site", "late.txt")), false);
  assert.deepEqual(result.changed, []);
});

test("each command is weighed as the task's own shell.execute: in Full Access it runs held to the job's folder, and the owner's refusals and questions stand", async (t) => {
  const f = await engineFixture(t);
  savePolicy(f.engine.app.store, owner, { preset: "custom", unmatchedCommands: "ask", rules: [
    { tool: "shell.execute", match: "git push*", decision: "deny" },
    { tool: "shell.execute", match: "npm publish*", decision: "ask" },
  ] });
  const full = await f.job("full");
  const allowed = await f.commands({ program: "npm", args: ["test"], cwd: "src" }, f.folder, full);
  assert.equal(allowed.isError, false, allowed.text);
  assert.deepEqual(f.ran, [{ input: { executable: "npm", args: ["test"], cwd: "site/src" }, confined: f.folder.absolute, full: true }],
    "run as shell.execute, its writes held to the job's folder, with the owner's Full Access carried to it");
  const denied = await f.commands({ program: "git", args: ["push"], cwd: "." }, f.folder, full);
  assert.equal(denied.isError, true);
  assert.match(denied.text, /refuse this command/);
  const asked = await f.commands({ program: "npm", args: ["publish"], cwd: "." }, f.folder, full);
  assert.equal(asked.isError, true);
  assert.match(asked.text, /ask the owner before this command/);
  const away = await f.commands({ program: "npm", args: ["test"], cwd: "../elsewhere" }, f.folder, full);
  assert.match(away.text, /outside the folder/);
  const noShell = await f.commands({ program: "npm", args: ["test"], cwd: "." }, f.folder, await f.job("full", ["code.handoff"]));
  assert.equal(noShell.isError, true, "a task without commands gets none through the door either");
  assert.equal(f.ran.length, 1, "only the allowed command ran");
  const kinds = f.engine.app.store.events(full.runId).map((event) => event.kind);
  assert.ok(kinds.includes("policy.denied") && kinds.includes("policy.ask"), "each refusal is on the task's record");
});

test("outside Full Access, for an owner who keeps commands asking, a command nobody has decided on is a question inside a hand-off", async (t) => {
  const f = await engineFixture(t);
  // Owner ruling 2026-09-30: commands no rule covers ship as "allow"; this owner chose "ask".
  savePolicy(f.engine.app.store, f.engine.app.runtime.owner, { unmatchedCommands: "ask" });
  const plain = await f.job(null);
  const answer = await f.commands({ program: "npm", args: ["test"], cwd: "." }, f.folder, plain);
  assert.equal(answer.isError, true);
  assert.match(answer.text, /ask the owner before this command/);
  assert.equal(f.ran.length, 0);
});

/** Windows holds a command inside WSL; macOS and Linux behind their own wall. Either must be there for the real run. */
const ready = process.platform === "win32" ? (await wslReadiness(wslProbe)) === null : (await wallReport()).available;
/** What the held command reports as its platform: Linux inside WSL, the computer's own elsewhere. */
const heldPlatform = process.platform === "win32" ? "linux" : process.platform;

test("in Branch's own worktree, a handed-off Claude Code's command really runs held to the folder, under the contract", { skip: !ready && "needs the OS wall (WSL with Node.js and bubblewrap on Windows)" }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-hand-off-held-"));
  const engine = await startEngine(root, { token: "x", npm: true, githubApiBase: "http://127.0.0.1:9/", privateAddresses: true,
    provider: { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } } });
  t.after(async () => { await engine.close(); await discardTemp(root); });
  const source = join(engine.workspace, "branch-agent-source"), worktree = "branch-agent-source/.branch-worktrees/self-x";
  const git = (...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { cwd: source, encoding: "utf8" }).trim();
  await mkdir(source, { recursive: true });
  git("init", "-q", "-b", "redesign/window");
  await writeFile(join(source, "a.txt"), "original\n");
  git("add", "."); git("commit", "-qm", "base");
  git("worktree", "add", "-q", "-b", "branch/self-x", ".branch-worktrees/self-x");
  await mkdir(join(engine.workspace, worktree, "src"), { recursive: true });
  const run = await engine.api("run", { prompt: "work", mode: "full" });
  new ContractBook(engine.app.store.sqlite).create(engine.app.runtime.owner, { taskRunId: run.body.id, sourceSha: git("rev-parse", "HEAD"),
    worktreePath: worktree, terms: { allowedPaths: ["**"], permissions: ["shell.execute", "code.hand_off"], expectedTests: ["tests/a.test.mjs"],
      definitionOfDone: "d", sideEffects: [], rollbackPlan: "r" }, sendRepositories: ["stabrea/branch-agent"] });
  const context = { ...engine.app.runtime.context({ runId: run.body.id }), permissions: new Set(["shell.execute", "code.handoff"]) };
  const commands = heldHandOffCommands({ registry: engine.app.registry, store: engine.app.store, runtime: engine.app.runtime });
  const seen = {};
  const handOff = new HandOff({ store: engine.app.store, owner: engine.app.runtime.owner, workspace: engine.workspace, dataDir: join(root, "data"),
    book: new ContractBook(engine.app.store.sqlite), git: gitRunner, commands,
    run: (call, _prompt, _env, _signal, _timeout, onLine) => standInClaude([
      { program: "node", args: ["-e", "require('fs').writeFileSync('inside.txt','ok'); console.log(process.platform)"], cwd: "src" },
      { program: "node", args: ["-e", "try { require('fs').writeFileSync('../../../a.txt', 'PWNED'); console.log('wrote') } catch (e) { console.log(e.code) }"], cwd: "src" },
    ], seen)(call, onLine) });
  const result = await handOff.run({ program: "claude-code", folder: worktree, task: "run it", minutes: 5 }, context);
  assert.equal(seen.results[0].isError, false, seen.results[0].content[0].text);
  assert.match(seen.results[0].content[0].text, new RegExp(`stdout:\\n${heldPlatform}`), "it ran behind the wall");
  assert.equal(await readFile(join(engine.workspace, worktree, "src", "inside.txt"), "utf8"), "ok", "a write inside the folder lands");
  // Outside its folder a write is refused (read-only under WSL), or lands only in the wall's own throwaway view (a
  // temporary folder bubblewrap covers on Linux). Either way the real file is untouched.
  assert.equal(await readFile(join(source, "a.txt"), "utf8"), "original\n", "a write outside the folder never reaches the real file");
  assert.deepEqual(result.changed, ["src/inside.txt"]);
});
