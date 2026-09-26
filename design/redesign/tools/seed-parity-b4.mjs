// Seeds a fresh engine data folder for verify-parity-b4.cjs with what only a model can make: a team of three specialists
// whose task ran to the end (so Team › Teams of specialists has the engine's own task view to draw), and one finished
// conversation (so Team › Shared has a conversation of the owner's to share), and one outside assistant read from an A2A
// card served here (so Customize › Tools › Agents has one to show and remove; the running engine refuses a card on this
// computer's own address, so it is added through the engine's own RemoteAgents.add with private addresses allowed for this
// seed only). The model is scripted, as the engine's own tests script it (tests/team-task-view.test.mjs). Run it while the
// engine is stopped:
//   BRANCH_DATA_DIR=<dir> BRANCH_WORKSPACE=<dir> node design/redesign/tools/seed-parity-b4.mjs
// then start the engine with the same two folders. Prints the team's and the conversation's ids as JSON.
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { createBranch } from "../../../dist/index.js";

const dataDir = resolve(process.env.BRANCH_DATA_DIR ?? ".branch");
const workspace = resolve(process.env.BRANCH_WORKSPACE ?? "workspace");
const roleOf = (request) => /Your role in team \\?"[^"\\]+\\?": ([a-z]+)\./.exec(JSON.stringify(request.messages))?.[1] ?? null;
const scripted = { name: "scripted", async complete(request) {
  const role = roleOf(request);
  return { content: role ? `answer from ${role}` : "parent done", toolCalls: [] };
} };
const knowledge = { activeSpecialist: () => ({ permissions: [], instructions: "" }) };

const app = await createBranch({ workspace, dataDir, provider: scripted, web: { allowPrivateAddresses: true } });
const cards = createServer((request, response) => {
  const base = `http://${request.headers.host}`;
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ name: "Seed helper", description: "Answers seeded questions", url: `${base}/a2a`, skills: [{ id: "lookup", name: "Look things up" }] }));
});
await new Promise((done) => cards.listen(0, "127.0.0.1", done));
try {
  const owner = app.runtime.owner;
  const members = ["planner", "builder", "reviewer"].map((role) => {
    const specialistId = randomUUID();
    // The shape the engine keeps (src/knowledge.ts), so Customize › Specialists names it.
    app.store.save("specialists", owner, specialistId, { version: 1, definition: { name: `Seed ${role}`, instructions: `Does the ${role} part.` },
      evaluationPassed: false, activeVersion: null, previousActive: null, history: [] });
    return { specialistId, role, brief: "" };
  });
  const team = app.teams.save({ name: "Seed crew", members });
  const task = await app.teams.run(app.runtime, knowledge, team.id, "ship the page", { requestId: randomUUID() });

  const run = app.store.createRun(owner, "Seed conversation to share");
  app.store.message(run.sessionId, { role: "user", content: run.prompt });
  app.store.message(run.sessionId, { role: "assistant", content: "Done." });
  app.store.finish(run.id, "completed", "Done.");
  // A task that stopped to ask the owner, so Team › Live now has a row whose steps Watch opens.
  const asking = app.store.createRun(owner, "Seed task that stopped to ask");
  app.store.message(asking.sessionId, { role: "user", content: asking.prompt });
  app.store.finish(asking.id, "needs_input", "Which folder should it use?");
  const agent = await app.remoteAgents.add({ cardUrl: `http://127.0.0.1:${cards.address().port}` });
  console.log(JSON.stringify({ team: team.id, task: task.taskId, state: task.state, sessionId: run.sessionId, asking: asking.id, agent: agent.id }));
} finally {
  cards.close();
  await app.close();
}
