// A built file whose source is gone is removed before tsc compiles (scripts/prune-dist.mjs): tsc never deletes an
// output, and with dist/ restored from the CI build cache a deleted module would otherwise still import. Mutations
// that go red here: keeping an orphan, removing a file whose source exists, and touching the folders the copy steps
// own.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { orphanedOutputs, pruneDist } from "../scripts/prune-dist.mjs";
import { discardTemp } from "./temp-dir.mjs";

test("every tsc output of a gone source is an orphan; outputs of a present source and copied files are not", () => {
  const sources = new Set(["kept.ts", "deep/kept.ts", "preload.cts"]);
  const outputs = [
    "kept.js", "kept.js.map", "kept.d.ts", "deep/kept.js",
    "preload.cjs", "preload.cjs.map", "preload.d.cts",
    "gone.js", "gone.js.map", "gone.d.ts", "deep/gone.js", "gone-common.cjs", "gone-common.d.cts",
    "holidays.json", "handbook/start.md", "bundled-add-ons/tool/index.js", "data/evaluation/suite.json",
  ];
  assert.deepEqual(orphanedOutputs(outputs, (file) => sources.has(file)),
    ["gone.js", "gone.js.map", "gone.d.ts", "deep/gone.js", "gone-common.cjs", "gone-common.d.cts"]);
});

test("pruning a real folder removes only the orphans", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-prune-dist-"));
  t.after(() => discardTemp(root));
  const put = async (file) => { await mkdir(dirname(join(root, file)), { recursive: true }); await writeFile(join(root, file), ""); };
  for (const file of ["src/a.ts", "src/sub/b.ts", "dist/a.js", "dist/a.d.ts", "dist/sub/b.js", "dist/old.js", "dist/sub/old.js.map",
    "dist/holidays.json", "dist/bundled-add-ons/x/index.js"]) await put(file);
  const removed = pruneDist(join(root, "dist"), join(root, "src"));
  assert.deepEqual(removed.sort(), ["old.js", "sub/old.js.map"]);
  assert.deepEqual((await readdir(join(root, "dist"))).sort(), ["a.d.ts", "a.js", "bundled-add-ons", "holidays.json", "sub"]);
  assert.deepEqual(await readdir(join(root, "dist", "sub")), ["b.js"]);
  assert.deepEqual(pruneDist(join(root, "missing-dist"), join(root, "src")), [], "no dist/ yet: nothing to do");
});
