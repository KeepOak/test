/**
 * DESIGN-DIRECTION PR 1: the helpers frame steers or stops one helper (a task another task started) mid fan-out, by
 * `POST /api/runs/<helper>/steer` and `/cancel`, and reads each helper's start time and newest step from
 * `GET /api/runs/<parent>/steps` (helpers[].startedAt, helpers[].lastStep). A scripted model; no provider.
 *
 * - Stopping one helper leaves its sibling and the task that started it running; both then finish.
 * - A steer note reaches only the helper it was sent to, never its sibling or the parent.
 * - Only the owner (or the person the task was started for) acts on a helper: a short-lived key never steers one, a
 *   key stops one only when it started the task, and under Lockdown a helper that can reach a tool Lockdown refuses
 *   is not steered.
 *
 * Mutation notes (each turns this file red):
 * - src/helper-control.ts helperSteerRefusal: drop the startedWithShortLivedKey() line and the key steers the helper.
 * - src/helper-control.ts helperSteerRefusal: drop the lockdown line and the helper that can run code is steered.
 * - src/server.ts: drop the helperSteerRefusal call on the steer route and both refusals are gone.
 * - src/run-steps.ts helpersOf: drop `startedAt` or `lastStep` and the helper data test fails.
 * - src/runtime.ts cancel: abort every controller instead of the one asked for and the sibling is stopped too.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { setLockdown } from "../dist/lockdown.js";
import { startServer } from "../dist/server.js";

const say = (content) => ({ content, toolCalls: [] });
const call = (name, args) => ({ content: "", toolCalls: [{ id: `c${Math.random().toString(36).slice(2, 9)}`, name, arguments: JSON.stringify(args) }] });
const until = async (check) => { for (let i = 0; i < 400 && !(await check()); i++) await new Promise((r) => setTimeout(r, 25)); return check(); };
const text = (request) => request.messages.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n");

/**
 * The parent fans out to the helpers named in the owner's message; each helper reads a note, then works (held until
 * the test lets it go or it is stopped), reads again, and says it is done. Every request is kept by who made it.
 */
function scripted(app) {
  const gates = new Map(), requests = { parent: [] };
  const provider = { name: "scripted", async complete(request) {
    const system = String(request.messages[0]?.content ?? "");
    const who = /You are the (\w+)\./.exec(system)?.[1];
    if (!who) {
      requests.parent.push(request);
      const last = request.messages.at(-1);
      if (last.role === "tool") return say("Both helpers answered.");
      const tasks = app.fanTo.map((specialist, index) => ({ specialist, prompt: `job ${index + 1}: look at the invoices` }));
      return call("delegate.parallel", { tasks });
    }
    // The specialist's own evaluation, before it is promoted: it only has to answer.
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
  const root = await mkdtemp(join(tmpdir(), "branch-helpers-steer-"));
  const holder = {};
  const model = scripted(holder);
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: model.provider });
  Object.assign(holder, { fanTo: [] });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  await writeFile(join(app.runtime.workspace, "notes.txt"), "the invoices");
  const api = async (path, body, bearer = server.token) => {
    const response = await fetch(`${server.url}/api/${path}`, { method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  /** An evaluated, promoted specialist (as tests/orchestration.test.mjs makes one). */
  const specialist = async (name, permissions = ["files.read"]) => {
    const context = app.runtime.context();
    const proposed = await app.registry.execute("specialists.propose", {
      name, instructions: `You are the ${name}.`, permissions,
      evaluation: { prompt: "say ready", checks: [{ path: `${name}.txt`, expected: "ready" }] },
    }, context);
    await writeFile(join(app.runtime.workspace, `${name}.txt`), "ready");
    await app.registry.execute("specialists.evaluate", { id: proposed.id }, context);
    await app.registry.execute("specialists.promote", { id: proposed.id }, context);
    return proposed.id;
  };
  /** Starts the owner's task fanning out to these specialists and waits until every helper is held mid-work. */
  const fanOut = async (ids, names) => {
    holder.fanTo = ids;
    const done = app.runtime.run({ prompt: "compare the invoices", permissions: [...app.runtime.context().permissions] });
    assert.ok(await until(() => names.every((name) => model.gates.has(name))), "control: every helper is working");
    const parent = app.store.sqlite.prepare("SELECT id FROM tasks WHERE prompt='compare the invoices'").get().id;
    const helpers = (await api(`runs/${parent}/steps`)).body.helpers;
    const byName = Object.fromEntries(names.map((name, i) => [name, helpers.find((h) => h.job.startsWith(`job ${i + 1}:`))]));
    return { done, parent: String(parent), byName };
  };
  return { app, api, server, specialist, fanOut, ...model };
}

test("PR1: each helper carries its start time and its newest step in plain words", async (t) => {
  const { app, api, specialist, fanOut, gates } = await fixture(t);
  const ids = [await specialist("alpha"), await specialist("beta")];
  const { done, parent, byName } = await fanOut(ids, ["alpha", "beta"]);
  const body = (await api(`runs/${parent}/steps`)).body;
  assert.equal(body.helpers.length, 2, JSON.stringify(body.helpers));
  for (const helper of Object.values(byName)) {
    assert.equal(helper.status, "running");
    assert.equal(helper.startedAt, app.store.run(helper.runId).createdAt, "started when its task was made");
    assert.ok(Date.parse(helper.startedAt) >= Date.parse(app.store.run(parent).createdAt), "after its parent");
    assert.equal(helper.lastStep?.kind, "tool", JSON.stringify(helper.lastStep));
    assert.match(helper.lastStep.title, /notes\.txt/, "the tool's own label, naming what it reads");
    assert.doesNotMatch(helper.lastStep.title, /^\{/, "plain words, not the call's input");
  }
  for (const release of gates.values()) release();
  assert.equal((await done).status, "completed");
});

test("PR1: stopping one helper leaves its sibling and its parent running", async (t) => {
  const { app, api, specialist, fanOut, gates } = await fixture(t);
  const ids = [await specialist("alpha"), await specialist("beta")];
  const { done, parent, byName } = await fanOut(ids, ["alpha", "beta"]);
  const stopped = await api(`runs/${byName.alpha.runId}/cancel`, {});
  assert.deepEqual(stopped.body, { cancelled: true }, JSON.stringify(stopped.body));
  assert.ok(await until(() => app.store.run(byName.alpha.runId).status === "cancelled"), "the helper asked for is stopped");
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(app.store.run(byName.beta.runId).status, "running", "its sibling carries on");
  assert.equal(app.store.run(parent).status, "running", "the task that started it carries on");
  gates.get("beta")();
  const finished = await done;
  assert.equal(finished.status, "completed", finished.output);
  assert.equal(app.store.run(byName.beta.runId).status, "completed", "the sibling finished its work");
  assert.equal(app.store.run(byName.alpha.runId).status, "cancelled");
});

test("PR1: a steer note reaches only the helper it was sent to", async (t) => {
  const { app, api, specialist, fanOut, gates, requests } = await fixture(t);
  const ids = [await specialist("alpha"), await specialist("beta")];
  const { done, byName } = await fanOut(ids, ["alpha", "beta"]);
  const note = "only the August invoices";
  const steered = await api(`runs/${byName.alpha.runId}/steer`, { text: note });
  assert.deepEqual(steered.body, { queued: 1 }, JSON.stringify(steered.body));
  for (const release of gates.values()) release();
  assert.equal((await done).status, "completed");
  assert.match(text(requests.alpha.at(-1)), new RegExp(note), "the helper read the note on its next round");
  assert.ok(requests.beta.every((r) => !text(r).includes(note)), "its sibling never saw it");
  assert.ok(requests.parent.every((r) => !text(r).includes(note)), "the parent never saw it");
  assert.equal(app.store.events(byName.alpha.runId).filter((e) => e.kind === "run.steer_applied").length, 1);
  assert.equal(app.store.events(byName.beta.runId).filter((e) => e.kind === "run.steered").length, 0);
});

test("PR1: a short-lived key never steers a helper, and stops one only when it started the task", async (t) => {
  const { app, api, specialist, fanOut, gates } = await fixture(t);
  const ids = [await specialist("alpha"), await specialist("beta")];
  const { done, byName } = await fanOut(ids, ["alpha", "beta"]);
  const key = app.sessionTokens.create(app.runtime.owner, { name: "script", scope: "run", minutes: 5 }).token;
  const steer = await api(`runs/${byName.alpha.runId}/steer`, { text: "stop checking" }, key);
  assert.equal(steer.status, 403, JSON.stringify(steer.body));
  assert.match(steer.body.error, /short-lived key cannot steer a helper/);
  assert.equal(app.store.events(byName.alpha.runId).filter((e) => e.kind === "run.steered").length, 0, "nothing was queued");
  const stop = await api(`runs/${byName.alpha.runId}/cancel`, {}, key);
  assert.equal(stop.status, 401, JSON.stringify(stop.body));
  assert.equal(app.store.run(byName.alpha.runId).status, "running", "the key stopped nothing");
  // The owner's own steer goes through, as a control.
  assert.deepEqual((await api(`runs/${byName.alpha.runId}/steer`, { text: "carry on" })).body, { queued: 1 });
  for (const release of gates.values()) release();
  await done;
});

test("PR1: a household person cannot steer or stop the owner's helper", async (t) => {
  const { app, api, specialist, fanOut, gates } = await fixture(t);
  const ids = [await specialist("alpha"), await specialist("beta")];
  const { done, byName } = await fanOut(ids, ["alpha", "beta"]);
  const dana = app.store.profiles.create({ name: "Dana", pin: "4826" });
  app.store.profiles.switch({ profileId: dana.id, pin: "4826" });
  const steer = await api(`runs/${byName.alpha.runId}/steer`, { text: "stop checking" });
  const stop = await api(`runs/${byName.beta.runId}/cancel`, {});
  app.store.profiles.switch({ profileId: null });
  assert.equal(steer.status, 404, JSON.stringify(steer.body));
  assert.equal(stop.status, 404, JSON.stringify(stop.body));
  assert.equal(app.store.run(byName.beta.runId).status, "running");
  assert.equal(app.store.events(byName.alpha.runId).filter((e) => e.kind === "run.steered").length, 0);
  for (const release of gates.values()) release();
  await done;
});

test("PR1: under Lockdown a helper that can run code is not steered; one that only reads still is", async (t) => {
  const { app, api, specialist, fanOut, gates } = await fixture(t);
  const ids = [await specialist("alpha"), await specialist("gamma", ["files.read", "code.execute"])];
  const { done, byName } = await fanOut(ids, ["alpha", "gamma"]);
  setLockdown(app.store, app.runtime.owner, { on: true });
  const refused = await api(`runs/${byName.gamma.runId}/steer`, { text: "run the cleanup script" });
  assert.equal(refused.status, 403, JSON.stringify(refused.body));
  assert.match(refused.body.error, /Lockdown is on/);
  assert.equal(app.store.events(byName.gamma.runId).filter((e) => e.kind === "run.steered").length, 0);
  assert.deepEqual((await api(`runs/${byName.alpha.runId}/steer`, { text: "just the totals" })).body, { queued: 1 },
    "a helper that reaches nothing Lockdown shut is still steered");
  // Stop is never refused by Lockdown: it only lowers the risk.
  assert.deepEqual((await api(`runs/${byName.gamma.runId}/cancel`, {})).body, { cancelled: true });
  for (const [name, release] of gates) if (name !== "gamma") release();
  await done;
});
