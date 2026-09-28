/**
 * Live helpers for household people (src/household-approvals.ts personTaskHere, src/server.ts, chat/timeline.js): while
 * a household person's task works, the lending files it and its helpers under the owner (src/collab-server.ts
 * runForCurrentPerson), yet the person at the window sees, stops and steers that task's own helpers live, and nobody
 * else's. Headless, against a scripted model whose helpers hold mid-work until let go. No provider.
 *
 * - Dana sends from the window: the helpers frame shows her two helpers while they work, never the owner's (working at
 *   the same time); Stop stops one of hers only; Steer reaches the other only; the activity list names her task, not his.
 * - Attack: Eve (another household person) at the window reads, lists, stops and steers none of Dana's live helpers; nor
 *   does Dana reach a task started for her in the owner's own conversation, nor one in her lent conversation that was
 *   not started for her.
 * - A household person's task that throws (rather than ending) still hands back its conversation and its helpers'.
 * - Her own task, for her only: its live step lines in her reply area (GET /api/runs/<id>/live, ended the moment the
 *   window is someone else's), her helpers' questions (seen and answered with Allow once; Eve neither sees nor answers
 *   them; a question of a task started for her in the owner's own conversation is not hers), and Stop on her main task
 *   (from the window, even after it started again; nobody else's, and nobody else stops hers).
 *
 * Mutation notes (each turns this file red; each was tried):
 * - household-approvals.ts personTaskHere: drop the personProfileId check and the task in her lent conversation that
 *   was not started for her is read.
 * - household-approvals.ts personTaskHere: drop the conversation check and the task started for her in the owner's own
 *   conversation is read.
 * - server.ts /api/runs/:id/steps: drop `|| personTaskHere(...)` and Dana's frame never shows.
 * - server.ts /api/runs/:id: drop `own` and Dana's Stop is refused; drop its helpers-only clause for steer and she steers
 *   her own task through the helpers' door.
 * - server.ts /api/activity: drop the lent list and Dana's window never learns her task works.
 * - collab-server.ts runForCurrentPerson: drop the hand-back in `catch` and a thrown task's helpers stay the owner's.
 * - household-approvals.ts mayAnswerHere: drop the live clause and her helper's question is not hers; answer true past
 *   the personProfileId check and a question in the owner's own conversation is.
 * - server.ts /api/runs/:id/live: readable by owner scope only, or by anyone, and her stream is refused or Eve's is
 *   let through; drop `stillHere` (or never end in streams.ts) and a switch of the window does not end her stream.
 * - chat.js stoppable: the window's picture of tasks only, or pane.js busy: sending only, and Stop never shows for her.
 * (Kept but not reachable from a test: mayAnswerHere's "asked in that very task's conversation"; the engine only ever
 *  asks a question in its task's own conversation.)
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
import { runForCurrentPerson } from "../dist/collab-server.js";
import { readPolicy, savePolicy } from "../dist/policy.js";
import { waitInPage } from "./wait-in-page.mjs";

const say = (content) => ({ content, toolCalls: [] });
const call = (name, args) => ({ content: "", toolCalls: [{ id: `c${Math.random().toString(36).slice(2, 9)}`, name, arguments: JSON.stringify(args) }] });
const until = async (check, tries = 400) => { for (let i = 0; i < tries && !(await check()); i++) await new Promise((r) => setTimeout(r, 25)); return check(); };
const text = (request) => request.messages.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n");

/* A parent hands work to the helpers its words name (holder.fans: words → specialist ids); each helper reads a note,
   then works (held until let go or stopped), reads again and answers. */
function scripted(holder) {
  const gates = new Map(), requests = {};
  const provider = { name: "scripted", async complete(request) {
    const who = /You are the (\w+)\./.exec(String(request.messages[0]?.content ?? ""))?.[1];
    if (!who) {
      if (request.messages.at(-1).role === "tool") return say("The helpers answered.");
      const asked = String(request.messages.filter((m) => m.role === "user").at(-1)?.content ?? "");
      const fan = Object.entries(holder.fans).find(([words]) => asked.includes(words))?.[1];
      return fan ? call("delegate.parallel", { tasks: fan.map((specialist, i) => ({ specialist, prompt: `job ${i + 1}: ${asked}` })) }) : say("Hello.");
    }
    if (/^say ready/.test(String(request.messages.find((m) => m.role === "user")?.content ?? ""))) return say("ready");
    (requests[who] ??= []).push(request);
    const round = request.messages.filter((m) => m.role === "tool").length + 1;
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
  const root = await mkdtemp(join(tmpdir(), "branch-household-live-"));
  const holder = { fans: {} }, model = scripted(holder);
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
  holder.fans = { "the owner's": [await specialist("alpha"), await specialist("beta")], "Dana's": [await specialist("gamma"), await specialist("delta")] };
  const person = (name, pin) => {
    const made = app.store.profiles.create({ name, pin });
    app.runtime.roles.save(made.id, { role: "owner" }); // a role that may hand work to helpers
    return { ...made, pin };
  };
  const at = (who) => app.store.profiles.switch(who ? { profileId: who.id, pin: who.pin } : { profileId: null });
  const helpersOf = (parentId) => app.store.sqlite.prepare("SELECT run_id AS id FROM events WHERE kind='run.started' AND json_extract(data,'$.parentRunId')=?").all(parentId).map((row) => String(row.id));
  const runBy = (prompt) => app.store.sqlite.prepare("SELECT id FROM tasks WHERE prompt=? ORDER BY rowid DESC LIMIT 1").get(prompt)?.id;
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 950 }, serviceWorkers: "block" })).newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await signIn(page, server);
  return { app, api, server, page, errors, person, at, helpersOf, runBy, release: (who) => model.gates.get(who)?.(), ...model };
}

/** Open only after disposing of the previous profile's document and reading the person now at the engine. Opening
    #open sets S.chat before that document's profile watcher can reset it; checking the conversation alone therefore
    lets a queued profile reset put the next message in a new Ask first conversation. */
async function openAs(f, sid) {
  const profile = f.app.store.profiles.active()?.id ?? null;
  const opened = () => waitInPage(f.page, async (id) => (await import("/app/core/state.js")).S.chat === id, sid, { timeout: 15000 });
  for (let tries = 0; ; tries++) {
    try {
      await f.page.goto("about:blank", { waitUntil: "load" });
      await f.page.goto(`${f.server.url}/?fresh=${Date.now()}#open=${sid}`, { waitUntil: "load" });
      await f.page.locator("#app #side").waitFor({ state: "visible", timeout: 60000 });
      const here = await f.page.evaluate(async () => (await import("/app/core/state.js")).E.profiles?.active?.id ?? null);
      if (here !== profile) throw new Error("The profile reset has not finished.");
      await opened();
      return;
    } catch (error) {
      if (tries >= 3) throw error;
      await f.page.waitForLoadState("load").catch(() => undefined);
    }
  }
}

/** The owner's task with two helpers held mid-work, started as the owner. */
async function ownerAtWork(f) {
  const done = f.app.runtime.run({ prompt: "check the owner's invoices", permissions: [...f.app.runtime.context().permissions] });
  assert.ok(await until(() => f.gates.has("alpha") && f.gates.has("beta")), "control: the owner's helpers work");
  const parent = f.runBy("check the owner's invoices");
  return { done, parent, helpers: f.helpersOf(parent) };
}

test("a queued profile reset cannot leave a helper message in a new Ask first conversation", async (t) => {
  const f = await fixture(t);
  const before = (await f.api("profiles")).body;
  const dana = f.person("Dana", "4826");
  f.at(dana);
  const first = await f.api("run", { prompt: "hello" });
  let stale = 0, oldDocument;
  let release;
  const held = new Promise((done) => { release = done; });
  t.after(release);
  await f.page.addInitScript(() => {
    const ask = window.fetch, id = Math.random().toString(36).slice(2);
    window.fetch = (url, options = {}) => {
      const headers = new Headers(options.headers);
      headers.set("x-profile-reset-fixture", id);
      return ask(url, { ...options, headers });
    };
  });
  // Hold the previous profile's completed read across opening. This is the stale boot picture which makes the
  // profile watcher reset the document after #open has already been consumed. Run/approval APIs use the actual server.
  await f.page.route("**/api/profiles", async (route) => {
    const document = route.request().headers()["x-profile-reset-fixture"];
    if (!stale && document) {
      oldDocument = document;
      stale += 1;
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(before) });
    }
    if (document && document === oldDocument) await held;
    return route.continue();
  });
  await openAs(f, first.body.sessionId);
  assert.equal(stale, 1, "the controlled stale profile read was delivered");
  assert.equal(await f.page.evaluate(async () => (await import("/app/core/state.js")).E.profiles?.active?.id), dana.id,
    "the previous profile's document must be gone before typing");
  const request = f.page.waitForRequest((r) => r.method() === "POST" && new URL(r.url()).pathname === "/api/run");
  await f.page.locator("#prompt").fill("check Dana's receipts");
  await f.page.locator("#prompt").press("Enter");
  assert.equal((await request).postDataJSON().sessionId, first.body.sessionId, "the message stays in her opened conversation");
  assert.ok(await until(() => f.gates.has("gamma") && f.gates.has("delta")), "her helpers start without a new conversation's approval");
  const parent = f.runBy("check Dana's receipts");
  assert.equal(f.helpersOf(parent).length, 2);
  assert.ok(!f.app.runtime.approvals.waiting().some((q) => q.runId === parent && q.tool === "delegate.parallel"));
  for (const release of f.gates.values()) release();
  assert.ok(await until(() => f.app.store.run(parent).status === "completed"));
  assert.deepEqual(f.errors, []);
});

test("a household person sees, stops and steers their own task's helpers live, and never the owner's", async (t) => {
  const f = await fixture(t);
  const { app, api, page, errors, at, helpersOf, runBy, gates, requests } = f;
  const owner = await ownerAtWork(f);
  const dana = f.person("Dana", "4826");
  at(dana);
  const first = await api("run", { prompt: "hello" }); // her own conversation, handed back to her when done
  assert.equal(first.status, 200);
  const sid = first.body.sessionId;
  await openAs(f, sid);
  await page.locator("#prompt").waitFor({ timeout: 15000 });
  const sent = [];
  page.on("request", (request) => { if (request.method() !== "GET" && request.url().includes("/api/")) sent.push(request.url().split("/api/")[1]); });
  await page.locator("#prompt").fill("check Dana's receipts");
  await page.locator("#prompt").press("Enter");
  const working = await until(() => gates.has("gamma") && gates.has("delta"));
  // What the window and the engine were doing, named in the failure (seen once in CI, not reproduced here).
  assert.ok(working, working ? "" : `control: her helpers work (window sent: ${sent.join(", ") || "nothing"}; box: "${await page.locator("#prompt").inputValue().catch((error) => error.message)}"; tasks: ${JSON.stringify(app.store.sqlite.prepare("SELECT prompt, status FROM tasks ORDER BY rowid").all())}; helpers holding: ${[...gates.keys()].join(", ")}; toasts: ${await page.evaluate(() => [...document.querySelectorAll(".toast")].map((toast) => toast.textContent).join(" | "))})`);
  const parent = runBy("check Dana's receipts"), hers = helpersOf(parent);
  assert.equal(app.store.run(parent).owner, app.runtime.owner, "control: while it works, the lending files her task under the owner");

  const listed = (await api("activity")).body.map((a) => a.runId);
  assert.ok(listed.includes(parent), "her working task is in her activity list");
  assert.ok(!listed.includes(owner.parent) && !owner.helpers.some((id) => listed.includes(id)), "the owner's is not");
  await page.waitForFunction(() => document.querySelectorAll(".hf18a .hfr18a [data-act='hfstop18a']").length === 2, null, { timeout: 20000 });
  const shown = await page.locator(".hf18a .hfr18a [data-act='hfstop18a']").evaluateAll((els) => els.map((el) => el.dataset.id));
  assert.deepEqual(shown.sort(), [...hers].sort(), `her frame shows her two helpers: ${JSON.stringify([shown, hers, parent])}`);
  assert.ok(!owner.helpers.some((id) => shown.includes(id)), "and none of the owner's");

  const [gammaRun, deltaRun] = ["gamma", "delta"].map((who) => hers.find((id) => app.store.run(id).prompt === requests[who][0].messages.find((m) => m.role === "user")?.content));
  await page.locator(`.hfr18a [data-act="hfstop18a"][data-id="${gammaRun}"]`).click();
  assert.ok(await until(() => app.store.run(gammaRun).status === "cancelled"), "the helper she stopped is stopped");
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(app.store.run(deltaRun).status, "running", "her other helper carries on");
  assert.equal(app.store.run(parent).status, "running", "and her task");
  assert.ok(owner.helpers.every((id) => app.store.run(id).status === "running"), "and the owner's helpers");

  await page.locator(".hfh18a").click();
  await page.locator(`.card18a [data-act="hfsteer18a"][data-id="${deltaRun}"]`).click();
  await page.locator("#steer18").fill("only the August receipts");
  await page.locator("#steer18").press("Enter");
  await page.waitForFunction(() => !document.querySelector("#steer18"), null, { timeout: 15000 });
  assert.ok(await until(() => app.store.events(deltaRun).some((e) => e.kind === "run.steered")), "her note reached her helper");
  gates.get("delta")();
  assert.ok(await until(() => app.store.run(parent).status === "completed"), "her task finishes");
  assert.match(text(requests.delta.at(-1)), /only the August receipts/);
  assert.ok(requests.alpha.every((r) => !/August/.test(text(r))), "the owner's helper never saw it");
  at(null);
  for (const who of ["alpha", "beta"]) gates.get(who)();
  assert.equal((await owner.done).status, "completed");
  assert.deepEqual(errors, []);
});

test("attack: nobody else reaches a household person's live helpers, nor does she reach what is not hers", async (t) => {
  const f = await fixture(t);
  const { app, api, at, helpersOf, runBy, gates } = f;
  const owner = await ownerAtWork(f);
  const dana = f.person("Dana", "4826"), eve = f.person("Eve", "1357");
  at(dana);
  const working = api("run", { prompt: "check Dana's receipts" });
  assert.ok(await until(() => gates.has("gamma") && gates.has("delta")), "control: her helpers work");
  const parent = runBy("check Dana's receipts"), hers = helpersOf(parent);
  assert.equal((await api(`runs/${parent}/steps`)).body.helpers.length, 2, "control: Dana reads her live helpers");
  for (const id of owner.helpers) assert.equal((await api(`runs/${id}/cancel`, {})).status, 404, "Dana never stops the owner's helper");
  assert.equal((await api(`runs/${owner.parent}/steps`)).status, 404, "nor reads the owner's task");
  // Her own task (not a helper) is hers to stop, never to steer through the helpers' door.
  assert.equal((await api(`runs/${parent}/steer`, { text: "stop" })).status, 404, "her own task is not steered through the helpers' door");
  assert.equal((await api(`runs/${owner.parent}/cancel`, {})).status, 404, "nor does she stop the owner's task");

  // A task in her lent conversation that was not started for her.
  const sid = app.store.run(parent).sessionId;
  const stray = app.store.createRun(app.runtime.owner, "the owner's note", sid);
  app.store.event(stray.id, "run.started", { parentRunId: null });
  assert.equal((await api(`runs/${stray.id}/steps`)).status, 404, "a task not started for her is not hers, wherever it runs");

  // A task started for her in the owner's own conversation (the window switched to her), not lent to her.
  const ownerSid = app.store.run(owner.parent).sessionId;
  at(null);
  const other = app.store.createRun(app.runtime.owner, "the owner's other note", ownerSid);
  app.store.event(other.id, "run.started", { parentRunId: null, personProfileId: dana.id });
  at(dana);
  assert.equal((await api(`runs/${other.id}/steps`)).status, 404, "nor one in a conversation that is not hers");
  // Its question (a task started for her, in the owner's own conversation) is neither listed for her nor answered by her.
  const fingerprint = "a".repeat(32);
  app.runtime.approvals.ask({ runId: other.id, sessionId: ownerSid, tool: "files.read", target: "notes.txt", label: "Reading notes.txt",
    question: "Before I go ahead: Reading notes.txt. Is that all right?", source: "owner", remember: "never", askedAt: new Date().toISOString(), fingerprint });
  try {
    assert.ok(!(await api("policy")).body.waiting.some((q) => q.fingerprint === fingerprint), "its question is not listed for her");
    const answered = await api("policy/approve", { sessionId: ownerSid, decision: "allow", remember: "never", fingerprint });
    assert.equal(answered.status, 404, "nor answered by her");
  } finally { app.runtime.approvals.dropFor(ownerSid, other.id); }

  at(eve);
  try {
    assert.equal((await api(`runs/${parent}/steps`)).status, 404, "Eve does not read Dana's task");
    for (const id of hers) {
      assert.equal((await api(`runs/${id}/steps`)).status, 404, "nor its helpers");
      assert.equal((await api(`runs/${id}/cancel`, {})).status, 404, "nor stops them");
      assert.equal((await api(`runs/${id}/steer`, { text: "stop" })).status, 404, "nor steers them");
    }
    const listed = (await api("activity?waiting=1")).body.map((a) => a.runId);
    assert.ok(![parent, ...hers, owner.parent, ...owner.helpers].some((id) => listed.includes(id)), "nor lists any of it");
  } finally { at(dana); }
  assert.ok(hers.every((id) => app.store.run(id).status === "running"));
  assert.ok(hers.every((id) => !app.store.events(id).some((e) => e.kind === "run.steered")));
  for (const who of ["gamma", "delta"]) gates.get(who)();
  assert.equal((await working).status, 200);
  at(null);
  for (const who of ["alpha", "beta"]) gates.get(who)();
  await owner.done;
});

test("a household person's task that throws still hands back its conversation and its helpers'", async (t) => {
  const f = await fixture(t);
  const { app, at, helpersOf, runBy, gates } = f;
  const dana = f.person("Dana", "4826");
  const run = app.runtime.run.bind(app.runtime);
  app.runtime.run = async (options) => { await run(options); throw new Error("the engine stopped under the task"); };
  at(dana);
  try {
    const thrown = runForCurrentPerson(app, { prompt: "check Dana's receipts" }).then(() => null, (error) => error);
    assert.ok(await until(() => gates.has("gamma") && gates.has("delta")), "control: her helpers work");
    for (const who of ["gamma", "delta"]) gates.get(who)();
    assert.match(String((await thrown)?.message), /engine stopped/, "control: the task threw");
    const parent = runBy("check Dana's receipts");
    const scope = app.store.profiles.scope();
    assert.ok(app.store.ownsSession(scope, app.store.run(parent).sessionId), "her conversation is hers again");
    for (const id of helpersOf(parent)) assert.ok(app.store.ownsSession(scope, app.store.run(id).sessionId), "and each helper's");
  } finally { app.runtime.run = run; at(null); }
});

/** Dana at the window in her own conversation, sending `words` from it; resolves once her two helpers work. */
async function danaSends(f, words) {
  const { api, page, at, gates, helpersOf, runBy } = f;
  const dana = f.person("Dana", "4826");
  at(dana);
  const first = await api("run", { prompt: "hello" });
  assert.equal(first.status, 200);
  await openAs(f, first.body.sessionId);
  await page.locator("#prompt").waitFor({ timeout: 15000 });
  await page.locator("#prompt").fill(words);
  await page.locator("#prompt").press("Enter");
  assert.ok(await until(() => gates.has("gamma") && gates.has("delta")), "control: her helpers work");
  const parent = runBy(words);
  return { dana, parent, hers: helpersOf(parent) };
}
/** Reads a server-sent stream until `seen(text)`, or it ends; the text so far. `onOpen` runs once its first steps arrive. */
async function readStream(f, path, seen, onOpen = async () => {}) {
  const controller = new AbortController();
  const response = await fetch(`${f.server.url}/api/${path}`, { headers: { authorization: `Bearer ${f.server.token}` }, signal: controller.signal });
  if (response.status !== 200) return { status: response.status, text: "" };
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let text = "", opened = false;
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      if (!opened && text.includes("event: steps")) { opened = true; await onOpen(); }
      if (seen(text)) break;
    }
  } catch { /* let go by the timer or once seen */ } finally { clearTimeout(timer); controller.abort(); }
  return { status: 200, text };
}
const PROFILE_END = /"reason":"profile"/;

test("her reply area follows her own task's live steps; nobody else's does, and a switch of the window ends them", async (t) => {
  const f = await fixture(t);
  const { app, page, errors, at, gates } = f;
  const owner = await ownerAtWork(f);
  const { dana, parent, hers } = await danaSends(f, "check Dana's receipts");
  // What the window and the engine showed, named in the failure (seen on Linux CI, not reproduced on Windows or WSL).
  await page.locator("#conversation li.ls-in").first().waitFor({ timeout: 20000 }).catch(async (error) => assert.fail(`${error.message}; `
    + `steps shown: ${JSON.stringify(await page.locator("#conversation li[class*='ls-']").allInnerTexts().catch((e) => e.message))}; `
    + `conversation: ${JSON.stringify((await page.locator("#conversation").innerText().catch((e) => e.message)).slice(-600))}; `
    + `parent: ${JSON.stringify(app.store.run(parent)?.status)}; helpers: ${JSON.stringify(hers.map((id) => app.store.run(id)?.status))}; `
    + `helper events: ${JSON.stringify(hers.map((id) => app.store.events(id).map((e) => e.kind).slice(-8)))}; `
    + `live: ${(await readStream(f, `runs/${parent}/live`, (text) => text.includes("event: steps"))).text.slice(0, 800)}`));
  const lines = await page.locator("#conversation li[class*='ls-']").allInnerTexts();
  assert.ok(lines.some((line) => /Reading notes\.txt/.test(line)), `her helpers' steps show live: ${JSON.stringify(lines)}`);
  const own = await readStream(f, `runs/${parent}/live`, (text) => text.includes("event: steps"));
  assert.equal(own.status, 200, "she follows her own task's live steps");
  assert.match(own.text, /event: steps/, "and they arrive");
  assert.equal((await readStream(f, `runs/${owner.parent}/live`, () => true)).status, 404, "never the owner's");
  const eve = f.person("Eve", "1357");
  // A stream she holds ends the moment the window is someone else's.
  const moved = await readStream(f, `runs/${parent}/live`, (text) => PROFILE_END.test(text), async () => at(eve));
  assert.match(moved.text, PROFILE_END, "switching the window ends her stream");
  assert.equal((await readStream(f, `runs/${parent}/live`, () => true)).status, 404, "Eve does not follow Dana's task");
  for (const id of hers) assert.equal((await readStream(f, `runs/${id}/live`, () => true)).status, 404, "nor its helpers");
  at(dana);
  for (const who of ["gamma", "delta"]) gates.get(who)();
  assert.ok(await until(() => app.store.run(parent).status === "completed"));
  at(null);
  for (const who of ["alpha", "beta"]) gates.get(who)();
  await owner.done;
  assert.deepEqual(errors, []);
});

test("she answers her own helper's question, and nobody else can", async (t) => {
  const f = await fixture(t);
  const { app, api, page, errors, at } = f;
  const before = readPolicy(app.store, app.runtime.owner);
  savePolicy(app.store, app.runtime.owner, { ...before, rules: [{ tool: "files.read", decision: "ask" }, ...before.rules] });
  const dana = f.person("Dana", "4826");
  at(dana);
  const first = await api("run", { prompt: "hello" });
  await openAs(f, first.body.sessionId);
  await page.locator("#prompt").waitFor({ timeout: 15000 });
  const sent = [], runRequests = [];
  page.on("request", (request) => {
    if (request.method() !== "GET" && request.url().includes("/api/")) sent.push(request.url().split("/api/")[1]);
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/run") runRequests.push(request.postDataJSON());
  });
  await page.locator("#prompt").fill("check Dana's receipts");
  await page.locator("#prompt").press("Enter");
  const parentOf = () => f.runBy("check Dana's receipts");
  assert.ok(await until(() => runRequests.length === 1), "the window submitted exactly one request");
  assert.equal(runRequests[0].sessionId, first.body.sessionId, `the helper test must use the conversation it opened, not a new Ask first conversation: ${JSON.stringify(runRequests)}`);
  const asks = () => app.runtime.approvals.waiting().filter((q) => parentOf() && f.helpersOf(parentOf()).includes(q.runId));
  const asking = await until(() => asks().length === 2);
  assert.ok(asking, asking ? "" : `control: each of her helpers asks before reading (window had open: ${await page.evaluate(async () => (await import("/app/core/state.js")).S.chat).catch((error) => error.message)}; window sent: ${sent.join(", ") || "nothing"}; box: "${await page.locator("#prompt").inputValue().catch((error) => error.message)}"; tasks: ${JSON.stringify(app.store.sqlite.prepare("SELECT id, prompt, status, session_id FROM tasks ORDER BY rowid").all())}; waiting: ${JSON.stringify(app.runtime.approvals.waiting().map(({ runId, sessionId, tool }) => ({ runId, sessionId, tool })))}; page errors: ${JSON.stringify(errors)}; toasts: ${await page.evaluate(() => [...document.querySelectorAll(".toast")].map((toast) => toast.textContent).join(" | "))})`);
  const [one, other] = asks();
  const listed = (await api("policy")).body.waiting.map((q) => q.fingerprint);
  assert.ok(listed.includes(one.fingerprint) && listed.includes(other.fingerprint), "her helpers' questions are hers to see");

  const eve = f.person("Eve", "1357");
  at(eve);
  try {
    assert.ok(!(await api("policy")).body.waiting.some((q) => [one.fingerprint, other.fingerprint].includes(q.fingerprint)), "Eve sees neither");
    const refused = await api("policy/approve", { sessionId: one.sessionId, decision: "allow", remember: "never", fingerprint: one.fingerprint, carryOn: true });
    assert.equal(refused.status, 404, "nor answers one");
  } finally { at(dana); }
  assert.equal(asks().length, 2, "nothing was answered for Eve");

  // In her window (started again by each switch): the frame says her helpers need her; Allow once answers that exact request.
  await openAs(f, app.store.run(parentOf()).sessionId);
  await page.locator(".hf18a .need18").waitFor({ timeout: 20000 });
  if (!(await page.locator(".hf18a.open").count())) await page.locator(".hfh18a").click();
  await page.locator(`.card18a [data-act="hpdo17c"][data-v="allow"][data-sid="${one.sessionId}"][data-fp="${one.fingerprint}"]`).click();
  assert.ok(await until(() => !asks().some((q) => q.runId === one.runId)), "her answer landed on that request");
  assert.ok(asks().some((q) => q.runId === other.runId), "and only that one");
  savePolicy(app.store, app.runtime.owner, before);
  const denied = await api("policy/approve", { sessionId: other.sessionId, decision: "deny", remember: "never", fingerprint: other.fingerprint, carryOn: true });
  assert.equal(denied.status, 200, JSON.stringify(denied.body));
  for (const release of f.gates.values()) release();
  assert.ok(await until(() => !["running", "needs_input"].includes(app.store.run(parentOf())?.status)), "her task settles");
  at(null);
  assert.deepEqual(errors, []);
});

test("she stops her own main task from the window, never anyone else's, and nobody else stops hers", async (t) => {
  const f = await fixture(t);
  const { app, api, page, errors, at } = f;
  const owner = await ownerAtWork(f);
  const { dana, parent } = await danaSends(f, "check Dana's receipts");
  assert.equal((await api(`runs/${owner.parent}/cancel`, {})).status, 404, "she never stops the owner's task");
  const eve = f.person("Eve", "1357");
  at(eve);
  try { assert.equal((await api(`runs/${parent}/cancel`, {})).status, 404, "Eve never stops Dana's"); } finally { at(dana); }
  assert.equal(app.store.run(parent).status, "running");
  // The window started again with each switch: back as Dana, her conversation still offers Stop for her working task.
  await openAs(f, app.store.run(parent).sessionId);
  await page.locator('[data-act="stop-run"]').waitFor({ timeout: 15000 });
  await page.locator('[data-act="stop-run"]').click();
  assert.ok(await until(() => app.store.run(parent).status === "cancelled"), "her Stop stopped her task");
  assert.equal(app.store.run(owner.parent).status, "running", "the owner's task carries on");
  assert.ok(owner.helpers.every((id) => app.store.run(id).status === "running"), "and his helpers");
  at(null);
  for (const who of ["alpha", "beta"]) f.gates.get(who)();
  await owner.done;
  assert.deepEqual(errors, []);
});
