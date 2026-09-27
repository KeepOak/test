import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, stat, symlink, writeFile } from "node:fs/promises";
import { cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { discardTemp } from "./temp-dir.mjs";
import { launcherMarker, performUnixInstall, performUnixUninstall, unixLayout } from "../dist/install/unix-install.js";
import { unixBootstrapperScript } from "../dist/install/unix-bootstrap.js";
import { quitPath, quitRequest } from "../dist/install/quit.js";
import { headlessUpdate } from "../dist/install/headless-update.js";
import { exportAgent, openAgent } from "../dist/agent-export.js";
import { bringInShareable } from "../dist/interop/agent-market.js";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { zipWrite } from "../dist/skill-package.js";

/**
 * Integration review of bucket 22 (adversarial pass): what the installer, `branch uninstall`,
 * `branch quit`, `branch update --yes` and `--assistant` must refuse. Temporary folders and stand-in
 * programs only; nothing is installed, closed or updated on this computer.
 */
const run = promisify(execFile);
const posixOnly = process.platform === "win32" && "shell scripts are for macOS and Linux";
const TOKEN = "c".repeat(64);
const nodeCopy = (from, to) => cp(from, to, { recursive: true, verbatimSymlinks: true });
const exists = (path) => lstat(path).then(() => true, () => false);

async function scratch(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-boring-int-"));
  t.after(() => discardTemp(root));
  return root;
}

async function fakeApp(root, platform, version) {
  const app = platform === "darwin" ? join(root, "Branch Agent.app") : join(root, "Branch-Agent-linux-x64");
  const program = platform === "darwin" ? join(app, "Contents", "MacOS", "Branch Agent") : join(app, "branch-agent");
  const resources = platform === "darwin" ? join(app, "Contents", "Resources", "app") : join(app, "resources", "app");
  await mkdir(join(resources, "dist", "install"), { recursive: true });
  await mkdir(join(program, ".."), { recursive: true });
  await writeFile(program, '#!/bin/sh\nprintf "%s\\n" "$@" > "$BRANCH_TEST_RECORD"\n');
  await chmod(program, 0o755);
  await writeFile(join(resources, "package.json"), JSON.stringify({ name: "branch-agent", version }));
  await writeFile(join(resources, "dist", "install", "install-cli.js"), "");
  if (platform === "linux")
    await writeFile(join(app, "branch-agent.desktop"), '[Desktop Entry]\nName=Branch Agent\nX-Branch-Agent-Version=1\nExec="branch-agent" %U\nIcon=branch-agent.png\n');
  return app;
}

// ------------------------------------------------------------------------------------ installing

test("installing never writes over another program's `branch` command, or through a link", { skip: posixOnly }, async (t) => {
  const root = await scratch(t);
  const layout = unixLayout("linux", {}, join(root, "home"));
  await mkdir(join(layout.launcher, ".."), { recursive: true });
  await writeFile(layout.launcher, "#!/bin/sh\necho another program called branch\n");
  const source = await fakeApp(join(root, "v1"), "linux", "1.0.0");
  await assert.rejects(performUnixInstall({ layout, source, version: "1.0.0", copy: nodeCopy }), /already a different `branch` command/);
  assert.match(await readFile(layout.launcher, "utf8"), /another program/);
  assert.equal(await exists(layout.installRoot), false, "refused before anything was copied");

  const outside = join(root, "outside.txt");
  await writeFile(outside, `${launcherMarker}\nnot to be touched\n`);
  await discardTemp(layout.launcher);
  await symlink(outside, layout.launcher);
  await assert.rejects(performUnixInstall({ layout, source, version: "1.0.0", copy: nodeCopy }), /already a different `branch` command/);
  assert.match(await readFile(outside, "utf8"), /not to be touched/, "a link is never written through");

  await discardTemp(layout.launcher);
  await mkdir(join(layout.menuEntry, ".."), { recursive: true });
  await writeFile(layout.menuEntry, "[Desktop Entry]\nName=Someone else\n");
  const report = await performUnixInstall({ layout, source, version: "1.0.0", copy: nodeCopy });
  assert.equal(report.menuEntry, null, "someone else's menu entry is left, and the install still works");
  assert.match(await readFile(layout.menuEntry, "utf8"), /Someone else/);
  assert.ok((await lstat(layout.launcher)).isFile());
  // Installing again replaces the installer's own command.
  const again = await performUnixInstall({ layout, source, version: "1.0.0", copy: nodeCopy });
  assert.equal(again.attached, true);
});

/**
 * mac7/app-icon changed one half of this rule. A Mac copy in the shared Applications folder that this
 * person cannot write without an administrator may be somebody else's: it is linked up, never written
 * to and never removed, exactly as before. One this person can write is the installer's own — since
 * `--applications` now puts it there — so an update really lands on it instead of quietly doing
 * nothing, and `uninstall` takes it away again.
 */
test("a Mac copy in the shared Applications folder is linked up when it needs an administrator, and updated when it does not", { skip: posixOnly }, async (t) => {
  const root = await scratch(t);
  const base = unixLayout("darwin", {}, join(root, "home"));
  const shared = join(root, "Applications", "Branch Agent.app");
  const layout = { ...base, sharedRoot: shared, candidates: [base.installRoot, shared] };
  await fakeApp(join(root, "Applications"), "darwin", "1.0.0");
  const copy = async () => { throw new Error("nothing may be copied over the shared copy"); };
  const report = await performUnixInstall({ layout, source: await fakeApp(join(root, "v2"), "darwin", "2.0.0"), version: "2.0.0", copy,
    canWrite: async () => false });
  assert.equal(report.installRoot, shared);
  assert.equal(report.attached, true);
  assert.equal(report.version, "1.0.0", "the version that is really there is reported");
  assert.equal(report.previousKept, null);
  assert.equal(report.quarantineCleared, false, "a copy that is not the installer's is not touched at all");
  assert.equal(await exists(`${shared}.previous`), false);
  assert.ok((await readFile(layout.launcher, "utf8")).includes("Applications/Branch Agent.app/Contents/MacOS"));

  const left = await performUnixUninstall({ layout, stop: async () => {}, removeService: async () => {}, canWrite: async () => false });
  assert.ok(await exists(join(shared, "Contents", "MacOS", "Branch Agent")), "a copy the installer did not put there is left");
  assert.deepEqual(left.left, [shared]);
  assert.deepEqual(left.removed, [layout.launcher]);

  // The same folder, writable: the installer's own, so the update lands and removing takes it away.
  const updated = await performUnixInstall({ layout, source: await fakeApp(join(root, "v3"), "darwin", "2.0.0"), version: "2.0.0",
    copy: (from, to) => cp(from, to, { recursive: true, verbatimSymlinks: true }), run: async () => "", canWrite: async () => true });
  assert.equal(updated.installRoot, shared);
  assert.equal(updated.attached, false, "an update that silently does nothing is the thing to avoid");
  assert.equal(updated.version, "2.0.0");
  const gone = await performUnixUninstall({ layout, stop: async () => {}, removeService: async () => {}, canWrite: async () => true });
  assert.deepEqual(gone.left, []);
  assert.ok(gone.removed.includes(shared));
  assert.equal(await exists(shared), false);
});

test("removing Branch removes links as links and never follows them out of its folders", { skip: posixOnly }, async (t) => {
  const root = await scratch(t);
  const layout = unixLayout("linux", {}, join(root, "home"));
  const precious = join(root, "precious");
  await mkdir(precious);
  await writeFile(join(precious, "keep.txt"), "mine");
  await mkdir(join(layout.installRoot, ".."), { recursive: true });
  await symlink(precious, layout.installRoot);
  await symlink(precious, `${layout.installRoot}.previous`);
  const markedOutside = join(root, "marked.txt");
  await writeFile(markedOutside, `${launcherMarker}\n`);
  await mkdir(join(layout.launcher, ".."), { recursive: true });
  await symlink(markedOutside, layout.launcher);
  const report = await performUnixUninstall({ layout, deleteData: false, stop: async () => {}, removeService: async () => {} });
  assert.equal(await readFile(join(precious, "keep.txt"), "utf8"), "mine");
  assert.equal(await exists(layout.installRoot), false, "the link itself went");
  assert.equal(await readlink(layout.launcher), markedOutside, "a linked `branch` is not the installer's file and stays");
  assert.ok(await exists(markedOutside));
  assert.ok(!report.removed.includes(layout.launcher));
  assert.equal(report.dataKept, layout.userDataDir);
});

// ------------------------------------------------------------------------------------ the script

const zipMaker = [
  "import sys, zipfile",
  "z = zipfile.ZipFile(sys.argv[1], 'w')",
  "for spec in sys.argv[2:]:",
  "    name, _, link = spec.partition('=>')",
  "    info = zipfile.ZipInfo(name)",
  "    if link: info.external_attr = 0xA1FF << 16",
  "    z.writestr(info, link or 'x')",
  "z.close()",
].join("\n");

async function macDownload(root, { entries, links = false } = {}) {
  const folder = join(root, "download");
  await mkdir(folder, { recursive: true });
  const arch = spawnSync("sysctl", ["-n", "hw.optional.arm64"]).stdout.toString().trim() === "1" ? "arm64" : "x64";
  const zip = join(folder, `Branch-Agent-macos-${arch}.zip`);
  if (entries) {
    const made = spawnSync("python3", ["-c", zipMaker, zip, ...entries]);
    assert.equal(made.status, 0, String(made.stderr));
  } else {
    const built = join(root, "built");
    await fakeApp(built, "darwin", "3.0.0");
    // A link of the app's own, like Versions/Current in a framework, is allowed.
    if (links) await symlink("../MacOS", join(built, "Branch Agent.app", "Contents", "Current"));
    await run("/usr/bin/ditto", ["-c", "-k", "--keepParent", join(built, "Branch Agent.app"), zip]);
  }
  const digest = createHash("sha256").update(await readFile(zip)).digest("hex");
  await writeFile(`${zip}.sha256`, `${digest}  ${zip}\n`);
  const script = join(folder, "install-branch-agent.sh");
  await writeFile(script, unixBootstrapperScript());
  return { folder, zip, script, digest };
}

const failsWith = (pattern) => (error) => error.code === 1 && pattern.test(error.stderr);

test("the script uninstalls only through the installer's own command, and needs a home folder", { skip: posixOnly }, async (t) => {
  const root = await scratch(t);
  const home = join(root, "home");
  const record = join(root, "ran.txt");
  await mkdir(join(home, ".local", "bin"), { recursive: true });
  await writeFile(join(home, ".local", "bin", "branch"), `#!/bin/sh\necho ran "$@" > '${record}'\n`);
  await chmod(join(home, ".local", "bin", "branch"), 0o755);
  const script = join(root, "install-branch-agent.sh");
  await writeFile(script, unixBootstrapperScript());
  await assert.rejects(run("/bin/sh", [script, "--uninstall", "--delete-data"], { env: { PATH: process.env.PATH, HOME: home } }),
    failsWith(/is not Branch Agent's command, so nothing was removed/));
  assert.equal(await exists(record), false, "another program called branch is never run");

  await writeFile(join(home, ".local", "bin", "branch"), `#!/bin/sh\n${launcherMarker}\necho ran "$@" > '${record}'\n`);
  await run("/bin/sh", [script, "--uninstall", "--delete-data"], { env: { PATH: process.env.PATH, HOME: home } });
  assert.equal((await readFile(record, "utf8")).trim(), "ran uninstall --delete-data");

  await assert.rejects(run("/bin/sh", [script], { env: { PATH: process.env.PATH } }), failsWith(/HOME is not set/));
  await assert.rejects(run("/bin/sh", [script], { env: { PATH: process.env.PATH, HOME: "relative/home" } }), failsWith(/HOME is not set/));
});

test("the script ignores a planted shasum, a checksum file that is not one, and names outside the folder", { skip: process.platform !== "darwin" && "macOS only" }, async (t) => {
  const root = await scratch(t);
  const env = { HOME: join(root, "home"), TMPDIR: root, BRANCH_TEST_RECORD: join(root, "record.txt") };
  await mkdir(env.HOME);
  const { zip, script, digest } = await macDownload(root);
  await writeFile(zip, "tampered");
  const planted = join(root, "planted");
  await mkdir(planted);
  await writeFile(join(planted, "shasum"), `#!/bin/sh\necho ${digest}\n`);
  await chmod(join(planted, "shasum"), 0o755);
  await assert.rejects(run("/bin/sh", [script], { env: { ...env, PATH: `${planted}:${process.env.PATH}` } }),
    failsWith(/does not match its checksum/), "the system's own shasum is used, whatever PATH says");
  assert.equal(await exists(env.BRANCH_TEST_RECORD), false);

  await writeFile(`${zip}.sha256`, "-  whatever\n");
  await assert.rejects(run("/bin/sh", [script], { env: { ...env, PATH: process.env.PATH } }), failsWith(/is not a checksum/));

  const evil = await macDownload(join(root, "evil"), { entries: ["Branch Agent.app/Contents/../../../../escaped.txt"] });
  await assert.rejects(run("/bin/sh", [evil.script], { env: { ...env, PATH: process.env.PATH } }), failsWith(/names files outside its own folder/));
  const absolute = await macDownload(join(root, "absolute"), { entries: ["/tmp/branch-escaped.txt"] });
  await assert.rejects(run("/bin/sh", [absolute.script], { env: { ...env, PATH: process.env.PATH } }), failsWith(/names files outside its own folder/));

  const outside = join(root, "outside");
  await mkdir(outside);
  const through = await macDownload(join(root, "through"), { entries: [`Branch Agent.app/Contents/Resources=>${outside}`, "Branch Agent.app/Contents/Resources/planted.txt"] });
  await assert.rejects(run("/bin/sh", [through.script], { env: { ...env, PATH: process.env.PATH } }), (error) => error.code !== 0);
  assert.equal(await exists(join(outside, "planted.txt")), false, "nothing is written through a link in the download");
  const linked = await macDownload(join(root, "linked"), { entries: [`Branch Agent.app/Contents/Resources=>${outside}`] });
  await assert.rejects(run("/bin/sh", [linked.script], { env: { ...env, PATH: process.env.PATH } }), failsWith(/link that leads outside its own folder/));
  const climbing = await macDownload(join(root, "climbing"), { entries: ["Branch Agent.app/Contents/up=>../../../../../../.."] });
  await assert.rejects(run("/bin/sh", [climbing.script], { env: { ...env, PATH: process.env.PATH } }), failsWith(/link that leads outside its own folder/));
  assert.equal(await exists(env.BRANCH_TEST_RECORD), false, "nothing was handed over");
  const good = await macDownload(join(root, "good"), { links: true });
  await run("/bin/sh", [good.script, "--quiet"], { env: { ...env, PATH: process.env.PATH } });
  assert.match(await readFile(env.BRANCH_TEST_RECORD, "utf8"), /^install$/m, "a link inside the app is fine");

  const text = unixBootstrapperScript();
  assert.ok(text.indexOf('ARCHIVE="$STAGE/$ASSET"') < text.indexOf("shasum -a 256 \"$ARCHIVE\""), "the private copy is the one checked");
  assert.ok(!/ditto -x -k "\$SOURCE"|tar -xzf "\$SOURCE"/.test(text), "and the one unpacked");
});

// ------------------------------------------------------------------------------------ branch quit

test("`branch quit` refuses the phone door and a connection that is not from this computer", async (t) => {
  const dataDir = await scratch(t);
  await writeFile(join(dataDir, "session-token"), TOKEN);
  let quits = 0;
  const quit = () => { quits++; };
  const request = (socket) => ({ method: "POST", headers: { authorization: `Bearer ${TOKEN}` }, socket });
  await assert.rejects(quitRequest(request({ localAddress: "127.0.0.1", remoteAddress: "100.64.0.9" }), { dataDir, quit }), /on this computer/);
  await assert.rejects(quitRequest(request({ localAddress: "127.0.0.1", remoteAddress: "127.0.0.1" }), { dataDir, quit, viaRemote: true }), /on this computer/);
  await assert.rejects(quitRequest(request({ localAddress: "127.0.0.1", remoteAddress: "127.0.0.1" }), { dataDir: join(dataDir, "none"), quit }), /on this computer/,
    "without a saved key nobody can ask");
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(quits, 0);
});

test("through the real server, a web page, a short-lived key and a launch without a quit cannot close Branch", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-boring-int-"));
  const dataDir = join(root, "data");
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir,
    provider: { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } } });
  let quits = 0;
  const servers = [];
  t.after(async () => { for (const s of servers) await s.close(); await app.close(); await discardTemp(root); });
  const withQuit = await startServer(app, { dataDir, port: 0, presence: "app", quit: () => { quits++; } });
  servers.push(withQuit);
  const post = (base, token, headers = {}) => fetch(`${base}${quitPath}`, { method: "POST", headers: { authorization: `Bearer ${token}`, ...headers } });
  const scoped = app.sessionTokens.create(app.runtime.owner, { scope: "run", minutes: 5 }).token;
  const byKey = await post(withQuit.url, scoped);
  assert.equal(byKey.status, 401);
  assert.match((await byKey.json()).error, /short-lived key cannot close Branch/, "refused at the shared short-lived-key door");
  assert.equal((await post(withQuit.url, withQuit.token, { origin: "https://evil.example" })).status, 403, "a web page's request is refused");
  assert.equal((await post(withQuit.url, withQuit.token, { "sec-fetch-site": "cross-site" })).status, 403);
  assert.equal((await post(withQuit.url, "d".repeat(64))).status, 401);
  const looked = await fetch(`${withQuit.url}${quitPath}`, { headers: { authorization: `Bearer ${withQuit.token}` } });
  assert.equal(looked.status, 405, "only POST closes");
  await withQuit.close();
  servers.pop();

  const without = await startServer(app, { dataDir, port: 0, presence: "daemon" });
  servers.push(without);
  const refused = await post(without.url, without.token);
  assert.equal(refused.status, 403, "a launch that did not say how to quit (the gateway's engine) refuses");
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(quits, 0);
});

// ------------------------------------------------------------------------------------ update

async function updateSetup(t) {
  const root = await scratch(t);
  const archive = Buffer.from("pretend download");
  const digest = createHash("sha256").update(archive).digest("hex");
  const release = {
    tag_name: "v2.0.0", name: "Branch Agent 2.0.0", body: "", published_at: null, html_url: "https://github.com/stabrea/Branch-Agent/releases/v2.0.0",
    assets: [
      { name: "Branch-Agent-linux-x64.tar.gz", browser_download_url: "https://example.test/app.tar.gz", size: archive.length },
      { name: "Branch-Agent-linux-x64.tar.gz.sha256", browser_download_url: "https://example.test/app.sha256", size: 10 },
    ],
  };
  const fetch = async (url) => url.endsWith("/releases/latest") ? Response.json(release)
    : url.endsWith(".sha256") ? new Response(`${digest}  x\n`) : new Response(archive);
  const events = [];
  const deps = { lastReleaseWithoutProvenance: "2.0.0",
    fetch, scratchDir: join(root, "scratch"), running: async () => null,
    extract: async (_file, into) => { await fakeApp(into, "linux", "2.0.0"); },
    backup: async () => { events.push("backup"); },
    quit: async () => { events.push("quit"); return { stopped: true, wasRunning: false, pid: null, message: "" }; },
    runScript: (...args) => { events.push(["script", ...args]); return 0; },
  };
  const lines = [];
  const input = { installRoot: join(root, "app"), dataDir: join(root, "data"), version: "1.0.0", platform: "linux", arch: "x64",
    yes: true, print: (line) => lines.push(line) };
  await mkdir(input.dataDir, { recursive: true });
  return { deps, events, lines, input };
}

test("`branch update --yes` never swaps when closing Branch fails outright, and never goes back a version", { skip: posixOnly }, async (t) => {
  const s = await updateSetup(t);
  const broken = async () => { s.events.push("quit"); throw new Error("the running note could not be read"); };
  assert.equal(await headlessUpdate({ ...s.input, deps: { ...s.deps, quit: broken } }), 1);
  assert.ok(!s.events.some((event) => event[0] === "script"), "the hand-over script never runs under a Branch that may still be working");
  assert.match(s.lines.at(-1), /could not be closed \(the running note could not be read\)\. Nothing was changed/);

  const before = s.events.length;
  assert.equal(await headlessUpdate({ ...s.input, version: "3.0.0", deps: s.deps }), 0);
  assert.equal(s.events.length, before, "a newer copy is never replaced by an older release: nothing backed up, closed or swapped");
});

// ------------------------------------------------------------------------------------ --assistant

test("an installer's assistant file follows a market's rules: no approval rules, models or memory, and new skills off", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-boring-int-"));
  const provider = { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } };
  const source = await createBranch({ workspace: join(root, "w1"), dataDir: join(root, "d1"), provider });
  const target = await createBranch({ workspace: join(root, "w2"), dataDir: join(root, "d2"), provider });
  t.after(async () => { await source.close(); await target.close(); await discardTemp(root); });
  const owner = source.runtime.owner;
  source.store.save("specialists", owner, "writer-1", { name: "writer" });
  source.store.save("settings", owner, "policy", { planted: "approve everything" });
  source.store.save("settings", owner, "routing", { planted: "a model of the publisher's choosing" });
  source.store.skills.install(owner, { document: "---\nname: tidy-up\ndescription: Tidy the desk.\n---\n\nPut things away.\n" });
  const { bytes } = exportAgent(source.store, owner, "x", { memory: true });
  const opened = openAgent(bytes);
  assert.ok(opened.manifest.sections.some((s) => s.name === "permissions"), "the file really carries approval rules");

  const into = target.runtime.owner;
  const policyBefore = target.store.get("settings", into, "policy")?.data ?? null;
  const reports = bringInShareable(target.store, into, opened, ["specialists", "procedures", "skills", "permissions", "routing"],
    { subject: "team.branch-agent", from: "Brought in by the installer" });
  assert.deepEqual([...new Set(reports.map((r) => r.section))].sort(), ["procedures", "skills", "specialists"]);
  assert.equal(target.store.get("specialists", into, "writer-1").data.name, "writer");
  assert.deepEqual(target.store.get("settings", into, "policy")?.data ?? null, policyBefore, "approval rules never arrive this way");
  assert.notEqual(target.store.get("settings", into, "routing")?.data?.planted, "a model of the publisher's choosing");
  const skills = target.store.skills.list(into);
  assert.equal(skills.length, 1);
  assert.equal(skills[0].activeVersion, null, "a new skill arrives switched off");

  const files = [...opened.files].map(([name, text]) => [name, name === "specialists.json" ? text.replace("writer", "w-riter") : text]);
  assert.throws(() => openAgent(zipWrite(files)), /does not match its fingerprint/, "a changed file is refused before anything is brought in");
});
