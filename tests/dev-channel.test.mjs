/* The Dev update channel (src/desktop/dev-build.ts, src/desktop/updater.ts): like Hermes Desktop, the newest merged
   change is built on this computer. Stand-ins for git, npm, unpacking and the network: nothing is cloned, built,
   downloaded, installed or opened here. */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, writeFile, access, symlink, chmod, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { Updater, compareVersions } from "../dist/desktop/updater.js";
import { devBranch, buildEnv, buildDev, stampDevVersion } from "../dist/desktop/dev-build.js";
import { protectedAreas, protectedTarget } from "../dist/never-break/protected.js";
import { updatePlan, betaCheckEveryMs } from "../dist/comfort/auto-update.js";
import { buildInfo } from "../scripts/package-desktop.mjs";

const repo = "stabrea/Branch-Agent", assetName = "Branch-Agent-windows-x64.zip", exe = "Branch Agent.exe";
const NEW = "a".repeat(40), OLD = "b".repeat(40), COMMITTED = 1758600000, BUILT = `0.19.3-dev.${COMMITTED}-g${NEW.slice(0, 12)}`;
const exists = (path) => access(path).then(() => true, () => false);

async function folders(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-dev-channel-"));
  t.after(() => discardTemp(root));
  const installDir = join(root, "installed"), scratchDir = join(root, "scratch"), sourceDir = join(root, "scratch", "dev-source");
  await mkdir(installDir, { recursive: true });
  await writeFile(join(installDir, exe), "the installed app");
  return { root, installDir, sourceDir, scratchDir };
}

/**
 * A git and npm that answer like the real ones, write what a real build writes, and record every call.
 * `running`: whether the clone knows the running change ("here"), learns it by fetching it ("fetched"), or never ("gone").
 * `shared`: what merge-base answers (the running change when the offered one contains it), or null for a failed check.
 * `standing` (dogfood F5): what the check's history folder says: "behind", "ahead", "apart", or "unreadable". Its calls
 * go to `history`, so `calls` stays the build's own.
 */
function fakeTools(where, { missing = [], head = NEW, headAfterReset = head, failOn = null, tamper = false, running = "here", shared = OLD, stampless = false, standing = "behind" } = {}) {
  const calls = [], history = [], inHistory = new Set(), walled = [];
  let knows = running === "here";
  const run = async (file, args, options) => {
    const plain = [];
    for (let at = 0; at < args.length; at++) { if (args[at] === "-c") { at++; continue; } plain.push(args[at]); }
    const line = [file, ...plain].join(" ");
    if (line.startsWith("git init") || options.cwd === join(where.scratchDir, "dev-history")) {
      history.push(line);
      if (!line.startsWith("git init")) walled.push(args.includes("protocol.allow=never") && args.includes("core.hooksPath=/dev/null")
        && args.includes("http.followRedirects=initial") && options.env?.GIT_ALLOW_PROTOCOL === "https");
      if (standing === "unreadable" && !line.startsWith("git init")) throw new Error(`${line} did not finish.`);
      // A new history folder knows no change until it is fetched.
      if (line.startsWith("git fetch")) inHistory.add(args.at(-1));
      if (line.startsWith("git cat-file") && !inHistory.has(args.at(-1).replace("^{commit}", ""))) throw new Error("git cat-file did not finish.");
      if (line.startsWith("git merge-base")) {
        // The shared change: the running one when the head includes it, the head when the running one includes that.
        if (standing === "walk-fails") throw new Error("git merge-base did not finish.");
        return `${standing === "behind" ? OLD : standing === "ahead" ? head : "c".repeat(40)}\n`;
      }
      return "";
    }
    calls.push(line);
    if (args[0] === "--version") { if (missing.includes(file)) throw new Error("not found"); return "1.0"; }
    if (failOn && line.includes(failOn)) throw new Error(`${failOn} did not finish.`);
    if (line.startsWith("git ls-remote")) return `${head}\trefs/heads/${devBranch}\n`;
    if (line.startsWith("git clone")) { await mkdir(join(where.sourceDir, ".git"), { recursive: true }); return ""; }
    if (line.startsWith("git reset")) { // the committed tree: canonical's own version, the lockfile agreeing
      await writeFile(join(where.sourceDir, "package.json"), JSON.stringify({ name: "branch-agent", version: "0.19.2" }));
      await writeFile(join(where.sourceDir, "package-lock.json"), JSON.stringify({ name: "branch-agent", version: "0.19.2", packages: { "": { version: "0.19.2" } } }));
      return "";
    }
    if (line.startsWith("git cat-file")) { if (!knows) throw new Error("git cat-file did not finish."); return ""; }
    if (line.startsWith(`git fetch --no-tags origin ${OLD}`)) { if (running === "fetched") knows = true; return ""; }
    if (line.startsWith("git merge-base")) { if (shared === null) throw new Error("git merge-base did not finish."); return `${shared}\n`; }
    if (line.startsWith("git show")) return `${COMMITTED}\n`;
    if (line.startsWith("git rev-parse")) return `${headAfterReset}\n`;
    if (line.startsWith("npm run package:desktop")) {
      // The download carries the version the source was stamped with, as a real one does inside it.
      const { version } = JSON.parse(await readFile(join(options.cwd, "package.json"), "utf8"));
      await mkdir(join(options.cwd, "release"), { recursive: true });
      await mkdir(join(options.cwd, "dist"), { recursive: true });
      if (stampless === false) await writeFile(join(options.cwd, "dist", "build-info.json"), JSON.stringify({ commit: NEW, builtAt: "2026-09-23T00:00:00Z" }));
      const zip = join(options.cwd, "release", assetName);
      await writeFile(zip, version);
      const digest = createHash("sha256").update(tamper ? "something else" : version).digest("hex");
      await writeFile(`${zip}.sha256`, `${digest}  ${assetName}\n`);
    }
    return "";
  };
  return { run, calls, history, walled };
}
/** Unpacking the built zip: the app folder with the package identity inside the download. */
const extract = async (archive, into) => {
  const version = await readFile(archive, "utf8");
  const app = join(into, "Branch Agent");
  await mkdir(join(app, "resources", "app"), { recursive: true });
  await writeFile(join(app, exe), "the new app");
  await writeFile(join(app, "resources", "app", "package.json"), JSON.stringify({ name: "branch-agent", version }));
};
const noNetwork = async (url) => { throw new Error(`the Dev channel must not call ${url}`); };
const updater = (where, tools, extra = {}) => new Updater({ repo, currentVersion: "0.19.3-beta.3", channel: "dev", installDir: where.installDir,
  executableName: exe, assetName, scratchDir: where.scratchDir, platform: "win32", fetch: noNetwork, extract,
  devRun: tools.run, currentCommit: OLD, runOnceKey: "HKCU\\Software\\BranchTest\\RunOnce", ...extra });
const building = (calls) => calls.filter((call) => !call.endsWith("--version") && !call.startsWith("git ls-remote"));

test("Dev says plainly when git or Node is missing, and looks nothing up", async (t) => {
  const where = await folders(t), tools = fakeTools(where, { missing: ["git", "npm"] });
  const status = await updater(where, tools).check();
  assert.equal(status.phase, "error");
  assert.match(status.message, /git, npm were not found\. Install git and Node\.js/);
  assert.equal(tools.calls.some((call) => call.startsWith("git ls-remote")), false);
});

test("Dev offers the newest merged change when it is not the one running, read with git, not GitHub's web API", async (t) => {
  const where = await folders(t), tools = fakeTools(where);
  const status = await updater(where, tools).check();
  assert.equal(status.phase, "available");
  assert.equal(status.message, "A newer Dev build (change aaaaaaa) can be built and installed.");
  assert.ok(tools.calls.includes(`git ls-remote https://github.com/${repo}.git refs/heads/${devBranch}`));
  const same = await updater(where, fakeTools(where, { head: OLD })).check();
  assert.equal(same.phase, "current");
  assert.equal(same.message, "You have the newest Dev build (change bbbbbbb).");
});

// Dogfood F5: Legion ran a build ahead of the main line, and "Check for updates" still called the main line's older head
// "a newer Dev build" that could be installed. The check now reads the history, as the build's never-go-back step does.
test("F5 a copy ahead of the main line is told so, and the older head is not offered", async (t) => {
  const where = await folders(t), tools = fakeTools(where, { standing: "ahead" });
  const status = await updater(where, tools).check();
  assert.equal(status.phase, "current", status.message);
  // The line's head does not contain this copy's change: another line of work, installed only on the owner's confirmation.
  assert.equal(status.message, "The newest change on mac/cross-platform (aaaaaaa) does not include this copy's change (bbbbbbb), so it is a different line of work, not a newer version of this one. It is installed only if you confirm it in Settings › Updates, and a safety copy of your work is kept first.");
  assert.equal(status.release.available, false);
  assert.equal(status.release.otherLine, true);
  assert.ok(tools.history.includes(`git fetch --quiet --filter=tree:0 --no-tags https://github.com/${repo}.git ${NEW}`), tools.history.join("\n"));
  assert.ok(tools.history.includes(`git merge-base ${OLD} ${NEW}`), "the history decides, not the ids differing");
  assert.ok(tools.walled.length && tools.walled.every(Boolean), "every history call runs behind the walls (NAS cfc3808)");
  assert.ok(tools.history.includes(`git update-ref refs/branch/head ${NEW}`) && tools.history.includes(`git update-ref refs/branch/running ${OLD}`),
    "both changes are kept by name, so the next look fetches only what is new");
  assert.equal(building(tools.calls).length, 0, "a check builds nothing");
  const apart = await updater(where, fakeTools(where, { standing: "apart" })).check();
  assert.equal(apart.phase, "current");
  assert.match(apart.message, /does not include this copy's change \(bbbbbbb\), so it is a different line of work/);
  assert.equal(apart.release.available, false);
  const behind = await updater(where, fakeTools(where)).check();
  assert.equal(behind.phase, "available", "the main line's head that includes this copy is still offered");
  const unreadable = await updater(where, fakeTools(where, { standing: "unreadable" })).check();
  assert.equal(unreadable.phase, "available", "without the history, the build's own never-go-back step still decides");
  // NAS cfc3808: a walk that fails is unknown, not "apart" (which would hide the update and say it goes back).
  const failed = await updater(where, fakeTools(where, { standing: "walk-fails" })).check();
  assert.equal(failed.phase, "available", failed.message);
});

// NAS cfc3808: a link planted where the history goes sent the fetch into another folder. It is never followed.
test("F5 a link where the history folder goes is never followed, and the answer is left unknown", async (t) => {
  const where = await folders(t);
  const elsewhere = join(where.root, "elsewhere");
  await mkdir(elsewhere, { recursive: true });
  await mkdir(where.scratchDir, { recursive: true });
  await symlink(elsewhere, join(where.scratchDir, "dev-history"), "dir");
  const tools = fakeTools(where, { standing: "ahead" });
  const status = await updater(where, tools).check();
  assert.equal(status.phase, "available", "unknown: the build's own step decides, as before");
  assert.equal(tools.history.filter((line) => !line.startsWith("git init")).length, 0, "no git ran through the link");
  assert.deepEqual(await readdir(elsewhere), [], "and nothing was written where it pointed");
});

// Q211 (NAS 67718a5): on macOS and Linux the check makes the updater's folder private before it keeps history there,
// and a folder that is not safe (a link) leaves the answer unknown with no git run at all.
test("F5 on macOS and Linux the check keeps its history only in a private folder", { skip: process.platform === "win32" }, async (t) => {
  const where = await folders(t);
  await mkdir(where.scratchDir, { recursive: true });
  await chmod(where.scratchDir, 0o777);
  const tools = fakeTools(where, { standing: "ahead" });
  const status = await updater(where, tools, { platform: process.platform }).check();
  assert.equal(status.phase, "current", status.message);
  assert.equal((await stat(where.scratchDir)).mode & 0o777, 0o700, "the folder is closed to everyone else first");
  const linked = await folders(t);
  const elsewhere = join(linked.root, "elsewhere");
  await mkdir(elsewhere, { recursive: true });
  await symlink(elsewhere, linked.scratchDir, "dir");
  const through = fakeTools(linked, { standing: "ahead" });
  const unsafe = await updater(linked, through, { platform: process.platform }).check();
  assert.equal(unsafe.phase, "available", "unknown: the build's own step decides");
  assert.deepEqual(through.history, [], "no git ran in a folder that is not safe");
  assert.deepEqual(await readdir(elsewhere), [], "and nothing was written where it pointed");
});

/* The Update button names KeepOak/Branch-Agent, which does not exist until the move, and git cannot fall back on a
   404 the way the release lookup does: asking it fails as a sign-in prompt. So Dev reads and builds the name Branch
   has now, which GitHub keeps sending on after the move (NAS 4896293). */
test("Dev reads and builds Branch's current name even when the Update button names the new one", async (t) => {
  const where = await folders(t), tools = fakeTools(where);
  const dev = updater(where, tools, { repo: "KeepOak/Branch-Agent", canary: async () => {} });
  const status = await dev.check();
  assert.equal(status.phase, "available", status.message);
  assert.ok(tools.calls.includes(`git ls-remote https://github.com/stabrea/Branch-Agent.git refs/heads/${devBranch}`), tools.calls.join("\n"));
  assert.equal(status.release.pageUrl, `https://github.com/stabrea/Branch-Agent/commit/${NEW}`);
  await dev.install();
  assert.ok(tools.calls.some((call) => call.startsWith(`git clone --no-tags --single-branch --branch ${devBranch} https://github.com/stabrea/Branch-Agent.git `)));
  assert.equal(tools.calls.some((call) => call.includes("KeepOak")), false, "git is never pointed at the new name");
});

test("installing a Dev build clones afresh in the updater's own folder, proves it goes forward, builds, and hands over", async (t) => {
  const where = await folders(t), tools = fakeTools(where), checked = [];
  const dev = updater(where, tools, { canary: async (_dir, version) => { checked.push(version); } });
  await dev.check();
  const { script, stagedDir } = await dev.install();
  assert.deepEqual(building(tools.calls), [
    `git clone --no-tags --single-branch --branch ${devBranch} https://github.com/${repo}.git ${where.sourceDir}`,
    `git reset --hard ${NEW}`, "git rev-parse HEAD", `git cat-file -e ${OLD}^{commit}`, `git merge-base ${OLD} ${NEW}`,
    "npm ci --no-audit --no-fund", `git show -s --format=%ct ${NEW}`, "npm run package:desktop -- --release",
  ]);
  assert.deepEqual(checked, [BUILT], "the new version's check expects the version the source was built as, not the running one");
  assert.equal(dev.status.release.latestVersion, BUILT, "the update's record and the next start expect the built version");
  assert.equal(await readFile(join(where.scratchDir, assetName), "utf8"), BUILT, "the download sits where a downloaded one would");
  assert.equal(await exists(where.sourceDir), false, "the source is gone once the download is out of it");
  assert.match(await readFile(script, "utf8"), /robocopy/i, "the same hand-over as a downloaded release");
  assert.ok((await readdir(stagedDir)).includes(exe));
  assert.equal(await readFile(join(where.installDir, exe), "utf8"), "the installed app", "nothing is swapped until the hand-over runs");
  const again = fakeTools(where);
  await updater(where, again).install();
  assert.ok(again.calls.some((call) => call.startsWith("git clone")), "the next build clones afresh too: nothing is reused");
});

test("the folder a Dev build clones into is one the assistant may never change", async () => {
  const areas = protectedAreas({ workspace: join(tmpdir(), "some-workspace"), dataDir: join(tmpdir(), "some-data") });
  const target = join(tmpdir(), "branch-agent-update", "dev-source", ".git", "config");
  assert.notEqual(protectedTarget({ tool: "files.write", readOnly: false, args: { path: target }, target, workspace: areas.workspace }, areas), null);
  const ordinary = join(tmpdir(), "some-workspace", "project", ".git", "config");
  assert.equal(protectedTarget({ tool: "files.write", readOnly: false, args: { path: ordinary }, target: ordinary, workspace: areas.workspace }, areas), null,
    "the control: a task's own checkout stays usable");
});

test("a Dev build refuses to start in a folder that already holds something", async (t) => {
  const where = await folders(t), tools = fakeTools(where);
  await mkdir(join(where.sourceDir, ".git"), { recursive: true });
  await assert.rejects(buildDev(tools.run, { repo, sourceDir: where.sourceDir, commit: NEW, running: OLD, assetName, onPhase: () => {} }),
    /was not empty, so nothing was built/);
  assert.deepEqual(tools.calls, [], "no git command ran against it");
});

test("a Dev build that fails, lands elsewhere, cannot show it goes forward, or comes out incomplete changes nothing", async (t) => {
  for (const [name, options, words] of [
    ["npm ci fails", { failOn: "npm ci" }, /npm ci did not finish/],
    ["the source is not the change looked up", { headAfterReset: OLD }, /did not arrive at the change that was looked up/],
    ["the build's checksum does not match", { tamper: true }, /came out incomplete/],
    ["the newest change does not contain the running one", { shared: "c".repeat(40) }, /does not include the version running now \(change bbbbbbb\), so installing it would go back/],
    ["the running change cannot be found, even fetched by its id", { running: "gone" }, /could not find the change the version running now was built from \(bbbbbbb\)/],
    ["the history check itself fails", { shared: null }, /would go back/],
    ["the built app does not say which change it is", { stampless: true }, /does not record which change it was made from/],
  ]) {
    const where = await folders(t), tools = fakeTools(where, options);
    const dev = updater(where, tools);
    await dev.check();
    await assert.rejects(dev.install(), words, name);
    assert.equal(dev.status.phase, "error", name);
    assert.equal(await readFile(join(where.installDir, exe), "utf8"), "the installed app", name);
    if (!/npm ci/.test(name) && !["the build's checksum does not match", "the built app does not say which change it is"].includes(name))
      assert.equal(tools.calls.includes("npm ci --no-audit --no-fund"), false, `${name}: stopped before building`);
  }
});

test("a running change the clone lacks is fetched by its id, and then the history decides", async (t) => {
  const where = await folders(t), tools = fakeTools(where, { running: "fetched" });
  const dev = updater(where, tools);
  await dev.check();
  await dev.install();
  assert.ok(tools.calls.includes(`git fetch --no-tags origin ${OLD}`));
  assert.ok(tools.calls.includes(`git merge-base ${OLD} ${NEW}`));
});

test("without the running change on record, its version decides whether the build would go back", async (t) => {
  const where = await folders(t);
  const older = updater(where, fakeTools(where), { currentCommit: null, currentVersion: "0.19.3" });
  await older.check();
  await assert.rejects(older.install(), /is older than the version running now \(0\.19\.3\)/);
  assert.equal(await readFile(join(where.installDir, exe), "utf8"), "the installed app");
  const control = updater(where, fakeTools(where), { currentCommit: null, currentVersion: "0.19.3-beta.3" });
  await control.check();
  await control.install();
});

test("Dev looks every five minutes and, with update by itself on, installs each change once nothing is working", () => {
  const saved = (releaseChannel) => ({ get: (table, _owner, key) =>
    (table === "settings" && key === "comfort-notify" ? { data: { autoUpdate: "install", releaseChannel } } : undefined) });
  const facts = { busyTasks: 0, updaterPhase: "available", now: new Date() };
  assert.equal(updatePlan(saved("beta"), "local", facts).step, "install", "the control: Beta with the same facts installs");
  assert.equal(updatePlan(saved("dev"), "local", facts).step, "install", "an available Dev build is installed, so fixes are seen live");
  assert.equal(updatePlan(saved("dev"), "local", { ...facts, busyTasks: 1 }).step, "nothing", "but never while a task is working");
  assert.equal(betaCheckEveryMs, 5 * 60 * 1000);
});

test("every packaged build records the change it was made from", () => {
  assert.equal(buildInfo({ GITHUB_SHA: NEW }, () => "").commit, NEW);
  assert.equal(buildInfo({}, () => `${OLD}\n`).commit, OLD);
  assert.equal(buildInfo({}, () => "not a commit").commit, null);
});

test("each Dev build's version names its change: two made in the same second differ; Beta below, Stable above", async (t) => {
  const where = await folders(t);
  const stamp = async (commit) => {
    await mkdir(where.sourceDir, { recursive: true });
    await writeFile(join(where.sourceDir, "package.json"), JSON.stringify({ name: "branch-agent", version: "0.19.2" }));
    await writeFile(join(where.sourceDir, "package-lock.json"), JSON.stringify({ name: "branch-agent", version: "0.19.2", packages: { "": { version: "0.19.2" } } }));
    const version = await stampDevVersion(where.sourceDir, COMMITTED, commit);
    const lock = JSON.parse(await readFile(join(where.sourceDir, "package-lock.json"), "utf8"));
    assert.deepEqual([lock.version, lock.packages[""].version], [version, version], "stamped like Beta: the package and its lockfile agree");
    return version;
  };
  const one = await stamp(NEW), two = await stamp(OLD);
  assert.equal(one, BUILT);
  assert.notEqual(one, two, "the update's record can tell two same-second builds apart");
  assert.equal(one.split(".").length, 4, "the Windows packager takes at most four dotted parts");
  assert.equal(compareVersions(one, "0.19.3-beta.999"), 1, "switching back to Beta never offers the same line's older builds");
  assert.equal(compareVersions("0.19.3", one), 1, "the Stable release of that line is newer than any of its Dev builds");
});

test("the build never sees the running app's own switches, and never waits on a password prompt", () => {
  const env = buildEnv({ PATH: "/usr/bin", HOME: "/Users/me", BRANCH_DATA_DIR: "/data", BRANCH_MOBILE_OUT: "/x", ELECTRON_RUN_AS_NODE: "1" }, "darwin");
  assert.deepEqual(Object.keys(env).filter((key) => /^(BRANCH|ELECTRON)_/.test(key)), []);
  assert.equal(env.HOME, "/Users/me");
  assert.equal(env.GIT_TERMINAL_PROMPT, "0");
  assert.equal(env.GIT_NO_LAZY_FETCH, "1", "a missing commit is never fetched lazily with all its trees (NAS cfc3808)");
  assert.equal(env.PATH, "/opt/homebrew/bin:/usr/local/bin:/usr/bin");
  assert.equal(buildEnv({ Path: "C:/x" }, "win32").GCM_INTERACTIVE, "never");
});

/* The line of work the Dev channel follows (src/dev-lines.ts): the owner's choice between the repository's own lines,
   checked against that list before git sees it; moving to a line whose head lacks the running change needs the
   owner's confirmation of that exact change in the window, and update by itself never gives it. */
test("Dev follows the line chosen: git asks for that line's head and clones that line", async (t) => {
  const where = await folders(t), tools = fakeTools(where);
  const dev = updater(where, tools, { devLine: "redesign/window", canary: async () => {} });
  const status = await dev.check();
  assert.equal(status.phase, "available", status.message);
  assert.equal(status.release.line, "redesign/window");
  assert.ok(tools.calls.includes(`git ls-remote https://github.com/${repo}.git refs/heads/redesign/window`), tools.calls.join("\n"));
  await dev.install();
  assert.ok(tools.calls.some((call) => call.startsWith(`git clone --no-tags --single-branch --branch redesign/window https://github.com/${repo}.git `)));
  assert.equal(tools.calls.some((call) => call.includes(devBranch)), false, "the main line is never asked for");
});

test("a line that is not one of Branch's own is refused before git runs", async (t) => {
  const where = await folders(t), tools = fakeTools(where);
  for (const line of ["main", "refs/heads/redesign/window", "--upload-pack=touch /tmp/x", "https://example.com/other.git", ""])
    assert.throws(() => updater(where, tools, { devLine: line }), /not one of Branch's lines of work/, line);
  const dev = updater(where, tools);
  assert.throws(() => dev.setChannel("dev", "--upload-pack=x"), /not one of Branch's lines of work/);
  assert.equal(dev.selectedLine, devBranch, "a refused line leaves the one chosen before");
  await assert.rejects(buildDev(tools.run, { repo, sourceDir: where.sourceDir, commit: NEW, running: OLD, assetName, onPhase: () => {}, line: "main" }),
    /not one of Branch's lines of work/);
  assert.deepEqual(tools.calls, [], "no git command ran for any of them");
});

test("changing the line is changing the channel: what was looked up on the other line is dropped", async (t) => {
  const where = await folders(t), tools = fakeTools(where);
  const dev = updater(where, tools, { canary: async () => {} });
  assert.equal((await dev.check()).release.line, devBranch);
  const moved = dev.setChannel("dev", "redesign/window");
  assert.equal(moved.phase, "idle");
  assert.equal(moved.release, null, "the main line's change is no longer the one on offer");
  await dev.install();
  const asked = tools.calls.filter((call) => call.startsWith("git ls-remote"));
  assert.equal(asked.at(-1), `git ls-remote https://github.com/${repo}.git refs/heads/redesign/window`, "the install looked up the new line again");
  assert.ok(tools.calls.some((call) => call.includes("--branch redesign/window")));
});

test("another line of work is never installed without the owner's confirmation of its exact change", async (t) => {
  for (const standing of ["apart", "ahead"]) {
    // `shared` makes the build's own never-go-back step fail, so only a confirmed move can get past it.
    const where = await folders(t), tools = fakeTools(where, { standing, shared: "c".repeat(40) });
    const dev = updater(where, tools, { devLine: "redesign/window", canary: async () => {} });
    const status = await dev.check();
    assert.equal(status.release.otherLine, true, standing);
    assert.equal(status.release.available, false, `${standing}: never offered as newer, so update by itself never installs it`);
    await assert.rejects(dev.install(), /There is no newer version to install/, standing);
    await assert.rejects(dev.install({ confirm: "d".repeat(40) }), /no longer the newest one on that line of work/, standing);
    await assert.rejects(dev.install({ confirm: "not a commit" }), /Only a Dev change of another line of work can be confirmed/, standing);
    assert.equal(building(tools.calls).length, 0, `${standing}: nothing was built without the confirmation`);
    await dev.install({ confirm: NEW });
    assert.ok(tools.calls.some((call) => call.startsWith("git clone") && call.includes("--branch redesign/window")), standing);
    assert.equal(tools.calls.includes(`git merge-base ${OLD} ${NEW}`), false, `${standing}: the confirmed move skips only the never-go-back step`);
    assert.equal(dev.status.phase, "ready", standing);
  }
});

test("a confirmation is refused for a change that is a newer version of this one, and off the Dev channel", async (t) => {
  const where = await folders(t);
  const dev = updater(where, fakeTools(where));
  await dev.check();
  await assert.rejects(dev.install({ confirm: NEW }), /no longer the newest one on that line of work/, "a newer version needs no confirmation and takes none");
  const stable = updater(where, fakeTools(where), { channel: "stable" });
  await assert.rejects(stable.install({ confirm: NEW }), /Only a Dev change of another line of work can be confirmed/);
});
