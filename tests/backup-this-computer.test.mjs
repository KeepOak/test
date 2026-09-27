/**
 * What is about this computer and whom it trusts stays here, like the sign-ins (Q168 A): which workspaces'
 * integration files may load, the outside assistants and their keys, the SSH computers, the commands that
 * fetch secrets and the paired devices. A changed backup could otherwise point Branch at a program, a machine
 * or a person the owner never chose here (NAS 1edead2, f0a62c9). Node only.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { restoreBackup } from "../dist/server.js";
import { staysOnThisComputer, thisComputerSettings } from "../dist/backup.js";
import { engageStop, stopState } from "../dist/safety-extras/emergency-stop.js";
import { decideFolder, folderTrust, integrationsFileTrusted, realFolder, saveFolderTrustSettings } from "../dist/folder-trust.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-backup-computer-"));
  const provider = { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const owner = app.runtime.owner;
  const setting = (key) => app.store.get("settings", owner, key)?.data;
  return { app, owner, setting, workspace: join(root, "workspace") };
}
// NAS 360099c: named here as well as in the list, so dropping one from the list turns the planting tests red too.
const keys = [...new Set([...thisComputerSettings, "devices-book", "remote-agent:helper", "jev-decisions", "vector-store", "trace"])];

test("the list is what Q168 A names, and devices-book stays too (named once, with the #186 fix's sign-ins)", () => {
  assert.deepEqual([...thisComputerSettings].sort(), ["adapt-stops", "background-processes", "channel-setup-done", "code-check", "code-run", "coding-shell-snapshot", "coding-worktree-forks", "comfort-update-failed", "dashboard-paused", "debug-adapters", "devices-join", "devices-picks", "feature-switches-migration", "folder-trust-copies", "folder-trust-real", "folder_trust", "folder_trust_mode", "git-checkpoints", "heartbeat-state", "jev-decisions", "keychain-entries", "language-servers", "learning-more-readback-last", "listen-address", "lockdown", "media-programs", "memory-history-status", "obsidian", "onboarding", "os-sandbox", "practice-previous-project", "practice-session", "reach-machine-name", "reach-relay-seen", "reach-relay-settings", "reach-remote-trunks-inbox", "reach-remote-trunks-keys", "reach-video-count", "remote-agent-pairing", "remote-computers", "run_queue", "safety-code-approvals-setup", "safety-emergency-stop", "sandbox-backends", "secret-commands", "speech-engines", "studies", "trace", "trunk-receipts", "vector-store", "voice", "webhook-waits"].sort());
  assert.equal(staysOnThisComputer("devices-book"), true);
  assert.equal(thisComputerSettings.includes("devices-book"), false, "one list names it, not two");
});

test("a backup carries nothing about this computer's trust, and still carries the owner's other settings", async (t) => {
  const { app, owner } = await fixture(t);
  for (const key of keys) app.store.save("settings", owner, key, { mine: key });
  app.store.save("settings", owner, "theme-probe", { kept: true });
  const ids = app.store.backup(app.version).tables.settings.map((row) => row.id);
  for (const key of keys) assert.ok(!ids.includes(key), `${key} is not in the backup`);
  assert.ok(ids.includes("theme-probe"));
});

test("a changed backup plants none of them, and replacing keeps this computer's own", async (t) => {
  const { app, owner, setting } = await fixture(t);
  app.store.save("settings", owner, "remote-agent:mine", { url: "https://mine.example", key: "this computer's" });
  app.store.save("settings", owner, "secret-commands", { mine: true });
  const changed = app.store.backup(app.version);
  const now = new Date().toISOString();
  for (const key of [...keys, "remote-agent:planted"])
    changed.tables.settings.push({ id: key, owner, data: JSON.stringify({ planted: key }), created_at: now, updated_at: now });
  // Over this Branch, replacing it.
  await app.runtime.run({ prompt: "hello", onTextDelta: () => undefined });
  await restoreBackup(app, async () => changed, true);
  for (const key of [...keys, "remote-agent:planted"]) assert.ok(!setting(key)?.planted, `${key} is not taken from the file`);
  assert.deepEqual(setting("remote-agent:mine"), { url: "https://mine.example", key: "this computer's" }, "this computer's own stays");
  assert.deepEqual(setting("secret-commands"), { mine: true }, "even the commands that fetch secrets");
  // Into a fresh Branch.
  const fresh = await fixture(t);
  await restoreBackup(fresh.app, async () => changed, false);
  // A fresh Branch writes some of these itself (the switch migration); what matters is that none holds the file's value.
  for (const key of [...keys, "remote-agent:planted"]) assert.ok(!fresh.setting(key)?.planted, `${key} is not planted in a fresh Branch`);
});

test("a changed backup cannot make a copy Branch never made share a trusted folder's decision (folder-trust-copies)", async (t) => {
  const { app, owner, workspace } = await fixture(t);
  const repo = join(workspace, "repo"), copy = join(repo, ".branch-worktrees", "x");
  await mkdir(repo, { recursive: true });
  const git = (...args) => execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args], { cwd: repo, stdio: "ignore" });
  git("init", "-q"); await writeFile(join(repo, "README.md"), "hello\n"); git("add", "."); git("commit", "-qm", "first");
  git("worktree", "add", "-q", "-b", "x", copy);
  await writeFile(join(copy, ".mcp.json"), JSON.stringify({ mcpServers: {} }));
  saveFolderTrustSettings(app.store, owner, { mode: "on" });
  decideFolder(app.store, owner, workspace, { folder: "repo", decision: "trust" });
  const mayLoad = () => integrationsFileTrusted(app.store, owner, workspace, join(copy, ".mcp.json"));
  assert.equal(folderTrust(app.store, owner, copy), "unknown", "control: Branch has no record of this copy");
  assert.equal(mayLoad(), false);
  const changed = app.store.backup(app.version);
  const now = new Date().toISOString();
  changed.tables.settings.push({ id: "folder-trust-copies", owner, created_at: now, updated_at: now,
    data: JSON.stringify({ copies: [{ source: realFolder(repo), copy: realFolder(copy) }] }) });
  await restoreBackup(app, async () => changed, true);
  assert.equal(folderTrust(app.store, owner, copy), "unknown", "the file's record of a copy is not taken");
  assert.equal(mayLoad(), false, "so the copy's integrations file still may not load");
});

test("a replacing restore keeps this computer's own paired chat senders (NAS ecd115b, the #186 merge)", async (t) => {
  const { app, owner, setting } = await fixture(t);
  app.store.save("settings", owner, "channel-pair:telegram:5:88", { approved: true, mine: true });
  app.store.save("settings", owner, "sender-allowlist", { senders: ["telegram:5:88"] });
  // A backup from another computer (or an older one) carries no senders of this computer's at all.
  const changed = app.store.backup(app.version);
  changed.tables.settings = changed.tables.settings.filter((row) => !row.id.startsWith("channel-pair:") && row.id !== "sender-allowlist");
  await restoreBackup(app, async () => changed, true);
  assert.deepEqual(setting("channel-pair:telegram:5:88"), { approved: true, mine: true });
  assert.deepEqual(setting("sender-allowlist"), { senders: ["telegram:5:88"] });
});

test("an emergency stop pressed here stays pressed through a replacing restore; letting it go is the owner's, with the code", async (t) => {
  const { app, owner } = await fixture(t);
  const released = app.store.backup(app.version); // made before the stop was pressed
  engageStop(app.store, owner, { network: true, tools: ["shell.execute"] });
  await restoreBackup(app, async () => released, true);
  const after = stopState(app.store, owner);
  assert.equal(after.engaged, true);
  assert.deepEqual([after.network, after.tools], [true, ["shell.execute"]]);
});

// NAS 2db8099: where the door listens, this computer's name, and its place at a relay (its id there and the envelopes
// it has already taken) are about this computer: never in a backup, never planted, and kept by a replace.
test("where this computer listens, its name, and its place at a relay stay on it (NAS 2db8099)", async (t) => {
  const { app, owner, setting } = await fixture(t);
  const here = ["listen-address", "reach-machine-name", "reach-relay-settings", "reach-relay-seen", "lockdown", "safety-wasm-add-on:tidy",
    // NAS dfb2136: a program and its arguments, as a changed file would plant them.
    "speech-engines", "voice", "media-programs",
    // NAS f30facf: programs run by a read, after a patch or by name, the container image, and a hook's own state.
    "language-servers", "debug-adapters", "code-check", "background-processes", "sandbox-backends", "hook:nightly",
    // NAS dd7589d: code-run's program, and Branch's own records of its state here.
    "code-run", "feature-switches-migration", "webhook-waits", "deferred:x", "move-in:y", "flow-run-limit:z", "flow-run-source:z"];
  for (const key of here) app.store.save("settings", owner, key, { mine: key });
  const archive = app.store.backup(app.version);
  for (const key of here) assert.ok(!archive.tables.settings.some((row) => row.id === key), `${key} is not in the backup`);
  const now = new Date().toISOString();
  for (const key of here) archive.tables.settings.push({ id: key, owner, data: JSON.stringify({ planted: key }), created_at: now, updated_at: now });
  await restoreBackup(app, async () => archive, true);
  for (const key of here) assert.deepEqual(setting(key), { mine: key }, `${key}: this computer's own stays`);
});

// NAS 23e7382: a file's `lockdown` carried a `before` of its own ({policy: off, desktop-control: on}); "Lockdown off"
// wrote it back as it was, so held rows went into place with nobody asked. Lockdown now stays on this computer.
test("a file's Lockdown never replaces this computer's, so turning it off puts back only this computer's own values", async (t) => {
  const { app, owner, setting } = await fixture(t);
  app.store.save("settings", owner, "policy", { preset: "ask-before-changes", rules: [] });
  const archive = app.store.backup(app.version);
  const now = new Date().toISOString();
  archive.tables.settings.push({ id: "lockdown", owner, created_at: now, updated_at: now,
    data: JSON.stringify({ on: true, since: now, before: { policy: { preset: "off" }, "desktop-control": { enabled: true } } }) });
  await restoreBackup(app, async () => archive, true);
  assert.notEqual(setting("lockdown")?.on, true, "the file's Lockdown is not in place");
  assert.deepEqual(setting("policy"), { preset: "ask-before-changes", rules: [] }, "and nothing it carried can be written back");
  assert.equal(setting("desktop-control"), undefined);
});
