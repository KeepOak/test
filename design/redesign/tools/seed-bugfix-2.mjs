// Seeds a fresh engine data folder for verify-bugfix-2.cjs, written the way the engine writes them itself: one finished
// task whose reply holds a ```chart block, one task stopped waiting for an answer in another conversation, and one
// remembered fact with its source. Run it while the engine is stopped:
//   BRANCH_DATA_DIR=<dir> BRANCH_WORKSPACE=<dir> node design/redesign/tools/seed-bugfix-2.mjs
// then start the engine with the same two folders. Prints the ids as JSON.
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createBranch } from "../../../dist/index.js";

const dataDir = resolve(process.env.BRANCH_DATA_DIR ?? ".branch");
const workspace = resolve(process.env.BRANCH_WORKSPACE ?? "workspace");
const quiet = { name: "scripted", async complete() { return { content: "", toolCalls: [] }; } };
export const CHART = 'Here are the figures.\n\n```chart\n{"type":"bar","title":"Cups by day","data":[{"label":"Mon","value":3},{"label":"Tue","value":7},{"label":"Wed","value":5}]}\n```';

const app = await createBranch({ workspace, dataDir, provider: quiet });
try {
  const owner = app.runtime.owner;
  const chart = app.store.createRun(owner, "Chart my week.");
  app.store.message(chart.sessionId, { role: "user", content: chart.prompt });
  app.store.message(chart.sessionId, { role: "assistant", content: CHART });
  app.store.finish(chart.id, "completed", CHART);

  const waiting = app.store.createRun(owner, "Write the notes file.");
  app.store.message(waiting.sessionId, { role: "user", content: waiting.prompt });
  app.store.finish(waiting.id, "needs_input", "");

  const fact = randomUUID();
  app.store.save("memory", owner, fact, { text: "Seeded fact for the bug-fix check", source: "Seeded by seed-bugfix-2.mjs", sourceRunId: chart.id });
  console.log(JSON.stringify({ chartRun: chart.id, chartSession: chart.sessionId, waitingRun: waiting.id, waitingSession: waiting.sessionId, fact }));
} finally {
  await app.close();
}
