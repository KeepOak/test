/**
 * The lead's workbench (SELF-311): memory files the lead writes and reads every session. In the owner's selected
 * Full Access the lead writes its MEMORY.md with the ordinary file tools, with no question; with the memory file
 * switched on, every new conversation is given it; and the lead changes it later the same way.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { saveContextFileSettings } from "../dist/context-files.js";
import { discardTemp } from "./temp-dir.mjs";

test("the lead writes its memory file without a question and every new conversation reads it", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-lead-memory-"));
  const systems = [];
  let step = 0;
  const provider = { name: "scripted", async complete(request) {
    systems.push(request.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n"));
    const said = [...request.messages].reverse().find((m) => m.role === "user" && !String(m.content).startsWith("<system-reminder>"))?.content ?? "";
    const last = request.messages.filter((m) => m.role !== "system" && !String(m.content).startsWith("<system-reminder>")).at(-1);
    if (last?.role === "tool" && /"path":"MEMORY.md","content"/.test(last.content) && /Update the rule/.test(said))
      return { content: "", toolCalls: [{ id: `e${++step}`, name: "files.edit",
        arguments: JSON.stringify({ path: "MEMORY.md", find: "exact-head green checks", replace: "exact-head green checks; never into redesign/window from a proof" }) }] };
    if (last?.role === "tool") return { content: "Saved.", toolCalls: [] };
    if (/Remember the merge rule/.test(said)) return { content: "", toolCalls: [{ id: `w${++step}`, name: "files.write",
      arguments: JSON.stringify({ path: "MEMORY.md", content: "# Lead memory\n- Merge only on exact-head green checks.\n" }) }] };
    if (/Update the rule/.test(said)) return { content: "", toolCalls: [{ id: `r${++step}`, name: "files.read", arguments: JSON.stringify({ path: "MEMORY.md" }) }] };
    return { content: "Hello.", toolCalls: [] };
  } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const run = async (body) => (await fetch(new URL("/api/run", server.url), { method: "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify(body) })).json();
  const wrote = await run({ prompt: "Remember the merge rule in your memory file", mode: "full" });
  assert.equal(wrote.status, "completed", wrote.output);
  assert.equal(app.store.events(wrote.id).filter((e) => /approval|needs_input/.test(e.kind)).length, 0, "no question in Full Access");
  saveContextFileSettings(app.store, app.runtime.owner, { files: { memory: "on" } });
  const fresh = await run({ prompt: "Hi", mode: "full" });
  assert.equal(fresh.status, "completed");
  assert.match(systems.at(-1), /Merge only on exact-head green checks/, "a new conversation is given the memory file");
  const edited = await run({ prompt: "Update the rule in MEMORY.md", sessionId: fresh.sessionId });
  assert.equal(edited.status, "completed", edited.output);
  assert.ok(app.store.events(edited.id).some((e) => e.kind === "tool.completed" && e.data.name === "files.edit"), "the lead changed its memory file");
  await run({ prompt: "Hi again", mode: "full" });
  assert.match(systems.at(-1), /never into redesign\/window from a proof/, "the next conversation reads the changed file");
});
