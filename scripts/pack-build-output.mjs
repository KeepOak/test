/**
 * `node scripts/pack-build-output.mjs <commit> <folder>`: after `npm run build`, packs dist/ and public/fonts/ into
 * `<folder>/branch-build-<commit>.bbo.gz` (src/desktop/build-output.ts), the file .github/workflows/beta-output.yml
 * publishes for the Beta update to take instead of compiling on the owner's computer. Prints the file's path.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { collectOutput, outputName, packOutput, unpackOutput } from "../dist/desktop/build-output.js";

const [commit, folder] = process.argv.slice(2);
if (!/^[0-9a-f]{40}$/.test(commit ?? "") || !folder) {
  console.error("usage: node scripts/pack-build-output.mjs <commit> <folder>");
  process.exit(2);
}
const packed = packOutput(await collectOutput("."));
unpackOutput(packed); // the very checks the app makes, before anything is published
await mkdir(folder, { recursive: true });
const file = join(folder, outputName(commit));
await writeFile(file, packed);
console.log(file);
