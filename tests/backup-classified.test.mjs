/**
 * Q230 (NAS a1291bd, eba8bd8): every settings id src reads is classified for a backup: it stays on this computer, it
 * waits for the owner's yes, or it travels with a reason why any value a file carries is harmless. Five hand sweeps in a
 * row each found one more id that acted; this test fails for any new one instead. Node only, reads src.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { heldForTheOwner, staysOnThisComputer, travelsWithBackup } from "../dist/backup.js";

const src = fileURLToPath(new URL("../src/", import.meta.url));
function files(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : path.endsWith(".ts") ? [path] : [];
  });
}
/** Every `"settings", <owner>, <key>` call in src: a literal id, a template's fixed start, or a key worked out in code. */
function scan() {
  const ids = new Set(), prefixes = new Set(), computed = new Set();
  for (const file of files(src)) {
    const text = readFileSync(file, "utf8");
    const consts = new Map([...text.matchAll(/(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::\s*string)?\s*=\s*["']([a-z0-9][a-z0-9_:.-]*)["']/g)].map((m) => [m[1], m[2]]));
    // NAS dc50a36: single-quoted keys, and the ids raw SQL names, count too.
    for (const m of text.matchAll(/(?:FROM|INTO)\s+settings\b[^;`"]*?(?:id\s*=\s*|VALUES\s*\()'([a-z0-9][a-z0-9_:.-]*)'/g)) ids.add(m[1]);
    for (const m of text.matchAll(/["']settings["'],\s*[^,()]+(?:\([^()]*\))?,\s*(["']([^"']+)["']|`([^`$]*)\$\{|([A-Za-z_$][\w$.]*))/g)) {
      if (m[2] !== undefined) ids.add(m[2]);
      else if (m[3] !== undefined) prefixes.add(m[3]);
      else if (consts.has(m[4])) ids.add(consts.get(m[4]));
      else computed.add(`src/${file.slice(src.length).replaceAll("\\", "/")}: ${m[4]}`); // the same names on Windows
    }
  }
  return { ids, prefixes, computed };
}
/** Strings the scan matches that are not settings ids: a permission, a table, a label or a command. */
const notSettings = new Set(["[page]", "crashes", "help.", "installed_skills", "model", "other", "plan", "plugins.manage", "sessions", "settings.write"]);
/**
 * The places whose settings key is worked out in code. Each was read (Q230) and its keys are covered by the lists in
 * src/backup.ts; a new one fails here until someone reads it and adds it.
 */
const reviewedComputedKeys = new Set([
  "src/a2a-client.ts: recordId",
  "src/accounts/settings.ts: sessionKey",
  "src/add-ons/export.ts: this.key",
  "src/add-ons/lists.ts: this.key",
  "src/add-ons/package-shelf.ts: recordKey",
  "src/add-ons/pipelines.ts: key",
  "src/agent-export.ts: key",
  "src/agent-export.ts: entry.key",
  "src/asks/settings.ts: askKey",
  "src/asks/settings.ts: key",
  "src/autonomy/loops.ts: keyOf",
  "src/autonomy/settings.ts: autonomyKey",
  "src/autonomy/subgoals.ts: keyOf",
  "src/browser-container-api.ts: settingsKey",
  "src/channels/catch-up.ts: id",
  "src/channels/catch-up.ts: key",
  "src/channels/chat-commands.ts: usageKey",
  "src/channels/router.ts: key",
  "src/channels/webhook-address.ts: key",
  "src/coding/checklist.ts: key",
  "src/coding/settings.ts: codingKey",
  "src/comfort/settings.ts: keyOf",
  "src/conversation-mode.ts: key",
  "src/deferred.ts: this.key",
  "src/delight.ts: progressKey",
  "src/feature-switch-migration.ts: key",
  "src/feature-switches.ts: key",
  "src/flow-graph-run.ts: trunkKey",
  "src/flow-graph-run.ts: limitKey",
  "src/flow-graph-run.ts: sourceKey",
  "src/flows-boards/recipe-checks.ts: key",
  "src/flows-boards/settings.ts: boardKey",
  "src/flows-boards/settings.ts: key",
  "src/goal-mode.ts: key",
  "src/integrations/mcp-oauth.ts: settingsKey",
  "src/interop/settings.ts: interopKey",
  "src/knobs/settings.ts: keyOf",
  "src/learning-more/settings.ts: learningKey",
  "src/learning-more/settings.ts: key",
  "src/lockdown.ts: entry.key",
  "src/memory-git.ts: STATUS",
  "src/migrate/apply.ts: settingsId",
  "src/migrate/record.ts: recordId",
  "src/model-savings/settings.ts: keyOf",
  "src/never-break/channel-position.ts: id",
  "src/never-break/channel-position.ts: key",
  "src/never-break/resume.ts: replayKey",
  "src/never-break/resume.ts: key",
  "src/openapi-tools.ts: savedKey",
  "src/orchestration-modes.ts: this.key",
  "src/people/groups.ts: tuplesKey",
  "src/personal/settings.ts: personalKey",
  "src/personal/settings.ts: key",
  "src/plan-act.ts: key",
  "src/plan-act.ts: projectKey",
  "src/plan-act.ts: sessionKey",
  "src/plugin-catalog.ts: this.key",
  "src/plugins.ts: this.key",
  "src/profile-roles.ts: this.key",
  "src/prompt-library.ts: itemsKey",
  "src/reach/settings.ts: reachKey",
  "src/reach/settings.ts: key",
  "src/reflection/pass.ts: cursorKey",
  "src/reflection/skill-notes.ts: sidecar",
  "src/request-cache.ts: this.key",
  "src/request-cache.ts: row.id",
  "src/restore-held.ts: restoreHeldKey",
  "src/restore-held.ts: row.id",
  "src/safety-extras/settings.ts: safetyKey",
  "src/safety-extras/wasm-add-ons.ts: fingerprintKey",
  "src/server.ts: meaningSearchSetting",
  "src/server.ts: key",
  "src/session-carry.ts: recordId",
  "src/settings-kit/api.ts: spec.key",
  "src/settings-kit/catalogue.ts: key",
  "src/settings-kit/catalogue.ts: listenKey",
  "src/settings-kit/catalogue.ts: wakeWordKey",
  "src/settings-kit/catalogue.ts: dictationKey",
  "src/settings-kit/changes.ts: spec.key",
  "src/settings-kit/file-map.ts: undoKey",
  "src/skill-installs.ts: logKey",
  "src/skill-packages.ts: this.key",
  "src/skill-revisions.ts: this.key",
  "src/skill-tools.ts: pinnedSkillKey",
  "src/terminal-parity.ts: options",
  "src/tool-categories.ts: ToolCategory",
  "src/tool-report.ts: catalogHealthId",
  "src/tool-usage.ts: id",
  "src/trunks/settings.ts: trunkKey",
  "src/trunks/teach.ts: watchKey"
]);

const classified = (id) => staysOnThisComputer(id) || heldForTheOwner(id) || id in travelsWithBackup;

test("every settings id src reads stays, waits for the owner's yes, or travels with a reason", () => {
  const { ids, prefixes } = scan();
  assert.ok(ids.size > 150 && prefixes.size > 10, `control: the scan finds the ids (${ids.size}, ${prefixes.size})`);
  const loose = [...ids].filter((id) => !notSettings.has(id) && !(id.endsWith(":") ? classified(`${id}x`) || id in travelsWithBackup : classified(id)));
  assert.deepEqual(loose, [], "classify each in src/backup.ts");
  const loosePrefixes = [...prefixes].filter((prefix) => !classified(`${prefix}x`) && !(prefix in travelsWithBackup));
  assert.deepEqual(loosePrefixes, [], "classify each prefix in src/backup.ts");
});

test("a travelling id is in no other list, and says why", () => {
  for (const [id, why] of Object.entries(travelsWithBackup)) {
    const probe = id.endsWith(":") ? `${id}x` : id;
    assert.equal(staysOnThisComputer(probe) || heldForTheOwner(probe), false, `${id} is listed twice`);
    assert.ok(why.length > 10, `${id} says why`);
  }
});

test("every place that works out a settings key in code has been read", () => {
  const { computed } = scan();
  assert.deepEqual([...computed].filter((site) => !reviewedComputedKeys.has(site)).sort(), [], "read it, cover its keys in src/backup.ts, then add it here");
});

// NAS eba8bd8: a conversation's waiting line never travels, so a file cannot queue words to run as the owner's next task.
test("a conversation's waiting line, a plan and a chat's link are never put in place from a file", () => {
  assert.equal(staysOnThisComputer("followups:any"), true);
  for (const id of ["plan:any", "channel-session:telegram:1", "project:any", "session-model:any", "slack-automations", "models"])
    assert.equal(heldForTheOwner(id) && !staysOnThisComputer(id), true, `${id} waits for the owner`);
});

/** One key each place that works out its key in code produces, and where it must land (Q230, the computed-key read). */
const computedExamples = {
  stays: ["remote-agent:x", "deferred:x", "flow-run-limit:x", "flow-run-source:x", "flow-run-trunk:x", "move-in:x",
    "channel-mark:telegram", "channel-position:telegram", "channel-replay:telegram:1:2", "webhook-address:slack",
    "mcp-oauth:server", "settings-kit-file-undo-1", "trunk-watch:t", "cache:abc", "session-carry:s", "plugin:p",
    "plugin-catalog:p", "safety-wasm-add-on:w", "restore-held", "listen-address", "memory-history-status",
    "coding-shell-snapshot", "code-run", "background-processes", "keychain-entries"],
  held: ["account-session:s", "add-on-export:a", "add-on-list:a", "add-on:a", "add-on-pipelines:a", "asks-hindsight",
    "asks-nodes-list", "autonomy-loop:s", "autonomy-heartbeat:s", "autonomy-subgoals:s", "browser-container",
    "channel-session:telegram:1", "coding-checklist:s", "coding-read-first", "coding-ci", "comfort-notify",
    "conversation-mode:s", "goal:s", "interop-fleet", "interop-handoff", "knobs-compaction", "learning-more-providers-settings",
    "model-savings-mixtures", "handoffs:x", "openapi-service:w", "profile-role:p", "personal-email-settings", "plan-act:project:p",
    "plan-act:session:s", "pinned-skill:s", "skill-package:k", "skill-candidate:k:1", "trunks-messages", "trunks-routines",
    "flowboards-recipe-checks:p", "tool-meaning-search", "people-shares", "policy", "desktop-control", "wake-word",
    "live-dictation", "routing", "model-profiles", "models", "governance"],
  travels: ["channel-usage:telegram:1", "delight-achievements", "prompt-library-items", "reflection-cursor:s",
    "reflection-note:p", "skill-install-log", "tool_catalog_health", "ask-first"],
};
const travels = (id) => id in travelsWithBackup || Object.keys(travelsWithBackup).some((key) => key.endsWith(":") && id.startsWith(key));

test("each key worked out in code lands where its reading put it", () => {
  for (const id of computedExamples.stays) assert.equal(staysOnThisComputer(id), true, `${id} stays on this computer`);
  for (const id of computedExamples.held) assert.equal(heldForTheOwner(id) && !staysOnThisComputer(id), true, `${id} waits for the owner`);
  for (const id of computedExamples.travels) {
    assert.equal(staysOnThisComputer(id) || heldForTheOwner(id), false, `${id} travels`);
    assert.ok(travels(id), `${id} says why it travels`);
  }
});

// NAS dc50a36: an id no list names (a raw query nobody scanned, a key added later) waits for the owner's yes.
test("an id in none of the lists waits for the owner's yes, and a plain catalogue setting still travels", () => {
  for (const id of ["made-up-later", "dream-cursor", "learning"]) assert.equal(heldForTheOwner(id) && !staysOnThisComputer(id), true, `${id} waits`);
  assert.equal(staysOnThisComputer("memory-snapshot:s"), true);
  assert.equal(heldForTheOwner("comfort-display"), false, "a plain catalogue card travels");
  assert.equal(heldForTheOwner("mcp-serving"), false);
});
