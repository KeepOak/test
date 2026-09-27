// mac7/real-update: what the first real 0.17.0 -> 0.18.0 update on Linux and Windows found, each
// pinned down here so it cannot come back. See docs/agents/real-update-test.md for the runs themselves.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, chmod, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { discardTemp } from "./temp-dir.mjs";
import { posixHandOverScript, posixRollbackScript } from "../dist/desktop/hand-over.js";
import { Updater } from "../dist/desktop/updater.js";
import { releaseAssetName, appEntryName } from "../dist/desktop/release-assets.js";

const posix = process.platform !== "win32";
async function scratch(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-real-update-"));
  t.after(() => discardTemp(root));
  return root;
}
const runScript = (script, args) => new Promise((resolve) => {
  spawn("/bin/sh", [script, ...args], { stdio: "ignore" }).on("close", resolve);
});
const read = (path) => readFile(path, "utf8").catch(() => null);

/** A Linux install and its new version, as the hand-over sees them. */
const me = typeof process.getuid === "function" ? process.getuid() : 0;
async function install(root, { newStarts = true, portable = false, helper = null, started = null, says = false } = {}) {
  const target = join(root, "Apps", "Branch-Agent-linux-x64");
  const staged = join(root, "scratch", "unpacked", "Branch-Agent-linux-x64");
  for (const [dir, marker, starts] of [[target, "old", true], [staged, "new", newStarts]]) {
    await mkdir(join(dir, "resources"), { recursive: true });
    // selfdev: a new version that `says` it is up writes the started file, as the app does once its engine is up.
    await writeFile(join(dir, "branch-agent"), !starts ? "#!/bin/sh\nexit 3\n"
      : marker === "new" && says && started ? `#!/bin/sh\ndate > '${started}'\nsleep 5\n` : "#!/bin/sh\nsleep 5\n");
    await chmod(join(dir, "branch-agent"), 0o755);
    await writeFile(join(dir, "resources", "version.txt"), marker);
    await writeFile(join(dir, "chrome-sandbox"), helper ?? "helper");
    await chmod(join(dir, "chrome-sandbox"), 0o755);
  }
  if (portable) {
    await writeFile(join(target, "portable.txt"), "");
    await mkdir(join(target, "Branch Data", "state"), { recursive: true });
    await writeFile(join(target, "Branch Data", "state", "branch.sqlite"), "the person's work");
  }
  const archive = join(root, "scratch", "Branch-Agent-linux-x64.tar.gz");
  await writeFile(archive, "archive");
  const log = join(root, "scratch", "apply-update.log");
  const script = join(root, "scratch", "apply-update.sh");
  await writeFile(script, posixHandOverScript({ platform: "linux", target, staged, log, executableName: "branch-agent", daemonPid: null, settleSeconds: 1, archive, sandboxOwner: me,
    ...(started ? { started, startedSeconds: 3 } : {}) }));
  return { target, staged, script, log, archive };
}

test("a portable copy keeps its data through an update, and through putting the old version back", { skip: !posix && "POSIX shell" }, async (t) => {
  const root = await scratch(t);
  const up = await install(join(root, "up"), { portable: true });
  assert.equal(await runScript(up.script, ["999999", "stay"]), 0);
  assert.equal(await read(join(up.target, "resources", "version.txt")), "new");
  assert.ok(existsSync(join(up.target, "portable.txt")), "the new version is still portable");
  assert.equal(await read(join(up.target, "Branch Data", "state", "branch.sqlite")), "the person's work", "and has the person's work");
  assert.equal(existsSync(join(`${up.target}.previous`, "Branch Data")), false, "which is not left behind in the old copy");

  const back = await install(join(root, "back"), { portable: true, newStarts: false });
  assert.equal(await runScript(back.script, ["999999"]), 1);
  assert.equal(await read(join(back.target, "resources", "version.txt")), "old", "the old version is back");
  assert.equal(await read(join(back.target, "Branch Data", "state", "branch.sqlite")), "the person's work", "with the work");
  assert.ok(existsSync(join(back.target, "portable.txt")));
});

test("selfdev, Beta: a new version that runs but never says its engine is up is put back by itself; one that says so stays", { skip: !posix && "POSIX shell" }, async (t) => {
  const root = await scratch(t);
  const started = join(root, "started-2.0.0");
  const silent = await install(join(root, "silent"), { started });
  await writeFile(started, "left from the check before the swap");
  assert.equal(await runScript(silent.script, ["999999"]), 1);
  assert.equal(await read(join(silent.target, "resources", "version.txt")), "old", "the previous version is back, with no switch asked");
  assert.equal(await read(join(`${silent.target}.failed`, "resources", "version.txt")), "new", "the new one is kept aside");
  assert.match(await read(silent.log), /new version did not say it was up/);
  const up = await install(join(root, "up"), { started, says: true });
  assert.equal(await runScript(up.script, ["999999"]), 0);
  assert.equal(await read(join(up.target, "resources", "version.txt")), "new");
});

test("putting the old version back moves it whole, keeps the new one aside and tidies the download once it works", { skip: !posix && "POSIX shell" }, async (t) => {
  const root = await scratch(t);
  const back = await install(join(root, "back"), { newStarts: false });
  assert.equal(await runScript(back.script, ["999999"]), 1);
  assert.equal(await read(join(back.target, "resources", "version.txt")), "old");
  assert.equal(await read(join(`${back.target}.failed`, "resources", "version.txt")), "new", "the version that would not start is kept aside");
  assert.match(await read(back.log), /restoring previous[\s\S]*previous version is back/);

  const up = await install(join(root, "up"));
  assert.equal(await runScript(up.script, ["999999"]), 0);
  assert.equal(existsSync(up.staged), false, "the unpacked copy is gone once the new version runs");
  assert.equal(existsSync(up.archive), false, "and so is the download");
});

// The real helper must be root's with the setuid bit, which a test cannot make; the script is told this
// user is the administrator (sandboxOwner), so a helper with the bit set by this user stands in for one.
test("Linux keeps the sandbox helper an administrator set up, when the new version brings the same one", { skip: process.platform !== "linux" && "Linux setuid" }, async (t) => {
  const root = await scratch(t);
  const same = await install(join(root, "same"));
  await chmod(join(same.target, "chrome-sandbox"), 0o4755);
  assert.equal(await runScript(same.script, ["999999", "stay"]), 0);
  assert.equal(await read(join(same.target, "resources", "version.txt")), "new");
  const { stat } = await import("node:fs/promises");
  assert.ok((await stat(join(same.target, "chrome-sandbox"))).mode & 0o4000, "the new version has the working helper");
  assert.match(await read(same.log), /kept the sandbox helper/);
  // Going back later hands it back to the old version.
  assert.equal((await stat(join(`${same.target}.previous`, "chrome-sandbox"))).mode & 0o4000, 0, "the old copy holds the new version's plain one");
  await writeFile(join(root, "rb.sh"), posixRollbackScript({ platform: "linux", target: same.target, log: join(root, "rb.log"), executableName: "branch-agent", sandboxOwner: me }));
  assert.equal(await runScript(join(root, "rb.sh"), ["999999", "stay"]), 0);
  assert.equal(await read(join(same.target, "resources", "version.txt")), "old");
  assert.ok((await stat(join(same.target, "chrome-sandbox"))).mode & 0o4000, "the old version has it again");

  const other = await install(join(root, "other"));
  await writeFile(join(other.staged, "chrome-sandbox"), "a different helper");
  await chmod(join(other.target, "chrome-sandbox"), 0o4755);
  assert.equal(await runScript(other.script, ["999999", "stay"]), 0);
  assert.ok((await stat(join(`${other.target}.previous`, "chrome-sandbox"))).mode & 0o4000, "a different helper is never swapped in");
});

test("Linux never carries a helper that is not the very one an administrator set up", { skip: process.platform !== "linux" && "Linux setuid" }, async (t) => {
  const root = await scratch(t);
  const { stat, symlink, rm, link } = await import("node:fs/promises");
  const setuidIn = async (dir) => Boolean((await stat(join(dir, "chrome-sandbox")).catch(() => ({ mode: 0 }))).mode & 0o4000);
  const cases = {
    // The new version brings no helper: nothing is compared, so nothing is moved.
    "the new version has none": async (up) => { await rm(join(up.staged, "chrome-sandbox")); },
    // A link to some other setuid program passes `-u`; it is never moved.
    "the old one is a link": async (up) => {
      await rm(join(up.target, "chrome-sandbox"));
      await writeFile(join(root, "elsewhere"), "helper"); await chmod(join(root, "elsewhere"), 0o4755);
      await symlink(join(root, "elsewhere"), join(up.target, "chrome-sandbox"));
    },
    // Another name for the same file (a hard link) means it may be changed from somewhere else.
    "the old one has a second name": async (up) => { await link(join(up.target, "chrome-sandbox"), join(root, `second-${Math.random()}`)); },
    // Not the administrator's: some other owner's setuid file is not the one that was set up.
    "the new one is already setuid": async (up) => { await chmod(join(up.staged, "chrome-sandbox"), 0o4755); },
  };
  for (const [name, arrange] of Object.entries(cases)) {
    const up = await install(join(root, name.replace(/\W+/g, "-")));
    await chmod(join(up.target, "chrome-sandbox"), 0o4755);
    await arrange(up);
    assert.equal(await runScript(up.script, ["999999", "stay"]), 0, name);
    assert.equal(await read(join(up.target, "resources", "version.txt")), "new", name);
    assert.doesNotMatch(await read(up.log), /kept the sandbox helper/, name);
    if (name !== "the new one is already setuid") assert.equal(await setuidIn(up.target), false, `${name}: no setuid helper in the new version`);
  }
  // A helper owned by someone other than the administrator is not carried either.
  const other = await install(join(root, "not-root"));
  await chmod(join(other.target, "chrome-sandbox"), 0o4755);
  await writeFile(other.script, posixHandOverScript({ platform: "linux", target: other.target, staged: other.staged, log: other.log,
    executableName: "branch-agent", daemonPid: null, settleSeconds: 1, archive: other.archive, sandboxOwner: me + 1 }));
  assert.equal(await runScript(other.script, ["999999", "stay"]), 0);
  assert.equal(await setuidIn(other.target), false);
});

test("an old copy is never deleted with the person's work in it, and Branch Data is never replaced", { skip: !posix && "POSIX shell" }, async (t) => {
  const root = await scratch(t);
  // An update before this fix left Branch Data behind in the previous copy; two updates later that copy is removed.
  const up = await install(join(root, "stranded"));
  for (const old of [`${up.target}.previous`, `${up.target}.previous-2`]) {
    await mkdir(join(old, "Branch Data"), { recursive: true });
    await writeFile(join(old, "Branch Data", "work.txt"), `work in ${old}`);
  }
  assert.equal(await runScript(up.script, ["999999", "stay"]), 0);
  const saved = (await readdir(join(root, "stranded", "Apps"))).filter((f) => f.includes("saved Branch Data"));
  assert.equal(saved.length, 1, "the Branch Data in the copy that was removed is moved out first");
  assert.equal(await read(join(root, "stranded", "Apps", saved[0], "work.txt")), `work in ${up.target}.previous-2`);
  assert.equal(await read(join(`${up.target}.previous-2`, "Branch Data", "work.txt")), `work in ${up.target}.previous`);

  // Both copies have a Branch Data: neither is deleted to make room for the other.
  const both = await install(join(root, "both"), { portable: true });
  await mkdir(join(both.staged, "Branch Data"), { recursive: true });
  await writeFile(join(both.staged, "Branch Data", "fresh.txt"), "fresh");
  assert.equal(await runScript(both.script, ["999999", "stay"]), 0);
  assert.equal(await read(join(`${both.target}.previous`, "Branch Data", "state", "branch.sqlite")), "the person's work");
  assert.match(await read(both.log), /Branch Data is in both copies/);
});

function release(asset, body) {
  const bytes = Buffer.from("pretend archive");
  const digest = createHash("sha256").update(bytes).digest("hex");
  return async (url) => {
    if (String(url).includes("releases/latest"))
      return new Response(JSON.stringify({
        tag_name: "v2.0.0", name: "2.0.0", body: "", published_at: null, html_url: "https://github.com/x/y/releases/tag/v2.0.0",
        assets: [{ name: asset, browser_download_url: `https://example.invalid/${asset}`, size: 1000 },
          { name: `${asset}.sha256`, browser_download_url: `https://example.invalid/${asset}.sha256`, size: 96 }],
      }), { status: 200 });
    if (String(url).endsWith(".sha256")) return new Response(`${digest}  ${asset}\n`, { status: 200 });
    return new Response(body(), { status: 200, headers: { "content-length": "1000" } });
  };
}

test("a download that drops halfway, or goes quiet, says so in plain words and leaves nothing behind", async (t) => {
  const root = await scratch(t);
  const asset = releaseAssetName("linux", "x64");
  const cases = {
    dropped: () => new ReadableStream({ start(c) { c.enqueue(new Uint8Array(100)); c.error(new TypeError("terminated")); } }),
    quiet: () => new ReadableStream({ start(c) { c.enqueue(new Uint8Array(100)); } }),
  };
  for (const [name, body] of Object.entries(cases)) {
    const scratchDir = join(root, name);
    const updater = new Updater({ lastReleaseWithoutProvenance: "2.0.0", repo: "x/y", currentVersion: "1.0.0", installDir: join(root, "app"), executableName: appEntryName("linux"),
      assetName: asset, scratchDir, fetch: release(asset, body), platform: "linux", stallMs: 200, extract: async () => undefined });
    await assert.rejects(updater.install());
    assert.equal(updater.status.phase, "error");
    assert.match(updater.status.message, /^The download stopped before it finished, so nothing was changed\./, `${name}: ${updater.status.message}`);
    assert.doesNotMatch(updater.status.message, /terminated|abort/i);
    assert.deepEqual((await readdir(scratchDir)).filter((f) => f !== "apply-update.log"), [], `${name}: the half download is removed`);
  }
});

/* ---------- Windows: the swap is two renames, and what is kept survives it ---------- */

// Its own program name, so the script's "is Branch still running" checks never see a real Branch on the machine.
const testExe = "Branch Agent Test.exe";
async function windowsInstall(root) {
  const install = join(root, "Programs", "Branch Agent");
  const write = async (dir, marker) => {
    await mkdir(join(dir, "resources", "app"), { recursive: true });
    await writeFile(join(dir, testExe), marker);
    await writeFile(join(dir, "resources", "version.txt"), marker);
    await writeFile(join(dir, "resources", "app", "package.json"), JSON.stringify({
      name: "branch-agent", version: marker === "new" ? "2.0.0" : "1.0.0",
    }));
  };
  await write(install, "old");
  await writeFile(join(install, "Uninstall Branch Agent.cmd"), "@echo off");
  await writeFile(join(install, "portable.txt"), "");
  await mkdir(join(install, "Branch Data", "state"), { recursive: true });
  await writeFile(join(install, "Branch Data", "state", "branch.sqlite"), "the person's work");
  const bytes = Buffer.from("zip");
  const digest = createHash("sha256").update(bytes).digest("hex");
  const fetch = async (url) => String(url).includes("releases/latest")
    ? Response.json({ tag_name: "v2.0.0", name: null, body: "", published_at: null, html_url: "https://github.com/x/y/releases/tag/v2.0.0",
      assets: [{ name: "app.zip", browser_download_url: "https://example.invalid/app.zip", size: 3 },
        { name: "app.zip.sha256", browser_download_url: "https://example.invalid/app.sha256", size: 64 }] })
    : String(url).endsWith("app.zip") ? new Response(bytes) : new Response(`${digest}  app.zip\n`);
  const updater = new Updater({ lastReleaseWithoutProvenance: "2.0.0", repo: "x/y", currentVersion: "1.0.0", installDir: install, executableName: testExe,
    assetName: "app.zip", scratchDir: join(root, "scratch"), fetch, platform: "win32", runOnceKey: testRunOnce,
    extract: async (_archive, into) => write(join(into, "Branch Agent-win32-x64"), "new") });
  const { script } = await updater.install();
  return { install, script, recover: join(root, "scratch", "recover-update.cmd") };
}
// Its own key, so a test never registers anything to run at the next real sign-in.
const testRunOnce = "HKCU\\Software\\BranchAgentTest\\RunOnce";
const armed = () => new Promise((resolve) => {
  spawn("reg.exe", ["query", testRunOnce, "/v", "Branch Agent update recovery"], { stdio: "ignore", windowsHide: true }).on("close", (code) => resolve(code === 0));
});
const clearTestKey = () => new Promise((resolve) => {
  spawn("reg.exe", ["delete", "HKCU\\Software\\BranchAgentTest", "/f"], { stdio: "ignore", windowsHide: true }).on("close", resolve);
});
const runCmd = (script, args) => new Promise((resolve) => {
  spawn("cmd.exe", ["/d", "/c", script, ...args], { stdio: "ignore", windowsHide: true }).on("close", resolve);
});
const whole = async (dir) => {
  const [exe, version] = [await read(join(dir, testExe)), await read(join(dir, "resources", "version.txt"))];
  return exe === version ? exe : `mixed (${exe}/${version})`;
};

test("Windows: the new version swaps in by renaming, and keeps the uninstaller and portable data", { skip: process.platform !== "win32" && "cmd.exe" }, async (t) => {
  const root = await scratch(t);
  const { install, script } = await windowsInstall(root);
  assert.equal(await runCmd(script, ["999999", "stay"]), 0);
  assert.equal(await whole(install), "new");
  assert.equal(await whole(`${install}.previous`), "old");
  assert.ok(existsSync(join(install, "Uninstall Branch Agent.cmd")), "the uninstaller Add or remove programs runs is still there");
  assert.ok(existsSync(join(install, "portable.txt")));
  assert.equal(await read(join(install, "Branch Data", "state", "branch.sqlite")), "the person's work");
  assert.equal(existsSync(`${install}.incoming`), false);
  assert.equal(await armed(), false, "nothing is left to run at the next sign-in");
});

test("Windows: going back keeps the person's data and the uninstaller in the program folder", { skip: process.platform !== "win32" && "cmd.exe" }, async (t) => {
  const { windowsRollbackScript } = await import("../dist/desktop/hand-over.js");
  const root = await scratch(t);
  t.after(clearTestKey);
  const { install, script } = await windowsInstall(root);
  assert.equal(await runCmd(script, ["999999", "stay"]), 0);
  const back = join(root, "rollback.cmd");
  await writeFile(back, windowsRollbackScript({ install, exe: join(install, testExe), log: join(root, "rollback.log") }));
  assert.equal(await runCmd(back, ["999999", "stay"]), 0);
  assert.equal(await whole(install), "old");
  assert.equal(await read(join(install, "Branch Data", "state", "branch.sqlite")), "the person's work");
  assert.ok(existsSync(join(install, "Uninstall Branch Agent.cmd")));
  assert.ok(existsSync(join(install, "portable.txt")));
});

test("Windows: an update cut off after any step leaves a whole version to start", { skip: process.platform !== "win32" && "cmd.exe" }, async (t) => {
  const root = await scratch(t);
  t.after(clearTestKey);
  const probe = await windowsInstall(join(root, "probe"));
  const lines = (await readFile(probe.script, "utf8")).split("\r\n");
  // Only the steps from the copy on can leave anything half-done; the waits before them change nothing.
  const from = lines.indexOf(":copy");
  const steps = lines.map((line, index) => [line, index]).filter(([line, index]) => index > from && /robocopy|^move|^rmdir|^if exist|^copy/.test(line)).map(([, index]) => index);
  assert.ok(steps.length >= 6);
  for (const cut of steps) {
    const { install, script, recover } = await windowsInstall(join(root, `cut-${cut}`));
    const text = (await readFile(script, "utf8")).split("\r\n");
    text.splice(cut + 1, 0, "exit /b 9");
    await writeFile(script, text.join("\r\n"));
    await runCmd(script, ["999999", "stay"]);
    // Cut off with no program folder, the recovery registered for the next sign-in puts one back.
    if (!existsSync(install)) {
      assert.ok(await armed(), `after "${lines[cut]}": the recovery is registered`);
      await runCmd(recover, []);
    }
    const now = await whole(install).catch(() => null);
    const kept = await whole(`${install}.previous`).catch(() => null);
    assert.ok(now === "old" || now === "new", `after "${lines[cut]}": ${now}, previous ${kept}`);
    if (now !== null) assert.equal(await read(join(install, "Branch Data", "state", "branch.sqlite")) ?? await read(join(`${install}.previous`, "Branch Data", "state", "branch.sqlite")), "the person's work");
  }
});

/* ---------- the one-step installer over a copy that is still open ---------- */

async function installerFixture(root) {
  const source = join(root, "unpacked"), installRoot = join(root, "Programs", "Branch Agent");
  await mkdir(join(source, "resources", "app"), { recursive: true });
  await writeFile(join(source, "Branch Agent.exe"), "new program");
  await mkdir(installRoot, { recursive: true });
  await writeFile(join(installRoot, "Branch Agent.exe"), "old program");
  const options = { source, installRoot, executableName: "Branch Agent.exe", version: "9.9.9", startMenuDir: join(root, "StartMenu"),
    desktopDir: null, uninstallHive: "HKCU\\Software\\BranchAgentTest\\none", userDataDir: join(root, "AppData", "Branch Agent"), legacyDataDirs: [] };
  return { options, installRoot };
}
const noTools = async () => ({ stdout: "", stderr: "" });

test("installing over a Branch that is still open closes it through its own route first, or says so and changes nothing", async (t) => {
  const { performInstall } = await import("../dist/install/installer.js");
  const root = await scratch(t);
  // It will not close (0.17.0 has no route to be asked through): plain words, and nothing touched.
  const stuck = await installerFixture(join(root, "stuck"));
  const asked = [];
  await assert.rejects(performInstall(stuck.options, { run: noTools, locked: async () => false,
    quit: async (dataDir) => { asked.push(dataDir); return { stopped: false, wasRunning: true, pid: 42, message: "did not close" }; } }),
  (error) => /^Branch Agent is still open, so it was not replaced\. Nothing was changed\./.test(error.message) && !/EPERM|unlink/.test(error.message));
  assert.deepEqual(asked, [join(root, "stuck", "AppData", "Branch Agent", "state")], "the running copy of this install's data is the one asked");
  assert.equal(await read(join(stuck.installRoot, "Branch Agent.exe")), "old program");
  assert.equal(existsSync(`${stuck.installRoot}.previous`), false);
  // Nothing says it runs, but Windows holds the program file open: the same plain answer.
  const held = await installerFixture(join(root, "held"));
  await assert.rejects(performInstall(held.options, { run: noTools, locked: async () => true,
    quit: async () => ({ stopped: true, wasRunning: false, pid: null, message: "not running" }) }), /still open, so it was not replaced/);
  assert.equal(await read(join(held.installRoot, "Branch Agent.exe")), "old program");
  // It closes when asked, and its helper processes let go of the program a moment later: the install goes ahead.
  const closes = await installerFixture(join(root, "closes"));
  let holds = 3;
  const report = await performInstall(closes.options, { run: noTools, locked: async () => holds-- > 0, lockPauseMs: 1,
    quit: async () => ({ stopped: true, wasRunning: true, pid: 42, message: "Branch Agent has closed." }) });
  assert.equal(await read(join(closes.installRoot, "Branch Agent.exe")), "new program");
  assert.equal(report.closedFirst, true);
});
