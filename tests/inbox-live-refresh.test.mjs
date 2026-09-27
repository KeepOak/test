/* A place reads its own data again in after() (the Inbox its questions); an unchanged view is not repainted (#341), but
   after() must still run, or a question arriving while the Inbox is open never shows until the person clicks.
   Mutation: in public/app/main.js drop the `VIEWS.after` call on the unchanged path, and this goes red. */
/**
 * Redesign security review, re-checked in the new window:
 * F1/F2: with a request waiting in each of two conversations, allowing the one shown answers that one only; the other
 * still waits and nothing of it happens. F3: a Trunk whose name is markup shows the name as text; no element of it
 * becomes part of the page. A scripted model; nothing reaches a provider.
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

/* Setup opens over a window whose onboarding is not done; these tests start past it, marked done through the engine. */
const onboarded = (server) => fetch(new URL("/api/onboarding", server.url), { method: "POST",
  headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify({ done: true }) });
import { readPolicy, savePolicy } from "../dist/policy.js";

const scripted = { name: "scripted", async complete(request) {
  const users = request.messages.filter((m) => m.role === "user").map((m) => String(m.content));
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
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 }, serviceWorkers: "block" });
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  return { app, page, server, workspace };
}

test("a question that arrives while the Inbox is open shows without a click", async (t) => {
  const { app, page } = await signedIn(t);
  await page.locator('#side [data-act="view"][data-v="inbox"]').first().click();
  await page.waitForTimeout(3000);
  void app.runtime.run({ prompt: "write gamma" }).catch(() => {});
  await page.waitForFunction(() => document.querySelector("#main")?.textContent?.includes("gamma"), undefined, { timeout: 20000 });
});
