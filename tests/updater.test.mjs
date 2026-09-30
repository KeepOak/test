import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, readFile, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { discardTemp } from "./temp-dir.mjs";
import { Updater, UpdateDeferredError, compareVersions } from "../dist/desktop/updater.js";

const run = promisify(execFile);
const windows = process.platform === "win32";

async function releaseFixture(t, { tag = "v0.3.0", tamper = false, embeddedVersion = tag.replace(/^v/, ""), embeddedName = "branch-agent" } = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-update-"));
  t.after(() => discardTemp(root));
  const source = join(root, "Branch Agent-win32-x64");
  await mkdir(join(source, "resources", "app"), { recursive: true });
  await writeFile(join(source, "Branch Agent Test.exe"), "new executable");
  await writeFile(join(source, "resources", "app.txt"), "new resources");
  await writeFile(join(source, "resources", "app", "package.json"), JSON.stringify({ name: embeddedName, version: embeddedVersion }));
  const archive = join(root, "Branch-Agent-windows-x64.zip");
  if (windows)
    await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      `Compress-Archive -LiteralPath '${source}' -DestinationPath '${archive}' -Force`]);
  else await writeFile(archive, "not a real archive");
  const bytes = await readFile(archive);
  const digest = createHash("sha256").update(bytes).digest("hex");
  let downloads = 0;
  const server = createServer((req, res) => {
    if (req.url === "/download/app.zip") downloads += 1;
    if (req.url === "/repos/stabrea/Branch-Agent/releases/latest") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({
        tag_name: tag, name: `Branch Agent ${tag}`, body: "Notes", published_at: "2026-09-15T00:00:00Z",
        html_url: "https://github.com/stabrea/Branch-Agent/releases/tag/" + tag,
        assets: [
          { name: "Branch-Agent-windows-x64.zip", browser_download_url: `${origin()}/download/app.zip`, size: bytes.length },
          { name: "Branch-Agent-windows-x64.zip.sha256", browser_download_url: `${origin()}/download/app.sha256`, size: 96 },
        ],
      }));
    }
    if (req.url === "/download/app.zip") { res.writeHead(200, { "content-length": bytes.length }); return res.end(bytes); }
    if (req.url === "/download/app.sha256") {
      res.writeHead(200);
      return res.end(`${tamper ? "0".repeat(64) : digest}  Branch-Agent-windows-x64.zip\n`);
    }
    res.writeHead(404); res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = () => `http://127.0.0.1:${server.address().port}`;
  const fetchViaFixture = (url, init) => fetch(url.replace("https://api.github.com", origin()), init);
  const installDir = join(root, "installed");
  await mkdir(installDir, { recursive: true });
  await writeFile(join(installDir, "Branch Agent Test.exe"), "old executable");
  return { root, installDir, fetchViaFixture, digest, downloadCount: () => downloads };
}

test("version comparison handles tags, prefixes and uneven lengths", () => {
  assert.equal(compareVersions("v0.2.0", "0.2.0"), 0);
  assert.equal(compareVersions("0.10.0", "0.9.9"), 1);
  assert.equal(compareVersions("1.0", "1.0.1"), -1);
  assert.equal(compareVersions("0.2.0-beta", "0.2.0"), -1);
  assert.equal(compareVersions("0.19.2-beta.10", "0.19.2-beta.9"), 1);
  assert.equal(compareVersions("0.19.2-beta.10", "0.19.1"), 1);
  assert.equal(compareVersions("0.19.2", "0.19.2-beta.10"), 1);
  assert.equal(compareVersions("1.2.3+build.7", "1.2.3"), 0);
});

/** GitHub as it answers before the move: the new name, KeepOak/Branch-Agent, does not exist yet (404). */
const beforeTheMove = (fake) => async (url, ...rest) => String(url).includes("/repos/KeepOak/Branch-Agent/")
  ? { ok: false, status: 404, json: async () => ({ message: "Not Found" }) } : fake(url, ...rest);

/* Two channels: Stable reads GitHub's newest final release; Beta builds every merged change (tests/dev-channel.test.mjs)
   and is never downloaded. A Beta build of 0.19.2's line is 0.19.3-dev.<time>-g<change> (src/desktop/dev-build.ts), so
   switching back to Stable waits for a newer Stable instead of installing an older version. */
test("Stable takes only final releases, and switching from Beta back never installs an older version", async () => {
  const asset = (tag) => [
    { name: "Branch-Agent-windows-x64.zip", browser_download_url: `https://github.com/stabrea/Branch-Agent/releases/download/${tag}/Branch-Agent-windows-x64.zip`, size: 100 },
    { name: "Branch-Agent-windows-x64.zip.sha256", browser_download_url: `https://github.com/stabrea/Branch-Agent/releases/download/${tag}/Branch-Agent-windows-x64.zip.sha256`, size: 96 },
  ];
  const release = (tag, prerelease = false) => ({ tag_name: tag, name: tag, body: "", published_at: "2026-09-23T00:00:00Z",
    html_url: `https://github.com/stabrea/Branch-Agent/releases/tag/${tag}`, prerelease, draft: false, assets: asset(tag) });
  const asked = [];
  const make = (currentVersion, latest, channel = "stable") => new Updater({ repo: "stabrea/Branch-Agent", currentVersion, channel,
    installDir: "C:/installed", executableName: "Branch Agent.exe", assetName: "Branch-Agent-windows-x64.zip",
    scratchDir: "C:/scratch", fetch: beforeTheMove(async (url) => { asked.push(String(url)); return { ok: true, status: 200, json: async () => latest }; }) });
  assert.equal((await make("0.19.1", release("v0.19.2")).check()).phase, "available", "control: a newer Stable is offered");
  assert.ok(asked.every((url) => url.endsWith("/releases/latest")), "Stable asks for the newest final release only");
  const pre = await make("0.19.1", release("v0.19.3-beta.2", true)).check();
  assert.equal(pre.phase, "error");
  assert.match(pre.message, /not a published final release/);
  const betaBuild = "0.19.3-dev.1758600000-gaaaaaaaaaaaa";
  const back = make(betaBuild, release("v0.19.2"), "beta");
  back.setChannel("stable");
  const waits = await back.check();
  assert.equal(waits.phase, "current", "returning to Stable does not install the older version");
  assert.equal(waits.release.available, false);
  assert.equal((await make(betaBuild, release("v0.19.3")).check()).phase, "available", "the next Stable release is newer than the Beta build");
});

/* After the move KeepOak answers with releases of its own: each check asks it once, takes the release from it, and
   says so. When neither name has a release, it says so. */
test("after the move Stable reads KeepOak once and takes the release from it", async () => {
  const at = "https://github.com/KeepOak/Branch-Agent/releases";
  const release = (tag) => ({ tag_name: tag, name: tag, body: "", published_at: "2026-09-24T00:00:00Z",
    html_url: `${at}/tag/${tag}`, prerelease: false, draft: false, assets: [
      { name: "Branch-Agent-windows-x64.zip", browser_download_url: `${at}/download/${tag}/Branch-Agent-windows-x64.zip`, size: 100 },
      { name: "Branch-Agent-windows-x64.zip.sha256", browser_download_url: `${at}/download/${tag}/Branch-Agent-windows-x64.zip.sha256`, size: 96 },
    ] });
  const asked = [];
  const fetch = async (url) => {
    asked.push(String(url));
    if (!String(url).includes("/repos/KeepOak/Branch-Agent/")) return { ok: false, status: 500, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => release("v0.20.0") };
  };
  const updater = new Updater({ repo: "KeepOak/Branch-Agent", currentVersion: "0.19.1", channel: "stable",
    installDir: "C:/installed", executableName: "Branch Agent.exe", assetName: "Branch-Agent-windows-x64.zip",
    scratchDir: "C:/scratch", fetch });
  const onStable = await updater.check();
  assert.equal(onStable.phase, "available");
  assert.equal(onStable.release.latestVersion, "0.20.0");
  assert.equal(onStable.release.sourceRepo, "KeepOak/Branch-Agent");
  assert.deepEqual(asked, ["https://api.github.com/repos/KeepOak/Branch-Agent/releases/latest"], "one question, to the new name");
});

test("when neither name has a release yet, the check says so rather than guessing", async () => {
  const updater = new Updater({ repo: "KeepOak/Branch-Agent", currentVersion: "0.19.1", channel: "stable",
    installDir: "C:/installed", executableName: "Branch Agent.exe", assetName: "Branch-Agent-windows-x64.zip",
    scratchDir: "C:/scratch", fetch: async () => ({ ok: false, status: 404, json: async () => ({ message: "Not Found" }) }) });
  const status = await updater.check();
  assert.equal(status.phase, "error");
  assert.match(status.message, /No release has been published yet\./);
});

/* Q37: measured minutes after publication, GitHub's release answer showed no assets while the release's own assets
   list had all nine; the installed check then said the download was missing. */
test("a newest release whose listed assets lag is read from its own assets list", async () => {
  const repo = "stabrea/Branch-Agent", name = "Branch-Agent-windows-x64.zip";
  const files = (tag) => [
    { name, browser_download_url: `https://github.com/${repo}/releases/download/${tag}/${name}`, size: 100 },
    { name: `${name}.sha256`, browser_download_url: `https://github.com/${repo}/releases/download/${tag}/${name}.sha256`, size: 96 },
  ];
  const asked = [];
  const make = (own) => new Updater({ repo, currentVersion: "0.19.1", channel: "stable",
    installDir: "C:/installed", executableName: "Branch Agent.exe", assetName: name, scratchDir: "C:/scratch",
    fetch: beforeTheMove(async (url) => {
      asked.push(url.replace(`https://api.github.com/repos/${repo}/`, ""));
      const assets = /releases\/(\d+)\/assets/.exec(url);
      if (assets) return { ok: true, status: 200, json: async () => own[assets[1]] ?? [] };
      return { ok: true, status: 200, json: async () => ({ id: 2, tag_name: "v0.19.2", name: "v0.19.2", body: "", published_at: "2026-09-23T09:42:16Z",
        html_url: `https://github.com/${repo}/releases/tag/v0.19.2`, prerelease: false, draft: false, assets: [] }) };
    }) });
  const found = await make({ 2: files("v0.19.2") }).check();
  assert.equal(found.phase, "available", found.message);
  assert.equal(found.release.latestVersion, "0.19.2");
  assert.equal(found.release.assetUrl, `https://github.com/${repo}/releases/download/v0.19.2/${name}`);
  assert.deepEqual(asked, ["releases/latest", "releases/2/assets?per_page=100"]);
  const missing = await make({}).check();
  assert.equal(missing.phase, "error");
  assert.match(missing.message, /missing its .* download or checksum/);
});

test("switching channels discards a check that was still in flight", async () => {
  let answer;
  const fetchPending = () => new Promise((resolve) => { answer = resolve; });
  const updater = new Updater({ repo: "stabrea/Branch-Agent", currentVersion: "0.19.1",
    installDir: "C:/installed", executableName: "Branch Agent.exe", assetName: "Branch-Agent-windows-x64.zip",
    scratchDir: "C:/scratch", fetch: fetchPending });
  const pending = updater.check();
  assert.equal(updater.status.phase, "checking");
  updater.setChannel("beta");
  answer({ ok: true, status: 200, json: async () => ({ tag_name: "v0.19.2", html_url: "https://github.com/stabrea/Branch-Agent/releases/tag/v0.19.2", assets: [] }) });
  assert.equal((await pending).phase, "idle");
  assert.equal(updater.status.release, null);
});

test("switching channels clears the previous attempt's provenance", () => {
  const updater = new Updater({ repo: "stabrea/Branch-Agent", currentVersion: "0.19.1", channel: "stable",
    installDir: "C:/installed", executableName: "Branch Agent.exe", assetName: "Branch-Agent-windows-x64.zip",
    scratchDir: "C:/scratch", fetch: async () => {} });
  // Simulate provenance from a previous attempt
  updater.provenance = { outcome: "checked", message: "A build provenance record was found…" };
  assert.ok(updater.provenance, "provenance is initially set from previous attempt");
  updater.setChannel("beta");
  assert.equal(updater.provenance, null, "setChannel clears the previous attempt's provenance");
});

test("check reports availability against the current version", async (t) => {
  const { root, installDir, fetchViaFixture } = await releaseFixture(t);
  const newer = new Updater({ repo: "stabrea/Branch-Agent", currentVersion: "0.2.0", installDir, executableName: "Branch Agent Test.exe",
    assetName: "Branch-Agent-windows-x64.zip", scratchDir: join(root, "scratch"), fetch: fetchViaFixture });
  const status = await newer.check();
  assert.equal(status.phase, "available");
  assert.equal(status.release.latestVersion, "0.3.0");
  assert.match(status.message, /0\.3\.0/);
  const current = new Updater({ repo: "stabrea/Branch-Agent", currentVersion: "0.3.0", installDir, executableName: "Branch Agent Test.exe",
    assetName: "Branch-Agent-windows-x64.zip", scratchDir: join(root, "scratch2"), fetch: fetchViaFixture });
  assert.equal((await current.check()).phase, "current");
  const unsupported = new Updater({ repo: "stabrea/Branch-Agent", currentVersion: "0.1.0", installDir: null, executableName: "Branch Agent Test.exe",
    assetName: "Branch-Agent-windows-x64.zip", scratchDir: join(root, "scratch3"), fetch: fetchViaFixture });
  assert.equal(unsupported.status.phase, "unsupported");
  await assert.rejects(unsupported.install(), /installed app only/);
});

test("automatic updates accept only final release tags", async (t) => {
  for (const tag of ["v0.3.0-beta", "0.3.0", "v01.3.0", "v0.3", "v0.3.0+", "latest"]) {
    const { root, installDir, fetchViaFixture } = await releaseFixture(t, { tag });
    const updater = new Updater({ repo: "stabrea/Branch-Agent", currentVersion: "0.2.0", installDir,
      executableName: "Branch Agent Test.exe", assetName: "Branch-Agent-windows-x64.zip",
      scratchDir: join(root, "scratch"), fetch: fetchViaFixture });
    const status = await updater.check();
    assert.equal(status.phase, "error", tag);
    assert.match(status.message, /final release tag/i, tag);
  }
});

test("automatic updates accept stable tags with build metadata", async (t) => {
  const { root, installDir, fetchViaFixture } = await releaseFixture(t, { tag: "v0.3.0+build.7" });
  const updater = new Updater({ repo: "stabrea/Branch-Agent", currentVersion: "0.2.0", installDir,
    executableName: "Branch Agent Test.exe", assetName: "Branch-Agent-windows-x64.zip",
    scratchDir: join(root, "scratch"), fetch: fetchViaFixture });
  const status = await updater.check();
  assert.equal(status.phase, "available");
  assert.equal(status.release.latestVersion, "0.3.0+build.7");
});

test("install downloads, verifies, unpacks beside the install and writes the hand-over script", { skip: !windows && "Windows archive tooling" }, async (t) => {
  const { root, installDir, fetchViaFixture } = await releaseFixture(t);
  const updater = new Updater({ repo: "stabrea/Branch-Agent", currentVersion: "0.2.0", installDir, executableName: "Branch Agent Test.exe",
    assetName: "Branch-Agent-windows-x64.zip", scratchDir: join(root, "scratch"), fetch: fetchViaFixture,
    runOnceKey: "HKCU\\Software\\BranchAgentTest\\RunOnce" }); // never the real RunOnce key
  t.after(() => run("reg.exe", ["delete", "HKCU\\Software\\BranchAgentTest", "/f"]).catch(() => undefined));
  const { script, stagedDir } = await updater.install();
  assert.equal(updater.status.phase, "ready");
  assert.equal(await readFile(join(stagedDir, "Branch Agent Test.exe"), "utf8"), "new executable");
  assert.equal(await readFile(join(stagedDir, "resources", "app.txt"), "utf8"), "new resources");
  assert.ok(!stagedDir.startsWith(installDir), "staging never lands inside the install");
  const text = await readFile(script, "utf8");
  assert.match(text, /robocopy\.exe ".*unpacked.*" ".*installed\.incoming" \/MIR/, "the new version is copied in beside the old one");
  assert.match(text, /move ".*installed" ".*installed\.previous"[\s\S]*move ".*installed\.incoming" ".*installed"/, "and the folders swap by renaming");
  assert.match(text, /robocopy\.exe ".*installed" ".*installed\.previous" \/MIR/, "previous version is kept");
  assert.match(text, /:restore[\s\S]*robocopy\.exe ".*installed\.previous" ".*installed" \/MIR/, "rollback path exists");
  assert.match(text, /start "" ".*installed\\Branch Agent Test\.exe"/);
  assert.match(text, /tasklist\.exe \/FI "PID eq %PID%" \/NH \/FO CSV/);
  assert.match(text, /%SystemRoot%\\System32\\find\.exe \/I "Branch Agent Test\.exe"/, "detects the running app by CSV listing with the system find");
  assert.match(text, /:drain[\s\S]*DRAIN% lss 15/, "waits for helper processes to exit");
  assert.match(text, /:wait[\s\S]*WAITED% lss 60[\s\S]*taskkill\.exe \/PID %PID% \/T \/F/, "ends the app itself if it does not close within the wait");
  assert.match(text, /app closed >>/, "logs when the app is gone");
  assert.match(text, /:copy[\s\S]*TRIES% lss 3/, "retries the copy before rolling back");
  assert.ok(!/\btimeout \/t/.test(text), "no timeout command; it fails without a console");
  assert.equal(await readFile(join(installDir, "Branch Agent Test.exe"), "utf8"), "old executable", "install untouched until the script runs");
  await run("cmd.exe", ["/d", "/c", script, "999999", "stay"]).catch(() => undefined);
  assert.equal(await readFile(join(installDir, "Branch Agent Test.exe"), "utf8"), "new executable");
  assert.ok(await stat(join(installDir, "resources", "app.txt")));
  assert.equal(await readFile(join(installDir + ".previous", "Branch Agent Test.exe"), "utf8"), "old executable", "previous version kept beside the install");
  assert.match(await readFile(join(root, "scratch", "apply-update.log"), "utf8"), /copying new version beside the old one, attempt 1/, "log kept for diagnosis");
});

test("a checksum mismatch refuses to install", { skip: !windows && "Windows archive tooling" }, async (t) => {
  const { root, installDir, fetchViaFixture } = await releaseFixture(t, { tamper: true });
  const updater = new Updater({ repo: "stabrea/Branch-Agent", currentVersion: "0.2.0", installDir, executableName: "Branch Agent Test.exe",
    assetName: "Branch-Agent-windows-x64.zip", scratchDir: join(root, "scratch"), fetch: fetchViaFixture });
  await assert.rejects(updater.install(), /did not match the published checksum/);
  assert.equal(updater.status.phase, "error");
  assert.equal(await readFile(join(installDir, "Branch Agent Test.exe"), "utf8"), "old executable");
});

test("work beginning during staging defers the update before any background engine is stopped", { skip: !windows && "Windows archive tooling" }, async (t) => {
  const { root, installDir, fetchViaFixture } = await releaseFixture(t);
  let stopped = 0;
  const updater = new Updater({ repo: "stabrea/Branch-Agent", currentVersion: "0.2.0", installDir,
    executableName: "Branch Agent Test.exe", assetName: "Branch-Agent-windows-x64.zip",
    scratchDir: join(root, "scratch"), fetch: fetchViaFixture,
    beforeStop: async () => { throw new UpdateDeferredError("Waiting for a task to finish."); },
    stopDaemon: async () => { stopped++; return null; } });
  await assert.rejects(updater.install(), /Waiting for a task/);
  assert.equal(updater.status.phase, "available", "the pending update is retried after work ends");
  assert.equal(stopped, 0);
  assert.equal(await readFile(join(installDir, "Branch Agent Test.exe"), "utf8"), "old executable");
});

test("a checksummed archive with the wrong package identity is refused before hand-over", { skip: !windows && "Windows archive tooling" }, async (t) => {
  for (const fixture of [
    { embeddedVersion: "9.9.9", message: /contains version 9\.9\.9.*release is 0\.3\.0/i },
    { embeddedName: "lookalike", message: /not a Branch Agent package/i },
  ]) {
    const { root, installDir, fetchViaFixture } = await releaseFixture(t, fixture);
    let backedUp = false;
    const updater = new Updater({ repo: "stabrea/Branch-Agent", currentVersion: "0.2.0", installDir,
      executableName: "Branch Agent Test.exe", assetName: "Branch-Agent-windows-x64.zip",
      scratchDir: join(root, "scratch"), fetch: fetchViaFixture, backup: async () => { backedUp = true; } });
    await assert.rejects(updater.install(), fixture.message);
    assert.equal(backedUp, false, "identity refusal happens before any owner-data backup or hand-over");
    await assert.rejects(stat(join(root, "scratch", "apply-update.cmd")), /ENOENT/);
  }
});

/**
 * CBQ-001: one invocation is one updater transaction. The guard is `busy`, but on a fresh updater it
 * is set only after the release has been looked up, and looking it up is a network round trip — so two
 * requests arriving during that trip both read `busy` as false and both go on to download, unpack and
 * write a hand-over script. Two hand-overs for one app is the multiplication this row forbids, and it
 * is counted here at the server rather than argued about.
 */
test("two install requests at once are one update, not two", { skip: !windows && "Windows archive tooling" }, async (t) => {
  const { root, installDir, fetchViaFixture, downloadCount } = await releaseFixture(t);
  const updater = new Updater({
    repo: "stabrea/Branch-Agent", currentVersion: "0.2.0", installDir, executableName: "Branch Agent Test.exe",
    assetName: "Branch-Agent-windows-x64.zip", scratchDir: join(root, "scratch"), fetch: fetchViaFixture,
  });
  const both = await Promise.allSettled([updater.install(), updater.install()]);
  const done = both.filter((one) => one.status === "fulfilled");
  assert.equal(done.length, 1, `one of the two requests did the work; got ${done.length}`);
  assert.equal(downloadCount(), 1, `the release was fetched once; it was fetched ${downloadCount()} times`);
  assert.match(String(both.find((one) => one.status === "rejected")?.reason?.message ?? ""), /already in progress/);
});

/**
 * CBQ-001, the half the first fix missed (review of 07f67542): install() gave the claim back as it
 * returned, but the Update button's handler still had the hand-over to start — three scheduler calls of
 * up to 15 s each. A second press in that time ran install() again, emptying the scratch folder the
 * first hand-over was about to use. With `hold`, the claim stays until `applying()` keeps it or
 * `release()` gives it back because the hand-over did not start.
 */
test("an install held for its hand-over refuses a second one until it is released", { skip: !windows && "Windows archive tooling" }, async (t) => {
  const { root, installDir, fetchViaFixture, downloadCount } = await releaseFixture(t);
  const updater = new Updater({
    repo: "stabrea/Branch-Agent", currentVersion: "0.2.0", installDir, executableName: "Branch Agent Test.exe",
    assetName: "Branch-Agent-windows-x64.zip", scratchDir: join(root, "scratch"), fetch: fetchViaFixture,
  });
  const { script } = await updater.install({ hold: true });
  assert.equal(updater.inProgress, true, "the claim is still held while the hand-over is being started");
  await assert.rejects(updater.install(), /already in progress/, "a second press starts nothing");
  assert.equal(downloadCount(), 1, "and fetches nothing");
  assert.ok((await stat(script)).isFile(), "the first hand-over's script is still there to be launched");

  updater.release();
  assert.equal(updater.inProgress, false, "a hand-over that did not start gives the claim back");
  await updater.install();
  assert.equal(downloadCount(), 2, "so the owner can try again");
  assert.equal(updater.inProgress, false, "and a plain install gives the claim back as it always did");
});

/**
 * The Update button's handler imports Electron, so it cannot be run here; like the other checks of
 * that file (tests/install-boring.test.mjs), this reads it. It must hold the claim through the
 * hand-over and give it back only when the hand-over did not start.
 */
test("the Update button holds the claim through the hand-over and gives it back only on failure", async () => {
  const ipc = await readFile(new URL("../src/desktop/updater-ipc.ts", import.meta.url), "utf8");
  // One install for the Update button and the app's own update loop alike (installNow), which the handler calls.
  const handler = ipc.slice(ipc.indexOf("const installNow = "), ipc.indexOf('ipcMain.handle("branch:open-external"'));
  // A confirmed move to another Dev line of work is passed beside it (src/desktop/update-readiness.ts confirmedChange).
  assert.match(handler, /updater\.install\(\{ hold: true(?:, automatic: automatic === true)?(?: \}|, \.\.\.\(confirmed \? \{ confirm: confirmed \} : \{\}\) \})\)/, "the handler asks for the claim to be held");
  const failure = handler.slice(handler.indexOf("} catch (error) {"));
  // Q55: `failed` gives the claim back and says what is still installed (tests/update-outcome.test.mjs).
  assert.match(failure, /^\} catch \(error\) \{\s*(?:\/\/[^\n]*\n\s*)*updater\.failed\([^;]*\);\s*throw error;/, "a hand-over that fails gives it back");
  assert.ok(handler.indexOf("launchHandOver(") < handler.indexOf("updater.failed("), "the release is on the hand-over's failure path");
  assert.equal((handler.match(/updater\.(?:release|failed)\(/g) ?? []).length, 1, "and nowhere else");
  // Q55: the words say the background engine was stopped only when this install really closed it.
  assert.match(handler, /throw new Error\(updater\.backgroundStopped\s*\?/, "the stopped-engine sentence follows what the updater did");
});

// Repo-move fallback tests: when KeepOak is 404, fall back to stabrea
test("release lookup tries KeepOak first; on 404, falls back to stabrea", async () => {
  const assetUrl = "https://example.com/branch-agent.zip";
  const checksumUrl = "https://example.com/branch-agent.zip.sha256";
  const responses = {};
  responses["KeepOak/Branch-Agent"] = { status: 404 }; // KeepOak not found yet
  responses["stabrea/Branch-Agent"] = {
    status: 200,
    json: async () => ({
      tag_name: "v0.3.0", name: "v0.3.0", body: "Release notes", published_at: "2026-09-23T00:00:00Z",
      html_url: "https://github.com/stabrea/Branch-Agent/releases/tag/v0.3.0",
      assets: [
        { name: "Branch-Agent-windows-x64.zip", browser_download_url: assetUrl, size: 1000 },
        { name: "Branch-Agent-windows-x64.zip.sha256", browser_download_url: checksumUrl, size: 96 },
      ],
    }),
  };
  const requested = [];
  const mockFetch = async (url) => {
    for (const [repo, response] of Object.entries(responses)) {
      if (url.includes(`repos/${repo}/releases`)) {
        requested.push(repo);
        return { ok: response.status === 200, status: response.status, json: response.json };
      }
    }
    return { ok: false, status: 404 };
  };
  const updater = new Updater({
    repo: "stabrea/Branch-Agent", currentVersion: "0.2.0", installDir: "C:/installed",
    executableName: "Branch Agent.exe", assetName: "Branch-Agent-windows-x64.zip",
    scratchDir: "C:/scratch", fetch: mockFetch,
  });
  const status = await updater.check();
  assert.equal(status.phase, "available", status.message);
  assert.equal(status.release?.latestVersion, "0.3.0");
  assert.equal(status.release?.assetUrl, assetUrl);
  assert.deepEqual(requested, ["KeepOak/Branch-Agent", "stabrea/Branch-Agent"], "tried KeepOak first, then stabrea");
});

test("release lookup does NOT fall back on HTTP 500 or other errors", async () => {
  const responses = {};
  responses["KeepOak/Branch-Agent"] = { status: 500 }; // Server error, not 404
  responses["stabrea/Branch-Agent"] = { status: 200, json: async () => ({}) };
  const requested = [];
  const mockFetch = async (url) => {
    for (const [repo, response] of Object.entries(responses)) {
      if (url.includes(`repos/${repo}/releases`)) {
        requested.push(repo);
        return { ok: false, status: response.status, json: response.json };
      }
    }
    return { ok: false, status: 404 };
  };
  const updater = new Updater({
    repo: "stabrea/Branch-Agent", currentVersion: "0.2.0", installDir: "C:/installed",
    executableName: "Branch Agent.exe", assetName: "Branch-Agent-windows-x64.zip",
    scratchDir: "C:/scratch", fetch: mockFetch,
  });
  const status = await updater.check();
  assert.equal(status.phase, "error", status.message);
  assert.match(status.message, /HTTP 500/);
  assert.deepEqual(requested, ["KeepOak/Branch-Agent"], "did not fall back to stabrea on 500");
});

test("release lookup does NOT fall back when fetch throws (network error)", async () => {
  const requested = [];
  const mockFetch = async (url) => {
    if (url.includes("repos/KeepOak/Branch-Agent/releases")) {
      requested.push("KeepOak/Branch-Agent");
      throw new Error("Network timeout");
    }
    requested.push("stabrea/Branch-Agent");
    return { ok: false, status: 404 };
  };
  const updater = new Updater({
    repo: "stabrea/Branch-Agent", currentVersion: "0.2.0", installDir: "C:/installed",
    executableName: "Branch Agent.exe", assetName: "Branch-Agent-windows-x64.zip",
    scratchDir: "C:/scratch", fetch: mockFetch,
  });
  const status = await updater.check();
  assert.equal(status.phase, "error", status.message);
  assert.match(status.message, /Network timeout/);
  assert.deepEqual(requested, ["KeepOak/Branch-Agent"], "did not fall back to stabrea on network error");
});
