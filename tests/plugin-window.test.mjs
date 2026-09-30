// UI-261: an enabled plugin granted ui.contribute adds plain row badges, model-pill labels and composer drafts to an
// owner's existing conversation; without that grant its entries are left out and said so, and switching it off removes them.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Plugins } from "../dist/plugins.js";

const session = "0f8c2d4e-1b2a-4c3d-9e8f-123456789abc";
function store() {
  const rows = new Map();
  return { get: (_t, _o, id) => rows.get(id), save: (_t, _o, id, data) => rows.set(id, { id, data }), list: () => [...rows.values()],
    delete: (_t, _o, id) => rows.delete(id), onEvent: () => () => {}, profiles: { requireOwner() {} },
    ownsSession: (_owner, id) => id === session };
}
async function plugins(t, permissions) {
  const root = await mkdtemp(join(tmpdir(), "branch-plugin-window-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "plugins"));
  await writeFile(join(root, "plugins", "helper.mjs"), `export default { id: "helper", name: "Draft helper", permissions: ${JSON.stringify(permissions)},
    window: [{ id: "review", sessionId: "${session}", slot: "row-badge", messageId: 3, text: "Needs review" },
      { id: "draft", sessionId: "${session}", slot: "composer-draft", label: "Review this plan", text: "Please review this plan." }] };`);
  return new Plugins(store(), "owner", { register() {}, unregister() {} }, join(root, "plugins"));
}

test("a plugin granted ui.contribute shows its entries in that conversation only, named for the plugin", async (t) => {
  const p = await plugins(t, ["ui.contribute"]);
  await p.enable("helper", ["ui.contribute"]);
  const got = p.windowContributions(session);
  assert.deepEqual(got.map((e) => [e.id, e.slot, e.pluginName]), [["helper:review", "row-badge", "Draft helper"], ["helper:draft", "composer-draft", "Draft helper"]]);
  assert.throws(() => p.windowContributions("11111111-2222-4333-8444-555555555555"), /not found/);
  await p.disable("helper");
  assert.deepEqual(p.windowContributions(session), []);
});

test("without the ui.contribute grant nothing is shown and the plugin says what was left out", async (t) => {
  const p = await plugins(t, ["ui.contribute"]);
  const summary = await p.enable("helper", []);
  assert.deepEqual(p.windowContributions(session), []);
  assert.ok(summary.leftOut.some((line) => /ui\.contribute was not granted/.test(line)));
});
