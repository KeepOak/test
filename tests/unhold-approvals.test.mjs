/**
 * unhold-approvals: the window now drives loosening approvals (Allow all, the second look switch), standing rules
 * ("Always allow", the rule list, adding and removing a rule) and the password-manager chooser. Each case here shows
 * the dangerous thing still cannot happen without the engine's own guard, and names the mutation that turns it red.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { readPolicy } from "../dist/policy.js";

const provider = { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } };

async function served(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-unhold-approvals-"));
  const dataDir = join(root, "data");
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir, provider });
  const server = await startServer(app, { dataDir, port: 0 });
  t.after(async () => { app.store.profiles.switch({ profileId: null }); await server.close(); await app.close(); await discardTemp(root); });
  const runKey = app.sessionTokens.create(app.runtime.owner, { name: "script", scope: "run", minutes: 5 }).token;
  const call = (method, path, body, key = server.token) => fetch(server.url + path, {
    method,
    headers: { authorization: `Bearer ${key}`, ...(method === "GET" ? {} : { "content-type": "application/json" }) },
    ...(method === "GET" ? {} : { body: JSON.stringify(body ?? {}) }),
  }).then(async (response) => ({ status: response.status, text: await response.text() }))
    .then(({ status, text }) => ({ status, text, body: (() => { try { return JSON.parse(text); } catch { return {}; } })() }));
  const rules = () => readPolicy(app.store, app.runtime.owner).rules;
  return { app, root, dataDir, server, runKey, call, rules };
}

/** A question waiting in a conversation, as a paused task leaves it, with the marks the engine puts on it. */
function seed(app, extra = {}) {
  const question = { runId: randomUUID(), sessionId: randomUUID(), tool: "files.write", target: "notes.txt", label: "Write notes.txt",
    question: "Before I go ahead: Write notes.txt. Is that all right?", source: "owner", remember: "session",
    askedAt: new Date().toISOString(), fingerprint: randomUUID().replaceAll("-", ""), ...extra };
  app.runtime.approvals.ask(question);
  return question;
}
const always = (q) => ({ sessionId: q.sessionId, decision: "allow", remember: "always", fingerprint: q.fingerprint });
const reviewer = (value, confirmLoosening = false) => ({ plan: { source: "set", key: "approval_reviewer", field: "mode", value },
  accept: ["approval_reviewer.mode"], ...(confirmLoosening ? { confirmLoosening } : {}) });
const reviewerMode = async (call) => (await call("GET", "/api/settings-kit")).body.settings
  .find((spec) => spec.key === "approval_reviewer").fields.find((field) => field.field === "mode").value;

/* Mutation: delete the `lockedDown` check at the top of `apply` in src/settings-kit/api.ts → the switch goes off. */
test("the second look cannot be switched off under Lockdown, and not without the owner's yes to loosening", async (t) => {
  const { call } = await served(t);
  assert.equal((await call("POST", "/api/settings-kit/apply", reviewer("on"))).status, 200, "control: switching it on tightens and needs no yes");
  const unconfirmed = await call("POST", "/api/settings-kit/apply", reviewer("off"));
  assert.equal(unconfirmed.status, 409);
  assert.match(unconfirmed.body.error, /less careful/);
  assert.equal(await reviewerMode(call), "on", "a loosening without the owner's yes changes nothing");
  assert.equal((await call("POST", "/api/lockdown", { on: true })).status, 200);
  const locked = await call("POST", "/api/settings-kit/apply", reviewer("off", true));
  assert.equal(locked.status, 409);
  assert.match(locked.body.error, /Lockdown is on/);
  assert.equal(await reviewerMode(call), "on", "Lockdown keeps the second look on even with the owner's yes");
  assert.equal((await call("POST", "/api/lockdown", { on: false })).status, 200);
  assert.equal((await call("POST", "/api/settings-kit/apply", reviewer("off", true))).status, 200, "control: the owner's yes, unlocked, turns it off");
  assert.equal(await reviewerMode(call), "off");
});

/* Mutation: delete the unhold-approvals `lockedDown` check in src/tracing-api.ts → both are let through. */
test("under Lockdown no rule is added or removed, so Lockdown's own ask-everything rule stays", async (t) => {
  const { call, rules } = await served(t);
  const added = await call("POST", "/api/rules/add", { tool: "files.write", match: "notes.txt", decision: "allow" });
  assert.equal(added.status, 200, "control: the owner adds a rule while unlocked");
  assert.equal((await call("GET", "/api/rules")).body.rules[0].rule.match, "notes.txt");
  assert.equal((await call("POST", "/api/lockdown", { on: true })).status, 200);
  const lockdownRules = rules();
  const add = await call("POST", "/api/rules/add", { tool: "*", match: "*", decision: "allow" });
  assert.equal(add.status, 409);
  assert.match(add.body.error, /Lockdown is on/);
  const remove = await call("POST", "/api/rules/remove", { index: 0 });
  assert.equal(remove.status, 409);
  assert.match(remove.body.error, /Lockdown is on/);
  assert.deepEqual(rules(), lockdownRules, "Lockdown's rule list is untouched");
  assert.equal((await call("POST", "/api/lockdown", { on: false })).status, 200);
  assert.equal(rules()[0].match, "notes.txt", "the owner's own list comes back as it was");
});

/* Mutation: delete the unhold-approvals `lockdownActive` check in Runtime.approve (src/runtime.ts) → the yes is
   written into Lockdown's own list, answered as "always", and lost when Lockdown ends. */
test("under Lockdown Always is refused, nothing is written, and the question keeps waiting for a plainer yes", async (t) => {
  const { app, call, rules } = await served(t);
  assert.equal((await call("POST", "/api/lockdown", { on: true })).status, 200);
  const lockdownRules = rules();
  const q = seed(app);
  const refused = await call("POST", "/api/policy/approve", always(q));
  assert.equal(refused.status >= 400, true, `→ ${refused.status}`);
  assert.match(refused.body.error, /Lockdown is on/);
  assert.deepEqual(rules(), lockdownRules, "Lockdown's rule list is untouched");
  assert.ok(app.runtime.approvals.questionFor(q.sessionId, q.fingerprint), "still waiting");
  const once = await call("POST", "/api/policy/approve", { ...always(q), remember: "never" });
  assert.equal(once.status, 200, "control: a yes just now still answers it under Lockdown");
  assert.equal(once.body.remembered, "never");
});

/* The flow path: a saved workflow stopped on a question is carried on with POST /api/workflows/<id>/resume, whose
   `remember` reaches Runtime.grantApproval, not Runtime.approve. Mutation: delete the unhold-approvals `lockdownActive`
   downgrade in grantApproval (src/runtime.ts) → "always" writes a rule into Lockdown's own list, lost when it ends. */
test("under Lockdown a workflow's Always is kept for that workflow only, and nothing is written into the rules", async (t) => {
  const { app, call, rules } = await served(t);
  const owner = app.runtime.owner;
  assert.equal((await call("POST", "/api/policy", { rules: [{ tool: "files.write", decision: "ask", remember: "session" }] })).status, 200);
  const made = app.workflows.create(owner, { name: "Writes one file",
    steps: [{ name: "Write it", kind: "tool", tool: "files.write", args: { path: "flow-note.txt", content: "flow" } }] });
  assert.equal((await call("POST", `/api/workflows/${made.id}/run`)).body.status, "waiting_approval");
  const asked = app.store.get("workflows", owner, made.id).data.pendingApproval;
  assert.match(String(asked.fingerprint ?? ""), /^[a-f0-9]{32}$/);
  assert.equal((await call("POST", "/api/lockdown", { on: true })).status, 200);
  const lockdownRules = rules();
  const resumed = await call("POST", `/api/workflows/${made.id}/resume`, { remember: "always" });
  assert.equal(resumed.status, 200, resumed.text);
  assert.deepEqual(rules(), lockdownRules, "Lockdown's rule list is untouched while it is on");
  assert.equal(app.runtime.approvals.answer(`workflow:${made.id}`, "files.write", asked.target, asked.fingerprint), "allow",
    "control: the yes was given, kept for this workflow");
  assert.equal((await call("POST", "/api/lockdown", { on: false })).status, 200);
  assert.equal(rules().some((rule) => rule.tool === "files.write" && rule.decision === "allow"), false,
    "no standing yes appears in the owner's own list either");
});

/* Mutation: delete `requireBoundSession(shortLivedKeyMark().sessionId, input.sessionId)` in src/server.ts, and have
   `keyAnswerRefusal` return null → a key answers a question of a task it never started. */
test("a short-lived key cannot answer a question of the owner's, even just now", async (t) => {
  const { app, call, runKey } = await served(t);
  const q = seed(app);
  const refused = await call("POST", "/api/policy/approve", { ...always(q), remember: "never" }, runKey);
  assert.equal(refused.status, 401);
  assert.ok(app.runtime.approvals.questionFor(q.sessionId, q.fingerprint), "still waiting");
});

/* Mutation: delete the `input.remember === "always" && startedWithShortLivedKey()` check in src/server.ts → the
   refusal's words change to the runtime's, and with `mayGiveStandingYes` also returning true the rule is written. */
test("a short-lived key cannot loosen, keep a standing yes, add or remove a rule, or change the password manager", async (t) => {
  const { app, call, runKey, rules } = await served(t);
  const q = seed(app);
  const standing = await call("POST", "/api/policy/approve", always(q), runKey);
  assert.equal(standing.status, 401);
  assert.match(standing.body.error, /cannot make a standing rule/);
  for (const [path, body] of [["/api/rules/add", { tool: "*", match: "*", decision: "allow" }], ["/api/rules/remove", { index: 0 }],
    ["/api/settings-kit/apply", reviewer("off", true)], ["/api/credentials/settings", { services: ["bitwarden"] }], ["/api/policy", { preset: "off" }]]) {
    const refused = await call("POST", path, body, runKey);
    assert.equal(refused.status, 401, path);
    assert.match(refused.body.error, /short-lived key/, path);
  }
  assert.deepEqual(rules(), [], "no rule was written");
  assert.ok(app.runtime.approvals.questionFor(q.sessionId, q.fingerprint), "the question is still waiting");
  const creds = (await call("GET", "/api/credentials/settings")).body;
  assert.deepEqual(creds.services, [], "the password manager is unchanged");
});

/* Mutation: make `mayGiveStandingYes` in src/runtime.ts return true → Sam's Always writes a rule into the owner's policy. */
test("a household person cannot keep a standing yes, add a rule, loosen the second look or pick the password manager", async (t) => {
  const { app, call, rules } = await served(t);
  const sam = app.store.profiles.create({ name: "Sam", pin: "2468" });
  app.runtime.roles.save(sam.id, { role: "adult" });
  const q = seed(app);
  app.store.profiles.switch({ profileId: sam.id, pin: "2468" });
  assert.throws(() => app.runtime.approve(q.sessionId, "allow", "always", q.fingerprint), /the owner's to give/);
  for (const [path, body] of [["/api/rules/add", { tool: "*", match: "*", decision: "allow" }], ["/api/rules/remove", { index: 0 }],
    ["/api/settings-kit/apply", reviewer("off", true)], ["/api/credentials/settings", { services: ["bitwarden"] }]]) {
    const refused = await call("POST", path, body);
    assert.ok(refused.status >= 400 && refused.status < 500, `${path} → ${refused.status}`);
    assert.match(refused.body.error, /belongs to the owner|owner/i, path);
  }
  app.store.profiles.switch({ profileId: null });
  assert.deepEqual(rules(), [], "the owner's policy is unchanged");
  assert.deepEqual((await call("GET", "/api/credentials/settings")).body.services, []);
  assert.equal(await reviewerMode(call), "off");
});

/* Mutations, one per case, each in Runtime.approve (src/runtime.ts): delete the `waiting.noStanding` check (Q59, Ask
   first and Plan); delete the `noStandingTarget` check (Q76, a pattern target); delete the `waiting.source !== "owner"`
   check (work the owner did not start: a tool server over MCP, a schedule, a trigger). Each lets a rule be written. */
test("Always is refused where the engine keeps no standing yes, and the question keeps waiting", async (t) => {
  const { app, call, rules } = await served(t);
  const cases = [
    [seed(app, { noStanding: true }), /never keep a yes for good/],
    [seed(app, { target: "*.txt", label: "Write *.txt" }), /does not say what it is targeting/],
    [seed(app, { source: "mcp" }), /did not start yourself/],
    [seed(app, { source: "schedule" }), /did not start yourself/],
  ];
  for (const [q, words] of cases) {
    const refused = await call("POST", "/api/policy/approve", always(q));
    assert.equal(refused.status >= 400, true, `${q.source} ${q.target} → ${refused.status}`);
    assert.match(refused.body.error, words);
    assert.ok(app.runtime.approvals.questionFor(q.sessionId, q.fingerprint), "still waiting");
  }
  assert.deepEqual(rules(), [], "no standing rule was written");
  const ok = seed(app);
  const kept = await call("POST", "/api/policy/approve", always(ok));
  assert.equal(kept.status, 200, "control: the owner's Always on an ordinary question of their own is kept");
  assert.equal(kept.body.remembered, "always");
  assert.equal(rules()[0].tool, "files.write");
});

/* Mutation: make `Secrets.list` in src/vault.ts add `value` to each entry → it shows in GET /api/secrets/<project>. */
test("a secret value never comes back in any response, the audit record or the data folder in plain text", async (t) => {
  const { call, dataDir } = await served(t);
  const value = `unhold-${randomUUID()}`;
  const put = await call("POST", "/api/secrets", { project: "default", name: "UNHOLD_TOKEN", value });
  assert.equal(put.status, 200, put.text);
  assert.equal(put.text.includes(value), false, "the save does not echo it");
  const reads = ["/api/secrets/default", "/api/secrets/audit", "/api/audit?limit=200", "/api/state", "/api/safety-extras/activity", "/api/settings-kit/history"];
  for (const path of reads) {
    const answer = await call("GET", path);
    assert.equal(answer.text.includes(value), false, `${path} carries the value`);
  }
  assert.ok((await call("GET", "/api/secrets/default")).body.secrets.some((s) => s.name === "UNHOLD_TOKEN"), "control: the name is listed");
  const plain = [];
  const walk = async (dir) => {
    for (const name of await readdir(dir)) {
      const path = join(dir, name);
      if ((await stat(path)).isDirectory()) await walk(path);
      else if ((await readFile(path)).includes(value)) plain.push(path);
    }
  };
  await walk(dataDir);
  assert.deepEqual(plain, [], "no file in the data folder holds the value in plain text");
});

test("the password manager is chosen by the owner alone, and choosing never switches the lookup on", async (t) => {
  const { call } = await served(t);
  const saved = await call("POST", "/api/credentials/settings", { services: ["1password"] });
  assert.equal(saved.status, 200);
  const now = (await call("GET", "/api/credentials/settings")).body;
  assert.deepEqual(now.services, ["1password"]);
  assert.equal(now.enabled, false, "the chooser leaves the owner's on/off switch alone");
});
