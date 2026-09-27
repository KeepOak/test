import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createBranch } from "../dist/index.js";
import { saveSeasonsSettings } from "../dist/seasons/settings.js";
import { undoNight, keep, veto, viewCandidate } from "../dist/seasons/journal.js";
import { discardTemp } from "./temp-dir.mjs";

const fixtureKey = "not-a-real-key-rings-fixture";
const tonight = () => { const now = new Date(); now.setDate(now.getDate() + 1); now.setHours(3, 0, 0, 0); return now; };
async function jsonBody(request) {
  const chunks = []; for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
/** Real HTTP protocol fixture. No production backend method is replaced. */
async function service(t) {
  const state = { facts: new Map(), puts: 0, deletes: 0, authFailures: 0, refuseDelete: false, refusePut: false, noOpPut: false };
  const server = createServer((request, response) => { void handle(request, response).catch(() => { response.writeHead(500); response.end(); }); });
  const answer = (response, status, data) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(data)); };
  async function handle(request, response) {
    if (request.headers["x-fixture-key"] !== fixtureKey) { state.authFailures++; return answer(response, 401, {}); }
    const path = new URL(request.url, "http://fixture").pathname.split("/").slice(2).map(decodeURIComponent);
    const [owner, id] = path, key = `${owner}:${id}`;
    if (request.method === "GET") {
      if (!id || id === "search") return answer(response, 200, [...state.facts.values()].filter((fact) => fact.owner === owner));
      return answer(response, state.facts.has(key) ? 200 : 404, state.facts.get(key) ?? {});
    }
    if (request.method === "DELETE") {
      state.deletes++;
      return answer(response, 200, { deleted: state.refuseDelete ? false : state.facts.delete(key) });
    }
    if (request.method === "PUT") {
      state.puts++;
      if (state.refusePut) return answer(response, 503, {});
      const before = state.facts.get(key), now = new Date().toISOString();
      const fact = { id, owner, data: await jsonBody(request), createdAt: before?.createdAt ?? now, updatedAt: now, revision: (before?.revision ?? 0) + 1 };
      if (!state.noOpPut) state.facts.set(key, fact);
      return answer(response, 200, fact);
    }
    return answer(response, 405, {});
  }
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { state, url: `http://127.0.0.1:${server.address().port}` };
}
async function fixture(t, { outside = true, onRem, twoFacts = false, billed = false } = {}) {
  const temp = process.platform === "win32" ? "C:/Users/bishi/AppData/Local/Temp/Codex-session-files" : tmpdir();
  await mkdir(temp, { recursive: true });
  const root = await mkdtemp(join(temp, "branch-rings-boundaries-"));
  let app;
  const seen = { rem: 0 };
  const provider = { name: "grounded-fixture", async complete(request) {
    const text = request.messages.filter((m) => m.role === "user").map((m) => m.content).join("\n");
    if (!text.includes("You read requests one person typed")) return { content: "done", toolCalls: [] };
    seen.rem++; await onRem?.(app);
    const quotes = text.split("\n").filter((line) => /^\[\d+\] /.test(line)).map((line) => ({ n: Number(/^\[(\d+)\]/.exec(line)[1]), words: line.replace(/^\[\d+\] /, "") }));
    const texts = ["The owner is vegetarian", ...(twoFacts ? ["The owner prefers cedar notebooks"] : [])];
    return { content: JSON.stringify({ facts: texts.map((text) => ({ text, kind: "preference", confidence: 0.9, quotes })) }), toolCalls: [] };
  } };
  const options = { dataDir: join(root, "data"), workspace: join(root, "workspace"),
    presets: [{ id: "default", name: "Boundary fixture", provider, model: "m", endpoint: billed ? "https://fixture.invalid/v1" : "http://127.0.0.1:11434/v1" }] };
  app = await createBranch(options);
  t.after(async () => { await app.close(); await discardTemp(root); });
  const first = await app.runtime.run({ prompt: "I am vegetarian and I prefer cedar notebooks, plan dinners" });
  await app.runtime.run({ prompt: "I am vegetarian and I prefer cedar notebooks, plan lunch", sessionId: first.sessionId });
  await app.runtime.run({ prompt: "I am vegetarian and I prefer cedar notebooks, plan supper" });
  let remote;
  if (outside) {
    remote = await service(t);
    app.web.policy.configure({ allowPrivateAddresses: true });
    // Only the secret reader is a fixture; the actual backend still authenticates every real HTTP request.
    app.memory.backend.secret = async (name) => { assert.equal(name, "RINGS_FIXTURE_KEY"); return fixtureKey; };
    app.memory.backend.configure("local", { mode: "outside", url: remote.url, header: "X-Fixture-Key", secret: "RINGS_FIXTURE_KEY" });
  }
  const reopen = async () => {
    await app.close(); app = await createBranch(options);
    app.web.policy.configure({ allowPrivateAddresses: true });
    app.memory.backend.secret = async (name) => { assert.equal(name, "RINGS_FIXTURE_KEY"); return fixtureKey; };
    return app;
  };
  return { app, remote, seen, reopen };
}
async function acceptedNight(app) {
  const { night } = await app.rings.night({ scope: "local", person: null }, tonight());
  const candidate = app.rings.book.candidates("local")[0];
  const accepted = await app.store.review.decide("local", candidate.proposalId, true);
  return { night, candidate, accepted };
}

test("outside Rings Undo and Keep verify actual backend state and retain the exact fact id across concurrent retries", async (t) => {
  const setup = await fixture(t);
  let { app } = setup;
  const { remote, reopen } = setup;
  const { night, candidate, accepted } = await acceptedNight(app);
  assert.equal(accepted.proposal.appliedReceipt.record.id, accepted.applied.id);
  assert.equal(accepted.proposal.appliedReceipt.destination.url, remote.url);
  assert.doesNotMatch(JSON.stringify(accepted.proposal.appliedReceipt), new RegExp(fixtureKey));
  for (let i = 0; i < 505; i++) app.rings.book.saveCandidate({ ...candidate, id: randomUUID(), text: `Unrelated candidate ${i}`,
    status: "pending", proposalId: null, memoryId: null, promotedNight: null });
  assert.ok(!app.rings.book.candidates("local").some((entry) => entry.id === candidate.id));
  app = await reopen();
  assert.equal(app.rings.book.candidate("local", candidate.id).id, candidate.id);
  const receipt = app.store.review.proposal("local", candidate.proposalId).appliedReceipt;
  await assert.rejects(app.memory.backend.setAsideAt("profile:unrelated", accepted.applied.id, receipt, "not allowed"), /belongs to someone else/);
  await assert.rejects(app.memory.backend.setAsideAt("local", accepted.applied.id, { ...receipt, record: { ...receipt.record, id: randomUUID() } }, "wrong id"), /different fact/);
  assert.equal(remote.state.deletes, 0);
  await Promise.all([undoNight(app.store, app.rings.book, "local", night.night), undoNight(app.store, app.rings.book, "local", night.night)]);
  assert.equal(remote.state.facts.size, 0, "the service actually deleted it; a local tombstone alone is insufficient");
  assert.equal((await app.memory.backend.search("local", "vegetarian")).length, 0);
  assert.equal(remote.state.deletes, 1);
  assert.equal(app.rings.book.night("local", night.night).status, "undone");
  assert.equal(app.store.backup("test").tables.memory_outside_archive, undefined);
  assert.equal(app.store.backup("test").tables.memory_proposal_receipts, undefined);
  await Promise.all([keep(app.store, app.rings.book, "local", candidate.id), keep(app.store, app.rings.book, "local", candidate.id)]);
  assert.equal(remote.state.puts, 2, "one acceptance and one restoration");
  assert.equal((await app.memory.backend.search("local", "vegetarian"))[0].id, accepted.applied.id);
  assert.equal(app.rings.book.candidate("local", candidate.id).status, "promoted");
  await veto(app.store, app.rings.book, "local", candidate.id);
  assert.equal(remote.state.facts.size, 0);
  for (let i = 0; i < 505; i++) app.rings.book.saveCandidate({ ...candidate, id: randomUUID(), text: `Other later candidate ${i}`,
    status: "pending", proposalId: null, memoryId: null, promotedNight: null });
  const repeated = app.rings.book.addMention("local", candidate.text, candidate.kind, { ...candidate.evidence[0], runId: randomUUID() });
  assert.equal(repeated.id, candidate.id, "a veto survives the recent-list boundary");
  assert.equal(repeated.status, "vetoed");
  await keep(app.store, app.rings.book, "local", candidate.id);
  assert.equal(remote.state.facts.size, 1);
  assert.equal(remote.state.authFailures, 0);
});

test("a changed provider cannot redirect Undo or credentials to an unrelated service with the same fact id", async (t) => {
  const { app, remote } = await fixture(t);
  const { night, candidate, accepted } = await acceptedNight(app);
  const other = await service(t);
  other.state.facts.set(`local:${accepted.applied.id}`, { ...accepted.applied, data: { ...accepted.applied.data, text: "An unrelated fact" } });
  app.memory.backend.configure("local", { url: other.url });
  await assert.rejects(undoNight(app.store, app.rings.book, "local", night.night), /same service and credential/);
  assert.equal(other.state.deletes, 0);
  assert.equal(remote.state.facts.size, 1);
  assert.equal(app.rings.book.night("local", night.night).status, "done");
  assert.equal(viewCandidate(app.store, "local", app.rings.book.candidate("local", candidate.id)).status, "promoted");
  app.memory.backend.configure("local", { mode: "built-in" });
  await assert.rejects(undoNight(app.store, app.rings.book, "local", night.night), /same service and credential/);
  app.memory.backend.configure("local", { mode: "outside", url: remote.url });
  remote.state.facts.set(`local:${accepted.applied.id}`, { ...accepted.applied, data: { ...accepted.applied.data, text: "An unrelated replacement" } });
  await assert.rejects(undoNight(app.store, app.rings.book, "local", night.night), /changed outside Branch/);
  assert.equal(remote.state.deletes, 0);
  assert.equal(app.rings.book.night("local", night.night).status, "done");
  remote.state.facts.set(`local:${accepted.applied.id}`, accepted.applied);
  await undoNight(app.store, app.rings.book, "local", night.night);
  assert.equal(remote.state.facts.size, 0);
  assert.equal(other.state.facts.size, 1);
  assert.equal(other.state.authFailures, 0);
});

test("failed remote actions preserve journal status and Restore refuses occupied IDs before retrying safely", async (t) => {
  const { app, remote } = await fixture(t);
  const { night, candidate, accepted } = await acceptedNight(app);
  remote.state.refuseDelete = true;
  await assert.rejects(undoNight(app.store, app.rings.book, "local", night.night), /still holds this fact/);
  assert.equal(app.rings.book.night("local", night.night).status, "done");
  assert.equal((await app.memory.backend.search("local", "vegetarian")).length, 1);
  remote.state.refuseDelete = false;
  await undoNight(app.store, app.rings.book, "local", night.night);
  remote.state.facts.set(`local:${accepted.applied.id}`, { ...accepted.applied, data: { ...accepted.applied.data, text: "Someone changed this fact" } });
  await assert.rejects(keep(app.store, app.rings.book, "local", candidate.id), /not overwritten/);
  assert.equal(remote.state.puts, 1);
  assert.equal(app.rings.book.candidate("local", candidate.id).status, "undone");
  remote.state.facts.clear(); remote.state.refusePut = true;
  await assert.rejects(keep(app.store, app.rings.book, "local", candidate.id), /refused/);
  assert.equal(app.rings.book.candidate("local", candidate.id).status, "undone");
  remote.state.refusePut = false;
  remote.state.noOpPut = true;
  await assert.rejects(keep(app.store, app.rings.book, "local", candidate.id), /did not confirm/);
  assert.equal(app.rings.book.candidate("local", candidate.id).status, "undone");
  assert.equal(remote.state.facts.size, 0);
  remote.state.noOpPut = false;
  await keep(app.store, app.rings.book, "local", candidate.id);
  assert.equal((await app.memory.backend.search("local", "vegetarian"))[0].id, accepted.applied.id);
});

test("switching Rings off inside REM stops an automatic night before any memory promotion", async (t) => {
  const { app, seen } = await fixture(t, { outside: false, onRem: (app) => saveSeasonsSettings(app.store, "local", { rings: "off" }) });
  const { night } = await app.rings.night({ scope: "local", person: null }, tonight(), false);
  assert.equal(night.status, "paused");
  assert.equal(app.store.list("memory", "local").length, 0);
  app.rings.tick(tonight()); await app.rings.idle();
  assert.equal(seen.rem, 1, "Off also prevents a scheduler retry");
});

test("the switch is re-read before every promotion, not only at phase entry", async (t) => {
  const { app } = await fixture(t, { outside: false, twoFacts: true });
  const decide = app.store.review.decide.bind(app.store.review);
  app.store.review.decide = async (...args) => { const result = await decide(...args); saveSeasonsSettings(app.store, "local", { rings: "off" }); return result; };
  const { night } = await app.rings.night({ scope: "local", person: null }, tonight(), false);
  assert.equal(night.status, "paused");
  assert.equal(app.store.list("memory", "local").length, 1);
  assert.equal(night.data.deep.promoted.length, 1);
});

test("revoking paid-model permission during REM pauses the billed night without keeping its facts", async (t) => {
  const { app } = await fixture(t, { outside: false, billed: true, onRem: (app) => saveSeasonsSettings(app.store, "local", { paidModels: false }) });
  saveSeasonsSettings(app.store, "local", { paidModels: true });
  const { night } = await app.rings.night({ scope: "local", person: null }, tonight(), false);
  assert.equal(night.status, "paused");
  assert.equal(app.store.list("memory", "local").length, 0);
});
