// Seeds a fresh engine data folder with three helpers the stand-in model can hand work to (DESIGN-DIRECTION PR 1; the
// window's helpers frame PRs use it): three evaluated, promoted specialists, made through the engine's own tools
// (specialists.propose, .evaluate, .promote, as tests/orchestration.test.mjs makes them), and notes.txt in the
// workspace for them to read. Writes <data dir>/helpers-seed.json for stub-model-helpers.cjs. Run it while the engine
// is stopped:
//   BRANCH_DATA_DIR=<dir> BRANCH_WORKSPACE=<dir> node design/redesign/tools/seed-helpers.mjs
// then start the stand-in model and the engine with the same two folders:
//   node design/redesign/tools/stub-model-helpers.cjs 1234 <dir>/helpers-seed.json
//   BRANCH_DATA_DIR=<dir> BRANCH_WORKSPACE=<dir> BRANCH_PORT=<port> node dist/cli.js start
// connect it (POST /api/connections/from-preset {provider:"lm-studio", key:"x", model:"stub-model"}) and send a message
// holding "HELPERS": the task hands three jobs to the helpers at once, and each works for 45 s.
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createBranch } from "../../../dist/index.js";

const dataDir = resolve(process.env.BRANCH_DATA_DIR ?? ".branch");
const workspace = resolve(process.env.BRANCH_WORKSPACE ?? "workspace");
const helpers = [
  { name: "Researcher", job: "Find every September invoice and list its total." },
  { name: "Checker", job: "Check each invoice total against the bank statement." },
  { name: "Writer", job: "Write a short note on what does not match." },
];

/* Only the specialists' own evaluation asks a model while seeding: it just has to answer. */
const evaluator = { name: "scripted", async complete() { return { content: "ready", toolCalls: [] }; } };

await mkdir(workspace, { recursive: true });
const app = await createBranch({ workspace, dataDir, provider: evaluator });
try {
  const context = app.runtime.context();
  const specialists = [];
  for (const helper of helpers) {
    const check = `${helper.name.toLowerCase()}-ready.txt`;
    const proposed = await app.registry.execute("specialists.propose", {
      name: helper.name, instructions: `You are the ${helper.name}, a helper.`, permissions: ["files.read"],
      evaluation: { prompt: "say ready", checks: [{ path: check, expected: "ready" }] },
    }, context);
    await writeFile(join(app.runtime.workspace, check), "ready");
    await app.registry.execute("specialists.evaluate", { id: proposed.id }, context);
    await app.registry.execute("specialists.promote", { id: proposed.id }, context);
    specialists.push({ id: proposed.id, name: helper.name, job: helper.job });
  }
  await writeFile(join(app.runtime.workspace, "notes.txt"), "September invoices: 16. Two are still missing a receipt.\n");
  await writeFile(join(dataDir, "helpers-seed.json"), JSON.stringify({ specialists }, null, 2));
  console.log(JSON.stringify({ specialists }));
} finally {
  await app.close();
}
