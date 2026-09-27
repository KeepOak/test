import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, failureSignature } from "../dist/index.js";
import { startServer } from "../dist/server.js";

const say = (content) => () => ({ content, toolCalls: [] });
const call = (name, args, id = "c1") => () => ({ content: "", toolCalls: [{ id, name, arguments: JSON.stringify(args) }] });
/** Steps are consumed in order; `steps.next` lets a test switch the script mid-way. */
function scripted(initial) {
  const provider = { name: "scripted", requests: [], steps: initial, index: 0, async complete(request) {
    provider.requests.push(request);
    const step = provider.steps[Math.min(provider.index++, provider.steps.length - 1)];
    return step(request);
  } };
  provider.reset = (steps) => { provider.steps = steps; provider.index = 0; };
  return provider;
}
async function fixture(t, steps) {
  const root = await mkdtemp(join(tmpdir(), "branch-gov-"));
  const provider = scripted(steps);
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  t.after(async () => { await app.close(); await discardTemp(root); });
  return { app, root, provider };
}
const skillDoc = (name, body) => `---\nname: ${name}\ndescription: ${name} helps.\n---\n${body}\n`;
async function served(t, app, root) {
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(() => server.close());
  return async (path, body) => {
    const response = await fetch(server.url + "/api/" + path, { method: body === undefined ? "GET" : "POST", headers: { authorization: "Bearer " + server.token, origin: server.url, "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const json = await response.json(); if (!response.ok) throw new Error(json.error); return json;
  };
}

test("a skill that keeps failing the same way is set aside, gets one trial after the cool-off, and is demoted when failures pile up", async (t) => {
  const { app, root, provider } = await fixture(t, [say("x")]);
  const api = await served(t, app, root);
  const skill = app.store.skills.install("local", { document: skillDoc("counter", "Count things.") });
  const readThenFail = [call("skills.read", { id: skill.id, version: 1 }), say("no number here")];
  const context = app.runtime.context();
  const gov = app.store.governance;
  gov.configure({ excludeAfterFailures: 2, windowMinutes: 60, recoveryAfterMinutes: 30, demoteAfterFailures: 4 });
  assert.equal(failureSignature("The answer did not pass its check: 42 items missing (id 0abc12345678)"), "the answer did not pass its check: # items missing (id #)");
  const fail = async () => { provider.reset(readThenFail); return app.runtime.run({ prompt: "count", checks: { mustMatch: "\\d+", maxRetries: 0 } }); };
  const first = await fail();
  assert.equal(first.status, "failed");
  assert.equal(gov.exclusions().length, 0, "one failure is not a pattern yet");
  const second = await fail();
  assert.equal(gov.exclusions().length, 1);
  assert.ok(app.store.events(second.id).some((e) => e.kind === "skill.set_aside"));
  // The owner can let it back in right away; two more failures set it aside again.
  assert.equal((await api("state")).setAside.length, 1);
  await api(`governance/set-aside/${skill.id}/restore`, {});
  assert.equal((await api("governance")).setAside.length, 0);
  await fail(); await fail();
  assert.equal(gov.exclusions().length, 1);
  // While set aside, the skill is left out of the catalog a new run sees, with the reason recorded.
  provider.reset([say("plain answer")]);
  const excluded = await app.runtime.run({ prompt: "anything" });
  const catalog = app.store.events(excluded.id).find((e) => e.kind === "skills.catalog").data.entries;
  assert.deepEqual(catalog.map((c) => c.id), []);
  const why = app.store.events(excluded.id).find((e) => e.kind === "skill.excluded");
  assert.match(why.data.reason, /set aside after repeated failures/);
  // After the cool-off, exactly one trial is granted; success clears the pattern.
  gov.now = () => new Date(Date.now() + 31 * 60000);
  provider.reset([call("skills.read", { id: skill.id, version: 1 }), say("There are 7 apples")]);
  const trial = await app.runtime.run({ prompt: "count again", checks: { mustMatch: "\\d+", maxRetries: 0 } });
  assert.equal(trial.status, "completed");
  assert.ok(app.store.events(trial.id).some((e) => e.kind === "skill.recovery_trial"));
  assert.ok(app.store.events(trial.id).some((e) => e.kind === "skill.recovered"));
  assert.equal(gov.exclusions().length, 0);
  // With a lenient set-aside rule, enough failures in the window demote the active version instead.
  gov.now = () => new Date();
  gov.configure({ excludeAfterFailures: 10, windowMinutes: 60, recoveryAfterMinutes: 30, demoteAfterFailures: 3 });
  for (let i = 0; i < 3; i++) await fail();
  const view = app.store.skills.view("local", skill.id);
  assert.equal(view.activeVersion, null, "the skill's active version was disabled");
  const events = app.store.runs("local").flatMap((r) => app.store.events(r.id));
  assert.ok(events.some((e) => e.kind === "skill.demoted"));
  assert.equal((await api("governance")).settings.demoteAfterFailures, 3);
  void context;
});

test("a benchmark runs the same tasks under two versions of a skill and keeps outcomes and costs", async (t) => {
  const { app, root, provider } = await fixture(t, [say("x")]);
  const api = await served(t, app, root);
  const skill = app.store.skills.install("local", { document: skillDoc("summariser", "Version one: be vague.") });
  const v2 = app.store.skills.update("local", skill.id, { document: skillDoc("summariser", "Version two: always include the total."), expectedRevision: skill.revision });
  assert.equal(v2.headVersion, 2);
  // Parent run answers first; then baseline (vague) and candidate (with number) for each of two tasks.
  provider.reset([say("benchmark parent"), say("some stuff"), say("Total: 12"), say("more stuff"), say("Total: 3")]);
  const result = await api(`skills/${skill.id}/benchmark`, { baselineVersion: 1, candidateVersion: 2, tasks: [{ prompt: "sum a", checks: { mustMatch: "\\d+", maxRetries: 0 } }, { prompt: "sum b", checks: { mustMatch: "\\d+", maxRetries: 0 } }], seed: "s1" });
  assert.equal(result.tasks.length, 4);
  assert.deepEqual([result.summary.baseline.passed, result.summary.candidate.passed], [0, 2]);
  assert.ok(result.tasks.every((r) => typeof r.ms === "number" && typeof r.tokens === "number" && r.runId));
  assert.equal(result.seed, "s1");
  const instructions = provider.requests.slice(1).map((r) => r.messages[0].content);
  assert.match(instructions[0], /Version one: be vague/);
  assert.match(instructions[1], /Version two: always include the total/);
  assert.equal((await api("governance")).benchmarks.length, 1);
  assert.ok(app.store.events(result.parentRunId).some((e) => e.kind === "skill.benchmarked"));
});

test("a better version of a skill can be drafted from a task that went well, keeping the original", async (t) => {
  const { app, root, provider } = await fixture(t, [say("done nicely")]);
  const api = await served(t, app, root);
  const skill = app.store.skills.install("local", { document: skillDoc("notes", "Take notes.") });
  const good = await app.runtime.run({ prompt: "take notes on the meeting" });
  provider.reset([say("drafting parent"), say(skillDoc("notes", "Take notes. Always start with the date and list decisions first."))]);
  const draft = await api(`skills/${skill.id}/draft`, { runId: good.id });
  assert.equal(draft.originalVersion, 1);
  assert.equal(draft.candidateVersion, 2);
  assert.equal(draft.skill.activeVersion, 1, "the original stays active until the owner activates the draft");
  const view = app.store.skills.view("local", skill.id);
  assert.equal(view.versions.length, 2);
  assert.match(view.document, /list decisions first/);
  assert.match(app.store.skills.read("local", skill.id, { version: 1 }).document, /Take notes\.\n$/);
  assert.equal(app.store.get("settings", "local", `skill-candidate:${skill.id}:2`).data.fromRunId, good.id);
  provider.reset([say("parent"), say("not a skill document at all")]);
  await assert.rejects(api(`skills/${skill.id}/draft`, { runId: good.id }), /Malformed|front ?matter|document|name/i);
});
