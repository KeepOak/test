/* The locale files stay sorted by key, one key per line (scripts/locale-order.mjs), and the merge driver
   (scripts/merge-json-keys.mjs, wired in .gitattributes) merges key additions from both sides by key, stopping only on a
   key both sides set differently. Parallel pull requests used to append to the end of all four files and conflict.
   Mutation: in locale-order.mjs drop the .sort() and the "sorted" test goes red; in merge-json-keys.mjs take ours for
   every key and the driver drops theirs. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { discardTemp } from "./temp-dir.mjs";
import { LOCALE_FILES, localeText, unsorted } from "../scripts/locale-order.mjs";
import { mergeTables } from "../scripts/merge-json-keys.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const driver = fileURLToPath(new URL("../scripts/merge-json-keys.mjs", import.meta.url));

test("every locale file is sorted by key, one key per line (node scripts/locale-order.mjs sorts them)", () => {
  assert.deepEqual(unsorted(root), [], "unsorted locale files");
  assert.equal(localeText({ b: "2", a: "1" }), '{\n  "a": "1",\n  "b": "2"\n}\n');
  assert.equal(LOCALE_FILES.length, 4);
});

test(".gitattributes sends the locale files to the key merge driver", async () => {
  assert.match(await readFile(join(root, ".gitattributes"), "utf8"), /^public\/locales\/\*\.json merge=jsonkeys$/m);
});

test("keys merge by key: both sides' additions, one side's change or removal; a key set differently is a conflict", () => {
  const base = { a: "1", b: "2", c: "3" };
  const ours = { a: "1", b: "two", c: "3", x: "ours" };
  const theirs = { a: "1", b: "2", y: "theirs" }; // removed c, added y
  assert.deepEqual(mergeTables(base, ours, theirs), { merged: { a: "1", b: "two", x: "ours", y: "theirs" }, conflicts: [] });
  assert.deepEqual(mergeTables(base, { ...base, z: "A" }, { ...base, z: "A" }).conflicts, [], "the same addition on both sides");
  assert.deepEqual(mergeTables(base, { ...base, z: "A" }, { ...base, z: "B" }).conflicts, ["z"]);
  assert.deepEqual(mergeTables(base, { ...base, b: "ours" }, { a: "1", c: "3" }).conflicts, ["b"], "changed on one side, removed on the other");
});

test("the driver writes the merge sorted, or git's own conflict markers when a key clashes", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "branch-merge-json-"));
  t.after(() => discardTemp(dir));
  const put = (name, table) => writeFile(join(dir, name), localeText(table));
  const run = () => spawnSync(process.execPath, [driver, join(dir, "base"), join(dir, "ours"), join(dir, "theirs")], { encoding: "utf8" });
  const base = { "a.one": "1", "m.mid": "m", "z.last": "z" };
  await put("base", base);
  await put("ours", { ...base, "b.ours": "added by ours" });
  await put("theirs", { ...base, "y.theirs": "added by theirs" });
  assert.equal(run().status, 0);
  assert.equal(await readFile(join(dir, "ours"), "utf8"), localeText({ ...base, "b.ours": "added by ours", "y.theirs": "added by theirs" }));

  await put("ours", { ...base, "m.mid": "ours" });
  await put("theirs", { ...base, "m.mid": "theirs" });
  assert.notEqual(run().status, 0, "a clash stops the merge");
  assert.match(await readFile(join(dir, "ours"), "utf8"), /<<<<<<< ours[\s\S]*=======[\s\S]*>>>>>>> theirs/);
});
