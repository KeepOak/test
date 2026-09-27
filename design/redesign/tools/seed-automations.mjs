// Seeds a fresh engine data folder for verify-automations.cjs. Run it while the engine is stopped:
//   BRANCH_DATA_DIR=<dir> BRANCH_WORKSPACE=<dir> node design/redesign/tools/seed-automations.mjs
// then start the engine with the same two folders. What it makes, each the way the engine itself writes it:
// - a conversation whose reply suggested a gateway change (gateway.propose), and that suggestion waiting, tried clean;
// - "Procedures that start themselves" switched on, with one such procedure, and one saved recipe beside it;
// - three archived facts;
// - Branch's own source checked out (a real Git repository), a self-development worktree with its contract, a request
//   from a chat that was approved (prepared, with one edit made in the worktree) and one still waiting.
// Prints the ids verify-automations.cjs needs as JSON, and writes them to <data dir>/verify-automations.json.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createBranch } from "../../../dist/index.js";
import { proposeConfig } from "../../../dist/never-break/gateway-config.js";
import { saveAutonomyMode } from "../../../dist/autonomy/settings.js";
import { ContractBook } from "../../../dist/self-development-contract.js";

const dataDir = resolve(process.env.BRANCH_DATA_DIR ?? ".branch");
const workspace = resolve(process.env.BRANCH_WORKSPACE ?? "workspace");
const quiet = { name: "scripted", async complete() { return { content: "", toolCalls: [] }; } };
const git = (cwd, ...args) => execFileSync("git", ["-c", "user.name=Verify", "-c", "user.email=verify@example.invalid", ...args], { cwd, encoding: "utf8" }).trim();

const app = await createBranch({ workspace, dataDir, provider: quiet });
const owner = app.runtime.owner;
try {
  // The gateway suggestion, made by a reply in a conversation.
  const why = "Wait longer before deciding a busy engine is stuck";
  const run = app.store.createRun(owner, "You restart the engine too quickly when it is busy.");
  app.store.message(run.sessionId, { role: "user", content: run.prompt });
  app.store.message(run.sessionId, { role: "assistant", content: "I suggested a longer wait.", toolCalls: [
    { id: "g1", name: "gateway.propose", arguments: JSON.stringify({ change: { startSeconds: 30 }, why }) }] });
  app.store.finish(run.id, "completed", "I suggested a longer wait.");
  await proposeConfig(dataDir, { startSeconds: 30 }, why, async () => ({ ok: true, detail: "A throwaway gateway started its engine with these settings." }));

  // A procedure that starts itself, and a saved recipe beside it.
  saveAutonomyMode(app.store, owner, "procedures", { mode: "on" });
  const procedure = app.autonomy.procedures.create({ name: "Tidy the Downloads folder", start: { kind: "manual" },
    steps: [{ title: "List", prompt: "List what is in Downloads" }, { title: "Tell me", prompt: "Tell me what moved" }] });
  const recipe = randomUUID();
  app.store.save("procedures", owner, recipe, { version: 1, status: "proposed", history: [],
    definition: { name: "Find last month's invoices", preconditions: [], parameters: {}, steps: [{ tool: "memory.search", args: { query: "invoice" }, expected: {} }] } });

  // Three archived facts.
  for (const [id, text] of [["arch-1", "An old address"], ["arch-2", "A previous billing contact"], ["arch-3", "Prefers window seats"]])
    app.store.save("memory", owner, id, { text, source: "owner" });
  app.store.memoryHygiene(owner, { olderThanDays: 1, action: "archive" }, Date.now() + 3 * 86_400_000);

  // Branch's own source, a worktree held to a contract, and two requests from a chat.
  const source = join(workspace, "branch-agent-source"), worktree = "branch-agent-source/.branch-worktrees/self-skip-open";
  mkdirSync(join(source, "src", "automations"), { recursive: true });
  writeFileSync(join(source, "src", "automations", "sweep.ts"), "for (const f of listFiles(dir)) {\n  if (age(f) > limit) move(f, archive);\n}\n");
  git(source, "init", "-q", "-b", "main");
  git(source, "add", ".");
  git(source, "commit", "-q", "-m", "start");
  const sha = git(source, "rev-parse", "HEAD");
  git(source, "worktree", "add", "-q", "-b", "branch/self-skip-open", ".branch-worktrees/self-skip-open", sha);
  writeFileSync(join(workspace, worktree, "src", "automations", "sweep.ts"), "for (const f of listFiles(dir)) {\n  if (age(f) <= limit) continue;\n  if (await isOpen(f)) { skipped.push(f); continue; }\n  move(f, archive);\n}\n");
  new ContractBook(app.store.sqlite).create(owner, { taskRunId: "", sourceSha: sha, worktreePath: worktree, terms: {
    allowedPaths: ["src/automations/**"], permissions: ["files.write"], expectedTests: ["tests/sweep.test.mjs"],
    definitionOfDone: "Open files are skipped", sideEffects: [], rollbackPlan: "Remove the worktree and its branch" } });
  const request = (text, status, answer) => {
    const id = randomUUID();
    app.store.sqlite.prepare("INSERT INTO self_development_requests(id, owner, text, sender, status, created_at, answer) VALUES(?,?,?,?,?,?,?)")
      .run(id, owner, text, JSON.stringify({ channel: "telegram", chatId: "1", senderId: "1", senderName: "Verifier", messageId: randomUUID() }),
        status, new Date().toISOString(), answer ? JSON.stringify(answer) : null);
    return id;
  };
  const approved = request("Skip files that are open when tidying Downloads", "approved", { at: new Date().toISOString(), worktree, revision: 1, sourceSha: sha });
  const waiting = request("Take the Export button out of the side panel", "waiting", null);

  const note = { sessionId: run.sessionId, procedure: procedure.id, recipe, approved, waiting };
  writeFileSync(join(dataDir, "verify-automations.json"), JSON.stringify(note, null, 2));
  console.log(JSON.stringify(note));
} finally {
  await app.close();
}
