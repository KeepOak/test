/**
 * Helper lifecycle (src/helper-tree.ts): a background helper is on its lead's record, listable and stoppable, before a
 * slow start (its own copy of the project) finishes; a conversation has no more background helpers at once than its
 * sub-tasks at once; a helper is not given sending, asking or scheduling tools unless its lead names them, and starts
 * no helpers of its own unless allowed; and stopping a task stops its whole helper tree, as starting afresh does.
 * A scripted model; no provider, no real git.
 *
 * Mutation notes (each turns this file red):
 * - src/runtime.ts started: drop `options.onCreated?.(run)` and helpers.start waits out the slow copy (or fails).
 * - src/runtime.ts delegateBackground: drop the `reserve` refusal and the third helper starts.
 * - src/helper-messages.ts helpers.start: use `[...context.permissions]` again and the helper has user.ask.
 * - src/runtime.ts cancel: drop the descendants loop and the helpers outlive their stopped lead.
 * - src/runtime.ts visibleTools: list registry.descriptions(context.permissions) again and a helper is shown fleet.send.
 * - src/helper-messages.ts resumeHelper: drop `delegates` and the helper carried on loses its leave.
 * - src/runtime.ts started: drop `this.carriedHelper(options)` and a helper resumed after a restart starts helpers.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { createBranch } from "../dist/index.js";
import { saveKnobs } from "../dist/knobs/settings.js";
import { HANDLERS } from "../dist/commands/handlers.js";
import { handOnRefusal } from "../dist/helper-tree.js";
import { discardTemp } from "./temp-dir.mjs";

const say = (content) => ({ content, toolCalls: [] });
const call = (name, args, id = `c${Math.random().toString(36).slice(2, 9)}`) => ({ content: "", toolCalls: [{ id, name, arguments: JSON.stringify(args) }] });
const until = async (check, ms = 15000) => { for (const end = Date.now() + ms; Date.now() < end; await wait(25)) if (check()) return true; return check(); };
/** Waits until the task is stopped; a stopped task's model call ends with the stop. */
const held = (signal) => new Promise((_, reject) => {
  if (signal?.aborted) return reject(signal.reason);
  signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
});
const firstUser = (request) => String(request.messages.find((m) => m.role === "user" && !String(m.content).startsWith("<system-reminder>"))?.content ?? "");
const toolTexts = (request) => request.messages.filter((m) => m.role === "tool").map((m) => String(m.content));

/** Lead and helper scripts, keyed by words in the owner's message or the helper's brief. */
function scripted(seen) {
  return { name: "scripted", async complete(request) {
    const system = request.messages.filter((m) => m.role === "system").map((m) => String(m.content)).join("\n");
    const asked = firstUser(request), tools = toolTexts(request);
    if (/RESUMABLE/.test(asked)) {
      // Its first run finishes; carried on after a restart, it tries to start a helper of its own.
      if (!tools.length && !seen.resumed) { seen.resumed = true; return say("first run done"); }
      if (!tools.length) return call("helpers.start", { brief: "HOLD never", minutes: 5 });
      seen.resumedNest = tools.at(-1);
      return say("could not nest after the restart");
    }
    if (/You are a helper working in the background/.test(system)) {
      (seen.helperTools ??= []).push(...(request.tools ?? []).map((tool) => tool.name));
      if (/NESTED/.test(asked) && !tools.length) return call("helpers.start", { brief: "HOLD grandchild", minutes: 5 });
      if (/TRY-NEST/.test(asked)) {
        if (!tools.length) return call("helpers.start", { brief: "HOLD never", minutes: 5 });
        seen.nestAnswer = tools.at(-1);
        return say("could not nest");
      }
      if (/HOLD|NESTED/.test(asked)) await held(request.signal);
      return say("helper done");
    }
    if (tools.length) {
      seen.leadTools = tools;
      if (/TREE/.test(asked)) await held(request.signal);
      return say("carrying on");
    }
    if (/SLOW/.test(asked)) return call("helpers.start", { brief: "HOLD slow", ownCopy: true, minutes: 5 });
    if (/CAP/.test(asked)) return { content: "", toolCalls: [1, 2, 3].map((n) => ({ id: `cap${n}`, name: "helpers.start", arguments: JSON.stringify({ brief: `HOLD cap ${n}`, minutes: 5 }) })) };
    if (/PERMS/.test(asked)) return call("helpers.start", { brief: "TRY-NEST", minutes: 5 });
    if (/NAMED/.test(asked)) return call("helpers.start", { brief: "plain", minutes: 5, permissions: ["files.read", "user.ask", "specialists.use"] });
    if (/TREE/.test(asked)) return call("helpers.start", { brief: "NESTED", minutes: 5, delegates: true });
    if (/AFRESH/.test(asked)) return call("helpers.start", { brief: "HOLD afresh", minutes: 5 });
    if (/LEAVE/.test(asked)) return call("helpers.start", { brief: "quick", minutes: 5, delegates: true });
    if (/RESTART/.test(asked)) return call("helpers.start", { brief: "RESUMABLE", minutes: 5 });
    return say("nothing to do");
  } };
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-helper-life-"));
  const seen = {};
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: scripted(seen) });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const all = [...app.runtime.context().permissions];
  const lead = (prompt) => app.runtime.run({ prompt, permissions: all, mode: "full" });
  const helpersOf = (runId) => app.store.events(runId).filter((e) => e.kind === "delegation.background_started").map((e) => e.data.childRunId);
  const started = (runId) => app.store.events(runId).find((e) => e.kind === "run.started")?.data;
  return { app, seen, all, lead, helpersOf, started };
}

test("a helper whose own copy is slow to make is on its lead's record at once, listable and stoppable", async (t) => {
  const { app, lead, helpersOf } = await fixture(t);
  saveKnobs(app.store, app.runtime.owner, "subtasks", { parallelSubtasks: 1 });
  // Stubbed git: `rev-parse` answers at once, `worktree add` takes 3 seconds (or until the helper is stopped).
  const places = app.runtime.coding.worktrees.deps, copy = { calls: 0, stopped: false, listed: -1 };
  let begun;
  const copying = new Promise((resolve) => { begun = resolve; });
  places.run = async () => ({ status: "completed", exitCode: 0, stdout: "0123abcd\n", stderr: "" });
  places.git = { worktree: async (_input, signal) => {
    copy.calls++;
    const lead = app.store.sqlite.prepare("SELECT id FROM tasks WHERE prompt LIKE 'SLOW:%'").get();
    copy.listed = lead ? helpersOf(String(lead.id)).length : 0;
    signal.addEventListener("abort", () => { copy.stopped = true; }, { once: true });
    begun();
    await wait(3000, undefined, { signal });
    throw new Error("stub: no copy made");
  } };
  const running = lead("SLOW: work in your own copy");
  await copying;
  assert.equal(copy.listed, 1, "the helper was on its lead's record before its copy was started");
  const leadId = String(app.store.sqlite.prepare("SELECT id FROM tasks WHERE prompt LIKE 'SLOW:%'").get().id);
  const [helper] = helpersOf(leadId);
  // While `git worktree add` is still working: listed, and stopped.
  const context = app.runtime.context({ runId: leadId });
  const listed = (await app.registry.execute("helpers.list", {}, context)).helpers;
  assert.deepEqual(listed.map((one) => [one.helper, one.status]), [[helper, "running"]]);
  assert.deepEqual(await app.registry.execute("helpers.stop", { helper }, context), { stopped: true });
  assert.ok(await until(() => app.store.run(helper).status === "cancelled"), app.store.run(helper).status);
  assert.equal(copy.stopped, true, "stopping the helper stopped the slow git call");
  assert.equal(copy.calls, 1);
  const run = await running;
  assert.equal(run.status, "completed", run.output);
  // Its place is given back: with one helper at once, another may start now.
  const again = await app.registry.execute("helpers.start", { brief: "HOLD again", minutes: 5 }, context);
  assert.ok(again.helper);
  app.runtime.cancel(again.helper);
});

test("a conversation has no more background helpers at once than its sub-tasks at once, even asked for in one step", async (t) => {
  const { app, seen, lead, helpersOf } = await fixture(t);
  saveKnobs(app.store, app.runtime.owner, "subtasks", { parallelSubtasks: 2 });
  const run = await lead("CAP: three helpers at once");
  assert.equal(run.status, "completed", run.output);
  const helpers = helpersOf(run.id);
  assert.equal(helpers.length, 2, "two started");
  assert.equal(seen.leadTools.filter((text) => /Helper limit reached: 2 helpers already work at once/.test(text)).length, 1, JSON.stringify(seen.leadTools));
  assert.ok(helpers.every((id) => app.store.run(id).status === "running"));
  // A lead that already finished still stops the helpers it started.
  app.runtime.cancel(run.id);
  assert.ok(await until(() => helpers.every((id) => app.store.run(id).status === "cancelled")));
});

test("a helper is not given sending, asking or scheduling tools, nor starts helpers, unless its lead says so", async (t) => {
  const { app, seen, lead, helpersOf, started } = await fixture(t);
  const run = await lead("PERMS: one helper with the default tools");
  const [helper] = helpersOf(run.id);
  assert.ok(await until(() => app.store.run(helper).status === "completed"), app.store.run(helper)?.status);
  const reach = started(helper).permissions;
  for (const withheld of ["channels.send", "trunks.message", "brief.manage", "user.ask", "schedules.manage"])
    assert.ok(!reach.includes(withheld), `${withheld} is withheld: ${reach}`);
  assert.ok(reach.includes("specialists.use") && reach.includes("files.read"), "it keeps the rest, helpers.tell_lead with it");
  assert.match(seen.nestAnswer, /does not start helpers or message other Branches and Trunks unless its lead allowed it/);
  assert.equal(helpersOf(helper).length, 0, "no grandchild");
  // Named by its lead, a withheld tool is given.
  const named = await lead("NAMED: a helper that may ask the owner");
  const [asker] = helpersOf(named.id);
  assert.ok(started(asker).permissions.includes("user.ask"));
  assert.ok(await until(() => app.store.run(asker).status === "completed"));
});

test("stopping a lead stops its helper tree, and starting afresh stops a conversation's helpers", async (t) => {
  const { app, lead, helpersOf } = await fixture(t);
  void lead("TREE: a helper that starts its own");
  let leadId, child, grandchild;
  assert.ok(await until(() => {
    leadId = app.store.sqlite.prepare("SELECT id FROM tasks WHERE prompt LIKE 'TREE:%'").get()?.id;
    [child] = leadId ? helpersOf(String(leadId)) : [];
    [grandchild] = child ? helpersOf(child) : [];
    return !!grandchild && app.store.run(String(leadId))?.status === "running";
  }), "the lead, its helper and the helper's own helper all work");
  leadId = String(leadId);
  assert.equal(app.runtime.cancel(leadId), true);
  assert.ok(await until(() => [leadId, child, grandchild].every((id) => app.store.run(id).status === "cancelled")),
    JSON.stringify([leadId, child, grandchild].map((id) => app.store.run(id).status)));

  const afresh = await lead("AFRESH: a helper left working");
  const [left] = helpersOf(afresh.id);
  assert.equal(app.store.run(left).status, "running");
  const reply = await HANDLERS.new({ host: { runtime: app.runtime, requireOwner: () => undefined }, surface: "window", argument: "",
    sessionId: afresh.sessionId, access: "full", mode: "full" });
  assert.equal(reply.client.do, "new");
  assert.ok(await until(() => app.store.run(left).status === "cancelled"), app.store.run(left).status);
});

test("a helper is not shown the hand-on tools it may not use", async (t) => {
  const { app, seen, lead, helpersOf } = await fixture(t);
  const run = await lead("PERMS: one helper with the default tools");
  const [helper] = helpersOf(run.id);
  assert.ok(await until(() => app.store.run(helper).status === "completed"));
  const handOn = ["helpers.start", "fleet.send", "trunks.remote.message"];
  assert.ok(seen.helperTools.length, "the helper was shown tools");
  assert.deepEqual(handOn.filter((name) => seen.helperTools.includes(name)), [], "never offered to it");
  // What the lead is shown of them (fleet.send and trunks.remote.message only where those parts are set up), a helper
  // is shown none of, unless its lead let it hand work on.
  const reach = app.runtime.context({ runId: run.id });
  const names = (context) => app.runtime.visibleTools(context).map((tool) => tool.name);
  const leads = handOn.filter((name) => names(reach).includes(name));
  assert.ok(leads.includes("helpers.start"), `a lead sees helpers.start: ${leads}`);
  assert.deepEqual(handOn.filter((name) => names({ ...reach, depth: 1 }).includes(name)), [], "a helper sees none");
  assert.deepEqual(handOn.filter((name) => names({ ...reach, depth: 1, delegates: true }).includes(name)), leads, "one allowed sees what its lead does");
  assert.deepEqual(handOn.map((name) => handOnRefusal(name, { depth: 1 }) !== null), [true, true, true], "and none of the three runs for it");
});

test("a helper allowed to hand work on keeps that leave when its lead carries it on", async (t) => {
  const { app, lead, helpersOf, started } = await fixture(t);
  const run = await lead("LEAVE: a helper that may start its own");
  const [helper] = helpersOf(run.id);
  assert.ok(await until(() => app.store.run(helper).status === "completed"));
  assert.equal(started(helper).delegates, true, "its start says so");
  const resumed = await app.registry.execute("helpers.message", { helper, text: "one more thing" }, app.runtime.context({ runId: run.id }));
  assert.equal(resumed.resumed, true);
  assert.equal(started(resumed.helper).delegates, true, "carried on with the same leave");
  assert.equal(started(resumed.helper).depth, 1);
  assert.ok(await until(() => app.store.run(resumed.helper).status === "completed"));
});

test("a helper carried on after a restart keeps its depth, so it still starts no helpers of its own", async (t) => {
  const { app, seen, lead, helpersOf, started } = await fixture(t);
  const run = await lead("RESTART: a helper that is cut off");
  const [helper] = helpersOf(run.id);
  assert.ok(await until(() => app.store.run(helper).status === "completed"));
  assert.equal(started(helper).depth, 1);
  app.store.sqlite.prepare("UPDATE tasks SET status='interrupted' WHERE id=?").run(helper);
  const again = await app.runtime.resume(helper);
  assert.equal(again.status, "completed", again.output);
  assert.equal(started(again.id).depth, 1, "the carried-on task works at its helper depth");
  assert.match(seen.resumedNest, /does not start helpers or message other Branches and Trunks unless its lead allowed it/);
  assert.equal(helpersOf(again.id).length, 0, "no grandchild");
});
