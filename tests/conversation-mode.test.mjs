/* Redesign phase 1: how much the assistant may do, picked per conversation in the message box.
   Enforced in the runtime's own policy check, not only on the screen: these drive real tasks and the
   real check a model's tool call goes through. */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, evaluatePolicy, PolicySchema, presetRules, savePolicy } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { heldMode, modeChoices, policyForMode, readConversationMode } from "../dist/conversation-mode.js";
import { sessionPlanAct } from "../dist/plan-act.js";

const off = PolicySchema.parse({});
const decide = (policy, tool, readOnly = false, resource) => evaluatePolicy(policy, { tool, target: "x", readOnly, resource }).decision;

test("each mode says what it means, even when the owner's setting is No approvals", () => {
  const ask = policyForMode(off, "ask"), plan = policyForMode(off, "plan"), auto = policyForMode(off, "auto"), full = policyForMode(off, "full");
  assert.equal(decide(off, "files.write"), "allow", "No approvals writes without asking");
  assert.equal(decide(ask, "files.write"), "ask", "Ask first asks before a write");
  assert.equal(decide(ask, "shell.execute"), "ask");
  assert.equal(decide(ask, "files.read", true), "allow", "and reading stays free");
  assert.equal(decide(plan, "files.write"), "deny", "Plan refuses a change outright");
  assert.equal(decide(plan, "shell.execute"), "deny");
  assert.equal(decide(plan, "files.read", true), "allow", "Plan still reads");
  assert.equal(decide(auto, "files.write"), "allow", "Auto writes in the workspace");
  assert.equal(decide(auto, "shell.execute"), "ask", "Auto asks before a command");
  assert.equal(decide(auto, "web.fetch"), "ask", "and before the web");
  assert.equal(decide(full, "files.write"), "allow");
  assert.equal(decide(full, "shell.execute"), "allow", "Full Access does not ask again about an uncovered command");
});

test("Full Access lets uncovered commands through while named command rules and Lockdown still apply", () => {
  const policy = PolicySchema.parse({ preset: "custom", unmatchedCommands: "ask", rules: [
    { tool: "shell.execute", match: "git push*", decision: "ask" },
    { tool: "shell.execute", match: "rm *", decision: "deny" },
  ] });
  const command = (held, target) => evaluatePolicy(held, { tool: "shell.execute", target, readOnly: false }).decision;
  const full = policyForMode(policy, "full");
  assert.equal(command(full, "node scripts/review.mjs"), "allow");
  assert.equal(command(full, "git push origin branch/change"), "ask");
  assert.equal(command(full, "rm important.txt"), "deny");
  assert.equal(policyForMode(policy, "full", true).unmatchedCommands, "ask", "Lockdown keeps the command fallback unchanged");
  assert.equal(policy.unmatchedCommands, "ask", "the saved policy and other conversations stay scoped");
  for (const mode of ["ask", "plan", "auto"]) assert.notEqual(command(policyForMode(policy, mode), "node scripts/review.mjs"), "allow");
});

test("a mode never lifts a refusal the owner wrote, and Ask first and Plan drop every yes", () => {
  const owner = PolicySchema.parse({ preset: "custom", rules: [
    { tool: "files.write", match: "secrets/*", decision: "deny" },
    { tool: "files.*", match: "*", decision: "allow" },
  ] });
  const at = (policy, target) => evaluatePolicy(policy, { tool: "files.write", target, readOnly: false }).decision;
  assert.equal(at(policyForMode(owner, "full"), "secrets/a"), "deny", "Full access keeps the owner's refusal");
  assert.equal(at(policyForMode(owner, "ask"), "notes/a"), "ask", "Ask first does not keep a broad yes");
  assert.equal(at(policyForMode(owner, "plan"), "notes/a"), "deny");
  const strict = PolicySchema.parse({ preset: "ask-before-changes", rules: presetRules("ask-before-changes") });
  assert.equal(decide(policyForMode(strict, "full"), "files.write"), "allow", "the owner may loosen one conversation");
});

test("somebody other than the owner never gets a mode looser than the owner's setting; Lockdown greys the loose ones", () => {
  assert.equal(heldMode({ mode: "full", planSet: false }, "ask-before-changes", false), null, "a person's Full access is ignored");
  assert.equal(heldMode({ mode: "plan", planSet: true }, "ask-before-changes", false), "plan", "but they may be stricter");
  assert.equal(heldMode({ mode: "full", planSet: false }, "ask-before-changes", true), "full");
  const locked = modeChoices("off", { locked: true, owner: true });
  assert.deepEqual(locked.filter((choice) => !choice.available).map((choice) => choice.mode), ["auto", "full"]);
  assert.match(locked.find((choice) => choice.mode === "full").why, /Lockdown is on/);
  const person = modeChoices("ask-before-changes", { locked: false, owner: false });
  assert.deepEqual(person.filter((choice) => !choice.available).map((choice) => choice.mode), ["auto", "full"]);
  const lockedPolicy = PolicySchema.parse({ preset: "custom", rules: [{ tool: "*", match: "*", applies: "any", decision: "ask", remember: "never" }] });
  assert.equal(decide(policyForMode(lockedPolicy, "full", true), "files.write"), "ask", "under Lockdown Full access is still asked");
  assert.equal(decide(policyForMode(lockedPolicy, "plan", true), "files.write"), "deny", "and Plan can only tighten it");
});

async function fixture(t, script) {
  const root = await mkdtemp(join(tmpdir(), "branch-conversation-mode-"));
  const provider = { name: "scripted", turn: 0, async complete(request) {
    provider.turn += 1;
    const asked = [...request.messages].reverse().find((m) => m.role === "user")?.content ?? "";
    return script(provider.turn, String(asked));
  } };
  const app = await createBranch({ dataDir: join(root, "data"), workspace: join(root, "ws"), provider });
  t.after(async () => { await app.close(); await discardTemp(root); });
  app.testRoot = root;
  return app;
}
/** A model that writes a file on its first turn of each task, then says it is done. */
const writes = (file) => (turn) => turn % 2 === 1
  ? { content: "", toolCalls: [{ id: `c${turn}`, name: "files.write", arguments: JSON.stringify({ path: file, content: "x" }) }] }
  : { content: "done", toolCalls: [] };

test("an Ask first conversation asks before a write even when the owner's setting is No approvals", async (t) => {
  const app = await fixture(t, writes("a.txt"));
  const asked = await app.runtime.run({ prompt: "write it", conversationMode: "ask" });
  assert.equal(asked.status, "needs_input", "the write waits for a yes");
  assert.equal(existsSync(join(app.runtime.workspace, "a.txt")), false);
  assert.equal(readConversationMode(app.store, app.runtime.owner, asked.sessionId).mode, "ask");
  const context = app.runtime.context({ runId: asked.id });
  assert.equal(app.runtime.checkPolicy("shell.execute", { executable: "git", args: ["status"] }, context).decision, "ask",
    "and before a command");
  savePolicy(app.store, app.runtime.owner, { unmatchedCommands: "allow" });
  assert.equal(app.runtime.checkPolicy("shell.execute", { executable: "git", args: ["status"] }, context).decision, "ask",
    "even with commands let through by the owner's setting");
  const other = await fixture(t, writes("b.txt"));
  const before = await other.runtime.run({ prompt: "write it" });
  assert.equal(before.status, "completed", "a conversation with no mode behaves exactly as before");
  assert.equal(readConversationMode(other.store, other.runtime.owner, before.sessionId), null);
});

test("a Plan conversation refuses changes and shows the plan first", async (t) => {
  const app = await fixture(t, writes("plan.txt"));
  const run = await app.runtime.run({ prompt: "write it", conversationMode: "plan" });
  assert.equal(existsSync(join(app.runtime.workspace, "plan.txt")), false, "nothing was written");
  const context = app.runtime.context({ runId: run.id });
  assert.equal(app.runtime.checkPolicy("files.write", { path: "plan.txt", content: "x" }, context).decision, "deny");
  assert.equal(app.runtime.checkPolicy("files.read", { path: "plan.txt" }, context).decision, "allow", "reading is free");
  const planAct = sessionPlanAct(app.store, app.runtime.owner, run.sessionId, app.store.projects.active(app.runtime.owner).id);
  assert.equal(planAct.planMode, "show-plan", "Plan means Show me the plan first");
});

test("a task from a chat app is held to Ask first in a Full access conversation", async (t) => {
  const app = await fixture(t, writes("c.txt"));
  const first = await app.runtime.run({ prompt: "write it", conversationMode: "full" });
  assert.equal(first.status, "completed", "the owner's own task in Full access goes ahead");
  assert.equal(app.runtime.checkPolicy("shell.execute", { executable: "git", args: ["status"] }, app.runtime.context({ runId: first.id })).decision,
    "allow", "the actual owner task does not ask again about an uncovered local command");
  const outside = await app.runtime.run({ prompt: "write it again", sessionId: first.sessionId, source: "channel" });
  assert.equal(outside.status, "needs_input", "the 0.18.1 hold on outside tasks still stands");
  assert.equal(app.runtime.checkPolicy("shell.execute", { executable: "git", args: ["status"] }, app.runtime.context({ runId: outside.id })).decision,
    "ask", "the outside task cannot inherit the owner's uncovered-command authorization");
});

async function served(t, script = writes("d.txt")) {
  const app = await fixture(t, script);
  const server = await startServer(app, { dataDir: join(app.testRoot, "data"), port: 0 });
  t.after(() => server.close());
  const call = async (path, body) => {
    const response = await fetch(new URL(path, server.url), { method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  return { app, server, call };
}

test("the window's new conversation starts in the mode picked, and each change is checked", async (t) => {
  const { app, call } = await served(t);
  const fresh = await call("/api/conversation-mode");
  assert.equal(fresh.body.newConversation, "ask", "a new conversation starts on Ask first");
  assert.equal(fresh.body.following.preset, "off");
  const run = (await call("/api/run", { prompt: "write it", mode: "plan" })).body;
  assert.equal((await call(`/api/conversation-mode?sessionId=${run.sessionId}`)).body.mode, "plan");
  const picked = await call("/api/conversation-mode", { sessionId: run.sessionId, mode: "auto" });
  assert.equal(picked.status, 200);
  assert.equal(picked.body.mode, "auto");
  const planAct = sessionPlanAct(app.store, app.runtime.owner, run.sessionId, app.store.projects.active(app.runtime.owner).id);
  assert.equal(planAct.planMode, "just-do-it", "leaving Plan leaves the plan-first switch too");
  await call("/api/lockdown", { on: true });
  const locked = await call("/api/conversation-mode", { sessionId: run.sessionId, mode: "full" });
  assert.equal(locked.status, 403, "Lockdown refuses a looser mode");
  assert.match(locked.body.error, /Lockdown/);
  assert.equal((await call("/api/conversation-mode", { sessionId: run.sessionId, mode: "ask" })).status, 200, "a stricter one is fine");
  await call("/api/lockdown", { on: false });
  assert.equal((await call("/api/conversation-mode", { sessionId: run.sessionId, mode: null })).body.mode, null, "and it can follow the setting again");
});

test("a household person may not pick a mode looser than the owner's setting", async (t) => {
  const { app, call } = await served(t);
  savePolicy(app.store, app.runtime.owner, { preset: "ask-before-changes" });
  const person = app.store.profiles.create({ name: "Sam", pin: "1234" });
  app.store.profiles.switch({ profileId: person.id, pin: "1234" });
  const run = (await call("/api/run", { prompt: "hello" })).body;
  const choices = (await call(`/api/conversation-mode?sessionId=${run.sessionId}`)).body.choices;
  assert.deepEqual(choices.filter((c) => !c.available).map((c) => c.mode), ["auto", "full"]);
  const refused = await call("/api/conversation-mode", { sessionId: run.sessionId, mode: "full" });
  assert.equal(refused.status, 403);
  assert.match(refused.body.error, /Only the owner/);
  app.store.profiles.switch({ profileId: null });
});

test("agreeing a plan in a Plan conversation lets it act, asking first", async (t) => {
  const { planAgreed } = await import("../dist/conversation-mode-api.js");
  const app = await fixture(t, writes("e.txt"));
  const run = await app.runtime.run({ prompt: "write it", conversationMode: "plan" });
  planAgreed(app, run.sessionId);
  assert.equal(readConversationMode(app.store, app.runtime.owner, run.sessionId).mode, "ask");
  const planAct = sessionPlanAct(app.store, app.runtime.owner, run.sessionId, app.store.projects.active(app.runtime.owner).id);
  assert.equal(planAct.planMode, "just-do-it");
  const context = app.runtime.context({ runId: run.id });
  assert.equal(app.runtime.checkPolicy("files.write", { path: "e.txt", content: "x" }, context).decision, "ask");
});

/* ---------------------------------------------------------------- the chip in the window */

async function windowFixture(t, script = () => ({ content: "Done.", toolCalls: [] }), route = null) {
  const { chromium } = await import("playwright");
  const { app, server, call } = await served(t, script);
  await call("/api/onboarding", { done: true });
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 }, serviceWorkers: "block" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  if (route) await route(page);
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  return { app, server, call, page, errors };
}

/* Redesign: the new window (public/app/chat/chips.js). The mode chip is data-act="modemenu2" in the message box; its menu
   (#app > .pop) is the prototype's POPS.modemenu2: Auto, Ask first, Plan first, Full access (data-act="set-mode"), then
   "Applies to" and the Lockdown switch (#pm-lock2). */
const modeChip = (page) => page.locator('#composer [data-act="modemenu2"]');
const chipSays = (page, words) => page.waitForFunction((w) => document.querySelector('#composer [data-act="modemenu2"]')?.textContent.trim() === w, words, { timeout: 10000 });
const openSession = async (page, id) => {
  await page.locator(`#side [data-act="chat"][data-id="${id}"]`).click();
  await page.waitForFunction((sid) => document.querySelector('#side [data-act="chat"][aria-current="true"]')?.dataset.id === sid, id, { timeout: 20000 });
  await page.waitForTimeout(600); // the chips read the open conversation's mode after it is drawn
};

/* Redesign: the prototype's menu has no warning before Full access (POPS.modemenu2 'set-mode' sets it at once) and no arrow
   keys inside the menu (its rows carry 1–4); both are replaced by the new window. Checked last, so the menu is still
   exercised: that the conversation was started on Ask first. */
test("the chip starts a new conversation on Ask first, and its menu asks before giving full access", async (t) => {
  const f = await windowFixture(t);
  const chip = modeChip(f.page);
  await chipSays(f.page, "Ask first");
  await f.page.locator("#prompt").fill("Tidy my notes");
  await f.page.locator("#send").click();
  await f.page.locator("#conversation .b .txt").first().waitFor({ timeout: 30000 });
  await f.page.waitForFunction(() => !document.getElementById("send").disabled);
  const sessionId = await f.page.locator('#side [data-act="chat"][aria-current="true"]').getAttribute("data-id");
  const startedOn = readConversationMode(f.app.store, f.app.runtime.owner, sessionId)?.mode ?? null;
  await chip.click();
  const menu = f.page.locator("#app > .pop");
  await menu.waitFor({ state: "visible" });
  assert.deepEqual((await menu.locator('[data-act="set-mode"] .mi-t').allInnerTexts()).map((x) => x.trim()), ["Auto", "Ask first", "Plan first", "Full access"]);
  await menu.locator('[data-act="set-mode"][data-v="full"]').click();
  await chipSays(f.page, "Full access");
  assert.equal(readConversationMode(f.app.store, f.app.runtime.owner, sessionId).mode, "full");
  await chip.click();
  await menu.waitFor({ state: "visible" });
  await chip.click();
  await menu.waitFor({ state: "hidden" });
  assert.deepEqual(f.errors, []);
  assert.equal(startedOn, "ask", "the conversation was started on Ask first");
});

/* Redesign: under Lockdown the prototype's menu greys every mode (POPS.modemenu2: disabled when S.locked) and the chip says
   Lockdown; the reason in a title and Plan staying pickable are the old menu's (replaced by the new window). */
test("under Lockdown the looser modes are greyed with the reason, not hidden, and cannot be picked", async (t) => {
  const f = await windowFixture(t);
  await f.call("/api/lockdown", { on: true });
  await f.page.reload();
  await f.page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  await chipSays(f.page, "Lockdown");
  await modeChip(f.page).click();
  const menu = f.page.locator("#app > .pop");
  await menu.waitFor({ state: "visible" });
  const full = menu.locator('[data-act="set-mode"][data-v="full"]');
  assert.equal(await full.isVisible(), true, "not hidden");
  assert.equal(await full.isDisabled(), true);
  assert.equal(await menu.locator('[data-act="set-mode"][data-v="auto"]').isDisabled(), true);
  await full.click({ force: true });
  await f.page.waitForTimeout(500);
  assert.equal((await f.call("/api/conversation-mode")).body.newConversation, "ask", "a greyed choice does nothing");
  await f.call("/api/lockdown", { on: false });
  assert.deepEqual(f.errors, []);
});

/* Redesign: the new card (public/app/chat/chat.js askCard) is the action's verb (once), "Always allow" and "Don’t allow";
   its "for this conversation" answer is replaced by the new window (not in the design's card). */
test("Q59: a question in an Ask first conversation offers no standing yes on its card", async (t) => {
  const f = await windowFixture(t, writes("asked.txt"));
  await f.page.locator("#prompt").fill("write it");
  await f.page.locator("#send").click();
  const card = f.page.locator("#live-ask");
  await card.waitFor({ state: "visible", timeout: 30000 });
  const answers = await card.locator(".acts > button").evaluateAll((buttons) => buttons.map((b) => ({ text: b.textContent.trim(), live: b.getAttribute("aria-disabled") !== "true" && !b.disabled, pri: b.classList.contains("pri") })));
  assert.ok(answers.some((a) => a.pri && a.live), JSON.stringify(answers));
  assert.equal(answers.some((a) => /^Always allow/.test(a.text) && a.live), false, "Ask first reads no standing yes, so none is offered");
  const sessionId = (await f.call("/api/policy")).body.waiting[0].sessionId;
  assert.equal(readConversationMode(f.app.store, f.app.runtime.owner, sessionId).mode, "ask", "control: the conversation is on Ask first");
  assert.deepEqual(f.errors, []);
});

/* Redesign: the new chip has no "Following your setting" title (replaced by the new window); what stays is that it never
   claims a mode that does not hold: a conversation from before follows the owner's No approvals, so it is not Ask first. */
test("a conversation from before keeps following the owner's setting, and says so", async (t) => {
  const f = await windowFixture(t);
  const old = (await f.call("/api/run", { prompt: "an older conversation" })).body;
  await f.page.reload();
  await f.page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  await openSession(f.page, old.sessionId);
  assert.doesNotMatch((await modeChip(f.page).innerText()).trim(), /^Ask first$/, "the chip does not claim Ask first for a conversation that never asks");
  assert.equal(readConversationMode(f.app.store, f.app.runtime.owner, old.sessionId), null, "looking changed nothing");
  assert.deepEqual(f.errors, []);
});

test("the owner can have new conversations follow the setting instead, and only the owner", async (t) => {
  const { app, call } = await served(t);
  assert.equal((await call("/api/conversation-mode")).body.settings.newConversation, "ask", "Ask first is the default");
  assert.equal((await call("/api/conversation-mode/settings", { newConversation: "follow", confirmLoosening: true })).body.settings.newConversation, "follow");
  assert.equal((await call("/api/conversation-mode")).body.newConversation, null, "the window then starts conversations on the setting");
  const person = app.store.profiles.create({ name: "Sam", pin: "1234" });
  app.store.profiles.switch({ profileId: person.id, pin: "1234" });
  const refused = await call("/api/conversation-mode/settings", { newConversation: "ask" });
  assert.ok([400, 403].includes(refused.status), `a household person is refused (${refused.status})`);
  app.store.profiles.switch({ profileId: null });
});

test("in the window, a new conversation on Ask first stops before its first write, though the setting is No approvals", async (t) => {
  const f = await windowFixture(t, (turn, asked) => (asked.includes("note") && turn % 2 === 1
    ? { content: "", toolCalls: [{ id: `w${turn}`, name: "files.write", arguments: JSON.stringify({ path: "note.txt", content: "hi" }) }] }
    : { content: "Written.", toolCalls: [] }));
  await f.page.locator("#prompt").fill("write a note for me");
  await f.page.locator("#send").click();
  await f.page.locator("#live-ask").waitFor({ state: "visible", timeout: 20000 });
  assert.match(await f.page.locator("#live-ask").innerText(), /note\.txt/);
  assert.equal(existsSync(join(f.app.runtime.workspace, "note.txt")), false, "nothing written before the yes");
  assert.deepEqual(f.errors, []);
});

/* The window reads what new conversations start on (GET /api/conversation-mode) after it draws; a first message sent
   before that answer came started a conversation with no mode, which then followed the owner's No approvals. The read
   is held back here so the message is sent first; the conversation must still start on Ask first. */
test("in the window, a first message sent before the mode was read still starts on Ask first", async (t) => {
  const f = await windowFixture(t, (turn, asked) => (asked.includes("note") && turn % 2 === 1
    ? { content: "", toolCalls: [{ id: `w${turn}`, name: "files.write", arguments: JSON.stringify({ path: "note.txt", content: "hi" }) }] }
    : { content: "Written.", toolCalls: [] }), (page) => page.route(/\/api\/conversation-mode(\?|$)/, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 2500));
    await route.continue();
  }));
  await f.page.locator("#prompt").fill("write a note for me");
  await f.page.locator("#send").click();
  await f.page.locator("#live-ask").waitFor({ state: "visible", timeout: 20000 });
  assert.equal(existsSync(join(f.app.runtime.workspace, "note.txt")), false, "nothing written before the yes");
  const started = (await f.call("/api/sessions?limit=5")).body.sessions?.[0]?.sessionId;
  assert.equal(readConversationMode(f.app.store, f.app.runtime.owner, started)?.mode, "ask", "the conversation holds Ask first");
  assert.deepEqual(f.errors, []);
});

/* And when that read fails outright, the first message starts the conversation on Ask first, never on No approvals. */
test("in the window, a first message sent when the mode cannot be read starts on Ask first", async (t) => {
  const f = await windowFixture(t, (turn, asked) => (asked.includes("note") && turn % 2 === 1
    ? { content: "", toolCalls: [{ id: `w${turn}`, name: "files.write", arguments: JSON.stringify({ path: "note.txt", content: "hi" }) }] }
    : { content: "Written.", toolCalls: [] }), (page) => page.route(/\/api\/conversation-mode(\?|$)/, (route) => route.abort()));
  await f.page.locator("#prompt").fill("write a note for me");
  await f.page.locator("#send").click();
  await f.page.locator("#live-ask").waitFor({ state: "visible", timeout: 20000 });
  assert.equal(existsSync(join(f.app.runtime.workspace, "note.txt")), false, "nothing written before the yes");
  const started = (await f.call("/api/sessions?limit=5")).body.sessions?.[0]?.sessionId;
  assert.equal(readConversationMode(f.app.store, f.app.runtime.owner, started)?.mode, "ask", "the conversation holds Ask first");
});

/** The body of each POST /api/run the window sends, as it sends it. */
const runsSent = (page) => {
  const sent = [];
  page.on("request", (request) => { if (request.method() === "POST" && new URL(request.url()).pathname === "/api/run") sent.push(request.postDataJSON()); });
  return sent;
};

/* Under Lockdown the window's first message says what the conversation starts on (Ask first), so it does not follow the
   owner's own setting once Lockdown ends. The owner's setting here is "follow", which Lockdown cannot start on. */
test("in the window, a first message under Lockdown starts the conversation on Ask first, which it keeps after", async (t) => {
  const f = await windowFixture(t);
  assert.equal((await f.call("/api/conversation-mode/settings", { newConversation: "follow", confirmLoosening: true })).status, 200);
  assert.equal((await f.call("/api/lockdown", { on: true })).status, 200);
  await f.page.reload();
  await f.page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  const sent = runsSent(f.page);
  await f.page.locator("#prompt").fill("hello there");
  await f.page.locator("#send").click();
  for (let tries = 0; tries < 100 && !sent.length; tries++) await f.page.waitForTimeout(50);
  assert.equal(sent[0]?.mode, "ask", "the first message names Ask first");
  const started = (await f.call("/api/sessions?limit=5")).body.sessions?.[0]?.sessionId;
  assert.equal((await f.call("/api/lockdown", { on: false })).status, 200);
  assert.equal(readConversationMode(f.app.store, f.app.runtime.owner, started)?.mode, "ask", "and keeps it once Lockdown is off");
});

/* Setup's "Have Branch suggest Trunks" starts a conversation of its own; its first message carries what new conversations
   start on, exactly as the message box's does (public/app/flows/setup.js propose, public/app/chat/chips.js). */
test("in the window, setup's Trunk suggestions start their conversation on what new conversations start on", async (t) => {
  const f = await windowFixture(t);
  assert.equal((await f.call("/api/onboarding", { trust: true, step: "trunks" })).status, 200);
  await f.page.reload();
  await f.page.locator("#ob-life").waitFor({ timeout: 60000 });
  const sent = runsSent(f.page);
  await f.page.locator("#ob-life").fill("I run a small bakery");
  await f.page.locator('[data-act="ob-propose"]').click();
  for (let tries = 0; tries < 100 && !sent.length; tries++) await f.page.waitForTimeout(50);
  assert.equal(sent[0]?.temporary, true, "control: this is setup's own conversation");
  assert.equal(sent[0]?.mode, "ask", "it starts on Ask first, as new conversations do");
});

/* ---------------------------------------------------------------- integration review */

/** A model that calls `files.write` on `file` when the newest message asks to write, and says done after any tool result. */
async function writerFixture(t, file) {
  const root = await mkdtemp(join(tmpdir(), "branch-conversation-mode-"));
  const provider = { name: "scripted", async complete(request) {
    const last = request.messages[request.messages.length - 1];
    const asked = String([...request.messages].reverse().find((m) => m.role === "user")?.content ?? "");
    if (last?.role === "tool" || !/write/i.test(asked)) return { content: "done", toolCalls: [] };
    return { content: "", toolCalls: [{ id: `w${Math.random().toString(36).slice(2, 8)}`, name: "files.write",
      arguments: JSON.stringify({ path: file, content: "x" }) }] };
  } };
  const app = await createBranch({ dataDir: join(root, "data"), workspace: join(root, "ws"), provider });
  t.after(async () => { await app.close(); await discardTemp(root); });
  app.testRoot = root;
  return app;
}

test("integration review: a helper started in an Ask first conversation is held to that conversation, not the owner's No approvals", async (t) => {
  const app = await writerFixture(t, "helper.txt");
  const parent = await app.runtime.run({ prompt: "hello", conversationMode: "ask" });
  assert.equal(parent.status, "completed");
  const context = app.runtime.context({ runId: parent.id });
  const child = await app.runtime.delegate("write the helper file", context, [...context.permissions], "");
  assert.notEqual(child.sessionId, parent.sessionId, "a helper works in a conversation of its own");
  assert.equal(existsSync(join(app.runtime.workspace, "helper.txt")), false, "the helper did not write without a yes");
  const childContext = app.runtime.context({ runId: child.id });
  assert.equal(app.runtime.checkPolicy("files.write", { path: "helper.txt", content: "x" }, childContext).decision, "ask");
  const { pickConversationMode } = await import("../dist/conversation-mode-api.js");
  pickConversationMode(app, parent.sessionId, "plan");
  assert.equal(app.runtime.checkPolicy("files.write", { path: "helper.txt", content: "x" }, childContext).decision, "deny",
    "and it follows the conversation when the mode changes");
});

test("integration review: a short-lived key's task never gets a mode looser than the owner's setting", async (t) => {
  const { underShortLivedKey } = await import("../dist/key-context.js");
  const { modeRefusal } = await import("../dist/conversation-mode-api.js");
  const app = await writerFixture(t, "key.txt");
  savePolicy(app.store, app.runtime.owner, { preset: "ask-before-changes" });
  const owners = await app.runtime.run({ prompt: "hello", conversationMode: "full" });
  const byKey = await underShortLivedKey(() => app.runtime.run({ prompt: "write it", sessionId: owners.sessionId }));
  assert.equal(byKey.status, "needs_input", "the key's task asks, as the owner's setting says");
  assert.equal(existsSync(join(app.runtime.workspace, "key.txt")), false);
  assert.match(underShortLivedKey(() => modeRefusal(app, "full")) ?? "", /Only the owner/, "and the key cannot start a Full access conversation");
  assert.equal(underShortLivedKey(() => modeRefusal(app, "plan")), null, "a stricter one is fine");
  const own = await app.runtime.run({ prompt: "write it", sessionId: owners.sessionId });
  assert.equal(own.status, "completed", "the owner's own task in the same conversation still has Full access");
  assert.equal(existsSync(join(app.runtime.workspace, "key.txt")), true);
});

test("integration review: a new conversation's mode sent with the message is checked like the chip", async (t) => {
  const { app, call } = await served(t, () => ({ content: "done", toolCalls: [] }));
  await call("/api/lockdown", { on: true });
  const locked = await call("/api/run", { prompt: "hello", mode: "full" });
  assert.equal(locked.status, 403, "Lockdown refuses Full access at the start too");
  assert.match(locked.body.error, /Lockdown/);
  assert.equal((await call("/api/run", { prompt: "hello", mode: "plan" })).status, 200, "Plan may start under Lockdown");
  await call("/api/lockdown", { on: false });
  savePolicy(app.store, app.runtime.owner, { preset: "ask-before-changes" });
  const owners = (await call("/api/run", { prompt: "the owner's", mode: "full" })).body;
  const person = app.store.profiles.create({ name: "Sam", pin: "1234" });
  app.store.profiles.switch({ profileId: person.id, pin: "1234" });
  const refused = await call("/api/run", { prompt: "hello", mode: "full" });
  assert.equal(refused.status, 403, "a household person cannot start a conversation looser than the owner's setting");
  const other = await call("/api/conversation-mode", { sessionId: owners.sessionId, mode: "plan" });
  assert.equal(other.status, 404, "nor pick a mode for the owner's conversation");
  app.store.profiles.switch({ profileId: null });
  assert.equal(readConversationMode(app.store, app.runtime.owner, owners.sessionId).mode, "full", "which kept its own");
});

test("integration review: a Plan conversation refuses changes for tasks from other programs too", async (t) => {
  const app = await writerFixture(t, "outside.txt");
  const plan = await app.runtime.run({ prompt: "hello", conversationMode: "plan" });
  for (const source of ["a2a", "acp", "mcp", "schedule", "trigger", "channel"]) {
    const run = await app.runtime.run({ prompt: "write it", sessionId: plan.sessionId, source });
    assert.notEqual(run.status, "needs_input", `${source}: a change is refused, not asked about`);
    assert.ok(app.store.events(run.id).some((event) => event.kind === "policy.denied"), `${source}: refused`);
    assert.equal(existsSync(join(app.runtime.workspace, "outside.txt")), false);
  }
});

test("integration review: Auto writes inside the workspace and never outside it", async (t) => {
  const inside = await writerFixture(t, "in.txt");
  const done = await inside.runtime.run({ prompt: "write it", conversationMode: "auto" });
  assert.equal(done.status, "completed");
  assert.equal(existsSync(join(inside.runtime.workspace, "in.txt")), true, "inside the workspace it goes ahead");
  const probe = await writerFixture(t, "x");
  const outside = join(probe.testRoot, "not-the-workspace.txt");
  const app = await writerFixture(t, outside);
  const run = await app.runtime.run({ prompt: "write it", conversationMode: "auto" });
  assert.equal(existsSync(outside), false, `Auto never writes outside the workspace (${run.status})`);
  const escaped = await writerFixture(t, "../escaped.txt");
  await escaped.runtime.run({ prompt: "write it", conversationMode: "auto" });
  assert.equal(existsSync(join(escaped.testRoot, "escaped.txt")), false, "not by climbing out either");
});

test("integration review: switching the mode takes effect at the next tool call and changes nothing already done", async (t) => {
  const { pickConversationMode } = await import("../dist/conversation-mode-api.js");
  const app = await writerFixture(t, "first.txt");
  const run = await app.runtime.run({ prompt: "write it", conversationMode: "full" });
  assert.equal(run.status, "completed");
  assert.equal(existsSync(join(app.runtime.workspace, "first.txt")), true);
  const context = app.runtime.context({ runId: run.id });
  const check = () => app.runtime.checkPolicy("files.write", { path: "second.txt", content: "x" }, context).decision;
  assert.equal(check(), "allow");
  pickConversationMode(app, run.sessionId, "ask");
  assert.equal(check(), "ask", "the next call asks");
  pickConversationMode(app, run.sessionId, "plan");
  assert.equal(check(), "deny", "the next call is refused");
  assert.equal(existsSync(join(app.runtime.workspace, "first.txt")), true, "what was done before stays done");
});

/* ------------- "Let Branch run this project's tests?" (mac7/coding-next) in each mode ------------- */

async function testsProject(t, answers) {
  let at = 0;
  const app = await fixture(t, () => answers[Math.min(at++, answers.length - 1)]);
  const { mkdir, writeFile } = await import("node:fs/promises");
  await mkdir(join(app.runtime.workspace, "test"), { recursive: true });
  await writeFile(join(app.runtime.workspace, "package.json"), JSON.stringify({ name: "p", type: "module" }));
  await writeFile(join(app.runtime.workspace, "test", "a.test.mjs"), 'import test from "node:test";\ntest("adds", () => {});\n');
  return app;
}
const checkCall = { content: "", toolCalls: [{ id: "k1", name: "code.check", arguments: "{}" }] };
const doneCall = { content: "done", toolCalls: [] };
const questions = (app, run) => app.store.events(run.id).filter((event) => event.kind === "policy.ask");
const testsRan = (app, run) => app.store.events(run.id).some((event) => event.kind === "code.check");

test("integration review: Plan never runs a project's tests and never asks", async (t) => {
  /* Plan first asks the model for a plan (the first answer), then the task may only read. */
  const app = await testsProject(t, [checkCall, checkCall, doneCall]);
  const run = await app.runtime.run({ prompt: "check it", conversationMode: "plan" });
  assert.equal(questions(app, run).length, 0, "no question");
  assert.equal(testsRan(app, run), false, "no tests");
  assert.ok(app.store.events(run.id).some((event) => event.kind === "policy.denied"));
});

test("integration review: Ask first asks before the tests run", async (t) => {
  const app = await testsProject(t, [checkCall, doneCall]);
  const run = await app.runtime.run({ prompt: "check it", conversationMode: "ask" });
  assert.equal(run.status, "needs_input");
  assert.equal(testsRan(app, run), false);
  assert.equal(questions(app, run).length, 1);
});

test("integration review: Auto and Full access still ask once per folder; a plain yes is Once; Always is kept per folder", async (t) => {
  const { readPolicy } = await import("../dist/policy.js");
  for (const mode of ["auto", "full"]) {
    const app = await testsProject(t, [checkCall, checkCall, doneCall, checkCall, checkCall, doneCall]);
    const first = await app.runtime.run({ prompt: "check it", conversationMode: mode });
    assert.equal(first.status, "needs_input", `${mode}: asked`);
    const [question] = questions(app, first);
    assert.equal(question.data.kind, "project-tests", `${mode}: the tests question itself, not a broad one`);
    assert.equal(question.data.remember, "never", `${mode}: a plain yes is Once`);
    assert.equal(testsRan(app, first), false);
    app.runtime.approve(first.sessionId, "allow", question.data.remember);
    assert.equal(readPolicy(app.store, app.runtime.owner).rules.some((rule) => rule.tool === "code.tests"), false,
      `${mode}: a plain yes writes no rule`);
    const second = await app.runtime.run({ prompt: "carry on", sessionId: first.sessionId });
    assert.equal(testsRan(app, second), true, `${mode}: Once runs them`);
    const third = await app.runtime.run({ prompt: "again", sessionId: first.sessionId });
    assert.equal(third.status, "needs_input", `${mode}: and then asks again`);
    app.runtime.approve(first.sessionId, "allow", "always");
    assert.ok(readPolicy(app.store, app.runtime.owner).rules.some((rule) => rule.tool === "code.tests" && rule.decision === "allow"),
      `${mode}: Always for this folder is written down`);
  }
});

/* Redesign: the chip says what really holds; its "came from outside" title and the menu's note are not in the prototype
   (replaced by the new window). */
test("a conversation carried on from outside says why it asks first, and how to work without being asked", async (t) => {
  const f = await windowFixture(t);
  // mac7/outside-review: a trigger's conversation, set to Full access, still asks before every change.
  const trigger = await f.app.runtime.run({ prompt: "hello", source: "trigger" });
  await f.call("/api/conversation-mode", { sessionId: trigger.sessionId, mode: "full" });
  const mine = (await f.call("/api/run", { prompt: "mine" })).body;
  await f.call("/api/conversation-mode", { sessionId: mine.sessionId, mode: "full" });
  await f.page.reload();
  await f.page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  await openSession(f.page, trigger.sessionId);
  assert.equal((await modeChip(f.page).innerText()).trim(), "Ask first", "the chip says what really holds");
  // The owner's own conversation says what was picked.
  await openSession(f.page, mine.sessionId);
  assert.equal((await modeChip(f.page).innerText()).trim(), "Full access");
  assert.deepEqual(f.errors, []);
});
