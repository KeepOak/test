/* The Dev update channel (src/desktop/dev-build.ts, src/desktop/updater.ts): like Hermes Desktop, the newest merged
   change is built on this computer. Stand-ins for git, npm, unpacking and the network: nothing is cloned, built,
   downloaded, installed or opened here. */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, writeFile, access, symlink, chmod, stat, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { Updater, compareVersions } from "../dist/desktop/updater.js";
import { betaLine, newestGreen, wholeSuiteWorkflow, buildEnv, buildDev, buildGitConfig, keyLine, packageSteps, packagesNeeded, staleOutputs, stampDevVersion } from "../dist/desktop/dev-build.js";
import { protectedAreas, protectedTarget } from "../dist/never-break/protected.js";
import { updatePlan, betaCheckEveryMs } from "../dist/comfort/auto-update.js";
import { buildInfo } from "../scripts/package-desktop.mjs";

const repo = "stabrea/Branch-Agent", assetName = "Branch-Agent-windows-x64.zip", exe = "Branch Agent.exe";
const NEW = "a".repeat(40), OLD = "b".repeat(40), COMMITTED = 1758600000, BUILT = `0.19.3-dev.${COMMITTED}-g${NEW.slice(0, 12)}`;
const exists = (path) => access(path).then(() => true, () => false);

async function folders(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-dev-channel-"));
  t.after(() => discardTemp(root));
  const installDir = join(root, "installed"), scratchDir = join(root, "scratch");
  // The build's own folder, kept between builds, in the data folder's updates/ (src/desktop/main.ts betaBuildDir).
  const buildDir = join(root, "data", "updates", "beta-build"), sourceDir = join(buildDir, "source");
  await mkdir(installDir, { recursive: true });
  await writeFile(join(installDir, exe), "the installed app");
  return { root, installDir, sourceDir, scratchDir, buildDir };
}

/**
 * A git and npm that answer like the real ones, write what a real build writes, and record every call.
 * `running`: whether the build's history knows the running change ("here"), learns it by fetching it ("fetched"), or never ("gone").
 * `shared`: what merge-base answers (the running change when the offered one contains it), or null for a failed check.
 * `standing` (dogfood F5): what the check's history folder says: "behind", "ahead", "apart", or "unreadable". Its calls
 * go to `history`, so `calls` stays the build's own.
 * `onLine`: whether the looked-up change is on Beta's line as fetched. `lock`: the committed package-lock.json's text.
 * `packaged`: the version the packager writes into the app (the stamped one when not given). `script`: the commit's own
 * `package:desktop` script (Branch's three steps unless given). `compiled`: what package.json said when tsc ran.
 */
function fakeTools(where, { missing = [], head = NEW, headAfterReset = head, failOn = null, tamper = false, running = "here", shared = OLD,
  stampless = false, standing = "behind", onLine = true, lock = "lock-1", node = "v24.14.0", packaged = null, npmCiOutput = null, script = packageSteps } = {}) {
  const calls = [], history = [], inHistory = new Set(), walled = [], buildWalled = [], temps = [], compiled = [];
  let knows = running === "here";
  const run = async (file, args, options) => {
    const plain = [];
    for (let at = 0; at < args.length; at++) { if (args[at] === "-c") { at++; continue; } plain.push(args[at]); }
    const line = [file, ...plain].join(" ");
    if (line.startsWith("git init --quiet --bare") || options.cwd === join(where.scratchDir, "dev-history")) {
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
    if (file === "npm" || (file === "node" && args[0] !== "--version")) if (args[0] !== "--version") temps.push([line, options.env?.TEMP, options.env?.TMP, options.env?.TMPDIR]);
    if (file === "git" && options.cwd === where.sourceDir)
      buildWalled.push(args.includes("protocol.allow=never") && args.includes("core.hooksPath=/dev/null") && options.env?.GIT_ALLOW_PROTOCOL === "https");
    if (args[0] === "--version") {
      if (missing.includes(file)) throw new Error("not found");
      return file === "node" ? `${node}\n` : file === "npm" ? "11.6.0\n" : "1.0";
    }
    if (failOn && line.includes(failOn)) {
      const { RunError } = await import("../dist/desktop/dev-build.js");
      throw new RunError(`${failOn} did not finish.`, npmCiOutput);
    }
    if (line.startsWith("git ls-remote")) return `${head}\trefs/heads/${betaLine}\n`;
    if (line.startsWith("git init --quiet")) { await mkdir(join(where.sourceDir, ".git"), { recursive: true }); return ""; }
    if (line.startsWith("git merge-base --is-ancestor")) { if (!onLine) throw new Error("git merge-base did not finish."); return ""; }
    if (line.startsWith("git checkout")) { // the committed tree: canonical's own version, the lockfile agreeing
      await writeFile(join(where.sourceDir, "package.json"), JSON.stringify({ name: "branch-agent", version: "0.19.2", scripts: { "package:desktop": script } }));
      await writeFile(join(where.sourceDir, "package-lock.json"), JSON.stringify({ name: "branch-agent", version: "0.19.2", packages: { "": { version: "0.19.2" } }, lock }));
      return "";
    }
    if (line.startsWith("git cat-file")) { if (!knows) throw new Error("git cat-file did not finish."); return ""; }
    if (line.startsWith(`git fetch --quiet --no-tags https://github.com/`) && line.endsWith(OLD)) { if (running === "fetched") knows = true; return ""; }
    if (line.startsWith("git merge-base")) { if (shared === null) throw new Error("git merge-base did not finish."); return `${shared}\n`; }
    if (line.startsWith("git show")) return `${COMMITTED}\n`;
    if (line.startsWith("git rev-parse")) return `${headAfterReset}\n`;
    if (line.startsWith("npm ci")) {
      await mkdir(join(options.cwd, "node_modules", "zod"), { recursive: true });
      await writeFile(join(options.cwd, "node_modules", "zod", "index.js"), "installed");
    }
    if (line.startsWith("npm run build") || line.startsWith("npm run package:desktop"))
      compiled.push(JSON.parse(await readFile(join(options.cwd, "package.json"), "utf8")).version);
    if (line.startsWith("npm run package:desktop") || line.startsWith("node scripts/package-desktop.mjs")) {
      // The app carries the version the source was stamped with, as a real one does inside it.
      const { version } = JSON.parse(await readFile(join(options.cwd, "package.json"), "utf8"));
      await mkdir(join(options.cwd, "dist"), { recursive: true });
      if (stampless === false) await writeFile(join(options.cwd, "dist", "build-info.json"), JSON.stringify({ commit: NEW, builtAt: "2026-09-23T00:00:00Z" }));
      const app = join(options.cwd, "release", "Branch Agent-win32-x64");
      await mkdir(join(app, "resources", "app"), { recursive: true });
      await writeFile(join(app, exe), "the new app");
      await writeFile(join(app, "resources", "app", "package.json"), JSON.stringify({ name: "branch-agent", version: packaged ?? version }));
      if (args.includes("--release")) {
        const zip = join(options.cwd, "release", assetName);
        await writeFile(zip, version);
        const digest = createHash("sha256").update(tamper ? "something else" : version).digest("hex");
        await writeFile(`${zip}.sha256`, `${digest}  ${assetName}\n`);
      }
    }
    return "";
  };
  return { run, calls, history, walled, buildWalled, temps, compiled };
}
/** Unpacking a built download (macOS and Linux keep the archive): the app folder with the package identity inside. */
const extract = async (archive, into) => {
  const version = await readFile(archive, "utf8");
  const app = join(into, "Branch Agent");
  await mkdir(join(app, "resources", "app"), { recursive: true });
  await writeFile(join(app, exe), "the new app");
  await writeFile(join(app, "resources", "app", "package.json"), JSON.stringify({ name: "branch-agent", version }));
};
const noNetwork = async (url) => { throw new Error(`the Dev channel must not call ${url}`); };
const updater = (where, tools, extra = {}) => new Updater({ repo, currentVersion: "0.19.3-beta.3", channel: "beta", installDir: where.installDir,
  executableName: exe, assetName, scratchDir: where.scratchDir, platform: "win32", fetch: noNetwork, extract,
  devRun: tools.run, currentCommit: OLD, runOnceKey: "HKCU\\Software\\BranchTest\\RunOnce", backup: async () => {}, canary: async () => {}, devBuildDir: where.buildDir,
  tryOut: async () => null, ...extra });
const building = (calls) => calls.filter((call) => !call.endsWith("--version") && !call.startsWith("git ls-remote"));
/** The build's commands, in order, for a Beta change on its line (the never-go-back step unless `confirmed`). */
const buildSteps = (where, { confirmed = false, fresh = true, npmCi = true, release = false } = {}) => [
  ...(fresh ? [`git init --quiet ${where.sourceDir}`] : []),
  `git fetch --quiet --no-tags --force https://github.com/${repo}.git +refs/heads/${betaLine}:refs/branch/line`,
  `git merge-base --is-ancestor ${NEW} refs/branch/line`, `git checkout --quiet --force --detach ${NEW}`,
  "git clean -ffdxq -e /node_modules/ -e /.build-cache/ -e /dist/", "git rev-parse HEAD",
  ...(confirmed ? [] : [`git cat-file -e ${OLD}^{commit}`, `git merge-base ${OLD} ${NEW}`]),
  `git show -s --format=%ct ${NEW}`,
  ...(npmCi ? ["npm ci --no-audit --no-fund"] : []),
  "npm run build", "node scripts/dependency-notices.mjs", `node scripts/package-desktop.mjs${release ? " --release" : ""}`,
];

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
  assert.equal(status.message, "A newer Beta build (change aaaaaaa) can be built and installed.");
  assert.ok(tools.calls.includes(`git ls-remote https://github.com/${repo}.git refs/heads/${betaLine}`));
  const same = await updater(where, fakeTools(where, { head: OLD })).check();
  assert.equal(same.phase, "current");
  assert.equal(same.message, "You have the newest Beta build (change bbbbbbb).");
});

// Dogfood F5: Legion ran a build ahead of the main line, and "Check for updates" still called the main line's older head
// "a newer Dev build" that could be installed. The check now reads the history, as the build's never-go-back step does.
test("F5 a copy ahead of the main line is told so, and the older head is not offered", async (t) => {
  const where = await folders(t), tools = fakeTools(where, { standing: "ahead" });
  const status = await updater(where, tools).check();
  assert.equal(status.phase, "current", status.message);
  // The line's head does not contain this copy's change: another line of work, installed only on the owner's confirmation.
  assert.equal(status.message, "The newest Beta change (aaaaaaa) does not include this copy's change (bbbbbbb), so it is a different line of work, not a newer version of this one. It is installed only if you confirm it in Settings › Updates, and a safety copy of your work is kept first.");
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
// Every Beta install is tried for real before it is used (src/desktop/beta-smoke.ts, tests/beta-smoke.test.mjs).
test("a Beta build that fails its try-out is not installed, and the owner reads which step failed", async (t) => {
  const where = await folders(t), tools = fakeTools(where), tried = [];
  const words = "The new Beta version was not used: when Branch tried it, Settings did not open (the Settings page never showed). You are still on the version you had, and nothing was changed.";
  const dev = updater(where, tools, { canary: async () => {}, tryOut: async (dir, version) => { tried.push([dir, version]); return words; } });
  await dev.check();
  await assert.rejects(dev.install(), (error) => error.message === words);
  assert.deepEqual(tried, [[join(where.scratchDir, "unpacked", "Branch Agent-win32-x64"), BUILT]], "the staged build is tried, as the version it was built as");
  assert.equal(dev.status.phase, "error");
  assert.equal(dev.status.message, words);
  assert.equal(dev.status.outcome.kept, "0.19.3-beta.3", "the running version stays");
  assert.equal(await readFile(join(where.installDir, exe), "utf8"), "the installed app", "nothing was swapped");
  assert.equal(await exists(join(where.scratchDir, "apply-update.cmd")), false, "no hand-over was written");
  assert.equal(await exists(join(where.scratchDir, "unpacked")), false, "the staged copy is removed");
  const broken = updater(where, fakeTools(where), { canary: async () => {}, tryOut: async () => { throw new Error("spawn EACCES"); } });
  await broken.check();
  await assert.rejects(broken.install(), /^Error: The new Beta version was not used: its try-out could not run \(spawn EACCES\)\. You are still on the version you had/);
});

test("Beta installs nothing without a try-out, and the check runs whatever the never-break switch says", async (t) => {
  const where = await folders(t), tools = fakeTools(where), required = [];
  await assert.rejects(updater(where, tools, { tryOut: undefined }).install(),
    /^Error: The Beta channel tries every new version before using it, and this copy of Branch cannot, so nothing was installed\.$/);
  assert.equal(building(tools.calls).length, 0, "nothing is built for nothing");
  const dev = updater(where, tools, { canary: async (_dir, _version, options) => { required.push(options?.required); } });
  await dev.check();
  await dev.install();
  assert.deepEqual(required, [true]);
});

test("Dev reads and builds Branch's current name even when the Update button names the new one", async (t) => {
  const where = await folders(t), tools = fakeTools(where);
  const dev = updater(where, tools, { repo: "KeepOak/Branch-Agent", canary: async () => {} });
  const status = await dev.check();
  assert.equal(status.phase, "available", status.message);
  assert.ok(tools.calls.includes(`git ls-remote https://github.com/stabrea/Branch-Agent.git refs/heads/${betaLine}`), tools.calls.join("\n"));
  assert.equal(status.release.pageUrl, `https://github.com/stabrea/Branch-Agent/commit/${NEW}`);
  await dev.install();
  assert.ok(tools.calls.includes(`git fetch --quiet --no-tags --force https://github.com/stabrea/Branch-Agent.git +refs/heads/${betaLine}:refs/branch/line`), tools.calls.join("\n"));
  assert.equal(tools.calls.some((call) => call.includes("KeepOak")), false, "git is never pointed at the new name");
});

test("installing a Beta build fetches into the build's own folder, proves it goes forward, builds, and hands over", async (t) => {
  const where = await folders(t), tools = fakeTools(where), checked = [], how = [];
  const dev = updater(where, tools, { canary: async (_dir, version, asked) => { checked.push(version); how.push(asked); } });
  await dev.check();
  const { script, stagedDir } = await dev.install();
  assert.deepEqual(building(tools.calls), buildSteps(where));
  assert.ok(tools.buildWalled.length && tools.buildWalled.every(Boolean), "every git call in the build folder runs behind the walls");
  assert.equal(await readFile(join(where.sourceDir, ".git", "config"), "utf8"), buildGitConfig, "the build folder's git settings are Branch's own");
  assert.deepEqual(checked, [BUILT], "the new version's check expects the version the source was built as, not the running one");
  assert.deepEqual(how, [{ required: true }], "selfdev: a Beta build is always tried on a copy of the work, whatever the never-break switch says");
  assert.equal(dev.status.release.latestVersion, BUILT, "the update's record and the next start expect the built version");
  assert.equal(stagedDir, join(where.scratchDir, "unpacked", "Branch Agent-win32-x64"), "Windows: the built app folder goes where a download is unpacked");
  assert.equal(await exists(join(where.scratchDir, assetName)), false, "no zip is written, checked and unpacked again");
  assert.match(await readFile(script, "utf8"), /robocopy/i, "the same hand-over as a downloaded release");
  assert.ok((await readdir(stagedDir)).includes(exe));
  assert.equal(await readFile(join(where.installDir, exe), "utf8"), "the installed app", "nothing is swapped until the hand-over runs");
  assert.ok(await exists(join(where.sourceDir, "node_modules")), "the build folder is kept for the next build");
  // The packager empties all of %TEMP%\electron-packager as it starts: a build at the same time lost its app (2026-09-27).
  const tmp = join(where.buildDir, "tmp");
  assert.deepEqual(tools.temps, ["npm ci --no-audit --no-fund", "npm run build", "node scripts/dependency-notices.mjs", "node scripts/package-desktop.mjs"]
    .map((line) => [line, tmp, tmp, tmp]));
  // tsc reads package.json: compiled with the committed one, so a new version stamp does not make every compile a full one.
  assert.deepEqual(tools.compiled, ["0.19.2"]);
});

/* Fast Beta builds: the next build reuses the checkout, and node_modules when package-lock.json is unchanged and the
   folder is exactly what the last install left; any doubt installs again. */
test("a second Beta build of an unchanged package-lock.json fetches only, and installs no packages", async (t) => {
  const where = await folders(t);
  await updater(where, fakeTools(where)).install();
  const again = fakeTools(where);
  const dev = updater(where, again);
  await dev.install();
  assert.deepEqual(building(again.calls), buildSteps(where, { fresh: false, npmCi: false }), "no clone, no npm ci");
  assert.deepEqual(dev.status.stages.find((stage) => stage.id === "installing").state, "skipped");
});

test("a changed package-lock.json, another Node, or a node_modules that changed since installs the packages again", async (t) => {
  for (const [name, second, meddle] of [
    ["package-lock.json changed", { lock: "lock-2" }, null],
    ["Node changed", { node: "v25.4.0" }, null],
    ["a file in node_modules changed", {}, (where) => writeFile(join(where.sourceDir, "node_modules", "zod", "index.js"), "changed")],
    ["a file was added to node_modules", {}, (where) => writeFile(join(where.sourceDir, "node_modules", "zod", "extra.js"), "planted")],
    ["the record is gone", {}, (where) => rm(join(where.buildDir, "packages.json"))],
  ]) {
    const where = await folders(t);
    await updater(where, fakeTools(where)).install();
    await meddle?.(where);
    const again = fakeTools(where, second);
    const dev = updater(where, again);
    await dev.install();
    assert.ok(again.calls.includes("npm ci --no-audit --no-fund"), name);
    assert.equal(dev.status.stages.find((stage) => stage.id === "installing").state, "done", name);
  }
});

test("a record of the last install cut off part way, or not a record, installs the packages again instead of stopping every build", async (t) => {
  for (const [name, text] of [["cut off", '{\n  "lock": "ab'], ["empty", ""], ["not a record", "[1,2]"], ["a field missing", '{"lock":"x","node":"v24"}']]) {
    const where = await folders(t);
    await updater(where, fakeTools(where)).install();
    await writeFile(join(where.buildDir, "packages.json"), text);
    const again = fakeTools(where), dev = updater(where, again);
    await dev.install();
    assert.ok(again.calls.includes("npm ci --no-audit --no-fund"), name);
    assert.equal(typeof JSON.parse(await readFile(join(where.buildDir, "packages.json"), "utf8")).tree, "string", `${name}: a whole record is written again`);
    assert.equal(await exists(join(where.buildDir, "packages.json.part")), false, `${name}: written whole, then moved into place`);
  }
});

test("a lock git left when it was stopped part way never stops every later build; one that may still be working is left", async (t) => {
  const where = await folders(t);
  await updater(where, fakeTools(where)).install();
  const git = join(where.sourceDir, ".git"), old = (Date.now() - 16 * 60_000) / 1000;
  await mkdir(join(git, "refs", "branch"), { recursive: true });
  for (const name of ["index.lock", "shallow.lock", "refs/branch/line.lock"]) {
    await writeFile(join(git, name), "");
    await utimes(join(git, name), old, old);
  }
  await writeFile(join(git, "HEAD.lock"), "");
  await updater(where, fakeTools(where)).install();
  for (const name of ["index.lock", "shallow.lock", "refs/branch/line.lock"]) assert.equal(await exists(join(git, name)), false, `${name} older than any git's time limit goes`);
  assert.equal(await exists(join(git, "HEAD.lock")), true, "a lock young enough to be a git still working is left");
});

test("the lockfile is compared as committed, before the version is stamped into it", async (t) => {
  const where = await folders(t), tools = fakeTools(where);
  await buildDev(tools.run, { repo, buildDir: where.buildDir, commit: NEW, running: OLD, assetName, platform: "win32", onStage: () => {} });
  const record = JSON.parse(await readFile(join(where.buildDir, "packages.json"), "utf8"));
  const committed = JSON.stringify({ name: "branch-agent", version: "0.19.2", packages: { "": { version: "0.19.2" } }, lock: "lock-1" });
  assert.equal(record.lock, createHash("sha256").update(committed).digest("hex"));
});

test("which builds need npm ci: the decision alone", () => {
  const now = { lock: "L", node: "v24", npm: "11", platform: "win32", arch: "x64" }, record = { ...now, tree: "T" };
  assert.equal(packagesNeeded(record, now, "T"), null, "same lockfile, same tools, same folder: reused");
  assert.equal(packagesNeeded(null, now, "T"), "no earlier install is on record");
  assert.equal(packagesNeeded(record, { ...now, lock: "M" }, "T"), "package-lock.json changed");
  assert.equal(packagesNeeded(record, { ...now, npm: "12" }, "T"), "Node or npm changed");
  assert.equal(packagesNeeded(record, { ...now, arch: "arm64" }, "T"), "the computer changed");
  assert.equal(packagesNeeded(record, now, null), "node_modules is missing");
  assert.equal(packagesNeeded(record, now, "U"), "node_modules is not what the last install left");
});

test("a Beta build refuses a change that is not on Beta's line, or a checkout that lands elsewhere, before building", async (t) => {
  for (const [name, options, words] of [
    ["not on the line", { onLine: false }, /is not on Beta's line of work, so nothing was built/],
    ["the checkout is not the change looked up", { headAfterReset: OLD }, /did not arrive at the change that was looked up/],
  ]) {
    const where = await folders(t), tools = fakeTools(where, options);
    const dev = updater(where, tools);
    await dev.check();
    await assert.rejects(dev.install(), words, name);
    assert.equal(dev.status.phase, "error", name);
    assert.equal(dev.status.failure.stage, "fetching", name);
    assert.equal(building(tools.calls).some((call) => call.startsWith("npm")), false, `${name}: nothing installed or built`);
    assert.equal(await readFile(join(where.installDir, exe), "utf8"), "the installed app", name);
  }
});

test("a commit that packages some other way is built with its own package:desktop script, stamped first", async (t) => {
  const where = await folders(t), tools = fakeTools(where, { script: "npm run build && node scripts/something-new.mjs && node scripts/package-desktop.mjs" });
  await updater(where, tools).install();
  assert.equal(building(tools.calls).at(-1), "npm run package:desktop");
  assert.equal(building(tools.calls).includes("node scripts/package-desktop.mjs"), false);
  assert.deepEqual(tools.compiled, [BUILT], "its own script builds with the version already stamped, as before");
  assert.equal(packageSteps, JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")).scripts["package:desktop"],
    "the steps are Branch's own package:desktop script today");
});

test("tsc's output for a source that is gone is removed before building; copied folders and other files are left", () => {
  const dist = ["a.js", "a.js.map", "a.d.ts", "gone.js", "gone.js.map", "gone.d.ts", "desktop/preload.cjs", "desktop/preload.d.cts",
    "old/preload.cjs", "data/suite.js", "handbook/x.js", "bundled-add-ons/y.js", "build-info.json", "fonts.css"];
  assert.deepEqual(staleOutputs(dist, ["a.ts", "desktop/preload.cts"]), ["gone.js", "gone.js.map", "gone.d.ts", "old/preload.cjs"]);
});

test("the folder a Beta build keeps is one the assistant may never change, and the data copy leaves out", async () => {
  const dataDir = join(tmpdir(), "some-data");
  const areas = protectedAreas({ workspace: join(tmpdir(), "some-workspace"), dataDir });
  const target = join(dataDir, "updates", "beta-build", "source", ".git", "config");
  assert.notEqual(protectedTarget({ tool: "files.write", readOnly: false, args: { path: target }, target, workspace: areas.workspace }, areas), null);
  // A workspace inside the data folder still leaves updates/ protected (src/never-break/protected.ts gatewayDataFiles).
  const inside = protectedAreas({ workspace: join(dataDir, "workspace"), dataDir });
  assert.notEqual(protectedTarget({ tool: "files.write", readOnly: false, args: { path: target }, target, workspace: inside.workspace }, inside), null);
  const ordinary = join(tmpdir(), "some-workspace", "project", ".git", "config");
  assert.equal(protectedTarget({ tool: "files.write", readOnly: false, args: { path: ordinary }, target: ordinary, workspace: areas.workspace }, areas), null,
    "the control: a task's own checkout stays usable");
});

test("a Beta build never follows a link or a file planted where its folder, checkout or history goes", async (t) => {
  for (const at of ["buildDir", "sourceDir", "git"]) {
    const where = await folders(t), tools = fakeTools(where);
    const elsewhere = join(where.root, "elsewhere");
    await mkdir(elsewhere, { recursive: true });
    const target = at === "git" ? join(where.sourceDir, ".git") : where[at];
    await mkdir(join(target, ".."), { recursive: true });
    await symlink(elsewhere, target, "junction");
    await assert.rejects(buildDev(tools.run, { repo, buildDir: where.buildDir, commit: NEW, running: OLD, assetName, platform: "win32", onStage: () => {} }),
      /not a plain folder of yours, so nothing was built/, at);
    assert.deepEqual(tools.calls, [], `${at}: no git command ran`);
    assert.deepEqual(await readdir(elsewhere), [], `${at}: nothing was written where it pointed`);
  }
});

test("the build folder's own git settings are replaced before every build, so none of them can run anything", async (t) => {
  const where = await folders(t);
  await updater(where, fakeTools(where)).install();
  await writeFile(join(where.sourceDir, ".git", "config"), "[core]\n\tfsmonitor = planted\n[filter \"x\"]\n\tsmudge = planted\n");
  const again = fakeTools(where);
  await updater(where, again).install();
  assert.equal(await readFile(join(where.sourceDir, ".git", "config"), "utf8"), buildGitConfig);
});

test("a failed build says where it stopped and the line that says why, and keeps the running version", async (t) => {
  const where = await folders(t);
  // What the owner's Beta build printed on 2026-09-27 (#435), shortened: the copy that failed is the line that says why.
  const why = "ENOENT: no such file or directory, copyfile 'dev-source/node_modules/electron/dist/electron.exe' -> 'dev-source/release/Branch Agent.exe'";
  const output = ["Packaging app for platform win32 x64 using electron v44.3.0", why, "npm error code 1", "npm error path dev-source",
    "npm error command failed", "npm error A complete log of this run can be found in: x.log"].join("\n");
  const dev = updater(where, fakeTools(where, { failOn: "node scripts/package-desktop.mjs", npmCiOutput: keyLine(output) }));
  await dev.check();
  await assert.rejects(dev.install(), /node scripts\/package-desktop\.mjs did not finish/);
  assert.equal(dev.status.failure.stage, "building");
  assert.equal(dev.status.failure.line, why);
  assert.deepEqual(dev.status.outcome, { kept: "0.19.3-beta.3", backgroundStopped: false });
  assert.deepEqual(dev.status.stages.map((stage) => [stage.id, stage.state]),
    [["fetching", "done"], ["installing", "done"], ["building", "failed"], ["checking", "waiting"], ["copying", "waiting"], ["swapping", "waiting"], ["restarting", "waiting"]]);
  assert.equal(await readFile(join(where.installDir, exe), "utf8"), "the installed app");
});

test("the key line of a program's output is the last one naming an error, else its last line", () => {
  assert.equal(keyLine(["added 3 packages", "npm error code ENOENT", "npm error path x", "npm error something went wrong", "done"].join("\n")), "npm error something went wrong");
  assert.equal(keyLine(["src/a.ts(3,1): error TS2304: Cannot find name 'x'.", "npm error command failed"].join("\n")), "src/a.ts(3,1): error TS2304: Cannot find name 'x'.");
  assert.equal(keyLine("fatal: couldn't find remote ref\n"), "fatal: couldn't find remote ref");
  assert.equal(keyLine("all fine\nlast words"), "last words");
  assert.equal(keyLine("\n  \n"), null);
});

test("a Dev build that fails, lands elsewhere, cannot show it goes forward, or comes out incomplete changes nothing", async (t) => {
  for (const [name, options, words] of [
    ["npm ci fails", { failOn: "npm ci" }, /npm ci did not finish/],
    ["the source is not the change looked up", { headAfterReset: OLD }, /did not arrive at the change that was looked up/],
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
    if (!/npm ci/.test(name) && !["the built app does not say which change it is"].includes(name))
      assert.equal(tools.calls.includes("npm ci --no-audit --no-fund"), false, `${name}: stopped before building`);
  }
});

test("a running change the clone lacks is fetched by its id, and then the history decides", async (t) => {
  const where = await folders(t), tools = fakeTools(where, { running: "fetched" });
  const dev = updater(where, tools);
  await dev.check();
  await dev.install();
  assert.ok(tools.calls.includes(`git fetch --quiet --no-tags https://github.com/${repo}.git ${OLD}`), tools.calls.join("\n"));
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

test("Beta looks every minute and, with update by itself on, installs each change once nothing is working", () => {
  const saved = (releaseChannel) => ({ get: (table, _owner, key) =>
    (table === "settings" && key === "comfort-notify" ? { data: { autoUpdate: "install", releaseChannel } } : undefined) });
  const facts = { busyTasks: 0, updaterPhase: "available", now: new Date() };
  assert.equal(updatePlan(saved("stable"), "local", facts).step, "install", "update by itself installs a verified Stable release");
  assert.equal(updatePlan(saved("beta"), "local", facts).step, "install", "an available Beta build is installed, so fixes are seen live");
  assert.equal(updatePlan(saved("dev"), "local", facts).step, "install", "a saved Dev choice is Beta now");
  assert.equal(updatePlan(saved("beta"), "local", { ...facts, busyTasks: 1 }).step, "nothing", "but never while a task is working");
  const looked = { get: (table, _owner, key) => (table === "settings" && key === "comfort-notify" ? { data: { autoUpdate: "check", releaseChannel: "dev" } }
    : table === "settings" && key === "comfort-update-last" ? { data: { at: new Date().toISOString() } } : undefined) };
  assert.equal(updatePlan(looked, "local", { busyTasks: 0, updaterPhase: "current", now: new Date() }).reason, "Beta updates were looked for less than a minute ago.");
  assert.equal(betaCheckEveryMs, 60 * 1000);
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

/* Beta follows one line of work, named once in src/desktop/dev-build.ts (betaLine); nothing the owner or anything else
   hands in chooses another. Moving to a change that lacks the running one (a copy built from another line) needs the
   owner's confirmation of that exact change in the window, and update by itself never gives it. */
test("Beta follows the one line named in the code: git asks for its head and clones it, whatever is handed in", async (t) => {
  assert.equal(betaLine, "redesign/window");
  const where = await folders(t), tools = fakeTools(where);
  const beta = updater(where, tools, { devLine: "mac/cross-platform", canary: async () => {} });
  const status = await beta.check();
  assert.equal(status.phase, "available", status.message);
  assert.ok(tools.calls.includes(`git ls-remote https://github.com/${repo}.git refs/heads/redesign/window`), tools.calls.join("\n"));
  await beta.install();
  assert.ok(tools.calls.includes(`git fetch --quiet --no-tags --force https://github.com/${repo}.git +refs/heads/redesign/window:refs/branch/line`));
  assert.equal(tools.calls.some((call) => call.includes("mac/cross-platform")), false, "no other line is ever asked for");
});

test("a change that lacks this copy's is never installed without the owner's confirmation of that exact change", async (t) => {
  for (const standing of ["apart", "ahead"]) {
    // `shared` makes the build's own never-go-back step fail, so only a confirmed move can get past it.
    const where = await folders(t), tools = fakeTools(where, { standing, shared: "c".repeat(40) });
    const dev = updater(where, tools, { canary: async () => {} });
    const status = await dev.check();
    assert.equal(status.release.otherLine, true, standing);
    assert.equal(status.release.available, false, `${standing}: never offered as newer, so update by itself never installs it`);
    await assert.rejects(dev.install(), /There is no newer version to install/, standing);
    await assert.rejects(dev.install({ confirm: "d".repeat(40) }), /no longer Beta's newest one/, standing);
    await assert.rejects(dev.install({ confirm: "not a commit" }), /Only a Beta change that does not contain this copy's change can be confirmed/, standing);
    assert.equal(building(tools.calls).length, 0, `${standing}: nothing was built without the confirmation`);
    await dev.install({ confirm: NEW });
    assert.ok(tools.calls.some((call) => call.startsWith("git fetch") && call.includes("+refs/heads/redesign/window:")), standing);
    assert.equal(tools.calls.includes(`git merge-base ${OLD} ${NEW}`), false, `${standing}: the confirmed move skips only the never-go-back step`);
    assert.equal(dev.status.phase, "ready", standing);
  }
});

test("a confirmation is refused for a change that is a newer version of this one, and off the Beta channel", async (t) => {
  const where = await folders(t);
  const dev = updater(where, fakeTools(where));
  await dev.check();
  await assert.rejects(dev.install({ confirm: NEW }), /no longer Beta's newest one/, "a newer version needs no confirmation and takes none");
  const stable = updater(where, fakeTools(where), { channel: "stable" });
  await assert.rejects(stable.install({ confirm: NEW }), /Only a Beta change that does not contain this copy's change can be confirmed/);
});

/* The copy before every Beta update: the window hands in `backup` (the rows' safety copy, then the whole data folder,
   src/install/data-copy.ts). It runs after the new version passed its check and before the hand-over is written, on
   a newer change and on a confirmed move; without it, or when it fails, nothing is installed. */
const DEV_CASES = [
  { name: "a newer change", standing: "behind", confirm: undefined },
  { name: "a confirmed move to a change that lacks this copy's", standing: "apart", confirm: NEW },
];

test("every Beta install copies the data after the new version's check and before the hand-over exists", async (t) => {
  for (const one of DEV_CASES) {
    const where = await folders(t), tools = fakeTools(where, { standing: one.standing }), order = [];
    const dev = updater(where, tools, {
      canary: async () => { order.push("canary"); },
      backup: async () => { order.push(await exists(join(where.scratchDir, "apply-update.cmd")) ? "backup after the hand-over" : "backup"); },
      beforeStop: async () => { order.push("idle check"); },
    });
    await dev.check();
    const { script } = await dev.install(one.confirm ? { confirm: one.confirm } : {});
    assert.deepEqual(order, ["canary", "backup", "idle check"], one.name);
    assert.equal(script, join(where.scratchDir, "apply-update.cmd"), one.name);
  }
});

test("a Beta install that cannot make the copy, or whose copy fails, installs nothing", async (t) => {
  for (const one of DEV_CASES) {
    const where = await folders(t), tools = fakeTools(where, { standing: one.standing });
    const none = updater(where, tools, { canary: async () => {}, backup: undefined });
    await none.check();
    await assert.rejects(none.install(one.confirm ? { confirm: one.confirm } : {}), /Beta channel keeps a copy of your data folder before every update.*nothing was installed/, one.name);
    assert.deepEqual(building(tools.calls), [], `${one.name}: nothing is cloned or built without a way to copy the data`);

    const failing = fakeTools(where, { standing: one.standing });
    const refused = updater(where, failing, { canary: async () => {},
      backup: async () => { throw new Error("The copy of the data folder could not be made (branch.sqlite did not pass its check)."); } });
    await refused.check();
    await assert.rejects(refused.install(one.confirm ? { confirm: one.confirm } : {}), /safety copy could not be made, so the update was stopped: The copy of the data folder could not be made/, one.name);
    assert.equal(refused.status.phase, "error", one.name);
    assert.equal(await exists(join(where.scratchDir, "apply-update.cmd")), false, `${one.name}: no hand-over is written`);
    assert.equal(await readFile(join(where.installDir, exe), "utf8"), "the installed app", `${one.name}: nothing is swapped`);
  }
});

/* Checked as a downloaded release is, once the archive exists: whole, the package it says, and the new version's own
   check on a copy of the work, on a newer change and on a confirmed move (which leaves out only the never-go-back step).
   A build has no published checksum or provenance record: its trust is git over https at the exact change looked up. */
test("a Beta build, or a confirmed move, is checked as a downloaded release is", async (t) => {
  for (const one of DEV_CASES) {
    const run = (dev) => dev.check().then(() => dev.install(one.confirm ? { confirm: one.confirm } : {}));
    let where = await folders(t);
    await assert.rejects(run(updater(where, fakeTools(where, { standing: one.standing, packaged: "0.0.1" }), { canary: async () => {} })),
      /contains version 0\.0\.1, but the selected release is/, `${one.name}: a package that is not the version built`);
    where = await folders(t);
    let copied = false;
    await assert.rejects(run(updater(where, fakeTools(where, { standing: one.standing }), {
      canary: async () => { throw new Error("the self-test failed"); }, backup: async () => { copied = true; } })),
    /did not pass its check/, `${one.name}: a version that fails its check on a copy of the work`);
    assert.equal(copied, false, `${one.name}: nothing goes on to the copy after a failed check`);
    where = await folders(t);
    const tools = fakeTools(where, { standing: one.standing }), checked = [];
    await run(updater(where, tools, { canary: async (_dir, version) => { checked.push(version); } }));
    assert.deepEqual(checked, [BUILT], `${one.name}: the check expects the version built`);
    assert.deepEqual(building(tools.calls), buildSteps(where, { confirmed: Boolean(one.confirm) }), one.name);
  }
});

/* macOS and Linux keep the download a release has (the Mac app is signed and zipped as one piece), so it is checked
   as written whole and unpacked as a downloaded one is. */
test("on macOS and Linux a Beta build's download is checked whole before it is unpacked", async (t) => {
  let where = await folders(t);
  const linux = (tools) => updater(where, tools, { platform: "linux", canary: async () => {} });
  await assert.rejects(linux(fakeTools(where, { tamper: true })).install(), /came out incomplete/);
  where = await folders(t);
  const tools = fakeTools(where);
  const { stagedDir } = await linux(tools).install();
  assert.ok(tools.calls.includes("node scripts/package-desktop.mjs --release"));
  assert.equal(stagedDir, join(where.scratchDir, "unpacked", "Branch Agent"));
});

/* The update screen reads the steps from the updater itself: what is being installed from the start (the change, and
   its version once the source is here), each step's state and times, never a guess. */
test("the steps of a Beta install, as the update screen shows them, with the target version once it is known", async (t) => {
  const where = await folders(t), seen = [];
  const dev = updater(where, fakeTools(where), { canary: async () => {}, onChange: (status) => seen.push(status) });
  await dev.check();
  await dev.install();
  const first = seen.find((status) => status.stages);
  assert.ok(seen.filter((status) => status.stages).every((status) => status.automatic === false), "pressed by the owner");
  assert.deepEqual(first.target, { version: null, commit: NEW }, "the change is named before its version is known");
  assert.ok(seen.every((status) => status.target?.version !== "0.19.3-beta.3"), "never the version already installed");
  const known = seen.find((status) => status.target?.version);
  assert.equal(known.target.version, BUILT);
  assert.equal(known.stages.find((stage) => stage.id === "installing").state, "waiting", "the version is known before packages are installed");
  const order = [];
  for (const status of seen) for (const stage of status.stages ?? []) if (stage.state === "running" && order.at(-1) !== stage.id) order.push(stage.id);
  assert.deepEqual(order, ["fetching", "installing", "building", "checking", "copying", "swapping"]);
  const last = dev.applying();
  assert.deepEqual(last.stages.map((stage) => stage.state), ["done", "done", "done", "done", "done", "done", "running"]);
  for (const stage of last.stages.slice(0, -1)) assert.ok(Date.parse(stage.endedAt) >= Date.parse(stage.startedAt), stage.id);
  const skipped = fakeTools(where), again = [];
  const second = updater(where, skipped, { canary: async () => {}, onChange: (status) => again.push(status) });
  await second.install();
  const installing = second.status.stages.find((stage) => stage.id === "installing");
  assert.equal(installing.state, "skipped", "installing is skipped, not shown as done, when nothing was installed");
  assert.equal(installing.startedAt, installing.endedAt);
  assert.equal((await second.check()).stages, null, "the next look clears the last install's steps");
  const auto = [];
  await updater(where, fakeTools(where), { canary: async () => {}, onChange: (status) => auto.push(status) }).install({ automatic: true });
  assert.ok(auto.filter((status) => status.stages).every((status) => status.automatic === true),
    "update by itself's install says so in every status, so the window keeps it in the background");
});

test("a task that starts during a background build defers the install, and the swap is never shown as begun", async (t) => {
  const where = await folders(t), seen = [];
  const { UpdateDeferredError } = await import("../dist/desktop/updater.js");
  const dev = updater(where, fakeTools(where), { canary: async () => {}, onChange: (status) => seen.push(status),
    beforeStop: async () => { throw new UpdateDeferredError("An update is ready, but Branch will wait until every task finishes or is answered."); } });
  await assert.rejects(dev.install({ automatic: true }), /wait until every task finishes/);
  assert.ok(seen.every((status) => !status.stages?.some((stage) => ["swapping", "restarting"].includes(stage.id) && stage.state !== "waiting")),
    "the full screen, which comes up for the swap, never comes up over the owner's work for a swap that did not start");
  assert.equal(dev.status.phase, "available");
  assert.equal(await readFile(join(where.installDir, exe), "utf8"), "the installed app");
});

test("Beta takes the newest change whose whole suite passed, not the tip, asking GitHub only when the tip moves", async (t) => {
  const GREEN = "c".repeat(40), TIP = "d".repeat(40), asked = [];
  let answer = { workflow_runs: [{ head_sha: GREEN, head_branch: betaLine }] }, ok = true;
  const fetch = async (url) => { asked.push(String(url)); if (!ok) return new Response("rate limited", { status: 403 }); return Response.json(answer); };
  const green = newestGreen(fetch);
  assert.equal(await green(repo, TIP), GREEN);
  assert.ok(asked[0].endsWith(`/repos/${repo}/actions/workflows/${wholeSuiteWorkflow}/runs?branch=redesign%2Fwindow&event=push&status=success&per_page=1`), asked[0]);
  assert.equal(await green(repo, TIP), GREEN);
  assert.equal(asked.length, 1, "the same tip is not asked about again");
  ok = false;
  assert.equal(await green(repo, "e".repeat(40)), GREEN, "GitHub not answering keeps the last passing change");
  ok = true; answer = { workflow_runs: [{ head_sha: "f".repeat(40), head_branch: "another-line" }] };
  assert.equal(await green(repo, "1".repeat(40)), GREEN, "a run of another line is never taken");
  assert.equal(await newestGreen(async () => { throw new Error("offline"); })(repo, TIP), null, "none known: the tip, as before");
  // Through the updater: the passing change is offered and built, not the tip.
  const where = await folders(t), tools = fakeTools(where, { head: TIP });
  const status = await updater(where, tools, { greenCommit: async (_repo, tip) => { assert.equal(tip, TIP); return NEW; } }).check();
  assert.equal(status.phase, "available");
  assert.equal(status.release.commit, NEW);
  assert.equal(status.release.tag, `dev-${NEW.slice(0, 7)}`);
});
