import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, stat, symlink, readlink, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { discardTemp } from "./temp-dir.mjs";

import { releaseAssets, releaseAssetName, checksumAssetName, appEntryName, installTarget } from "../dist/desktop/release-assets.js";
import { launchdPlist, launchdPlistPath, launchdLabel, launchdCommand } from "../dist/install/launchd.js";
import { systemdUnit, systemdUnitPath, systemdQuote, systemdCommand } from "../dist/install/systemd.js";
import { daemonCommand } from "../dist/install/daemon.js";
import { launchHandOver, posixHandOverScript, shellQuote } from "../dist/desktop/hand-over.js";
import { Updater, expandArchive, posixExtractCommand } from "../dist/desktop/updater.js";
import { doctorFix, doctorText, gitInstallAdvice } from "../dist/doctor-fix.js";

const run = promisify(execFile);
const posix = process.platform !== "win32";

async function scratch(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-service-update-"));
  t.after(() => discardTemp(root));
  return root;
}
const program = {
  executable: "/Applications/Branch Agent.app/Contents/MacOS/Branch Agent",
  script: "/Applications/Branch Agent.app/Contents/Resources/app/dist/cli.js",
  dataDir: "/Users/pat/Library/Application Support/Branch Agent/data",
  workspace: "/Users/pat/Branch & Co <work>",
  port: 3210,
};
function recorder(fail = () => false) {
  const calls = [];
  const runTool = async (file, args) => {
    calls.push([file, ...args]);
    if (fail(args)) throw new Error("exit 1");
    return "";
  };
  return { calls, run: runTool };
}

// ---------------------------------------------------------------------------- release downloads

test("every kind of computer maps to exactly one download name, or to none", () => {
  const table = {
    "win32/x64": "Branch-Agent-windows-x64.zip",
    "darwin/arm64": "Branch-Agent-macos-arm64.zip",
    "darwin/x64": "Branch-Agent-macos-x64.zip",
    "linux/x64": "Branch-Agent-linux-x64.tar.gz",
  };
  for (const platform of ["win32", "darwin", "linux", "freebsd", "aix"])
    for (const arch of ["x64", "arm64", "ia32", "arm"])
      assert.equal(releaseAssetName(platform, arch), table[`${platform}/${arch}`] ?? null, `${platform}/${arch}`);
  assert.equal(releaseAssets.length, 4);
  assert.equal(checksumAssetName("Branch-Agent-linux-x64.tar.gz"), "Branch-Agent-linux-x64.tar.gz.sha256");
  assert.deepEqual(["win32", "darwin", "linux"].map(appEntryName), ["Branch Agent.exe", "Branch Agent.app", "branch-agent"]);
});

test("the folder an update replaces is the program folder, or the whole app bundle on a Mac", () => {
  assert.equal(installTarget("win32", "C:\\Users\\pat\\AppData\\Local\\Programs\\Branch Agent\\Branch Agent.exe"),
    "C:\\Users\\pat\\AppData\\Local\\Programs\\Branch Agent");
  assert.equal(installTarget("darwin", "/Applications/Branch Agent.app/Contents/MacOS/Branch Agent"), "/Applications/Branch Agent.app");
  assert.equal(installTarget("darwin", "/opt/homebrew/bin/node"), null, "not inside an app bundle");
  assert.equal(installTarget("linux", "/home/pat/Apps/Branch-Agent-linux-x64/branch-agent"), "/home/pat/Apps/Branch-Agent-linux-x64");
});

// ------------------------------------------------------------------------------- macOS sign-in

test("the Mac sign-in file starts at sign-in, restarts only after a crash, and logs into the data folder", () => {
  const plist = launchdPlist(program);
  assert.equal(launchdPlistPath("/Users/pat"), "/Users/pat/Library/LaunchAgents/com.keepoak.branch-agent.plist");
  assert.match(plist, /<key>Label<\/key><string>com\.keepoak\.branch-agent<\/string>/);
  assert.match(plist, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(plist, /<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key><false\/>\s*<\/dict>/);
  assert.match(plist, /<key>ProcessType<\/key><string>Background<\/string>/);
  assert.match(plist, /<array>\s*<string>\/Applications\/Branch Agent\.app\/Contents\/MacOS\/Branch Agent<\/string>\s*<string>[^<]*cli\.js<\/string>\s*<string>start<\/string>\s*<\/array>/);
  assert.match(plist, /<key>ELECTRON_RUN_AS_NODE<\/key><string>1<\/string>/, "the engine runs with no window");
  assert.match(plist, /<key>BRANCH_WORKSPACE<\/key><string>\/Users\/pat\/Branch &amp; Co &lt;work&gt;<\/string>/, "text is escaped");
  assert.match(plist, /<key>StandardOutPath<\/key><string>\/Users\/pat\/Library\/Application Support\/Branch Agent\/data\/logs\/background\.log<\/string>/);
  assert.match(plist, /<key>StandardErrorPath<\/key><string>[^<]*\/data\/logs\/background-errors\.log<\/string>/);
});

test("the Mac sign-in file is a valid property list", { skip: process.platform !== "darwin" && "macOS plutil" }, async (t) => {
  const root = await scratch(t);
  const file = join(root, "check.plist");
  await writeFile(file, launchdPlist(program));
  const { stdout } = await run("/usr/bin/plutil", ["-lint", file]);
  assert.match(stdout, /OK/);
});

// Installing a LaunchAgent or a systemd unit only means something on macOS or Linux; Windows does not pretend to prove it.
test("installing on a Mac writes the file and loads it for this person only; removing unloads first", { skip: !posix }, async (t) => {
  const root = await scratch(t);
  const path = join(root, "LaunchAgents", `${launchdLabel}.plist`);
  const options = { ...program, dataDir: join(root, "data"), launcherPath: join(root, "unused.vbs"), platform: "darwin", plistPath: path, uid: 501 };
  const fake = recorder();
  const report = await daemonCommand("install", options, { run: fake.run });
  assert.deepEqual(fake.calls, [
    ["/bin/launchctl", "bootout", "gui/501/com.keepoak.branch-agent"],
    ["/bin/launchctl", "bootstrap", "gui/501", path],
  ]);
  assert.equal(await readFile(path, "utf8"), launchdPlist(options));
  assert.ok((await stat(join(root, "data", "logs"))).isDirectory(), "the log folder exists before macOS writes to it");
  assert.equal(report.installed, true);
  assert.equal(report.taskName, "com.keepoak.branch-agent");
  assert.equal(report.message, "Branch now starts by itself when you sign in to your Mac, with no window. Timed jobs and chat replies keep working when the window is closed.");
  assert.ok(!existsSync(options.launcherPath), "no Windows launcher is written");

  const status = await daemonCommand("status", options, { run: fake.run });
  assert.deepEqual(fake.calls[2], ["/bin/launchctl", "print", "gui/501/com.keepoak.branch-agent"]);
  assert.deepEqual([status.installed, status.message], [true, "Branch starts by itself when you sign in to your Mac."]);

  const removed = await daemonCommand("uninstall", options, { run: fake.run });
  assert.deepEqual(fake.calls[3], ["/bin/launchctl", "bootout", "gui/501/com.keepoak.branch-agent"]);
  assert.equal(fake.calls.length, 4);
  assert.equal(existsSync(path), false, "the file is gone");
  assert.equal(removed.installed, false);

  const missing = await launchdCommand("status", options, { path, uid: 501 }, { run: recorder(() => true).run });
  assert.equal(missing.installed, false);
  assert.match(missing.message, /does not start by itself/);
});

test("a failed load on a Mac is reported, not hidden", async (t) => {
  const root = await scratch(t);
  const options = { ...program, dataDir: join(root, "data"), launcherPath: "", platform: "darwin", plistPath: join(root, "a.plist"), uid: 501 };
  const fake = recorder((args) => args[0] === "bootstrap");
  await assert.rejects(daemonCommand("install", options, { run: fake.run }), /exit 1/);
});

// ------------------------------------------------------------------------------- Linux sign-in

test("the Linux sign-in file restarts unless stopped on purpose, quotes safely and refuses line breaks", () => {
  assert.equal(systemdUnitPath({}, "/home/pat"), "/home/pat/.config/systemd/user/branch-agent.service");
  assert.equal(systemdUnitPath({ XDG_CONFIG_HOME: "/cfg" }, "/home/pat"), "/cfg/systemd/user/branch-agent.service");
  const unit = systemdUnit({ ...program, executable: "/opt/Branch Agent/branch-agent", workspace: "/home/pat/100% \"real\" $HOME" });
  assert.match(unit, /^ExecStart="\/opt\/Branch Agent\/branch-agent" "[^"]*cli\.js" "start"$/m);
  assert.match(unit, /^Environment="ELECTRON_RUN_AS_NODE=1"$/m);
  assert.match(unit, /^Environment="BRANCH_WORKSPACE=\/home\/pat\/100%% \\"real\\" \$HOME"$/m, "% is doubled, $ is left alone where nothing expands");
  assert.match(unit, /^Environment="BRANCH_PORT=3210"$/m);
  assert.match(unit, /^Restart=always$/m);
  assert.match(unit, /^RestartPreventExitStatus=78$/m, "a stop on purpose stays stopped");
  assert.match(unit, /^StandardOutput=append:\/Users\/pat\/Library\/Application Support\/Branch Agent\/data\/logs\/background\.log$/m);
  assert.match(unit, /^WantedBy=default\.target$/m);
  assert.equal(systemdQuote("a$b\\c"), '"a$$b\\\\c"', "ExecStart doubles $ so nothing is expanded");
  assert.throws(() => systemdUnit({ ...program, dataDir: "/tmp/x\nExecStartPre=/bin/evil" }), /line break/);
});

test("the Linux sign-in file passes systemd's own check", { skip: process.platform !== "linux" && "Linux systemd" }, async (t) => {
  const root = await scratch(t);
  const file = join(root, "branch-agent.service");
  await writeFile(file, systemdUnit({ ...program, executable: "/bin/true", script: "/bin/true" }));
  const analyze = await run("systemd-analyze", ["verify", file]).then(() => "", (error) => String(error.stderr ?? error.message));
  if (/not found|ENOENT/.test(analyze)) return t.skip("systemd-analyze is not installed");
  assert.ok(!/Unknown key|Failed to parse|Invalid/i.test(analyze), analyze);
});

test("installing on Linux writes the file and switches it on for this person only", { skip: !posix }, async (t) => {
  const root = await scratch(t);
  const path = join(root, "systemd", "user", "branch-agent.service");
  const options = { ...program, dataDir: join(root, "data"), launcherPath: "", platform: "linux", unitPath: path };
  const fake = recorder();
  const report = await daemonCommand("install", options, { run: fake.run });
  assert.deepEqual(fake.calls, [
    ["systemctl", "--user", "daemon-reload"],
    ["systemctl", "--user", "enable", "--now", "branch-agent.service"],
  ]);
  assert.equal(await readFile(path, "utf8"), systemdUnit(options));
  assert.equal(report.message, "Branch now starts by itself when you sign in, with no window. Timed jobs and chat replies keep working when the window is closed.");
  assert.equal(report.taskName, "branch-agent.service");

  const status = await daemonCommand("status", options, { run: fake.run });
  assert.deepEqual(fake.calls[2], ["systemctl", "--user", "is-enabled", "branch-agent.service"]);
  assert.equal(status.message, "Branch starts by itself when you sign in.");

  await daemonCommand("uninstall", options, { run: fake.run });
  assert.deepEqual(fake.calls.slice(3), [
    ["systemctl", "--user", "disable", "--now", "branch-agent.service"],
    ["systemctl", "--user", "daemon-reload"],
  ]);
  assert.equal(existsSync(path), false);
  const off = await systemdCommand("status", options, { path }, { run: recorder(() => true).run });
  assert.equal(off.installed, false);
});

test("any other kind of computer gets an honest answer and nothing is run", async () => {
  const fake = recorder();
  const report = await daemonCommand("install", { ...program, launcherPath: "", platform: "freebsd" }, { run: fake.run });
  assert.equal(report.installed, false);
  assert.match(report.message, /not available on this kind of computer/);
  assert.deepEqual(fake.calls, []);
});

// ---------------------------------------------------------------------------------- hand-over

test("on a Mac or Linux the hand-over starts detached with nothing attached, never through the scheduler", async () => {
  for (const platform of ["darwin", "linux"]) {
    let spawned = null;
    const execCalls = [];
    const how = await launchHandOver("/tmp/update/apply-update.sh", 4242, {
      platform,
      exec: (...args) => { execCalls.push(args); },
      write: () => { throw new Error("no launcher file on this system"); },
      spawn: (command, args, options) => { spawned = { command, args, options }; return { unref() { spawned.unrefd = true; } }; },
    });
    assert.equal(how, "spawn");
    assert.deepEqual(execCalls, []);
    assert.deepEqual(spawned, {
      command: "/bin/sh", args: ["/tmp/update/apply-update.sh", "4242"],
      options: { detached: true, stdio: "ignore" }, unrefd: true,
    });
  }
});

const plan = (extra = {}) => ({
  platform: "darwin", target: "/Applications/Branch Agent.app", staged: "/tmp/it's/unpacked/Branch Agent.app",
  log: "/tmp/it's/apply-update.log", executableName: "branch-agent", daemonPid: null, ...extra,
});

test("the Mac hand-over waits, ends a stuck app, keeps the previous bundle and reopens with open -n", () => {
  const text = posixHandOverScript(plan({ daemonPid: 777 }));
  assert.equal(shellQuote("it's"), "'it'\\''s'");
  assert.match(text, /^#!\/bin\/sh\n/);
  assert.match(text, /^TARGET='\/Applications\/Branch Agent\.app'$/m);
  assert.match(text, /^STAGED='\/tmp\/it'\\''s\/unpacked\/Branch Agent\.app'$/m, "quotes survive a path with a quote in it");
  assert.match(text, /^PREVIOUS="\$TARGET\.previous"$/m);
  assert.match(text, /\[ "\$n" -lt 60 \][\s\S]*kill -TERM "\$1"[\s\S]*\[ "\$n" -lt 10 \][\s\S]*kill -KILL "\$1"/, "bounded wait, then TERM, then KILL");
  assert.match(text, /wait_for "\$PID" app\nwait_for 777 "background engine"\n/);
  assert.ok(text.indexOf("wait_for 777") < text.indexOf('mv "$TARGET" "$PREVIOUS"'), "both are gone before anything moves");
  assert.match(text, /\/usr\/bin\/open -n -W "\$TARGET" >\/dev\/null 2>&1 &\nSTARTED=\$!/);
  // mac7/real-update: the previous bundle is moved back whole (ditto only if that move fails).
  assert.match(text, /new version did not start; restoring previous"\n[\s\S]*mv "\$TARGET" "\$FAILED" && mv "\$PREVIOUS" "\$TARGET"[\s\S]*\/usr\/bin\/ditto "\$PREVIOUS" "\$TARGET"; fi\n\/usr\/bin\/open -n "\$TARGET"/);
  assert.match(text, /^\/usr\/bin\/ditto "\$STAGED" "\$INCOMING" \|\|/m, "the bundle is copied with ditto");
  assert.match(text, /^sleep 20$/m, "the new version has twenty seconds to prove it stays up");
  assert.ok(!/osascript|Terminal|schtasks|wscript|cmd\.exe/.test(text), "no terminal window and nothing from Windows");
  assert.ok(!posixHandOverScript(plan()).includes("background engine"), "no second wait without an engine");
});

test("the Linux hand-over starts the program file inside the swapped folder", () => {
  const text = posixHandOverScript(plan({ platform: "linux", target: "/home/pat/Apps/Branch-Agent-linux-x64" }));
  assert.match(text, /^"\$TARGET"\/'branch-agent' >\/dev\/null 2>&1 &$/m);
  assert.ok(!text.includes("/usr/bin/open"));
  assert.match(text, /^cp -Rp "\$STAGED" "\$INCOMING" \|\|/m);
});

async function fakeInstall(root, exeBody, settleSeconds = 20) {
  const target = join(root, "Apps", "Branch-Agent-linux-x64");
  const staged = join(root, "scratch", "unpacked", "Branch-Agent-linux-x64");
  for (const [dir, body, marker] of [[target, exeBody.old, "old"], [staged, exeBody.new, "new"]]) {
    await mkdir(join(dir, "resources"), { recursive: true });
    await writeFile(join(dir, "branch-agent"), body);
    await chmod(join(dir, "branch-agent"), 0o755);
    await writeFile(join(dir, "resources", "version.txt"), marker);
  }
  const script = join(root, "scratch", "apply-update.sh");
  const log = join(root, "scratch", "apply-update.log");
  await writeFile(script, posixHandOverScript({ platform: "linux", target, staged, log, executableName: "branch-agent", daemonPid: null, settleSeconds }));
  return { target, script, log };
}
const runScript = (script, args) => new Promise((resolve) => {
  const child = spawn("/bin/sh", [script, ...args], { stdio: "ignore" });
  child.on("close", resolve);
});

test("sh runs the hand-over: waits for the app, swaps the folder and keeps the previous copy", { skip: !posix && "POSIX shell" }, async (t) => {
  const root = await scratch(t);
  const { target, script, log } = await fakeInstall(root, { old: "#!/bin/sh\nexit 0\n", new: "#!/bin/sh\nexit 0\n" });
  // A stand-in for the app that closes by itself after a moment.
  const app = spawn(process.execPath, ["-e", "setTimeout(() => {}, 1500)"], { stdio: "ignore" });
  t.after(() => { try { app.kill(); } catch { /* gone */ } });
  const code = await runScript(script, [String(app.pid), "stay"]);
  assert.equal(code, 0);
  assert.equal(app.exitCode, 0, "the app ended by itself before the swap");
  assert.equal(await readFile(join(target, "resources", "version.txt"), "utf8"), "new");
  assert.equal(await readFile(join(`${target}.previous`, "resources", "version.txt"), "utf8"), "old");
  assert.equal(existsSync(`${target}.incoming`), false);
  assert.match(await readFile(log, "utf8"), /update started[\s\S]*app closed[\s\S]*copying new version[\s\S]*keeping previous version/);
});

test("sh puts the previous version back when the new one does not stay up", { skip: !posix && "POSIX shell" }, async (t) => {
  const root = await scratch(t);
  const started = join(root, "started.txt");
  const { target, script, log } = await fakeInstall(root, {
    old: `#!/bin/sh\necho old >> '${started}'\n`,
    new: `#!/bin/sh\necho new >> '${started}'\nexit 3\n`,
  }, 1);
  const code = await runScript(script, ["999999"]);
  assert.equal(code, 1);
  assert.equal(await readFile(join(target, "resources", "version.txt"), "utf8"), "old", "the previous version is back");
  assert.equal(await readFile(join(`${target}.failed`, "resources", "version.txt"), "utf8"), "new", "the one that failed is kept aside (mac7/real-update)");
  // The previous version is started in the background; a busy machine can take a while to get to it.
  const lines = async () => (await readFile(started, "utf8")).trim().split("\n");
  for (let tries = 0; tries < 200 && (await lines()).length < 2; tries += 1) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(await lines(), ["new", "old"]);
  assert.match(await readFile(log, "utf8"), /starting new version[\s\S]*did not start; restoring previous/);
});

// ------------------------------------------------------------------------------------ updater

function releaseFor(assetName, { tamper = false } = {}) {
  const bytes = Buffer.from("pretend archive");
  const digest = createHash("sha256").update(bytes).digest("hex");
  const asked = [];
  const fetcher = async (url) => {
    asked.push(String(url));
    if (String(url).includes("releases/latest"))
      return new Response(JSON.stringify({
        tag_name: "v2.0.0", name: "Branch Agent 2.0.0", body: "", published_at: null,
        html_url: "https://github.com/x/y/releases/tag/v2.0.0",
        assets: releaseAssets.flatMap(({ name }) => [
          { name, browser_download_url: `https://example.invalid/${name}`, size: bytes.length },
          { name: `${name}.sha256`, browser_download_url: `https://example.invalid/${name}.sha256`, size: 96 },
        ]),
      }), { status: 200 });
    if (String(url).endsWith(".sha256")) return new Response(`${tamper ? "0".repeat(64) : digest}  ${assetName}\n`, { status: 200 });
    return new Response(bytes, { status: 200 });
  };
  return { fetcher, asked };
}

test("a Mac update fetches the Mac download, finds the app bundle and writes the shell hand-over", async (t) => {
  const root = await scratch(t);
  const asset = releaseAssetName("darwin", "arm64");
  const { fetcher, asked } = releaseFor(asset);
  const installDir = join(root, "Applications", "Branch Agent.app");
  const updater = new Updater({ lastReleaseWithoutProvenance: "2.0.0",
    repo: "x/y", currentVersion: "1.0.0", installDir, executableName: appEntryName("darwin"), assetName: asset,
    scratchDir: join(root, "scratch"), fetch: fetcher, platform: "darwin",
    extract: async (_archive, into) => {
      await mkdir(join(into, "Branch Agent.app", "Contents", "MacOS"), { recursive: true });
      await mkdir(join(into, "Branch Agent.app", "Contents", "Resources", "app"), { recursive: true });
      await writeFile(join(into, "Branch Agent.app", "Contents", "MacOS", "Branch Agent"), "new");
      await writeFile(join(into, "Branch Agent.app", "Contents", "Resources", "app", "package.json"), JSON.stringify({ name: "branch-agent", version: "2.0.0" }));
    },
    stopDaemon: async () => 5150,
  });
  const { script, stagedDir } = await updater.install();
  assert.ok(asked.includes("https://example.invalid/Branch-Agent-macos-arm64.zip"), "the Mac download, not the Windows one");
  assert.ok(!asked.some((url) => url.includes("windows")));
  assert.equal(stagedDir, join(root, "scratch", "unpacked", "Branch Agent.app"));
  assert.equal(script, join(root, "scratch", "apply-update.sh"));
  const text = await readFile(script, "utf8");
  assert.equal(text, posixHandOverScript({
    platform: "darwin", target: installDir, staged: stagedDir, log: join(root, "scratch", "apply-update.log"),
    executableName: "Branch Agent.app", daemonPid: 5150, archive: join(root, "scratch", asset),
  }));
  assert.equal(updater.status.phase, "ready");
});

test("a Linux update finds the program folder inside the download", async (t) => {
  const root = await scratch(t);
  const asset = releaseAssetName("linux", "x64");
  const updater = new Updater({ lastReleaseWithoutProvenance: "2.0.0",
    repo: "x/y", currentVersion: "1.0.0", installDir: join(root, "Branch-Agent-linux-x64"), executableName: "branch-agent",
    assetName: asset, scratchDir: join(root, "scratch"), fetch: releaseFor(asset).fetcher, platform: "linux",
    extract: async (_archive, into) => {
      await mkdir(join(into, "Branch-Agent-linux-x64", "resources", "app"), { recursive: true });
      await writeFile(join(into, "Branch-Agent-linux-x64", "branch-agent"), "new");
      await writeFile(join(into, "Branch-Agent-linux-x64", "resources", "app", "package.json"), JSON.stringify({ name: "branch-agent", version: "2.0.0" }));
    },
  });
  const { script, stagedDir } = await updater.install();
  assert.equal(stagedDir, join(root, "scratch", "unpacked", "Branch-Agent-linux-x64"));
  assert.match(await readFile(script, "utf8"), /"\$TARGET"\/'branch-agent'/);
});

test("a download that does not match its checksum is refused on a Mac and on Linux", async (t) => {
  const root = await scratch(t);
  for (const [platform, arch] of [["darwin", "x64"], ["linux", "x64"]]) {
    const asset = releaseAssetName(platform, arch);
    let unpacked = false;
    const updater = new Updater({ lastReleaseWithoutProvenance: "2.0.0",
      repo: "x/y", currentVersion: "1.0.0", installDir: join(root, "app"), executableName: appEntryName(platform),
      assetName: asset, scratchDir: join(root, `scratch-${platform}`), fetch: releaseFor(asset, { tamper: true }).fetcher,
      platform, extract: async () => { unpacked = true; },
    });
    await assert.rejects(updater.install(), /did not match the published checksum/);
    assert.equal(updater.status.phase, "error");
    assert.equal(unpacked, false, "nothing is unpacked");
  }
});

test("a running-from-source copy, or a computer with no download, says so in plain words", async () => {
  const base = { lastReleaseWithoutProvenance: "2.0.0", repo: "x/y", currentVersion: "1.0.0", executableName: "branch-agent", scratchDir: "/tmp/none" };
  const source = new Updater({ ...base, installDir: null, assetName: "Branch-Agent-linux-x64.tar.gz", platform: "linux" });
  assert.equal(source.status.phase, "unsupported");
  assert.match(source.status.message, /running from its source code, so update it with `branch update`/);
  assert.ok(!/Windows only/.test(source.status.message));
  await assert.rejects(source.install(), /source code/);
  const windows = new Updater({ ...base, installDir: null, assetName: "Branch-Agent-windows-x64.zip", platform: "win32" });
  assert.equal(windows.status.message, "Updates apply to the installed app only.", "Windows wording is unchanged");
  const none = new Updater({ ...base, installDir: "/opt/x", assetName: null, platform: "linux" });
  assert.equal(none.status.phase, "unsupported");
  assert.match(none.status.message, /not available for this kind of computer yet/);
});

test("a release without the Mac download says which one is missing", async (t) => {
  const root = await scratch(t);
  const updater = new Updater({ lastReleaseWithoutProvenance: "2.0.0",
    repo: "x/y", currentVersion: "1.0.0", installDir: join(root, "a.app"), executableName: "Branch Agent.app",
    assetName: "Branch-Agent-macos-riscv.zip", scratchDir: join(root, "s"), fetch: releaseFor("x").fetcher, platform: "darwin",
  });
  const status = await updater.check();
  assert.equal(status.phase, "error");
  assert.equal(status.message, "The newest release is missing its macOS download or checksum.");
});

test("unpacking uses ditto on a Mac and tar on Linux", async () => {
  assert.deepEqual(posixExtractCommand("darwin", "/s/a.zip", "/s/u"), ["/usr/bin/ditto", ["-x", "-k", "/s/a.zip", "/s/u"]]);
  assert.deepEqual(posixExtractCommand("linux", "/s/a.tar.gz", "/s/u"), ["tar", ["-xzf", "/s/a.tar.gz", "-C", "/s/u"]]);
  const calls = [];
  await expandArchive("/s/a.zip", tmpdir(), "darwin", async (file, args) => { calls.push([file, ...args]); });
  assert.deepEqual(calls, [["/usr/bin/ditto", "-x", "-k", "/s/a.zip", tmpdir()]]);
});

test("a real Linux-shaped download unpacks with tar", { skip: !posix && "POSIX tar" }, async (t) => {
  const root = await scratch(t);
  await mkdir(join(root, "src", "Branch-Agent-linux-x64"), { recursive: true });
  await writeFile(join(root, "src", "Branch-Agent-linux-x64", "branch-agent"), "exe");
  const archive = join(root, "Branch-Agent-linux-x64.tar.gz");
  await run("tar", ["-czf", archive, "-C", join(root, "src"), "Branch-Agent-linux-x64"]);
  await mkdir(join(root, "out"));
  await expandArchive(archive, join(root, "out"), "linux");
  assert.equal(await readFile(join(root, "out", "Branch-Agent-linux-x64", "branch-agent"), "utf8"), "exe");
});

test("a real Mac-shaped download keeps the links inside the app bundle", { skip: process.platform !== "darwin" && "macOS ditto" }, async (t) => {
  const root = await scratch(t);
  const bundle = join(root, "src", "Branch Agent.app");
  await mkdir(join(bundle, "Contents", "Frameworks", "Versions", "A"), { recursive: true });
  await writeFile(join(bundle, "Contents", "Frameworks", "Versions", "A", "lib"), "lib");
  await symlink("A", join(bundle, "Contents", "Frameworks", "Versions", "Current"));
  const archive = join(root, "Branch-Agent-macos-arm64.zip");
  await run("/usr/bin/ditto", ["-c", "-k", "--keepParent", bundle, archive]);
  await mkdir(join(root, "out"));
  await expandArchive(archive, join(root, "out"), "darwin");
  assert.equal(await readlink(join(root, "out", "Branch Agent.app", "Contents", "Frameworks", "Versions", "Current")), "A");
});

// ------------------------------------------------------------------------------------- doctor

test("doctor gives Git advice that fits the computer, in plain words", async () => {
  assert.match(gitInstallAdvice("win32"), /Git for Windows from git-scm\.com/);
  assert.match(gitInstallAdvice("darwin"), /xcode-select --install/);
  assert.match(gitInstallAdvice("linux"), /sudo apt install git/);
  for (const platform of ["darwin", "linux"]) {
    assert.ok(!/Windows/.test(gitInstallAdvice(platform)));
    const report = await doctorFix(
      { fix: false, port: 3210, workspace: process.cwd(), browsersInstalled: async () => true, platform },
      { run: async () => { throw new Error("not found"); }, portFree: async () => true },
    );
    const git = report.checks.find((check) => check.name === "Git");
    assert.equal(git.fix, gitInstallAdvice(platform));
    assert.ok(!/\b(TTS|daemon|binary|stdout|localhost|launchd|systemd)\b/.test(doctorText(report)));
  }
});

// ------------------------------------------------------------------ one list of download names

test("packaging, the release workflow and the updater agree on every download name and layout", async () => {
  const { assetNameFor } = await import("../scripts/package-desktop.mjs");
  const mac = await import("../scripts/package-macos.mjs");
  const linux = await import("../scripts/package-linux.mjs");
  const { macAppBundleName } = await import("../dist/desktop/release-assets.js");
  for (const platform of ["win32", "darwin", "linux", "freebsd"])
    for (const arch of ["x64", "arm64", "ia32"])
      assert.equal(assetNameFor(platform, arch), releaseAssetName(platform, arch), `${platform} ${arch}`);
  for (const arch of mac.MAC_ARCHES) assert.equal(mac.macAssetName(arch), releaseAssetName("darwin", arch));
  assert.equal(linux.linuxAssetName("x64"), releaseAssetName("linux", "x64"));
  assert.equal(`${linux.LINUX_FOLDER}.tar.gz`, releaseAssetName("linux", "x64"), "the Linux folder is named after its download");
  assert.equal(appEntryName("linux"), linux.LINUX_EXECUTABLE);
  assert.equal(appEntryName("darwin"), `${mac.MAC_APP_NAME}.app`);
  assert.equal(macAppBundleName, `${mac.MAC_APP_NAME}.app`);
  const workflow = await readFile(new URL("../.github/workflows/package.yml", import.meta.url), "utf8");
  const publication = await import("../scripts/publish-release.mjs");
  const published = publication.releaseFiles("v9.8.7");
  // The workflow checks the archives before the publication script independently inventories every file.
  const loops = [...workflow.matchAll(/for name in ([^;]+);/g)].map((match) => match[1].trim().split(/\s+/));
  assert.equal(loops.length, 1, "one workflow loop verifies the downloads before publication");
  assert.deepEqual(loops[0], releaseAssets.map(({ name }) => name), "the workflow verifies exactly these downloads");
  for (const { name } of releaseAssets) {
    assert.ok(published.includes(name), `${name} is published`);
    assert.ok(published.includes(`${name}.sha256`), `${name} is published with its checksum`);
  }
  assert.equal(`${releaseAssets[0].name}.sha256`, checksumAssetName(releaseAssets[0].name), "the checksum is named the way the updater looks for it");
  assert.ok(published.includes("Install Branch Agent.cmd") && published.includes("install-branch-agent.sh"), "both installer scripts are attached");
  // mac7/reach-leftovers: the phone download (the packed command) goes up with the checksum the
  // Termux script insists on, named after the version in the tag.
  assert.match(workflow, /cli="branch-agent-\$\{TAG#v\}\.tgz"/, "the phone download is named after the tag");
  assert.ok(published.includes("branch-agent-9.8.7.tgz") && published.includes("branch-agent-9.8.7.tgz.sha256"), "the phone download goes up with its checksum");
  assert.match(workflow, /sha256sum "\$name" > "\$name\.sha256"/, "its checksum is written beside it, in the format the Termux script reads");
  const check = workflow.slice(workflow.indexOf("- name: Check every download is there"), workflow.indexOf("- name: Publish the complete reviewed release"));
  assert.match(check, /sha256sum --check "\$cli\.sha256"/, "the phone download is checked before the release is touched");
  assert.match(workflow, /release\/install-branch-agent\.sh/, "the macOS and Linux builds hand over their installer script");
});

test("the release workflow never replaces a download that is already attached (bucket 22)", async () => {
  const workflow = await readFile(new URL("../.github/workflows/package.yml", import.meta.url), "utf8");
  const script = await readFile(new URL("../scripts/publish-release.mjs", import.meta.url), "utf8");
  assert.ok(!workflow.includes("--clobber") && !script.includes("--clobber"), "no upload overwrites what is there");
  assert.match(script, /readRelease\(gh, tag, repo\)/, "it first reads what is already attached");
  assert.match(script, /present > 0 && present < group\.length/, "a partial archive/checksum pair is refused");
  assert.match(script, /return present === 0/, "a complete attached group is kept rather than uploaded again");
  assert.match(script, /replace\(\/\[\^A-Za-z0-9\._-\]\/g, "\."\)/,
    "the exact GitHub rewrite is used for installer names containing spaces");
  assert.match(script, /"--draft=false", "--prerelease=false"/, "the final complete inventory is published as stable");
  assert.doesNotMatch(script, /"--latest"/, "rerunning an older stable release cannot move Latest backwards");
});

test("on macOS and Linux the update folder must belong to this person and is closed to others", { skip: process.platform === "win32" && "POSIX owners" }, async (t) => {
  const { ensurePrivateDir } = await import("../dist/desktop/updater.js");
  const root = await scratch(t);
  const dir = join(root, "update");
  await mkdir(dir, { mode: 0o777 });
  await ensurePrivateDir(dir);
  assert.equal((await stat(dir)).mode & 0o777, 0o700);
  await symlink(dir, join(root, "link"));
  await assert.rejects(ensurePrivateDir(join(root, "link")), /not safe/);
  assert.throws(() => posixHandOverScript({ platform: "linux", target: "/a", staged: "/b", log: "/c", executableName: "x", daemonPid: "1; rm -rf ~" }), /not a number/);
});
