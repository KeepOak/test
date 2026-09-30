import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import {
  createBranch,
  ApprovalGate,
  RateLimiter,
  PolicySchema,
  evaluatePolicy,
  globMatches,
  policyTarget,
  presetRules,
  policyPresets,
  cappedPolicy,
  readPolicy,
  savePolicy,
  addPolicyRule,
  isReadOnlyPermission,
  jsonWriteProblem,
} from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { maximumPolicyRules } from "../dist/policy.js";
/** Q257: the fingerprint of the question the window shows for a conversation; a bare answer is refused. */
const shownFingerprint = (app, sessionId) => app.runtime.approvals.questionFor(sessionId)?.fingerprint;

const say = (content) => () => ({ content, toolCalls: [] });
const calls = (...toolCalls) => () => ({ content: "", toolCalls });
const write = (id, path, content) => ({ id, name: "files.write", arguments: JSON.stringify({ path, content }) });

function scripted(steps) {
  const provider = {
    name: "scripted",
    requests: [],
    async complete(request) {
      provider.requests.push(request);
      return steps[Math.min(provider.requests.length - 1, steps.length - 1)](request);
    },
    /** Starts the script again, so each task in a test gets the same sequence of replies. */
    reset() { provider.requests.length = 0; },
  };
  return provider;
}
async function fixture(t, steps = [say("ok")], options = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-approvals-"));
  const provider = scripted(steps);
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider, ...options });
  app.coding.setMode("read-first", "off"); // read-first ships on (Q250); these tests are about approvals, not reading first
  t.after(async () => { await app.close(); await discardTemp(root); });
  return { app, root, provider, workspace: join(root, "workspace") };
}
async function served(t, steps, options = {}) {
  const { app, root, workspace, provider } = await fixture(t, steps, options);
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(() => server.close());
  const api = async (method, path, body) => {
    const response = await fetch(server.url + path, {
      method,
      headers: { authorization: `Bearer ${server.token}`, ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json() };
  };
  return { app, api, workspace, provider };
}
const kindsOf = (app, runId) => app.store.events(runId).map((event) => event.kind);

test("rules are read in order and match tool and target patterns", () => {
  assert.equal(globMatches("files.*", "files.write"), true);
  assert.equal(globMatches("files.write", "filesXwrite"), false, "the dot is literal, not a wildcard");
  assert.equal(globMatches("notes/*", "notes/deep/one.txt"), true);
  assert.equal(globMatches("*", ""), true);
  const policy = PolicySchema.parse({
    preset: "custom",
    rules: [
      { tool: "files.write", match: "notes/*", decision: "allow" },
      { tool: "files.*", decision: "deny" },
      { tool: "*", decision: "ask" },
    ],
  });
  assert.equal(evaluatePolicy(policy, { tool: "files.write", target: "notes/a.txt", readOnly: false }).decision, "allow");
  assert.equal(evaluatePolicy(policy, { tool: "files.write", target: "other.txt", readOnly: false }).decision, "deny");
  assert.equal(evaluatePolicy(policy, { tool: "shell.execute", target: "git status", readOnly: false }).decision, "ask");
  // A "changes" rule never stops a tool that only looks at things.
  const readOnly = PolicySchema.parse({ rules: [{ tool: "*", applies: "changes", decision: "deny" }] });
  assert.equal(evaluatePolicy(readOnly, { tool: "files.read", target: "a.txt", readOnly: true }).decision, "allow");
  assert.equal(evaluatePolicy(readOnly, { tool: "files.write", target: "a.txt", readOnly: false }).decision, "deny");
  assert.equal(policyTarget("shell.execute", { executable: "git", args: ["status"] }), "git status");
  assert.equal(policyTarget("web.fetch", { url: "https://example.org/a/b" }), "example.org");
  assert.equal(policyTarget("files.write", { path: "notes/a.txt" }), "notes/a.txt");
  assert.equal(isReadOnlyPermission("files.read"), true);
  assert.equal(isReadOnlyPermission("files.write"), false);
  assert.equal(isReadOnlyPermission("something.new"), false, "an unknown permission counts as a change");
});

test("the default policy asks nothing and refuses nothing, except a command nobody has ruled on", async (t) => {
  const { app, workspace } = await fixture(t, [calls(write("c1", "hello.txt", "hi")), say("done")]);
  const saved = readPolicy(app.store, app.runtime.owner);
  assert.deepEqual(saved, { preset: "off", rules: [], limits: { toolCallsPerMinute: 0, modelRoundsPerMinute: 0 }, unmatchedCommands: "ask" });
  assert.equal(evaluatePolicy(saved, { tool: "shell.execute", target: "rm -rf", readOnly: false }).decision, "allow",
    "without the thing it is about, nothing has changed");
  // Batch 26 (wave 8): a host command nobody has decided about is asked, not run on a guess.
  assert.equal(evaluatePolicy(saved, { tool: "shell.execute", target: "rm -rf", readOnly: false, resource: { kind: "command", value: "rm" } }).decision, "ask");
  assert.equal(evaluatePolicy({ ...saved, unmatchedCommands: "allow" }, { tool: "shell.execute", target: "rm -rf", readOnly: false, resource: { kind: "command", value: "rm" } }).decision, "allow");
  const run = await app.runtime.run({ prompt: "write the file" });
  assert.equal(run.status, "completed");
  assert.equal(await readFile(join(workspace, "hello.txt"), "utf8"), "hi");
  assert.ok(!kindsOf(app, run.id).includes("policy.ask"));
});

test("the three presets expand to rules and are chosen through the policy endpoint", async (t) => {
  const { api } = await served(t);
  const listed = (await api("GET", "/api/policy")).body;
  assert.equal(listed.policy.preset, "off");
  assert.deepEqual(listed.presets.map((preset) => preset.id), ["off", "ask-before-changes", "workspace", "careful", "read-only"]);
  // Q235: Careful is saved as a custom list older builds read, and still comes back through the endpoint as Careful.
  for (const preset of ["ask-before-changes", "workspace", "careful", "read-only"]) {
    const saved = (await api("POST", "/api/policy", { preset, confirmLoosening: true })).body.policy; // Q257: some moves loosen
    assert.equal(saved.preset, preset);
    assert.deepEqual(saved.rules, presetRules(preset));
    assert.ok(saved.rules.length > 0, `${preset} expands to rules`);
    assert.equal((await api("GET", "/api/policy")).body.policy.preset, preset);
  }
  assert.equal(presetRules("ask-before-changes")[0].decision, "ask");
  assert.equal(presetRules("read-only")[0].decision, "deny");
  assert.ok(policyPresets().every((preset) => preset.label && preset.description));
  // Hand-edited rules keep the limits and mark the policy as the owner's own.
  const custom = (await api("POST", "/api/policy", { rules: [{ tool: "shell.execute", decision: "deny" }], confirmLoosening: true })).body.policy; // Q257: from read-only this loosens
  assert.equal(custom.preset, "custom");
  assert.equal(custom.rules.length, 1);
  assert.equal((await api("POST", "/api/policy", { limits: { toolCallsPerMinute: 5 } })).body.policy.rules.length, 1);
});

test("an ask pauses the task, a yes for this conversation is not asked again, and a standing yes becomes a rule", async (t) => {
  const { app, api, workspace, provider } = await served(t, [calls(write("c1", "notes.txt", "one")), say("done")]);
  await api("POST", "/api/policy", { preset: "ask-before-changes" });
  const paused = (await api("POST", "/api/run", { prompt: "write notes" })).body;
  assert.equal(paused.status, "needs_input");
  assert.match(paused.output, /Before I go ahead: Writing notes\.txt/);
  const waiting = (await api("GET", "/api/policy")).body.waiting;
  assert.equal(waiting.length, 1);
  assert.equal(waiting[0].tool, "files.write");
  assert.equal(waiting[0].target, "notes.txt");
  assert.equal(waiting[0].source, "owner");
  const answered = await api("POST", "/api/policy/approve", { sessionId: paused.sessionId, fingerprint: shownFingerprint(app, paused.sessionId), decision: "allow", remember: "session" });
  assert.equal(answered.status, 200);
  assert.equal(answered.body.decision, "allow");
  provider.reset();
  const second = (await api("POST", "/api/run", { prompt: "write notes", sessionId: paused.sessionId })).body;
  assert.equal(second.status, "completed", second.output);
  assert.equal(await readFile(join(workspace, "notes.txt"), "utf8"), "one");
  assert.ok(!kindsOf(app, second.id).includes("policy.ask"), "the second call was not asked about again");
  // A standing yes is written back into the policy as an allow rule that beats the broad ask rule.
  provider.reset();
  const third = (await api("POST", "/api/run", { prompt: "write elsewhere" })).body;
  assert.equal(third.status, "needs_input");
  await api("POST", "/api/policy/approve", { sessionId: third.sessionId, fingerprint: shownFingerprint(app, third.sessionId), decision: "allow", remember: "always" });
  const policy = (await api("GET", "/api/policy")).body.policy;
  assert.deepEqual(policy.rules[0], { tool: "files.write", match: "notes.txt", applies: "any", decision: "allow", remember: "always" });
  assert.equal(evaluatePolicy(policy, { tool: "files.write", target: "notes.txt", readOnly: false }).decision, "allow");
  assert.equal(evaluatePolicy(policy, { tool: "files.write", target: "other.txt", readOnly: false }).decision, "ask");
});

// Q215 (NAS 8f03a68): with the approval rules full and only the owner's refusals and "ask first" rules to make room
// with, a standing yes is not kept. The owner is told, the yes holds for that conversation, and nothing is saved.
test("with the approval rules full, a standing yes is kept for the conversation only, and the answer says so", async (t) => {
  const { app, api, workspace, provider } = await served(t, [calls(write("c1", "notes.txt", "one")), say("done")]);
  await api("POST", "/api/policy", { preset: "ask-before-changes" });
  const lines = presetRules("ask-before-changes");
  const own = Array.from({ length: maximumPolicyRules - lines.length }, (_, i) =>
    ({ tool: `helper.t${i}`, match: "*", applies: "any", decision: i % 2 ? "ask" : "deny", remember: "always" }));
  app.store.save("settings", app.runtime.owner, "policy", { ...readPolicy(app.store, app.runtime.owner), rules: [...own, ...lines] });
  const full = readPolicy(app.store, app.runtime.owner).rules;
  assert.equal(full.length, maximumPolicyRules);
  const paused = (await api("POST", "/api/run", { prompt: "write notes" })).body;
  assert.equal(paused.status, "needs_input");
  const answered = await api("POST", "/api/policy/approve", { sessionId: paused.sessionId, fingerprint: shownFingerprint(app, paused.sessionId), decision: "allow", remember: "always" });
  assert.equal(answered.status, 200);
  assert.equal(answered.body.remembered, "session", "held for this conversation");
  assert.match(answered.body.standingNote, new RegExp(`rules are full \\(${maximumPolicyRules}\\).*not kept as a standing rule`));
  assert.deepEqual(readPolicy(app.store, app.runtime.owner).rules, full, "no rule was saved, and none of the owner's was dropped");
  provider.reset();
  const again = (await api("POST", "/api/run", { prompt: "write notes", sessionId: paused.sessionId })).body;
  assert.equal(again.status, "completed", again.output);
  assert.equal(await readFile(join(workspace, "notes.txt"), "utf8"), "one");
});

test("replaying a saved recipe asks about the steps inside it before any of them runs", async (t) => {
  let recipeId = "";
  const replay = () => ({ content: "", toolCalls: [{ id: "r1", name: "procedures.replay", arguments: JSON.stringify({ id: recipeId }) }] });
  // Q250: read before edit ships on and holds a recipe the model replays, so it reads the file the recipe writes first.
  const readIt = () => ({ content: "", toolCalls: [{ id: "r0", name: "files.read", arguments: JSON.stringify({ path: "recipe.txt" }) }] });
  const { app, api, workspace, provider } = await served(t, [readIt, replay, say("done")]);
  const context = app.runtime.context();
  const recipe = app.knowledge.proposeProcedure(context, {
    name: "write a file", preconditions: [],
    steps: [{ tool: "files.write", args: { path: "recipe.txt", content: "hello" }, expected: { path: "recipe.txt", bytes: 5 } }],
  });
  recipeId = recipe.id;
  // Verified first, while nothing is asked about; the settings come afterwards.
  assert.equal((await app.knowledge.verifyProcedure(context, recipe.id)).data.status, "verified");
  await api("POST", "/api/policy", { preset: "ask-before-changes" });
  await writeFile(join(workspace, "recipe.txt"), "stale");
  // Replaying at all is the first question; saying yes to it is not a yes to what is inside.
  const first = (await api("POST", "/api/run", { prompt: "replay it" })).body;
  assert.equal(first.status, "needs_input");
  assert.match(first.output, /Before I go ahead: Using procedures\.replay/);
  await api("POST", "/api/policy/approve", { sessionId: first.sessionId, fingerprint: shownFingerprint(app, first.sessionId), decision: "allow", remember: "session" });
  provider.reset();
  const paused = (await api("POST", "/api/run", { prompt: "replay it", sessionId: first.sessionId })).body;
  assert.equal(paused.status, "needs_input", "the step inside the recipe is asked about, not waved through");
  assert.match(paused.output, /Before I go ahead: Writing recipe\.txt/);
  assert.equal(await readFile(join(workspace, "recipe.txt"), "utf8"), "stale", "no step ran while it waits");
  const waiting = (await api("GET", "/api/policy")).body.waiting;
  assert.equal(waiting[0].tool, "files.write", "the question names the step's own tool");
  await api("POST", "/api/policy/approve", { sessionId: paused.sessionId, fingerprint: shownFingerprint(app, paused.sessionId), decision: "allow", remember: "session" });
  provider.reset();
  const second = (await api("POST", "/api/run", { prompt: "replay it", sessionId: paused.sessionId })).body;
  assert.equal(second.status, "completed", second.output);
  assert.equal(await readFile(join(workspace, "recipe.txt"), "utf8"), "hello");
});

test("a read-only setting refuses a recipe's steps before any of them runs", async (t) => {
  const { app, api, workspace } = await served(t);
  const context = app.runtime.context();
  const recipe = app.knowledge.proposeProcedure(context, {
    name: "write two files", preconditions: [],
    steps: [
      { tool: "files.write", args: { path: "one.txt", content: "one" }, expected: { path: "one.txt", bytes: 3 } },
      { tool: "files.write", args: { path: "two.txt", content: "two" }, expected: { path: "two.txt", bytes: 3 } },
    ],
  });
  await app.knowledge.verifyProcedure(context, recipe.id);
  await api("POST", "/api/policy", { preset: "read-only" });
  await assert.rejects(() => app.knowledge.replayProcedure(app.runtime.context(), recipe.id),
    /Your settings do not allow this/);
  assert.equal(await readFile(join(workspace, "one.txt"), "utf8"), "one", "only what the verification wrote is there");
});

test("a saved password inside a tool call never reaches the question the person is shown", async (t) => {
  const secret = "sk-live-do-not-print-me";  // not-a-real-secret: a planted fixture, here to prove it gets blanked out
  const { app, api } = await served(t, [calls(write("c1", `notes-${secret}.txt`, "one")), say("done")]);
  app.store.secrets.scrubber.remember("SERVICE_TOKEN", secret);
  await api("POST", "/api/policy", { preset: "ask-before-changes" });
  const paused = (await api("POST", "/api/run", { prompt: "write notes" })).body;
  assert.equal(paused.status, "needs_input");
  const waiting = (await api("GET", "/api/policy")).body.waiting;
  const shown = JSON.stringify([paused.output, waiting, app.store.events(paused.id)]);
  assert.ok(!shown.includes(secret), "the question, the waiting list and the event log are all scrubbed");
  assert.match(paused.output, /SERVICE_TOKEN/, "the name of the secret stands in for its value");
});

test("read only refuses a change in plain words without stopping the task", async (t) => {
  const { app, api, workspace } = await served(t, [calls(write("c1", "blocked.txt", "no")), say("I could not change that file")]);
  await api("POST", "/api/policy", { preset: "read-only" });
  const run = (await api("POST", "/api/run", { prompt: "write it" })).body;
  assert.equal(run.status, "completed");
  assert.ok(kindsOf(app, run.id).includes("policy.denied"));
  await assert.rejects(readFile(join(workspace, "blocked.txt"), "utf8"), /ENOENT/);
});

test("a browser click is asked about with the website it is on", async (t) => {
  const { app } = await fixture(t);
  const gate = app.runtime.approvals;
  const context = { ...app.runtime.context(), runId: "run-1" };
  app.registry.register({
    name: "browser.click", permission: "browser.interact", description: "click",
    parameters: (await import("zod")).z.object({ name: (await import("zod")).z.string() }).strict(),
    execute: async () => ({ clicked: true }),
    target: () => "shop.example.org",
  });
  assert.equal(app.registry.targetOf("browser.click", { name: "Buy" }, context), "shop.example.org");
  const policy = savePolicy(app.store, app.runtime.owner, { preset: "workspace" });
  assert.equal(evaluatePolicy(policy, { tool: "browser.click", target: "shop.example.org", readOnly: false }).decision, "ask");
  assert.equal(evaluatePolicy(policy, { tool: "files.write", target: "a.txt", readOnly: false }).decision, "allow",
    "the workspace preset lets file writes through");
  // Once the person allows that site for the conversation, the same click is not asked about again.
  gate.remember("session-1", "browser.click", "shop.example.org", "allow");
  assert.equal(gate.answer("session-1", "browser.click", "shop.example.org"), "allow");
  assert.equal(gate.answer("session-1", "browser.click", "other.example.org"), undefined);
});

test("a practice run says what it would have done and changes nothing", async (t) => {
  const { app, api, workspace, provider } = await served(t, [calls(write("c1", "practice.txt", "nope")), say("that is what I would do")]);
  const run = (await api("POST", "/api/run", { prompt: "write it", dryRun: true })).body;
  assert.equal(run.status, "completed");
  await assert.rejects(readFile(join(workspace, "practice.txt"), "utf8"), /ENOENT/);
  const events = app.store.events(run.id);
  const simulated = events.find((event) => event.kind === "tool.simulated");
  assert.equal(simulated.data.name, "files.write");
  assert.equal(simulated.data.target, "practice.txt");
  const report = events.find((event) => event.kind === "dryrun.report");
  assert.equal(report.data.count, 1);
  assert.equal(report.data.actions[0].label, "Writing practice.txt");
  // A real run with the same script does write the file, so the difference is the practice flag alone.
  provider.reset();
  const real = (await api("POST", "/api/run", { prompt: "write it" })).body;
  assert.equal(real.status, "completed");
  assert.equal(await readFile(join(workspace, "practice.txt"), "utf8"), "nope");
});

test("a conversation that hits its per-minute limit pauses and then carries on", async (t) => {
  // Deterministic timing: control the clock so both tool calls land within the same
  // rate window, making the test predictable regardless of machine speed.
  // Without this, on slow CI machines >1000ms can pass between calls, causing the
  // first call to age out of the window before the second is checked.
  let callNumber = 0;
  const baseTime = 10000; // arbitrary start time
  const testClock = () => baseTime + (callNumber * 500);

  const { app, api, workspace, provider } = await served(
    t,
    [calls(write("c1", "a.txt", "1")), calls(write("c2", "b.txt", "2")), say("both written")],
    { reliability: { rateWindowMs: 1000 }, clock: testClock },
  );

  const origComplete = provider.complete.bind(provider);
  provider.complete = async function(request) {
    const result = await origComplete(request);
    if (result.toolCalls?.length) {
      // Increment time for each tool call: first at T=0, second at T=500ms
      callNumber++;
    }
    return result;
  };

  await api("POST", "/api/policy", { limits: { toolCallsPerMinute: 1 } });
  const run = (await api("POST", "/api/run", { prompt: "write both" })).body;
  assert.equal(run.status, "completed", run.output);
  const kinds = kindsOf(app, run.id);
  assert.ok(kinds.includes("rate.paused"), "the task paused when it reached the limit");
  assert.ok(kinds.includes("rate.resumed"), "and carried on afterwards");
  const paused = app.store.events(run.id).find((event) => event.kind === "rate.paused");
  assert.match(String(paused.data.message), /reached its limit of 1 tool calls a minute/);
  assert.equal(await readFile(join(workspace, "b.txt"), "utf8"), "2", "nothing was dropped");
});

test("the sliding window counts only what is inside it", () => {
  const limiter = new RateLimiter(1000);
  assert.equal(limiter.waitMs("a", 2, 0), 0);
  limiter.record("a", 0);
  assert.equal(limiter.waitMs("a", 2, 10), 0);
  limiter.record("a", 10);
  assert.equal(limiter.waitMs("a", 2, 20), 980, "waits until the oldest of the two leaves the window");
  assert.equal(limiter.waitMs("a", 2, 1100), 0, "both have left the window by then");
  assert.equal(limiter.waitMs("a", 0, 20), 0, "a limit of zero means no limit");
});

test("a saved .json file that is not valid JSON is reported as a warning, and the file is kept", async (t) => {
  const { app, workspace } = await fixture(t, [calls(write("c1", "broken.json", "{oops")), say("saved")]);
  const run = await app.runtime.run({ prompt: "save the settings" });
  assert.equal(run.status, "completed");
  assert.equal(await readFile(join(workspace, "broken.json"), "utf8"), "{oops", "the write was not rolled back");
  const warning = app.store.events(run.id).find((event) => event.kind === "file.invalid_json");
  assert.equal(warning.data.path, "broken.json");
  assert.match(String(warning.data.message), /not valid JSON/);
  // The check is only about .json files, and valid JSON passes quietly.
  const read = async (path) => ({ content: await readFile(join(workspace, path), "utf8") });
  assert.equal(await jsonWriteProblem(read, "notes.txt"), null);
  await writeFile(join(workspace, "fine.json"), '{"a":1}');
  assert.equal(await jsonWriteProblem(read, "fine.json"), null);
  assert.ok(await jsonWriteProblem(read, "broken.json"));
});

test("a task the owner did not start cannot be given a standing yes and never gets more than ask", async (t) => {
  const { app, api } = await served(t, [calls(write("c1", "auto.txt", "x")), say("done")]);
  await api("POST", "/api/policy", { rules: [{ tool: "*", decision: "allow" }] });
  const owners = cappedPolicy(readPolicy(app.store, app.runtime.owner), "owner");
  assert.equal(evaluatePolicy(owners, { tool: "files.write", target: "auto.txt", readOnly: false }).decision, "allow");
  for (const source of ["trigger", "schedule", "mcp"]) {
    const capped = cappedPolicy(readPolicy(app.store, app.runtime.owner), source);
    assert.equal(evaluatePolicy(capped, { tool: "files.write", target: "auto.txt", readOnly: false }).decision, "ask",
      `${source} runs are held to "Ask before changes"`);
    assert.equal(evaluatePolicy(capped, { tool: "files.read", target: "auto.txt", readOnly: true }).decision, "allow",
      `${source} runs may still read`);
  }
  // A deny the owner set is kept for those tasks too.
  savePolicy(app.store, app.runtime.owner, { rules: [{ tool: "shell.execute", decision: "deny" }] });
  assert.equal(evaluatePolicy(cappedPolicy(readPolicy(app.store, app.runtime.owner), "trigger"),
    { tool: "shell.execute", target: "git status", readOnly: false }).decision, "deny");
  // Deliberately changed in 0.18.1 (security fix): this used to expect "allow", because "No approvals"
  // left outside tasks unheld. It now holds them to "Ask before changes" like every other preset.
  savePolicy(app.store, app.runtime.owner, { preset: "off" });
  assert.equal(evaluatePolicy(cappedPolicy(readPolicy(app.store, app.runtime.owner), "trigger"),
    { tool: "files.write", target: "auto.txt", readOnly: false }).decision, "ask");
  // The run itself cannot hand out a permanent yes. The owner's own refusal above stays through the
  // moves of the preset, so the rules to compare with are the ones in force before the run.
  savePolicy(app.store, app.runtime.owner, { preset: "ask-before-changes" });
  const rulesBefore = readPolicy(app.store, app.runtime.owner).rules;
  const run = await app.runtime.run({ prompt: "write it", source: "trigger" });
  assert.equal(run.status, "needs_input");
  assert.throws(() => app.runtime.approve(run.sessionId, "allow", "always"), /standing yes/);
  const once = await api("POST", "/api/policy/approve", { sessionId: run.sessionId, fingerprint: shownFingerprint(app, run.sessionId), decision: "allow", remember: "session" });
  assert.equal(once.status, 200);
  assert.deepEqual(readPolicy(app.store, app.runtime.owner).rules, rulesBefore, "no rule was added by the task");
});

test("a website is checked with you once and then remembered, under the workspace preset", async (t) => {
  const { z } = await import("zod");
  const reach = (id, url) => ({ id, name: "web.ping", arguments: JSON.stringify({ url }) });
  const { app, api, provider } = await served(t, [calls(reach("c1", "https://alpha.example.org/a")), say("done")]);
  app.registry.register({
    name: "web.ping", permission: "web.read", description: "look at a page",
    parameters: z.object({ url: z.string() }).strict(), execute: async () => ({ ok: true }),
  });
  await api("POST", "/api/policy", { preset: "workspace" });
  const paused = (await api("POST", "/api/run", { prompt: "look it up" })).body;
  assert.equal(paused.status, "needs_input");
  const [question] = (await api("GET", "/api/policy")).body.waiting;
  assert.equal(question.target, "alpha.example.org", "the rule matches on the website, not the whole address");
  assert.equal(question.remember, "always", "a new website is offered as a standing yes");
  await api("POST", "/api/policy/approve", { sessionId: paused.sessionId, fingerprint: shownFingerprint(app, paused.sessionId), decision: "allow", remember: "always" });
  const policy = (await api("GET", "/api/policy")).body.policy;
  assert.equal(policy.rules[0].match, "alpha.example.org");
  provider.reset();
  const second = (await api("POST", "/api/run", { prompt: "look it up", sessionId: paused.sessionId })).body;
  assert.equal(second.status, "completed", second.output);
  assert.ok(!kindsOf(app, second.id).includes("policy.ask"), "the same website is not asked about again");
  assert.equal(evaluatePolicy(policy, { tool: "web.ping", target: "beta.example.org", readOnly: true }).decision, "ask",
    "a different website is still checked with you");
});

test("a yes given earlier never outranks a rule that refuses", async (t) => {
  const { app, api, workspace, provider } = await served(t, [calls(write("c1", "later.txt", "x")), say("done")]);
  await api("POST", "/api/policy", { preset: "ask-before-changes" });
  const paused = (await api("POST", "/api/run", { prompt: "write it" })).body;
  assert.equal(paused.status, "needs_input");
  await api("POST", "/api/policy/approve", { sessionId: paused.sessionId, fingerprint: shownFingerprint(app, paused.sessionId), decision: "allow", remember: "session" });
  // Changing your mind takes effect at once, even inside the conversation that said yes.
  await api("POST", "/api/policy", { preset: "read-only" });
  provider.reset();
  const second = (await api("POST", "/api/run", { prompt: "write it", sessionId: paused.sessionId })).body;
  assert.equal(second.status, "completed");
  assert.ok(kindsOf(app, second.id).includes("policy.denied"));
  await assert.rejects(readFile(join(workspace, "later.txt"), "utf8"), /ENOENT/);
});

test("the gate remembers answers per conversation and forgets them on request", () => {
  const gate = new ApprovalGate();
  gate.ask({ runId: "r1", sessionId: "s1", tool: "files.write", target: "a.txt", label: "Writing a.txt",
    question: "ok?", source: "owner", remember: "session", askedAt: new Date().toISOString() });
  assert.equal(gate.waiting().length, 1);
  assert.equal(gate.waiting("s2").length, 0);
  assert.equal(gate.resolve("s1").tool, "files.write");
  assert.equal(gate.resolve("s1"), undefined, "a question is answered once");
  gate.remember("s1", "files.write", "a.txt", "deny");
  assert.equal(gate.answer("s1", "files.write", "a.txt"), "deny");
  gate.forget("s1");
  assert.equal(gate.answer("s1", "files.write", "a.txt"), undefined);
  assert.throws(() => addPolicyRule({ get: () => undefined, save: () => undefined }, "local", { tool: "x", decision: "bad" }));
});
