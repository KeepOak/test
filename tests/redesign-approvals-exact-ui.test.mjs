/**
 * Redesign security review, re-checked in the new window:
 * F1/F2: with a request waiting in each of two conversations, allowing the one shown answers that one only; the other
 * still waits and nothing of it happens. F3: a Trunk whose name is markup shows the name as text; no element of it
 * becomes part of the page. A scripted model; nothing reaches a provider.
 */
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

/* Setup opens over a window whose onboarding is not done; these tests start past it, marked done through the engine. */
const onboarded = (server) => fetch(new URL("/api/onboarding", server.url), { method: "POST",
  headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify({ done: true }) });
import { readPolicy, savePolicy } from "../dist/policy.js";

/* One browser for the file, launched once: each test opens its own page with browser.newPage, which is a fresh context
   of its own (no cookie, storage or cache carried over), and closes it; only the launch is shared. */
let browser;
before(async () => { browser = await chromium.launch({ headless: true }); });
after(async () => { await browser?.close(); });

const scripted = { name: "scripted", async complete(request) {
  const users = request.messages.filter((m) => m.role === "user").map((m) => String(m.content));
  // Q050, QA R1: after a yes the task that asked carries on itself, and the engine makes the approved call.
  if (request.messages.at(-1)?.role === "tool") return { content: "Written.", toolCalls: [] };
  const wanted = users.map((text) => /write (\w+)/.exec(text)?.[1]).find(Boolean);
  if (wanted && request.messages.at(-1)?.role === "user")
    return { content: "", toolCalls: [{ id: "c1", name: "files.write", arguments: JSON.stringify({ path: `${wanted}.txt`, content: wanted }) }] };
  return { content: "ok", toolCalls: [] };
} };

async function signedIn(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-redesign-exact-"));
  const workspace = join(root, "workspace");
  const app = await createBranch({ workspace, dataDir: join(root, "data"), provider: scripted });
  const policy = readPolicy(app.store, app.runtime.owner);
  savePolicy(app.store, app.runtime.owner, { ...policy, rules: [{ tool: "files.write", decision: "ask" }, ...policy.rules] });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  await onboarded(server);
  let page;
  t.after(async () => { await page?.close(); await server.close(); await app.close(); await discardTemp(root); });
  page = await browser.newPage({ viewport: { width: 1366, height: 900 }, serviceWorkers: "block" });
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  return { app, page, server, workspace };
}
async function send(page, text) {
  await page.locator("#prompt").fill(text);
  await page.locator("#send").click();
}

test("F1/F2: allowing the request shown answers that one only; the other conversation's still waits", async (t) => {
  const { app, page, workspace } = await signedIn(t);
  await send(page, "write alpha");
  await page.locator("#live-ask").waitFor({ state: "visible", timeout: 30000 });
  await page.locator('[data-act="newmenu"]').first().click();
  await page.locator('[data-act="newconv"]').first().click();
  await send(page, "write beta");
  await page.waitForFunction(() => document.querySelector("#live-ask")?.textContent?.includes("beta"), undefined, { timeout: 30000 });
  assert.equal(app.runtime.approvals.waiting().length, 2, "a request waits in each conversation");
  await page.locator("#live-ask .btn.pri").click();
  await page.locator("#conversation").getByText("Written.").waitFor({ timeout: 30000 });
  assert.equal(await readFile(join(workspace, "beta.txt"), "utf8"), "beta", "the request shown was answered");
  assert.equal(existsSync(join(workspace, "alpha.txt")), false, "the other conversation's request did not happen");
  assert.deepEqual(app.runtime.approvals.waiting().map((q) => q.target), ["alpha.txt"], "it still waits");
});

test("F3: a Trunk named with markup shows the name as text, and none of it becomes part of the page", async (t) => {
  const { app, page } = await signedIn(t);
  const name = "</button><i class=scrim data-act=ask>";
  app.trunks.setMode("trunks", { mode: "on" });
  app.trunks.create({ name });
  await page.reload();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  await page.getByRole("button", { name: "Settings", exact: true }).first().click();
  await page.locator('[data-act="setpage"][data-v="instructions"]').click();
  await page.getByRole("heading", { name: "Instructions & personality" }).waitFor({ timeout: 30000 });
  await page.locator('[data-act="if-owner"][data-v="branch"]').waitFor({ timeout: 30000 });
  assert.equal(await page.locator("i.scrim").count(), 0, "no element made from the name");
  assert.equal(await page.locator('i[data-act="ask"]').count(), 0, "no action made from the name");
  // Pass 18: Settings takes the list's place, so the name is read where Settings shows it, as the page's own text.
  await page.locator(".set-page").getByText(name, { exact: true }).first().waitFor({ timeout: 10000 });
});

test("F1: an approve control that names no request (as Inbox's Trunk-message rows had) answers nothing", async (t) => {
  const { app, page, workspace } = await signedIn(t);
  await send(page, "write alpha");
  await page.locator("#live-ask").waitFor({ state: "visible", timeout: 30000 });
  await page.locator('[data-act="newmenu"]').first().click();
  await page.locator('[data-act="newconv"]').first().click();
  await page.evaluate(() => {
    const stray = document.createElement("button");
    stray.type = "button"; stray.id = "stray-allow"; stray.dataset.act = "ask"; stray.dataset.v = "allowed"; stray.textContent = "Allow";
    document.querySelector("#main").append(stray);
  });
  await page.locator("#stray-allow").click();
  await page.waitForTimeout(3000);
  assert.equal(existsSync(join(workspace, "alpha.txt")), false, "the unseen request did not happen");
  assert.equal(app.runtime.approvals.waiting().length, 1, "it still waits");
});

test("the chat-app wizard: a pasted token is saved by the engine and never shown on the page or kept by the window", async (t) => {
  const { page } = await signedIn(t);
  const token = "tk_redesign_gate_secret_0000000000042";
  // The window draws #main once more when its second round of reads lands (~0.7 s after sign-in), which drops a
  // button added from outside; add it again if it went and retry, so the test waits on the wizard, not on timing.
  for (let tries = 0; tries < 5; tries++) {
    await page.evaluate(() => {
      if (document.querySelector("#open-ntfy")) return;
      const open = document.createElement("button");
      open.type = "button"; open.id = "open-ntfy"; open.dataset.act = "ch-open"; open.dataset.v = "ntfy"; open.textContent = "ntfy";
      document.querySelector("#main").append(open);
    });
    if (await page.locator("#open-ntfy").click({ timeout: 3000 }).then(() => true, () => false)) break;
  }
  const next = page.locator('.dlg [data-act="chw-next"]');
  while (!(await page.locator("[data-chf]").count())) { await next.click(); await page.waitForTimeout(200); }
  await page.locator('[data-chf="topic"]').fill("branch-gate");
  await page.locator('[data-chf="NTFY_ACCESS_TOKEN"]').fill(token);
  const checked = page.waitForResponse((r) => r.url().includes("/api/channel-setup/ntfy/check"));
  await next.click();
  const answer = await checked;
  assert.equal(answer.status(), 200, `the engine saved it: ${await answer.text()}`);
  await page.waitForTimeout(500);
  assert.equal((await page.content()).includes(token), false, "the token is not in the page");
  assert.equal(await page.evaluate((secret) => [...document.querySelectorAll("input")].some((i) => i.value.includes(secret)), token), false,
    "no field still holds it");
  assert.equal((await page.evaluate(() => JSON.stringify({ ...sessionStorage }) + JSON.stringify({ ...localStorage }))).includes(token), false,
    "the window does not keep it");
});
