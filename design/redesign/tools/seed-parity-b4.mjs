// Seeds a fresh engine data folder for verify-parity-b4.cjs with what only a model can make: a team of three specialists
// whose task ran to the end (so Team › Teams of specialists has the engine's own task view to draw), and one finished
// conversation (so Team › Shared has a conversation of the owner's to share). The model is scripted, as the engine's own
// tests script it (tests/team-task-view.test.mjs). Run it while the engine is stopped:
//   BRANCH_DATA_DIR=<dir> BRANCH_WORKSPACE=<dir> node design/redesign/tools/seed-parity-b4.mjs
// then start the engine with the same two folders. Prints the team's and the conversation's ids as JSON.
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createBranch } from "../../../dist/index.js";

const dataDir = resolve(process.env.BRANCH_DATA_DIR ?? ".branch");
const workspace = resolve(process.env.BRANCH_WORKSPACE ?? "workspace");
const roleOf = (request) => /Your role in team \\?"[^"\\]+\\?": ([a-z]+)\./.exec(JSON.stringify(request.messages))?.[1] ?? null;
const scripted = { name: "scripted", async complete(request) {
  const role = roleOf(request);
  return { content: role ? `answer from ${role}` : "parent done", toolCalls: [] };
} };
const knowledge = { activeSpecialist: () => ({ permissions: [], instructions: "" }) };

const app = await createBranch({ workspace, dataDir, provider: scripted });
try {
  const owner = app.runtime.owner;
  const members = ["planner", "builder", "reviewer"].map((role) => {
    const specialistId = randomUUID();
    app.store.save("specialists", owner, specialistId, { id: specialistId, name: `Seed ${role}` });
    return { specialistId, role, brief: "" };
  });
  const team = app.teams.save({ name: "Seed crew", members });
  const task = await app.teams.run(app.runtime, knowledge, team.id, "ship the page", { requestId: randomUUID() });

  const run = app.store.createRun(owner, "Seed conversation to share");
  app.store.message(run.sessionId, { role: "user", content: run.prompt });
  app.store.message(run.sessionId, { role: "assistant", content: "Done." });
  app.store.finish(run.id, "completed", "Done.");
  console.log(JSON.stringify({ team: team.id, task: task.taskId, state: task.state, sessionId: run.sessionId }));
} finally {
  await app.close();
}
