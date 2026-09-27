/**
 * Q257: a household person at the window sees and answers only the questions of their own tasks (runs they started,
 * `run.started` personProfileId, in their own conversations). Every other waiting question is left out of what they
 * read (GET /api/policy waiting, GET /api/state attention) and refused on every route that answers or settles one,
 * with the same status and words whether the question is live, answered already, made up, or in a conversation that
 * does not exist, so the refusal says nothing about the owner's work. The owner still sees and answers everything.
 *
 * Also here: POST /api/policy and POST /api/approvals/categories are refused under Lockdown (409, even with the
 * owner's yes to loosening), and a change that makes Branch less careful needs `confirmLoosening`. The password
 * manager save writes an audit entry (names only), and choosing one manager keeps the other one listed. An answer on
 * POST /api/policy/approve that names no fingerprint is refused when the question has one, and settles nothing.
 *
 * Mutations (each applied to dist/, this file run, the file put back), and the case each turns red:
 *   M1  GET /api/policy: drop the `mayAnswerHere` filter on `waiting`                  → "cannot see"
 *   M2  attention(): read `waitingRuns(runtime.owner)` for everyone again               → "cannot see"
 *   M3  POST /api/policy/approve: delete the `refuseForeignQuestion` call               → "cannot answer"
 *   M4  refuseForeignQuestion: throw a plain Error instead of the 404 HttpError         → "cannot answer" (the words differ)
 *   M5  mayAnswerHere: return false for every household person (no own-task allowance)  → "own task"
 *   M6  delete the owner's `return true` in mayAnswerHere and early return in refuseForeignQuestion → "owner still can"
 *   M7  POST /api/policy: delete the `policyChangeRefusal` throw                        → "POST /api/policy"
 *   M8  policyChangeRefusal: delete the Lockdown check (both routes)                    → "POST /api/policy", "categories"
 *   M9  policyChangeRefusal: skip the loosening weighing (both routes)                  → "POST /api/policy", "categories"
 *   M10 POST /api/approvals/categories: delete the `policyChangeRefusal` throw          → "categories"
 *   M11 saveCredentialSettings: delete the audit() call                                 → "password manager"
 *   M12 saveCredentialSettings: `choose` replaces the list ([choose]) instead of keeping → "password manager"
 *   M13 policyChangeLooser: drop the unmatched-commands check                            → "no command tool"
 *   M14 policyChangeLooser: drop the per-minute limit check                              → "POST /api/policy"
 *   M15 POST /api/policy/approve: delete the unnamed-answer (no fingerprint) check       → "names no request"
 *   M16 choosePreset (/preset): delete its refusal throw (Lockdown, and since Q258 loosening) → "POST /api/policy"
 * Run them all: node design/redesign/tools/mutate-q257.mjs (after npx tsc -p .).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { runForCurrentPerson } from "../dist/collab-server.js";
import { readPolicy, savePolicy } from "../dist/policy.js";
import { readCredentialSettings } from "../dist/credential-cli.js";
import { policyChangeLooser } from "../dist/preset-moves.js";

/** A model that writes one file when asked to, then says it is done. */
const writer = { name: "writer", async complete(request) {
  const last = request.messages.at(-1);
  if (last?.role === "user" && /^write /.test(String(last.content)))
    return { content: "", toolCalls: [{ id: `w${randomUUID()}`, name: "files.write", arguments: JSON.stringify({ path: String(last.content).slice(6).trim(), content: "hello" }) }] };
  return { content: "Done.", toolCalls: [] };
} };

async function served(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-q257-"));
  const dataDir = join(root, "data");
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir, provider: writer });
  savePolicy(app.store, app.runtime.owner, { preset: "ask-before-changes" });
  const server = await startServer(app, { dataDir, port: 0 });
  t.after(async () => { app.store.profiles.switch({ profileId: null }); await server.close(); await app.close(); await discardTemp(root); });
  const sam = app.store.profiles.create({ name: "Sam", pin: "2468" });
  app.runtime.roles.save(sam.id, { role: "adult" });
  const call = (method, path, body) => fetch(server.url + path, {
    method,
    headers: { authorization: `Bearer ${server.token}`, ...(method === "GET" ? {} : { "content-type": "application/json" }) },
    ...(method === "GET" ? {} : { body: JSON.stringify(body ?? {}) }),
  }).then(async (response) => ({ status: response.status, text: await response.text() }))
    .then(({ status, text }) => ({ status, text, body: (() => { try { return JSON.parse(text); } catch { return {}; } })() }));
  const asOwner = () => app.store.profiles.switch({ profileId: null });
  const asSam = () => app.store.profiles.switch({ profileId: sam.id, pin: "2468" });
  return { app, call, sam, asOwner, asSam };
}

/**
 * The owner's conversation with one question answered already (its fingerprint is stale) and one still waiting,
 * and Sam's own task waiting on its question. The window is left on the owner.
 */
async function waitingWork(app, asOwner, asSam) {
  asOwner();
  const first = await app.runtime.run({ prompt: "write old.txt" });
  const stale = app.runtime.approvals.questionFor(first.sessionId);
  app.runtime.approve(first.sessionId, "allow", "never", stale.fingerprint);
  const owners = await app.runtime.run({ prompt: "write owner.txt", sessionId: first.sessionId });
  const live = app.runtime.approvals.questionFor(owners.sessionId);
  assert.ok(live && live.fingerprint !== stale.fingerprint, "control: the owner's conversation has a new question waiting");
  asSam();
  const sams = await runForCurrentPerson(app, { prompt: "write sam.txt", onTextDelta: () => undefined });
  const mine = app.runtime.approvals.questionFor(sams.sessionId);
  assert.ok(mine, "control: Sam's own task asks before writing");
  asOwner();
  return { owners, live, stale, sams, mine };
}

/** Everything a refused answer must leave as it was: still waiting, same fingerprint, no yes kept, nothing carried on. */
function assertUntouched(app, run, live, why) {
  assert.equal(app.runtime.approvals.questionFor(run.sessionId, live.fingerprint)?.fingerprint, live.fingerprint, `${why}: still waiting`);
  assert.equal(app.store.run(run.id).status, "needs_input", `${why}: the task still waits`);
  assert.deepEqual(app.runtime.approvals.grants(run.sessionId).filter((grant) => grant.target === "owner.txt"), [], `${why}: no yes kept`);
  const decided = app.store.audit.list(app.runtime.owner, { action: "approval.decided" }).filter((entry) => entry.runId === run.id);
  assert.deepEqual(decided, [], `${why}: nothing recorded as decided`);
  assert.equal(app.store.sessionRuns(app.store.run(run.id).owner, run.sessionId).length, 2, `${why}: no carry-on was started`);
}

/* M1, M2 */
test("a household person cannot see the owner's waiting question, in GET /api/policy or GET /api/state", async (t) => {
  const { app, call, asOwner, asSam } = await served(t);
  const { owners, live, sams, mine } = await waitingWork(app, asOwner, asSam);
  asSam();
  const policy = (await call("GET", "/api/policy")).body;
  assert.deepEqual(policy.waiting.map((q) => q.fingerprint), [mine.fingerprint], "Sam's list holds his own question only");
  const attention = (await call("GET", "/api/state")).body.attention.map((w) => w.runId);
  assert.equal(attention.includes(owners.id), false, "the owner's waiting task is not in Sam's attention list");
  assert.ok(attention.includes(sams.id), "Sam's own waiting task is");
  asOwner();
  const ownerView = (await call("GET", "/api/policy")).body.waiting.map((q) => q.fingerprint);
  assert.ok(ownerView.includes(live.fingerprint) && ownerView.includes(mine.fingerprint), "control: the owner's list holds both");
  assert.ok((await call("GET", "/api/state")).body.attention.some((w) => w.runId === owners.id), "control: the owner's attention list holds theirs");
});

/* M3, M4 */
test("a household person cannot answer the owner's question on any route, with any fingerprint, and nothing changes", async (t) => {
  const { app, call, asOwner, asSam } = await served(t);
  const { owners, live, stale } = await waitingWork(app, asOwner, asSam);
  asSam();
  const sessionId = owners.sessionId;
  const tries = [
    { sessionId, decision: "allow", remember: "never", fingerprint: live.fingerprint },
    { sessionId, decision: "allow", remember: "never", fingerprint: live.fingerprint, carryOn: true },
    { sessionId, decision: "deny", remember: "never", fingerprint: live.fingerprint, carryOn: true },
    { sessionId, decision: "allow", remember: "session", fingerprint: live.fingerprint },
    { sessionId, decision: "allow", remember: "never" },
    { sessionId, decision: "allow", remember: "never", fingerprint: stale.fingerprint },
    { sessionId, decision: "allow", remember: "never", fingerprint: "0".repeat(32) },
    { sessionId: randomUUID(), decision: "allow", remember: "never", fingerprint: live.fingerprint },
  ];
  const answers = [];
  for (const body of tries) answers.push(await call("POST", "/api/policy/approve", body));
  for (const [index, answer] of answers.entries()) assert.equal(answer.status, 404, `try ${index}: ${answer.text}`);
  assert.equal(new Set(answers.map((answer) => answer.text)).size, 1, `every refusal reads the same: ${answers.map((a) => a.text).join(" | ")}`);
  assert.deepEqual(answers[0].body, { error: "Nothing in this conversation is waiting for your answer." });
  assertUntouched(app, owners, live, "after POST /api/policy/approve");

  // The other ways to answer, carry on or settle a task are closed to a household person already; kept closed here.
  // Each is refused for its own reason, read from the body: the household gate (src/household-routes.ts), the route's
  // requireOwner, or the owner's run and conversation not being found in the household person's scope.
  const gate = /^This belongs to the owner\. Switch back to the owner's profile to use it\.$/;
  const owner = /belongs to the owner\. Switch back to the owner's profile/;
  const closed = [
    ["/api/safety-extras/codes/confirm", { sessionId, fingerprint: live.fingerprint, code: "123456" }, 400, /^The safety extras belongs to the owner/],
    [`/api/trunks/messages/${randomUUID()}/answer`, {}, 400, gate],
    [`/api/trunks/rooms/${randomUUID()}/answer`, { memberId: randomUUID(), decision: "allow" }, 400, gate],
    [`/api/runs/${owners.id}/resume`, {}, 404, /^Run not found$/],
    [`/api/runs/${owners.id}/cancel`, {}, 404, /^Run not found$/],
    [`/api/sessions/${sessionId}/followups`, { prompt: "yes, go ahead" }, 404, /^Session not found$/],
    ["/api/deferred/settle", { id: randomUUID(), outcome: "done" }, 400, owner],
    [`/api/flows/${randomUUID()}/resume`, {}, 400, owner],
    [`/api/workflows/${randomUUID()}/resume`, {}, 400, gate],
    ["/api/personal/voice/answer", { decision: "allow" }, 400, gate],
    ["/api/run", { prompt: "yes, go ahead", sessionId }, 400, /^Conversation not found$/],
  ];
  for (const [path, body, status, words] of closed) {
    const answer = await call("POST", path, body);
    assert.equal(answer.status, status, `${path} → ${answer.status} ${answer.text}`);
    assert.match(String(answer.body.error), words, `${path} is refused for its own reason: ${answer.text}`);
  }
  assertUntouched(app, owners, live, "after every other route");
  asOwner();
  assert.equal((await call("POST", "/api/policy/approve", tries[0])).status, 200, "control: the owner's own answer still lands");
});

/* M5 */
test("a household person can answer their own task's question", async (t) => {
  const { app, call, asOwner, asSam } = await served(t);
  const { owners, live, sams, mine } = await waitingWork(app, asOwner, asSam);
  asSam();
  const answered = await call("POST", "/api/policy/approve", { sessionId: sams.sessionId, decision: "allow", remember: "never", fingerprint: mine.fingerprint, carryOn: true });
  assert.equal(answered.status, 200, answered.text);
  assert.equal(answered.body.decision, "allow");
  assert.equal(app.runtime.approvals.questionFor(sams.sessionId, mine.fingerprint), undefined, "Sam's question is answered");
  assert.equal(answered.body.task, "settled", "a household person's own task is settled, never carried on as the owner's");
  assertUntouched(app, owners, live, "the owner's question");
});

/* M6 */
test("the owner still answers everything: their own question and a household person's", async (t) => {
  const { app, call, asOwner, asSam } = await served(t);
  const { owners, live, sams, mine } = await waitingWork(app, asOwner, asSam);
  const listed = (await call("GET", "/api/policy")).body.waiting.map((q) => q.fingerprint);
  assert.deepEqual([live.fingerprint, mine.fingerprint].filter((fp) => listed.includes(fp)), [live.fingerprint, mine.fingerprint], "the owner sees both");
  const theirs = await call("POST", "/api/policy/approve", { sessionId: sams.sessionId, decision: "deny", remember: "never", fingerprint: mine.fingerprint });
  assert.equal(theirs.status, 200, theirs.text);
  const own = await call("POST", "/api/policy/approve", { sessionId: owners.sessionId, decision: "allow", remember: "never", fingerprint: live.fingerprint, carryOn: true });
  assert.equal(own.status, 200, own.text);
  assert.equal(own.body.task, "carrying-on");
  assert.equal(app.runtime.approvals.questionFor(owners.sessionId, live.fingerprint), undefined);
});

/* M15 */
test("an answer that names no request is refused when the question has a fingerprint, and settles nothing", async (t) => {
  const { app, call, asOwner, asSam } = await served(t);
  const { owners, live, sams, mine } = await waitingWork(app, asOwner, asSam);
  for (const decision of ["allow", "deny"]) {
    const bare = await call("POST", "/api/policy/approve", { sessionId: owners.sessionId, decision, remember: "never", carryOn: true });
    assert.equal(bare.status, 409, bare.text);
    assert.match(bare.body.error, /which request/);
  }
  assertUntouched(app, owners, live, "after a bare yes and a bare no from the owner");
  asSam();
  const own = await call("POST", "/api/policy/approve", { sessionId: sams.sessionId, decision: "allow", remember: "never", carryOn: true });
  assert.equal(own.status, 409, "a household person's own bare yes is refused too");
  assert.equal(app.runtime.approvals.questionFor(sams.sessionId, mine.fingerprint)?.fingerprint, mine.fingerprint);
  assert.equal(app.store.run(sams.id).status, "needs_input");
  asOwner();
  const named = await call("POST", "/api/policy/approve", { sessionId: owners.sessionId, decision: "allow", remember: "never", fingerprint: live.fingerprint });
  assert.equal(named.status, 200, "control: the same answer naming its request lands");
});

/* M7, M8, M9, M13, M14 */
test("POST /api/policy: a loosening needs confirmLoosening, and nothing is changed under Lockdown", async (t) => {
  const { app, call } = await served(t);
  const preset = () => readPolicy(app.store, app.runtime.owner).preset;
  assert.equal((await call("POST", "/api/commands/settings", { mode: "on" })).status, 200, "typed commands on, for /preset below");
  const loose = await call("POST", "/api/policy", { preset: "off" });
  assert.equal(loose.status, 409, loose.text.slice(0, 300));
  assert.match(loose.body.error, /less careful/);
  assert.equal(preset(), "ask-before-changes", "an unconfirmed loosening changes nothing");
  assert.equal((await call("POST", "/api/policy", { preset: "read-only" })).status, 200, "control: tightening needs no yes");
  const rules = await call("POST", "/api/policy", { rules: [{ tool: "*", match: "*", decision: "allow" }] });
  assert.equal(rules.status, 409, "an allow-everything rule list is a loosening");
  assert.equal(preset(), "read-only");
  assert.equal((await call("POST", "/api/policy", { unmatchedCommands: "allow" })).status, 409, "letting unmentioned commands through loosens");
  assert.equal((await call("POST", "/api/policy", { limits: { toolCallsPerMinute: 30 } })).status, 200, "control: a limit tightens");
  assert.equal((await call("POST", "/api/policy", { limits: { toolCallsPerMinute: 0 } })).status, 409, "taking a limit away loosens");
  assert.equal(readPolicy(app.store, app.runtime.owner).limits.toolCallsPerMinute, 30);
  assert.equal((await call("POST", "/api/lockdown", { on: true })).status, 200);
  const locked = readPolicy(app.store, app.runtime.owner);
  for (const body of [{ preset: "off", confirmLoosening: true }, { preset: "read-only" }, { rules: [] , confirmLoosening: true }]) {
    const refused = await call("POST", "/api/policy", body);
    assert.equal(refused.status, 409, refused.text);
    assert.match(refused.body.error, /Lockdown is on/);
  }
  const typed = await call("POST", "/api/commands/run", { surface: "window", line: "/preset off" });
  assert.match(typed.text, /Lockdown is on/, `the /preset command is refused too: ${typed.text.slice(0, 200)}`);
  assert.deepEqual(readPolicy(app.store, app.runtime.owner), locked, "Lockdown's policy is untouched");
  assert.equal((await call("POST", "/api/lockdown", { on: false })).status, 200);
  assert.equal(preset(), "read-only", "the owner's own policy comes back");
  const confirmed = await call("POST", "/api/policy", { preset: "off", confirmLoosening: true });
  assert.equal(confirmed.status, 200, confirmed.text.slice(0, 300));
  assert.equal(preset(), "off", "control: the owner's yes loosens");
});

/* M13 */
test("letting a command no rule mentions run without asking is less careful even where no command tool is registered", () => {
  const before = { preset: "custom", rules: [], limits: { toolCallsPerMinute: 0, modelRoundsPerMinute: 0 }, unmatchedCommands: "ask" };
  const none = { inventory: () => [] };
  assert.match(String(policyChangeLooser(before, { ...before, unmatchedCommands: "allow" }, none)), /command no rule mentions/);
  assert.equal(policyChangeLooser(before, { ...before }, none), null, "control: no change, nothing looser");
});

/* M8, M9, M10 */
test("POST /api/approvals/categories: a loosening needs confirmLoosening, and nothing is changed under Lockdown", async (t) => {
  const { app, call } = await served(t);
  savePolicy(app.store, app.runtime.owner, { preset: "off" });
  const commands = async () => (await call("GET", "/api/approvals/categories")).body.categories.find((c) => c.id === "commands").decision;
  assert.equal((await call("POST", "/api/approvals/categories", { commands: "deny" })).status, 200, "control: a refusal tightens");
  const loose = await call("POST", "/api/approvals/categories", { commands: "allow" });
  assert.equal(loose.status, 409, loose.text.slice(0, 300));
  assert.match(loose.body.error, /less careful/);
  assert.equal(await commands(), "deny", "an unconfirmed loosening changes nothing");
  assert.equal((await call("POST", "/api/lockdown", { on: true })).status, 200);
  const locked = readPolicy(app.store, app.runtime.owner);
  for (const body of [{ commands: "allow", confirmLoosening: true }, { commands: "deny" }]) {
    const refused = await call("POST", "/api/approvals/categories", body);
    assert.equal(refused.status, 409, refused.text);
    assert.match(refused.body.error, /Lockdown is on/);
  }
  assert.deepEqual(readPolicy(app.store, app.runtime.owner), locked, "Lockdown's policy is untouched");
  assert.equal((await call("POST", "/api/lockdown", { on: false })).status, 200);
  const confirmed = await call("POST", "/api/approvals/categories", { commands: "allow", confirmLoosening: true });
  assert.equal(confirmed.status, 200, confirmed.text.slice(0, 300));
  assert.equal(await commands(), "allow", "control: the owner's yes loosens");
});

/* M11, M12 */
test("the password manager save is written down without secrets, and choosing one keeps the other listed", async (t) => {
  const { app, call } = await served(t);
  const entries = () => app.store.audit.list(app.runtime.owner, { action: "connection.changed" });
  const before = entries().length;
  const saved = await call("POST", "/api/credentials/settings", { enabled: true, services: ["bitwarden", "1password"], bitwardenCommand: "C:/tools/secret-bw-path.exe" });
  assert.equal(saved.status, 200, saved.text);
  assert.equal(entries().length, before + 1, "the save is in the audit record");
  const entry = entries()[0];
  assert.match(`${entry.subject} ${entry.reason}`, /Bitwarden/);
  assert.equal(JSON.stringify(entries()).includes("secret-bw-path"), false, "no command or value is written into the record");
  const chose = await call("POST", "/api/credentials/settings", { choose: "1password" });
  assert.equal(chose.status, 200, chose.text);
  assert.deepEqual(readCredentialSettings(app.store, app.runtime.owner).services, ["1password", "bitwarden"], "1Password first, Bitwarden kept");
  assert.equal(entries().length, before + 2, "a choice is written down too");
  await call("POST", "/api/credentials/settings", { choose: "bitwarden" });
  const back = readCredentialSettings(app.store, app.runtime.owner);
  assert.deepEqual(back.services, ["bitwarden", "1password"], "switching back loses nothing");
  assert.equal(back.bitwardenCommand, "C:/tools/secret-bw-path.exe");
  assert.equal(back.enabled, true, "choosing never touches the switch");
  const both = await call("POST", "/api/credentials/settings", { choose: "bitwarden", services: [] });
  assert.equal(both.status, 400, "a choice and a whole list at once is refused");
});
