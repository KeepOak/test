import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, cp, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { discardTemp } from "./temp-dir.mjs";
import {
  copyCommand, installedMenuEntry, launcherMarker, launcherScript, performUnixInstall, performUnixUninstall, unixLayout,
} from "../dist/install/unix-install.js";
import { answeredApplications, wantsApplications } from "../dist/install/unix-install-cli.js";
import { LINUX_ICON_SIZES, iconFileName, iconFileSize, iconThemePath } from "../dist/install/unix-icons.js";
import { unixBootstrapperName, unixBootstrapperScript } from "../dist/install/unix-bootstrap.js";
import { unixInstall } from "../dist/install/unix-install-cli.js";
import { quitPath, quitRequest, quitRunning } from "../dist/install/quit.js";
import { manageCommand } from "../dist/install/manage-cli.js";
import { headlessUpdate, releaseRepo } from "../dist/install/headless-update.js";
import { writeRunning } from "../dist/install/running.js";
import { symlink } from "node:fs/promises";
import { releaseAssets } from "../dist/desktop/release-assets.js";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

/**
 * Bucket 22, "Installing it should be boring", and issue #106: macOS and Linux install and remove
 * without questions, and a script can read, close and update an installed Branch. Everything runs in
 * temporary folders with stand-in programs; nothing is installed and no launchd or systemd job is touched.
 */
const run = promisify(execFile);
const posixOnly = process.platform === "win32" && "shell scripts are for macOS and Linux";
const TOKEN = "a".repeat(64);

async function scratch(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-boring-"));
  t.after(() => discardTemp(root));
  return root;
}

/** A pretend unpacked app: a program file that records how it was run, and the app's package.json. */
async function fakeApp(root, platform, version) {
  const app = platform === "darwin" ? join(root, "Branch Agent.app") : join(root, "Branch-Agent-linux-x64");
  const program = platform === "darwin" ? join(app, "Contents", "MacOS", "Branch Agent") : join(app, "branch-agent");
  const resources = platform === "darwin" ? join(app, "Contents", "Resources", "app") : join(app, "resources", "app");
  await mkdir(join(resources, "dist", "install"), { recursive: true });
  await mkdir(join(program, ".."), { recursive: true });
  await writeFile(program, '#!/bin/sh\nprintf "%s\\n" "RUN_AS_NODE=$ELECTRON_RUN_AS_NODE" "DATA=$BRANCH_DATA_DIR" "ROOT=$BRANCH_INSTALL_ROOT" "$@" > "$BRANCH_TEST_RECORD"\n');
  await chmod(program, 0o755);
  await writeFile(join(resources, "package.json"), JSON.stringify({ name: "branch-agent", version }));
  await writeFile(join(resources, "dist", "install", "install-cli.js"), "");
  if (platform === "linux")
    await writeFile(join(app, "branch-agent.desktop"), '[Desktop Entry]\nName=Branch Agent\nX-Branch-Agent-Version=1\nExec="branch-agent" %U\nIcon=branch-agent.png\n');
  return app;
}

const nodeCopy = (from, to) => cp(from, to, { recursive: true, verbatimSymlinks: true });

test("the default folders on macOS and Linux are this person's own", () => {
  const mac = unixLayout("darwin", {}, "/Users/ann");
  assert.equal(mac.installRoot, "/Users/ann/Applications/Branch Agent.app");
  assert.deepEqual(mac.candidates, [mac.installRoot, "/Applications/Branch Agent.app"], "a copy in /Applications is found, not installed over");
  assert.equal(mac.launcher, "/Users/ann/.local/bin/branch");
  assert.equal(mac.dataDir, "/Users/ann/Library/Application Support/Branch Agent/state", "the same folder the app window uses");
  assert.equal(mac.serviceFile, "/Users/ann/Library/LaunchAgents/com.keepoak.branch-agent.plist");
  assert.equal(mac.menuEntry, null);
  const linux = unixLayout("linux", {}, "/home/ann");
  assert.equal(linux.installRoot, "/home/ann/.local/share/branch-agent/app");
  assert.equal(linux.menuEntry, "/home/ann/.local/share/applications/branch-agent.desktop");
  assert.equal(linux.dataDir, "/home/ann/.config/Branch Agent/state");
  assert.equal(linux.serviceFile, "/home/ann/.config/systemd/user/branch-agent.service");
  const xdg = unixLayout("linux", { XDG_DATA_HOME: "/d", XDG_CONFIG_HOME: "/c" }, "/home/ann");
  assert.equal(xdg.installRoot, "/d/branch-agent/app");
  assert.equal(xdg.userDataDir, "/c/Branch Agent");
  assert.deepEqual(copyCommand("darwin", "/a", "/b"), ["/usr/bin/ditto", ["/a", "/b"]], "a Mac bundle is copied the way a signed app needs");
  assert.deepEqual(copyCommand("linux", "/a", "/b"), ["cp", ["-Rp", "/a", "/b"]]);
});

test("the `branch` command runs the app's own engine on the app's own data, and quotes every path", () => {
  const text = launcherScript({ platform: "darwin", installRoot: "/Users/o'k/Applications/Branch Agent.app", dataDir: "/d $HOME", workspace: "/w" });
  assert.ok(text.startsWith(`#!/bin/sh\n${launcherMarker}`));
  assert.match(text, /^exec '\/Users\/o'\\''k\/Applications\/Branch Agent\.app\/Contents\/MacOS\/Branch Agent' '.*\/Contents\/Resources\/app\/dist\/cli\.js' "\$@"$/m);
  assert.match(text, /\|\| BRANCH_DATA_DIR='\/d \$HOME'/, "a dollar sign in a folder name is not expanded");
  assert.match(text, /^ELECTRON_RUN_AS_NODE=1$/m);
  const linux = launcherScript({ platform: "linux", installRoot: "/h/app", dataDir: "/d", workspace: "/w" });
  assert.match(linux, /^exec '\/h\/app\/branch-agent' '\/h\/app\/resources\/app\/dist\/cli\.js' "\$@"$/m);
});

test("the Linux menu entry names the installed files in full, and a folder it cannot quote gets none", () => {
  const text = '[Desktop Entry]\nExec="branch-agent" %U\nIcon=branch-agent.png\n';
  assert.equal(installedMenuEntry(text, "/home/a b/app"), '[Desktop Entry]\nExec="/home/a b/app/branch-agent" %U\nIcon=/home/a b/app/branch-agent.png\n');
  assert.equal(installedMenuEntry(text, '/home/a"b/app'), null);
  assert.equal(installedMenuEntry(text, "/home/$x/app"), null);
});

for (const platform of ["linux", "darwin"]) {
  test(`installing on ${platform}: a fresh copy, the same version linked up again, and a new one keeping the old`, { skip: posixOnly }, async (t) => {
    const root = await scratch(t);
    const layout = unixLayout(platform, {}, join(root, "home"));
    const first = await performUnixInstall({ layout, source: await fakeApp(join(root, "v1"), platform, "1.0.0"), version: "1.0.0", copy: nodeCopy });
    assert.equal(first.installRoot, layout.installRoot);
    assert.equal(first.attached, false);
    assert.equal(first.previousKept, null);
    assert.equal((await stat(layout.launcher)).mode & 0o777, 0o755);
    assert.ok((await stat(layout.dataDir)).isDirectory());
    if (platform === "linux") assert.match(await readFile(layout.menuEntry, "utf8"), new RegExp(`Exec="${layout.installRoot}/branch-agent"`));
    else assert.equal(first.menuEntry, null);

    const again = await performUnixInstall({ layout, source: await fakeApp(join(root, "v1b"), platform, "1.0.0"), version: "1.0.0",
      copy: async () => { throw new Error("an installed copy of the same version is never copied over"); } });
    assert.equal(again.attached, true);

    const second = await performUnixInstall({ layout, source: await fakeApp(join(root, "v2"), platform, "2.0.0"), version: "2.0.0", copy: nodeCopy, menuEntry: false });
    assert.equal(second.previousKept, `${layout.installRoot}.previous`);
    const manifest = platform === "darwin" ? ["Contents", "Resources", "app", "package.json"] : ["resources", "app", "package.json"];
    assert.equal(JSON.parse(await readFile(join(layout.installRoot, ...manifest), "utf8")).version, "2.0.0");
    assert.equal(JSON.parse(await readFile(join(`${layout.installRoot}.previous`, ...manifest), "utf8")).version, "1.0.0");

    // The command really runs the app's runtime on the installed engine, on the app's own data.
    const record = join(root, "record.txt");
    const env = { PATH: process.env.PATH, BRANCH_TEST_RECORD: record };
    await run("/bin/sh", [layout.launcher, "--version", "--json"], { env });
    const lines = (await readFile(record, "utf8")).trim().split("\n");
    assert.deepEqual(lines, ["RUN_AS_NODE=1", `DATA=${layout.dataDir}`, `ROOT=${layout.installRoot}`,
      join(layout.installRoot, ...manifest.slice(0, -1), "dist", "cli.js"), "--version", "--json"]);
    await run("/bin/sh", [layout.launcher], { env: { ...env, BRANCH_DATA_DIR: "/elsewhere" } });
    assert.match(await readFile(record, "utf8"), /^DATA=\/elsewhere$/m, "a folder the person set still wins");
  });
}

test("a custom distribution: an assistant file beside the installer is brought in on a fresh install only", { skip: posixOnly }, async (t) => {
  const root = await scratch(t);
  const layout = unixLayout("linux", {}, join(root, "home"));
  const assistant = join(root, "team.branch-agent");
  await writeFile(assistant, "pretend export");
  const ran = [], lines = [];
  const runBranch = async (launcher, args) => { ran.push([launcher, ...args]); };
  const source = await fakeApp(join(root, "v1"), "linux", "1.0.0");
  await assert.rejects(unixInstall(["--source", source, "--assistant", join(root, "missing")], layout, () => {}, runBranch), /was not found, so nothing was installed/);
  await assert.rejects(stat(layout.launcher), "a wrong file stops the install before anything is copied");
  await unixInstall(["--source", source, "--assistant", assistant], layout, (line) => lines.push(line), runBranch);
  assert.deepEqual(ran, [[layout.launcher, "import-agent", assistant, "--sections", "specialists,procedures,skills", "--shareable-only"]], "a market's rules: no approval rules, model choices or memory");
  assert.match(lines.join("\n"), /Branch Agent 1\.0\.0 is installed in .*The assistant in .* was brought in/s);
  await writeFile(join(layout.dataDir, "branch.sqlite"), "somebody's work");
  await unixInstall(["--source", source, "--assistant", assistant], layout, (line) => lines.push(line), runBranch);
  assert.equal(ran.length, 1, "an assistant that is already set up is never replaced");
  assert.match(lines.join("\n"), /already installed .* linked up again.*already set up on this computer/s);
});

test("a download that is not the app is refused before anything is touched", { skip: posixOnly }, async (t) => {
  const root = await scratch(t);
  const layout = unixLayout("darwin", {}, join(root, "home"));
  await assert.rejects(performUnixInstall({ layout, source: join(root, "Something.app"), version: "1", copy: nodeCopy }), /--source/);
  await mkdir(join(root, "Branch Agent.app"));
  await assert.rejects(performUnixInstall({ layout, source: join(root, "Branch Agent.app"), version: "1", copy: nodeCopy }), /did not contain the app/);
  await assert.rejects(stat(layout.launcher));
});

test("a copy that fails half-way puts the one that was there back", { skip: posixOnly }, async (t) => {
  const root = await scratch(t);
  const layout = unixLayout("linux", {}, join(root, "home"));
  await performUnixInstall({ layout, source: await fakeApp(join(root, "v1"), "linux", "1.0.0"), version: "1.0.0", copy: nodeCopy });
  await assert.rejects(performUnixInstall({ layout, source: await fakeApp(join(root, "v2"), "linux", "2.0.0"), version: "2.0.0",
    copy: async (_from, to) => { await mkdir(to, { recursive: true }); throw new Error("disk full"); } }), /disk full/);
  assert.equal(JSON.parse(await readFile(join(layout.installRoot, "resources", "app", "package.json"), "utf8")).version, "1.0.0");
});

test("removing Branch closes it, takes out its sign-in entry, and keeps the data unless asked", { skip: posixOnly }, async (t) => {
  const root = await scratch(t);
  const layout = unixLayout("linux", {}, join(root, "home"));
  await performUnixInstall({ layout, source: await fakeApp(join(root, "v1"), "linux", "1.0.0"), version: "1.0.0", copy: nodeCopy });
  await performUnixInstall({ layout, source: await fakeApp(join(root, "v2"), "linux", "2.0.0"), version: "2.0.0", copy: nodeCopy });
  await writeFile(join(layout.dataDir, "branch.sqlite"), "work");
  const calls = [];
  const kept = await performUnixUninstall({ layout, stop: async () => { calls.push("stop"); }, removeService: async () => { calls.push("service"); } });
  assert.deepEqual(calls, ["stop", "service"], "Branch is closed before its files go");
  assert.equal(kept.dataKept, layout.userDataDir);
  assert.equal(await readFile(join(layout.dataDir, "branch.sqlite"), "utf8"), "work");
  for (const gone of [layout.installRoot, `${layout.installRoot}.previous`, layout.launcher, layout.menuEntry, join(layout.installRoot, "..")])
    await assert.rejects(stat(gone), `${gone} is gone`);

  // Someone else's `branch` command is left alone, and --delete-data removes the data folder too.
  await mkdir(join(layout.launcher, ".."), { recursive: true });
  await writeFile(layout.launcher, "#!/bin/sh\necho another program\n");
  const deleted = await performUnixUninstall({ layout, deleteData: true, stop: async () => {}, removeService: async () => {} });
  assert.equal(deleted.dataKept, null);
  await assert.rejects(stat(layout.userDataDir));
  assert.match(await readFile(layout.launcher, "utf8"), /another program/);
  await assert.rejects(performUnixUninstall({ layout, stop: async () => { throw new Error("Branch Agent did not close."); }, removeService: async () => {} }), /did not close/);
});

test("`branch uninstall` takes out the sign-in entry in this person's folder only, with the stand-in launchctl", { skip: posixOnly }, async (t) => {
  const root = await scratch(t);
  const layout = unixLayout("darwin", {}, join(root, "home"));
  await mkdir(join(layout.serviceFile, ".."), { recursive: true });
  await writeFile(layout.serviceFile, "<plist/>");
  const ran = [], lines = [];
  const code = await manageCommand(["uninstall"], {
    env: {}, platform: "darwin", version: "1", packageRoot: root, print: (line) => lines.push(line),
    deps: { layout, run: async (file, args) => { ran.push([file, ...args]); return ""; }, quit: { alive: () => false } },
  });
  assert.equal(code, 0);
  assert.equal(ran.length, 1);
  assert.deepEqual(ran[0].slice(0, 2), ["/bin/launchctl", "bootout"]);
  await assert.rejects(stat(layout.serviceFile));
  assert.match(lines.join("\n"), /kept in .*Branch Agent/);
  const windows = [];
  assert.equal(await manageCommand(["uninstall"], { env: {}, platform: "win32", version: "1", packageRoot: root, print: (line) => windows.push(line) }), 1);
  assert.match(windows[0], /Uninstall Branch Agent\.cmd \/quiet/);
});

test("the macOS and Linux installer script picks the download by its full name and checks it", { skip: posixOnly }, async () => {
  const script = unixBootstrapperScript();
  assert.equal(unixBootstrapperName, "install-branch-agent.sh");
  for (const { platform, name } of releaseAssets.filter((asset) => asset.platform !== "win32"))
    assert.ok(script.includes(`ASSET=${name} ;;`), `${platform} gets ${name}`);
  assert.ok(!/curl|wget|https?:/.test(script), "it downloads nothing of its own");
  assert.ok(!/\bread\b/.test(script), "it never asks anything");
  assert.match(script, /does not match its checksum/);
  const syntax = spawnSync("/bin/sh", ["-n"], { input: script });
  assert.equal(syntax.status, 0, String(syntax.stderr));
});

async function macDownload(root, version, { checksum = true } = {}) {
  const folder = join(root, "download");
  const built = join(root, "built");
  await fakeApp(built, "darwin", version);
  await mkdir(folder, { recursive: true });
  const arch = spawnSync("sysctl", ["-n", "hw.optional.arm64"]).stdout.toString().trim() === "1" ? "arm64" : "x64";
  const zip = join(folder, `Branch-Agent-macos-${arch}.zip`);
  await run("/usr/bin/ditto", ["-c", "-k", "--keepParent", join(built, "Branch Agent.app"), zip]);
  const digest = createHash("sha256").update(await readFile(zip)).digest("hex");
  if (checksum) await writeFile(`${zip}.sha256`, `${digest}  ${zip}\n`);
  const script = join(folder, unixBootstrapperName);
  await writeFile(script, unixBootstrapperScript());
  return { folder, zip, script };
}

test("on a Mac the installer script checks, unpacks and hands over to the app's own installer", { skip: process.platform !== "darwin" && "macOS only" }, async (t) => {
  const root = await scratch(t);
  const { zip, script } = await macDownload(root, "3.0.0");
  const record = join(root, "record.txt");
  const env = { PATH: process.env.PATH, HOME: join(root, "home"), TMPDIR: root, BRANCH_TEST_RECORD: record };
  const done = await run("/bin/sh", [script, "--quiet", "--no-menu-entry"], { env });
  assert.equal(done.stdout, "", "--quiet prints nothing");
  const lines = (await readFile(record, "utf8")).trim().split("\n");
  assert.equal(lines[0], "RUN_AS_NODE=1");
  assert.match(lines[3], /\/Branch Agent\.app\/Contents\/Resources\/app\/dist\/install\/install-cli\.js$/);
  assert.equal(lines[4], "install");
  assert.equal(lines[5], "--source");
  assert.match(lines[6], /branch-agent-setup\.[^/]+\/app\/Branch Agent\.app$/);
  assert.deepEqual(lines.slice(7), ["--quiet", "--no-menu-entry"]);

  await writeFile(zip, "tampered");
  await assert.rejects(run("/bin/sh", [script], { env }), (error) => error.code === 1 && /does not match its checksum/.test(error.stderr));
  const missing = await macDownload(join(root, "second"), "3.0.0", { checksum: false });
  await assert.rejects(run("/bin/sh", [missing.script], { env }), (error) => error.code === 1 && /\.sha256 is missing/.test(error.stderr));
  const nothing = await run("/bin/sh", [script, "--uninstall"], { env });
  assert.match(nothing.stdout, /not installed/, "removing what is not there is not an error");
});

// ---------------------------------------------------------------------------------- branch quit

function fakeRequest({ method = "POST", address = "127.0.0.1", token = TOKEN } = {}) {
  return { method, headers: { authorization: `Bearer ${token}` }, socket: { localAddress: address, remoteAddress: address } };
}

test("the engine closes on `branch quit` only for this computer's own key", async (t) => {
  const dataDir = await scratch(t);
  await writeFile(join(dataDir, "session-token"), TOKEN);
  let quits = 0;
  const quit = () => { quits++; };
  assert.equal(quitPath, "/api/deployment/quit");
  await assert.rejects(quitRequest(fakeRequest({ address: "100.64.0.2" }), { dataDir, quit }), /on this computer/);
  await assert.rejects(quitRequest(fakeRequest({ token: "b".repeat(64) }), { dataDir, quit }), /on this computer/);
  await assert.rejects(quitRequest(fakeRequest({ method: "GET" }), { dataDir, quit }), /POST/);
  await assert.rejects(quitRequest(fakeRequest(), { dataDir }), /cannot be closed from outside/);
  const answer = await quitRequest(fakeRequest(), { dataDir, quit });
  assert.equal(answer.closing, true);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(quits, 1, "the answer is sent first, then the launch quits");
});

test("through the real server, `branch quit` reaches the launch's own quit, and a short-lived key cannot", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-boring-"));
  const dataDir = join(root, "data");
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir,
    provider: { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } } });
  let quits = 0, server = null;
  t.after(async () => { await server?.close(); await app.close(); await discardTemp(root); });
  server = await startServer(app, { dataDir, port: 0, presence: "app", quit: () => { quits++; } });
  const post = (base, token) => fetch(`${base}${quitPath}`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
  const short = app.sessionTokens.create(app.runtime.owner, { scope: "run", minutes: 5 }).token;
  const refused = await post(server.url, short);
  assert.notEqual(refused.status, 200, "a short-lived key cannot close Branch");
  assert.match((await refused.json()).error, /short-lived key|holding Branch's own key/);
  const answer = await post(server.url, server.token);
  assert.equal(answer.status, 200);
  assert.equal((await answer.json()).closing, true);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(quits, 1);
  const report = await quitRunning(dataDir, { alive: () => quits < 2, sleep: async () => {}, waitMs: 1000, fetch: async (url, init) => {
    const response = await fetch(url, init);
    await new Promise((resolve) => setTimeout(resolve, 300));
    return response;
  } });
  assert.equal(report.stopped, true, "the same request from `branch quit`, waited out");
  assert.equal(quits, 2);
});

test("`branch quit` asks, waits for the process to go, and falls back to the engine's own stop", async (t) => {
  const dataDir = await scratch(t);
  await writeFile(join(dataDir, "session-token"), TOKEN);
  const quick = { sleep: async () => {}, waitMs: 50 };
  assert.deepEqual(await quitRunning(dataDir, quick), { stopped: true, wasRunning: false, pid: null, message: "Branch Agent is not running." });

  await writeRunning(dataDir, { port: 4321, pid: 999001, url: "http://127.0.0.1:4321", mode: "app", version: "1" });
  let alive = true;
  const asked = [];
  const fetch = async (url, init) => { asked.push([url, init.method, init.headers.authorization]); alive = false; return new Response("{}"); };
  const closed = await quitRunning(dataDir, { ...quick, fetch, alive: () => alive });
  assert.deepEqual(asked, [["http://127.0.0.1:4321/api/deployment/quit", "POST", `Bearer ${TOKEN}`]]);
  assert.deepEqual([closed.stopped, closed.wasRunning, closed.pid], [true, true, 999001]);

  const refused = async () => new Response("{}", { status: 400 });
  const stuck = await quitRunning(dataDir, { ...quick, fetch: refused, alive: () => true, stopEngine: async () => { throw new Error("only for the background engine"); } });
  assert.equal(stuck.stopped, false, "a window that does not close is reported, not ended");
  assert.match(stuck.message, /did not close/);

  await writeRunning(dataDir, { port: 4321, pid: 999001, url: "http://127.0.0.1:4321", mode: "daemon", version: "1" });
  const viaEngine = await quitRunning(dataDir, { ...quick, fetch: refused, alive: () => true,
    stopEngine: async () => ({ pid: 999001, stopped: true, forced: false, message: "" }) });
  assert.equal(viaEngine.stopped, true, "the background engine is stopped its own way when it does not answer");

  await writeRunning(dataDir, { port: 4321, pid: 999001, url: "http://192.168.1.5:4321", mode: "app", version: "1" });
  const far = await quitRunning(dataDir, { ...quick, fetch: async () => { throw new Error("never called for another address"); }, alive: () => true });
  assert.equal(far.stopped, false);
});

// ---------------------------------------------------------------------------------- version and update

test("`branch --version --json` says what is installed, where, and whether it is running", async (t) => {
  const root = await scratch(t);
  const lines = [];
  const context = { env: { BRANCH_DATA_DIR: join(root, "data"), BRANCH_INSTALL_ROOT: "/Apps/Branch Agent.app" }, platform: "darwin",
    version: "9.9.9", packageRoot: root, print: (line) => lines.push(line) };
  assert.equal(await manageCommand(["version", "--json"], context), 0);
  assert.deepEqual(JSON.parse(lines[0]), { version: "9.9.9", path: "/Apps/Branch Agent.app", dataDir: join(root, "data"), running: false, installed: true });
  await mkdir(join(root, "data"));
  await writeRunning(join(root, "data"), { port: 4321, pid: process.pid, url: "http://127.0.0.1:4321", mode: "daemon", version: "9.9.9" });
  await manageCommand(["version", "--json"], context);
  assert.equal(JSON.parse(lines[1]).running, true);
  assert.equal(await manageCommand(["version"], context), null, "plain `version` is unchanged");
  assert.equal(await manageCommand(["update"], { ...context, env: {} }), null, "a copy that was not installed keeps `update` from Git");
  await mkdir(join(root, ".git"));
  assert.equal(await manageCommand(["update", "--yes"], context), null, "a Git checkout keeps its own `update`");
});

test("the real `branch` answers --version --json and quit without opening anything", async (t) => {
  const root = await scratch(t);
  const env = { ...process.env, BRANCH_DATA_DIR: join(root, "data"), BRANCH_WORKSPACE: join(root, "workspace") };
  const version = await run(process.execPath, ["dist/cli.js", "--version", "--json"], { env });
  const info = JSON.parse(version.stdout);
  assert.equal(info.version, JSON.parse(await readFile("package.json", "utf8")).version);
  assert.equal(info.running, false);
  const quit = await run(process.execPath, ["dist/cli.js", "quit"], { env });
  assert.match(quit.stdout, /not running/);
  const help = await run(process.execPath, ["dist/cli.js", "uninstall", "--help"], { env });
  assert.match(help.stdout, /^branch uninstall/);
  await assert.rejects(stat(join(root, "data")), "nothing was created");
});

function releaseServer(archive, digest) {
  const release = {
    tag_name: "v2.0.0", name: "Branch Agent 2.0.0", body: "", published_at: null, html_url: "https://github.com/stabrea/Branch-Agent/releases/v2.0.0",
    assets: [
      { name: "Branch-Agent-linux-x64.tar.gz", browser_download_url: "https://example.test/app.tar.gz", size: archive.length },
      { name: "Branch-Agent-linux-x64.tar.gz.sha256", browser_download_url: "https://example.test/app.sha256", size: 10 },
    ],
  };
  const asked = [];
  const fetch = async (url) => {
    asked.push(url);
    // Before the move the new name has no releases yet, so the lookup falls back to the old one.
    if (url.startsWith("https://api.github.com/repos/KeepOak/")) return new Response("Not Found", { status: 404 });
    if (url.endsWith("/releases/latest")) return Response.json(release);
    if (url.endsWith(".sha256")) return new Response(`${digest}  Branch-Agent-linux-x64.tar.gz\n`);
    return new Response(archive);
  };
  return { fetch, asked };
}

async function updateSetup(t) {
  const root = await scratch(t);
  const archive = Buffer.from("pretend download");
  const digest = createHash("sha256").update(archive).digest("hex");
  const events = [];
  const deps = { lastReleaseWithoutProvenance: "2.0.0",
    scratchDir: join(root, "scratch"),
    running: async () => null,
    extract: async (_file, into) => { await fakeApp(into, "linux", "2.0.0"); },
    backup: async () => { events.push("backup"); },
    quit: async () => { events.push("quit"); return { stopped: true, wasRunning: false, pid: null, message: "" }; },
    runScript: (script, args) => { events.push(["script", script, args]); return 0; },
  };
  const lines = [];
  const input = { installRoot: join(root, "app"), dataDir: join(root, "data"), version: "1.0.0", platform: "linux", arch: "x64",
    yes: true, print: (line) => lines.push(line) };
  await mkdir(input.dataDir, { recursive: true });
  return { root, archive, digest, deps, events, lines, input };
}

test("`branch update --yes` checks the download, keeps a safety copy, closes Branch and swaps with the app's own script", { skip: posixOnly }, async (t) => {
  const s = await updateSetup(t);
  const server = releaseServer(s.archive, s.digest);
  assert.equal(releaseRepo, "KeepOak/Branch-Agent");
  const ipc = await readFile("src/desktop/updater-ipc.ts", "utf8");
  assert.match(ipc, /repo: primaryRepo,/, "the same repository as the Update button");
  assert.equal(await headlessUpdate({ ...s.input, yes: false, deps: { ...s.deps, fetch: server.fetch } }), 0);
  assert.match(s.lines.at(-1), /Version 2\.0\.0 is ready \(you have 1\.0\.0\)\. Run `branch update --yes`/);
  assert.deepEqual(s.events, [], "only checking changes nothing");

  assert.equal(await headlessUpdate({ ...s.input, deps: { ...s.deps, fetch: server.fetch } }), 0);
  assert.deepEqual(server.asked.slice(0, 2), ["https://api.github.com/repos/KeepOak/Branch-Agent/releases/latest",
    "https://api.github.com/repos/stabrea/Branch-Agent/releases/latest"], "the new name first, then the old one it moved from");
  assert.deepEqual(s.events.slice(0, 2), ["backup", "quit"], "the safety copy comes before Branch is closed");
  const [, script, args] = s.events[2];
  assert.equal(args[1], "stay", "nothing was open, so nothing is opened afterwards");
  assert.ok(Number(args[0]) > 0);
  const text = await readFile(script, "utf8");
  assert.ok(text.includes(`TARGET='${s.input.installRoot}'`), "the same hand-over script as the Update button");
  assert.match(s.lines.join("\n"), /Updated Branch Agent from 1\.0\.0 to 2\.0\.0\. The version before is kept beside it\. Log: .*apply-update\.log/);
});

test("`branch update --yes` reopens a window that was open, and refuses a download that does not match", { skip: posixOnly }, async (t) => {
  const s = await updateSetup(t);
  const server = releaseServer(s.archive, s.digest);
  const running = async () => ({ port: 1, pid: 4242, url: "http://127.0.0.1:1", mode: "app", version: "1.0.0", startedAt: new Date().toISOString() });
  const quit = async () => ({ stopped: true, wasRunning: true, pid: 4242, message: "" });
  assert.equal(await headlessUpdate({ ...s.input, deps: { ...s.deps, fetch: server.fetch, running, quit } }), 0);
  assert.deepEqual(s.events.at(-1)[2], ["4242"], "the window comes back after the swap");

  const stubborn = async () => ({ stopped: false, wasRunning: true, pid: 4242, message: "Branch Agent did not close. Quit it from its window or menu, then try again." });
  const beforeStubborn = s.events.length;
  assert.equal(await headlessUpdate({ ...s.input, deps: { ...s.deps, fetch: server.fetch, running, quit: stubborn } }), 1);
  assert.ok(!s.events.slice(beforeStubborn).some((event) => event[0] === "script"), "a Branch that would not close is never ended to make room");
  assert.match(s.lines.at(-1), /did not close.*Nothing was changed/);

  const bad = releaseServer(s.archive, "0".repeat(64));
  const before = s.events.length;
  assert.equal(await headlessUpdate({ ...s.input, deps: { ...s.deps, fetch: bad.fetch } }), 1);
  assert.equal(s.events.length, before, "nothing was copied, closed or swapped");
  assert.match(s.lines.at(-1), /did not match the published checksum/);

  assert.equal(await headlessUpdate({ ...s.input, deps: { ...s.deps, fetch: server.fetch, runScript: () => 1 } }), 1);
  assert.match(s.lines.at(-1), /did not finish, so Branch stays on the version it had/);
  assert.equal(await headlessUpdate({ ...s.input, version: "2.0.0", deps: { ...s.deps, fetch: server.fetch } }), 0);
  assert.match(s.lines.at(-1), /newest version \(2\.0\.0\)/);
  assert.equal(await headlessUpdate({ ...s.input, platform: "win32" }), 1);
  assert.match(s.lines.at(-1), /On Windows, update from the app/);
});

/**
 * mac7/app-icon. What a person gets after downloading: an app macOS will open, in the folder they
 * chose, with the KeepOak mark in every size a menu asks for. Temporary folders and stand-in tools
 * only — no /Applications, no xattr, nothing installed.
 */
const shush = { stop: async () => {}, removeService: async () => {} };

/** A layout whose "shared Applications folder" is inside the temporary folder. */
function sharedLayout(root) {
  const layout = unixLayout("darwin", {}, join(root, "home"));
  const sharedRoot = join(root, "Applications", "Branch Agent.app");
  return { ...layout, sharedRoot, candidates: [layout.installRoot, sharedRoot] };
}

test("the internet mark is taken off the copy the installer made, and off nothing else", { skip: posixOnly }, async (t) => {
  const root = await scratch(t);
  const ran = [];
  const run = async (file, args) => { ran.push([file, args]); return ""; };
  const layout = unixLayout("darwin", {}, join(root, "home"));
  const mac = await performUnixInstall({ layout, source: await fakeApp(join(root, "v1"), "darwin", "1.0.0"), version: "1.0.0", copy: nodeCopy, run,
    clearMark: true });
  assert.equal(mac.quarantineCleared, true);
  assert.deepEqual(ran, [["/usr/bin/xattr", ["-r", "-s", "-d", "com.apple.quarantine", layout.installRoot]]],
    "only the installed bundle, by name, and nothing wider");

  ran.length = 0;
  const linux = unixLayout("linux", {}, join(root, "home2"));
  const other = await performUnixInstall({ layout: linux, source: await fakeApp(join(root, "l1"), "linux", "1.0.0"), version: "1.0.0", copy: nodeCopy, run });
  assert.equal(other.quarantineCleared, false);
  assert.deepEqual(ran, [], "no other system has the idea of an internet mark");
});

test("a copy in the shared Applications folder is updated when this person can write it, and left alone when not", { skip: posixOnly }, async (t) => {
  const root = await scratch(t);
  const layout = sharedLayout(root);
  const manifest = ["Contents", "Resources", "app", "package.json"];
  const version = async () => JSON.parse(await readFile(join(layout.sharedRoot, ...manifest), "utf8")).version;
  await mkdir(join(root, "Applications"), { recursive: true });
  await nodeCopy(await fakeApp(join(root, "v1"), "darwin", "1.0.0"), layout.sharedRoot);

  // Somebody else's copy: linked up and reported at its own version, exactly as before this change.
  const locked = await performUnixInstall({ layout, source: await fakeApp(join(root, "v2"), "darwin", "2.0.0"), version: "2.0.0",
    canWrite: async () => false, copy: async () => { throw new Error("a copy this person cannot write is never written over"); } });
  assert.equal(locked.attached, true);
  assert.equal(locked.installRoot, layout.sharedRoot);
  assert.equal(locked.version, "1.0.0");
  assert.equal(await version(), "1.0.0");

  // A copy this person can write is the installer's own, so an update really lands.
  const updated = await performUnixInstall({ layout, source: await fakeApp(join(root, "v3"), "darwin", "2.0.0"), version: "2.0.0",
    canWrite: async () => true, copy: nodeCopy, run: async () => "" });
  assert.equal(updated.attached, false, "an update that silently does nothing is the thing to avoid");
  assert.equal(updated.version, "2.0.0");
  assert.equal(await version(), "2.0.0");
});

test("asking for the Applications folder moves Branch there, and is dropped when that needs an administrator", { skip: posixOnly }, async (t) => {
  const root = await scratch(t);
  const layout = sharedLayout(root);
  await performUnixInstall({ layout, source: await fakeApp(join(root, "v1"), "darwin", "1.0.0"), version: "1.0.0", copy: nodeCopy, run: async () => "" });
  assert.ok(await stat(layout.installRoot));

  const moved = await performUnixInstall({ layout, source: await fakeApp(join(root, "v2"), "darwin", "1.0.0"), version: "1.0.0",
    applications: true, canWrite: async () => true, copy: nodeCopy, run: async () => "" });
  assert.equal(moved.installRoot, layout.sharedRoot);
  assert.equal(moved.movedFrom, layout.installRoot);
  await assert.rejects(stat(layout.installRoot), "one copy, not two");
  assert.match(await readFile(layout.launcher, "utf8"), new RegExp(layout.sharedRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  const refused = await performUnixInstall({ layout: sharedLayout(join(root, "other")), source: await fakeApp(join(root, "v3"), "darwin", "1.0.0"),
    version: "1.0.0", applications: true, canWrite: async () => false, copy: nodeCopy, run: async () => "" });
  assert.equal(refused.installRoot, sharedLayout(join(root, "other")).installRoot, "it falls back to this person's own folder rather than asking for a password");
});

test("removing Branch takes the shared copy only when this person can write it", { skip: posixOnly }, async (t) => {
  const root = await scratch(t);
  const layout = sharedLayout(root);
  await mkdir(join(root, "Applications"), { recursive: true });
  await nodeCopy(await fakeApp(join(root, "v1"), "darwin", "1.0.0"), layout.sharedRoot);

  const left = await performUnixUninstall({ layout, ...shush, canWrite: async () => false });
  assert.deepEqual(left.left, [layout.sharedRoot]);
  assert.ok(await stat(layout.sharedRoot));

  const gone = await performUnixUninstall({ layout, ...shush, canWrite: async () => true });
  assert.ok(gone.removed.includes(layout.sharedRoot));
  await assert.rejects(stat(layout.sharedRoot));
});

test("the Linux download's icon sizes go into this person's icon theme, and go again when Branch does", { skip: posixOnly }, async (t) => {
  const root = await scratch(t);
  const layout = unixLayout("linux", {}, join(root, "home"));
  const source = await fakeApp(join(root, "v1"), "linux", "1.0.0");
  await mkdir(join(source, "icons"), { recursive: true });
  for (const size of LINUX_ICON_SIZES) await writeFile(join(source, "icons", iconFileName("branch-agent", size)), `mark ${size}`);
  await writeFile(join(source, "icons", "not-ours.png"), "ignored");

  const report = await performUnixInstall({ layout, source, version: "1.0.0", copy: nodeCopy });
  assert.deepEqual(report.icons, LINUX_ICON_SIZES.map((size) => join(layout.iconTheme, `${size}x${size}`, "apps", "branch-agent.png")).sort());
  assert.equal(await readFile(join(layout.iconTheme, "48x48", "apps", "branch-agent.png"), "utf8"), "mark 48");
  assert.match(await readFile(layout.menuEntry, "utf8"), /^Icon=branch-agent$/m, "the theme's name, so each menu draws the size made for it");

  const removed = await performUnixUninstall({ layout, ...shush });
  for (const icon of report.icons) assert.ok(removed.removed.includes(icon), `${icon} goes with the app`);
});

test("the Applications question is put only to a person at a terminal, and an answer given in advance wins", async () => {
  const never = async () => { throw new Error("nobody should be asked here"); };
  assert.equal(answeredApplications([]), null);
  assert.equal(await wantsApplications(["--applications"], "darwin", false, never), true, "an answer on the command line needs no terminal");
  assert.equal(await wantsApplications(["--no-applications", "--applications"], "darwin", true, never), false, "no wins, so a script cannot be talked into it");
  assert.equal(await wantsApplications(["--quiet"], "darwin", true, never), false);
  assert.equal(await wantsApplications([], "darwin", false, never), false, "no terminal, no question");
  assert.equal(await wantsApplications([], "linux", true, never), false, "only macOS has an Applications folder");
  for (const [reply, wanted] of [["", true], ["y", true], ["Yes", true], ["n", false], ["no", false]])
    assert.equal(await wantsApplications([], "darwin", true, async () => reply), wanted, `"${reply}"`);
  const asked = [];
  await wantsApplications([], "darwin", true, async (question) => { asked.push(question); return "n"; });
  assert.match(asked[0], /Applications folder/);
  assert.match(asked[0], /came from the internet until something takes that mark off/, "it says in plain words why macOS is asking");
});

test("the icon sizes the Linux theme asks for are named the same way by the packager and the installer", () => {
  assert.deepEqual(LINUX_ICON_SIZES, [16, 32, 48, 64, 128, 256, 512]);
  assert.equal(iconFileName("branch-agent", 48), "branch-agent-48.png");
  assert.equal(iconFileSize("branch-agent", "branch-agent-48.png"), 48);
  assert.equal(iconFileSize("branch-agent", "branch-agent-47.png"), null, "a size no theme asks for is not ours");
  assert.equal(iconFileSize("branch-agent", "evil.png"), null);
  assert.equal(iconFileSize("branch-agent", "../../../etc/branch-agent-48.png"), null, "a name that climbs out is not ours");
  assert.equal(iconThemePath("/t/hicolor", "branch-agent", 256), "/t/hicolor/256x256/apps/branch-agent.png");
});

// ---- integrate/mac-fixes: the adversarial pass over mac7/app-icon ----
// Clearing macOS's "came from the internet" mark is a security decision, so it happens only when the
// person said yes, only to the copy just made, and never through a link out of that copy. A shared
// Applications folder is writable by every administrator on the Mac, so a writable folder does not
// make the copy in it this person's: it has to be a real folder, holding Branch, that they own.

test("the internet mark stays on unless the person said yes, and a note about it is only ever true", { skip: posixOnly }, async (t) => {
  const root = await scratch(t);
  const ran = [];
  const run = async (file, args) => { ran.push([file, args]); return ""; };
  const layout = unixLayout("darwin", {}, join(root, "home"));
  const silent = await performUnixInstall({ layout, source: await fakeApp(join(root, "v1"), "darwin", "1.0.0"), version: "1.0.0", copy: nodeCopy, run });
  assert.equal(silent.quarantineCleared, false, "nobody said yes, so nothing is cleared");
  assert.deepEqual(ran, []);

  const again = await performUnixInstall({ layout, source: await fakeApp(join(root, "v1b"), "darwin", "1.0.0"), version: "1.0.0", copy: nodeCopy, run,
    clearMark: true });
  assert.equal(again.attached, true);
  assert.equal(again.quarantineCleared, false, "a copy the installer did not just make is not touched");
  assert.deepEqual(ran, []);

  const failed = await performUnixInstall({ layout, source: await fakeApp(join(root, "v2"), "darwin", "2.0.0"), version: "2.0.0", copy: nodeCopy,
    clearMark: true, run: async () => { throw new Error("/usr/bin/xattr failed"); } });
  assert.equal(failed.attached, false);
  assert.equal(failed.quarantineCleared, false, "xattr failed, so the installer must not say the mark is gone");
});

test("a person who is not asked never has the mark cleared, and one who answers on the command line does", { skip: process.platform !== "darwin" && "real xattr and ditto" }, async (t) => {
  const root = await scratch(t);
  const layout = sharedLayout(root);
  const never = async () => { throw new Error("nobody should be asked here"); };
  const lines = [];
  // The test runner has no terminal on stdin, which is exactly a script running the installer.
  await unixInstall(["--source", await fakeApp(join(root, "v1"), "darwin", "1.0.0")], layout, (line) => lines.push(line), undefined, never);
  assert.ok(!lines.some((line) => /taken off/.test(line)), lines.join("\n"));
  assert.ok(lines.some((line) => /mark was left on/.test(line) && /--applications/.test(line)),
    `a script's install says the mark is still there and how to take it off:\n${lines.join("\n")}`);
  await mkdir(join(root, "Applications"), { recursive: true });
  const yes = [];
  await unixInstall(["--source", await fakeApp(join(root, "v2"), "darwin", "2.0.0"), "--applications"], layout, (line) => yes.push(line), undefined, never);
  assert.ok(yes.some((line) => /taken off this copy/.test(line)), yes.join("\n"));
});

test("on a real Mac the mark comes off the installed app and off nothing a link inside it points at", { skip: process.platform !== "darwin" && "real xattr" }, async (t) => {
  const root = await scratch(t);
  const mark = (path) => spawnSync("/usr/bin/xattr", ["-s", "-w", "com.apple.quarantine", "0081;00000000;Test;", path]).status;
  const marked = (path) => spawnSync("/usr/bin/xattr", ["-s", "-p", "com.apple.quarantine", path]).status === 0;
  const outside = join(root, "outside");
  await mkdir(join(outside, "folder"), { recursive: true });
  await writeFile(join(outside, "file"), "not Branch's");
  for (const path of [join(outside, "file"), join(outside, "folder")]) assert.equal(mark(path), 0);
  const source = await fakeApp(join(root, "v1"), "darwin", "1.0.0");
  await symlink(join(outside, "file"), join(source, "Contents", "Resources", "planted-file"));
  await symlink(join(outside, "folder"), join(source, "Contents", "Resources", "planted-folder"));
  const layout = unixLayout("darwin", {}, join(root, "home"));
  const program = join(layout.installRoot, "Contents", "MacOS", "Branch Agent");
  const copy = async (from, to) => { await nodeCopy(from, to); assert.equal(mark(program), 0); assert.equal(mark(to), 0); };
  const report = await performUnixInstall({ layout, source, version: "1.0.0", copy, clearMark: true });
  assert.equal(report.quarantineCleared, true);
  assert.equal(marked(program), false, "the app's own files are cleared");
  assert.equal(marked(layout.installRoot), false);
  assert.equal(marked(join(outside, "file")), true, "a file a link points at is somebody else's and keeps its mark");
  assert.equal(marked(join(outside, "folder")), true);
});

test("another person's copy in a writable shared folder is linked up, never replaced and never removed", { skip: posixOnly }, async (t) => {
  const root = await scratch(t);
  const layout = sharedLayout(root);
  await mkdir(join(root, "Applications"), { recursive: true });
  await nodeCopy(await fakeApp(join(root, "v1"), "darwin", "1.0.0"), layout.sharedRoot);
  const someoneElse = process.getuid() + 1;
  const copy = async () => { throw new Error("another person's copy is never written over"); };
  const ran = [];
  const report = await performUnixInstall({ layout, source: await fakeApp(join(root, "v2"), "darwin", "2.0.0"), version: "2.0.0",
    canWrite: async () => true, uid: someoneElse, copy, run: async (file, args) => { ran.push([file, args]); return ""; }, clearMark: true });
  assert.equal(report.attached, true);
  assert.equal(report.version, "1.0.0");
  assert.equal(report.quarantineCleared, false);
  assert.deepEqual(ran, []);
  const moved = await performUnixInstall({ layout, source: await fakeApp(join(root, "v3"), "darwin", "2.0.0"), version: "2.0.0",
    canWrite: async () => true, uid: someoneElse, copy, run: async () => "", applications: true });
  assert.equal(moved.attached, true, "asking for Applications does not make another person's copy this person's");
  assert.equal(moved.version, "1.0.0", "and the version really there is the one reported");
  const left = await performUnixUninstall({ layout, ...shush, canWrite: async () => true, uid: someoneElse });
  assert.deepEqual(left.left, [layout.sharedRoot]);
  assert.ok(await stat(join(layout.sharedRoot, "Contents", "MacOS", "Branch Agent")), "it is still there");
});

test("a different program, or a link, under Branch's name in Applications is never moved aside or written through", { skip: posixOnly }, async (t) => {
  const root = await scratch(t);
  const layout = sharedLayout(root);
  await mkdir(layout.sharedRoot, { recursive: true });
  await writeFile(join(layout.sharedRoot, "somebody-elses.txt"), "keep me");
  const report = await performUnixInstall({ layout, source: await fakeApp(join(root, "v1"), "darwin", "1.0.0"), version: "1.0.0",
    canWrite: async () => true, copy: nodeCopy, run: async () => "", applications: true });
  assert.equal(report.installRoot, layout.installRoot);
  assert.equal(await readFile(join(layout.sharedRoot, "somebody-elses.txt"), "utf8"), "keep me");
  await assert.rejects(stat(`${layout.sharedRoot}.previous`), "nothing of theirs is put where the next install deletes it");

  const linked = sharedLayout(join(root, "linked"));
  const elsewhere = await fakeApp(join(root, "elsewhere"), "darwin", "1.0.0");
  await mkdir(join(root, "linked", "Applications"), { recursive: true });
  await symlink(elsewhere, linked.sharedRoot);
  const through = await performUnixInstall({ layout: linked, source: await fakeApp(join(root, "v2"), "darwin", "2.0.0"), version: "2.0.0",
    canWrite: async () => true, copy: async () => { throw new Error("never through a link"); }, run: async () => "" });
  assert.equal(through.attached, true);
  const gone = await performUnixUninstall({ layout: linked, ...shush, canWrite: async () => true });
  assert.ok(await stat(join(elsewhere, "Contents", "MacOS", "Branch Agent")), "removing never follows the link");
  assert.ok(!gone.removed.includes(linked.sharedRoot));
});

test("moving into Applications refuses while Branch is running, before anything is changed", { skip: posixOnly }, async (t) => {
  const root = await scratch(t);
  const layout = sharedLayout(root);
  await performUnixInstall({ layout, source: await fakeApp(join(root, "v1"), "darwin", "1.0.0"), version: "1.0.0", copy: nodeCopy, run: async () => "" });
  await mkdir(join(root, "Applications"), { recursive: true });
  await assert.rejects(performUnixInstall({ layout, source: await fakeApp(join(root, "v2"), "darwin", "1.0.0"), version: "1.0.0",
    applications: true, canWrite: async () => true, copy: nodeCopy, run: async () => "", running: async () => true }), /running/);
  assert.ok(await stat(join(layout.installRoot, "Contents", "MacOS", "Branch Agent")), "the running copy is still there");
  await assert.rejects(stat(layout.sharedRoot));
});
