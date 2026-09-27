// Seeds a fresh engine data folder for verify-connectors.cjs: one conversation with a question and a reply, so a reply can
// be flagged. Run it while the engine is stopped:
//   BRANCH_DATA_DIR=<dir> BRANCH_WORKSPACE=<dir> node design/redesign/tools/seed-connectors.mjs
// then start the engine with the same two folders. Prints the conversation's id as JSON.
import { resolve } from "node:path";
import { createBranch } from "../../../dist/index.js";

const dataDir = resolve(process.env.BRANCH_DATA_DIR ?? ".branch");
const workspace = resolve(process.env.BRANCH_WORKSPACE ?? "workspace");
const quiet = { name: "scripted", async complete() { return { content: "", toolCalls: [] }; } };

const app = await createBranch({ workspace, dataDir, provider: quiet });
try {
  const run = app.store.createRun(app.runtime.owner, "What is six times seven?");
  app.store.message(run.sessionId, { role: "user", content: run.prompt });
  app.store.message(run.sessionId, { role: "assistant", content: "Six times seven is 41." });
  app.store.finish(run.id, "completed", "Six times seven is 41.");
  console.log(JSON.stringify({ session: run.sessionId }));
} finally {
  await app.close();
}
