/* Q52: a finished task says what it made and how that was checked, from its own record only: each file it wrote
   or changed and each artifact it kept, with the proof its tool's receipt gives; the project checks it ran and the
   reviewer's verdict; and, for a change to Branch's own source, how far that got, with merged and "in a release"
   left "unknown" because nothing records them. Headless only. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { signIn } from "./new-window-places.mjs";
import { discardTemp } from "./temp-dir.mjs";
import { Receipts } from "../dist/receipts.js";
import { runResult } from "../dist/results.js";
import { audit } from "../dist/audit.js";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { openChat } from "./open-chat.mjs"; // trunk-one-row: one row per Trunk

const receipts = new Receipts({ key: async () => Buffer.alloc(32, 7) });
const run = { id: "r1", sessionId: "s1", prompt: "Write the report", status: "completed", createdAt: "", updatedAt: "" };
let next = 0;
const ev = (kind, data = {}) => ({ id: `e${next++}`, runId: "r1", kind, data, createdAt: new Date(1_000 + next).toISOString() });
const done = async (id, name, result) => ev("tool.completed", { id, name, result, receipt: await receipts.sign("r1", id, name, result) });

test("Q52 each file a task wrote is listed once, under the tool that wrote it, with that tool's proof", async () => {
  const events = [
    ev("tool.started", { id: "t1", name: "files.write", path: "report.md" }),
    ev("file.changed", { path: "report.md", existed: false, added: 3, removed: 0 }),
    await done("t1", "files.write", { ok: true }),
    ev("tool.started", { id: "t2", name: "files.edit", path: "report.md" }),
    ev("file.changed", { path: "report.md", existed: true, added: 1, removed: 1 }),
    await done("t2", "files.edit", { ok: true }),
    ev("tool.started", { id: "t3", name: "files.write", path: "notes.txt" }),
    ev("file.changed", { path: "notes.txt", existed: true }),
    ev("tool.failed", { id: "t3", name: "files.write", error: "disk full" }),
  ];
  const result = await runResult(receipts, run, events);
  assert.deepEqual(result.made.map(({ kind, path, tool, created, proof }) => [kind, path, tool, created, proof]), [
    ["file", "report.md", "files.write", true, "success"],
    ["file", "notes.txt", "files.write", false, "failed"],
  ]);
  assert.deepEqual(result.checked, []);
  assert.equal(result.ownChange, null, "not Branch's own source");
});

test("Q52 writes that run side by side are each put under the tool about that path", async () => {
  const events = [
    ev("tool.started", { id: "a", name: "files.write", path: "a.txt" }),
    ev("tool.started", { id: "b", name: "files.edit", path: "b.txt" }),
    ev("file.changed", { path: "a.txt", existed: false }),
    ev("file.changed", { path: "b.txt", existed: true }),
    await done("b", "files.edit", { ok: true }),
    ev("tool.failed", { id: "a", name: "files.write", error: "no" }),
  ];
  const made = (await runResult(receipts, run, events)).made;
  assert.deepEqual(made.map((one) => [one.path, one.tool, one.proof]), [["a.txt", "files.write", "failed"], ["b.txt", "files.edit", "success"]]);
});

test("Q52 a result edited after it was recorded, or with no receipt, says so", async () => {
  const signed = await done("t1", "artifacts.save", { path: "out/chart.png", sha256: "ab" });
  const edited = { ...signed, data: { ...signed.data, result: { path: "out/chart.png", sha256: "cd" } } };
  const artifact = await runResult(receipts, run, [ev("tool.started", { id: "t1", name: "artifacts.save" }), edited]);
  assert.deepEqual(artifact.made.map(({ kind, path, proof }) => [kind, path, proof]), [["artifact", "out/chart.png", "modified"]]);
  const bare = await runResult(receipts, run, [ev("tool.started", { id: "t9", name: "files.write", path: "x" }), ev("file.changed", { path: "x" }),
    ev("tool.completed", { id: "t9", name: "files.write", result: { ok: true } })]);
  assert.equal(bare.made[0].proof, "unsigned");
  const orphan = await runResult(receipts, run, [ev("file.changed", { path: "y" })]);
  assert.equal(orphan.made[0].proof, "not recorded", "a change with no tool is not given a proof it lacks");
});

test("Q52 the checks it ran and the reviewer's verdict, and how far its own change got", async () => {
  const events = [
    ev("tool.started", { id: "p1", name: "branch.prepare_source_change" }),
    ev("file.changed", { path: "src/a.ts", existed: true }),
    await done("p1", "branch.prepare_source_change", { ok: true }),
    ev("code.check", { ok: false, status: "2 tests failed", exitCode: 1 }),
    ev("code.check", { ok: true, status: "all tests passed", exitCode: 0 }),
    ev("verify.verdict", { pass: true, verdict: "accept", fixes: [] }),
  ];
  const result = await runResult(receipts, run, events);
  assert.deepEqual(result.checked.map(({ kind, passed }) => [kind, passed]), [["project check", false], ["project check", true], ["review", true]]);
  assert.deepEqual(result.ownChange, { codeChanged: true, tests: "passed", review: "not opened", merged: "unknown", inRelease: "unknown" });
  const opened = await runResult(receipts, run, [...events.slice(0, 4),
    ev("pull_request.opened", { repository: "KeepOak/Branch-Agent", number: 1, address: "https://github.com/KeepOak/Branch-Agent/pull/1" })]);
  assert.deepEqual([opened.ownChange.tests, opened.ownChange.review], ["failed", "pending"], "the last check counts; a PR is a review pending");
  const unnamed = await runResult(receipts, run, [...events.slice(0, 4), ev("pull_request.opened", { url: "https://example.test/pr/1" })]);
  assert.equal(unnamed.ownChange.review, "not opened", "a note with no repository and number is not a pull request");
  const untested = await runResult(receipts, run, [ev("tool.started", { id: "p2", name: "branch.prepare_source_change" })]);
  assert.deepEqual([untested.ownChange.codeChanged, untested.ownChange.tests], [false, "not run"]);
});

/** A model that answers from a script, so a real task runs through the real runtime. */
const scripted = (steps) => ({ name: "scripted", async complete() { return steps.shift() ?? { content: "Done.", toolCalls: [] }; } });

test("Q52 a real task that writes a file: the result names it, proven, and the Activity pane says so", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-results-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: scripted([
    { content: "", toolCalls: [{ id: "w1", name: "files.write", arguments: JSON.stringify({ path: "hello.txt", content: "hello" }) }] },
    { content: "Wrote hello.txt.", toolCalls: [] },
  ]) });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const finished = await app.runtime.run({ prompt: "write hello" });
  assert.equal(finished.status, "completed");
  const call = (path) => fetch(new URL(path, server.url), { headers: { authorization: `Bearer ${server.token}` } });
  const result = await (await call(`/api/runs/${finished.id}/result`)).json();
  assert.deepEqual(result.made.map(({ kind, path, tool, created, proof }) => [kind, path, tool, created, proof]),
    [["file", "hello.txt", "files.write", true, "success"]]);
  assert.equal(result.ownChange, null);
  assert.equal((await call(`/api/runs/${finished.id}/result`.replace(finished.id, "00000000-0000-0000-0000-000000000000"))).status, 404);

  const httpCall = (path, body) => fetch(new URL(path, server.url), {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).then((response) => response.json());
  await httpCall("/api/onboarding", { done: true });
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 }, reducedMotion: "reduce" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await signIn(page, server);
  errors.length = 0;
  // Redesign: the conversation's side panel (data-act="pane"), its Files tab: each file the conversation's tasks touched,
  // with Made or Changed (prototype.html's pane "files"; public/app/chat/pane.js).
  await openChat(page, finished.sessionId);
  await page.locator("#conversation .u").first().waitFor({ timeout: 15000 });
  await page.locator('[data-act="pane"][data-p="activity"]').first().click();
  await page.locator('#pane [data-v="files"], #pane .ptab').filter({ hasText: "Files" }).first().click();
  const row = page.locator('#pane [data-act="fileopen"][data-n="hello.txt"]');
  await row.waitFor({ timeout: 15000 });
  assert.equal(await row.locator(".pill").innerText(), "Made");
  // Redesign: replaced by the new window (prototype.html's Files row has no "checked and confirmed" proof line, and the new
  // window has no /i18n.js French); the proof itself is the engine's, asserted on GET /api/runs/<id>/result above.
  assert.deepEqual(errors, []);
});


test("SELF-028 a pull request is only the opening tool's own repository and number", async () => {
  const { pullRequestReference } = await import("../dist/self-development-results.js");
  const repo = "KeepOak/Branch-Agent";
  assert.deepEqual(pullRequestReference(repo, { number: 7, address: "https://github.com/KeepOak/Branch-Agent/pull/7" }),
    { repository: repo, number: 7, address: "https://github.com/KeepOak/Branch-Agent/pull/7" });
  // The computer's own gh answers with the address only; the number is read from it.
  assert.deepEqual(pullRequestReference(repo, { url: "https://github.com/keepoak/branch-agent/pull/12?x=1#top" }),
    { repository: repo, number: 12, address: "https://github.com/keepoak/branch-agent/pull/12" });
  assert.deepEqual(pullRequestReference(undefined, { repository: repo, number: 3 }), { repository: repo, number: 3, address: null });
  for (const [why, repository, result] of [
    ["an address on another repository", repo, { number: 7, address: "https://github.com/someone/else/pull/7" }],
    ["a number the address does not say", repo, { number: 8, address: "https://github.com/KeepOak/Branch-Agent/pull/7" }],
    ["an address that is not https", repo, { url: "http://github.com/KeepOak/Branch-Agent/pull/7" }],
    ["an address carrying a sign-in", repo, { url: "https://user:pass@github.com/KeepOak/Branch-Agent/pull/7" }],
    ["an address that is not a pull request", repo, { url: "https://github.com/KeepOak/Branch-Agent/issues/7" }],
    ["no number at all", repo, { title: "Branch: fix" }],
    ["a number that is not a whole positive number", repo, { number: -1 }],
    ["a repository that is not owner/name", "KeepOak/Branch-Agent/extra", { number: 7 }],
    ["no repository", undefined, { number: 7 }],
  ]) assert.equal(pullRequestReference(repository, result), null, `accepted ${why}`);
});

test("SELF-028 \"merged repo#n\" comes only from a merge tool's result or the owner's merge record", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-results-merged-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const owner = app.runtime.owner, sha = "a".repeat(40), repository = "KeepOak/Branch-Agent";
  const task = { ...app.store.createRun(owner, "fix Branch"), status: "completed" };
  const opened = [ev("tool.started", { id: "p1", name: "branch.prepare_source_change" }),
    ev("pull_request.opened", { repository, number: 42, address: "https://github.com/KeepOak/Branch-Agent/pull/42", branch: "b", base: "main", files: 1 })];
  const merged = async (events) => (await runResult(receipts, task, [...opened, ...events], app.store)).ownChange.merged;
  assert.equal(await merged([]), "unknown", "an opened pull request is not a merge");
  // Anything but a merge tool's own result with its commit leaves it unknown.
  assert.equal(await merged([await done("m1", "github.merge_pull_request", { merged: true, repository, number: 42 })]), "unknown", "no commit");
  assert.equal(await merged([await done("m2", "web.fetch", { merged: true, sha, repository, number: 42 })]), "unknown", "not a merge tool");
  assert.equal(await merged([ev("pull_request.opened", { repository, number: 42, merged: true, sha })]), "unknown", "the task's own note");
  assert.equal(await merged([ev("model.completed", { content: "Merged KeepOak/Branch-Agent#42." })]), "unknown", "the model's words");
  const fromTool = await runResult(receipts, task, [...opened, await done("m3", "github.merge_pull_request", { merged: true, sha, repository, number: 42 })], app.store);
  assert.equal(fromTool.ownChange.merged, "merged keepoak/branch-agent#42");
  assert.deepEqual([fromTool.pullRequests[0].mergeEvidence, fromTool.pullRequests[0].mergeSha], ["tool result", sha]);
  // The owner's merge record counts only for a pull request this task opened, and only a merge.
  const record = (subject, outcome) => audit(app.store, owner, { action: "self_development.merge", actor: owner, subject,
    reason: "test", source: "owner", outcome });
  record(`${repository}#99 ${sha}`, "merged");
  record(`${repository}#42 ${sha}`, "approved");
  assert.equal(await merged([]), "unknown", "another pull request's merge, or an approval, is not this one's merge");
  record(`${repository}#42 ${"b".repeat(40)}`, "merged");
  const fromAudit = await runResult(receipts, task, opened, app.store);
  assert.equal(fromAudit.ownChange.merged, "merged keepoak/branch-agent#42");
  assert.deepEqual([fromAudit.pullRequests[0].mergeEvidence, fromAudit.pullRequests[0].reviewedHead], ["owner audit", "b".repeat(40)]);
  assert.equal(fromAudit.ownChange.inRelease, "unknown", "a merge is not a release");
});
