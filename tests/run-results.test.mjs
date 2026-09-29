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
  const opened = await runResult(receipts, run, [...events.slice(0, 4), ev("pull_request.opened", { url: "https://example.test/pr/1" })]);
  assert.deepEqual([opened.ownChange.tests, opened.ownChange.review], ["failed", "pending"], "the last check counts; a PR is a review pending");
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

