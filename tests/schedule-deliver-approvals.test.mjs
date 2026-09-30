/**
 * A schedule that sends its result to a chat sends a message to that chat when it runs. So does a page
 * or screen watch that sends its news to a chat, and the morning brief once the chat it goes to is
 * chosen. So the owner's approval settings weigh each of them under "Message people" as well as
 * "Change settings": it is asked about whenever either kind would ask, refused whenever either
 * refuses, and the question put to the owner stays the call's own. It meets what sending that message
 * now would meet, so a rule about that one chat and a conversation mode that asks before a message is
 * sent count as well. One that sends nowhere (a schedule with no chat, a watch whose news stays in the
 * app, a change to the brief that names no chat) is judged exactly as before. Every model here is a
 * scripted fake and every page a made-up one: nothing is sent, nothing is fetched, and no picture of
 * the screen is taken.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { addPolicyRule, readPolicy, savePolicy } from "../dist/policy.js";
import { mergeCategoryRules } from "../dist/tool-categories.js";
import { saveConversationMode } from "../dist/conversation-mode.js";
import { dryRunPlan } from "../dist/mcp-policy.js";

const chat = { channel: "hand", chatId: "friend-1" };
const dueAt = new Date(Date.now() + 3_600_000).toISOString();
const timed = { prompt: "say the weather", kind: "task", dueAt, deliverTo: chat };
const plain = { prompt: "say the weather", kind: "task", dueAt };
const strictness = ["allow", "ask", "deny"];
const region = { x: 10, y: 20, width: 200, height: 100 };
/** The calls that can name a chat to send to later, each given that chat, or none (null). */
const pointedAt = {
  "monitor.create": (to) => ({ url: "https://example.test/notices", every: "6h", notifyVia: to ?? "activity" }),
  "monitors.screen.create": (to) => ({ label: "The progress bar", region, notifyVia: to ?? "activity" }),
  "brief.configure": (to) => ({ enabled: true, ...(to ? { deliverTo: to } : {}) }),
};
const watchesAndBrief = Object.entries(pointedAt);

async function harness(t, kinds) {
  const root = await mkdtemp(join(tmpdir(), "branch-schedule-deliver-approvals-"));
  const calls = [];
  const provider = { name: "scripted", async complete() {
    const call = calls.shift();
    return call ? { content: "", toolCalls: [call] } : { content: "done", toolCalls: [] };
  } };
  const workspace = join(root, "workspace");
  const app = await createBranch({ workspace, dataDir: join(root, "data"), provider });
  t.after(async () => { await app.close(); await discardTemp(root); });
  // A page watch takes its first look as it is made: at a made-up page, so nothing is fetched.
  const looked = [];
  app.web.fetchPage = async (url) => { looked.push(url); return { text: "The notices today", url }; };
  app.web.search = async (query) => { looked.push(query); return []; };
  /** The owner decides whole kinds at once, as the approval settings screen saves them. */
  const decide = (decisions) => savePolicy(app.store, app.runtime.owner, { rules: mergeCategoryRules(app.registry, [], decisions) });
  decide(kinds);
  let count = 0;
  /** One of the owner's own tasks in which the model makes this one call. */
  const task = (name, args, sessionId) => {
    calls.push({ id: `c${++count}`, name, arguments: JSON.stringify(args) });
    return app.runtime.run({ prompt: "go ahead", ...(sessionId ? { sessionId } : {}) });
  };
  const schedules = () => app.store.list("schedules", app.runtime.owner);
  const status = (run) => app.store.run(run.id).status;
  const watches = () => app.monitors.list(app.runtime.owner);
  const brief = () => app.brief.settings(app.runtime.owner);
  /** What the tools themselves said when they refused, in one task. */
  const failures = (run) => app.store.events(run.id).filter((event) => event.kind === "tool.failed").map((event) => event.data);
  return { app, workspace, decide, task, schedules, status, watches, brief, failures, looked };
}

test("a schedule that sends to a chat gets the stricter of Change settings and Message people; one that sends nowhere, Change settings alone", async (t) => {
  const { app, decide } = await harness(t, {});
  for (const settings of strictness) for (const message of strictness) {
    decide({ settings, message });
    const context = app.runtime.context({});
    const stricter = strictness[Math.max(strictness.indexOf(settings), strictness.indexOf(message))];
    assert.equal(app.runtime.checkPolicy("schedules.create", timed, context).decision, stricter,
      `Change settings ${settings}, Message people ${message}: a schedule that sends to a chat`);
    assert.equal(app.runtime.checkPolicy("schedules.create", plain, context).decision, settings,
      `Change settings ${settings}, Message people ${message}: a schedule that sends nowhere`);
  }
});

test("a rule the owner wrote about one chat counts for a schedule that sends to that chat, and only that chat", async (t) => {
  const { app } = await harness(t, {});
  addPolicyRule(app.store, app.runtime.owner, { tool: "channels.broadcast", match: "hand:friend-1", decision: "deny" });
  const context = app.runtime.context({});
  assert.equal(app.runtime.checkPolicy("channels.broadcast", { text: "hello", to: [chat] }, context).decision, "deny",
    "the control: a message to that chat now is refused");
  const judged = (deliverTo) => app.runtime.checkPolicy("schedules.create", { ...plain, deliverTo }, context).decision;
  assert.equal(judged(chat), "deny", "so is a schedule that would send its result there");
  assert.equal(judged({ channel: "hand", chatId: "friend-2" }), "allow", "a schedule that sends to another chat is not");
});

test("in a conversation on Auto, which asks before a message is sent, a schedule that sends to a chat asks too", async (t) => {
  const { app } = await harness(t, {});
  const run = app.store.createRun(app.runtime.owner, "a conversation on Auto");
  app.store.event(run.id, "run.started", { source: "owner" });
  saveConversationMode(app.store, app.runtime.owner, run.sessionId, { mode: "auto" });
  const context = app.runtime.context({ runId: run.id });
  assert.equal(app.runtime.checkPolicy("channels.broadcast", { text: "hello", to: [chat] }, context).decision, "ask",
    "the control: a message sent now asks");
  assert.equal(app.runtime.checkPolicy("schedules.create", timed, context).decision, "ask", "so does one put on a timer");
  assert.equal(app.runtime.checkPolicy("schedules.create", plain, context).decision, "allow", "a schedule that sends nowhere goes ahead, as before");
});

test("Message people set to ask with Change settings allowed: a schedule that sends to a chat waits for a yes, one that sends nowhere goes ahead", async (t) => {
  const { app, task, schedules, status } = await harness(t, { message: "ask", settings: "allow" });
  const run = await task("schedules.create", timed);
  assert.equal(status(run), "needs_input", "the owner is asked before a message is put on a timer");
  const asked = app.runtime.approvals.questionFor(run.sessionId);
  assert.equal(asked?.tool, "schedules.create", "the question is the schedule's own");
  assert.deepEqual(schedules(), [], "nothing is saved while the question waits");

  const quiet = await task("schedules.create", plain);
  assert.equal(status(quiet), "completed");
  assert.equal(schedules().length, 1, "a schedule that sends nowhere only changes a setting, and goes ahead");
  assert.equal(schedules()[0].data.deliverTo, undefined);
});

test("Message people set to refuse: a schedule that sends to a chat is refused, even where Change settings would only ask", async (t) => {
  const { app, task, schedules } = await harness(t, { message: "deny", settings: "ask" });
  const run = await task("schedules.create", timed);
  assert.equal(app.store.events(run.id).filter((event) => event.kind === "policy.denied").length, 1, "refused, not asked");
  assert.equal(app.runtime.approvals.questionFor(run.sessionId), undefined, "no question waits");
  assert.deepEqual(schedules(), [], "nothing is saved");
});

test("a yes to a schedule that sends to a chat stays that schedule's: it never lets a later message to the chat through", async (t) => {
  const { app, task, schedules, status } = await harness(t, { message: "ask", settings: "allow" });
  const run = await task("schedules.create", timed);
  const asked = app.runtime.approvals.questionFor(run.sessionId);
  assert.equal(asked?.tool, "schedules.create");
  const before = readPolicy(app.store, app.runtime.owner).rules;
  // A schedule names no one target a standing yes could be kept for, so "Always" is refused, and
  // nothing is written: least of all a rule for sending messages.
  assert.throws(() => app.runtime.approve(run.sessionId, "allow", "always", asked.fingerprint), /does not say/);
  assert.deepEqual(readPolicy(app.store, app.runtime.owner).rules, before, "no rule was written");

  app.runtime.approve(run.sessionId, "allow", "session", asked.fingerprint);
  const again = await task("schedules.create", timed, run.sessionId);
  assert.equal(status(again), "completed", "the yes covers the very schedule it was given for");
  assert.equal(schedules().length, 1);
  assert.deepEqual(schedules()[0].data.deliverTo, chat);

  const message = await task("channels.broadcast", { text: "hello", to: [chat] }, run.sessionId);
  assert.equal(status(message), "needs_input", "a message to the same chat now is still asked about");
  assert.equal(app.runtime.approvals.questionFor(run.sessionId)?.tool, "channels.broadcast");
});

test("another AI tool's dry run of a schedule that sends to a chat says what the call itself would meet", async (t) => {
  const { app, workspace } = await harness(t, { message: "deny", settings: "allow" });
  const plan = (args) => dryRunPlan(app.registry, app.store, app.runtime.owner, workspace, { name: "schedules.create", arguments: args });
  const called = (args) => app.runtime.checkPolicy("schedules.create", args, app.runtime.context({ source: "mcp" })).decision;
  assert.equal(called(timed), "deny", "the call itself is refused");
  assert.equal(plan(timed).decision, "deny", "and the dry run says so");
  assert.equal(called(plain), "ask", "a change another AI tool asks for still waits for a yes");
  assert.equal(plan(plain).decision, "ask");
});

/* ---------- a page or screen watch, and the morning brief, that send to a chat ---------- */

test("a watch or the morning brief that sends to a chat gets the stricter of Change settings and Message people; one that sends nowhere, Change settings alone", async (t) => {
  const { app, decide } = await harness(t, {});
  for (const settings of strictness) for (const message of strictness) {
    decide({ settings, message });
    const context = app.runtime.context({});
    const stricter = strictness[Math.max(strictness.indexOf(settings), strictness.indexOf(message))];
    for (const [tool, args] of watchesAndBrief) {
      assert.equal(app.runtime.checkPolicy(tool, args(chat), context).decision, stricter,
        `Change settings ${settings}, Message people ${message}: ${tool} that sends to a chat`);
      assert.equal(app.runtime.checkPolicy(tool, args(null), context).decision, settings,
        `Change settings ${settings}, Message people ${message}: ${tool} that sends nowhere`);
    }
  }
});

test("a rule the owner wrote about one chat counts for a watch or the morning brief that sends to that chat, and only that chat", async (t) => {
  const { app } = await harness(t, {});
  addPolicyRule(app.store, app.runtime.owner, { tool: "channels.broadcast", match: "hand:friend-1", decision: "deny" });
  const context = app.runtime.context({});
  assert.equal(app.runtime.checkPolicy("channels.broadcast", { text: "hello", to: [chat] }, context).decision, "deny",
    "the control: a message to that chat now is refused");
  for (const [tool, args] of watchesAndBrief) {
    const judged = (to) => app.runtime.checkPolicy(tool, args(to), context).decision;
    assert.equal(judged(chat), "deny", `${tool} that would send to that chat is refused too`);
    assert.equal(judged({ channel: "hand", chatId: "friend-2" }), "allow", `${tool} that sends to another chat is not`);
    assert.equal(judged(null), "allow", `${tool} that sends nowhere is not`);
  }
});

test("in a conversation on Auto, which asks before a message is sent, choosing the brief's chat or a screen watch that sends to a chat asks too", async (t) => {
  const { app } = await harness(t, {});
  const run = app.store.createRun(app.runtime.owner, "a conversation on Auto");
  app.store.event(run.id, "run.started", { source: "owner" });
  saveConversationMode(app.store, app.runtime.owner, run.sessionId, { mode: "auto" });
  const context = app.runtime.context({ runId: run.id });
  const judged = (tool, to) => app.runtime.checkPolicy(tool, pointedAt[tool](to), context).decision;
  assert.equal(app.runtime.checkPolicy("channels.broadcast", { text: "hello", to: [chat] }, context).decision, "ask",
    "the control: a message sent now asks");
  assert.equal(judged("brief.configure", chat), "ask", "so does choosing the chat the morning brief goes to");
  assert.equal(judged("brief.configure", null), "allow", "a change to the brief that names no chat goes ahead, as before");
  assert.equal(judged("monitors.screen.create", chat), "ask", "so does a screen watch that sends its news to a chat");
  assert.equal(judged("monitors.screen.create", null), "allow", "one whose news stays in the app goes ahead, as before");
  // A page watch looks at the web, so Auto already asks before one, wherever its news goes.
  assert.equal(judged("monitor.create", chat), "ask");
  assert.equal(judged("monitor.create", null), "ask");
});

test("Message people set to ask with Change settings allowed: a page watch that sends to a chat waits for a yes, one whose news stays in the app goes ahead", async (t) => {
  const { app, task, status, watches, looked } = await harness(t, { message: "ask", settings: "allow" });
  const run = await task("monitor.create", pointedAt["monitor.create"](chat));
  assert.equal(status(run), "needs_input", "the owner is asked before a watch sends its news to a chat");
  assert.equal(app.runtime.approvals.questionFor(run.sessionId)?.tool, "monitor.create", "the question is the watch's own");
  assert.deepEqual(watches(), [], "nothing is saved while the question waits");
  assert.deepEqual(looked, [], "and the page is not looked at");

  const quiet = await task("monitor.create", pointedAt["monitor.create"](null));
  assert.equal(status(quiet), "completed");
  assert.equal(watches().length, 1, "a watch whose news stays in the app only changes a setting, and goes ahead");
  assert.equal(watches()[0].notifyVia, "activity");
});

test("Message people set to ask with Change settings allowed: a screen watch that sends to a chat waits for a yes, one whose news stays in the app goes ahead", async (t) => {
  const { app, task, status, failures } = await harness(t, { message: "ask", settings: "allow" });
  const run = await task("monitors.screen.create", pointedAt["monitors.screen.create"](chat));
  assert.equal(status(run), "needs_input", "the owner is asked before a screen watch sends its news to a chat");
  assert.equal(app.runtime.approvals.questionFor(run.sessionId)?.tool, "monitors.screen.create", "the question is the watch's own");
  assert.deepEqual(failures(run), [], "the watch itself is not reached while the question waits");

  // Watching the screen is switched off here, so no picture is ever taken: a call the rules let
  // through reaches the watch itself, which says so.
  const quiet = await task("monitors.screen.create", pointedAt["monitors.screen.create"](null));
  assert.equal(status(quiet), "completed");
  assert.equal(app.runtime.approvals.questionFor(quiet.sessionId), undefined, "one whose news stays in the app is not asked about");
  assert.match(failures(quiet)[0]?.error ?? "", /switched off/, "it goes ahead, as far as the watch itself");
  assert.deepEqual(app.screenWatches.list(app.runtime.owner), []);
});

test("Message people set to ask with Change settings allowed: choosing the chat the morning brief goes to waits for a yes; a change that names no chat goes ahead", async (t) => {
  const { app, task, status, brief } = await harness(t, { message: "ask", settings: "allow" });
  // The ship-on rule: the brief ships on; the owner switches it off through its own save, so a waiting question can be seen to change nothing.
  assert.equal(brief().enabled, true, "the brief ships on");
  app.brief.configure(app.runtime.owner, { enabled: false });
  assert.equal(brief().enabled, false);
  const run = await task("brief.configure", pointedAt["brief.configure"](chat));
  assert.equal(status(run), "needs_input", "the owner is asked before the brief is pointed at a chat");
  assert.equal(app.runtime.approvals.questionFor(run.sessionId)?.tool, "brief.configure", "the question is the brief's own");
  assert.equal(brief().deliverTo, null, "no chat is chosen while the question waits");
  assert.equal(brief().enabled, false, "and the brief is not switched on");

  const quiet = await task("brief.configure", pointedAt["brief.configure"](null));
  assert.equal(status(quiet), "completed");
  assert.equal(brief().enabled, true, "a change that names no chat only changes a setting, and goes ahead");
  assert.equal(brief().deliverTo, null);
});

test("Message people set to refuse: a page watch that sends to a chat is refused, even where Change settings would only ask", async (t) => {
  const { app, task, watches, looked } = await harness(t, { message: "deny", settings: "ask" });
  const run = await task("monitor.create", pointedAt["monitor.create"](chat));
  assert.equal(app.store.events(run.id).filter((event) => event.kind === "policy.denied").length, 1, "refused, not asked");
  assert.equal(app.runtime.approvals.questionFor(run.sessionId), undefined, "no question waits");
  assert.deepEqual(watches(), [], "nothing is saved");
  assert.deepEqual(looked, [], "and the page is not looked at");
});

test("a yes to a page watch that sends to a chat stays that watch's: it never lets a later message to the chat through", async (t) => {
  const { app, task, status, watches } = await harness(t, { message: "ask", settings: "allow" });
  const paged = pointedAt["monitor.create"](chat);
  const run = await task("monitor.create", paged);
  const asked = app.runtime.approvals.questionFor(run.sessionId);
  assert.equal(asked?.tool, "monitor.create");
  const before = readPolicy(app.store, app.runtime.owner).rules.map((rule) => JSON.stringify(rule));
  // A page watch names the site it looks at, so "Always" keeps a standing yes for watching that site,
  // and nothing else: least of all a rule for sending messages.
  app.runtime.approve(run.sessionId, "allow", "always", asked.fingerprint);
  const written = readPolicy(app.store, app.runtime.owner).rules.filter((rule) => !before.includes(JSON.stringify(rule)));
  assert.deepEqual(written.map((rule) => [rule.tool, rule.match, rule.decision]), [["monitor.create", "example.test", "allow"]],
    "the one rule written is a yes for watching that site");

  const again = await task("monitor.create", paged, run.sessionId);
  assert.equal(status(again), "completed", "the yes covers the very watch it was given for");
  assert.equal(watches().length, 1);
  assert.deepEqual(watches()[0].notifyVia, chat);

  const message = await task("channels.broadcast", { text: "hello", to: [chat] }, run.sessionId);
  assert.equal(status(message), "needs_input", "a message to the same chat now is still asked about");
  assert.equal(app.runtime.approvals.questionFor(run.sessionId)?.tool, "channels.broadcast");

  // With Message people still set to ask, the same watch in another conversation asks again before
  // its news may go to the chat: the standing yes was for watching the site.
  const elsewhere = await task("monitor.create", paged);
  assert.equal(status(elsewhere), "needs_input", "another conversation is asked again");
  assert.equal(app.runtime.approvals.questionFor(elsewhere.sessionId)?.tool, "monitor.create");
});

test("another AI tool's dry run of a watch or the morning brief that sends to a chat says what the call itself would meet", async (t) => {
  const { app, workspace } = await harness(t, { message: "deny", settings: "allow" });
  for (const [tool, args] of watchesAndBrief) {
    const plan = (to) => dryRunPlan(app.registry, app.store, app.runtime.owner, workspace, { name: tool, arguments: args(to) }).decision;
    const called = (to) => app.runtime.checkPolicy(tool, args(to), app.runtime.context({ source: "mcp" })).decision;
    assert.equal(called(chat), "deny", `${tool}: the call itself is refused`);
    assert.equal(plan(chat), "deny", `${tool}: and the dry run says so`);
    assert.equal(called(null), "ask", `${tool}: one that sends nowhere, asked for by another AI tool, still waits for a yes`);
    assert.equal(plan(null), "ask", `${tool}: and the dry run says so`);
  }
});
