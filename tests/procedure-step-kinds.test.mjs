/**
 * The flow editor's step kinds, run for real by the procedure runner (src/autonomy/procedures.ts, src/autonomy/step-kinds.ts):
 * When, If it says, Wait, Repeat, Split and gather and Run a flow. Repeat, Split and gather and Run a flow need the owner's
 * own yes to exactly what they could do unattended, with a hard cap, asked apart from the yes to the procedure itself.
 * The Trunk is a stand-in that answers by what it is asked; the clock is a variable. No sleeps.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer, offLimitsToShortLivedKeys } from "../dist/server.js";
import { SelfStarting } from "../dist/autonomy/procedures.js";
import { Ledger } from "../dist/autonomy/ledger.js";
import { maxUnattendedTurns, parseWait, parseWhen, fanItems } from "../dist/autonomy/step-kinds.js";

/** A real store, a real ledger, a stand-in Trunk and a clock the test moves. */
async function world(t, answer = () => "Done.", held = ["files.read"]) {
  const root = await mkdtemp(join(tmpdir(), "branch-step-kinds-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"),
    provider: { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } } });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const clock = { now: new Date("2026-09-27T09:00:00Z") };
  const asked = [];
  const runner = { async turn(request) {
    asked.push(request);
    return { ran: true, run: { id: `run-${asked.length}`, status: "completed", output: answer(request.prompt, asked.length), sessionId: "00000000-0000-4000-8000-000000000001" } };
  } };
  const ledger = new Ledger(app.store, "local", () => clock.now);
  const procedures = new SelfStarting({ store: app.store, owner: "local", runner, ledger, held: () => held, now: () => clock.now, timezone: () => "UTC" });
  const unattended = () => ledger.list("pending").filter((e) => e.kind === "unattended");
  /** The owner's yes in Inbox, as /api/autonomy/decide gives it: made first, then settled. */
  const yes = (entry) => { procedures.allowUnattended(entry.payload); ledger.settle(entry.id, true); };
  const prompts = () => asked.map((r) => r.prompt.split("\n").at(-1));
  return { app, root, clock, asked, prompts, ledger, procedures, unattended, yes };
}
const auto = (name, steps, extra = {}) => ({ name, level: "auto", start: { kind: "manual" }, steps, ...extra });

test("returning to an approved shape requires a fresh yes for the new version", async (t) => {
  const { ledger, procedures, unattended, yes } = await world(t);
  const steps = [{ kind: "loop", title: "Repeat", prompt: "Say hi.", times: 2 }];
  const made = procedures.create(auto("Versioned", steps));
  const first = unattended()[0];
  yes(first);
  for (const next of [[{ ...steps[0], times: 3 }], steps]) {
    const q = procedures.proposeChange(made.id, { steps: next });
    procedures.applyChange(ledger.get(q.id).payload);
    ledger.settle(q.id, true);
  }
  const newest = unattended()[0];
  assert.notEqual(newest.fingerprint, first.fingerprint);
  assert.equal(procedures.trigger(made.id, "test").started, false);
  assert.throws(() => procedures.allowUnattended(first.payload), /changed after/);
  yes(newest);
  assert.equal(procedures.get(made.id).version, 3);
});

test("a full ledger cannot leave a created or changed procedure behind after reporting failure", async (t) => {
  const { ledger, procedures, unattended } = await world(t);
  const plain = procedures.create(auto("Existing", [{ title: "Say", prompt: "Hi." }]));
  const change = procedures.proposeChange(plain.id, { steps: [{ kind: "loop", title: "Repeat", prompt: "Hi.", times: 2 }] });
  const before = procedures.get(plain.id);
  while (ledger.pendingCount() < 20) ledger.ask({ kind: "order", from: "owner", fingerprint: `fill-${ledger.pendingCount()}`,
    title: "Waiting", detail: "Waiting", payload: {} });
  const count = procedures.list().length;
  assert.throws(() => procedures.create(auto("Must not appear", [{ kind: "loop", title: "Repeat", prompt: "Hi.", times: 2 }])), /20 things/);
  assert.equal(procedures.list().length, count);
  assert.throws(() => procedures.applyChange(ledger.get(change.id).payload), /20 things/);
  assert.deepEqual(procedures.get(plain.id), before);
  assert.equal(unattended().length, 0);
});

test("proposals fingerprint behavior beyond prompt text", async (t) => {
  const { ledger, procedures } = await world(t);
  const first = procedures.propose(auto("Wait", [{ kind: "wait", title: "Pause", minutes: 5 }]));
  const second = procedures.propose(auto("Wait", [{ kind: "wait", title: "Pause", minutes: 60 }]));
  assert.equal(first.waiting, true);
  assert.equal(second.waiting, true);
  assert.notEqual(ledger.get(first.id).fingerprint, ledger.get(second.id).fingerprint);
});

test("the words a person writes for When and Wait are read into the engine's own form", () => {
  assert.deepEqual(parseWhen("5:00 PM", "Europe/London"), { kind: "daily", time: "17:00", timezone: "Europe/London" });
  assert.deepEqual(parseWhen("at 07:30", "UTC"), { kind: "daily", time: "07:30", timezone: "UTC" });
  assert.deepEqual(parseWhen("every 2 hours", "UTC"), { kind: "every", minutes: 120 });
  assert.deepEqual(parseWhen("after the invoice task", "UTC"), { kind: "after-task", words: "invoice" });
  assert.throws(() => parseWhen("Fridays whenever", "UTC"), /time of day/);
  assert.equal(parseWait("30 minutes"), 30);
  assert.equal(parseWait("2 hours"), 120);
  assert.equal(parseWait("1 day"), 1440);
  assert.throws(() => parseWait("8 days"), /at most a week/);
  assert.deepEqual(fanItems("Here:\n- one\n2) two\n\n* three"), ["Here:", "one", "two", "three"]);
});

test("every kind runs for real: split and gather, if it says, repeat until, wait, when, and a plain request", async (t) => {
  const { clock, prompts, ledger, procedures, unattended, yes } = await world(t, (prompt) => {
    if (/List the suppliers/.test(prompt)) return "- Staples\n- Viking\n- Office Depot";
    if (/Price Viking/.test(prompt)) return "Viking is cheaper than last time";
    if (/Check stock/.test(prompt)) return prompts().filter((p) => /Check stock/.test(p)).length >= 2 ? "all done" : "still counting";
    return "ok";
  });
  const p = procedures.create(auto("Price check", [
    { title: "List", prompt: "List the suppliers." },
    { kind: "fan", title: "Price each", prompt: "Price {item}." },
    { kind: "if", title: "Cheaper?", contains: "cheaper", yes: "Draft an order.", no: "Just report the prices." },
    { kind: "loop", title: "Stock", prompt: "Check stock.", times: 5, until: "done" },
    { kind: "wait", title: "Pause", minutes: "30 minutes" },
    { kind: "when", title: "After invoices", at: "after the invoice task" },
    { title: "Report", prompt: "Tell me what happened." },
  ]));
  // Made by the owner's yes, but its repeating steps are asked about apart, and it does not run before that yes.
  assert.equal(unattended().length, 1, "the separate question is asked when it is made");
  const refused = procedures.trigger(p.id, "a test");
  assert.equal(refused.started, false);
  assert.match(refused.reason, /waits for your yes to what it would repeat/);
  assert.deepEqual(prompts(), []);
  yes(unattended()[0]);
  assert.equal(procedures.trigger(p.id, "a test").started, true);
  await procedures.idle();
  assert.deepEqual(prompts(), ["List the suppliers.", "Price Staples.", "Price Viking.", "Price Office Depot.", "Draft an order.", "Check stock.", "Check stock."],
    "one per line, the yes way (the gathered answers say cheaper), and Repeat stops once it says done");
  let state = procedures.get(p.id);
  assert.ok(state.running?.waitUntil, "Wait holds the run");
  clock.now = new Date(clock.now.getTime() + 29 * 60_000);
  await procedures.tick();
  assert.equal(procedures.get(p.id).running.step, 4, "not before its time");
  clock.now = new Date(clock.now.getTime() + 2 * 60_000);
  await procedures.tick();
  await procedures.idle();
  state = procedures.get(p.id);
  assert.equal(state.running.waitFor, "invoice", "When waits for a task about invoices");
  procedures.afterTask("Water the plants");
  assert.equal(procedures.get(p.id).running.step, 5, "another task does not carry it on");
  procedures.afterTask("Pay the invoice from Viking");
  await procedures.idle();
  assert.equal(prompts().at(-1), "Tell me what happened.");
  state = procedures.get(p.id);
  assert.equal(state.running, null);
  assert.equal(state.stats.completed, 1);
  assert.equal(ledger.list("pending").length, 0);
});

test("the owner's yes lists exactly what could run unattended and how many times; past the hard cap nothing is kept", async (t) => {
  const { procedures, unattended } = await world(t);
  const p = procedures.create(auto("Stock", [{ kind: "loop", title: "Count", prompt: "Count the paper.", times: 4, until: "enough" },
    { kind: "fan", title: "Each shelf", prompt: "Check {item}." }], { perDay: 2 }));
  const [entry] = unattended();
  assert.match(entry.title, /Let "Stock" repeat and run steps without asking each time\?/);
  const lines = entry.detail.split("\n");
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^Step 1, Count: asks a Trunk the same request up to 4 times, stopping once the answer says "enough": Count the paper\.$/);
  assert.match(lines[1], /^Step 2, Each shelf: asks a Trunk once for each line the step before gave, up to 8 times: Check \{item\}\.$/);
  assert.equal(lines[2], `In all, one run makes at most 12 requests to a Trunk without asking you each time (no procedure may make more than ${maxUnattendedTurns}), and it runs at most 2 times a day.`);
  assert.deepEqual(entry.payload, { procedureId: p.id, fingerprint: entry.fingerprint });
  assert.throws(() => procedures.create(auto("Too much", [1, 2, 3, 4].map((n) => ({ kind: "loop", title: `Loop ${n}`, prompt: "Again.", times: 10 })))),
    /up to 40 requests to a Trunk; the most a procedure may make is 30/);
  assert.equal(procedures.list().length, 1, "the one over the cap was never kept");
  assert.throws(() => procedures.create(auto("Bad", [{ kind: "loop", title: "Loop", prompt: "Again.", times: 11 }])));
  assert.throws(() => procedures.create(auto("Bad", [{ kind: "wait", title: "Pause", minutes: 5, prompt: "Also do this." }])), /sends no request of its own/);
});

test("a no to the question keeps it from running; a change to its steps asks again, and the old yes never covers it", async (t) => {
  const { ledger, procedures, unattended, yes, prompts } = await world(t);
  const p = procedures.create(auto("Twice", [{ kind: "loop", title: "Ask", prompt: "Say hi.", times: 2 }]));
  ledger.settle(unattended()[0].id, false);
  const refused = procedures.trigger(p.id, "a test");
  assert.equal(refused.started, false);
  assert.match(refused.reason, /You said no/);
  const q = procedures.proposeChange(p.id, { steps: [{ kind: "loop", title: "Ask", prompt: "Say hi.", times: 3 }] });
  procedures.applyChange(ledger.get(q.id).payload);
  ledger.settle(q.id, true);
  assert.equal(unattended().length, 1, "the changed steps are asked about anew");
  assert.match(unattended()[0].detail, /up to 3 times/);
  assert.equal(procedures.trigger(p.id, "a test").started, false);
  yes(unattended()[0]);
  procedures.trigger(p.id, "a test");
  await procedures.idle();
  assert.deepEqual(prompts(), ["Say hi.", "Say hi.", "Say hi."]);
});

test("Run a flow runs the version the owner said yes to; when that flow changes it asks again and nothing of it runs", async (t) => {
  const { ledger, procedures, unattended, yes, prompts } = await world(t);
  const inner = procedures.create(auto("Tidy", [{ title: "Sort", prompt: "Sort the folder." }, { title: "Say", prompt: "Say what moved." }]));
  const outer = procedures.create(auto("Weekly", [{ title: "Start", prompt: "Begin the week." }, { kind: "sub", title: "Tidy up", flowId: inner.id }]));
  assert.equal(procedures.get(outer.id).procedure.steps[1].version, 1, "pinned to the version it runs now");
  const [entry] = unattended();
  assert.match(entry.detail, /Step 2, Tidy up: runs the procedure "Tidy" \(version 1\), up to 2 requests to a Trunk\./);
  yes(entry);
  procedures.trigger(outer.id, "a test");
  await procedures.idle();
  assert.deepEqual(prompts(), ["Begin the week.", "Sort the folder.", "Say what moved."]);

  const q = procedures.proposeChange(inner.id, { steps: [{ title: "Delete", prompt: "Delete the old files." }] });
  procedures.applyChange(ledger.get(q.id).payload);
  ledger.settle(q.id, true);
  const before = prompts().length;
  const held = procedures.trigger(outer.id, "a test");
  assert.equal(held.started, false, "the yes was for version 1; version 2 is not run under it: " + held.reason);
  await procedures.idle();
  assert.equal(prompts().length, before, "nothing ran");
  const again = unattended().at(-1);
  assert.match(again.detail, /runs the procedure "Tidy" \(version 2\)/);
  yes(again);
  procedures.trigger(outer.id, "a test");
  await procedures.idle();
  assert.deepEqual(prompts().slice(before), ["Begin the week.", "Delete the old files."]);

  assert.throws(() => procedures.create(auto("Self", [{ kind: "sub", title: "Me", flowId: outer.id }])), /runs another procedure itself|waits, asks you or runs a procedure/,
    "a flow that runs flows cannot be run from another");
  const waits = procedures.create(auto("Slow", [{ kind: "wait", title: "Pause", minutes: 5 }]));
  assert.throws(() => procedures.create(auto("Outer", [{ kind: "sub", title: "Slow", flowId: waits.id }])), /cannot be run from another procedure/);
  assert.throws(() => procedures.proposeChange(outer.id, { steps: [{ kind: "sub", title: "Me", flowId: outer.id }] }), /would run the procedure it is part of/);

  // The flow it runs is later changed to run a flow itself: nothing of it runs from here, and nothing is asked about it.
  const loops = procedures.create(auto("Loops", [{ kind: "loop", title: "Again", prompt: "Once more.", times: 10 }]));
  const nest = procedures.proposeChange(inner.id, { steps: [{ kind: "sub", title: "Loops", flowId: loops.id }] });
  procedures.applyChange(ledger.get(nest.id).payload);
  ledger.settle(nest.id, true);
  const ran = prompts().length;
  const nested = procedures.trigger(outer.id, "a test");
  assert.equal(nested.started, false);
  assert.match(nested.reason, /cannot be run from another procedure/);
  await procedures.idle();
  assert.equal(prompts().length, ran, "nothing ran");
  assert.equal(unattended().filter((e) => e.payload.procedureId === outer.id).length, 0,
    "no question about the outer flow, which would undercount what the flow inside it runs");
});

test("the hard cap holds at run time too, and a waiting run is not cut off by a restart", async (t) => {
  const { procedures, unattended, yes, prompts, app } = await world(t);
  const p = procedures.create(auto("Many", [{ kind: "loop", title: "Again", prompt: "Once more.", times: 3 }]));
  yes(unattended()[0]);
  procedures.trigger(p.id, "a test");
  // The run has already made its most (as if a flow it runs had grown): the next request is refused.
  const running = procedures.get(p.id);
  app.store.save("settings", "local", `autonomy-procedure:${p.id}`, { ...running, running: { ...running.running, turns: maxUnattendedTurns } });
  await procedures.idle();
  const after = procedures.get(p.id);
  assert.equal(after.running, null);
  assert.match(after.recent.at(-1).note, /stopped at 30 requests/);
  assert.ok(prompts().length <= 1);

  const w = procedures.create(auto("Waits", [{ kind: "wait", title: "Pause", minutes: 60 }, { title: "Then", prompt: "Carry on." }]));
  procedures.trigger(w.id, "a test");
  await procedures.idle();
  procedures.recover();
  assert.ok(procedures.get(w.id).running?.waitUntil, "still waiting after a restart, not cancelled");
});

test("the yes is the owner's alone: a short-lived key cannot answer it, and the route applies it", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-step-kinds-http-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"),
    provider: { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } } });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const call = async (path, body, key = server.token) => {
    const response = await fetch(server.url + path, { method: body === undefined ? "GET" : "POST",
      headers: { authorization: "Bearer " + key, origin: server.url, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  await call("/api/autonomy/switch", { part: "procedures", mode: "on", confirmLoosening: true });
  const made = await call("/api/autonomy/procedures", auto("Loop", [{ kind: "loop", title: "Ask", prompt: "Say hi.", times: 2 }]));
  assert.equal(made.status, 200);
  const waiting = (await call("/api/autonomy/ledger")).body.entries.find((e) => e.kind === "unattended");
  assert.ok(waiting);
  assert.match(offLimitsToShortLivedKeys("POST", "/api/autonomy/decide") ?? "", /short-lived key/, "a short-lived key cannot say yes");
  const said = await call("/api/autonomy/decide", { id: waiting.id, yes: true });
  assert.equal(said.status, 200);
  assert.equal(said.body.made.unattended.fingerprint, waiting.fingerprint);
  assert.equal((await call(`/api/autonomy/procedures/${made.body.procedure.id}/run`, {})).body.started, true);
});

test("a flow run from another never gets more permissions than either flow was given", async (t) => {
  const { asked, procedures, unattended, yes } = await world(t, () => "ok", ["files.read", "files.write", "web.fetch"]);
  const inner = procedures.create(auto("Read only", [{ title: "Look", prompt: "Look at the folder." }], { permissions: ["files.read"] }));
  const outer = procedures.create(auto("Writer", [{ title: "Write", prompt: "Write the notes." }, { kind: "sub", title: "Look", flowId: inner.id }],
    { permissions: ["files.read", "files.write"] }));
  yes(unattended().find((e) => e.payload.procedureId === outer.id));
  assert.equal(procedures.trigger(outer.id, "a test").started, true);
  await procedures.idle();
  assert.deepEqual(asked.map((r) => [r.prompt.split("\n").at(-1), [...r.permissions].sort()]),
    [["Write the notes.", ["files.read", "files.write"]], ["Look at the folder.", ["files.read"]]],
    "the inner flow's request keeps its own narrower permissions");
});
