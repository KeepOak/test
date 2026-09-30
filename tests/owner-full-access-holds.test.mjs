import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { resolveCaller, asCaller } from "../dist/caller.js";
import { underShortLivedKey } from "../dist/key-context.js";
import { savePolicy } from "../dist/policy.js";
import { ContractBook } from "../dist/self-development-contract.js";
import { z } from "zod";
import { discardTemp } from "./temp-dir.mjs";

const change = { changes: [{ setting: "messagesPerConversationHour", value: 61 }] };
const caller = (overrides = {}) => resolveCaller({ key: "window", pairedDoor: false, fromThisComputer: true,
  windowHousehold: false, lockdown: false, appLocked: false, ...overrides });

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-full-access-"));
  const provider = { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const call = async (path, body) => {
    const response = await fetch(new URL(`/api/${path}`, server.url), { method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  return { app, call };
}

test("selected owner Full Access allows routine settings work and validated children without fabricating an approval", async (t) => {
  const { app, call } = await fixture(t);
  const started = await call("run", { prompt: "Do the work", mode: "full" });
  assert.equal(started.status, 200);
  const run = app.store.run(started.body.id);
  const own = app.runtime.context({ runId: run.id });
  assert.equal(app.runtime.checkPolicy("settings.change", change, own).decision, "allow");
  assert.equal(app.runtime.checkPolicy("desktop.screenshot", {}, own).decision, "allow", "the selected owner mode covers ordinary screen use");
  // SELF-013: starting a change to Branch itself is not asked again in the owner's selected Full Access; elsewhere it is.
  const prepare = { name: "x", repository: "KeepOak/Branch-Agent", contract: { allowedPaths: ["src/**"], permissions: ["files.write"],
    expectedTests: ["tests/x.test.mjs"], definitionOfDone: "d", sideEffects: [], rollbackPlan: "r" } };
  assert.equal(app.runtime.checkPolicy("branch.prepare_source_change", prepare, own).decision, "allow");
  const plain = await call("run", { prompt: "Do the work" });
  assert.equal(app.runtime.checkPolicy("branch.prepare_source_change", prepare, app.runtime.context({ runId: plain.body.id })).decision, "ask",
    "outside Full Access the owner is still asked, once each time");
  assert.equal(app.runtime.checkPolicy("code.hand_off", { program: "codex", folder: "site", task: "Review it" }, own).decision,
    "ask", "a hand-off using an external coding account keeps its own once-only question");
  await assert.rejects(app.registry.execute("files.write", { path: "branch-agent-source/src/runtime.ts", content: "unsafe" }, own),
    /protected Branch Agent source checkout is never changed directly/, "the execution guard still protects Branch's source");
  assert.match(app.runtime.ownerFullAccessFor(own, true), new RegExp(run.sessionId));
  assert.equal(app.store.audit.list(app.runtime.owner, { action: "approval.decided" }).length, 0, "selecting Full Access is not a fake answer to a tool question");
  const child = await asCaller(caller(), () => app.runtime.delegate("child work", own, ["settings.write"], "A checked helper", { agent: "writer" }));
  const childContext = app.runtime.context({ runId: child.id, depth: 1, agent: "writer", permissions: ["settings.write"] });
  assert.equal(app.runtime.checkPolicy("settings.change", change, childContext).decision, "allow", "actual owner child inherits the selected mode");
  assert.equal(app.runtime.ownerFullAccessFor(childContext, true), null, "a child cannot authorize widening Branch's own contract");
  assert.equal(app.runtime.ownerFullAccessFor({ ...childContext, agent: "pretend" }), null, "the agent must match the saved child mark");
  assert.equal(app.runtime.ownerFullAccessFor({ ...childContext, depth: 0 }), null, "the depth must match the saved parent chain");
});

test("outside, household, key, door, lock and owner rules remain stricter than Full Access", async (t) => {
  const { app, call } = await fixture(t);
  const started = await call("run", { prompt: "Do the work", mode: "full" });
  assert.equal(started.status, 200);
  const own = app.runtime.context({ runId: started.body.id });
  const check = (context = own) => app.runtime.checkPolicy("settings.change", change, context).decision;
  assert.equal(asCaller(caller({ pairedDoor: true }), () => check()), "ask", "a paired door cannot borrow this window's selection");
  assert.equal(underShortLivedKey(() => check()), "ask", "a short-lived key cannot borrow it");
  assert.equal(check({ ...own, source: "channel" }), "ask", "a chat source cannot claim the owner's mode");
  const outside = await app.runtime.run({ prompt: "from chat", sessionId: started.body.sessionId, source: "channel" });
  assert.equal(check(app.runtime.context({ runId: outside.id })), "ask", "the saved origin also bars a resumed outside task");
  const remote = await asCaller(caller({ fromThisComputer: false }), () => app.runtime.run({
    prompt: "from remote window", sessionId: started.body.sessionId, source: "owner" }));
  assert.equal(check(app.runtime.context({ runId: remote.id })), "ask", "the saved remote caller cannot become local after a reconnect");
  const person = app.store.profiles.create({ name: "Sam", pin: "1234" });
  app.store.profiles.switch({ profileId: person.id, pin: "1234" });
  assert.equal(check(), "ask", "switching the local window to a household person ends the owner exception");
  app.store.profiles.switch({ profileId: null });
  app.runtime.fullAccessLocked = () => true;
  assert.equal(check(), "ask", "App lock restores the hold even for the owner's saved mode");
  app.runtime.fullAccessLocked = () => false;
  savePolicy(app.store, app.runtime.owner, { preset: "off", rules: [{ tool: "settings.change", match: "*", applies: "any", decision: "ask", remember: "never" }] });
  assert.equal(check(), "ask", "the owner's named ask rule wins");
});

test("a direct owner's saved Full Access widens a real source contract without an invented approval", async (t) => {
  const { app, call } = await fixture(t);
  app.registry.register({ name: "git.push", permission: "git.remote", description: "no Git calls", parameters: z.object({}),
    execute: async () => ({}) });
  const started = await call("run", { prompt: "Improve Branch", mode: "full" });
  assert.equal(started.status, 200);
  const context = app.runtime.context({ runId: started.body.id });
  const book = new ContractBook(app.store.sqlite);
  const folder = "branch-agent-source/.branch-worktrees/self-example";
  book.create(app.runtime.owner, { taskRunId: started.body.id, sourceSha: "b".repeat(40), worktreePath: folder,
    terms: { allowedPaths: ["src/ui/**"], permissions: ["files.write"], expectedTests: ["tests/ui.test.mjs"],
      definitionOfDone: "The UI behavior works", sideEffects: [], rollbackPlan: "Remove the worktree" } });
  const input = { name: "example", reason: "Include the UI test", changes: { allowedPaths: ["src/ui/**", "tests/ui.test.mjs"] } };
  assert.equal(app.runtime.checkPolicy("branch.widen_source_contract", input, context).decision, "allow");
  const widened = await app.registry.execute("branch.widen_source_contract", input, context);
  assert.equal(widened.contract.revision, 2);
  assert.match(widened.contract.approvedBy, new RegExp(started.body.sessionId));
  assert.equal(app.store.audit.list(app.runtime.owner, { action: "approval.decided" }).length, 0);
  const child = await asCaller(caller(), () => app.runtime.delegate("Review it", context, ["git.remote"], "Checked helper", { agent: "reviewer" }));
  const childContext = app.runtime.context({ runId: child.id, depth: 1, agent: "reviewer", permissions: ["git.remote"] });
  await assert.rejects(app.registry.execute("branch.widen_source_contract", input, childContext),
    /Nobody has said yes to widening this contract/, "a child cannot turn inherited coding reach into owner authority");
  assert.equal(book.history(app.runtime.owner, folder).length, 2);
});
