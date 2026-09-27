// Writes tests/caller-policy.golden.txt: who may call every route, asked of a running engine (tests/caller-policy-world.mjs).
// Run it only when a change of who may call what is meant; the diff of the golden file is that change, for review.
//   node design/redesign/tools/write-caller-policy-golden.mjs
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { world, matrix, goldenText } from "../../../tests/caller-policy-world.mjs";

const started = Date.now();
const w = await world();
try {
  const rows = await matrix(w);
  await writeFile(join(import.meta.dirname, "../../../tests/caller-policy.golden.txt"), goldenText(rows));
  console.log(`${rows.length} lines in ${Math.round((Date.now() - started) / 1000)} s`);
} finally {
  await w.close();
}
