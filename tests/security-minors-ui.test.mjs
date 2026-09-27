/**
 * Security minors, checked in the new window against a real engine with a scripted model (nothing reaches a provider):
 * - Allow all answers only questions that carry a fingerprint. A question without one is left to its own Allow, so a
 *   bare yes (which the engine gives to the oldest question in that conversation) is never sent on its behalf.
 * - "Ask before opening an app it hasn't used" shows on when the owner never saved it, and off once they turned it off.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
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
  const root = await mkdtemp(join(tmpdir(), "branch-security-minors-"));
  const workspace = join(root, "workspace");
  const app = await createBranch({ workspace, dataDir: join(root, "data"), provider: scripted });
  const policy = readPolicy(app.store, app.runtime.owner);
  savePolicy(app.store, app.runtime.owner, { ...policy, rules: [{ tool: "files.write", decision: "ask" }, ...policy.rules] });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const post = (path, body) => fetch(new URL(path, server.url), { method: "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify(body) })
    .then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
  const get = (path) => fetch(new URL(path, server.url), { headers: { authorization: `Bearer ${server.token}` } }).then((r) => r.json());
  await post("/api/onboarding", { done: true });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 }, serviceWorkers: "block" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const signIn = async () => {
    await page.goto(server.url);
    await page.getByLabel("Session token", { exact: true }).fill(server.token);
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  };
  return { app, page, workspace, post, get, errors, signIn };
}

/* Mutation: in public/app/places/inbox.js, make `exactAsks` return every question (`asks`) and drop the loop's
   `.filter(exact)` → the confirm lists three, a bare yes is sent, and the fingerprint-less question is answered. */
test("Allow all leaves out a question with no fingerprint, and every yes it sends names its request", async (t) => {
  const { app, page, workspace, errors, signIn } = await signedIn(t);
  for (const word of ["alpha", "beta"]) assert.equal((await app.runtime.run({ prompt: `write ${word}` })).status, "needs_input");
  const bare = { runId: randomUUID(), sessionId: randomUUID(), tool: "files.write", target: "bare.txt", label: "Write bare.txt",
    question: "Before I go ahead: Write bare.txt. Is that all right?", source: "owner", remember: "session", askedAt: new Date().toISOString() };
  app.runtime.approvals.ask(bare);
  assert.equal(app.runtime.approvals.waiting().length, 3);
  const answers = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/policy/approve") answers.push(request.postDataJSON());
  });
  await signIn();
  await page.locator('#side [data-act="view"][data-v="inbox"]').first().click();
  const button = page.locator('#main [data-act="allowall"]');
  await button.waitFor({ timeout: 30000 });
  assert.match(await button.innerText(), /\b2\b/, "the count leaves the fingerprint-less question out");
  await button.click();
  const listed = await page.locator(".dlg ul li").allInnerTexts();
  assert.equal(listed.length, 2, listed.join(" | "));
  assert.equal(listed.some((text) => text.includes("bare.txt")), false, "the confirm does not name it");
  await page.locator('.dlg [data-act="allowall-go"]').click();
  await page.waitForFunction(() => !document.querySelector('.dlg [data-act="allowall-go"]'), undefined, { timeout: 30000 });
  for (let i = 0; i < 100 && answers.length < 2; i++) await page.waitForTimeout(100);
  await page.waitForTimeout(1000);
  assert.equal(answers.length, 2, JSON.stringify(answers));
  for (const body of answers) {
    assert.match(String(body.fingerprint ?? ""), /^[a-f0-9]{32}$/, JSON.stringify(body));
    assert.equal(body.remember, "never");
  }
  assert.notEqual(answers.some((body) => body.sessionId === bare.sessionId), true, "nothing was sent for its conversation");
  assert.deepEqual(app.runtime.approvals.waiting().map((q) => q.target), ["bare.txt"], "it still waits for its own answer");
  for (let i = 0; i < 100; i++) {
    const done = await Promise.all(["alpha", "beta"].map((w) => readFile(join(workspace, `${w}.txt`), "utf8").then(() => true, () => false)));
    if (done.every(Boolean)) break;
    await page.waitForTimeout(100);
  }
  assert.equal(await readFile(join(workspace, "alpha.txt"), "utf8"), "alpha", "control: the fingerprinted ones went ahead");
  assert.equal(await readFile(join(workspace, "beta.txt"), "utf8"), "beta");
  assert.deepEqual(errors, []);
});

/* Library › Memory's "Export what it remembers" (JSON Lines). In a browser it is a download of the engine's own file; in
   the desktop app (window.branchDesktop stood in here: the real preload and IPC are tests/desktop-export.test.mjs) the
   same lines go to the guarded export, because the desktop drops every download.
   Mutation: in public/app/places/library.js drop the `exportMemoryLines` branch → the stand-in is handed nothing. */
test("Export what it remembers downloads in a browser and goes to the desktop's guarded export in the app", async (t) => {
  const { page, post, errors, signIn } = await signedIn(t);
  const fact = { id: "5c2e1b7a-3d4f-4a6b-9c8d-7e6f5a4b3c2d", data: { text: "Security minors fact" } };
  assert.equal((await post("/api/memory/import", { jsonl: JSON.stringify(fact) })).status, 200);
  const openMemoryMenu = async () => {
    await page.locator('#side [data-act="view"][data-v="library"]').first().click();
    await page.locator('[data-act="ptab"][data-place="library"][data-v="memory"]').first().click();
    await page.getByRole("button", { name: "More for memory", exact: true }).click();
  };
  await signIn();
  await openMemoryMenu();
  const download = page.waitForEvent("download", { timeout: 30000 });
  await page.locator('.pop [data-act="memexp15"]:not([data-v])').click();
  const file = await download;
  assert.equal(file.suggestedFilename(), "memory.jsonl");
  const downloaded = await readFile(await file.path(), "utf8");
  assert.match(downloaded, /Security minors fact/);
  // The desktop app: a stand-in for its preload records what the window hands over, and no download starts.
  await page.addInitScript(() => {
    window.__handed = [];
    window.branchDesktop = Object.freeze({ exportMemoryLines: async (text) => { window.__handed.push(text); return { saved: true }; } });
  });
  await page.reload();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  let downloads = 0;
  page.on("download", () => { downloads++; });
  await openMemoryMenu();
  await page.locator('.pop [data-act="memexp15"]:not([data-v])').click();
  await page.waitForFunction(() => window.__handed.length > 0, undefined, { timeout: 15000 });
  const handed = await page.evaluate(() => window.__handed);
  assert.equal(handed.length, 1);
  assert.equal(handed[0], downloaded, "the desktop is handed the engine's own lines, exactly");
  await page.waitForTimeout(500);
  assert.equal(downloads, 0, "no download is started in the desktop app");
  assert.deepEqual(errors, []);
});

/* Mutations: in src/desktop-app-ask.ts, set AppAskSettingsSchema's default back to false (the engine reads it as off);
   in public/app/settings/pages/computer.js, draw #c-ask without its `checked` (the window no longer shows the engine's on). */
test("Ask before opening an app it hasn't used shows on when never saved, and off once the owner turned it off", async (t) => {
  const { page, post, get, errors, signIn } = await signedIn(t);
  assert.deepEqual(await get("/api/desktop/app-ask"), { on: true });
  /* The page reads GET /api/desktop/app-ask when it opens; the switch is looked at only once that answer has landed. */
  const computerPage = async () => {
    const read = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/desktop/app-ask" && r.request().method() === "GET", { timeout: 30000 });
    await page.getByRole("button", { name: "Settings", exact: true }).first().click();
    await page.locator('[data-act="setpage"][data-v="computer"]').first().click();
    await read;
    await page.locator("#c-ask").waitFor({ timeout: 30000 });
    await page.waitForTimeout(500);
  };
  await signIn();
  await computerPage();
  assert.equal(await page.locator("#c-ask").isChecked(), true, "never saved: shown on");
  assert.equal((await post("/api/desktop/app-ask", { on: false })).body.on, false);
  await page.reload();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  await computerPage();
  assert.equal(await page.locator("#c-ask").isChecked(), false, "the owner's off: shown off");
  assert.deepEqual(errors, []);
});
