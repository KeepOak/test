/**
 * The lead's workbench (SELF-307): a long conversation that is folded keeps what the lead needs to carry on: the plan,
 * the files it touched, its open to-dos, and the numbers of the helpers still working and the wake-ups still set.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBranch, saveKnobs } from "../dist/index.js";
import { discardTemp } from "./temp-dir.mjs";

const call = (name, args, id) => ({ content: "", toolCalls: [{ id, name, arguments: JSON.stringify(args) }] });
const filler = (n) => `Turn ${n}: ` + "long review notes about the merge queue ".repeat(60);

test("a folded conversation still has its plan, files, to-dos, working helpers and wake-ups in front of the model", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-open-work-"));
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const requests = [];
  const steps = [
    call("files.write", { path: "notes/queue.md", content: "merge queue" }, "w"),
    call("checklist.write", { steps: [{ text: "Merge #687", done: false }, { text: "Sync the master plan", done: false }] }, "c"),
    call("schedules.wake_later", { message: "Check CI on #687.", inMinutes: 30 }, "k"),
    call("helpers.start", { brief: "Read the CI logs of #697.", minutes: 5 }, "h"),
    { content: "All set.", toolCalls: [] },
  ];
  const provider = { name: "scripted", async complete(request) {
    const system = request.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
    if (/Summarize the conversation below/.test(request.messages[0].content)) return { content: "Handoff: working the merge queue.", toolCalls: [] };
    if (/You are a helper working in the background/.test(system)) { await gate; return { content: "Logs read.", toolCalls: [] }; }
    requests.push(request.messages.map((m) => `${m.role}: ${m.content}`).join("\n"));
    return steps.shift() ?? { content: "Carrying on from the summary.", toolCalls: [] };
  } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  t.after(async () => { release(); await app.close(); await discardTemp(root); });
  saveKnobs(app.store, app.runtime.owner, "compaction", { contextWindowTokens: 20000 });
  const first = await app.runtime.run({ prompt: "Work the merge queue; keep a checklist", mode: "full" });
  assert.equal(first.status, "completed", first.output);
  const helper = app.store.events(first.id).find((event) => event.kind === "delegation.background_started").data.childRunId;
  const [wake] = (await app.registry.execute("schedules.wakeups", {}, app.runtime.context({ runId: first.id }))).wakeups;
  for (let n = 1; n <= 40; n++) app.store.message(first.sessionId, { role: n % 2 ? "user" : "assistant", content: filler(n) });
  const run = await app.runtime.run({ prompt: "what is still open?", sessionId: first.sessionId });
  assert.equal(run.status, "completed", run.output);
  assert.ok(app.store.events(run.id).some((event) => event.kind === "context.compacted"), "the conversation was folded");
  const sent = requests.at(-1);
  assert.match(sent, /compacted summary/);
  assert.match(sent, /Sync the master plan/, "the plan");
  assert.match(sent, /notes\/queue\.md/, "the files it touched");
  assert.match(sent, /Work still open in this conversation/);
  assert.ok(sent.includes(`Helper ${helper} is working on: Read the CI logs of #697.`), "the working helper's number");
  assert.ok(sent.includes(`Wake-up ${wake.id} at ${wake.nextAt}: Check CI on #687.`), "the wake-up's number");
  release();
});
