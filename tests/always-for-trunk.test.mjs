/**
 * Redesign ("Always allow for <Trunk>"): a standing yes given to one Trunk's question is kept for that Trunk only.
 * Its work goes ahead without asking again; another Trunk doing the same thing is still asked; a yes named for a
 * Trunk other than the one that asked is refused. Scripted model and Trunks; nothing reaches a provider.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { call, fixture, on } from "./trunks-helpers.mjs";
import { evaluatePolicy, readPolicy, savePolicy } from "../dist/policy.js";

const note = { path: "note.txt", content: "hello" };
const rules = [({ last }) => (last?.role === "user" && /write the note/.test(String(last.content)) ? call("files.write", note) : null),
  ({ last }) => (last?.role === "tool" ? "Done." : null)];

async function twoTrunks(t) {
  const { app } = await fixture(t, rules);
  on(app);
  const ada = app.trunks.create({ name: "Ada" });
  const bo = app.trunks.create({ name: "Bo" });
  await app.trunks.introduced();
  for (const trunk of [ada, bo]) app.trunks.edit(trunk.id, { permissions: ["files.write", "files.read"] });
  const policy = readPolicy(app.store, app.runtime.owner);
  savePolicy(app.store, app.runtime.owner, { ...policy, rules: [{ tool: "files.write", decision: "ask" }, ...policy.rules] });
  return { app, ada, bo };
}
const asked = (app, runId) => app.runtime.approvals.questionFor(app.store.run(runId).sessionId);

test("a rule for one Trunk covers only that Trunk's work", () => {
  const policy = { preset: "custom", rules: [{ tool: "files.write", match: "*", applies: "any", decision: "allow", remember: "always", trunk: "ada" }] };
  const request = { tool: "files.write", target: "note.txt", readOnly: false };
  assert.equal(evaluatePolicy(policy, { ...request, trunk: "ada" }).decision, "allow");
  assert.equal(evaluatePolicy(policy, { ...request, trunk: "bo" }).rule, null, "another Trunk's work is not covered");
  assert.equal(evaluatePolicy(policy, request).rule, null, "the owner's own conversation is not covered");
});

test("Always allow for Ada is kept for Ada: Ada goes ahead, Bo is still asked", async (t) => {
  const { app, ada, bo } = await twoTrunks(t);
  const first = await app.trunks.say(ada.id, "write the note");
  const question = asked(app, first.runId);
  assert.ok(question, "Ada's write stopped on a question");
  assert.equal(question.trunk, ada.id, "the question knows which Trunk asked");
  app.runtime.approve(question.sessionId, "allow", "always", question.fingerprint, undefined, ada.id);
  const kept = readPolicy(app.store, app.runtime.owner).rules.find((rule) => rule.decision === "allow" && rule.tool === "files.write");
  assert.equal(kept?.trunk, ada.id, "the standing yes names Ada");

  const again = await app.trunks.say(ada.id, "write the note");
  assert.equal(asked(app, again.runId), undefined, "Ada is not asked again");
  const bos = await app.trunks.say(bo.id, "write the note");
  assert.equal(asked(app, bos.runId)?.trunk, bo.id, "Bo doing the same thing is still asked");
});

test("a yes named for a Trunk other than the one that asked is refused and keeps nothing", async (t) => {
  const { app, ada, bo } = await twoTrunks(t);
  const run = await app.trunks.say(ada.id, "write the note");
  const question = asked(app, run.runId);
  const before = readPolicy(app.store, app.runtime.owner).rules.length;
  assert.throws(() => app.runtime.approve(question.sessionId, "allow", "always", question.fingerprint, undefined, bo.id),
    /did not come from that Trunk's work/);
  assert.equal(readPolicy(app.store, app.runtime.owner).rules.length, before, "no rule was written");
  assert.ok(asked(app, run.runId), "the question still waits");
});

test("an always that does not name the Trunk (an older client) is still kept for the Trunk that asked", async (t) => {
  const { app, ada, bo } = await twoTrunks(t);
  const first = await app.trunks.say(ada.id, "write the note");
  const question = asked(app, first.runId);
  app.runtime.approve(question.sessionId, "allow", "always", question.fingerprint);
  const kept = readPolicy(app.store, app.runtime.owner).rules.find((rule) => rule.decision === "allow" && rule.tool === "files.write");
  assert.equal(kept?.trunk, ada.id, "kept for Ada, not for everyone");
  const bos = await app.trunks.say(bo.id, "write the note");
  assert.equal(asked(app, bos.runId)?.trunk, bo.id, "Bo is still asked");
});

test("a refusal or an ask-first that names a Trunk holds for everyone; only a yes is narrowed to a Trunk", () => {
  const request = { tool: "files.write", target: "note.txt", readOnly: false };
  for (const decision of ["deny", "ask"]) {
    const policy = { preset: "custom", rules: [{ tool: "files.write", match: "*", applies: "any", decision, remember: "always", trunk: "ada" }] };
    for (const trunk of ["ada", "bo", undefined])
      assert.equal(evaluatePolicy(policy, { ...request, trunk }).decision, decision, `${decision} for ${trunk ?? "no Trunk"}`);
  }
});
