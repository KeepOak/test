/**
 * Moving the approval preset (src/policy.ts, src/preset-moves.ts).
 *
 *   - A preset replaces its own lines, never the owner's: every refusal the owner has stays through a
 *     move, in front of the new preset's lines. A standing yes ends with the move, as it always has.
 *   - A move is weighed by what the policy answers before and after it, the owner's own rules included,
 *     never by where the preset sits in the list. Any answer that gets looser makes it a less careful
 *     change, which settings.change refuses and settings.loosen asks about every time.
 *
 * Everything runs on its own data folder and a closed port; the owner's own Branch is never touched.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, addPolicyRule, evaluatePolicy, isReadOnlyPermission, presetRules, readPolicy, savePolicy } from "../dist/index.js";
import { looserThan, policyForMode } from "../dist/conversation-mode.js";
import { z } from "zod";
import { changesFor } from "../dist/settings-kit/changes.js";
import { presets } from "../dist/settings-kit/presets.js";
import { settingsKitApi } from "../dist/settings-kit/api.js";
import { settingsHistory } from "../dist/settings-kit/history.js";
import { startServer } from "../dist/server.js";
import { maximumPolicyRules } from "../dist/policy.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-preset-moves-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const owner = app.runtime.owner;
  /** A context for a task the owner started in the app. */
  const as = () => {
    const run = app.store.createRun(owner, "change a setting");
    app.store.event(run.id, "run.started", { source: "owner" });
    return app.runtime.context({ runId: run.id, source: "owner" });
  };
  const policy = () => readPolicy(app.store, owner);
  /** What the saved policy answers for one tool, about nothing in particular. */
  const answer = (tool) => evaluatePolicy(policy(), { tool, target: "", readOnly: isReadOnlyPermission(app.registry.permissionOf(tool)) }).decision;
  const standing = (tool, decision) => addPolicyRule(app.store, owner, { tool, match: "*", decision, remember: "always" });
  /** The planned change of the preset, weighed on the app's own tools. */
  const move = (value) => changesFor(app.store, owner, [{ key: "policy", field: "preset", value }], app.registry);
  const run = (name, args) => app.registry.execute(name, args, as());
  return { app, root, owner, as, policy, answer, standing, move, run };
}

async function served(t, app, root) {
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(() => server.close());
  return async (method, path, body) => {
    const response = await fetch(server.url + path, {
      method,
      headers: { authorization: `Bearer ${server.token}`, ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json() };
  };
}

const presetChange = (value) => ({ changes: [{ setting: "policy.preset", value }] });
const refusalOf = (promise) => promise.then(() => null, (error) => error);
const ownRefusals = (count, prefix) =>
  Array.from({ length: count }, (_, i) => ({ tool: `${prefix}.t${i}`, match: "*", applies: "any", decision: "deny", remember: "always" }));

/* ---------- the owner's refusals stay through a move ---------- */

test("a standing refusal stays through preset moves, in front of each preset's own lines", async (t) => {
  const { app, owner, policy, answer, standing } = await fixture(t);
  savePolicy(app.store, owner, { preset: "workspace" });
  standing("web.fetch", "deny");
  const refusal = policy().rules[0];
  assert.equal(answer("web.fetch"), "deny");
  savePolicy(app.store, owner, { preset: "read-only" });
  assert.deepEqual(policy().rules, [refusal, ...presetRules("read-only")], "the owner's refusal is kept, in front");
  assert.equal(answer("web.fetch"), "deny");
  savePolicy(app.store, owner, { preset: "workspace" });
  assert.deepEqual(policy().rules, [refusal, ...presetRules("workspace")], "Read only's own refusal did not come along");
  assert.equal(answer("web.fetch"), "deny");
  assert.equal(answer("web.search"), "ask");
  // A conversation with a mode of its own replaces the preset's part, and keeps the owner's refusal in every mode.
  for (const mode of ["plan", "ask", "auto", "full"]) {
    const held = policyForMode(policy(), mode, false, app.registry.outboundTools());
    assert.equal(evaluatePolicy(held, { tool: "web.fetch", target: "", readOnly: true }).decision, "deny", `${mode} keeps it`);
  }
});

test("a preset's own refusal, or a hand-made copy of it, does not follow into the next preset", async (t) => {
  const { app, owner, policy } = await fixture(t);
  savePolicy(app.store, owner, { preset: "read-only" });
  savePolicy(app.store, owner, { preset: "workspace" });
  assert.deepEqual(policy().rules, presetRules("workspace"));
  const mine = { tool: "files.delete", match: "*", applies: "any", decision: "deny", remember: "session" };
  savePolicy(app.store, owner, { rules: [...presetRules("read-only"), mine] });
  assert.equal(policy().preset, "custom");
  savePolicy(app.store, owner, { preset: "ask-before-changes" });
  assert.deepEqual(policy().rules, [mine, ...presetRules("ask-before-changes")], "the owner's own refusal stays; the copy of a preset's line does not");
});

test("a standing yes ends with a preset move, as it always has", async (t) => {
  const { app, owner, policy, answer, standing } = await fixture(t);
  savePolicy(app.store, owner, { preset: "workspace" });
  standing("web.search", "allow");
  assert.equal(answer("web.search"), "allow");
  savePolicy(app.store, owner, { preset: "ask-before-changes" });
  assert.deepEqual(policy().rules, presetRules("ask-before-changes"));
  savePolicy(app.store, owner, { preset: "workspace" });
  assert.equal(answer("web.search"), "ask", "the yes did not come back with the preset that asked before");
});

test("the approval card and the settings kit keep the owner's refusals through a move, and the kit marks a looser move", async (t) => {
  const { app, root, policy, standing } = await fixture(t);
  const api = await served(t, app, root);
  assert.equal((await api("POST", "/api/policy", { preset: "workspace" })).status, 200);
  standing("web.fetch", "deny");
  const refusal = policy().rules[0];
  const card = await api("POST", "/api/policy", { preset: "read-only", confirmLoosening: true }); // Q257: web reads stop asking, so this loosens
  assert.equal(card.status, 200, "the owner's own move on the card, with the yes to loosening, is made at once");
  assert.deepEqual(card.body.policy.rules, [refusal, ...presetRules("read-only")], "the card's preset keeps the refusal");
  await api("POST", "/api/policy", { preset: "workspace", confirmLoosening: true }); // Q257: from read-only this loosens
  const plan = { source: "set", key: "policy", field: "preset", value: "ask-before-changes" };
  const preview = (await api("POST", "/api/settings-kit/preview", plan)).body;
  assert.equal(preview.changes.find((change) => change.id === "policy.preset")?.loosens, true, "looking things up on the web stops asking");
  const unticked = await api("POST", "/api/settings-kit/apply", { plan, accept: ["policy.preset"], confirmLoosening: false });
  assert.equal(unticked.status, 409, "it needs the separate yes");
  assert.equal(policy().preset, "workspace");
  const made = await api("POST", "/api/settings-kit/apply", { plan, accept: ["policy.preset"], confirmLoosening: true });
  assert.equal(made.status, 200);
  assert.deepEqual(policy().rules, [refusal, ...presetRules("ask-before-changes")], "the kit's writer keeps it too");
});

test("near the most rules a policy holds, a preset's own lines are never cut", async (t) => {
  const { app, owner, policy, standing, move } = await fixture(t);
  const M = maximumPolicyRules;
  const store = (preset, rules) => app.store.save("settings", owner, "policy", { preset, rules, limits: {}, unmatchedCommands: "ask" });
  const lines = presetRules("workspace");
  const kept = ownRefusals(M - lines.length, "helper");
  store("workspace", [...kept, ...lines]);
  assert.equal(policy().rules.length, M);
  savePolicy(app.store, owner, { preset: "read-only" });
  assert.deepEqual(policy().rules, [...kept, ...presetRules("read-only")]);
  savePolicy(app.store, owner, { preset: "workspace" });
  assert.deepEqual(policy().rules, [...kept, ...presetRules("workspace")], "exactly full, with every line of the preset");
  // A standing answer at the limit pushes out the oldest of the owner's own rules, never a line of the preset.
  standing("helper.newest", "deny");
  assert.equal(policy().rules.length, M);
  assert.equal(policy().rules[0].tool, "helper.newest");
  assert.deepEqual(policy().rules.slice(-lines.length), lines);
  assert.ok(!policy().rules.some((rule) => rule.tool === `helper.t${kept.length - 1}`), "the oldest of the owner's rules made room");
  assert.ok(policy().rules.some((rule) => rule.tool === `helper.t${kept.length - 2}`));
  // Read only's one refusal of every change is never the one cut. Q212: nor is one of the owner's refusals, for a
  // standing yes: with only refusals left, the yes is not remembered, and the audit says why.
  store("read-only", [...ownRefusals(M - 1, "other"), ...presetRules("read-only")]);
  const full = policy().rules;
  standing("other.newest", "allow");
  assert.deepEqual(policy().rules, full, "a standing yes pushes out none of the owner's refusals");
  assert.equal(evaluatePolicy(policy(), { tool: "files.write", target: "a.txt", readOnly: false }).decision, "deny");
  assert.equal(evaluatePolicy(policy(), { tool: `other.t${M - 2}`, target: "x", readOnly: false }).decision, "deny", "the oldest refusal stays");
  assert.match(app.store.audit.list(owner, { limit: 5 }).map((entry) => `${entry.outcome}: ${entry.reason}`).join("\n"), new RegExp(`not kept: .*full \\(${M}\\).*drop one of your refusals`));
  // With one of the owner's own yeses among them, that yes makes room instead, and the audit names it.
  store("read-only", [...ownRefusals(M - 2, "other"), { tool: "other.yes", match: "*", applies: "any", decision: "allow", remember: "always" }, ...presetRules("read-only")]);
  standing("other.newest", "allow");
  assert.equal(policy().rules.length, M);
  assert.equal(policy().rules[0].tool, "other.newest");
  assert.ok(!policy().rules.some((rule) => rule.tool === "other.yes"), "the owner's yes made room");
  assert.equal(policy().rules.filter((rule) => rule.tool.startsWith("other.t")).length, M - 2, "every refusal stays");
  assert.match(app.store.audit.list(owner, { limit: 5 }).map((entry) => entry.reason).join("\n"), /made room/);
  // Q215 (NAS 8f03a68): an owner's "ask first" is as careful as a refusal to a standing yes: it never makes room for one.
  store("read-only", [...ownRefusals(M - 151, "other"), ...ownRefusals(150, "asked").map((rule) => ({ ...rule, decision: "ask" })), ...presetRules("read-only")]);
  const guarded = policy().rules;
  standing("other.newest", "allow");
  assert.deepEqual(policy().rules, guarded, "a standing yes pushes out none of the owner's asks either");
  // A standing question may take the oldest ask's place, and a refusal comes before neither.
  standing("asked.newest", "ask");
  assert.equal(policy().rules[0].tool, "asked.newest");
  assert.ok(!policy().rules.some((rule) => rule.tool === "asked.t149"), "the oldest ask made room");
  assert.equal(policy().rules.filter((rule) => rule.decision === "deny" && rule.tool.startsWith("other.")).length, M - 151, "every refusal stays");
  // A move whose kept refusals and own lines would not fit is refused in plain words, and nothing changes.
  store("off", ownRefusals(M - 5, "more"));
  assert.throws(() => savePolicy(app.store, owner, { preset: "workspace" }), new RegExp(`more than the ${M}`));
  assert.equal(policy().preset, "off");
  assert.equal(policy().rules.length, M - 5);
  const planned = move("workspace");
  assert.deepEqual(planned.changes, [], "the kit plans nothing it could not save");
  assert.match(planned.refused.join("\n"), new RegExp(`^policy\\.preset: .*more than the ${M}`, "m"));
});

/* ---------- a move is weighed by what the policy answers ---------- */

test("moving from the workspace preset to Read only is less careful: settings.change refuses it, and settings.loosen asks every time", async (t) => {
  const { app, owner, as, policy, run } = await fixture(t);
  savePolicy(app.store, owner, { preset: "workspace" });
  const ask = presetChange("read-only");
  const refused = await refusalOf(run("settings.change", ask));
  assert.ok(refused, "settings.change did not make it");
  assert.match(refused.message, /less careful.*settings\.loosen/s);
  assert.match(refused.message, /look things up/i, "it says what would stop asking, by kind");
  assert.doesNotMatch(refused.message, /web\.(fetch|search|page|crawl)/, "and not by tool name");
  assert.equal(policy().preset, "workspace");
  const check = app.runtime.checkPolicy("settings.loosen", ask, as());
  assert.equal(check.onceOnly, true);
  assert.match(check.label, /look things up/i, "the owner's question says it too");
  const found = await run("settings.find", { request: "how careful", value: "read-only" });
  assert.equal(found.status, "ready");
  assert.equal(found.useTool, "settings.loosen");
  assert.match(found.preview[0].looser ?? "", /look things up/i);
  const made = await run("settings.loosen", ask);
  assert.equal(made.changed.length, 1);
  assert.equal(policy().preset, "read-only");
});

test("moving from the workspace preset to Ask before changes is less careful too: looking things up on the web stops asking", async (t) => {
  const { app, owner, as, policy, move } = await fixture(t);
  savePolicy(app.store, owner, { preset: "workspace" });
  assert.equal(move("ask-before-changes").changes[0].loosens, true);
  // Q235: the whole-app Careful preset no longer makes this move: it has approvals of its own.
  const careful = changesFor(app.store, owner, presets.find((preset) => preset.id === "careful").sets, app.registry).changes;
  assert.ok(!careful.some((change) => change.loosens), "applying Careful from the workspace preset makes nothing less careful");
  // In the train with dogfood A1: the catalogue sees this move as possibly looser, so its one question is asked every
  // time (settingsHold once-only), and that yes is what lets settings.change make it. The question says what loosens.
  const input = presetChange("ask-before-changes");
  const check = app.runtime.checkPolicy("settings.change", input, as());
  assert.equal(check.onceOnly, true, "asked every time");
  assert.match(check.label, /look things up/i, "and the question says what would stop asking");
  assert.equal(policy().preset, "workspace", "nothing changed before the yes");
});

test("moving from Ask before changes to Read only only tightens, so it is an ordinary change", async (t) => {
  const { app, owner, as, policy, move, run } = await fixture(t);
  savePolicy(app.store, owner, { preset: "ask-before-changes" });
  assert.equal(move("read-only").changes[0].loosens, false);
  assert.ok(!app.runtime.checkPolicy("settings.change", presetChange("read-only"), as()).onceOnly, "the ordinary question");
  assert.equal((await run("settings.change", presetChange("read-only"))).changed.length, 1);
  assert.equal(policy().preset, "read-only");
});

test("a move is weighed by what the owner's own rules answer, not by the preset's place in the list", async (t) => {
  const { app, owner, answer, move, run } = await fixture(t);
  // The place in the list calls leaving a hand-made list less careful; here nothing gets looser, since the refusal stays.
  savePolicy(app.store, owner, { rules: [{ tool: "web.fetch", decision: "deny" }] });
  assert.equal(move("read-only").changes[0].loosens, false);
  assert.equal((await run("settings.change", presetChange("read-only"))).changed.length, 1);
  assert.equal(answer("web.fetch"), "deny");
  // A hand-made copy of Read only's refusal is the owner's own: leaving it for Ask before changes turns refusals into questions.
  savePolicy(app.store, owner, { rules: presetRules("read-only") });
  const [change] = move("ask-before-changes").changes;
  assert.equal(change.loosens, true);
  assert.match(change.looser ?? "", /ask to .*which it refuses now/);
  // A question the owner wrote about one website is weighed on that website: a move that drops it lets the site through.
  savePolicy(app.store, owner, { rules: [{ tool: "web.fetch", match: "example.com", decision: "ask" }] });
  assert.equal(move("off").changes[0].loosens, true);
});

test("work started from outside, and a conversation on Full access, are weighed too, even when the owner's own answers stay", async (t) => {
  const { app, owner, move } = await fixture(t);
  // A yes for one website hides a question about that site that only work from outside (a trigger, a schedule,
  // a chat app) is still held to.
  savePolicy(app.store, owner, { rules: [{ tool: "web.fetch", match: "example.com", decision: "allow" }, { tool: "web.fetch", match: "example.com", decision: "ask" }] });
  const [site] = move("ask-before-changes").changes;
  assert.equal(site.loosens, true);
  assert.match(site.looser ?? "", /look things up without asking for work started from outside/);
  // The same with a yes for every website.
  savePolicy(app.store, owner, { rules: [{ tool: "web.*", decision: "allow" }, { tool: "web.*", decision: "ask" }] });
  const [outside] = move("ask-before-changes").changes;
  assert.equal(outside.loosens, true);
  assert.match(outside.looser ?? "", /look things up without asking for work started from outside/);
  // Full access keeps only the owner's own rules, so their own question ends with the move even where the new preset asks the same.
  savePolicy(app.store, owner, { rules: [{ tool: "web.search", decision: "ask" }] });
  const [full] = move("workspace").changes;
  assert.equal(full.loosens, true);
  assert.match(full.looser ?? "", /in a conversation on Full access$/);
});

test("undoing a less careful move, with a refusal added since, is refused in words that name what would loosen, and the refusal stays", async (t) => {
  const { app, owner, policy, answer, standing, run } = await fixture(t);
  savePolicy(app.store, owner, { preset: "ask-before-changes" });
  await run("settings.loosen", presetChange("workspace"));
  const record = settingsHistory(app.store, owner)
    .find((entry) => entry.source === "talk" && entry.changes.some((change) => change.setting === "policy.preset"));
  assert.ok(record, "the move was recorded");
  standing("web.fetch", "deny");
  const refused = await refusalOf(run("settings.undo", { record: record.id }));
  assert.ok(refused, "the undo was not made");
  assert.match(refused.message, /less careful/);
  assert.match(refused.message, /look things up/i);
  assert.equal(policy().preset, "workspace");
  assert.equal(answer("web.fetch"), "deny");
  // The owner undoes it on the Recent changes card, with the separate yes; the refusal stays through that move as well.
  const deps = { store: app.store, owner, workspace: app.runtime.workspace, appVersion: "test", tools: app.registry };
  const undo = (body) => settingsKitApi(deps, "POST", "/api/settings-kit/undo", async () => body);
  await assert.rejects(undo({ record: record.id }), /less careful/);
  await undo({ record: record.id, confirmLoosening: true });
  assert.equal(policy().preset, "ask-before-changes");
  assert.equal(answer("web.fetch"), "deny");
});

test("with no list of tools to weigh it on, a preset move counts as less careful", async (t) => {
  const { app, owner, move } = await fixture(t);
  const [unweighed] = changesFor(app.store, owner, [{ key: "policy", field: "preset", value: "ask-before-changes" }]).changes;
  assert.equal(unweighed.loosens, true);
  assert.equal(move("ask-before-changes").changes[0].loosens, false, "weighed on the tools, it only tightens");
});

test("a command no rule mentions still asks, so leaving the workspace preset for No approvals does not claim commands stop asking", async (t) => {
  const { app, owner, move } = await fixture(t);
  savePolicy(app.store, owner, { preset: "workspace" });
  const [change] = move("off").changes;
  assert.equal(change.loosens, true);
  assert.match(change.looser ?? "", /look things up/i);
  assert.doesNotMatch(change.looser ?? "", /run commands/i);
});

test("Careful asks before every change and before web lookups, and moving to it from either neighbour loosens nothing (Q235)", async (t) => {
  const { app, owner, answer, move } = await fixture(t);
  for (const from of ["workspace", "ask-before-changes"]) {
    savePolicy(app.store, owner, { preset: from });
    assert.equal(move("careful").changes[0].loosens, false, `from ${from} nothing gets looser`);
  }
  savePolicy(app.store, owner, { preset: "careful" });
  for (const tool of ["files.write", "files.delete", "web.search", "web.fetch", "browser.navigate", "shell.execute"])
    assert.equal(answer(tool), "ask", `${tool} is asked about under Careful`);
  assert.equal(answer("files.read"), "allow", "reading on this computer is free");
});

test("Careful is saved in a shape an older build reads, so a rollback keeps every rule (Q235, NAS 6512883)", async (t) => {
  const { app, owner } = await fixture(t);
  addPolicyRule(app.store, owner, { tool: "files.delete", match: "*", decision: "deny", remember: "always" });
  savePolicy(app.store, owner, { preset: "careful" });
  addPolicyRule(app.store, owner, { tool: "web.fetch", match: "https://example.com/*", decision: "allow", remember: "always" });
  const saved = app.store.get("settings", owner, "policy").data;
  assert.equal(saved.preset, "custom", "the saved row never carries a preset name an older build may not know");
  // The reader of the builds before Careful: the same strict object, with the five names they knew.
  const olderReader = z.object({ preset: z.enum(["off", "ask-before-changes", "workspace", "read-only", "custom"]),
    rules: z.array(z.any()), limits: z.any(), unmatchedCommands: z.enum(["ask", "allow"]) }).strict();
  const older = olderReader.safeParse(saved);
  assert.ok(older.success, "an older build reads it without falling back to no rules");
  assert.deepEqual(older.data.rules, readPolicy(app.store, owner).rules, "and keeps every rule: the owner's refusal, Careful's lines and the standing yes");
  // NAS af0a751: a yes of the owner's own makes it their own list; with only their refusal it is still Careful.
  assert.equal(readPolicy(app.store, owner).preset, "custom", "a standing yes in front of Careful's lines is the owner's own list");
  savePolicy(app.store, owner, { preset: "careful" });
  assert.equal(readPolicy(app.store, owner).preset, "careful", "picked again: the yes goes, the owner's refusal stays, and it is Careful");
  savePolicy(app.store, owner, { preset: "workspace" });
  assert.equal(app.store.get("settings", owner, "policy").data.preset, "workspace");
  assert.equal(readPolicy(app.store, owner).preset, "workspace");
});

test("a hand-made list is Careful only when it holds every line of Careful and no other preset's (Q235)", async (t) => {
  const { app, owner } = await fixture(t);
  const careful = presetRules("careful");
  savePolicy(app.store, owner, { rules: careful.slice(1) });
  assert.equal(readPolicy(app.store, owner).preset, "custom", "one of Careful's lines missing is not Careful");
  savePolicy(app.store, owner, { rules: [...careful, ...presetRules("read-only")] });
  assert.equal(readPolicy(app.store, owner).preset, "custom", "with Read only's refusal in it, it is not Careful either");
  savePolicy(app.store, owner, { rules: careful });
  assert.equal(readPolicy(app.store, owner).preset, "careful");
});

test("Careful ranks with Ask before changes: a conversation mode looser than asking is looser than Careful (Q235)", () => {
  assert.equal(looserThan("ask", "careful"), false);
  assert.equal(looserThan("plan", "careful"), false);
  assert.equal(looserThan("auto", "careful"), true);
  assert.equal(looserThan("full", "careful"), true);
});

test("a yes added on the rules card under Careful makes it the owner's own list, so picking Careful again asks nothing looser (NAS af0a751)", async (t) => {
  const { app, owner, answer, move } = await fixture(t);
  savePolicy(app.store, owner, { preset: "careful" });
  savePolicy(app.store, owner, { rules: [{ tool: "files.write", match: "*", decision: "allow", remember: "always" }, ...readPolicy(app.store, owner).rules] });
  assert.equal(readPolicy(app.store, owner).preset, "custom", "the card's edit is the owner's own list, as for every preset");
  assert.equal(answer("files.write"), "allow");
  assert.equal(move("careful").changes.length, 1, "picking Careful again is a real move");
  savePolicy(app.store, owner, { preset: "careful" });
  assert.equal(answer("files.write"), "ask", "and it takes the yes away");
  assert.equal(readPolicy(app.store, owner).preset, "careful");
});
