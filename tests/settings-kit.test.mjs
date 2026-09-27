import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer, offLimitsToShortLivedKeys } from "../dist/server.js";
import { neverTouched, secretShaped, settingsCatalogue, specFor } from "../dist/settings-kit/catalogue.js";
import { applyChanges, changesFor, resetProposals } from "../dist/settings-kit/changes.js";
import { presets } from "../dist/settings-kit/presets.js";
import { exportSettings, readSettingsFile } from "../dist/settings-kit/transfer.js";
import { fileMap, openFile, saveFile } from "../dist/settings-kit/file-map.js";
import { readPolicy } from "../dist/policy.js";
import { loopGuardMode, saveLoopGuardSettings } from "../dist/loop-guard.js";
import { folderTrustMode } from "../dist/folder-trust.js";
import { findFile } from "../dist/context-files.js";

/* R17-S-A: presets, putting settings back, one settings file, and the files the owner writes. */

const LOCALES = join(import.meta.dirname, "..", "public", "locales");

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-settings-kit-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  t.after(async () => { await app.close(); await discardTemp(root); });
  return { app, store: app.store, owner: app.runtime.owner, workspace: app.runtime.workspace, root };
}
const all = (changes) => ({ accept: changes.map((change) => change.id), confirmLoosening: true, why: "test" });

test("the catalogue names only settings: nothing locked away, nothing secret-shaped, every word in both languages", async () => {
  const en = JSON.parse(await readFile(join(LOCALES, "en.json"), "utf8"));
  const fr = JSON.parse(await readFile(join(LOCALES, "fr.json"), "utf8"));
  for (const spec of settingsCatalogue) {
    assert.ok(!neverTouched.some((pattern) => pattern.test(spec.key)), `${spec.key} is on the never-touched list`);
    assert.ok(en[spec.t] && fr[spec.t], `${spec.t} needs English and French`);
    for (const field of spec.fields) {
      assert.ok(!secretShaped.test(field.field), `${spec.key}.${field.field} sounds like a secret`);
      assert.ok(en[field.t] && fr[field.t], `${field.t} needs English and French`);
    }
  }
  for (const key of ["lockdown", "session-lock", "model-connections", "secret-commands", "people-groups", "remote-devices", "feature-switches-migration", "move-in:servers"])
    assert.equal(specFor(key), undefined, `${key} must never be reachable`);
  for (const preset of presets) {
    assert.ok(en[preset.t] && fr[preset.t] && en[preset.aboutT] && fr[preset.aboutT], `${preset.id} needs its words`);
  }
});

test("every preset only proposes values its settings can hold", async (t) => {
  const { store, owner } = await fixture(t);
  for (const preset of presets) {
    const { refused } = changesFor(store, owner, preset.sets);
    assert.deepEqual(refused, [], `${preset.id} proposes something the catalogue refuses`);
  }
});

test("a fresh install has nothing to put back, and a changed guard comes back only with a separate yes", async (t) => {
  const { store, owner } = await fixture(t);
  assert.deepEqual(changesFor(store, owner, resetProposals()).changes, [], "a new install is already at its defaults");
  saveLoopGuardSettings(store, owner, { mode: "on" });
  const { changes } = changesFor(store, owner, resetProposals());
  assert.deepEqual(changes.map((change) => [change.id, change.from, change.to, change.loosens]), [["loop_guard.mode", "on", "off", true]]);
  assert.throws(() => applyChanges(store, owner, changes, { ...all(changes), confirmLoosening: false }), /less careful/);
  assert.equal(loopGuardMode(store, owner), "on", "nothing was written when the yes was missing");
  applyChanges(store, owner, changes, all(changes));
  assert.equal(loopGuardMode(store, owner), "off");
  assert.deepEqual(changesFor(store, owner, resetProposals("loop_guard")).changes, []);
});

test("a preset shows each change first, and only the ticked ones are made, through each setting's own reader", async (t) => {
  const { store, owner } = await fixture(t);
  // A move of the approval preset is weighed on the tools Branch has; without them it counts as less careful.
  // This test has a store and no app, so it hands in a reading tool, a changing tool and a web one.
  const tools = { inventory: () => [{ name: "files.read", permission: "files.read" }, { name: "files.write", permission: "files.write" },
    { name: "web.fetch", permission: "web.read" }] };
  const careful = presets.find((preset) => preset.id === "careful");
  const { changes } = changesFor(store, owner, careful.sets, tools);
  const ids = changes.map((change) => change.id);
  assert.ok(ids.includes("policy.preset") && ids.includes("loop_guard.mode") && ids.includes("folder_trust_mode.mode"));
  assert.ok(changes.every((change) => !change.loosens), "being careful never loosens anything from a fresh install");
  applyChanges(store, owner, changes, { accept: ["policy.preset", "loop_guard.mode"], confirmLoosening: false, why: "test" });
  const policy = readPolicy(store, owner);
  assert.equal(policy.preset, "careful", "Q235: Careful has approvals of its own");
  assert.ok(policy.rules.length > 0, "the preset's rules were worked out the way the card does it");
  assert.equal(loopGuardMode(store, owner), "on");
  assert.equal(folderTrustMode(store, owner), "off", "an unticked line was not written");
  // Moving from careful to hands-off loosens the approval preset, and says so.
  const handsOff = changesFor(store, owner, presets.find((preset) => preset.id === "hands-off").sets, tools).changes;
  assert.equal(handsOff.find((change) => change.id === "policy.preset")?.loosens, true);
});

test("a switch that keeps an older yes/no has both kept in step", async (t) => {
  const { store, owner } = await fixture(t);
  const { changes } = changesFor(store, owner, [{ key: "desktop-control", field: "mode", value: "when-needed" }]);
  assert.equal(changes[0].loosens, true, "letting Branch use the screen reaches further");
  applyChanges(store, owner, changes, all(changes));
  // Q65: saved through the screen's own schema, as its card saves it, so the record also carries the schema's other fields.
  assert.deepEqual(store.get("settings", owner, "desktop-control").data, { mode: "when-needed", enabled: true, maxActionsPerRun: 40 });
  applyChanges(store, owner, changesFor(store, owner, resetProposals("desktop-control")).changes, { accept: ["desktop-control.mode"], confirmLoosening: false, why: "test" });
  assert.deepEqual(store.get("settings", owner, "desktop-control").data, { mode: "off", enabled: false, maxActionsPerRun: 40 });
});

test("a settings file carries only catalogued switches, never a secret, and round-trips", async (t) => {
  const one = await fixture(t);
  await one.store.secrets.put(one.owner, "default", "GITHUB_TOKEN", "ghp_should-never-leave-1234567890");
  one.store.save("settings", one.owner, "model-connections", { connections: [{ apiKey: "sk-never-in-a-file-123" }] });
  saveLoopGuardSettings(one.store, one.owner, { mode: "when-needed" });
  const file = exportSettings(one.store, one.owner, "0.17.0");
  const text = JSON.stringify(file);
  assert.doesNotMatch(text, /ghp_|sk-never|model-connections|lockdown/);
  assert.deepEqual(Object.keys(file.settings).sort(), settingsCatalogue.map((spec) => spec.key).sort());
  const other = await fixture(t);
  const { changes, refused } = changesFor(other.store, other.owner, readSettingsFile(text));
  assert.deepEqual(refused, []);
  assert.deepEqual(changes.map((change) => change.id), ["loop_guard.mode"]);
});

test("a crafted file cannot reach what is locked away, bring in a secret, or loosen anything unasked", async (t) => {
  const { store, owner } = await fixture(t);
  const crafted = JSON.stringify({
    format: "branch-settings", version: 1, exportedAt: "2026-09-17T00:00:00.000Z", appVersion: "x",
    settings: {
      lockdown: { on: false }, "session-lock": { mode: "off" }, "model-connections": { mode: "on" },
      "secret-commands": { mode: "on" }, "people-groups": { mode: "on" },
      voice: { apiKey: "sk-123", systemVoice: "on", speechRate: 2 },
      "desktop-control": { mode: "on", enabled: true, maxActionsPerRun: 200 },
      policy: { preset: "custom", rules: "[]" },
    },
  });
  const { changes, refused } = changesFor(store, owner, readSettingsFile(crafted));
  assert.deepEqual(changes.map((change) => change.id).sort(), ["desktop-control.mode", "voice.systemVoice"]);
  assert.ok(changes.every((change) => change.loosens));
  for (const id of ["lockdown.on", "session-lock.mode", "model-connections.mode", "secret-commands.mode", "people-groups.mode",
    "voice.apiKey", "voice.speechRate", "desktop-control.enabled", "desktop-control.maxActionsPerRun", "policy.preset", "policy.rules"])
    assert.ok(refused.some((line) => line.startsWith(`${id}:`)), `${id} should be refused`);
  assert.throws(() => applyChanges(store, owner, changes, { ...all(changes), confirmLoosening: false }), /less careful/);
  assert.equal(store.get("settings", owner, "desktop-control"), undefined);
  assert.throws(() => readSettingsFile("{not json"), /could not be read/);
  assert.throws(() => readSettingsFile(JSON.stringify({ format: "branch-agent" })), /not a Branch settings file/);
  assert.throws(() => readSettingsFile("x".repeat(300 * 1024)), /larger/);
});

test("which file does what: the map, editing through the loader, and the files that cannot be edited here", async (t) => {
  const { store, owner, workspace } = await fixture(t);
  await mkdir(workspace, { recursive: true });
  const map = fileMap(store, owner, workspace);
  assert.deepEqual(map.map((entry) => entry.slot), ["soul", "identity", "user", "agents", "tools", "sop", "memory", "heartbeat"]);
  assert.equal(map.find((entry) => entry.slot === "soul").scope, "you");
  assert.equal(map.find((entry) => entry.slot === "agents").scope, "project");

  const saved = saveFile(store, owner, workspace, { slot: "soul", text: "Speak plainly." });
  assert.equal(saved.text, "Speak plainly.\n");
  assert.equal(findFile({ workspace, owner: store.folder }, "soul").text, "Speak plainly.\n", "the loader reads what was saved");
  saveFile(store, owner, workspace, { slot: "agents", text: "Ask before renaming." });
  assert.equal(await readFile(join(workspace, "AGENTS.md"), "utf8"), "Ask before renaming.\n");
  saveFile(store, owner, workspace, { slot: "agents", text: "Shorter." });
  assert.equal(await readFile(join(workspace, "AGENTS.md"), "utf8"), "Shorter.\n", "saving replaces the whole file");

  assert.throws(() => saveFile(store, owner, workspace, { slot: "memory", text: "x".repeat(9000) }), /longer than your assistant reads/);
  await writeFile(join(workspace, "TOOLS.md"), "line\n".repeat(3000));
  assert.equal(openFile(store, owner, workspace, "tools").editable, false, "a file longer than the loader carries is not offered");
  assert.throws(() => saveFile(store, owner, workspace, { slot: "tools", text: "short" }), /cannot be changed here/);
  await writeFile(join(workspace, "..", "outside.md"), "outside\n");
  await symlink(join(workspace, "..", "outside.md"), join(workspace, "HEARTBEAT.md"));
  assert.throws(() => saveFile(store, owner, workspace, { slot: "heartbeat", text: "overwritten" }), /plain file|cannot be changed/);
  assert.equal(await readFile(join(workspace, "..", "outside.md"), "utf8"), "outside\n", "a link is never followed");
  assert.throws(() => saveFile(store, owner, workspace, { slot: "passwords", text: "x" }));

  store.save("settings", owner, "folder_trust_mode", { mode: "on" });
  assert.equal(openFile(store, owner, workspace, "agents").why, "not trusted");
  assert.throws(() => saveFile(store, owner, workspace, { slot: "agents", text: "x" }), /not trusted/);
  assert.equal(openFile(store, owner, workspace, "soul").editable, true, "a file about you is kept with your own things");
});

test("over HTTP: reads for the window, changes for the owner only, and a short-lived key kept out", async (t) => {
  const { app, root } = await fixture(t);
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(() => server.close());
  const call = async (path, body) => {
    const response = await fetch(server.url + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  const overview = await call("/api/settings-kit");
  assert.equal(overview.status, 200);
  assert.equal(overview.body.presets.length, presets.length);
  const plan = { source: "preset", preset: "careful" };
  const preview = await call("/api/settings-kit/preview", plan);
  assert.ok(preview.body.changes.length > 3);
  const applied = await call("/api/settings-kit/apply", { plan, accept: ["loop_guard.mode", "not.a-real-id"], confirmLoosening: false });
  assert.equal(applied.status, 200);
  assert.deepEqual(applied.body.applied.map((change) => change.id), ["loop_guard.mode"]);
  const loose = await call("/api/settings-kit/apply", { plan: { source: "set", key: "loop_guard", field: "mode", value: "off" }, accept: ["loop_guard.mode"] });
  assert.equal(loose.status, 409);
  assert.match(loose.body.error, /less careful/);
  const locked = await call("/api/settings-kit/preview", { source: "set", key: "lockdown", field: "on", value: false });
  assert.deepEqual(locked.body.changes, []);
  assert.equal((await call("/api/settings-kit/files/soul")).body.editable, true);
  assert.equal((await call("/api/settings-kit/files/nope")).status, 404);
  const exported = await call("/api/settings-kit/export");
  assert.equal(exported.body.format, "branch-settings");
  // A short-lived key: may look at the overview, never the file, the owner's files or a change.
  assert.equal(offLimitsToShortLivedKeys("GET", "/api/settings-kit"), null);
  for (const path of ["/api/settings-kit/export", "/api/settings-kit/files", "/api/settings-kit/files/soul"])
    assert.ok(offLimitsToShortLivedKeys("GET", path), `${path} must be refused to a short-lived key`);
  for (const path of ["/api/settings-kit/preview", "/api/settings-kit/apply", "/api/settings-kit/files"])
    assert.ok(offLimitsToShortLivedKeys("POST", path), `${path} must be refused to a short-lived key`);
});
