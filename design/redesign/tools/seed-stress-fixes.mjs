/* Seeds a throwaway engine for verify-stress-fixes.cjs: one finished task, made while recordings are switched off (as they
   ship), so the verify can prove that switching them on plays a task that ran before. Nothing else is written here; the
   verify makes its Trunk and its sign-in connection through the engine's own routes.
     BRANCH_DATA_DIR=<fresh dir> BRANCH_WORKSPACE=<fresh dir> node design/redesign/tools/seed-stress-fixes.mjs */
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createBranch } from "../../../dist/index.js";

const dataDir = resolve(process.env.BRANCH_DATA_DIR ?? ".branch");
const workspace = resolve(process.env.BRANCH_WORKSPACE ?? "workspace");
const quiet = { name: "scripted", async complete() { return { content: "", toolCalls: [] }; } };

const app = await createBranch({ workspace, dataDir, provider: quiet });
const owner = app.runtime.owner;
try {
  const run = app.store.createRun(owner, "Summarise the notes from Monday");
  app.store.message(run.sessionId, { role: "user", content: run.prompt });
  app.store.message(run.sessionId, { role: "assistant", content: "Three points from Monday." });
  app.store.finish(run.id, "completed", "Three points from Monday.");
  writeFileSync(join(dataDir, "verify-stress-fixes.json"), JSON.stringify({ run: run.id }));
  console.log(`seeded run ${run.id}`);
} finally { await app.close(); }
