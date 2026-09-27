import test from "node:test";
import assert from "node:assert/strict";
import { link, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer, offLimitsToShortLivedKeys } from "../dist/server.js";
import { classify, securityShaped, settingsCatalogue } from "../dist/settings-kit/catalogue.js";
import { applyChanges, changesFor, loosens } from "../dist/settings-kit/changes.js";
import { presets } from "../dist/settings-kit/presets.js";
import { readSettingsFile } from "../dist/settings-kit/transfer.js";
import { saveFile } from "../dist/settings-kit/file-map.js";
import { reviewerSettings } from "../dist/approval-reviewer.js";
import { securityCheckSettings } from "../dist/security-audit/settings.js";
import { wallSettings } from "../dist/sandbox.js";
import { setLockdown } from "../dist/lockdown.js";
import { readPolicy } from "../dist/policy.js";
import { saveGoalUndoSettings } from "../dist/goal-mode.js";

/* R17-S-A integration review (adversarial pass): the holes found, each shut and kept shut. */

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-settings-kit-review-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  t.after(async () => { await app.close(); await discardTemp(root); });
  return { app, store: app.store, owner: app.runtime.owner, workspace: app.runtime.workspace, root };
}
const every = (changes, confirmLoosening = true) => ({ accept: changes.map((change) => change.id), confirmLoosening, why: "test" });
const settingsFile = (settings) => JSON.stringify({ format: "branch-settings", version: 1, exportedAt: "x", appVersion: "x", settings });

/** Every security-relevant switch named in the brief, under the names it has or is likely to get. */
const securitySwitches = [
  "never-break", "never-break-gateway", "add-ons", "add-on-wall", "add-ons-wall", "windows-without-wall", "page-notes",
  "web-pages", "autonomy", "plan-act", "orchestration", "personal-connectors", "tunnel", "remote-tunnel", "knobs",
  "knobs-env", "env-pass-through", "leak-guard", "accounts", "account-pools", "gateway", "launch-file", "lockdown",
  "session-lock", "people", "pairing", "remote-agent-pairing", "model-connections", "sandbox-backends", "mcp-sharing",
  "skill-scan", "session-limits", "interop-modes-list", "some-setting-added-next-month",
];

test("review: an unknown or security-relevant setting is blocked, and nothing security-shaped is plain", () => {
  for (const key of securitySwitches) {
    assert.equal(classify(key, "mode"), "blocked", `${key} must be blocked`);
    assert.equal(classify(key, "enabled"), "blocked", `${key} must be blocked`);
  }
  assert.equal(classify("loop_guard", "not-a-field"), "blocked", "an unknown field of a known setting is blocked too");
  assert.equal(classify("loop_guard", "mode"), "less-careful-when-lowered");
  assert.equal(classify("desktop-control", "mode"), "less-careful-when-raised");
  // Every security switch that does sit in the catalogue is flagged one way or the other.
  for (const key of ["os-sandbox", "folder_trust_mode", "policy", "approval_reviewer", "loop_guard", "security-check", "desktop-control", "keychain-entries"])
    for (const field of settingsCatalogue.find((spec) => spec.key === key).fields)
      assert.notEqual(classify(key, field.field), "plain", `${key}.${field.field} must not be plain`);
  for (const spec of settingsCatalogue)
    if (securityShaped.test(spec.key))
      for (const field of spec.fields) assert.notEqual(field.guard, "plain", `${spec.key}.${field.field} sounds like safety but is plain`);
  // Should a plain field ever sit on a safety-shaped setting, any move of it counts as less careful.
  const stray = { key: "sandbox-extra", fields: [] };
  const field = { field: "mode", label: "x", t: "x", kind: { type: "switch" }, initial: "off", guard: "plain" };
  assert.equal(loosens(field, "on", "off", stray), true);
  assert.equal(loosens(field, "off", "on", stray), true);
});

test("review: working until a goal is met is autonomy, and taking away the snapshots or letting it write skills is flagged", async (t) => {
  const { store, owner } = await fixture(t);
  // The ship-on rule turns goals on; this test is about Hands-off flagging the move to them, so goals start off.
  saveGoalUndoSettings(store, owner, { goal: "off" });
  const handsOff = changesFor(store, owner, presets.find((preset) => preset.id === "hands-off").sets).changes;
  assert.equal(handsOff.find((change) => change.id === "goal-undo.goal")?.loosens, true, "Hands-off lets it keep going on its own, and says so");
  assert.throws(() => applyChanges(store, owner, handsOff, every(handsOff, false)), /less careful/, "Hands-off never goes through without the separate yes");
  assert.equal(store.get("settings", owner, "policy"), undefined, "nothing was written");
  applyChanges(store, owner, handsOff, every(handsOff));
  const back = changesFor(store, owner, [{ key: "goal-undo", field: "snapshots", value: "off" }]).changes;
  assert.equal(back[0].loosens, true, "turning off the record of files before a task takes a protection away");
  const skills = changesFor(store, owner, [{ key: "reflection", field: "newSkills", value: "on" }]).changes;
  assert.equal(skills[0].loosens, true, "writing its own skills lets it reach further");
  // From "Ask before changes", Hands-off loosens the approvals and says so.
  const careful = changesFor(store, owner, [{ key: "policy", field: "preset", value: "ask-before-changes" }]).changes;
  applyChanges(store, owner, careful, every(careful));
  const again = changesFor(store, owner, presets.find((preset) => preset.id === "hands-off").sets).changes;
  assert.equal(again.find((change) => change.id === "policy.preset")?.loosens, true);
});

test("review: guards are saved through their own save, so a kept copy cannot go stale and a damaged record is not widened", async (t) => {
  const { store, owner } = await fixture(t);
  assert.equal(reviewerSettings(store, owner).mode, "off", "read once, and kept");
  const on = changesFor(store, owner, [{ key: "approval_reviewer", field: "mode", value: "on" },
    { key: "security-check", field: "malware", value: "on" }, { key: "os-sandbox", field: "network", value: "open" }]).changes;
  applyChanges(store, owner, on, every(on));
  assert.equal(reviewerSettings(store, owner).mode, "on", "the second look is really on, not only on the page");
  assert.equal(securityCheckSettings(store, owner).malware, "on");
  assert.equal(wallSettings(store, owner).network, "open");
  // A damaged wall record is read as the strictest wall; the kit shows that, and writing a field keeps the rest.
  store.save("settings", owner, "os-sandbox", { mode: "sideways", network: "open", keySites: { GITHUB_TOKEN: "api.github.com" } });
  assert.equal(wallSettings(store, owner).mode, "on");
  const fix = changesFor(store, owner, [{ key: "os-sandbox", field: "mode", value: "off" }]).changes;
  assert.equal(fix[0]?.from, "on", "the kit shows what the wall is really doing");
  assert.equal(fix[0]?.loosens, true);
});

test("review: a crafted settings file cannot pollute, reach locked records, or smuggle values out of bounds", async (t) => {
  const { store, owner } = await fixture(t);
  const crafted = '{"format":"branch-settings","version":1,"exportedAt":"x","appVersion":"x","settings":{'
    + '"__proto__":{"mode":"on","polluted":"yes"},"constructor":{"mode":"on"},"loop_guard":{"__proto__":{"x":1},"mode":"when-needed"},'
    + '"accounts":{"mode":"on"},"add-ons":{"wall":"off"},"leak-guard":{"mode":"off"},"knobs":{"env":"pass"},"never-break":{"mode":"off"},'
    + '"retention":{"keepDays":999999,"enabled":"yes"},"os-sandbox":{"network":"everywhere","keySites":{"A":"b"}},'
    + '"policy":{"preset":"custom","unmatchedCommands":"allow"}}}';
  const proposals = readSettingsFile(crafted);
  assert.equal({}.polluted, undefined, "nothing reached Object.prototype");
  const { changes, refused } = changesFor(store, owner, proposals);
  assert.deepEqual(changes.map((change) => change.id).sort(), ["loop_guard.mode", "policy.unmatchedCommands"]);
  assert.equal(changes.find((change) => change.id === "policy.unmatchedCommands").loosens, true);
  assert.equal(changes.find((change) => change.id === "loop_guard.mode").loosens, true, "the loop guard ships on, so lowering it is less careful");
  for (const id of ["accounts.mode", "add-ons.wall", "leak-guard.mode", "knobs.env", "never-break.mode", "retention.keepDays",
    "retention.enabled", "os-sandbox.network", "os-sandbox.keySites", "policy.preset"])
    assert.ok(refused.some((line) => line.startsWith(`${id}:`)), `${id} should be refused`);
  assert.throws(() => readSettingsFile(settingsFile(Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`k${i}`, {}])))), /not a Branch settings file/);
  assert.throws(() => readSettingsFile(settingsFile({ voice: { systemVoice: "on" } }).replace('"version":1', '"version":1,"extra":true')), /not a Branch settings file/);
});

test("review: the file editor never writes through a second name, and Branch's own files stay out of reach", async (t) => {
  const { store, owner, workspace, root } = await fixture(t);
  await mkdir(workspace, { recursive: true });
  const precious = join(root, "precious.txt");
  await writeFile(precious, "keep me\n");
  await link(precious, join(workspace, "AGENTS.md"));
  assert.throws(() => saveFile(store, owner, workspace, { slot: "agents", text: "overwritten" }), /plain file|cannot be changed/);
  assert.equal(await readFile(precious, "utf8"), "keep me\n", "a hard link is never written through");
  const refusals = [];
  const guard = (target) => { refusals.push(target); return "This would change Branch's own files."; };
  assert.throws(() => saveFile(store, owner, workspace, { slot: "sop", text: "steps" }, guard), /Branch's own files/);
  assert.ok(refusals.some((target) => target.endsWith("SOP.md")), "the never-break guard was asked about the file");
  const ok = saveFile(store, owner, workspace, { slot: "tools", text: "fine" }, () => null);
  assert.equal(ok.text, "fine\n");
});

test("review over HTTP: a person gets 400 everywhere, a short-lived key 401 on every change and the private reads", async (t) => {
  const { app, root } = await fixture(t);
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(() => server.close());
  const call = async (path, body, token = server.token) => {
    const response = await fetch(server.url + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", origin: server.url },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  const routes = [
    ["/api/settings-kit"], ["/api/settings-kit/export"], ["/api/settings-kit/files"], ["/api/settings-kit/files/user"],
    ["/api/settings-kit/files/memory"], ["/api/settings-kit/preview", { source: "reset" }],
    ["/api/settings-kit/apply", { plan: { source: "reset" }, accept: [] }], ["/api/settings-kit/files", { slot: "memory", text: "x" }],
  ];
  const made = await call("/api/profiles", { name: "Sam", pin: "4321" });
  await call("/api/profiles/switch", { profileId: made.body.id, pin: "4321" });
  for (const [path, body] of routes) {
    const answer = await call(path, body);
    // household-followups: the reads the kit answers itself and the owner-only routes src/server.ts
    // refuses before the kit is reached carry the same status, 400, as requireOwner always has.
    assert.equal(answer.status, 400, `${path} must be refused to a person the same way everywhere`);
    assert.match(answer.body.error, /belongs to the owner/);
  }
  await call("/api/profiles/switch", { profileId: null });
  // The owner still saves both kinds of file through the real never-break guard: a project's file in
  // the workspace, and a file about you in the data folder (the one place that guard is not asked).
  await mkdir(app.runtime.workspace, { recursive: true });
  for (const [slot, where] of [["memory", join(app.runtime.workspace, "MEMORY.md")], ["soul", join(app.store.folder, "SOUL.md")]]) {
    const saved = await call("/api/settings-kit/files", { slot, text: `about ${slot}` });
    assert.equal(saved.status, 200, `${slot}: ${saved.body.error}`);
    assert.equal((await call(`/api/settings-kit/files/${slot}`)).body.text, `about ${slot}\n`);
    assert.equal(await readFile(where, "utf8"), `about ${slot}\n`);
  }
  const run =app.sessionTokens.create(app.runtime.owner, { name: "script", scope: "run", minutes: 5 }).token;
  for (const [path, body] of routes.slice(1)) assert.equal((await call(path, body, run)).status, 401, `${path} must be refused to a run key`);
  for (const path of ["/api/settings-kit/files/soul-2", "/api/settings-kit/files/x_y", "/api/settings-kit/export/"])
    assert.ok(offLimitsToShortLivedKeys("GET", path), `${path} must be refused to a short-lived key`);
  assert.equal((await call("/api/settings-kit", undefined, run)).status, 200, "the overview only shows switches");
  const loose = await call("/api/settings-kit/apply", { plan: { source: "import", file: settingsFile({ "desktop-control": { mode: "on" } }) },
    accept: ["desktop-control.mode"] });
  assert.equal(loose.status, 409, "a file that loosens needs the separate yes");
  assert.equal(app.store.get("settings", app.runtime.owner, "desktop-control"), undefined);
  const huge = await call("/api/settings-kit/preview", { source: "import", file: "x".repeat(300 * 1024) });
  assert.ok(huge.status >= 400 && huge.status < 500);
  // While Lockdown is on, nothing here may change what it took over, or anything else.
  setLockdown(app.store, app.runtime.owner, { on: true });
  const locked = await call("/api/settings-kit/apply", { plan: { source: "preset", preset: "hands-off" },
    accept: ["policy.preset", "goal-undo.goal"], confirmLoosening: true });
  assert.equal(locked.status, 409);
  assert.match(locked.body.error, /Lockdown/);
  assert.equal(readPolicy(app.store, app.runtime.owner).preset, "custom", "Lockdown's rule stays in place");
});
