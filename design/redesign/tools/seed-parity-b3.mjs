// Seeds a fresh engine data folder as a set-up user for verify-parity-b3.cjs. Run it while the engine is stopped:
//   BRANCH_DATA_DIR=<dir> BRANCH_WORKSPACE=<dir> node design/redesign/tools/seed-parity-b3.mjs
// then start the engine with the same two folders. Everything is written the way the engine itself writes it:
// - a Trunk ("Ledger") with a finished task in its own conversation, and a finished task in Branch's own;
// - a fact to forget (and put back), four saved prompts (the list shows every one) with the prompt library on;
// - two install requests for a tool server (the part switched on), one to decline and one to allow;
// - a request from a chat to change Branch itself, waiting;
// - two jobs handed over: one done by hand (user.task) and one an outside tool is doing;
// - a repeating schedule the Trunk made, with three recorded turns (one failed), and a trigger in the Trunk's conversation;
// - "Procedures that start themselves" on, with one procedure and a change to it waiting for the owner's yes;
// - a spreadsheet and two versions of a text in Library › Documents, one open forecast and one lead;
// - a picture a task made (Library › Made for you).
// Prints the ids verify-parity-b3.cjs needs as JSON, and writes them to <data dir>/verify-parity-b3.json.
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createBranch } from "../../../dist/index.js";
import { saveAutonomyMode } from "../../../dist/autonomy/settings.js";
import { savePrompt, savePromptLibrarySettings } from "../../../dist/prompt-library.js";
import { saveRecordingSettings } from "../../../dist/run-recording.js";

const dataDir = resolve(process.env.BRANCH_DATA_DIR ?? ".branch");
const workspace = resolve(process.env.BRANCH_WORKSPACE ?? "workspace");
const quiet = { name: "scripted", async complete() { return { content: "", toolCalls: [] }; } };

const app = await createBranch({ workspace, dataDir, provider: quiet });
const owner = app.runtime.owner;
try {
  saveRecordingSettings(app.store, owner, { mode: "on" }); // "Watch again" reads the task's recording
  const ledger = app.trunks.create({ name: "Ledger" });
  const finish = (prompt, sessionId, output) => {
    const run = app.store.createRun(owner, prompt, sessionId);
    app.store.message(run.sessionId, { role: "user", content: prompt });
    app.store.message(run.sessionId, { role: "assistant", content: output });
    app.store.finish(run.id, "completed", output);
    return run;
  };
  const ledgerRun = finish("September expense report", ledger.chatSessionId, "Built the report from 16 charges.");
  // One action it took, with its settings kept, so "Make a workflow" has a step to repeat.
  app.store.message(ledgerRun.sessionId, { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "memory.search", arguments: JSON.stringify({ query: "invoice" }) }] });
  app.store.event(ledgerRun.id, "tool.completed", { name: "memory.search", id: "c1" });
  const mainRun = finish("Tidy the Downloads folder", undefined, "Archived the old files.");

  const fact = randomUUID();
  app.store.save("memory", owner, fact, { text: "Prefers invoices as PDF", source: "owner" });

  savePromptLibrarySettings(app.store, owner, { mode: "on" });
  for (const [title, command, body] of [["Monday plan", "monday", "Plan my week: what is due, what is waiting on me, and the three things that matter most this week and why."],
    ["Invoice check", "invoices", "Check my inbox for invoices"], ["Weekly report", "weekly", "Summarise what my Trunks did this week"], ["Receipts", "receipts", "File this month's receipts"]])
    savePrompt(app.store, owner, { title, command, body }, () => false);

  app.flowsBoards.setMode("install-requests", { mode: "on" });
  await app.flowsBoards.installs.request({ kind: "mcp", name: "notes", server: { transport: "http", url: "https://mcp.example.com/notes" }, why: "keep notes" }, "chat", "a chat app");
  await app.flowsBoards.installs.request({ kind: "mcp", name: "diary", server: { transport: "http", url: "https://mcp.example.com/diary" }, why: "keep a diary" }, "chat", "a chat app");

  const selfRequest = randomUUID();
  app.store.sqlite.prepare("INSERT INTO self_development_requests(id, owner, text, sender, status, created_at, answer) VALUES(?,?,?,?,?,?,NULL)")
    .run(selfRequest, owner, "Take the Export button out of the side panel",
      JSON.stringify({ channel: "telegram", chatId: "1", senderId: "1", senderName: "Verifier", messageId: randomUUID() }), "waiting", new Date().toISOString());

  app.runtime.deferrals.open({ id: "by-hand-1", runId: ledgerRun.id, sessionId: ledger.chatSessionId, tool: "user.task", description: "Sign the lease renewal" });
  app.runtime.deferrals.open({ id: "outside-1", runId: mainRun.id, sessionId: mainRun.sessionId, tool: "mcp.notes.upload", description: "Upload the scans" });

  const now = Date.now(), at = (minutesAgo, seconds) => ({ startedAt: new Date(now - minutesAgo * 60000).toISOString(), finishedAt: new Date(now - minutesAgo * 60000 + seconds * 1000).toISOString() });
  const schedule = randomUUID();
  app.store.save("schedules", owner, schedule, { prompt: "Check my inbox for invoices", kind: "task", dueAt: new Date(now + 3600000).toISOString(),
    intervalMs: 86400000, daysOff: "run", permissions: [], status: "pending", startedBy: ledger.id, runCount: 3,
    history: [{ runId: null, status: "completed", trigger: "schedule", ...at(3000, 40) }, { runId: null, status: "failed", trigger: "schedule", ...at(1500, 90) }, { runId: null, status: "completed", trigger: "schedule", ...at(60, 55) }] });
  const trigger = app.triggers.create(app.runtime.context({ signal: AbortSignal.timeout(30000), source: "owner" }), { name: "New PDF in Downloads", prompt: "Summarise the new PDF", sessionId: ledger.chatSessionId });

  saveAutonomyMode(app.store, owner, "procedures", { mode: "on" });
  const procedure = app.autonomy.procedures.create({ name: "Tidy the Downloads folder", start: { kind: "manual" },
    steps: [{ title: "List", prompt: "List what is in Downloads" }, { title: "Tell me", prompt: "Tell me what moved" }] });
  app.autonomy.procedures.proposeChange(procedure.id, { steps: [{ title: "List", prompt: "List what is in Downloads" }, { title: "Archive", prompt: "Move files older than six months" }] });

  // Library › Documents: a spreadsheet to ask, and two versions of a text to compare, each added from the workspace.
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, "expenses.csv"), "category,payee,amount\nTravel,Delta,612\nSupplies,Oakfield Supply,412\nMeals,Hartwell Grill,104.2\nTravel,Lyft,38\n");
  writeFileSync(join(workspace, "lease-2025.md"), "# Rent\n\n$1,420 a month.\n\n# Repairs\n\nYou pay for any repair under $150.\n");
  writeFileSync(join(workspace, "lease-2026.md"), "# Rent\n\n$1,480 a month.\n\n# Repairs\n\nYou pay for any repair under $100.\n");
  for (const path of ["expenses.csv", "lease-2025.md", "lease-2026.md"]) await app.documents.add(owner, { path });
  // A knowledge base over two notes, read and mapped the engine's own way (names mentioned together, no model).
  mkdirSync(join(workspace, "notes"), { recursive: true });
  writeFileSync(join(workspace, "notes", "hartwell.md"), "# Hartwell\n\nHartwell Grill sent the invoice. Oakfield Supply delivered the order to Hartwell Grill.\n");
  writeFileSync(join(workspace, "notes", "receipts.md"), "# Receipts\n\nOakfield Supply and Delta receipts are filed. Delta refunded the seat.\n");
  const base = app.knowledgeParts.bases.create(owner, { name: "Notes", sources: [{ kind: "folder", path: "notes" }] });
  await app.knowledgeParts.bases.reindex(owner, base.id);
  await app.knowledgeParts.graph.build(owner, base.id);
  // Automations › Running on its own, more: one open forecast and one lead.
  app.asks.forecasts.add({ question: "Will the September close finish on time?", probability: 0.7 });
  app.asks.leads.add([{ name: "Dana Reyes", company: "Oakfield Supply", title: "Operations" }], {});

  const picture = await app.runtime.artifacts.write(ledgerRun.id, "chart.png", "image/png",
    Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));

  const note = { trunk: ledger.id, ledgerSession: ledger.chatSessionId, ledgerRun: ledgerRun.id, mainRun: mainRun.id, fact, selfRequest,
    schedule, trigger: trigger.id, procedure: procedure.id, picture: picture.path };
  writeFileSync(join(dataDir, "verify-parity-b3.json"), JSON.stringify(note, null, 2));
  console.log(JSON.stringify(note));
} finally {
  await app.close();
}
