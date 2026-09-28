import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { desktopGatewayConfig } from "../dist/desktop/gateway-mode.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-desktop-gateway-mode-"));
  t.after(() => discardTemp(root));
  return root;
}
test("a desktop without a saved gateway choice ships on and records the migration", async (t) => {
  const root = await fixture(t);
  assert.equal((await desktopGatewayConfig(root)).config.mode, "on");
  assert.equal(JSON.parse(await readFile(join(root, "gateway.json"), "utf8")).mode, "on");
});
test("desktop migration preserves an explicit off and the exact saved file", async (t) => {
  const root = await fixture(t), path = join(root, "gateway.json"), saved = '{"mode":"off","holdSeconds":7}\n';
  await writeFile(path, saved);
  assert.equal((await desktopGatewayConfig(root)).config.mode, "off");
  assert.equal(await readFile(path, "utf8"), saved);
});
test("parallel first desktop launches share one complete migration file", async (t) => {
  const root = await fixture(t);
  const loaded = await Promise.all([desktopGatewayConfig(root), desktopGatewayConfig(root)]);
  assert.deepEqual(loaded.map((item) => item.config.mode), ["on", "on"]);
});
test("an unreadable saved choice remains untouched and does not become an on migration", async (t) => {
  const root = await fixture(t), path = join(root, "gateway.json");
  await writeFile(path, "{ not json");
  const loaded = await desktopGatewayConfig(root);
  assert.equal(loaded.config.mode, "off");
  assert.equal(await readFile(path, "utf8"), "{ not json");
});
