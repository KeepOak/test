/**
 * NAS 0adb368: the window said "Noted. It carries on in its conversation." when the monthly budget refused the
 * carry-on. The Inbox card's words now follow what the answer did: carried on, or still waiting.
 * Redesign: the new window's Inbox row (public/app/places/inbox.js askRow, answered by chat/chat.js answer()) has no
 * "Noted. …" sentence (prototype.html has none), so the old #policy-waiting card and #policy-status line are gone. What
 * it does instead follows the engine's answer: "carrying-on" follows the task until it has finished; "still-waiting" opens
 * the conversation where the task still waits, shows nothing working there, and the Inbox badge still counts it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, savePolicy } from "../dist/index.js";
import { startServer, carryOnWords } from "../dist/server.js";

function writer() {
  let file = "";
  return { name: "writer", async complete(request) {
    const last = request.messages.at(-1);
    const named = /^write (\S+)/.exec(String(last?.content ?? ""));
    if (last?.role === "user" && named) file = named[1];
    if (last?.role === "user" && (named || last.content === carryOnWords))
      return { content: "", toolCalls: [{ id: `w${Math.random()}`, name: "files.write", arguments: JSON.stringify({ path: file, content: "hello" }) }] };
    return { content: "Done.", toolCalls: [] };
  } };
}

test("the Inbox says it carries on only when it does, and that it still waits when the budget stops it", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-answered-ui-"));
  const workspace = join(root, "workspace");
  const app = await createBranch({ workspace, dataDir: join(root, "data"), provider: writer() });
  savePolicy(app.store, app.runtime.owner, { preset: "ask-before-changes" });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  await fetch(new URL("/api/onboarding", server.url), { method: "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify({ done: true }) });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block" });
  const errors = [], answers = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("response", async (response) => {
    if (new URL(response.url()).pathname === "/api/policy/approve") answers.push((await response.json().catch(() => ({}))).task);
  });
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  const badge = () => page.locator('#side [data-act="view"][data-v="inbox"] .cnt');
  const allowInInbox = async (run, want) => {
    await page.locator('#side [data-act="view"][data-v="inbox"]').click();
    const allow = page.locator(`#main [data-act="ask"][data-v="allow"][data-sid="${run.sessionId}"]`);
    await allow.waitFor({ timeout: 30000 });
    await allow.click();
    for (let i = 0; i < 200 && answers.length < want; i++) await page.waitForTimeout(50);
  };

  const first = await app.runtime.run({ prompt: "write u1.txt" });
  assert.equal(first.status, "needs_input", "control: the first task waits");
  await allowInInbox(first, 1);
  assert.equal(answers.at(-1), "carrying-on");
  // It carries on: its row leaves the Inbox, what it asked for is done, and nothing waits any more.
  await page.locator(`#main [data-act="ask"][data-sid="${first.sessionId}"]`).waitFor({ state: "detached", timeout: 20000 });
  for (let i = 0; i < 100 && !existsSync(join(workspace, "u1.txt")); i++) await page.waitForTimeout(50);
  assert.equal(existsSync(join(workspace, "u1.txt")), true, "the carry-on wrote the file");
  await badge().waitFor({ state: "detached", timeout: 20000 });

  // A second task asks; then the budget is reached, so its carry-on is refused as it starts.
  const second = await app.runtime.run({ prompt: "write u2.txt" });
  assert.equal(second.status, "needs_input", "control: a second task waits");
  app.store.save("settings", app.runtime.owner, "usage_budget", { pauseAtBudget: true, maxMonthlyTokens: 0 });
  await allowInInbox(second, 2);
  assert.equal(answers.at(-1), "still-waiting");
  // It still waits: the window opens its conversation with nothing working there, and the Inbox badge still counts it.
  await page.waitForFunction((id) => document.querySelector('#side .list [data-act="chat"][aria-current="true"]')?.dataset.id === id, second.sessionId, { timeout: 20000 });
  await page.waitForTimeout(1500);
  assert.equal(await page.locator("#conversation .typing").count(), 0, "nothing is shown working");
  assert.equal(app.store.run(second.id).status, "needs_input", "the task still waits");
  assert.ok(app.store.events(second.id).some((event) => event.kind === "run.carry_on_refused"), "with why written down");
  assert.equal(existsSync(join(workspace, "u2.txt")), false, "nothing was written");
  await page.waitForFunction(() => document.querySelector('#side [data-act="view"][data-v="inbox"] .cnt')?.textContent === "1", null, { timeout: 20000 });
  assert.deepEqual(errors, []);
});
