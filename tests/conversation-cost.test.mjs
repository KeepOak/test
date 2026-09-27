/**
 * DG-101: what a whole conversation probably cost, for the far end of the line under the message box
 * (public/conversation-facts.js). One task with no price makes the answer unknown, so a partial sum is never
 * shown as a total; a finished task's cost is kept rather than read from its events every few seconds (Q35).
 * Node only.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { discardTemp } from "./temp-dir.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-conversation-cost-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const server = await startServer(app, { port: 0, dataDir: join(root, "data") });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const cost = (session, token = server.token) => fetch(new URL(`/api/sessions/${session}/cost`, server.url), {
    headers: { authorization: `Bearer ${token}` },
  });
  return { app, server, cost };
}

test("conversation cost tells a known free task from an unknown one or a missing conversation", async (t) => {
  const { app, cost } = await fixture(t);
  const run = app.store.createRun(app.runtime.owner, "Free local task");
  assert.deepEqual(await (await cost(run.sessionId)).json(), { amount: null, currency: "USD" });
  app.store.event(run.id, "model.complete", { model: "local-model" });
  assert.deepEqual(await (await cost(run.sessionId)).json(), { amount: 0, currency: "USD" });
  app.store.createRun(app.runtime.owner, "Unknown task", run.sessionId);
  assert.equal((await (await cost(run.sessionId)).json()).amount, null, "one task with no price makes the total unknown");
  assert.equal((await cost(randomUUID())).status, 404);
});

test("conversation cost is signed in, per profile, and gives a conversation's key no more than before", async (t) => {
  const { app, cost } = await fixture(t);
  const ownerRun = app.store.createRun(app.runtime.owner, "Owner task");
  assert.equal((await cost(ownerRun.sessionId, "invalid")).status, 401);
  const key = app.sessionTokens.create(app.runtime.owner, { scope: "read", minutes: 5, sessionId: ownerRun.sessionId });
  assert.equal((await cost(ownerRun.sessionId, key.token)).status, 401, "the route is not on a bound key's list");
  const person = app.store.profiles.create({ name: "Household", pin: "1234" });
  app.store.profiles.switch({ profileId: person.id, pin: "1234" });
  // Q261: reading fails closed for a household person at the window, and the window never asks for a conversation's
  // cost, so it is refused in the one sentence, the owner's conversation and their own alike.
  assert.equal((await cost(ownerRun.sessionId)).status, 400);
  const personalRun = app.store.createRun(app.store.profiles.scope(), "Personal task");
  assert.equal((await cost(personalRun.sessionId)).status, 400);
  app.store.profiles.switch({ profileId: null });
  assert.equal((await cost(personalRun.sessionId)).status, 404);
  assert.equal((await cost(ownerRun.sessionId)).status, 200);
});

test("a finished task's cost is worked out once, not on every refresh, until its prices change", async (t) => {
  const { app, cost } = await fixture(t);
  const run = app.store.createRun(app.runtime.owner, "A finished task");
  app.store.event(run.id, "model.complete", { model: "local-model" });
  app.store.finish(run.id, "completed", "Done.");
  const events = app.store.events.bind(app.store);
  let reads = 0;
  app.store.events = (runId) => { if (runId === run.id) reads += 1; return events(runId); };
  for (let i = 0; i < 4; i += 1) assert.equal((await (await cost(run.sessionId)).json()).amount, 0);
  assert.equal(reads, 1, "four refreshes read the finished task's events once");
  // New prices mean it is worked out again, once.
  app.store.save("settings", app.runtime.owner, "pricing", { overrides: { "local-model": { input: 1, output: 1 } } });
  await cost(run.sessionId);
  await cost(run.sessionId);
  assert.equal(reads, 2, "a change of prices is picked up, then kept again");
});
