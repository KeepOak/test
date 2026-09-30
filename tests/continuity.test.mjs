import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { Continuity } from "../dist/reach/continuity.js";
import { assertContinuitySession, assertContinuityTool, continuityRecords } from "../dist/reach/continuity-store.js";
import { pairInboxKey } from "../dist/reach/remote-trunks.js";
import { saveReachMode } from "../dist/reach/settings.js";
import { underShortLivedKey } from "../dist/key-context.js";
import { discardTemp } from "./temp-dir.mjs";

const owner = "local", done = { name: "fixture", complete: async () => ({ content: "Done.", toolCalls: [] }) };
const tokenOf = (row) => ({ id: row.id, generation: row.generation });
async function engine(t, provider = done) {
  const root = await mkdtemp(join(tmpdir(), "branch-continuity-"));
  const options = { workspace: join(root, "workspace"), dataDir: join(root, "data"), provider };
  const app = await createBranch(options);
  saveReachMode(app.store, owner, "machines", { mode: "on" });
  t.after(async () => { await app.close(); await discardTemp(root); });
  return { app, root, options };
}
async function until(check) {
  const expires = Date.now() + 10000;
  while (!check() && Date.now() < expires) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(check(), "condition completed before deadline");
}
async function pair(t, provider = done, sourceProvider = done) {
  const source = await engine(t, sourceProvider), destination = await engine(t, provider);
  const server = await startServer(destination.app, { dataDir: destination.options.dataDir, port: 0 });
  t.after(() => server.close());
  const key = destination.app.sessionTokens.create(owner, { name: "source", scope: "run", minutes: 5 });
  const sourceDirectory = { list: () => [{ id: "remote", name: "Remote", address: server.url, secret: "PAIRED", labels: [] }] };
  const destinationDirectory = { list: () => [{ id: "source", name: "Source", address: "http://127.0.0.1:1", secret: "UNUSED", labels: [] }] };
  pairInboxKey(destination.app.store, owner, { machine: "source", keyId: key.entry.id }, destinationDirectory.list());
  const link = { fetcher: fetch, secret: async () => key.token };
  const receiver = new Continuity(destination.app.runtime, destinationDirectory, link, () => {});
  destination.app.reachParts.continuity = receiver;
  const sender = new Continuity(source.app.runtime, sourceDirectory, link, () => {});
  return { source, destination, sender, receiver, sourceDirectory, destinationDirectory, link, key, server };
}

test("two engines: source stays fenced across close/reopen while remote writes; release returns ownership", async (t) => {
  let unblock, calls = 0;
  const waiting = new Promise((resolve) => { unblock = resolve; });
  const provider = { name: "continuity-fixture", async complete() {
    if (++calls <= 2) { await waiting; return { content: "", toolCalls: [{ id: `write${calls}`, name: "files.write", arguments: JSON.stringify({ path: "continued.txt", content: "remote continued" }) }] }; }
    return { content: "Remote task completed.", toolCalls: [] };
  } };
  const env = await pair(t, provider), { source, destination, sender, receiver } = env;
  destination.app.coding.setMode("read-first", "off"); // This fixture isolates continuity and the destination's approval gate.
  const prior = await source.app.runtime.run({ prompt: "A saved source conversation" });
  const receipt = await sender.start({ machine: "remote", sessionId: prior.sessionId, prompt: "Write continued.txt with remote continued." });
  assert.equal(receipt.state, "active");
  await assert.rejects(source.app.runtime.run({ sessionId: prior.sessionId, prompt: "duplicate" }), /continuity|held/i);
  await assert.rejects(source.app.registry.execute("files.read", { path: "nothing" }, source.app.runtime.context({ runId: prior.id })), /continuity|fenced/i);
  assert.throws(() => assertContinuitySession(destination.app.store, owner, receiver.list()[0].sessionId), /held/);
  await source.app.close();
  unblock();
  await until(() => destination.app.runtime.workingRuns().length === 0);
  const question = destination.app.runtime.approvals.waiting()[0];
  assert.equal(question?.tool, "files.write", "remote changes still require the destination's approval");
  const approved = await fetch(env.server.url + "/api/policy/approve", { method: "POST",
    headers: { authorization: `Bearer ${env.server.token}`, "content-type": "application/json" },
    body: JSON.stringify({ sessionId: question.sessionId, fingerprint: question.fingerprint, decision: "allow", remember: "never", carryOn: true }) });
  assert.equal(approved.status, 200, await approved.clone().text());
  await until(() => destination.app.runtime.workingRuns().length === 0);
  assert.equal(await readFile(join(destination.options.workspace, "continued.txt"), "utf8"), "remote continued");
  const reopened = await createBranch(source.options);
  t.after(() => reopened.close());
  const resumed = new Continuity(reopened.runtime, env.sourceDirectory, env.link, () => {});
  await assert.rejects(reopened.runtime.run({ sessionId: prior.sessionId, prompt: "still held" }), /continuity|held/i);
  assert.match((await resumed.status(tokenOf(receipt))).output, /completed/);
  assert.equal((await resumed.reclaim(tokenOf(receipt))).state, "released");
  assert.equal((await reopened.runtime.run({ sessionId: prior.sessionId, prompt: "Back here" })).status, "completed");
  assert.throws(() => assertContinuityTool(destination.app.store, owner, receiver.list()[0].runId), /fenced/);
  await reopened.close();
});

test("lost reply, repeated dispatch and stale generation cannot duplicate or unlock work", async (t) => {
  const env = await pair(t), sessionId = env.source.app.store.createSession(owner);
  let lose = true;
  const link = { ...env.link, fetcher: async (...args) => {
    const response = await fetch(...args);
    if (lose) { lose = false; await response.text(); throw new Error("response lost after acceptance"); }
    return response;
  } };
  const sender = new Continuity(env.source.app.runtime, env.sourceDirectory, link, () => {});
  await assert.rejects(sender.start({ machine: "remote", sessionId, prompt: "Carry on." }), /response lost/);
  const first = sender.list()[0], token = tokenOf(first);
  assert.throws(() => assertContinuitySession(env.source.app.store, owner, sessionId), /held/);
  await sender.dispatch(token);
  await sender.dispatch(token);
  assert.equal(env.receiver.list().length, 1);
  assert.equal(env.destination.app.store.runs(owner).length, 1);
  await assert.rejects(sender.reclaim({ ...token, generation: token.generation + 1 }), /superseded/);
  await sender.reclaim(token);
  await sender.start({ machine: "remote", sessionId, prompt: "Second transfer." });
  assert.equal(sender.list().at(-1).generation, first.generation + 1);
  await sender.reclaim(token); // Old release is idempotent, but never touches the newer fence.
  assert.throws(() => assertContinuitySession(env.source.app.store, owner, sessionId), /held/);
});

test("receive and release bind to paired key; session-bound keys and mutated receipts are refused", async (t) => {
  const env = await pair(t), payload = { id: randomUUID(), generation: 1, prompt: "Work" };
  assert.throws(() => env.receiver.receive(payload, "unpaired"), /Pair/);
  const received = env.receiver.receive(payload, env.key.entry.id);
  assert.throws(() => env.receiver.remoteStatus(tokenOf(received), "other-key"), /paired key/);
  await assert.rejects(env.receiver.release(tokenOf(received), "other-key"), /paired key/);
  assert.throws(() => env.receiver.receive({ ...payload, prompt: "Different" }, env.key.entry.id), /different work/);
  assert.throws(() => underShortLivedKey(() => env.receiver.receive({ ...payload, id: randomUUID() }, env.key.entry.id),
    { keyId: env.key.entry.id, sessionId: randomUUID() }), /conversation-bound/);
  const replacement = "owner-paired-replacement";
  pairInboxKey(env.destination.app.store, owner, { machine: "source", keyId: replacement }, env.destinationDirectory.list());
  assert.throws(() => env.receiver.remoteStatus(tokenOf(received), env.key.entry.id), /paired key/);
  await env.receiver.release(tokenOf(received), replacement);
  assert.equal(env.receiver.receive(payload, replacement).state, "released");
});

test("destination restart never replays an uncertain task; background programs prevent dispatch and release", async (t) => {
  const env = await pair(t), sessionId = env.source.app.store.createSession(owner);
  const sender = new Continuity(env.source.app.runtime, env.sourceDirectory, env.link, () => { throw new Error("Stop the managed background program first."); });
  await assert.rejects(sender.start({ machine: "remote", sessionId, prompt: "Carry on" }), /background program/);
  assert.equal(env.receiver.list().length, 0);
  assert.throws(() => assertContinuitySession(env.source.app.store, owner, sessionId), /held/);
  const actual = new Continuity(env.source.app.runtime, env.sourceDirectory, env.link, () => {});
  await actual.preview(tokenOf(sender.list()[0]));
  const result = await actual.dispatch(tokenOf(sender.list()[0]));
  await until(() => env.destination.app.runtime.workingRuns().length === 0);
  const restored = new Continuity(env.destination.app.runtime, env.destinationDirectory, env.link, () => { throw new Error("Remote program still runs."); });
  assert.equal(restored.remoteStatus(tokenOf(result), env.key.entry.id).state, "interrupted");
  assert.equal(env.destination.app.store.runs(owner).length, 1);
  await assert.rejects(restored.release(tokenOf(result), env.key.entry.id), /Remote program/);
  assert.equal(continuityRecords(env.destination.app.store, owner)[0].state, "stopping");
});

test("failed quiescence retains context intent and cannot fall through to a text-only dispatch", async (t) => {
  const env = await pair(t), run = await env.source.app.runtime.run({ prompt: "Preserve this task context" });
  let busy = true;
  const sender = new Continuity(env.source.app.runtime, env.sourceDirectory, env.link, () => {
    if (busy) throw new Error("Background work is still running");
  });
  await assert.rejects(sender.prepare({ machine: "remote", sessionId: run.sessionId, prompt: "Continue", includeContext: true }), /Background work/);
  const token = tokenOf(sender.list()[0]);
  busy = false;
  await assert.rejects(sender.dispatch(token), /preparing and reviewing/);
  assert.equal(env.receiver.list().length, 0);
  const preview = await sender.preview(token);
  assert.match(preview.contextText, /Preserve this task context/);
  await assert.rejects(sender.dispatch(token), /Preview and approve/);
  await sender.dispatch({ ...token, contextFingerprint: preview.contextFingerprint });
  assert.match(env.destination.app.store.runs(owner)[0].prompt, /Preserve this task context/);
});

test("HTTP run key has only peer protocol routes and cannot read or start owner transfers", async (t) => {
  const env = await pair(t);
  const request = (path, body, token = env.key.token) => fetch(env.server.url + path, {
    method: body ? "POST" : "GET", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  assert.equal((await request("/api/reach/continuity")).status, 401);
  assert.equal((await request("/api/reach/continuity/start", { machine: "source", sessionId: randomUUID(), prompt: "No" })).status, 401);
  const received = await request("/api/reach/continuity/receive", { id: randomUUID(), generation: 1, prompt: "Allowed paired work" });
  assert.equal(received.status, 200, await received.clone().text());
  const value = await received.json();
  assert.equal((await request("/api/reach/continuity/status", tokenOf(value))).status, 200);
  const other = env.destination.app.sessionTokens.create(owner, { name: "other", scope: "run", minutes: 5 });
  assert.equal((await request("/api/reach/continuity/release", tokenOf(value), other.token)).status, 403);
  assert.equal((await request("/api/reach/continuity/release", tokenOf(value))).status, 200);
});

test("context is captured only after local quiescence, previewed, scrubbed, and approved by fingerprint", async (t) => {
  const env = await pair(t), secret = "never-send-fixture-secret";
  env.source.app.store.secrets.scrubber.remember("FIXTURE", secret);
  const run = await env.source.app.runtime.run({ prompt: `Original task and selected context ${secret}` });
  const selected = await env.sender.prepare({ machine: "remote", sessionId: run.sessionId, prompt: "Finish the original task", includeContext: true });
  assert.match(selected.contextText, /Original task/);
  assert.doesNotMatch(selected.contextText, new RegExp(secret));
  assert.equal(env.receiver.list().length, 0, "preview itself sends nothing");
  await assert.rejects(env.sender.dispatch(tokenOf(selected)), /Preview and approve/);
  await env.sender.dispatch({ ...tokenOf(selected), contextFingerprint: selected.contextFingerprint });
  const remote = env.destination.app.store.runs(owner)[0];
  assert.match(remote.prompt, /Original task/);
  assert.match(remote.prompt, /quoted historical data/);
  assert.doesNotMatch(remote.prompt, new RegExp(secret));
  await env.sender.reclaim(tokenOf(selected));
  const cancelled = await env.sender.prepare({ machine: "remote", sessionId: run.sessionId, prompt: "Never sent", includeContext: true });
  await env.sender.reclaim(tokenOf(cancelled));
  assert.equal(env.receiver.list().length, 1, "cancelling a preview never contacts the destination");
  assert.doesNotThrow(() => assertContinuitySession(env.source.app.store, owner, run.sessionId));
});

test("source cancellation completes before remote execution; an unsent cancellation wins a racing dispatch", async (t) => {
  let stopped = false, entered = false;
  const sourceProvider = { name: "waiting", complete: ({ signal }) => new Promise((_resolve, reject) => {
    entered = true;
    signal.addEventListener("abort", () => { stopped = true; reject(signal.reason); }, { once: true });
  }) };
  const remoteProvider = { name: "checks-quiescence", async complete() {
    assert.equal(stopped, true, "source execution stopped before the destination's first model call");
    return { content: "Continued after source stopped", toolCalls: [] };
  } };
  const env = await pair(t, remoteProvider, sourceProvider), sessionId = env.source.app.store.createSession(owner);
  const local = env.source.app.runtime.run({ sessionId, prompt: "A task in flight" });
  await until(() => entered);
  const transferred = await env.sender.start({ machine: "remote", sessionId, prompt: "Continue now" });
  assert.equal((await local).status, "cancelled");
  await env.sender.reclaim(tokenOf(transferred));
  const preview = await env.sender.prepare({ machine: "remote", sessionId, prompt: "Cancel before sending", includeContext: false });
  const result = await Promise.allSettled([env.sender.reclaim(tokenOf(preview)), env.sender.dispatch(tokenOf(preview))]);
  assert.equal(result[0].status, "fulfilled");
  assert.equal(result[1].status, "rejected");
  assert.equal(env.receiver.list().length, 1);
  assert.doesNotThrow(() => assertContinuitySession(env.source.app.store, owner, sessionId));
});
