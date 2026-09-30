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
import { archiveBuiltIn } from "../dist/memory-journal.js";
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
  const proposal = app.store.review.proposal("local", candidate.proposalId);
  const accepted = proposal.status === "accepted"
    ? { proposal, applied: app.store.get("memory", "local", proposal.appliedId) }
    : await app.store.review.decide("local", candidate.proposalId, true);
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

test("opposing journal actions on one outside fact settle in request order without affecting other facts", async (t) => {
  const { app, remote } = await fixture(t);
  const { candidate, accepted } = await acceptedNight(app);
  const first = veto(app.store, app.rings.book, "local", candidate.id);
  const second = keep(app.store, app.rings.book, "local", candidate.id);
  await Promise.all([first, second]);
  assert.equal(app.rings.book.candidate("local", candidate.id).status, "promoted");
  assert.deepEqual(remote.state.facts.get(`local:${accepted.applied.id}`).data, accepted.applied.data);
  await veto(app.store, app.rings.book, "local", candidate.id);
  const third = keep(app.store, app.rings.book, "local", candidate.id);
  const fourth = veto(app.store, app.rings.book, "local", candidate.id);
  await Promise.all([third, fourth]);
  assert.equal(app.rings.book.candidate("local", candidate.id).status, "vetoed");
  assert.equal(remote.state.facts.has(`local:${accepted.applied.id}`), false);
  assert.equal(remote.state.puts, 3);
  assert.equal(remote.state.deletes, 3);
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

test("built-in Veto and Undo refuse owner-edited facts using the exact accepted receipt", async (t) => {
  const { app } = await fixture(t, { outside: false });
  const { night, candidate, accepted } = await acceptedNight(app);
  const edited = { ...accepted.applied.data, text: "Owner edited this after acceptance" };
  app.store.save("memory", "local", accepted.applied.id, edited);
  await assert.rejects(veto(app.store, app.rings.book, "local", candidate.id), /changed after acceptance/);
  await assert.rejects(undoNight(app.store, app.rings.book, "local", night.night), /changed after acceptance/);
  await assert.rejects(app.memory.backend.setAsideAt("local", accepted.applied.id, accepted.proposal.appliedReceipt, "fixture"), /changed after acceptance/);
  assert.deepEqual(app.store.get("memory", "local", accepted.applied.id).data, edited);
  assert.equal(app.store.archivedMemory("local").length, 0);
  assert.equal(app.rings.book.night("local", night.night).status, "done");
  assert.equal(viewCandidate(app.store, "local", app.rings.book.candidate("local", candidate.id)).status, "promoted");
});

test("a proposal missing its accepted receipt cannot treat an edited fact as the original after restart", async (t) => {
  const setup = await fixture(t, { outside: false });
  let app = setup.app;
  const { night, candidate, accepted } = await acceptedNight(app);
  app.store.sqlite.prepare("DELETE FROM memory_proposal_receipts WHERE owner=? AND proposal_id=?")
    .run("local", candidate.proposalId);
  app = await setup.reopen();
  assert.equal(app.store.review.proposal("local", candidate.proposalId).appliedReceipt, null);
  const edited = { ...accepted.applied.data, text: "Owner edited this after the receipt was lost" };
  app.store.save("memory", "local", accepted.applied.id, edited);
  await assert.rejects(veto(app.store, app.rings.book, "local", candidate.id), /Acceptance has no receipt/);
  await assert.rejects(undoNight(app.store, app.rings.book, "local", night.night), /Acceptance has no receipt/);
  assert.deepEqual(app.store.get("memory", "local", accepted.applied.id).data, edited);
  assert.equal(app.store.archivedMemory("local").length, 0);
  assert.equal(app.rings.book.night("local", night.night).status, "done");
  assert.equal(app.rings.book.candidate("local", candidate.id).status, "promoted");
});

test("built-in Keep refuses an occupied id or edited archive and preserves journal state before safe retry", async (t) => {
  const { app } = await fixture(t, { outside: false });
  const { night, candidate, accepted } = await acceptedNight(app);
  await undoNight(app.store, app.rings.book, "local", night.night);
  const unrelated = app.store.save("memory", "local", accepted.applied.id, { text: "Unrelated owner fact", source: "owner" }).data;
  await assert.rejects(keep(app.store, app.rings.book, "local", candidate.id), /changed after acceptance/);
  await assert.rejects(app.memory.backend.restoreAt("local", accepted.applied.id, accepted.proposal.appliedReceipt), /changed after acceptance/);
  assert.deepEqual(app.store.get("memory", "local", accepted.applied.id).data, unrelated);
  assert.equal(app.rings.book.candidate("local", candidate.id).status, "undone");
  assert.deepEqual(app.store.archivedMemory("local")[0].data, accepted.applied.data);
  app.store.sqlite.prepare("DELETE FROM memory WHERE owner=? AND id=?").run("local", accepted.applied.id);
  app.store.sqlite.prepare("UPDATE memory_archive SET data=? WHERE owner=? AND id=?").run(JSON.stringify(unrelated), "local", accepted.applied.id);
  await assert.rejects(keep(app.store, app.rings.book, "local", candidate.id), /changed after acceptance/);
  assert.equal(app.store.get("memory", "local", accepted.applied.id), undefined);
  app.store.sqlite.prepare("UPDATE memory_archive SET data=? WHERE owner=? AND id=?").run(JSON.stringify(accepted.applied.data), "local", accepted.applied.id);
  await Promise.all([keep(app.store, app.rings.book, "local", candidate.id), keep(app.store, app.rings.book, "local", candidate.id)]);
  assert.deepEqual(app.store.get("memory", "local", accepted.applied.id).data, accepted.applied.data);
  assert.equal(app.store.archivedMemory("local").length, 0);
  assert.equal(app.rings.book.candidate("local", candidate.id).status, "promoted");
});

test("built-in receipt restoration preserves every accepted field including expiry", async (t) => {
  const { app } = await fixture(t, { outside: false });
  const record = app.store.save("memory", "local", randomUUID(), { text: "Expired fixture", expiresAt: "2000-01-01T00:00:00.000Z" });
  const receipt = { destination: { kind: "built-in" }, record };
  assert.throws(() => archiveBuiltIn(app.store, "profile:foreign", record.id, receipt, "fixture"), /receipt belongs to a different fact/);
  await assert.rejects(app.memory.backend.setAsideAt("profile:foreign", record.id, receipt, "fixture"), /someone else/);
  await app.memory.backend.setAsideAt("local", record.id, receipt, "fixture");
  await app.memory.backend.restoreAt("local", record.id, receipt);
  assert.deepEqual(app.store.get("memory", "local", record.id).data, record.data);
});

test("manual nights share one in-flight reading while another person's night remains independent", async (t) => {
  let entered, release;
  const began = new Promise((resolve) => { entered = resolve; });
  const held = new Promise((resolve) => { release = resolve; });
  const { app, seen } = await fixture(t, { outside: false, onRem: async () => { entered(); await held; } });
  const clock = tonight();
  const one = app.rings.night({ scope: "local", person: null }, clock);
  const two = app.rings.night({ scope: "local", person: null }, clock);
  await began;
  try {
    const person = app.store.profiles.create({ name: "Independent night", pin: "1234" });
    const other = await app.rings.night({ scope: `profile:${person.id}`, person: person.id }, clock);
    assert.equal(other.night.status, "done");
    assert.equal(seen.rem, 1);
  } finally { release(); }
  assert.deepEqual(await one, await two);
  await app.rings.idle();
  assert.equal(seen.rem, 1);
});

test("400 earlier foreign requests cannot starve the owner's later evidence or leak into it", async (t) => {
  const { app } = await fixture(t, { outside: false });
  const baseline = Date.now() + 1000;
  app.rings.book.moveCursor("local", new Date(baseline).toISOString());
  for (let n = 0; n < 405; n++) {
    const run = app.store.createRun("local", `Foreign evidence ${n}`);
    app.store.event(run.id, "run.started", { source: "owner", personProfileId: "someone-else" });
    app.store.finish(run.id, "completed", "fixture");
    app.store.sqlite.prepare("UPDATE tasks SET created_at=? WHERE id=?").run(new Date(baseline + 1).toISOString(), run.id);
  }
  const actual = app.store.createRun("local", "Owner evidence beyond the pre-filter page");
  app.store.event(actual.id, "run.started", { source: "owner" });
  app.store.finish(actual.id, "completed", "fixture");
  app.store.sqlite.prepare("UPDATE tasks SET created_at=? WHERE id=?").run(new Date(baseline + 2).toISOString(), actual.id);
  assert.deepEqual(app.rings.requests({ scope: "local", person: null }).map((one) => one.runId), [actual.id]);
  assert.equal(app.rings.book.cursor("local"), new Date(baseline).toISOString(), "reading does not advance another person's evidence cursor");
});

test("a night resumes at the exact task after 60 same-timestamp requests, including across restart", async (t) => {
  const setup = await fixture(t, { outside: false });
  let app = setup.app;
  const baseline = new Date(Date.now() + 1000).toISOString();
  const tiedAt = new Date(Date.parse(baseline) + 1).toISOString();
  app.store.sqlite.exec("DROP TABLE seasons_cursor; CREATE TABLE seasons_cursor(scope TEXT PRIMARY KEY, through TEXT NOT NULL)");
  app.store.sqlite.prepare("INSERT INTO seasons_cursor VALUES(?,?)").run("local", baseline);
  app = await setup.reopen();
  assert.deepEqual(app.rings.book.cursorPosition("local"), { at: baseline, id: "" }, "old timestamp-only rows migrate without replaying evidence");
  const runIds = [];
  for (let n = 0; n < 61; n++) {
    const run = app.store.createRun("local", `Owner request from one batch ${n}`);
    app.store.event(run.id, "run.started", { source: "owner" });
    app.store.finish(run.id, "completed", "fixture");
    app.store.sqlite.prepare("UPDATE tasks SET created_at=? WHERE id=?").run(tiedAt, run.id);
    runIds.push(run.id);
  }
  const first = app.rings.requests({ scope: "local", person: null });
  assert.equal(first.length, 60);
  assert.ok(first.every((request) => request.at === tiedAt && runIds.includes(request.runId)));
  const firstNight = await app.rings.night({ scope: "local", person: null }, tonight());
  assert.equal(firstNight.night.status, "done");
  assert.equal(firstNight.night.data.read, 60);
  assert.deepEqual(app.rings.book.cursorPosition("local"), { at: tiedAt, id: first.at(-1).runId });
  app = await setup.reopen();
  const tail = app.rings.requests({ scope: "local", person: null });
  assert.equal(tail.length, 1, "the tied request after the cap remains visible after restart");
  assert.ok(runIds.includes(tail[0].runId));
  assert.ok(!first.some((request) => request.runId === tail[0].runId));
  const next = tonight(); next.setDate(next.getDate() + 1);
  const secondNight = await app.rings.night({ scope: "local", person: null }, next);
  assert.equal(secondNight.night.data.read, 1);
  assert.deepEqual(app.rings.book.cursorPosition("local"), { at: tiedAt, id: tail[0].runId });
  assert.equal(app.rings.requests({ scope: "local", person: null }).length, 0);
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
