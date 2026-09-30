/**
 * SELF-015: downloads inside the worktree. On Windows a command held to a self-development worktree runs inside WSL
 * behind bubblewrap, and it used to be limited to node, npm, npx and git. Now Python and its installers (pip, pip3,
 * pipx, uv) and curl and wget run there too.
 * - They reach the network only in the owner's selected Full Access, and their writes stay held to the folder.
 * - A held pip or python3 is the worktree's own `.venv/bin/<name>` when there is one, since Ubuntu's own Python is
 *   externally managed. A link there that leads out of the folder is refused, apart from a venv's python3 pointing at
 *   the system's interpreter.
 * - apt is never run. The owner is given the exact `sudo apt-get install` line to run themselves.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContractBook } from "../dist/self-development-contract.js";
import { BranchShell } from "../dist/integrations/shell.js";
import { aptRefusal, wslHeldPlan, wslOnlyName, wslProbe, wslProgram, wslReadiness, wslNoProgram } from "../dist/integrations/wsl-held.js";
import { heldProgram } from "../dist/integrations/wsl-held-runner.js";
import { startEngine } from "./fixtures/selfdev-harness.mjs";
import { discardTemp } from "./temp-dir.mjs";

test("the WSL allow-list covers Python, its installers and the downloaders, and nothing else", () => {
  for (const name of ["python3", "pip", "pip3", "pipx", "uv", "curl", "wget", "node", "npm", "npx", "git"]) assert.equal(wslProgram(name), name);
  assert.equal(wslProgram("C:\\Python312\\python.exe"), "python3", "Windows' python is WSL's python3");
  assert.equal(wslProgram("C:\\Windows\\System32\\curl.exe"), "curl");
  for (const name of ["bash", "sh", "sudo", "perl", "powershell"])
    assert.throws(() => wslProgram(name), /only node, npm, npx, git, python3, pip, pip3, pipx, uv, curl, wget/, name);
  assert.equal(wslOnlyName("wget"), true);
  assert.equal(wslOnlyName("apt-get"), true, "apt is named so it can be refused with the owner's line");
  assert.equal(wslOnlyName("bash"), false);
  const plan = wslHeldPlan({ executable: { path: "C:/Python312/python.exe", args: [] }, args: ["-m", "venv", ".venv"], cwd: "C:/w/x",
    workspace: "C:/w", env: {}, secrets: [], registry: false, open: true, timeoutMs: 1000 });
  assert.deepEqual([plan.program, plan.args, plan.open], ["python3", ["-m", "venv", ".venv"], true]);
});

test("apt is never run: the owner is given the exact line to run themselves", () => {
  assert.throws(() => wslProgram("apt-get", ["install", "-y", "jq", "ripgrep"]), (error) =>
    error.message.endsWith("in Ubuntu (WSL) themselves: sudo apt-get install jq ripgrep") && /needs root/.test(error.message));
  assert.match(aptRefusal(["update"]), /sudo apt-get install <the packages>$/);
  assert.match(aptRefusal(["install", "jq;rm", "-rf", "x"]), /sudo apt-get install x$/, "only package-shaped words reach the line");
  assert.match(wslNoProgram("pip"), /sudo apt-get install python3-pip/);
});

test("a held pip or python3 is the worktree's own venv, and a link out of the folder is refused", async () => {
  const plan = (program) => ({ program, cwd: "/mnt/c/w/site/src", workspace: "/mnt/c/w/site" });
  const look = (links, system = {}) => ({ exists: (path) => Object.hasOwn(links, path), real: async (path) => links[path] ?? path,
    find: (program) => system[program] ?? null });
  const venv = "/mnt/c/w/site/.venv/bin";
  // The command's own folder first, then the held folder's top.
  assert.deepEqual(await heldProgram(plan("pip"), look({ [`${venv}/pip`]: `${venv}/pip` })), { path: `${venv}/pip` });
  assert.deepEqual(await heldProgram(plan("pip3"), look({ "/mnt/c/w/site/src/.venv/bin/pip3": "/mnt/c/w/site/src/.venv/bin/pip3" })),
    { path: "/mnt/c/w/site/src/.venv/bin/pip3" });
  // A venv's python3 is a link to the system's interpreter, and only that link leaves the folder.
  assert.deepEqual(await heldProgram(plan("python3"), look({ [`${venv}/python3`]: "/usr/bin/python3.12" })), { path: `${venv}/python3` });
  for (const [program, target] of [["pip", "/usr/bin/wget"], ["python3", "/usr/bin/bash"], ["python3", "/home/o/evil/python3"], ["pip3", "/tmp/pip3"]]) {
    const answer = await heldProgram(plan(program), look({ [`${venv}/${program}`]: target }));
    assert.match(answer.refusal, new RegExp(`leads outside the folder this command is held to \\(to ${target.replace(/\//g, "\\/")}\\)`), `${program} -> ${target}`);
  }
  // No venv: the system's own program, or the owner is told how to add it.
  assert.deepEqual(await heldProgram(plan("pip"), look({}, { pip: "/usr/bin/pip" })), { path: "/usr/bin/pip" });
  assert.deepEqual(await heldProgram(plan("curl"), look({ [`${venv}/curl`]: `${venv}/curl` }, { curl: "/usr/bin/curl" })), { path: "/usr/bin/curl" },
    "only python3, pip and pip3 come from a venv");
  assert.deepEqual(await heldProgram(plan("uv"), look({})), { refusal: wslNoProgram("uv") });
});

test("on Windows a held apt command is refused with the owner's line before anything starts", { skip: process.platform !== "win32" }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-held-apt-"));
  t.after(() => discardTemp(root));
  await mkdir(join(root, "w"), { recursive: true });
  const shell = new BranchShell({ executables: { node: { path: process.execPath } } }, process.env);
  t.after(() => shell.close());
  const context = { owner: "local", runId: "r", workspace: root, writesConfinedTo: join(root, "w"), signal: new AbortController().signal };
  await assert.rejects(shell.execute({ executable: "apt-get", args: ["install", "jq"], cwd: "w" }, context), /themselves: sudo apt-get install jq$/);
  await assert.rejects(shell.execute({ executable: "bash", args: [], cwd: "w" }, context), /Executable alias is not configured/,
    "a program WSL does not run still needs an alias, and gets none");
  await assert.rejects(shell.execute({ executable: "wget", args: [], cwd: "w" }, { ...context, writesConfinedTo: undefined }),
    /Executable alias is not configured/, "outside a held command nothing changes");
});

const ready = process.platform === "win32" && (await wslReadiness(wslProbe)) === null;

/** A tiny web server inside WSL, where a held command's open wall can reach it; stopped when the test ends. */
async function serverInWsl(t, body) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const script = `require('http').createServer((q, r) => r.end(${JSON.stringify(body)})).listen(${port}, '127.0.0.1', () => console.log('up')); setTimeout(() => process.exit(0), 180000);`;
  const child = spawn("wsl.exe", ["--exec", "node", "-e", script], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { child.kill(); });
  await new Promise((done, fail) => {
    const timer = setTimeout(() => fail(new Error("the server in WSL never started")), 30000);
    child.stdout.on("data", (chunk) => { if (String(chunk).includes("up")) { clearTimeout(timer); done(); } });
  });
  return `http://127.0.0.1:${port}/`;
}

test("in Branch's own worktree, curl, wget and a venv's pip really run held to the folder, reaching the network only in Full Access", { skip: !ready && "needs Windows with WSL, Node.js and bubblewrap" }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-held-downloads-"));
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
  const folder = join(engine.workspace, worktree, "src");
  await mkdir(folder, { recursive: true });
  const run = await engine.api("run", { prompt: "work", mode: "full" });
  new ContractBook(engine.app.store.sqlite).create(engine.app.runtime.owner, { taskRunId: run.body.id, sourceSha: git("rev-parse", "HEAD"),
    worktreePath: worktree, terms: { allowedPaths: ["**"], permissions: ["shell.execute"], expectedTests: ["tests/a.test.mjs"],
      definitionOfDone: "d", sideEffects: [], rollbackPlan: "r" }, sendRepositories: ["stabrea/branch-agent"] });
  const context = { ...engine.app.runtime.context({ runId: run.body.id }), permissions: new Set(["shell.execute"]) };
  const shell = (executable, args, full = true) => engine.app.registry.execute("shell.execute", { executable, args, cwd: `${worktree}/src`, timeoutMs: 120000 },
    full ? { ...context, ownerFullAccess: true } : context);
  const url = await serverInWsl(t, "hello from the web");

  // In Full Access a download lands in the worktree; outside it the wall has no network, so nothing lands.
  const curl = await shell("curl", ["-fsS", "-o", "got.txt", url]);
  assert.equal(curl.exitCode, 0, curl.stderr);
  assert.equal(await readFile(join(folder, "got.txt"), "utf8"), "hello from the web");
  const wget = await shell("wget", ["-q", "-O", "got-wget.txt", url]);
  assert.equal(wget.exitCode, 0, wget.stderr);
  assert.equal(await readFile(join(folder, "got-wget.txt"), "utf8"), "hello from the web");
  const shut = await shell("curl", ["-fsS", "-o", "shut.txt", url], false);
  assert.notEqual(shut.exitCode, 0, "outside Full Access the wall has no network");
  assert.equal(existsSync(join(folder, "shut.txt")), false);
  // A download aimed outside the folder never reaches the real file.
  await shell("curl", ["-fsS", "-o", "../../../a.txt", url]);
  assert.equal(await readFile(join(source, "a.txt"), "utf8"), "original\n");

  // Python runs held, a venv is made in the worktree, and a held pip is that venv's own.
  const venv = await shell("python3", ["-m", "venv", ".venv"]);
  assert.equal(venv.exitCode, 0, venv.stderr);
  const pip = await shell("pip", ["--version"]);
  assert.equal(pip.exitCode, 0, pip.stderr);
  assert.match(pip.stdout, /self-x\/src\/\.venv\/lib\/python3/, "pip is the worktree's venv, not the system's");
  const prefix = await shell("python3", ["-c", "import sys; print(sys.prefix)"]);
  assert.match(prefix.stdout.trim(), /self-x\/src\/\.venv$/, "and so is python3");

  // A venv link planted to lead out of the folder is refused before it runs.
  execFileSync("wsl.exe", ["--exec", "sh", "-c", `rm -f .venv/bin/pip3 && ln -s /usr/bin/wget .venv/bin/pip3`], { cwd: folder });
  const planted = await shell("pip3", ["--version"]);
  assert.notEqual(planted.exitCode, 0);
  assert.match(planted.stderr, /\.venv\/bin\/pip3 leads outside the folder this command is held to \(to \/usr\/bin\/wget\)/);

  // apt, through the real shell, is refused with the line the owner runs themselves.
  await assert.rejects(shell("apt-get", ["install", "-y", "jq"]), /themselves: sudo apt-get install jq/);
});
