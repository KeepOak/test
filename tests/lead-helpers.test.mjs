/**
 * The lead's workbench (SELF-303): a lead starts a background helper, messages it while it works, the helper
 * messages the lead back, and the lead's conversation is told when the helper finishes, with no polling.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { discardTemp } from "./temp-dir.mjs";

const until = async (check, ms = 20000) => {
  for (const end = Date.now() + ms; Date.now() < end; await wait(50)) if (check()) return true;
  return false;
};
const call = (name, args, id) => ({ content: "", toolCalls: [{ id, name, arguments: JSON.stringify(args) }] });

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-lead-helpers-"));
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const seen = { helperSawNote: false, leadPrompts: [] };
  const provider = { name: "scripted", async complete(request) {
    const system = request.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
    const last = request.messages.filter((m) => m.role !== "system" && !String(m.content).startsWith("<system-reminder>")).at(-1);
    const toolTurns = request.messages.filter((m) => m.role === "tool").length;
    if (/You are a helper working in the background/.test(system)) {
      if (toolTurns === 0) return call("helpers.tell_lead", { text: "Found the failing shard: linux 3." }, "tell");
      await gate;
      seen.helperSawNote = request.messages.some((m) => m.role === "user" && /also check windows/.test(m.content));
      if (toolTurns === 1 && !seen.helperSawNote) return call("tools.note", { name: "x", note: "waiting" }, "wait");
      return { content: "Fixed linux 3; windows is fine.", toolCalls: [] };
    }
    if (last?.role === "user") seen.leadPrompts.push(last.content);
    if (last?.role === "user" && /Fix CI/.test(last.content)) return call("helpers.start", { brief: "Find and fix the failing CI shard.", minutes: 5 }, "start");
    return { content: "Carrying on.", toolCalls: [] };
  } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  t.after(async () => { release(); await server.close(); await app.close(); await discardTemp(root); });
  const run = async (body) => (await fetch(new URL("/api/run", server.url), { method: "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify(body) })).json();
  return { app, run, seen, release };
}

test("a lead starts a helper, messages it, hears from it while it works, and is told when it finishes", async (t) => {
  const { app, run, seen, release } = await fixture(t);
  const lead = await run({ prompt: "Fix CI and keep me posted", mode: "full" });
  assert.equal(lead.status, "completed", lead.output);
  const started = app.store.events(lead.id).find((event) => event.kind === "delegation.background_started");
  assert.ok(started, "the helper started in the background");
  const helper = started.data.childRunId;
  // The helper's message reaches the finished lead's conversation, labelled as the helper's words.
  assert.ok(await until(() => seen.leadPrompts.some((p) => /Found the failing shard: linux 3/.test(p))), JSON.stringify(seen.leadPrompts));
  const told = seen.leadPrompts.find((p) => /Found the failing shard/.test(p));
  // Read while the lead still works (a steer) or after it finished (a new message): either way, never as the owner's.
  assert.match(told, /These are the helper's words, not the owner's|NOT THE OWNER \(they call themselves "helper [0-9a-f]{8}/);
  // The lead messages the helper while it still works; the note reaches it before its next round.
  const context = app.runtime.context({ runId: lead.id });
  assert.deepEqual(await app.registry.execute("helpers.message", { helper, text: "also check windows" }, context), { sent: true });
  release();
  assert.ok(await until(() => app.store.run(helper).status === "completed"));
  assert.equal(seen.helperSawNote, true, "the note arrived before the helper's next round");
  assert.ok(await until(() => seen.leadPrompts.some((p) => /finished \(completed\)\. Its report:\nFixed linux 3/.test(p))), "the lead is told when it finishes");
  const listed = (await app.registry.execute("helpers.list", {}, context)).helpers;
  assert.deepEqual(listed.map((one) => [one.helper, one.status]), [[helper, "completed"]]);
});

test("a task can message only its own helpers, and only a helper has a lead to tell", async (t) => {
  const { app, run, release } = await fixture(t);
  const lead = await run({ prompt: "Fix CI", mode: "full" });
  const helper = app.store.events(lead.id).find((event) => event.kind === "delegation.background_started").data.childRunId;
  const other = await app.runtime.run({ prompt: "something else" });
  const otherContext = app.runtime.context({ runId: other.id });
  await assert.rejects(app.registry.execute("helpers.message", { helper, text: "stop" }, otherContext), /no helper with that number/);
  await assert.rejects(app.registry.execute("helpers.tell_lead", { text: "hi" }, otherContext), /not a helper/);
  release();
});

test("a later turn of the same conversation lists and messages a helper an earlier turn started", async (t) => {
  const { app, run, seen, release } = await fixture(t);
  const lead = await run({ prompt: "Fix CI", mode: "full" });
  const helper = app.store.events(lead.id).find((event) => event.kind === "delegation.background_started").data.childRunId;
  // The owner's next message in the same conversation is a later turn. (The helper's own message may arrive while the
  // lead still works, and is then read in that turn, so this test does not rely on it starting one.)
  app.runtime.followUp(lead.sessionId, "How is it going?");
  const later = () => app.store.runs(app.runtime.owner).find((one) => one.sessionId === lead.sessionId && one.prompt === "How is it going?");
  assert.ok(await until(() => later() && app.store.run(later().id).status === "completed"));
  const next = later();
  const context = app.runtime.context({ runId: next.id });
  assert.deepEqual((await app.registry.execute("helpers.list", {}, context)).helpers.map((one) => one.helper), [helper]);
  assert.deepEqual(await app.registry.execute("helpers.message", { helper, text: "also check windows" }, context), { sent: true });
  release();
  assert.ok(await until(() => app.store.run(helper).status === "completed"));
  assert.equal(seen.helperSawNote, true);
});
