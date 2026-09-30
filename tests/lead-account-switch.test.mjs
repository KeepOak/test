/**
 * The lead's workbench (SELF-307): at a plan limit the lead's own conversation moves to the owner's next account in the
 * middle of a task and carries on, with the accounts pool as it ships (on, move to the next account on). The lead is
 * the default Trunk in Full Access, on the owner's Claude subscription through Branch's own tool loop.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createBranch } from "../dist/index.js";
import { accountsServiceFor } from "../dist/accounts/service.js";
import { registerCliAgent } from "../dist/providers/cli-agent.js";
import { accountsSettings, saveAccountsSettings } from "../dist/accounts/settings.js";
import { saveUsageGlanceSettings } from "../dist/usage-glance.js";
import { discardTemp } from "./temp-dir.mjs";

const pool = "cli-claude-code", second = "aaaaaaaa";
function stream(block) {
  const events = [{ type: "message_start", message: { role: "assistant", content: [], usage: { input_tokens: 2, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: block }, { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: block.type === "tool_use" ? "tool_use" : "end_turn" }, usage: { output_tokens: 3 } }, { type: "message_stop" }];
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
}

async function fixture(t, { limitPrimary = true } = {}) {
  const parent = join(tmpdir(), "claude-session-files"); await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "lead-account-switch-")), saved = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = join(root, "primary-native-account");
  let app;
  try { app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") }); }
  finally { if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = saved; }
  t.after(async () => { await app.close(); await discardTemp(root); });
  const service = accountsServiceFor(app.runtime.models);
  // Only the list is saved: the mode and the switch keep the values they ship with.
  saveAccountsSettings(app.store, app.runtime.owner, { poolingRule: 2, pools: [{ pool, kind: "cli",
    accounts: ["primary", second].map((id) => ({ id, label: id, createdAt: new Date().toISOString() })) }] });
  for (const id of ["primary", second]) service.noteSignIn(pool, id, { installed: true, signedIn: true, identity: { email: `${id}@fixture.invalid`, authMethod: "claude.ai" }, message: "Signed in" });
  const homes = new Map(), calls = [];
  let release;
  const state = { primaryLimited: false, asked: [], gate: new Promise((resolve) => { release = resolve; }) };
  state.release = () => release();
  service.deps.claudeSubscription = {
    spawn: (_command, args, invocation) => {
      homes.set(invocation.env.ANTHROPIC_BASE_URL, invocation.env.CLAUDE_CONFIG_DIR);
      return spawn(process.execPath, [resolve("tests/fixtures/claude-subscription-native.mjs"), ...args],
        { ...invocation, env: { ...invocation.env, BRANCH_NATIVE_FIXTURE_RELAY: invocation.env.ANTHROPIC_BASE_URL } });
    },
    connect: async (headers, payload) => {
      const body = JSON.parse(payload);
      const account = homes.get(headers["x-branch-fixture-relay"]) === service.primaryClaudeHome ? "primary" : "second";
      const results = body.messages.flatMap((message) => message.content).filter((part) => part.type === "tool_result");
      const asked = body.messages.flatMap((message) => message.content).map((part) => part.text ?? "").join("\n");
      calls.push({ account, round: results.length });
      state.asked.push(asked);
      if (/Long task/.test(asked) && results.length === 0) await state.gate;
      // The first account runs out of its plan after the task's first step.
      if (limitPrimary && account === "primary" && (results.length >= 1 || state.primaryLimited)) { state.primaryLimited = true; return new Response("", { status: 429 }); }
      const read = body.tools.find((one) => one.description.startsWith("Branch tool files.read."));
      if (/Long task/.test(asked) && results.length < 1)
        return stream({ type: "tool_use", id: "read-long", name: read.name, input: { path: "a.txt" } });
      if (/Read both notes/.test(asked) && results.length < 2)
        return stream({ type: "tool_use", id: `read-${results.length}`, name: read.name, input: { path: results.length ? "b.txt" : "a.txt" } });
      return stream({ type: "text", text: results.length ? results.map((one) => one.content).join(" + ") : "ok" });
    },
  };
  registerCliAgent(app.runtime.models, { id: "claude-code" });
  app.runtime.models.configure(app.runtime.owner, { activePreset: pool });
  await writeFile(join(root, "workspace", "a.txt"), "note A");
  await writeFile(join(root, "workspace", "b.txt"), "note B");
  return { app, service, calls, state };
}

test("the default Trunk's task moves to the next account at a plan limit mid-task, finishes, and the next turn stays there", async (t) => {
  const { app, calls } = await fixture(t);
  const shipped = accountsSettings(app.store, app.runtime.owner);
  assert.notEqual(shipped.mode, "off", "several accounts per connection ships on");
  assert.equal(shipped.pools[0].autoSwitch, true, "moving to the next account ships on");
  const home = app.trunks.ensureDefault(true);
  const run = await app.runtime.run({ prompt: "Read both notes, a.txt then b.txt", trunkId: home.id, mode: "full" });
  assert.equal(run.status, "completed", run.output);
  assert.match(run.output, /note A/);
  assert.match(run.output, /note B/);
  assert.equal(calls[0].account, "primary", "the task began on the first account");
  const moved = app.store.events(run.id).filter((event) => event.kind === "model.account_moved");
  assert.equal(moved.length, 1, JSON.stringify(app.store.events(run.id).map((e) => e.kind)));
  const afterMove = calls.slice(calls.findIndex((call) => call.account === "second"));
  assert.ok(afterMove.length >= 2 && afterMove.every((call) => call.account === "second"), JSON.stringify(calls));
  assert.ok(afterMove.some((call) => call.round >= 1), "the rest of the same task ran on the next account");
  const before = calls.length;
  const next = await app.runtime.run({ prompt: "Thanks", sessionId: run.sessionId, trunkId: home.id });
  assert.equal(next.status, "completed", next.output);
  assert.deepEqual(calls.slice(before).map((call) => call.account), ["second"], "the conversation stays on the account it moved to");
  // The lead sees it: the first account rests at its limit, the second is in use, and not every account is near.
  const usage = await app.registry.execute("accounts.usage", {}, app.runtime.context({ runId: next.id }));
  assert.equal(usage.connection, pool);
  assert.deepEqual(usage.accounts.map((one) => [one.account, one.limited, one.inUse]), [["primary", true, false], [second, false, true]]);
  assert.equal(usage.everyAccountNear, false);
  await assert.rejects(app.registry.execute("accounts.usage", {}, { ...app.runtime.context({ runId: next.id }), trunk: "another-trunk" }), /Only the owner's own/);
});

test("a running task is asked for a handoff once, and only when every account is near its limit", async (t) => {
  const { app, service, state } = await fixture(t, { limitPrimary: false });
  const home = app.trunks.ensureDefault(true);
  const resetAt = new Date(Date.now() + 3 * 60 * 60_000).toISOString();
  const used = (account, usedPercent) => service.notePlanWindows(pool, account,
    [{ id: "five_hour", usedPercent, minutes: 300, resetAt, measuredAt: new Date().toISOString() }]);
  const running = app.runtime.run({ prompt: "Long task: read a.txt", trunkId: home.id, mode: "full" });
  for (let i = 0; i < 200 && !state.asked.length; i++) await new Promise((done) => setTimeout(done, 25));
  const task = app.store.activeRuns(app.runtime.owner)[0];
  assert.ok(task, "the task is working");
  used("primary", 99); used(second, 50);
  await app.scheduler.tick();
  assert.equal(app.store.events(task.id).filter((e) => e.kind === "usage.handoff_asked").length, 0, "one account still has room: it moves there, no handoff");
  used(second, 98.5);
  // The owner's switch for asking tasks to save their progress rules the handoff too.
  saveUsageGlanceSettings(app.store, app.runtime.owner, { saveProgress: "off" });
  await app.scheduler.tick();
  assert.equal(app.store.events(task.id).filter((e) => e.kind === "usage.handoff_asked").length, 0, "switched off, never asked");
  saveUsageGlanceSettings(app.store, app.runtime.owner, { saveProgress: "ask" });
  await app.scheduler.tick();
  await app.scheduler.tick();
  assert.equal(app.store.events(task.id).filter((e) => e.kind === "usage.handoff_asked").length, 1, "asked once");
  assert.equal(app.store.events(task.id).find((e) => e.kind === "run.steered")?.data.from, "Branch (every account is near its plan limit)", "said as Branch's own note");
  const usage = await app.registry.execute("accounts.usage", {}, app.runtime.context({ runId: task.id }));
  assert.equal(usage.everyAccountNear, true);
  assert.deepEqual(usage.accounts.map((one) => one.percentUsed), [99, 99]);
  state.release();
  const done = await running;
  assert.equal(done.status, "completed", done.output);
  assert.ok(state.asked.some((text) => /Write a handoff now/.test(text) && /at or past 98% of its plan/.test(text)), "the note reached the task's next step");
});
