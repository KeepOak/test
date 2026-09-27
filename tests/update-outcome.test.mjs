/**
 * Q55 in the updater: every status names the installed build (version, and the commit it was built
 * from or null), the offered release carries its own notes, and a failed update says the installed
 * version was kept until the next thing the updater does.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { Updater } from "../dist/desktop/updater.js";
import { ActivationJournal, lastActivation, settleActivation } from "../dist/never-break/activation.js";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

const repo = "stabrea/Branch-Agent", name = "Branch-Agent-windows-x64.zip", tag = "v9.9.9";
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const release = { tag_name: tag, name: "Branch Agent 9.9.9", body: "Faster start.\nFixed the Files view.", published_at: "2026-09-23T00:00:00Z",
  html_url: `https://github.com/${repo}/releases/tag/${tag}`, prerelease: false, draft: false,
  assets: [name, `${name}.sha256`].map((file) => ({ name: file, browser_download_url: `https://github.com/${repo}/releases/download/${tag}/${file}`, size: 100 })) };
/** GitHub answers the look-up; the download itself is refused, as a dropped connection would be. */
const github = async (url) => url.endsWith("/latest")
  ? { ok: true, status: 200, json: async () => release }
  : { ok: false, status: 503, body: null, headers: new Headers(), json: async () => ({}) };

async function make(t, extra = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-update-outcome-"));
  t.after(() => discardTemp(root));
  return new Updater({ lastReleaseWithoutProvenance: "9.9.9", repo, currentVersion: "0.19.3", channel: "stable", installDir: join(root, "installed"),
    executableName: "Branch Agent.exe", assetName: name, scratchDir: join(root, "scratch"), platform: "win32", fetch: github, ...extra });
}

test("every status names the installed build, with its commit or null when none was recorded", async (t) => {
  const stamped = await make(t, { currentCommit: COMMIT });
  assert.deepEqual(stamped.status.installed, { version: "0.19.3", commit: COMMIT });
  const checked = await stamped.check();
  assert.deepEqual(checked.installed, { version: "0.19.3", commit: COMMIT }, "still there after a check");
  assert.equal(checked.release.notes, "Faster start.\nFixed the Files view.", "the offered release's own notes");
  const unstamped = await make(t);
  assert.deepEqual(unstamped.status.installed, { version: "0.19.3", commit: null });
  const unsupported = new Updater({ repo, currentVersion: "0.19.3", installDir: null, executableName: "x", assetName: name, scratchDir: "unused", currentCommit: null });
  assert.equal(unsupported.status.phase, "unsupported");
  assert.deepEqual(unsupported.status.installed, { version: "0.19.3", commit: null });
});

test("a failed install says the installed version was kept, and the next check clears it", async (t) => {
  const updater = await make(t);
  assert.equal((await updater.check()).outcome, null);
  await assert.rejects(updater.install());
  assert.equal(updater.status.phase, "error");
  assert.deepEqual(updater.status.outcome, { kept: "0.19.3", backgroundStopped: false });
  assert.equal(updater.inProgress, false);
  assert.equal((await updater.check()).outcome, null, "a later check does not carry an old failure");
});

test("a hand-over that could not start gives the claim back and says what was kept", async (t) => {
  const updater = await make(t);
  await updater.check();
  const status = updater.failed("The update could not be started: no shell.");
  assert.equal(status.phase, "error");
  assert.equal(status.message, "The update could not be started: no shell.");
  assert.deepEqual(status.outcome, { kept: "0.19.3", backgroundStopped: false });
  assert.equal(updater.inProgress, false);
  assert.equal(status.release.latestVersion, "9.9.9", "the offered release is still named");
});

/** A release that downloads, verifies and unpacks without the network, so an install reaches the background engine. */
async function reachesTheEngine(t, stopDaemon) {
  const root = await mkdtemp(join(tmpdir(), "branch-update-outcome-"));
  t.after(() => discardTemp(root));
  const bytes = Buffer.from("pretend zip"), digest = createHash("sha256").update(bytes).digest("hex");
  const scratchDir = join(root, "scratch");
  const updater = new Updater({ lastReleaseWithoutProvenance: "9.9.9", repo: "x/y", currentVersion: "1.0.0", installDir: join(root, "installed"), executableName: "Branch Agent.exe",
    assetName: "app.zip", scratchDir, platform: "win32", backup: async () => {}, stopDaemon: () => stopDaemon(scratchDir),
    fetch: async (url) => String(url).includes("releases/latest")
      ? new Response(JSON.stringify({ tag_name: "v2.0.0", name: "Branch Agent 2.0.0", body: "", published_at: null, html_url: "https://github.com/x/y/releases/tag/v2.0.0",
        assets: [{ name: "app.zip", browser_download_url: "https://example.invalid/app.zip", size: bytes.length },
          { name: "app.zip.sha256", browser_download_url: "https://example.invalid/app.sha256", size: 64 }] }), { status: 200 })
      : String(url).endsWith("app.zip") ? new Response(bytes, { status: 200 }) : new Response(`${digest}  app.zip
`, { status: 200 }),
    extract: async (_archive, into) => {
      await mkdir(join(into, "app", "resources", "app"), { recursive: true });
      await writeFile(join(into, "app", "Branch Agent.exe"), "new");
      await writeFile(join(into, "app", "resources", "app", "package.json"), JSON.stringify({ name: "branch-agent", version: "2.0.0" }));
    } });
  await mkdir(join(root, "installed"), { recursive: true });
  return updater;
}

test("a failure after the background engine was closed says the engine was stopped, not that nothing changed", async (t) => {
  // The engine closes, then the hand-over script cannot be written (a folder is where its file goes).
  const updater = await reachesTheEngine(t, async (scratchDir) => { await mkdir(join(scratchDir, "recover-update.cmd")); return 4321; });
  await assert.rejects(updater.install());
  assert.equal(updater.status.phase, "error");
  assert.deepEqual(updater.status.outcome, { kept: "1.0.0", backgroundStopped: true });
  assert.equal(updater.backgroundStopped, true);
});

test("a hand-over that could not start after the engine was closed says the engine was stopped", async (t) => {
  const updater = await reachesTheEngine(t, async () => 4321);
  await updater.install({ hold: true });
  assert.equal(updater.backgroundStopped, true, "the window's message is chosen from this");
  assert.deepEqual(updater.failed("The update could not be started: no shell.").outcome, { kept: "1.0.0", backgroundStopped: true });
  assert.equal(updater.inProgress, false);
});

test("an engine stop that found nothing running is not called a stop", async (t) => {
  const updater = await reachesTheEngine(t, async () => null);
  await updater.install({ hold: true });
  assert.equal(updater.backgroundStopped, false);
  assert.deepEqual(updater.failed("The update could not be started: no shell.").outcome, { kept: "1.0.0", backgroundStopped: false });
});

test("the newest activation is read without writing, and an unconfirmed update settles as failed", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "branch-update-outcome-"));
  t.after(() => discardTemp(dataDir));
  const path = join(dataDir, "activation.sqlite");
  const thisStart = new Date(Date.now() - 1000);
  assert.equal(lastActivation(dataDir, thisStart), null, "nothing recorded");
  assert.equal(existsSync(path), false, "and no journal is created by looking");
  const journal = new ActivationJournal(path);
  const entry = { kind: "update", target: join(dataDir, "app"), previous: null, candidate: null, launcher: null,
    executableName: "Branch Agent.exe", understood: 1, databases: [], backups: [] };
  journal.activated(journal.stage({ ...entry, fromVersion: "0.19.2", toVersion: "0.19.3" }));
  journal.stage({ ...entry, fromVersion: "0.19.3", toVersion: "9.9.9" });
  journal.close();
  assert.equal(settleActivation(path, "0.19.3"), "failed");
  assert.deepEqual(lastActivation(dataDir, thisStart), { kind: "update", fromVersion: "0.19.3", toVersion: "9.9.9", state: "failed" });
});

/** A journal whose newest update never landed, settled as failed by the start that followed it. */
async function failedUpdate(t) {
  const dataDir = await mkdtemp(join(tmpdir(), "branch-update-outcome-"));
  t.after(() => discardTemp(dataDir));
  const journal = new ActivationJournal(join(dataDir, "activation.sqlite"));
  const entry = { kind: "update", target: join(dataDir, "app"), previous: null, candidate: null, launcher: null,
    executableName: "Branch Agent.exe", understood: 1, databases: [], backups: [] };
  journal.stage({ ...entry, fromVersion: "0.19.3", toVersion: "9.9.9" });
  journal.close();
  assert.equal(settleActivation(join(dataDir, "activation.sqlite"), "0.19.3"), "failed");
  return { dataDir, entry };
}

test("a failed update is not repeated by a later start", async (t) => {
  const { dataDir } = await failedUpdate(t);
  // The start that settled it says so; a start that began after it was settled does not.
  assert.equal(lastActivation(dataDir, new Date(Date.now() - 60_000))?.state, "failed");
  assert.equal(lastActivation(dataDir, new Date(Date.now() + 60_000)), null);
});

test("a later update that landed takes the failed one's place", async (t) => {
  const { dataDir, entry } = await failedUpdate(t);
  const journal = new ActivationJournal(join(dataDir, "activation.sqlite"));
  journal.activated(journal.stage({ ...entry, fromVersion: "0.19.3", toVersion: "9.9.10" }));
  journal.close();
  assert.deepEqual(lastActivation(dataDir, new Date(Date.now() - 60_000)), { kind: "update", fromVersion: "0.19.3", toVersion: "9.9.10", state: "activated" });
});

test("what the last update did is the owner's alone: a household person and a short-lived key are refused", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-update-outcome-"));
  const provider = { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const headers = { authorization: `Bearer ${server.token}`, "content-type": "application/json", origin: server.url };
  const call = async (method, path, body) => {
    const response = await fetch(server.url + path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  assert.deepEqual(await call("GET", "/api/never-break/last-update"), { status: 200, body: { last: null } });
  const person = (await call("POST", "/api/profiles", { name: "Sam", pin: "4321" })).body;
  assert.equal((await call("POST", "/api/profiles/switch", { profileId: person.id, pin: "4321" })).status, 200);
  const refused = await call("GET", "/api/never-break/last-update");
  assert.notEqual(refused.status, 200);
  assert.match(refused.body.error, /belongs to the owner/);
  const key = app.sessionTokens.create(app.runtime.owner, { name: "wall", scope: "read", minutes: 5 }).token;
  const byKey = await fetch(server.url + "/api/never-break/last-update", { headers: { authorization: `Bearer ${key}` } });
  assert.equal(byKey.status, 401, "a short-lived key is refused too");
});
