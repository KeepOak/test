/* #484, the window's side: after a restore, Overview shows one owner-only card with a line per Trunk the restore brought
   back cut down, in the engine's words ("Give <Trunk> back what it had" and what it would regain). The give button goes
   through only with the settings kit's tick (confirmLoosening), and the engine's refusal is shown otherwise; "Keep it"
   leaves the Trunk as it is. Every change is checked through the engine. Headless; a scripted model. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { newWindow, openPlace } from "./new-window-places.mjs";

const quiet = { name: "scripted", async complete() { return { content: "Hello.", toolCalls: [] }; } };

async function until(check, label, ms = 15000) {
  const end = Date.now() + ms;
  for (;;) { if (await check()) return; if (Date.now() > end) assert.fail(`Timed out: ${label}`); await new Promise((r) => setTimeout(r, 50)); }
}

async function backup(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-restore-trunks-window-"));
  const other = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: quiet });
  t.after(async () => { await other.close(); await discardTemp(root); });
  const made = [other.trunks.create({ name: "Helper" }), other.trunks.create({ name: "Second" })];
  await other.trunks.introduced();
  for (const trunk of made) other.trunks.records.put({ ...other.trunks.records.get(trunk.id), permissions: ["files.read", "files.write"], mcpServers: ["notes-server"] });
  return { snapshot: other.store.backup(other.version), made };
}

test("Overview's card gives a restored Trunk back what it had only with the tick, and Keep it keeps it cut down", async (t) => {
  const { snapshot, made: [helper, second] } = await backup(t);
  const { app, page, errors } = await newWindow(t, { seed: (app) => { app.store.restore(snapshot); } });
  const record = (id) => app.store.get("governance", app.runtime.owner, `trunk:${id}`)?.data;
  const place = await openPlace(page, "overview");
  const card = place.locator(".rt484");
  await card.waitFor();
  assert.equal(await card.locator(".rt484-row").count(), 2);
  const row = card.locator(".rt484-row").filter({ hasText: "Give Helper back what it had" });
  assert.match(await row.innerText(), /files\.write/);
  assert.match(await row.innerText(), /notes-server/);
  await row.locator('[data-act="rt484-give"]').click();
  await page.locator(".toast").filter({ hasText: /less careful/ }).first().waitFor();
  assert.equal(record(helper.id).paused, true, "nothing given back without the tick");
  await row.locator('[data-sw="rt484-yes"]').check();
  await row.locator('[data-act="rt484-give"]').click();
  await until(() => record(helper.id).paused === false, "given back through POST /api/restore/trunks");
  assert.deepEqual(record(helper.id).permissions, ["files.read", "files.write"]);
  await until(async () => (await card.locator(".rt484-row").count()) === 1, "its line is gone");
  await card.locator('.rt484-row [data-act="rt484-keep"]').click();
  await card.waitFor({ state: "detached" });
  assert.equal(record(second.id).paused, true, "kept as the restore brought it back");
  assert.deepEqual(record(second.id).mcpServers, []);
  assert.deepEqual(errors, []);
});
