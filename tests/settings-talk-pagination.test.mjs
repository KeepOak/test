import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBranch } from "../dist/index.js";
import { settingsCatalogue } from "../dist/settings-kit/catalogue.js";
import { discardTemp } from "./temp-dir.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-settings-pages-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  // The learning core ships when needed (the ship-on rule); these tests move it from off, so the owner switches it off first.
  app.learningCore.configure({ mode: "off" });
  t.after(async () => { await app.close(); await discardTemp(root); });
  return (input) => app.registry.execute("settings.list", input, app.runtime.context({ source: "owner" }));
}

test("settings.list can reach every catalogued field without repeating a page", async (t) => {
  const list = await fixture(t);
  const expected = settingsCatalogue.flatMap((spec) => spec.fields.map((field) => `${spec.key}.${field.field}`));
  const first = await list({});
  assert.equal(first.shown.length, Math.min(80, expected.length));
  assert.equal(first.nextOffset, expected.length > 80 ? 80 : null);
  const seen = [];
  let offset = 0;
  while (offset !== null) {
    const page = await list({ offset, limit: 17 });
    assert.equal(page.total, expected.length);
    assert.ok(page.shown.length <= 17);
    seen.push(...page.shown.map((row) => row.setting));
    assert.ok(page.nextOffset === null || page.nextOffset > offset);
    offset = page.nextOffset;
  }
  assert.deepEqual(seen, expected);
});

test("settings.list applies pagination after its filters and ends an empty page", async (t) => {
  const list = await fixture(t);
  const expected = (await list({ search: "fly-core", onlyOff: true })).shown;
  const first = await list({ search: "fly-core", onlyOff: true, offset: 0, limit: 1 });
  assert.deepEqual(first.shown, expected);
  assert.equal(first.total, 1);
  assert.equal(first.nextOffset, null);
  const beyond = await list({ search: "fly-core", offset: 1, limit: 1 });
  assert.deepEqual(beyond.shown, []);
  assert.equal(beyond.total, 1);
  assert.equal(beyond.nextOffset, null);
});

test("settings.list rejects invalid page bounds", async (t) => {
  const list = await fixture(t);
  for (const input of [{ offset: -1 }, { offset: 0.5 }, { offset: 10001 },
    { limit: 0 }, { limit: 81 }, { limit: 1.5 }, { limit: "10" }]) {
    await assert.rejects(list(input));
  }
});
