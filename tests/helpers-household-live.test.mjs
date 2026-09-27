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
 *
 * Mutation notes (each turns this file red; each was tried):
 * - household-approvals.ts personTaskHere: drop the personProfileId check and the task in her lent conversation that
 *   was not started for her is read.
 * - household-approvals.ts personTaskHere: drop the conversation check and the task started for her in the owner's own
 *   conversation is read.
 * - server.ts /api/runs/:id/steps: drop `|| personTaskHere(...)` and Dana's frame never shows.
 * - server.ts /api/runs/:id cancel: drop `ownHelper` and Dana's Stop is refused.
 * - server.ts /api/activity: drop the lent list and Dana's window never learns her task works.
 * - collab-server.ts runForCurrentPerson: drop the hand-back in `catch` and a thrown task's helpers stay the owner's.
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
  return { app, api, page, errors, person, at, helpersOf, runBy, release: (who) => model.gates.get(who)?.(), ...model };
}

/** The owner's task with two helpers held mid-work, started as the owner. */
async function ownerAtWork(f) {
  const done = f.app.runtime.run({ prompt: "check the owner's invoices", permissions: [...f.app.runtime.context().permissions] });
  assert.ok(await until(() => f.gates.has("alpha") && f.gates.has("beta")), "control: the owner's helpers work");
  const parent = f.runBy("check the owner's invoices");
  return { done, parent, helpers: f.helpersOf(parent) };
}

test("a household person sees, stops and steers their own task's helpers live, and never the owner's", async (t) => {
  const f = await fixture(t);
  const { app, api, page, errors, at, helpersOf, runBy, gates, requests } = f;
  const owner = await ownerAtWork(f);
  const dana = f.person("Dana", "4826");
  at(dana);
  const first = await api("run", { prompt: "hello" }); // her own conversation, handed back to her when done
  assert.equal(first.status, 200);
  const sid = first.body.sessionId;
  await page.reload();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 60000 });
  await page.evaluate((id) => { location.hash = "open=" + id; }, sid);
  await page.locator("#prompt").waitFor({ timeout: 15000 });
  await page.locator("#prompt").fill("check Dana's receipts");
  await page.locator("#prompt").press("Enter");
  assert.ok(await until(() => gates.has("gamma") && gates.has("delta")), "control: her helpers work");
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
  // Her own task, not a helper: the lending's rule for a task stands (no stop through the helpers' door).
  assert.equal((await api(`runs/${parent}/cancel`, {})).status, 404, "the helpers' door opens for helpers only");

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
