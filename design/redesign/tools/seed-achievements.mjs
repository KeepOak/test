// Seeds a fresh engine data folder for verify-achievements.cjs with a real past and the delight record an install kept
// from before Q251 (every switch at the old "off" default, nothing chosen, achievements never looked at): six tasks
// really run through the engine's runtime (a scripted model answers "Done."). Run it while the engine is stopped:
//   BRANCH_DATA_DIR=<dir> BRANCH_WORKSPACE=<dir> node design/redesign/tools/seed-achievements.mjs
// then start the engine with the same two folders; verify-achievements.cjs adds Trunks and a settings change through
// the engine's routes. Prints how many tasks were run as JSON.
import { resolve } from "node:path";
import { createBranch } from "../../../dist/index.js";

const dataDir = resolve(process.env.BRANCH_DATA_DIR ?? ".branch");
const workspace = resolve(process.env.BRANCH_WORKSPACE ?? "workspace");
const provider = { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } };

const app = await createBranch({ workspace, dataDir, provider });
try {
  const owner = app.runtime.owner;
  app.store.save("settings", owner, "delight", {
    pets: { on: false, kind: "squirrel", name: "Hazel", talks: true, tips: true }, achievements: { on: false, quiet: false },
    look: { style: "pixel" }, background: { on: false, scrim: 60, fit: "fill" },
  });
  const tasks = 6;
  for (let i = 0; i < tasks; i++) await app.runtime.run({ prompt: `Seeded task ${i + 1}` });
  console.log(JSON.stringify({ tasks }));
} finally {
  await app.close();
}
