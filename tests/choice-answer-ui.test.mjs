/**
 * Parity B1: a choice card's answer is the owner's next message in that conversation, word for word. An option's title
 * is the model's words, so picking it never runs one of the window's slash commands, is never held for "Ask me
 * questions first" and is never sent on to a Trunk it names; and a double click answers once.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

const options = [{ title: "/status", hint: "words starting with a slash are the answer" }, { title: "Keep going", hint: "" }];

function asker() {
  return { name: "asker", async complete(request) {
    const last = request.messages.at(-1);
    if (last?.role === "user" && last.content === "which one") return { content: "", toolCalls: [{ id: `q${Math.random()}`, name: "user.ask", arguments: JSON.stringify({ question: "Which one?", options }) }] };
    return { content: "Noted.", toolCalls: [] };
  } };
}

test("picking an option sends its title as the answer, once, and never as a command", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-choice-answer-ui-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: asker() });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const headers = { authorization: `Bearer ${server.token}`, "content-type": "application/json" };
  await fetch(new URL("/api/onboarding", server.url), { method: "POST", headers, body: JSON.stringify({ done: true }) });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block" });
  const errors = [], commands = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => { if (new URL(request.url()).pathname === "/api/commands/run") commands.push(request.postData()); });
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });

  await page.locator("#prompt").fill("which one");
  await page.locator("#prompt").press("Enter");
  const pick = page.locator('#conversation .card.choice [data-act="pick"]').first();
  await pick.waitFor({ timeout: 30000 });
  const sid = app.store.runs(app.runtime.owner).find((r) => r.prompt === "which one").sessionId;
  await pick.dblclick();
  await page.locator("#conversation .card.choice .opt.picked").waitFor({ timeout: 20000 });
  const said = async () => (await (await fetch(new URL(`/api/sessions/${sid}`, server.url), { headers })).json()).messages.filter((m) => m.role === "user");
  for (let i = 0; i < 100 && (await said()).length < 2; i++) await page.waitForTimeout(50);
  await page.waitForTimeout(1000);
  const users = (await said()).map((m) => m.content);
  assert.deepEqual(users, ["which one", "/status"], "the title is the conversation's next message, once");
  assert.deepEqual(commands, [], "picking an option runs no command");
  assert.deepEqual(errors, []);
});
