/**
 * QA retest 2026-09-28 (m4): reading a schedule's words is a task the engine keeps out of Recent, yet the window cheered
 * it ("New conversation is done", the name a conversation gets when no list shows it) and it counted toward the
 * conversations achievement ("5 conversations · Bronze" with three in the list). It now stays quiet in both, while a
 * Trunk's introduction (set aside, but its conversation is listed) is still cheered. Node only: the real dist/ and
 * public/, a scripted model, headless Chromium, port 0.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { signIn } from "./new-window-places.mjs";
import { discardTemp } from "./temp-dir.mjs";

const fresh = () => ({ through: 0, tools: {}, events: {} });

async function served(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-hidden-quiet-"));
  // Slow enough that the window sees each task running before it finishes, which is what it cheers.
  const provider = { name: "scripted", async complete() { await new Promise((r) => setTimeout(r, 1500)); return { content: "not a schedule", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "w"), dataDir: join(root, "d"), provider });
  const server = await startServer(app, { dataDir: join(root, "d"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const post = (path, body) => fetch(new URL(path, server.url), { method: "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  return { app, server, post };
}

test("a conversation holding only work kept out of Recent is not counted as the owner's", async (t) => {
  const { app, post } = await served(t);
  const count = () => app.store.achievementTallies("local", fresh()).tallies.conversations;
  await app.runtime.run({ prompt: "hello" });
  assert.equal(count(), 1, "control: the owner's own conversation counts");
  const refused = await post("/api/schedules/propose", { text: "when a receipt arrives in my email, file it" });
  assert.notEqual(refused.status, 200, "control: the words could not be read as a schedule");
  assert.ok(app.store.runs("local").some((run) => run.prompt === "Reading a schedule from your words"), "control: the engine read them in a task of its own");
  assert.equal(count(), 1, "that task's conversation does not count");
});

/* The window cheers a task it saw running and then finished (public/app/shell/cheer.js look()). The engine's reading of a
   schedule usually starts and ends inside one request, so the window is handed the two moments directly. */
test("the window does not cheer work no list shows, and still cheers a listed conversation", async (t) => {
  const { app, server, post } = await served(t);
  await post("/api/onboarding", { done: true });
  const listed = await app.runtime.run({ prompt: "a conversation of the owner's" });
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 }, serviceWorkers: "block" });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await signIn(page, server);
  const cheerAfter = (run) => page.evaluate(async (run) => {
    const [{ E }, { renderNow }] = await Promise.all([import("/app/core/state.js"), import("/app/core/dom.js")]);
    document.querySelector(".cheer11")?.remove();
    const others = (E.state.runs ?? []).filter((r) => r.id !== run.id);
    E.state = { ...E.state, runs: [{ ...run, status: "running" }, ...others] };
    renderNow();
    E.state = { ...E.state, runs: [{ ...run, status: "completed" }, ...others] };
    renderNow();
    await new Promise((r) => setTimeout(r, 300));
    return document.querySelector(".cheer11")?.textContent ?? null;
  }, run);
  const hidden = { id: "00000000-0000-4000-8000-000000000001", sessionId: "00000000-0000-4000-8000-000000000002",
    prompt: "Reading a schedule from your words", output: "", aside: true, createdAt: new Date().toISOString() };
  assert.equal(await cheerAfter(hidden), null, "work kept out of every list is not cheered");
  const shown = await cheerAfter({ ...listed, id: "00000000-0000-4000-8000-000000000003", output: "all done" });
  assert.match(String(shown), /all done/, "a listed conversation finishing is still cheered");
  assert.deepEqual(errors, []);
});
