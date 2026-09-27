// Seeds a fresh engine data folder for verify-pass18.cjs filled: what only a model or a team turn can make.
// - "Seed crew": three specialists whose task ran to the end (a scripted model, as seed-parity-b4.mjs), so the team run
//   board has the engine's own task view with members and batches.
// - "Seed desk": two specialists and a task claimed by the window with a handoff offered to one member (Q62,
//   src/team-handoff.ts), so the board draws the open handoff with Accept and Reject held.
// Run it while the engine is stopped:
//   BRANCH_DATA_DIR=<dir> BRANCH_WORKSPACE=<dir> node design/redesign/tools/seed-pass18.mjs
// then start the engine with the same two folders. Trunks and a room are made through the API by the verify script.
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createBranch } from "../../../dist/index.js";
import { TeamTasks } from "../../../dist/team-tasks.js";
import { TeamHandoffs } from "../../../dist/team-handoff.js";

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
  const specialists = (roles) => roles.map((role) => {
    const specialistId = randomUUID();
    app.store.save("specialists", owner, specialistId, { version: 1, definition: { name: `Seed ${role}`, instructions: `Does the ${role} part.` },
      evaluationPassed: false, activeVersion: null, previousActive: null, history: [] });
    return { specialistId, role, brief: "" };
  });
  const crew = app.teams.save({ name: "Seed crew", purpose: "Plans, builds and reviews one page.", members: specialists(["planner", "builder", "reviewer"]) });
  const ran = await app.teams.run(app.runtime, knowledge, crew.id, "ship the page", { requestId: randomUUID() });

  const deskMembers = specialists(["writer", "checker"]);
  const desk = app.teams.save({ name: "Seed desk", purpose: "Writes and checks one letter.", members: deskMembers });
  const scope = { owner, source: "window" };
  const tasks = new TeamTasks(app.store);
  const task = tasks.observe(scope, desk.id, randomUUID(), "seed-desk");
  const claim = tasks.claim(scope, task.taskId);
  new TeamHandoffs(app.store).offer(claim, `member:${deskMembers[1].specialistId}`, "the letter is written and needs checking");
  console.log(JSON.stringify({ crew: crew.id, crewTask: ran.taskId, desk: desk.id, deskTask: task.taskId }));
} finally {
  await app.close();
}
