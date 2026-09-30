import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdir, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { discardTemp } from "./temp-dir.mjs";
import { PublicationQueue } from "../dist/self-development-publication.js";
import { matchingPublication } from "../dist/self-development-publication-lookup.js";
import { computerGhPublicationFinder } from "../dist/integrations/gh-pull-request.js";
import { GitHubAccess } from "../dist/integrations/github.js";

const intent = { cwd: "/source/work", workspace: "/source", remote: "origin", pushRepo: "owner/project", pushAddress: "https://github.com/owner/project.git", repository: "owner/project", branch: "branch/change", base: "redesign/window", sha: "a".repeat(40), walked: "b".repeat(40), contractHash: "c".repeat(64), files: ["src/a.ts"], opening: { repo: "owner/project", title: "Change", body: "Reason", base: "redesign/window", head: "branch/change", draft: true }, runId: "run-1", adapter: "saved" };
function fixture(t) {
  const db = new DatabaseSync(":memory:"); t.after(() => db.close());
  let now = 1000, pushed = 0, opened = 0, remote = null, pr = null;
  const io = { validate: async () => {}, remote: async () => remote,
    push: async () => { pushed++; remote = intent.sha; }, find: async () => pr,
    open: async () => { opened++; pr = { number: 1 }; return pr; } };
  const queue = () => new PublicationQueue(db, "owner", io, () => now);
  return { db, io, queue, advance: () => { now += 4_000_000; }, counts: () => ({ pushed, opened }) };
}

test("RES711 persists an outage and resumes exact publication once after restart", async (t) => {
  const f = fixture(t), q = f.queue(), entry = q.enqueue(intent);
  f.io.remote = async () => { throw new Error("connect ECONNREFUSED ghp_PRIVATE"); };
  const first = await q.attempt(entry.id, new AbortController().signal);
  assert.equal(first.state, "waiting"); assert.equal(first.attempts, 1);
  assert.equal(JSON.stringify(q.list()).includes("ghp_PRIVATE"), false);
  f.io.remote = async () => null; f.advance();
  assert.equal((await f.queue().attempt(entry.id, new AbortController().signal)).state, "published");
  assert.deepEqual(f.counts(), { pushed: 1, opened: 1 });
  assert.equal(q.enqueue(intent).id, entry.id);
  await q.attempt(entry.id, new AbortController().signal);
  assert.deepEqual(f.counts(), { pushed: 1, opened: 1 });
});

test("RES711 reconciles lost create response before repeating and never repeats push", async (t) => {
  const f = fixture(t), q = f.queue(), entry = q.enqueue(intent);
  let exists = false, calls = 0;
  f.io.find = async () => exists ? { number: 7 } : null;
  f.io.open = async () => { calls++; exists = true; throw new Error("socket hang up"); };
  assert.equal((await q.attempt(entry.id, new AbortController().signal)).state, "waiting");
  f.advance();
  assert.equal((await f.queue().attempt(entry.id, new AbortController().signal)).state, "published");
  assert.equal(calls, 1); assert.equal(f.counts().pushed, 1);
});

test("RES711 blocks policy changes and changed remote heads; cancellation stops retries", async (t) => {
  const f = fixture(t), q = f.queue(), entry = q.enqueue(intent);
  f.io.remote = async () => "d".repeat(40);
  assert.equal((await q.attempt(entry.id, new AbortController().signal)).state, "blocked");
  assert.deepEqual(f.counts(), { pushed: 0, opened: 0 });
  const second = q.enqueue({ ...intent, branch: "branch/second" });
  f.io.validate = async () => { throw new Error("permission denied ghp_PRIVATE"); };
  assert.equal((await q.attempt(second.id, new AbortController().signal)).state, "blocked");
  const third = q.enqueue({ ...intent, branch: "branch/third" });
  q.cancel(third.id);
  assert.equal((await q.attempt(third.id, new AbortController().signal)).state, "cancelled");
});

test("RES711 serializes simultaneous attempts and stops after finite retries", async (t) => {
  const f = fixture(t), q = f.queue(), entry = q.enqueue(intent);
  await Promise.all([q.attempt(entry.id, new AbortController().signal), f.queue().attempt(entry.id, new AbortController().signal)]);
  assert.deepEqual(f.counts(), { pushed: 1, opened: 1 });
  const second = q.enqueue({ ...intent, branch: "branch/outage" });
  f.io.remote = async () => { throw new Error("ETIMEDOUT"); };
  for (let i = 0; i < 10; i++) { await q.attempt(second.id, new AbortController().signal); f.advance(); }
  assert.equal(q.get(second.id).state, "blocked");
  assert.equal(q.get(second.id).attempts, 6);
});

test("RES711 lost push response reconciles the remote without sending twice", async (t) => {
  const f = fixture(t), q = f.queue(), entry = q.enqueue(intent);
  let remote = null, pushes = 0;
  f.io.remote = async () => remote;
  f.io.push = async () => { pushes++; remote = intent.sha; throw new Error("connection reset"); };
  assert.equal((await q.attempt(entry.id, new AbortController().signal)).state, "waiting");
  assert.equal((await q.attempt(entry.id, new AbortController().signal)).attempts, 1, "backoff is respected");
  f.advance();
  assert.equal((await f.queue().attempt(entry.id, new AbortController().signal)).state, "published");
  assert.equal(pushes, 1);
});

test("RES711 cancellation while push completes prevents creating a PR", async (t) => {
  const f = fixture(t), q = f.queue(), entry = q.enqueue(intent);
  f.io.push = async () => { q.cancel(entry.id); };
  assert.equal((await q.attempt(entry.id, new AbortController().signal)).state, "cancelled");
  assert.equal(f.counts().opened, 0);
});

const lookup = { repo: intent.repository, pushRepo: intent.pushRepo, branch: intent.branch, base: intent.base, sha: intent.sha };
const pr = { number: 7, html_url: "https://github.com/owner/project/pull/7", state: "closed",
  head: { ref: intent.branch, sha: intent.sha, repo: { full_name: intent.pushRepo } },
  base: { ref: intent.base, repo: { full_name: intent.repository } } };

test("RES711 exact lookup includes closed PRs and refuses mismatched heads", () => {
  assert.equal(matchingPublication(lookup, [pr]).number, 7);
  assert.equal(matchingPublication(lookup, []), null);
  assert.throws(() => matchingPublication(lookup, [{ ...pr, head: { ...pr.head, sha: "d".repeat(40) } }]), /different head/);
  assert.throws(() => matchingPublication(lookup, {}), /incomplete/);
  assert.throws(() => matchingPublication(lookup, [pr, pr]), /ambiguous/);
});

test("RES711 saved token and computer sign-in lookup adapters are read-only and exact", async () => {
  const signal = new AbortController().signal;
  let requested;
  const github = new GitHubAccess({}, { assertAllowed: async () => {} }, async () => "test-token", async (url, options) => {
    requested = { url: String(url), method: options.method };
    return new Response(JSON.stringify([pr]), { status: 200 });
  });
  assert.equal((await github.findPublication(lookup, signal)).number, 7);
  assert.equal(requested.method, "GET"); assert.match(requested.url, /state=all/);
  const finder = computerGhPublicationFinder((_file, args, _options, done) => {
    assert.deepEqual(args.slice(0, 2), ["api", "--method=GET"]);
    assert.match(args[2], /state=all/); done(null, JSON.stringify([pr]), ""); return { stdin: null };
  });
  assert.equal((await finder(lookup, signal)).number, 7);
});

test("RES711 GitHub 503 retries and 401 blocks without storing token-bearing errors", async (t) => {
  const f = fixture(t), q = f.queue(), entry = q.enqueue(intent);
  f.io.find = async () => { throw Object.assign(new Error("redacted upstream details"), { status: 503 }); };
  assert.equal((await q.attempt(entry.id, new AbortController().signal)).state, "waiting");
  f.advance();
  f.io.find = async () => { throw Object.assign(new Error("bad credentials ghp_PRIVATE"), { status: 401 }); };
  assert.equal((await q.attempt(entry.id, new AbortController().signal)).state, "blocked");
  assert.equal(JSON.stringify(q.list()).includes("ghp_PRIVATE"), false);
});

test("RES711 old terminal history cannot starve due publication", async (t) => {
  const f = fixture(t), q = f.queue();
  for (let i = 0; i < 505; i++) q.cancel(q.enqueue({ ...intent, branch: `branch/old-${i}` }).id);
  const entry = q.enqueue(intent);
  await q.drain(new AbortController().signal);
  assert.equal(q.get(entry.id).state, "published");
});

test("RES711 explicit retry rechecks policy; cancelled and published intents stay terminal", async (t) => {
  const f = fixture(t), q = f.queue(), entry = q.enqueue(intent), signal = new AbortController().signal;
  f.io.validate = async () => { throw new Error("permission denied"); };
  await q.attempt(entry.id, signal);
  assert.equal((await q.retry(entry.id, signal)).state, "blocked");
  assert.deepEqual(f.counts(), { pushed: 0, opened: 0 });
  f.io.validate = async () => {};
  assert.equal((await q.retry(entry.id, signal)).state, "published");
  await q.retry(entry.id, signal);
  const cancelled = q.enqueue({ ...intent, branch: "branch/cancelled" }); q.cancel(cancelled.id);
  assert.equal((await q.retry(cancelled.id, signal)).state, "cancelled");
  assert.deepEqual(f.counts(), { pushed: 1, opened: 1 });
});

test("RES711 interrupted process recovers persisted uncertain PR after its lease expires", async (t) => {
  const scratch = join(tmpdir(), "Codex-session-files"); await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "publication-restart-"));
  const path = join(root, "queue.sqlite"), db = new DatabaseSync(path);
  const io = { validate: async () => {}, remote: async () => intent.sha, find: async () => ({ number: 8 }),
    push: async () => assert.fail("already pushed"), open: async () => assert.fail("already created") };
  const q = new PublicationQueue(db, "owner", io, () => 0), entry = q.enqueue(intent);
  const crashed = { ...entry, state: "sending", phase: "open", attempts: 1, nextAttemptAt: 600_000 };
  db.prepare("UPDATE self_development_publications SET data=?,state=?,due=? WHERE id=?")
    .run(JSON.stringify(crashed), crashed.state, crashed.nextAttemptAt, entry.id);
  db.close();
  const reopened = new DatabaseSync(path); t.after(async () => { reopened.close(); await discardTemp(root); });
  const recovered = new PublicationQueue(reopened, "owner", io, () => 600_001);
  assert.equal((await recovered.attempt(entry.id, new AbortController().signal)).state, "published");
});
