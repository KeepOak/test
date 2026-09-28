/**
 * RES-703 / SELF-308: a pane beside the conversation shows its task working as the main conversation does: its live
 * steps, and, when it stops to ask, the same approval card, answered in the pane. The task carries on there; the main
 * conversation stays open and untouched, and nothing else is answered. A real engine and window, a scripted model that
 * writes a file behind an Ask rule, a hidden browser.
 * Mutation: draw a pane without its cards (or answer through the main conversation) and it goes red.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { saveConversationModeSettings } from "../dist/conversation-mode.js";
import { readPolicy, savePolicy } from "../dist/policy.js";

const writer = { name: "scripted", async complete(request) {
  const users = request.messages.filter((m) => m.role === "user").map((m) => String(m.content));
  const allowed = /The call you asked about did not run/.test(String(request.messages[0]?.content ?? "")) && !/"ok":true/.test(String(request.messages.at(-1)?.content ?? ""));
  if (request.messages.at(-1)?.role === "tool" && !allowed) return { content: "Written.", toolCalls: [] };
  const wanted = users.map((text) => /write (\w+)/.exec(text)?.[1]).find(Boolean);
  if (wanted && (request.messages.at(-1)?.role === "user" || allowed))
    return { content: "", toolCalls: [{ id: "c1", name: "files.write", arguments: JSON.stringify({ path: `${wanted}.txt`, content: wanted }) }] };
  return { content: "ok", toolCalls: [] };
} };

function seedTopic(app, thing) {
  const run = app.store.createRun(app.runtime.owner, `Tell me about ${thing}`);
  app.store.message(run.sessionId, { role: "user", content: `Tell me about ${thing}` });
  app.store.message(run.sessionId, { role: "assistant", content: `Here is what I know about ${thing}.` });
  app.store.finish(run.id, "completed", `Here is what I know about ${thing}.`);
  return run.sessionId;
}

test("a pane's task shows its live steps and its question, answered in the pane; the main conversation stays", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-panes-live-"));
  const workspace = join(root, "workspace");
  const app = await createBranch({ workspace, dataDir: join(root, "data"), provider: writer });
  const policy = readPolicy(app.store, app.runtime.owner);
  savePolicy(app.store, app.runtime.owner, { ...policy, rules: [{ tool: "files.write", decision: "ask" }, ...policy.rules] });
  saveConversationModeSettings(app.store, app.runtime.owner, { newConversation: "follow" });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  await fetch(new URL("/api/onboarding", server.url), { method: "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify({ done: true }) });
  const plums = seedTopic(app, "plums"), pears = seedTopic(app, "pears");
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 900 }, serviceWorkers: "block" })).newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });

  await page.locator(`#side [data-act="chat"][data-id="${plums}"]`).click();
  await page.locator("#conversation").getByText("Here is what I know about plums.").waitFor();
  await page.locator(`#side [data-act="chat"][data-id="${pears}"]`).click({ button: "right" });
  await page.locator(`.pop [data-act="pane-add"][data-id="${pears}"]`).click();
  const pane = page.locator(`.pn19[data-pane="${pears}"]`);
  await pane.getByText("Here is what I know about pears.").waitFor();
  await pane.locator(".bs-body15").hover();
  await page.locator(`.pn19.on19[data-pane="${pears}"]`).waitFor();
  await page.locator("#prompt").fill("write beta");
  await page.locator("#prompt").press("Enter");

  const card = pane.locator(".card.ask");
  await card.waitFor({ timeout: 60000 });
  await pane.locator(".live-steps li").first().waitFor({ timeout: 30000 });
  assert.ok(await pane.locator(".live-steps").isVisible(), "the pane shows its task's live steps");
  assert.equal(await page.locator("#conversation .card.ask").count(), 0, "the main conversation has no card");
  assert.equal(existsSync(join(workspace, "beta.txt")), false, "nothing written before the yes");

  await card.locator(".btn.pri").click();
  await pane.getByText("Written.").waitFor({ timeout: 60000 });
  assert.equal(await readFile(join(workspace, "beta.txt"), "utf8"), "beta", "the pane's request was answered and carried on");
  assert.deepEqual(app.runtime.approvals.waiting(), [], "nothing else waits");
  await page.locator("#conversation").getByText("Here is what I know about plums.").waitFor();
  assert.ok(await page.locator(`#side .row[data-id="${plums}"][aria-current="true"]`).count(), "the main conversation stayed open");
  assert.deepEqual(errors, []);
});
