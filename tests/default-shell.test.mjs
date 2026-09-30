import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { defaultShellConfig, locateProgram } from "../dist/integrations/default-shell.js";
import { loadIntegrations } from "../dist/integrations/bootstrap.js";
import { ToolRegistry } from "../dist/registry.js";
import { evaluatePolicy, PolicySchema, policyTarget, standingRule } from "../dist/policy.js";
import { resourceOf } from "../dist/policy-resources.js";

const windowsHost = process.platform === "win32";

/**
 * Dogfood A2: with no command settings file the desktop app could not run a single command on its own computer,
 * so asked to fix its own code it could not look at it. It now starts with the developer programs installed here,
 * each by its full address; a program that is not installed is never listed.
 */

async function folder(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-default-shell-"));
  t.after(() => discardTemp(root));
  return root;
}

/** A program file that may be run, as an installer leaves one. */
async function program(where, name) {
  await mkdir(where, { recursive: true });
  await writeFile(join(where, name), "#!/bin/sh\n");
  await chmod(join(where, name), 0o755);
}

/** Does `work` from inside `where`, as when Branch is started from a project folder (`npm run` does this). */
async function from(where, work) {
  const before = process.cwd();
  process.chdir(where);
  try { return await work(); } finally { process.chdir(before); }
}

test("on Windows the installed programs are listed by full address, and an npm launcher as Node running its script", async (t) => {
  const bin = await folder(t);
  await writeFile(join(bin, "git.exe"), "");
  await writeFile(join(bin, "node.exe"), "");
  await mkdir(join(bin, "node_modules", "npm", "bin"), { recursive: true });
  await writeFile(join(bin, "node_modules", "npm", "bin", "npm-cli.js"), "");
  await writeFile(join(bin, "npm.cmd"), `@ECHO off\r\n"%_prog%"  "%dp0%\\node_modules\\npm\\bin\\npm-cli.js" %*\r\n`);
  const config = defaultShellConfig({ PATH: bin, USERPROFILE: "C:\\Users\\owner" }, "win32");
  assert.deepEqual(config.executables.git, { path: join(bin, "git.exe"), args: [] });
  assert.deepEqual(config.executables.npm, { path: join(bin, "node.exe"), args: [join(bin, "node_modules", "npm", "bin", "npm-cli.js")] });
  assert.equal(config.executables.python, undefined, "a program that is not installed is never listed");
  assert.equal(config.env.HOME, "C:\\Users\\owner", "Git and npm find their settings from the home folder");
});

test("an npm launcher with no Node installed is not listed, and looking for Node itself ends", async (t) => {
  const bin = await folder(t);
  await mkdir(join(bin, "node_modules", "npm", "bin"), { recursive: true });
  await writeFile(join(bin, "node_modules", "npm", "bin", "npm-cli.js"), "");
  await writeFile(join(bin, "npm.cmd"), `@ECHO off\r\n"%_prog%"  "%dp0%\\node_modules\\npm\\bin\\npm-cli.js" %*\r\n`);
  assert.equal(locateProgram("npm", { PATH: bin }, "win32"), null);
  assert.equal(locateProgram("node", { PATH: bin }, "win32"), null);
});

test("elsewhere a program is found where PATH says, and nothing installed means no command settings at all", async (t) => {
  const bin = await folder(t);
  await writeFile(join(bin, "git"), "#!/bin/sh\n");
  await chmod(join(bin, "git"), 0o755);
  assert.deepEqual(locateProgram("git", { PATH: bin }, "linux"), { path: join(bin, "git"), args: [] });
  assert.equal(locateProgram("gh", { PATH: bin }, "linux"), null);
  assert.equal(defaultShellConfig({ PATH: await folder(t) }, "linux"), null);
});

test("with no settings file, Branch can still run the programs installed here", async (t) => {
  const registry = new ToolRegistry();
  const loaded = await loadIntegrations(registry, undefined, process.env);
  t.after(() => loaded.close());
  assert.ok(registry.names().includes("shell.execute"), "the command tool is there, because this computer has Node at least");
});

test("a PATH folder that is not a full address is skipped, and Branch still starts with the programs in the rest",
  { skip: windowsHost && "these are macOS and Linux programs; the Windows case is the next test" }, async (t) => {
    const project = await folder(t), system = await folder(t);
    await program(join(project, "node_modules", ".bin"), "git");
    await program(system, "git");
    // The `./node_modules/.bin` habit: a folder that names a different place from each folder it is read from.
    const env = { PATH: ["./node_modules/.bin", system].join(delimiter) };
    const registry = new ToolRegistry();
    const loaded = await from(project, async () => {
      assert.deepEqual(defaultShellConfig(env)?.executables.git, { path: join(system, "git"), args: [] });
      return loadIntegrations(registry, undefined, env);
    });
    t.after(() => loaded.close());
    assert.ok(registry.names().includes("shell.execute"), "Branch starts, with the command tool");
  });

test("on Windows, too, a PATH folder that is not a full address or that is inside the workspace is skipped", async (t) => {
  const project = await folder(t), workspace = await folder(t), system = await folder(t);
  const planted = join(workspace, "node_modules", ".bin");
  for (const where of [join(project, "tools"), planted, system]) {
    await mkdir(where, { recursive: true });
    await writeFile(join(where, "git.exe"), "");
  }
  const relativeFirst = await from(project, () => defaultShellConfig({ PATH: ["tools", system].join(delimiter) }, "win32"));
  assert.deepEqual(relativeFirst?.executables.git, { path: join(system, "git.exe"), args: [] });
  const plantedFirst = defaultShellConfig({ PATH: [planted, system].join(delimiter) }, "win32", [workspace]);
  assert.deepEqual(plantedFirst?.executables.git, { path: join(system, "git.exe"), args: [] });
});

test("a PATH folder inside the workspace, as written or through a link, is skipped, so a program planted there is never taken",
  { skip: windowsHost && "these are macOS and Linux programs; the Windows case is the test before" }, async (t) => {
    const workspace = await folder(t), system = await folder(t), outside = await folder(t);
    const planted = join(workspace, "node_modules", ".bin");
    for (const name of ["git", "node"]) { await program(planted, name); await program(system, name); }
    // A folder outside the workspace that is a link into it holds the same planted programs.
    await symlink(planted, join(outside, "bin"));
    for (const first of [planted, join(outside, "bin")]) {
      const config = defaultShellConfig({ PATH: [first, system].join(delimiter) }, process.platform, [workspace]);
      assert.deepEqual(config?.executables.git, { path: join(system, "git"), args: [] }, `git, with ${first} first on PATH`);
      assert.deepEqual(config?.executables.node, { path: join(system, "node"), args: [] }, `node, with ${first} first on PATH`);
    }
  });

test("with no settings file, Branch never offers a program from the workspace it works in", async (t) => {
  const workspace = await folder(t);
  const planted = join(workspace, "node_modules", ".bin");
  await program(planted, "git");
  await writeFile(join(planted, "git.exe"), "");
  const registry = new ToolRegistry();
  // What the launch knows about itself: the workspace its tasks work in.
  const host = { context: () => ({ owner: "owner", workspace }) };
  const loaded = await loadIntegrations(registry, undefined, { PATH: planted }, undefined, host);
  t.after(() => loaded.close());
  assert.equal(registry.names().includes("shell.execute"), false, "the only git on PATH is the workspace's own, so there is no command tool");
});

test("where only python3 is installed it is offered as python3, and a yes given for python never covers it, nor the reverse", async (t) => {
  const bin = await folder(t);
  await program(bin, "python3");
  const only = defaultShellConfig({ PATH: bin }, "linux");
  assert.deepEqual(only?.executables.python3, { path: join(bin, "python3"), args: [] });
  assert.equal(only?.executables.python, undefined, "offered under the name of the program that runs");
  await program(bin, "python");
  const both = defaultShellConfig({ PATH: bin }, "linux");
  assert.deepEqual(Object.keys(both.executables), ["python"], "where python is installed it is offered as before, and python3 is not added beside it");
  // The owner's rules read the words a command is offered under.
  const asked = (executable) => {
    const input = { executable, args: ["tool.py"] }, target = policyTarget("shell.execute", input);
    return { tool: "shell.execute", target, readOnly: false, resource: resourceOf("shell.execute", "shell.execute", target, input) };
  };
  // Owner ruling 2026-09-30: commands no rule covers ship as "allow"; here the owner keeps them asking.
  const always = (match) => ({ ...PolicySchema.parse({ unmatchedCommands: "ask" }),
    rules: [standingRule({ tool: "shell.execute", match, applies: "any", decision: "allow", remember: "always" })] });
  assert.equal(evaluatePolicy(always("python3 tool.py"), asked("python3")).decision, "allow");
  assert.equal(evaluatePolicy(always("python tool.py"), asked("python3")).decision, "ask");
  assert.equal(evaluatePolicy(always("python3 tool.py"), asked("python")).decision, "ask");
});

test("a file on PATH that is not marked runnable is passed over for the next folder's program",
  { skip: windowsHost && "Windows has no execute bit: a program there is any file it can start" }, async (t) => {
    const first = await folder(t), second = await folder(t);
    await writeFile(join(first, "git"), "#!/bin/sh\n");
    await chmod(join(first, "git"), 0o644);
    await program(second, "git");
    assert.deepEqual(locateProgram("git", { PATH: [first, second].join(delimiter) }, "linux"), { path: join(second, "git"), args: [] });
    assert.equal(locateProgram("git", { PATH: first }, "linux"), null);
  });
