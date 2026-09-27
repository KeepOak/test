/**
 * The second review of #332 found three launch shapes that still reached code in the workspace past the guard
 * (src/mcp-workspace-guard.ts): a file: URL, inline code that names a workspace path, and a package runner told to take
 * its package from a workspace folder. Its follow-up added five more: options that move a runner into another folder,
 * shell command strings, wsl, `python -m pip|uv`, and an option that takes a value placed before the program. Review 2
 * of #368 added a home-relative `~` path, cmd's `^` escape, a name split by shell quotes, and 8.3 short names. Each is
 * refused when the server is added and when it is switched on, and (for the shapes that run locally) as Branch starts
 * it again; a workspace folder given as data stays allowed.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { launchFingerprint } from "../dist/mcp-own-servers.js";
import { workspaceRefusal } from "../dist/mcp-workspace-guard.js";
import { inWorkspace } from "../dist/integrations/default-shell.js";

const notesServer = resolve("dist/examples/mcp-notes-server.js");

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-guardshapes-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), web: { allowPrivateAddresses: true } });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  await mkdir(app.runtime.workspace, { recursive: true });
  return { app, root, workspace: app.runtime.workspace, ...server };
}
const api = (url, token, path, body) => fetch(`${url}${path}`, {
  method: "POST", headers: { authorization: `Bearer ${token}`, origin: url, "content-type": "application/json" }, body: JSON.stringify(body),
}).then(async (response) => {
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? "request failed");
  return data;
});
const toolsOf = (app, id) => app.registry.names().filter((name) => name.startsWith(`mcp.${id}.`));
const stdio = (command, args, cwd) => ({ transport: "stdio", command, args, envKeys: [], ...(cwd ? { cwd } : {}) });

/** A workspace script that only leaves a marker if it ever runs; each launch line runs the notes server itself. */
async function plant(workspace, marker) {
  const script = join(workspace, "srv.mjs");
  await writeFile(script, `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "ran");\n`);
  return script;
}

/**
 * Refused at add (nothing saved), and, saved before this check with the owner's yes to this exact launch: refused by the
 * switch (no question asked) and, when `asBranchStarts`, not started as Branch starts.
 */
async function refusedEverywhere({ app, url, token }, probe, said, asBranchStarts) {
  await assert.rejects(api(url, token, "/api/mcp/servers", { name: "Probe", server: probe }), said, "refused when added");
  assert.deepEqual(app.ownMcp.saved(), [], "nothing is saved");
  const entry = { id: "probe", name: "Probe", server: probe, on: asBranchStarts, approved: launchFingerprint(probe), tools: [], version: null, hidden: [], addedAt: new Date().toISOString() };
  app.store.save("settings", app.runtime.owner, "mcp-own-servers", { servers: [entry] });
  if (asBranchStarts) {
    await app.ownMcp.startSaved([]);
    assert.equal(toolsOf(app, "probe").length, 0, "not started as Branch starts");
    assert.equal(app.ownMcp.saved()[0].on, false);
    assert.match(app.ownMcp.list(true).servers[0].error, said);
  }
  await assert.rejects(api(url, token, "/api/mcp/servers/probe/start", {}), said, "refused by the switch");
  assert.equal(app.runtime.approvals.waiting().length, 0, "and no question was asked");
  app.store.save("settings", app.runtime.owner, "mcp-own-servers", { servers: [] });
}

/* Shape 1. Mutation: in asPath (src/mcp-workspace-guard.ts), drop the file: branch so every text is resolved as a path;
   the add is then accepted and, as Branch starts, the workspace script runs and writes the marker. */
test("a workspace file named by a file: URL is refused, as --import <url> and --import=<url>", async (t) => {
  const f = await fixture(t);
  const marker = join(f.root, "file-url-ran.txt"), url = pathToFileURL(await plant(f.workspace, marker)).href;
  await refusedEverywhere(f, stdio(process.execPath, ["--import", url, notesServer]), /srv\.mjs, a file inside the workspace/, true);
  await refusedEverywhere(f, stdio(process.execPath, [`--import=${url}`, notesServer]), /srv\.mjs, a file inside the workspace/, true);
  assert.equal(existsSync(marker), false, "the workspace script never ran");
});

/* Shape 2. Mutation: in launchRefusal, drop `...inlineCode(name, args)` from the code check; node's -e then imports the
   workspace script as Branch starts (the marker is written) and the python launch is saved. */
test("inline code that names a workspace path is refused: node -e / --eval / -p, python -c", async (t) => {
  const f = await fixture(t);
  const marker = join(f.root, "inline-ran.txt"), script = await plant(f.workspace, marker);
  const load = `import(${JSON.stringify(pathToFileURL(script).href)}).then(() => import(${JSON.stringify(pathToFileURL(notesServer).href)}))`;
  const said = /code that names a place inside the workspace/;
  await refusedEverywhere(f, stdio(process.execPath, ["-e", load]), said, true);
  await refusedEverywhere(f, stdio(process.execPath, [`--eval=${load}`]), said, true);
  assert.equal(existsSync(marker), false, "the workspace script never ran");
  // Written with the other slash and case, and relative to the folder it starts in.
  const other = process.platform === "win32" ? script.replace(/\\/g, "/").toUpperCase() : script;
  await refusedEverywhere(f, stdio("node", ["-p", `require(${JSON.stringify(other)})`]), said, false);
  await refusedEverywhere(f, stdio("node", ["-e", "import('./workspace/srv.mjs')"], f.root), said, false);
  await refusedEverywhere(f, stdio("python", ["-c", `exec(open(${JSON.stringify(script)}).read())`]), said, false);
});

/* Shape 3. Mutation: delete the `packageSources(name, args).some(names)` line in launchRefusal; every one of these is
   then saved. Checked by the refusal only: nothing here is started, so no package is fetched. */
test("a package runner told to take its package from a workspace folder is refused", async (t) => {
  const f = await fixture(t);
  const pkg = join(f.workspace, "pkg");
  await mkdir(pkg);
  await writeFile(join(pkg, "package.json"), JSON.stringify({ name: "srv", bin: "index.js" }));
  const said = /take its package from inside the workspace/;
  for (const probe of [
    stdio("npx", [`--package=${pkg}`, "srv"]),
    stdio("npx", ["srv", "--prefix", pkg]),
    stdio("uvx", [`--from=${pkg}`, "srv"]),
    stdio("uv", ["run", "--with", pkg, "srv"]),
    stdio("pip", ["install", "-e", pkg]),
    stdio("pip", ["install", `--editable=${pkg}`]),
    stdio("cmd", ["/c", "npx", `--package=${pkg}`, "srv"]),
  ]) await refusedEverywhere(f, probe, said, false);
});

/* The review's follow-up shapes. Each path below that only the rule under test can catch is one a task could write later
   (it does not exist when the server is added), so no other rule refuses it by finding the file. */
const later = (workspace, name) => join(workspace, "later", name);
/** How WSL writes a Windows path (`/mnt/c/…`); elsewhere the path as it is. */
const asWsl = (path) => (process.platform === "win32" ? `/mnt/${path[0].toLowerCase()}${path.slice(2).replace(/\\/g, "/")}` : path);
const encoded = (command) => Buffer.from(command, "utf16le").toString("base64");

/* Group 1. Mutation: in launchRefusal, delete the `folderValues(name, args), ...launch.folders` check and the deno
   settings check; every one of these is then saved. Checked by the refusal only (nothing is fetched). */
test("an option that moves a runner into a workspace folder is refused, as --opt=value and --opt value", async (t) => {
  const f = await fixture(t);
  const pkg = join(f.workspace, "pkg");
  await mkdir(pkg);
  const said = /start in a folder inside the workspace/;
  for (const probe of [
    stdio("npm", ["-C", pkg, "exec", "srv"]),
    stdio("npm", ["exec", `--workspace=${pkg}`, "srv"]),
    stdio("pnpm", ["--dir", pkg, "exec", "srv"]),
    stdio("pnpm", [`-C=${pkg}`, "dlx", "srv"]),
    stdio("yarn", ["--cwd", pkg, "srv"]),
    stdio("bun", [`--cwd=${pkg}`, "run", "srv"]),
    stdio("uv", ["--directory", pkg, "run", "srv"]),
    stdio("uvx", [`--project=${pkg}`, "srv"]),
    stdio("pwsh", ["-WorkingDirectory", pkg, "-File", notesServer]),
    stdio("wsl", ["--cd", asWsl(pkg), "--", "node", "srv.mjs"]),
  ]) await refusedEverywhere(f, probe, said, false);
  await refusedEverywhere(f, stdio("deno", ["run", "--config", later(f.workspace, "deno.json"), notesServer]), /deno\.json, a file inside the workspace/, false);
});

/* Group 2. Mutation: in launchRefusal, drop `...launch.texts` from the code check; every one of these is then saved (the
   programs they name do not exist yet, so only the command string gives them away). */
test("a shell command string that names the workspace is refused: bash/sh/zsh -c, PowerShell, cmd /c", async (t) => {
  const f = await fixture(t);
  const script = later(f.workspace, "srv.mjs"), forward = script.replace(/\\/g, "/");
  const said = /code that names a place inside the workspace/;
  for (const probe of [
    stdio("bash", ["-c", `node ${forward}`]),
    stdio("sh", ["-lc", `exec node "${forward}"`]),
    stdio("zsh", ["-c", `node '${script}'`]),
    stdio("powershell", ["-NoProfile", "-Command", `& node '${script}'`]),
    stdio("pwsh", ["-c", `node ${script}`]),
    stdio("powershell", ["-NoProfile", "-EncodedCommand", encoded(`node ${script}`)]),
    stdio("pwsh", ["-enc", encoded(`& node ./workspace/later/srv.mjs`)], f.root),
    stdio("cmd", ["/c", `node ${script}`]),
  ]) await refusedEverywhere(f, probe, said, false);
  // A program at the start of the string that is inside the workspace is refused as a program.
  const bin = join(f.workspace, "bin"), exe = process.platform === "win32" ? ".exe" : "";
  await mkdir(bin);
  await writeFile(join(bin, `planted${exe}`), "", { mode: 0o755 });
  const withPath = f.app.ownMcp.deps.env;
  f.app.ownMcp.deps.env = { ...process.env, PATH: bin, Path: bin };
  await refusedEverywhere(f, stdio("bash", ["-c", "planted --serve"]), /program is inside the workspace/, false);
  f.app.ownMcp.deps.env = withPath;
});

/* Group 3. Mutation: delete the `name === "wsl"` branch of innerOf (src/mcp-launch-shapes.ts); every one of these is
   then saved. */
test("the command after wsl, wsl -- and wsl -e is judged as the program and its arguments", async (t) => {
  const f = await fixture(t);
  const pkg = join(f.workspace, "pkg");
  await mkdir(pkg);
  await refusedEverywhere(f, stdio("wsl", ["-e", "node", asWsl(pkg)]), /the folder pkg, inside the workspace/, false);
  await refusedEverywhere(f, stdio("wsl", ["--", "python3", "-c", `exec(open('${asWsl(later(f.workspace, "srv.py"))}').read())`]),
    /code that names a place inside the workspace/, false);
  await refusedEverywhere(f, stdio("wsl", ["-d", "Ubuntu", "npx", `--package=${asWsl(pkg)}`, "srv"]), /take its package from inside the workspace/, false);
});

/* Group 4. Mutation: delete the `isPython(name)` branch of innerOf (src/mcp-launch-shapes.ts); every one of these is
   then saved. */
test("python -m pip, -m uv and -m pipx are held to the package-folder rules", async (t) => {
  const f = await fixture(t);
  const pkg = join(f.workspace, "pkg");
  await mkdir(pkg);
  const said = /take its package from inside the workspace/;
  for (const probe of [
    stdio("python", ["-m", "pip", "install", "-e", pkg]),
    stdio("py", ["-m", "uv", "run", "--with", pkg, "srv"]),
    stdio("python3", ["-mpipx", "run", `--spec=${pkg}`, "srv"]),
  ]) await refusedEverywhere(f, probe, said, false);
  await refusedEverywhere(f, stdio("python", ["-I", "-m", "uv", "--directory", pkg, "run", "srv"]), /start in a folder inside the workspace/, false);
});

/* Group 5. Mutation: in readNode (src/mcp-launch-shapes.ts), delete `if (!arg.includes("=") && nodeValued.has(arg)) at++;`;
   the node launch is then saved, and as Branch starts it runs the workspace folder (the marker is written). A second
   mutation, deleting `if (!attached) at++;` in readPython, lets the python launch be saved, and this goes red. */
test("a workspace folder run past an option that takes a value first is refused: node -r x <folder>, python -X opt <folder>", async (t) => {
  const f = await fixture(t);
  const folder = join(f.workspace, "srvdir"), marker = join(f.root, "valued-option-ran.txt");
  await mkdir(folder);
  await writeFile(join(folder, "package.json"), JSON.stringify({ type: "module", main: "index.js" }));
  await writeFile(join(folder, "index.js"), `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "ran");\nawait import(${JSON.stringify(pathToFileURL(notesServer).href)});\n`);
  const said = /the folder srvdir, inside the workspace/;
  await refusedEverywhere(f, stdio(process.execPath, ["--title", "branch-probe", folder]), said, true);
  assert.equal(existsSync(marker), false, "the workspace folder's program never ran");
  await refusedEverywhere(f, stdio("node", ["-r", "dotenv/config", folder]), said, false);
  await refusedEverywhere(f, stdio("python", ["-X", "utf8", folder]), said, false);
  await refusedEverywhere(f, stdio("npx", ["--registry", "https://registry.npmjs.org", folder]), said, false);
});

/* Data, not code. Mutation: make launchRefusal run `names` over every argument (not only code, package sources and
   folder options) and this goes red. */
test("a workspace folder given as data is still allowed", async (t) => {
  const { app, url, token, workspace } = await fixture(t);
  const add = (server) => api(url, token, "/api/mcp/servers", { name: "Data", server });
  const saved = await add(stdio(process.execPath, [notesServer, workspace]));
  assert.equal(saved.server.on, false, "saved, off until the owner's yes");
  await add(stdio(process.execPath, [notesServer, `--root=${pathToFileURL(workspace).href}`]));
  await add(stdio(process.execPath, ["--title", "notes", notesServer, workspace]));
  const script = join(tmpdir(), "srv.sh");
  for (const server of [
    stdio("npx", ["-y", "@modelcontextprotocol/server-filesystem", workspace]),
    stdio("cmd", ["/c", "npx", "-y", "@modelcontextprotocol/server-filesystem", workspace]),
    stdio("wsl", ["-e", "npx", "-y", "@modelcontextprotocol/server-filesystem", asWsl(workspace)]),
    stdio("python", ["-m", "mcp_server_filesystem", workspace]),
    stdio("python", ["-X", "utf8", script, workspace]),
    stdio("python", ["-c", "import sys; print(sys.argv)", workspace]),
    stdio("bash", [script, workspace]),
    stdio("pwsh", ["-File", script, workspace]),
    stdio("bash", ["-c", "npx -y some-server"]),
    stdio("uvx", ["--from", "mcp-server-git==1.0", "mcp-server-git", "--repository", workspace]),
    stdio("uv", ["--directory", tmpdir(), "run", "srv", "--root", workspace]),
  ]) assert.equal(workspaceRefusal(server, workspace, process.env), null, `${server.command} ${server.args.join(" ")}`);
});

/* Review 2 of #368: spellings of a workspace path that a shell reads back to the path. As above, each path that only the
   rule under test can catch does not exist yet. */
const slashed = (path) => path.replace(/\\/g, "/");

/* Mutation: in asPath (src/mcp-workspace-guard.ts), drop `?? fromHome(text)`; every one of these is then saved. */
test("a path written from the home folder with ~ is read as the home folder, in a shell string and as an argument", async (t) => {
  const f = await fixture(t);
  const home = (path) => `~/${slashed(relative(homedir(), path))}`;
  const said = /code that names a place inside the workspace/;
  await refusedEverywhere(f, stdio("bash", ["-c", `node ${home(later(f.workspace, "srv.mjs"))}`]), said, false);
  await refusedEverywhere(f, stdio("pwsh", ["-c", `node ${home(later(f.workspace, "srv.mjs")).replace(/\//g, "\\")}`]), said, false);
  const script = await plant(f.workspace, join(f.root, "home-ran.txt"));
  await refusedEverywhere(f, stdio(process.execPath, ["--import", home(script), notesServer]), /srv\.mjs, a file inside the workspace/, false);
});

/* Mutation: make `uncaret` (src/mcp-launch-shapes.ts) return its text unchanged; every one of these is then saved. */
test("cmd's ^ escape inside a path is read the way cmd reads it", async (t) => {
  const f = await fixture(t);
  const caret = (path) => path.replace(/workspace/, "work^space");
  await refusedEverywhere(f, stdio("cmd", ["/c", `node ${caret(later(f.workspace, "srv.mjs"))}`]), /code that names a place inside the workspace/, false);
  const script = await plant(f.workspace, join(f.root, "caret-ran.txt"));
  await refusedEverywhere(f, stdio("cmd", ["/c", "node", caret(script)]), /srv\.mjs, a file inside the workspace/, false);
});

/* Mutation: make `unbacktick` (src/mcp-launch-shapes.ts) return its text unchanged; this is then saved. */
test("PowerShell's backtick escape inside a path is read the way PowerShell reads it", async (t) => {
  const f = await fixture(t);
  const path = later(f.workspace, "srv.mjs").replace(/workspace/, "w`orkspace");
  await refusedEverywhere(f, stdio("pwsh", ["-c", `node ${path}`]), /code that names a place inside the workspace/, false);
});

/* Mutation: in commandLine (src/mcp-launch-shapes.ts), drop `words(read, how === "posix").join(" ")` from the texts kept;
   every one of these is then saved. */
test("a workspace name split by shell quotes or escapes is read whole: work\"sp\"ace, 'wo'rk, w\\ork", async (t) => {
  const f = await fixture(t);
  const path = slashed(later(f.workspace, "srv.mjs"));
  const said = /code that names a place inside the workspace/;
  for (const spelled of [path.replace("workspace", 'work"sp"ace'), path.replace("workspace", "'wo'rkspace"), path.replace("workspace", "w\\orkspace")])
    await refusedEverywhere(f, stdio("bash", ["-c", `node ${spelled}`]), said, false);
  await refusedEverywhere(f, stdio("cmd", ["/c", `node ${later(f.workspace, "srv.mjs").replace("workspace", 'work"sp"ace')}`]), said, false);
});

/* 8.3 short names: paths are compared with links followed (realFolder, src/folder-trust.ts, uses realpathSync.native,
   which on Windows expands a short name). Short names are off on some drives, so the alias is made as a link named like
   one (WORKSP~1 -> workspace), which realpathSync.native resolves the same way; a real short name is tried as well when
   the drive has one. Mutation: in inWorkspace (src/integrations/default-shell.ts), drop the `realFolder` comparison; the
   first unit check then goes red (and, run on their own, the guard checks allow the file and the code through the alias). */
test("a workspace reached by a short name or other alias is still the workspace", async (t) => {
  const f = await fixture(t);
  const alias = join(f.root, "WORKSP~1");
  await symlink(f.workspace, alias, "junction");
  try {
    const script = await plant(f.workspace, join(f.root, "alias-ran.txt"));
    assert.equal(inWorkspace(f.workspace, join(alias, "srv.mjs"), process.platform), true, "an existing file through the alias");
    assert.equal(inWorkspace(f.workspace, join(alias, "later", "srv.mjs"), process.platform), true, "a file not written yet, through the alias");
    assert.equal(inWorkspace(f.workspace, join(f.root, "WORKSP~2", "srv.mjs"), process.platform), false, "a different name is not the workspace");
    await refusedEverywhere(f, stdio(process.execPath, [join(alias, "srv.mjs")]), /srv\.mjs, a file inside the workspace/, false);
    await refusedEverywhere(f, stdio("node", ["-e", `import(${JSON.stringify(slashed(join(alias, "later", "srv.mjs")))})`]),
      /code that names a place inside the workspace/, false);
    await refusedEverywhere(f, stdio("npm", ["-C", alias, "exec", "srv"]), /start in a folder inside the workspace/, false);
    const short = process.platform === "win32" ? execFileSync("cmd", ["/d", "/c", `for %I in ("${script}") do @echo %~sI`], { encoding: "utf8", windowsVerbatimArguments: true }).trim() : script;
    if (short !== script) await refusedEverywhere(f, stdio(process.execPath, [short]), /a file inside the workspace/, false);
  } finally {
    await unlink(alias);
  }
});
