import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { chromium } from "playwright";
import { z } from "zod";
import { createBranch, riskSentence, offPlanDifference, commandDifference, relatedCommand, correctionLabel } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { signIn } from "./new-window-places.mjs";
/** Q257: the fingerprint of the question the window shows for a conversation; a bare answer is refused. */
const shownFingerprint = (app, sessionId) => app.runtime.approvals.questionFor(sessionId)?.fingerprint;

const say = (content) => ({ content, toolCalls: [] });
const call = (name, args) => ({ content: "", toolCalls: [{ id: `c${Math.random().toString(36).slice(2, 9)}`, name, arguments: JSON.stringify(args) }] });
const kinds = (app, runId) => app.store.events(runId).map((e) => e.kind);
const data = (app, runId, kind) => app.store.events(runId).filter((e) => e.kind === kind).map((e) => e.data);
const missing = async (path) => { try { await access(path); return false; } catch { return true; } };

/** A provider whose answer is chosen from the system prompt and the last message of the request. */
function scripted(reply) {
  const provider = { name: "scripted", requests: [], async complete(request) {
    provider.requests.push(request);
    const system = request.messages[0].content;
    const user = [...request.messages].reverse().find((m) => m.role === "user")?.content ?? "";
    return reply({ system, user, last: request.messages.at(-1), request });
  } };
  return provider;
}
async function served(t, reply, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-plan-act-"));
  const provider = scripted(reply);
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider, ...options });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const api = async (path, body) => {
    const response = await fetch(`${server.url}/api/${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${server.token}`, origin: server.url, "content-type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const json = await response.json();
    if (!response.ok) throw new Error(json.error);
    return json;
  };
  return { app, provider, api, workspace: join(root, "workspace") };
}
/** A plan the model always answers with: look at a file, then change it. */
const twoStepPlan = '{"steps":[{"title":"Read the notes","touches":"notes.txt","changes":false},{"title":"Write the summary","touches":"summary.txt","changes":true}]}';

test("the two modes: show-plan stores a plan and changes nothing before it is agreed", async (t) => {
  const { app, api, workspace } = await served(t, ({ system, user, last }) => {
    if (/You are planning a task/.test(system)) return say(twoStepPlan);
    if (last?.role === "tool") return say("Summary written.");
    if (/^Step 1 of 2/.test(user)) return say("I read the notes.");
    if (/^Step 2 of 2/.test(user)) return call("files.write", { path: "summary.txt", content: "done" });
    if (/Every step of the plan is done/.test(user)) return say("Read and summarised.");
    return say("Both steps are finished.");
  });
  const chosen = await api("plan-act", { scope: "project", planMode: "show-plan" });
  assert.equal(chosen.project.planMode, "show-plan");
  assert.equal(chosen.effective.autonomy, "at-the-end", "not checking back until the end is the default");

  const asked = await api("run", { prompt: "summarise my notes" });
  assert.equal(asked.status, "needs_input", "the task stops with its plan instead of doing anything");
  assert.match(asked.output, /Here is my plan:\n1\. Read the notes — notes\.txt \(changes nothing\)\n2\. Write the summary — summary\.txt/);
  assert.match(asked.output, /One step changes something: step 2 \(summary\.txt\)/);
  assert.ok(await missing(join(workspace, "summary.txt")), "nothing that changes anything has run");
  assert.ok(!kinds(app, asked.id).includes("tool.started"), "no tool ran before the plan was agreed");

  const stored = (await api(`runs/${asked.id}/plan`)).plan;
  assert.equal(stored.mode, "show-plan");
  assert.equal(stored.approved, false);
  assert.equal(stored.decision, "waiting");
  assert.equal(stored.runId, asked.id, "the plan is stored with the task, not only printed");
  assert.deepEqual(stored.steps.map((s) => [s.title, s.touches, s.changes]),
    [["Read the notes", "notes.txt", false], ["Write the summary", "summary.txt", true]]);
  assert.deepEqual(data(app, asked.id, "plan.awaiting_approval")[0].steps, ["Read the notes", "Write the summary"]);

  const agreed = await api(`runs/${asked.id}/plan`, {});
  assert.equal(agreed.approved, true);
  assert.equal(agreed.decision, "approved");
  const done = await api("run", { prompt: "go ahead", sessionId: asked.sessionId });
  assert.equal(done.status, "completed");
  assert.equal(await readFile(join(workspace, "summary.txt"), "utf8"), "done");
  assert.deepEqual(data(app, done.id, "plan.step.finished").map((d) => [d.step, d.passed]), [[1, true], [2, true]]);
});

test("a plan sent back with a reason is planned again, and the reason reaches the model", async (t) => {
  const { app, api, provider } = await served(t, ({ system }) => {
    if (/You are planning a task/.test(system)) return say(twoStepPlan);
    return say("nothing to do");
  });
  await api("plan-act", { scope: "project", planMode: "show-plan" });
  const asked = await api("run", { prompt: "summarise my notes" });
  assert.equal(asked.status, "needs_input");

  const sent = await api(`runs/${asked.id}/plan`, { decision: "reject", reason: "Do not write any files, just tell me" });
  assert.equal(sent.decision, "waiting", "a new plan is waiting after the old one was sent back");
  assert.equal(sent.approved, false);
  assert.equal(sent.asked.status, "needs_input", "the model was asked again straight away");
  assert.deepEqual(data(app, asked.id, "plan.rejected")[0].reason, "Do not write any files, just tell me");

  const planning = provider.requests.filter((r) => /You are planning a task/.test(r.messages[0].content));
  assert.equal(planning.length, 2, "the model was asked for a plan a second time");
  const second = planning[1].messages.map((m) => m.content).join("\n");
  assert.match(second, /Do not write any files, just tell me/, "the reason reaches the model");
  assert.match(second, /They sent the plan back because/);
  assert.match(second, /1\. Read the notes/, "so does the plan they turned down");
});

test("a step whose wording the owner changed is the wording that runs", async (t) => {
  const { app, api } = await served(t, ({ system, user }) => {
    if (/You are planning a task/.test(system)) return say('{"steps":[{"title":"Email everyone","changes":true}]}');
    if (/^Step 1 of 1/.test(user)) return say(`I did: ${user.split(": ")[1]}`);
    return say("Finished.");
  });
  await api("plan-act", { scope: "project", planMode: "show-plan" });
  const asked = await api("run", { prompt: "tell the team" });
  const agreed = await api(`runs/${asked.id}/plan`, { steps: [{ title: "Email only Ada" }] });
  assert.deepEqual(agreed.steps.map((s) => s.title), ["Email only Ada"]);
  assert.equal(data(app, asked.id, "plan.approved")[0].edited, true);

  const done = await api("run", { prompt: "go ahead", sessionId: asked.sessionId });
  assert.equal(done.status, "completed");
  assert.deepEqual(data(app, done.id, "plan.step.started").map((d) => d.title), ["Email only Ada"]);
  assert.ok(!JSON.stringify(data(app, done.id, "plan.step.started")).includes("Email everyone"),
    "the wording first shown is gone; only what was agreed runs");
});

test("a step that needs something the plan did not mention stops and names the difference", async (t) => {
  const { app, api, workspace } = await served(t, ({ system, user }) => {
    if (/You are planning a task/.test(system)) return say('{"steps":[{"title":"Read the notes","touches":"notes.txt","changes":false}]}');
    if (/^Step 1 of 1/.test(user)) return call("files.write", { path: "notes.txt", content: "rewritten" });
    return say("Done.");
  });
  await api("plan-act", { scope: "project", planMode: "show-plan" });
  const asked = await api("run", { prompt: "read my notes" });
  await api(`runs/${asked.id}/plan`, {});
  const stopped = await api("run", { prompt: "go ahead", sessionId: asked.sessionId });
  assert.equal(stopped.status, "needs_input");
  assert.match(stopped.output, /step 1 of the plan you agreed said it would only look at notes\.txt and change nothing/);
  assert.match(stopped.output, /which the plan did not mention/);
  assert.ok(await missing(join(workspace, "notes.txt")), "it did not quietly do it anyway");
  const difference = data(app, stopped.id, "plan.off_plan")[0];
  assert.equal(difference.step, 1);
  assert.match(difference.difference, /change nothing/);

  // The plan the owner is halfway through survives the task stopping to ask about it.
  const kept = (await api(`runs/${asked.id}/plan`)).plan;
  assert.equal(kept.approved, true, "the agreed plan is still there to carry on with");
  assert.equal(kept.waitingOnOwner, true);
});

test("an ordinary approval in the middle of a plan does not throw the rest of the plan away", async (t) => {
  const { app, api, workspace } = await served(t, ({ system, user, last }) => {
    if (/You are planning a task/.test(system)) return say('{"steps":[{"title":"Write the first note","touches":"one.txt","changes":true},{"title":"Write the second note","touches":"two.txt","changes":true}]}');
    if (last?.role === "tool") return say("Written.");
    if (/^Step 1 of 2/.test(user)) return call("files.write", { path: "one.txt", content: "one" });
    if (/^Step 2 of 2/.test(user)) return call("files.write", { path: "two.txt", content: "two" });
    return say("Both notes are written.");
  });
  await api("policy", { preset: "ask-before-changes" });
  await api("plan-act", { scope: "project", planMode: "show-plan" });
  const asked = await api("run", { prompt: "write two notes" });
  await api(`runs/${asked.id}/plan`, {});

  const stopped = await api("run", { prompt: "go ahead", sessionId: asked.sessionId });
  assert.equal(stopped.status, "needs_input", "the approval rule stops it, as it always has");
  assert.match(stopped.output, /Before I go ahead/);
  const kept = (await api(`runs/${asked.id}/plan`)).plan;
  assert.equal(kept.approved, true, "the agreed plan is still there");
  assert.equal(kept.current, 0, "and it is still on the step it stopped in");

  // Each note is a different file, so each is a question of its own: that is the approval rule
  // doing its job. What matters here is that the plan survives both of them.
  await api("policy/approve", { sessionId: asked.sessionId, fingerprint: shownFingerprint(app, asked.sessionId), decision: "allow", remember: "session" });
  const second = await api("run", { prompt: "go ahead", sessionId: asked.sessionId });
  assert.equal(await readFile(join(workspace, "one.txt"), "utf8"), "one");
  assert.equal(second.status, "needs_input", "the second note is a second question");
  assert.deepEqual(data(app, second.id, "plan.step.started").map((d) => d.step), [1, 2],
    "the step it stopped inside is done again from its start, and then it moves on");
  await api("policy/approve", { sessionId: asked.sessionId, fingerprint: shownFingerprint(app, asked.sessionId), decision: "allow", remember: "session" });
  const done = await api("run", { prompt: "go ahead", sessionId: asked.sessionId });
  assert.equal(done.status, "completed", "the rest of the plan is picked up after the answers");
  assert.equal(await readFile(join(workspace, "two.txt"), "utf8"), "two");
  // A step the task stopped inside is begun again, so what it had already done it would do again.
  // Here nothing had: the question came before the write, which is where an approval always comes.
  const writes = [stopped.id, second.id, done.id].flatMap((id) => data(app, id, "tool.completed"))
    .filter((event) => event.name === "files.write").length;
  assert.equal(writes, 2, "each note was written exactly once, though step 1 was begun twice");
  assert.deepEqual(data(app, second.id, "plan.step.started").map((d) => d.begunBefore ?? false), [true, false],
    "the step it stopped inside knows it had already begun");
  assert.equal(app.runtime.orchestration.plan(asked.sessionId), undefined, "the finished plan is cleared");
});

test("each autonomy setting stops where it should", async (t) => {
  const plan = '{"steps":[{"title":"Look it up","changes":false},{"title":"Write it down","changes":true}]}';
  const reply = ({ system, user }) => {
    if (/You are planning a task/.test(system)) return say(plan);
    if (/^Step 1 of 2/.test(user)) return say("Looked it up.");
    if (/^Step 2 of 2/.test(user)) return say("Wrote it down.");
    return say("Both done.");
  };
  for (const [autonomy, stopsBeforeStepTwo] of [["at-the-end", false], ["changes-only", true], ["every-step", true]]) {
    const { app, api } = await served(t, reply);
    await api("plan-act", { scope: "project", planMode: "show-plan", autonomy });
    const asked = await api("run", { prompt: `plan with ${autonomy}` });
    const agreed = await api(`runs/${asked.id}/plan`, {});
    assert.equal(agreed.autonomy, autonomy, "the plan carries the setting it was agreed under");
    const first = await api("run", { prompt: "go ahead", sessionId: asked.sessionId });
    if (!stopsBeforeStepTwo) {
      assert.equal(first.status, "completed", `${autonomy} runs the whole plan`);
      assert.deepEqual(data(app, first.id, "plan.step.started").map((d) => d.step), [1, 2]);
      continue;
    }
    assert.equal(first.status, "needs_input", `${autonomy} stops before the step that changes something`);
    assert.match(first.output, /Step 2 of 2 is next: Write it down/);
    assert.deepEqual(data(app, first.id, "plan.check_back").map((d) => d.step), [2]);
    const second = await api("run", { prompt: "go ahead", sessionId: asked.sessionId });
    assert.equal(second.status, "completed", `${autonomy} carries on from exactly there`);
    assert.deepEqual(data(app, second.id, "plan.step.started").map((d) => d.step), [2]);
  }
});

test('"check with me before every step" also stops before a step that changes nothing', async (t) => {
  const { app, api } = await served(t, ({ system, user }) => {
    if (/You are planning a task/.test(system)) return say('{"steps":[{"title":"Look here","changes":false},{"title":"Look there","changes":false}]}');
    if (/^Step \d of 2/.test(user)) return say("Looked.");
    return say("Both done.");
  });
  await api("plan-act", { scope: "project", planMode: "show-plan", autonomy: "every-step" });
  const asked = await api("run", { prompt: "have a look around" });
  assert.match(asked.output, /Nothing in this plan changes anything/, "the card says so in one sentence");
  await api(`runs/${asked.id}/plan`, {});
  const first = await api("run", { prompt: "go ahead", sessionId: asked.sessionId });
  assert.equal(first.status, "needs_input");
  assert.deepEqual(data(app, first.id, "plan.check_back").map((d) => d.step), [2]);

  // The same plan under "changes-only" would not have stopped: nothing in it changes anything.
  await api("plan-act", { scope: "project", autonomy: "changes-only" });
  const carried = await api("run", { prompt: "go ahead", sessionId: asked.sessionId });
  assert.equal(carried.status, "completed", "the plan keeps the setting it was agreed under");
});

test("the record of what was allowed carries the plan, the answer and who gave it", async (t) => {
  const { app, api } = await served(t, ({ system }) => {
    if (/You are planning a task/.test(system)) return say(twoStepPlan);
    return say("ok");
  });
  await api("plan-act", { scope: "project", planMode: "show-plan", autonomy: "changes-only" });
  const asked = await api("run", { prompt: "summarise my notes" });
  await api(`runs/${asked.id}/plan`, {});
  const owner = app.runtime.owner;
  const agreed = app.store.audit.list(owner).find((entry) => entry.subject.startsWith("the plan for"));
  assert.ok(agreed, "agreeing a plan is written down");
  assert.equal(agreed.outcome, "allowed");
  assert.equal(agreed.actor, owner, "who gave the answer");
  assert.equal(agreed.runId, asked.id, "against the task it was given for");
  assert.match(agreed.reason, /1\. Read the notes; 2\. Write the summary/, "the plan itself");
  assert.match(agreed.reason, /Check with me before steps that change something/, "and how far it may go");
  const decided = data(app, asked.id, "plan.decided")[0];
  assert.equal(decided.decision, "approved");
  assert.equal(decided.autonomy, "changes-only");
  assert.deepEqual(decided.steps, ["Read the notes", "Write the summary"]);

  const sentBack = await api("run", { prompt: "and again please", sessionId: asked.sessionId });
  assert.equal(sentBack.status, "needs_input");
  await api(`runs/${sentBack.id}/plan`, { decision: "reject", reason: "too many steps" });
  const refused = app.store.audit.list(owner).find((entry) => entry.outcome === "refused" && entry.subject.startsWith("the plan for"));
  assert.ok(refused, "sending a plan back is written down too");
  assert.match(refused.reason, /Plan sent back: too many steps/);
});

test('"Just do it" is exactly what it always was', async (t) => {
  const { app, api, workspace } = await served(t, ({ last }) => {
    if (last?.role === "tool") return say("I wrote the file.");
    return call("files.write", { path: "summary.txt", content: "done" });
  });
  const state = await api("plan-act");
  assert.equal(state.effective.planMode, "just-do-it", "and it is the default");
  const run = await api("run", { prompt: "write the summary" });
  assert.equal(run.status, "completed");
  assert.equal(run.output, "I wrote the file.");
  assert.equal(await readFile(join(workspace, "summary.txt"), "utf8"), "done");
  assert.ok(!kinds(app, run.id).some((k) => k.startsWith("plan.")), "no plan, no card, no waiting");
  assert.equal(app.runtime.orchestration.plan(run.sessionId), undefined);

  // One conversation can be set apart from the project without changing the project.
  const set = await api("plan-act", { sessionId: run.sessionId, planMode: "show-plan" });
  assert.equal(set.effective.planMode, "show-plan");
  assert.equal(set.effective.fromConversation, true);
  assert.equal(set.project.planMode, "just-do-it", "the project is untouched");
  const back = await api("plan-act", { sessionId: run.sessionId, followProject: true });
  assert.equal(back.effective.planMode, "just-do-it");
  assert.equal(back.effective.fromConversation, false);
});

test("a command that failed is not retried silently: both commands and the difference are shown", async (t) => {
  let ran = 0;
  const { app, api } = await served(t, ({ last }) => {
    if (!last || last.role !== "tool") return call("shell.execute", { executable: "git", args: ["stauts"], cwd: "." });
    return call("shell.execute", { executable: "git", args: ["status"], cwd: "." });
  });
  app.registry.register({
    name: "shell.execute", permission: "shell.execute", description: "Run a command, for this test.",
    parameters: z.object({ executable: z.string(), args: z.array(z.string()), cwd: z.string() }).strict(),
    execute: () => { ran += 1; return { exitCode: 1, stdout: "", stderr: "git: 'stauts' is not a git command" }; },
  });
  // Even with the rules letting commands straight through, a second try is offered, not made.
  await api("policy", { unmatchedCommands: "allow", confirmLoosening: true }); // Q257: a loosening needs the owner's yes
  const stopped = await api("run", { prompt: "check the repository" });
  assert.equal(stopped.status, "needs_input", "the corrected command is offered, not simply run");
  assert.match(stopped.output, /"git stauts" did not work, so this would run "git status" instead/);
  assert.match(stopped.output, /the same command without stauts and with status/);
  assert.equal(ran, 1, "only the command that failed ever ran");
  const offered = data(app, stopped.id, "command.correction")[0];
  assert.equal(offered.failed, "git stauts");
  assert.equal(offered.proposed, "git status");
  assert.equal(offered.difference, "the same command without stauts and with status");
});

test("a command that did not work is offered corrected, with the difference shown", async (t) => {
  assert.equal(relatedCommand(["git", "stauts"], ["git", "status"]), true);
  assert.equal(relatedCommand(["git", "status"], ["npm", "status"]), false, "a different program is a different job");
  assert.equal(commandDifference(["git", "stauts"], ["git", "status"]), "the same command without stauts and with status");
  assert.equal(commandDifference(["git", "status"], ["git", "status"]), "exactly the same command again");
  assert.match(correctionLabel(["git", "stauts"], ["git", "status"]),
    /"git stauts" did not work, so this would run "git status" instead — the same command without stauts and with status/);
});

test("the switch is in the conversation, and the plan card approves in one press", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-plan-act-ui-"));
  const provider = scripted(({ system, user }) => {
    if (/You are planning a task/.test(system)) return say(twoStepPlan);
    if (/^Step \d of 2/.test(user)) return say("Done that.");
    return say("All finished.");
  });
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const httpCall = (path, body) => fetch(new URL(path, server.url), {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).then((response) => response.json());
  await httpCall("/api/onboarding", { done: true });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await signIn(page, server);
  // Redesign: the choice lives in the conversation's mode chip (data-act="modemenu2"), "Plan first" (prototype.html PMODES:
  // "Writes a plan and waits for your OK before doing anything"), and the plan is drawn in the conversation as the
  // prototype's plan block (ul.plan, prototype.html:3014). The old More menu and #session-plan-mode are replaced.
  await page.locator('[data-act="modemenu2"]').click();
  await page.locator('.pop [data-act="set-mode"][data-v="plan"]').click();
  await page.locator("#prompt").fill("summarise my notes");
  await page.locator("#send").click();
  // WINDOW BUG: public/app/chat/chat.js thread() draws only policy asks; a task waiting on its plan (run needs_input under
  // Plan first) shows nothing in the conversation, so the plan can be neither read nor agreed.
  const plan = page.locator("#conversation ul.plan");
  await plan.waitFor({ state: "visible", timeout: 30000 });
  assert.deepEqual((await plan.locator("li").allInnerTexts()).map((one) => one.trim()), ["Read the notes", "Write the summary"]);
  // The OK is given in the conversation (the engine's go-ahead from a chat message, tested below).
  await page.locator("#prompt").fill("go ahead");
  await page.locator("#send").click();
  await page.locator("#conversation").getByText("All finished.").waitFor({ timeout: 30000 });
  assert.deepEqual(errors, []);
});

test("the plain sentences the owner reads say what is risky and what is off the plan", async () => {
  assert.equal(riskSentence([{ title: "Look", changes: false }, { title: "Look again", changes: false }]),
    "Nothing in this plan changes anything: every step only looks things up.");
  assert.equal(riskSentence([{ title: "Read", changes: false }, { title: "Send", touches: "the mailing list", changes: true }]),
    "One step changes something: step 2 (the mailing list). Nothing else in the plan changes anything.");
  assert.match(riskSentence([{ title: "Send", changes: true }, { title: "Delete", changes: true }]),
    /^2 steps change something: step 1 \(Send\), step 2 \(Delete\)/);
  // A step that does not say whether it changes anything is taken to change something.
  assert.match(riskSentence([{ title: "Do a thing" }]), /^One step changes something/);
  assert.equal(offPlanDifference({ title: "Read", touches: "notes.txt", changes: false }, 1,
    { label: "Read a file", target: "notes.txt", readOnly: true }), null, "looking at things is never off the plan");
  assert.equal(offPlanDifference({ title: "Send", changes: true }, 2,
    { label: "Write a file", target: "a.txt", readOnly: false }), null, "a step that said it changes things may");
  assert.match(offPlanDifference({ title: "Read", touches: "notes.txt", changes: false }, 1,
    { label: "Write a file", target: "notes.txt", readOnly: false }) ?? "", /but to carry on it now needs to write a file/);
});

/**
 * mac7/smoke-fixes (B5). The smoke test found a `branch run --plan` task that made a plan, showed
 * nobody, changed a file and finished. The cause was not the headless run: it was that `--plan`
 * alone is "work out a plan, then do it", and the conversation's switch had never been saved. These
 * three hold the promise in docs/features.md — nothing that changes anything until you say yes.
 */
test("with nobody to ask, Plan mode finishes with the plan and changes nothing", async (t) => {
  const { app, api, workspace } = await served(t, ({ system, user, last }) => {
    if (/You are planning a task/.test(system)) return say(twoStepPlan);
    if (last?.role === "tool") return say("Summary written.");
    if (/^Step 1 of 2/.test(user)) return say("I read the notes.");
    if (/^Step 2 of 2/.test(user)) return call("files.write", { path: "summary.txt", content: "done" });
    if (/Every step of the plan is done/.test(user)) return say("Read and summarised.");
    return say("Both steps are finished.");
  });
  await api("plan-act", { scope: "project", planMode: "show-plan" });

  // A script's own `branch run`: nobody is at a terminal to be asked.
  const run = await app.runtime.run({ prompt: "summarise my notes", unattended: true });
  assert.equal(run.status, "completed", "the plan is the answer, not a question nobody can answer");
  assert.match(run.output, /Here is my plan:\n1\. Read the notes/);
  assert.match(run.output, /Nothing has been done\./);
  assert.match(run.output, /"go ahead" in this conversation will carry it out/);
  assert.ok(await missing(join(workspace, "summary.txt")), "nothing that changes anything has run");
  assert.ok(!kinds(app, run.id).includes("tool.started"), "no tool ran");
  assert.ok(!kinds(app, run.id).includes("attention.needed"), "nobody was asked, so nothing waits on an answer");
  assert.ok(kinds(app, run.id).includes("plan.answered_with_plan"));

  // The plan is kept, so the owner can agree to it whenever they next look.
  const stored = app.runtime.orchestration.plan(run.sessionId);
  assert.equal(stored.approved, false);
  assert.equal(stored.decision, "waiting");
  const agreed = await api("run", { prompt: "go ahead", sessionId: run.sessionId });
  assert.equal(agreed.status, "completed");
  assert.equal(await readFile(join(workspace, "summary.txt"), "utf8"), "done");
});

test("the Plan chip: it shows the plan and waits, and finishes with it when nobody can be asked", async (t) => {
  const { app, api, workspace } = await served(t, ({ system, user, last }) => {
    if (/You are planning a task/.test(system)) return say(twoStepPlan);
    if (last?.role === "tool") return say("Summary written.");
    if (/^Step \d of 2/.test(user)) return say("Step done.");
    return say("Finished.");
  });
  const first = await api("run", { prompt: "hello" });
  await api("conversation-mode", { sessionId: first.sessionId, mode: "plan" });
  assert.equal((await api(`plan-act?sessionId=${first.sessionId}`)).effective.planMode, "show-plan",
    "the Plan chip is the same switch");

  // Someone at the window: the plan is shown and the task waits, as it does for the switch itself.
  const asked = await api("run", { prompt: "summarise my notes", sessionId: first.sessionId });
  assert.equal(asked.status, "needs_input", asked.output);
  assert.match(asked.output, /Here is my plan:\n1\. Read the notes/, "the plan, not a refusal");
  assert.ok(kinds(app, asked.id).includes("plan.awaiting_approval"));
  assert.ok(await missing(join(workspace, "summary.txt")));

  // A script, a schedule or a trigger in the same conversation: the plan is the answer instead.
  const run = await app.runtime.run({ prompt: "summarise my notes", sessionId: first.sessionId, unattended: true });
  assert.equal(run.status, "completed");
  assert.match(run.output, /Here is my plan:/);
  assert.match(run.output, /Nothing has been done\./);
  assert.ok(await missing(join(workspace, "summary.txt")));
  assert.ok(!kinds(app, run.id).includes("tool.started"));
});

test("a plan-act choice that names neither a conversation nor the project is refused, not dropped", async (t) => {
  const { api } = await served(t, () => say("hello"));
  await assert.rejects(() => api("plan-act", { planMode: "show-plan", autonomy: "changes-only" }),
    /Say which conversation this choice is for, or send scope "project"/);
  // And the setting really is untouched, which is what the silent version hid.
  assert.equal((await api("plan-act")).project.planMode, "just-do-it");
});

/**
 * mac7/smoke-fixes (integration review, B5). The builder reused `nobodyToAsk` from the tests
 * question, which counts a chat app — so Plan mode from a chat finished with its plan and told the
 * person who had just written "there was nobody to say yes while this task ran". A chat person is a
 * person: the chat is handed a `needs_input` answer as the words it is (src/channels/router.ts
 * `finishTurn`), the conversation is written down against that chat, and "go ahead" there picks the
 * plan up. So Plan mode from a chat shows the plan and waits, as it does in the window.
 */
test("Plan mode from a chat message shows the plan and waits, and the chat's go-ahead carries it out", async (t) => {
  const { app, api, workspace } = await served(t, ({ system, user, last }) => {
    if (/You are planning a task/.test(system)) return say(twoStepPlan);
    if (last?.role === "tool") return say("Summary written.");
    if (/^Step 1 of 2/.test(user)) return say("I read the notes.");
    if (/^Step 2 of 2/.test(user)) return call("files.write", { path: "summary.txt", content: "done" });
    if (/Every step of the plan is done/.test(user)) return say("Read and summarised.");
    return say("Both steps are finished.");
  });
  await api("plan-act", { scope: "project", planMode: "show-plan" });

  const asked = await app.runtime.run({ prompt: "summarise my notes", source: "channel" });
  assert.equal(asked.status, "needs_input", asked.output);
  assert.match(asked.output, /Here is my plan:\n1\. Read the notes/, "the plan goes back to the chat");
  assert.doesNotMatch(asked.output, /nobody to say yes/, "somebody is there: the person who wrote the message");
  assert.ok(kinds(app, asked.id).includes("plan.awaiting_approval"));
  assert.ok(!kinds(app, asked.id).includes("plan.answered_with_plan"), "a chat is not nobody");
  assert.ok(!kinds(app, asked.id).includes("tool.started"), "nothing has run while it waits");
  assert.ok(await missing(join(workspace, "summary.txt")));

  // The same chat, in the same conversation: "go ahead" is not a dead end. The plan is picked up and
  // worked through — and the step that changes something stops and asks, because a task a chat
  // started is held at "Ask before changes" however it is carried on (0.18.1). That is what makes
  // waiting here safe: the chat person may agree to the plan, and still cannot change a file alone.
  const agreed = await app.runtime.run({ prompt: "go ahead", sessionId: asked.sessionId, source: "channel" });
  assert.ok(kinds(app, agreed.id).includes("plan.step.started"), "the plan was picked up, not dropped");
  assert.equal(agreed.status, "needs_input", agreed.output);
  assert.match(agreed.output, /Before I go ahead: Writing summary\.txt/);
  assert.ok(await missing(join(workspace, "summary.txt")), "still nothing changed until the owner says yes");

  // A schedule is still nobody: nobody is sitting there when it runs, so it finishes with the plan.
  const scheduled = await app.runtime.run({ prompt: "summarise my notes", source: "schedule" });
  assert.equal(scheduled.status, "completed");
  assert.ok(kinds(app, scheduled.id).includes("plan.answered_with_plan"));
  assert.match(scheduled.output, /Nothing has been done\./);
});
