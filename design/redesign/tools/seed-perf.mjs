// Seeds a fresh engine data folder for verify-perf.cjs with realistic amounts: 40 conversations, one of them long
// (150 turns, 300 messages), each written the way the engine writes a finished task. Run it while the engine is stopped:
//   BRANCH_DATA_DIR=<dir> BRANCH_WORKSPACE=<dir> node design/redesign/tools/seed-perf.mjs
// then start the engine with the same two folders. verify-perf.cjs makes the Trunks through the engine. Prints the long
// conversation's id as JSON.
import { resolve } from "node:path";
import { createBranch } from "../../../dist/index.js";

const dataDir = resolve(process.env.BRANCH_DATA_DIR ?? ".branch");
const workspace = resolve(process.env.BRANCH_WORKSPACE ?? "workspace");
const quiet = { name: "scripted", async complete() { return { content: "", toolCalls: [] }; } };
const para = (i) => `Point ${i}: ` + "the notes say the plan moves forward once the numbers are checked and the draft is read again. ".repeat(3);

const app = await createBranch({ workspace, dataDir, provider: quiet });
try {
  const owner = app.runtime.owner;
  let long = null;
  for (let turn = 0; turn < 150; turn++) {
    const run = app.store.createRun(owner, `Question ${turn} about the quarterly plan`, long ?? undefined);
    long = run.sessionId;
    app.store.message(run.sessionId, { role: "user", content: run.prompt });
    app.store.message(run.sessionId, { role: "assistant", content: `${para(turn)}\n\n- one\n- two\n\n\`\`\`js\nconst x = ${turn};\n\`\`\`` });
    app.store.finish(run.id, "completed", para(turn));
  }
  for (let c = 0; c < 39; c++) {
    const run = app.store.createRun(owner, `Conversation ${c}: tidy the folder`);
    for (let m = 0; m < 3; m++) {
      app.store.message(run.sessionId, { role: "user", content: `Step ${m} of conversation ${c}` });
      app.store.message(run.sessionId, { role: "assistant", content: para(m) });
    }
    app.store.finish(run.id, "completed", "Done.");
  }
  console.log(JSON.stringify({ long }));
} finally {
  await app.close();
}
