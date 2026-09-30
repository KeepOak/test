/**
 * Pass 18a, the window's side of DESIGN-DIRECTION PRs 4 and 5 (public/app/chat/helpframe.js): the helpers frame above the
 * message box and the view-only helper conversation, driven headless against a scripted model whose helpers hold
 * mid-work until the test lets them go (as tests/helpers-steer-stop.test.mjs does). No provider.
 *
 * - The frame shows while helpers work, one row each, and goes once none does (the thread's chip then reads done).
 * - Stop on one helper stops that helper only; its sibling and the task that started it carry on.
 * - Steer on one helper reaches that helper only.
 * - Open shows a helper's own record view only: no message box, nothing can be sent, one way back.
 * - QA Q048: once none works, the thread's chip says how each ended ("1 done, 1 stopped"), never "done" for all.
 * - QA Q049: the question before handing out work names the helpers ("Start 2 helpers: alpha and beta"), not ids.
 * - Helpers' conversations never join the sidebar (GET /api/sessions), and a household person at the window sees
 *   none of the owner's helpers: they are neither read, listed, stopped nor steered for them. A household person's own
 *   helpers are handed back with their task, so they are theirs to read afterwards and never the owner's.
 * - QA Q048 (the background pill): a helper is its parent's work, never counted on its own; a task that ended is counted
 *   by how it ended ("1 done, 1 stopped").
 * - QA Q049 (the question's card): each helper's job in plain words (the engine's `jobs`), not the raw request.
 *
 * Mutation notes (each turns this file red; each was tried):
 * - helpframe.js helpFrame: draw the frame whatever the helpers' status (drop `if (!now.length) return ""`) and it never goes.
 * - helpframe.js stop: cancel frameRun() instead of the helper's own run and the parent stops too.
 * - helpframe.js steer: steer frameRun() instead of the helper and the note reaches the parent, not the helper.
 * - chat.js draw: draw composer() in the view-only branch and the message box is there.
 * - helpers.js howTheyStand: return t("window.chat.helpers.done") for every ended list and the stopped one reads done.
 * - src/runtime.ts checkPolicy: drop the specialistName resolver and the question names no helper.
 * - src/session-library.ts notEngineOnly: drop the run.started parentRunId clause and helpers join the sidebar.
 * - src/server.ts GET /api/runs/:id/steps: drop the `run.owner !== profiles.scope()` refusal and the household person
 *   reads the owner's helpers.
 * - src/collab-server.ts runForCurrentPerson: drop the helpers' hand-back and the household person's own helpers stay
 *   the owner's (she reads none of them, he reads them all).
 * - src/collab-server.ts helperSessions: drop the "made only of her helpers" filter and a conversation holding the owner's
 *   task is handed to her.
 * - chat/bg.js poll: count helpers (drop the parentRunId skip) and the pill reads "3 in the background"; count every
 *   ended task as finished (HOW → "done") and the stopped one reads finished.
 * - src/runtime.ts checkPolicy: drop `jobs: this.cardJobs(...)`, or chat.js requestBody: ignore q.jobs, and the card shows
 *   the raw request.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { signIn } from "./new-window-places.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { readPolicy, savePolicy } from "../dist/policy.js";

const say = (content) => ({ content, toolCalls: [] });
const call = (name, args) => ({ content: "", toolCalls: [{ id: `c${Math.random().toString(36).slice(2, 9)}`, name, arguments: JSON.stringify(args) }] });
const until = async (check, tries = 400) => { for (let i = 0; i < tries && !(await check()); i++) await new Promise((r) => setTimeout(r, 25)); return check(); };
/* Branch's mascot in every form a face can take: its pictures and loops, its figure, the mark. */
const MASCOT = '.hf18a :is(img[src^="/art/branch-"], video[src^="/art/anim-"], [data-m17^="/art/branch-"], .mark-face, .av.brand)';
const text = (request) => request.messages.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n");

/* The parent fans out to the helpers named; each helper reads a note, then works (held until let go or stopped). */
function scripted(holder) {
  const gates = new Map(), requests = { parent: [] };
  const provider = { name: "scripted", async complete(request) {
    const system = String(request.messages[0]?.content ?? "");
    const who = /You are the (\w+)\./.exec(system)?.[1];
    if (!who) {
      requests.parent.push(request);
      if (request.messages.at(-1).role === "tool") return say("The helpers answered.");
      return call("delegate.parallel", { tasks: holder.fanTo.map((specialist, i) => ({ specialist, prompt: `job ${i + 1}: look at the invoices` })) });
    }
    if (/^say ready/.test(String(request.messages.find((m) => m.role === "user")?.content ?? ""))) return say("ready");
    (requests[who] ??= []).push(request);
    const round = request.messages.filter((m) => m.role === "tool").length + 1; // each helper's own rounds, whoever's it is
    if (round === 1) return call("files.read", { path: "notes.txt" });
    if (round === 2) {
      await new Promise((resolve, reject) => {
        gates.set(who, resolve);
        request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true });
      });
      return call("files.read", { path: "notes.txt" });
    }
    return say(`${who} is done`);
  } };
  return { provider, gates, requests };
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-helpers-frame-"));
  const holder = { fanTo: [] }, model = scripted(holder);
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: model.provider });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  await writeFile(join(app.runtime.workspace, "notes.txt"), "the invoices");
  const api = async (path, body) => {
    const response = await fetch(`${server.url}/api/${path}`, { method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  await api("onboarding", { done: true });
  await api("deployment/suggestion", { id: "updates", answer: "never" });
  const specialist = async (name) => {
    const context = app.runtime.context();
    const proposed = await app.registry.execute("specialists.propose", {
      name, instructions: `You are the ${name}.`, permissions: ["files.read"],
      evaluation: { prompt: "say ready", checks: [{ path: `${name}.txt`, expected: "ready" }] },
    }, context);
    await writeFile(join(app.runtime.workspace, `${name}.txt`), "ready");
    await app.registry.execute("specialists.evaluate", { id: proposed.id }, context);
    await app.registry.execute("specialists.promote", { id: proposed.id }, context);
    return proposed.id;
  };
  const ids = [await specialist("alpha"), await specialist("beta")];
  /** Starts a task fanning out to both helpers and waits until each is held mid-work. */
  const fanOut = async (prompt = "compare the invoices", sessionId) => {
    holder.fanTo = ids;
    model.gates.clear();
    for (const who of Object.keys(model.requests)) if (who !== "parent") delete model.requests[who];
    const done = app.runtime.run({ prompt, permissions: [...app.runtime.context().permissions], ...(sessionId ? { sessionId } : {}) });
    assert.ok(await until(() => model.gates.has("alpha") && model.gates.has("beta")), "control: both helpers are working");
    const parent = app.store.runs(app.store.profiles.scope()).find((r) => r.prompt === prompt);
    const helpers = (await api(`runs/${parent.id}/steps`)).body.helpers;
    const byName = { alpha: helpers.find((h) => h.job.startsWith("job 1:")), beta: helpers.find((h) => h.job.startsWith("job 2:")) };
    return { done, parent, byName };
  };
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 950 }, serviceWorkers: "block" })).newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await signIn(page, server);
  const openChat = async (sessionId) => {
    await page.evaluate((id) => { location.hash = "open=" + id; }, sessionId);
    await page.waitForFunction((id) => document.querySelector('#side .list [data-act="chat"][aria-current="true"]')?.dataset.id === id, sessionId, { timeout: 15000 });
  };
  const releaseAll = () => { for (const release of model.gates.values()) release(); };
  return { app, api, page, errors, fanOut, openChat, releaseAll, holder, ids, ...model };
}

test("the frame shows while helpers work, one row each, and goes once none does", async (t) => {
  const { page, errors, fanOut, openChat, releaseAll } = await fixture(t);
  const { done, parent, byName } = await fanOut();
  await openChat(parent.sessionId);
  await page.locator(".dock > .hf18a").waitFor({ timeout: 15000 });
  await page.waitForFunction(() => document.querySelectorAll(".hf18a .hfr18a [data-act='hfstop18a']").length === 2, null, { timeout: 15000 });
  const rows = await page.locator(".hf18a .hfr18a").allInnerTexts();
  for (const h of Object.values(byName)) assert.ok(rows.some((r) => r.includes(h.name)), `a row for ${h.name}: ${JSON.stringify(rows)}`);
  assert.match(await page.locator(".hfh18a").innerText(), /2 helpers/);
  // Each face acts out the helper's own state (working), never its parent's "needs you" (copper only for needs-you).
  assert.equal(await page.locator('.hf18a .face18 [data-st="wait"], .hf18a .face18 .waiting').count(), 0);
  // The owner's faces rule: a helper is never Branch's mascot, even in Branch's own conversation. A saved specialist shows
  // the specialist's face (its line icon, as Customize › Specialists draws it). Mutation: draw av({ kind: "main" }) → red.
  assert.equal(await page.locator(MASCOT).count(), 0, "no helper face is the mascot");
  assert.equal(await page.locator(".hf18a .hfr18a .face18.hs18c svg.i").count(), 2, "each specialist helper shows the specialist's face");
  assert.equal(await page.locator("#conversation .hl17c").count(), 0, "the thread's chip steps aside while the frame shows");
  releaseAll();
  assert.equal((await done).status, "completed");
  await page.waitForFunction(() => !document.querySelector(".hf18a"), null, { timeout: 15000 });
  await page.waitForFunction(() => /2 helpers · done/.test(document.querySelector("#conversation .hl17c")?.textContent ?? ""), null, { timeout: 15000 });
  assert.deepEqual(errors, []);
});

test("in a Trunk's conversation a helper that is no saved specialist shows that Trunk's face, dimmed and badged", async (t) => {
  const { app, page, errors, fanOut, openChat, releaseAll, ids, holder } = await fixture(t);
  const ann = app.trunks.create({ name: "Ann" });
  await app.trunks.introduced(); // Ann's own introduction has finished in her conversation
  // Ann's work asks before handing out work; the owner says yes for this conversation.
  holder.fanTo = ids;
  const first = await app.runtime.run({ prompt: "split the invoices for Ann", sessionId: ann.chatSessionId, permissions: [...app.runtime.context().permissions] });
  assert.equal(first.status, "needs_input", "control: Ann's task asks first");
  const question = app.runtime.approvals.questionFor(ann.chatSessionId);
  app.runtime.approve(question.sessionId, "allow", "session", question.fingerprint);
  const { done, parent } = await fanOut("compare the invoices for Ann", ann.chatSessionId);
  // Neither helper is a saved specialist any more, so each is shown as Ann's helper.
  for (const id of ids) app.store.delete("specialists", app.store.profiles.scope(), id);
  await openChat(parent.sessionId);
  await page.waitForFunction(() => document.querySelectorAll(".hf18a .hfr18a .face18.hb18c .in18c.dim18").length === 2, null, { timeout: 15000 });
  assert.equal(await page.locator(".hf18a .hfr18a .face18.hb18c .b18c svg.i").count(), 2, "each carries the helper badge");
  // Each is still named by the name kept when it started, never by its id.
  assert.deepEqual((await page.locator(".hf18a .hfr18a .nm18 b").allInnerTexts()).sort(), ["alpha", "beta"]);
  assert.equal(await page.locator(MASCOT).count(), 0, "no helper face is the mascot");
  releaseAll();
  assert.equal((await done).status, "completed");
  assert.deepEqual(errors, []);
});

test("Stop on one helper stops that helper only; its sibling and its parent carry on", async (t) => {
  const { app, page, errors, fanOut, openChat, gates } = await fixture(t);
  const { done, parent, byName } = await fanOut();
  await openChat(parent.sessionId);
  const stop = page.locator(`.hfr18a [data-act="hfstop18a"][data-id="${byName.alpha.runId}"]`);
  await stop.waitFor({ timeout: 15000 });
  await stop.click();
  assert.ok(await until(() => app.store.run(byName.alpha.runId).status === "cancelled"), "the helper asked for is stopped");
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(app.store.run(byName.beta.runId).status, "running", "its sibling carries on");
  assert.equal(app.store.run(parent.id).status, "running", "the task that started it carries on");
  await page.waitForFunction((id) => !document.querySelector(`.hfr18a [data-act="hfstop18a"][data-id="${id}"]`), byName.alpha.runId, { timeout: 15000 });
  assert.equal(await page.locator(`.hfr18a [data-act="hfstop18a"][data-id="${byName.beta.runId}"]`).count(), 1, "the sibling's row stays");
  gates.get("beta")();
  assert.equal((await done).status, "completed");
  // QA Q048: once none works, the thread's chip says how each one ended, never "done" for the one stopped.
  await page.waitForFunction(() => /2 helpers · 1 done, 1 stopped/.test(document.querySelector("#conversation .hl17c")?.textContent ?? ""), null, { timeout: 15000 });
  assert.deepEqual(errors, []);
});

test("QA Q049: the question before handing out work names the helpers in words, not their ids", async (t) => {
  const { app, fanOut, releaseAll } = await fixture(t);
  const { done, byName } = await fanOut();
  const ids = [byName.alpha, byName.beta].map((h) => app.store.events(h.runId).find((e) => e.kind === "run.started")?.data.agent);
  const args = { tasks: ids.map((specialist, i) => ({ specialist, prompt: `job ${i + 1}` })) };
  const { label } = app.runtime.checkPolicy("delegate.parallel", args, app.runtime.context());
  assert.equal(label, "Start 2 helpers: alpha and beta");
  assert.doesNotMatch(label, /delegate\.parallel|[0-9a-f]{8}-/);
  releaseAll();
  await done;
});

test("Steer on one helper reaches that helper only", async (t) => {
  const { page, errors, fanOut, openChat, releaseAll, requests } = await fixture(t);
  const { done, parent, byName } = await fanOut();
  await openChat(parent.sessionId);
  await page.locator(".hfh18a").click();
  await page.locator(`.card18a [data-act="hfsteer18a"][data-id="${byName.beta.runId}"]`).click();
  const note = "only the August invoices";
  await page.locator("#steer18").fill(note);
  await page.locator("#steer18").press("Enter");
  await page.waitForFunction(() => !document.querySelector("#steer18"), null, { timeout: 15000 });
  releaseAll();
  assert.equal((await done).status, "completed");
  assert.match(text(requests.beta.at(-1)), new RegExp(note), "the helper read the note on its next round");
  assert.ok(requests.alpha.every((r) => !text(r).includes(note)), "its sibling never saw it");
  assert.ok(requests.parent.every((r) => !text(r).includes(note)), "the parent never saw it");
  assert.deepEqual(errors, []);
});

test("Open shows a helper's own record view only: no message box, nothing sent, one way back", async (t) => {
  const { app, page, errors, fanOut, openChat, releaseAll } = await fixture(t);
  const { done, parent, byName } = await fanOut();
  await openChat(parent.sessionId);
  await page.locator(".hfh18a").click();
  await page.locator(`.card18a [data-act="hfopen18a"][data-id="${byName.alpha.runId}"]`).click();
  await page.locator(".vo18").waitFor({ timeout: 15000 });
  assert.equal(await page.locator("#composer, #prompt").count(), 0, "no message box");
  assert.match(await page.locator(".head .vo18h").innerText(), /alpha[\s\S]*Helper for .+ · view only/);
  assert.match(await page.locator(".voh18").innerText(), /asked for: job 1: look at the invoices/);
  await page.locator(".vosteps18 li").first().waitFor({ timeout: 15000 });
  const before = app.store.runs(app.store.profiles.scope()).length;
  await page.keyboard.press("Enter");
  await page.locator('[data-act="voback18"]').focus();
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(app.store.runs(app.store.profiles.scope()).length, before, "nothing was sent");
  assert.match(await page.locator('[data-act="voback18"]').innerText(), /^Back to /);
  await page.locator('[data-act="voback18"]').click();
  await page.locator("#prompt").waitFor({ timeout: 15000 });
  assert.equal(await page.locator(".dock > .hf18a").count(), 1, "back in the conversation, with its frame");
  releaseAll();
  await done;
  assert.deepEqual(errors, []);
});

test("helpers never join the sidebar, and a household person sees none of the owner's helpers", async (t) => {
  const { app, api, page, fanOut, openChat, releaseAll } = await fixture(t);
  const owner = await fanOut("the owner's invoices");
  const listed = (await api("sessions?limit=50")).body.sessions.map((s) => s.sessionId);
  assert.ok(listed.includes(owner.parent.sessionId), "control: the parent's conversation is listed");
  for (const h of Object.values(owner.byName)) assert.ok(!listed.includes(h.sessionId), `${h.name}'s conversation stays out of the list`);
  const counted = Object.values(app.store.projectSessionCounts(app.store.profiles.scope())).reduce((a, n) => a + n, 0);
  assert.equal(counted, listed.length, "a project counts the conversations it lists, never its helpers'");
  await openChat(owner.parent.sessionId);
  await page.locator(".dock > .hf18a").waitFor({ timeout: 15000 });
  for (const h of Object.values(owner.byName)) assert.equal(await page.locator(`#side [data-id="${h.sessionId}"]`).count(), 0);
  assert.equal((await api(`runs/${owner.parent.id}/steps`)).body.helpers.length, 2, "control: the owner reads them");

  // While they work, Dana (a household person) is at the window: the owner's helpers are neither read nor acted on.
  const dana = app.store.profiles.create({ name: "Dana", pin: "4826" });
  app.store.profiles.switch({ profileId: dana.id, pin: "4826" });
  try {
    assert.equal((await api(`runs/${owner.parent.id}/steps`)).status, 404, "the owner's task and its helpers are not read for her");
    const hers = (await api("sessions?limit=50")).body.sessions.map((s) => s.sessionId);
    assert.ok(!hers.includes(owner.parent.sessionId), "nor is the owner's conversation listed");
    assert.equal((await api(`runs/${owner.byName.alpha.runId}/cancel`, {})).status, 404, "nor stopped");
    assert.equal((await api(`runs/${owner.byName.beta.runId}/steer`, { text: "stop" })).status, 404, "nor steered");
  } finally { app.store.profiles.switch({ profileId: null }); }
  assert.equal(app.store.run(owner.byName.alpha.runId).status, "running");
  releaseAll();
  assert.equal((await owner.done).status, "completed");
});

test("a household person's own helpers are theirs, never the owner's, and the owner's never theirs", async (t) => {
  const { app, api, page, errors, fanOut, openChat, releaseAll, gates, holder, ids } = await fixture(t);
  // The owner's helpers are working when Dana (a household person) comes to the window and starts her own.
  const owner = await fanOut("the owner's invoices");
  const ownerRelease = new Map(gates);
  const dana = app.store.profiles.create({ name: "Dana", pin: "4826" });
  app.runtime.roles.save(dana.id, { role: "owner" }); // a role that may hand work to helpers
  /* The window starts again by itself when the person changes (public/app/main.js watchPerson); a reload of our own
     raced that one and was aborted, so the window's own restart is what is waited for. */
  const restarted = page.waitForEvent("framenavigated", { predicate: (frame) => frame === page.mainFrame(), timeout: 30000 });
  app.store.profiles.switch({ profileId: dana.id, pin: "4826" });
  let parent;
  try {
    holder.fanTo = ids;
    gates.clear();
    const started = api("run", { prompt: "Dana's receipts" });
    assert.ok(await until(() => gates.has("alpha") && gates.has("beta")), "control: her helpers are working");
    for (const who of ["alpha", "beta"]) assert.equal((await api(`runs/${owner.byName[who].runId}/cancel`, {})).status, 404, "the owner's helper is not stopped for her");
    assert.equal((await api(`runs/${owner.parent.id}/steps`)).status, 404, "nor read");
    releaseAll();
    assert.equal((await started).status, 200);
    parent = app.store.runs(app.store.profiles.scope()).find((r) => r.prompt === "Dana's receipts");
    assert.ok(parent, "her task is filed under her name");
    const hers = (await api(`runs/${parent.id}/steps`)).body.helpers ?? [];
    assert.equal(hers.length, 2, `her own helpers are hers to read: ${JSON.stringify(hers)}`);
    assert.ok(hers.every((h) => h.status === "completed"));
    for (const h of hers) assert.equal((await api(`sessions/${h.sessionId}`)).status, 200, "and each helper's own conversation");
    assert.ok(!hers.some((h) => Object.values(owner.byName).some((o) => o.runId === h.runId)), "none of them is the owner's");
    // In the window she sees her conversation's helpers, and only hers.
    await restarted;
    await page.locator("#app #side").waitFor({ state: "visible", timeout: 60000 });
    await openChat(parent.sessionId);
    await page.waitForFunction(() => /2 helpers · done/.test(document.querySelector("#conversation .hl17c")?.textContent ?? ""), null, { timeout: 15000 });
    for (const o of Object.values(owner.byName)) assert.equal(await page.locator(`[data-id="${o.runId}"]`).count(), 0);
    var herHelpers = hers;
  } finally { app.store.profiles.switch({ profileId: null }); }
  // Back with the owner: Dana's helpers are not the owner's to read.
  for (const h of herHelpers) {
    const read = await api(`sessions/${h.sessionId}`);
    assert.ok(read.status >= 400 && /not found/i.test(read.body.error ?? ""), `her helper's conversation is not the owner's: ${JSON.stringify(read)}`);
    assert.equal((await api(`runs/${h.runId}/steps`)).status, 404, "nor its record");
  }
  assert.equal((await api(`runs/${owner.parent.id}/steps`)).body.helpers.length, 2, "control: the owner still reads his own");
  for (const release of ownerRelease.values()) release();
  assert.equal((await owner.done).status, "completed");
  assert.deepEqual(errors, []);
});

test("a household hand-back moves only conversations made of her task's helpers, never one holding anything else", async (t) => {
  const { app, api, releaseAll, gates, holder, ids } = await fixture(t);
  const dana = app.store.profiles.create({ name: "Dana", pin: "4826" });
  app.runtime.roles.save(dana.id, { role: "owner" });
  app.store.profiles.switch({ profileId: dana.id, pin: "4826" });
  try {
    holder.fanTo = ids;
    gates.clear();
    const started = api("run", { prompt: "Dana's receipts" });
    assert.ok(await until(() => gates.has("alpha") && gates.has("beta")), "control: her helpers are working");
    const parent = app.store.runs(app.runtime.owner).find((r) => r.prompt === "Dana's receipts");
    const helpers = app.store.runs(app.runtime.owner).filter((r) => app.store.events(r.id).find((e) => e.kind === "run.started")?.data.parentRunId === parent.id);
    assert.equal(helpers.length, 2);
    // Something else lands in one helper's conversation while she works: that conversation is not only hers.
    const shared = helpers[0].sessionId, hers = helpers[1].sessionId;
    app.store.createRun(app.runtime.owner, "the owner's own note", shared);
    releaseAll();
    assert.equal((await started).status, 200);
    assert.ok(app.store.ownsSession(app.runtime.owner, shared), "a conversation holding another task stays where it was");
    assert.ok(app.store.ownsSession(app.store.profiles.scope(), hers), "one made only of her helper is handed back");
  } finally { app.store.profiles.switch({ profileId: null }); }
});

test("QA Q048: the background pill counts a task, not its helpers, and says how each task really ended", async (t) => {
  const { app, api, page, errors, fanOut, gates } = await fixture(t);
  const pill = () => page.locator("#dockrow .bgchip15").textContent({ timeout: 1000 }).catch(() => "");
  const first = await fanOut("the first invoices");
  // The window stays on a new conversation: the task and its two helpers all work away from it.
  await page.waitForFunction(() => /^1 in the background$/.test(document.querySelector("#dockrow .bgchip15")?.textContent?.trim() ?? ""), null, { timeout: 15000 })
    .catch(async () => assert.fail(`the pill counts the task alone, not its helpers: ${await pill()}`));
  assert.equal((await api(`runs/${first.byName.alpha.runId}/cancel`, {})).status, 200);
  gates.get("beta")();
  assert.equal((await first.done).status, "completed");
  await page.waitForFunction(() => /^1 finished in the background$/.test(document.querySelector("#dockrow .bgchip15")?.textContent?.trim() ?? ""), null, { timeout: 15000 })
    .catch(async () => assert.fail(`a stopped helper is never counted finished: ${await pill()}`));
  const second = await fanOut("the second invoices");
  await page.waitForFunction(() => /^1 in the background$/.test(document.querySelector("#dockrow .bgchip15")?.textContent?.trim() ?? ""), null, { timeout: 15000 });
  assert.equal((await api(`runs/${second.parent.id}/cancel`, {})).status, 200);
  for (const release of gates.values()) release();
  await second.done;
  assert.equal(app.store.run(second.parent.id).status, "cancelled");
  await page.waitForFunction(() => /^1 done, 1 stopped$/.test(document.querySelector("#dockrow .bgchip15")?.textContent?.trim() ?? ""), null, { timeout: 15000 })
    .catch(async () => assert.fail(`the stopped task says stopped: ${await pill()}`));
  assert.deepEqual(errors, []);
});

test("QA Q049: the question before handing out work lists each helper's job in plain words, not the raw request", async (t) => {
  const { app, api, page, errors, holder, ids, openChat, releaseAll } = await fixture(t);
  const policy = readPolicy(app.store, app.runtime.owner);
  savePolicy(app.store, app.runtime.owner, { ...policy, rules: [{ tool: "delegate.parallel", decision: "ask" }, ...policy.rules] });
  holder.fanTo = ids;
  const done = app.runtime.run({ prompt: "split the invoices", permissions: [...app.runtime.context().permissions] });
  const asked = await until(async () => ((await api("policy")).body.waiting ?? []).find((q) => q.tool === "delegate.parallel"));
  assert.ok(asked, "control: the task asks first");
  assert.deepEqual(asked.jobs, [{ name: "alpha", job: "job 1: look at the invoices" }, { name: "beta", job: "job 2: look at the invoices" }]);
  assert.match(asked.question, /Start 2 helpers: alpha and beta/);
  await openChat(asked.sessionId);
  const card = page.locator("#live-ask");
  await card.waitFor({ timeout: 15000 });
  assert.deepEqual(await card.locator("dt").allTextContents(), ["alpha", "beta"]);
  assert.deepEqual(await card.locator("dd:not(.mailbody)").allTextContents(), ["job 1: look at the invoices", "job 2: look at the invoices"]);
  const words = await card.innerText();
  assert.doesNotMatch(words, /[0-9a-f]{8}-[0-9a-f]{4}-|"specialist"|failFast|\{/, `no ids and no raw request: ${words}`);
  await done;
  releaseAll();
  assert.deepEqual(errors, []);
});
