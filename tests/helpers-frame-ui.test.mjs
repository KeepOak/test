/**
 * Pass 18a, the window's side of DESIGN-DIRECTION PRs 4 and 5 (public/app/chat/helpframe.js): the helpers frame above the
 * message box and the view-only helper conversation, driven headless against a scripted model whose helpers hold
 * mid-work until the test lets them go (as tests/helpers-steer-stop.test.mjs does). No provider.
 *
 * - The frame shows while helpers work, one row each, and goes once none does (the thread's chip then reads done).
 * - Stop on one helper stops that helper only; its sibling and the task that started it carry on.
 * - Steer on one helper reaches that helper only.
 * - Open shows a helper's own record view only: no message box, nothing can be sent, one way back.
 * - Helpers' conversations never join the sidebar (GET /api/sessions), and a household person at the window sees
 *   none of the owner's helpers: they are neither read, listed, stopped nor steered for them.
 *
 * Mutation notes (each turns this file red; each was tried):
 * - helpframe.js helpFrame: draw the frame whatever the helpers' status (drop `if (!now.length) return ""`) and it never goes.
 * - helpframe.js stop: cancel frameRun() instead of the helper's own run and the parent stops too.
 * - helpframe.js steer: steer frameRun() instead of the helper and the note reaches the parent, not the helper.
 * - chat.js draw: draw composer() in the view-only branch and the message box is there.
 * - src/session-library.ts notEngineOnly: drop the run.started parentRunId clause and helpers join the sidebar.
 * - src/server.ts GET /api/runs/:id/steps: drop the `run.owner !== profiles.scope()` refusal and the household person
 *   reads the owner's helpers.
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

const say = (content) => ({ content, toolCalls: [] });
const call = (name, args) => ({ content: "", toolCalls: [{ id: `c${Math.random().toString(36).slice(2, 9)}`, name, arguments: JSON.stringify(args) }] });
const until = async (check, tries = 400) => { for (let i = 0; i < tries && !(await check()); i++) await new Promise((r) => setTimeout(r, 25)); return check(); };
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
    const round = requests[who].length;
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
  const fanOut = async (prompt = "compare the invoices") => {
    holder.fanTo = ids;
    model.gates.clear();
    for (const who of Object.keys(model.requests)) if (who !== "parent") delete model.requests[who];
    const done = app.runtime.run({ prompt, permissions: [...app.runtime.context().permissions] });
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
  return { app, api, page, errors, fanOut, openChat, releaseAll, ...model };
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
  assert.equal(await page.locator("#conversation .hl17c").count(), 0, "the thread's chip steps aside while the frame shows");
  releaseAll();
  assert.equal((await done).status, "completed");
  await page.waitForFunction(() => !document.querySelector(".hf18a"), null, { timeout: 15000 });
  await page.waitForFunction(() => /2 helpers · done/.test(document.querySelector("#conversation .hl17c")?.textContent ?? ""), null, { timeout: 15000 });
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
  assert.deepEqual(errors, []);
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
