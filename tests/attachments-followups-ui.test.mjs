/**
 * Attachment follow-ups (#479), in the window:
 * - A message may be only files: Send with an empty box sends the files.
 * - The chips stay until the message is sent. A message the engine never got (it was away) keeps its files, and once
 *   the engine answers again they are sent ahead once more (what it had waiting went with it) and go with the message.
 * Mutations, each turns a test here red:
 * - public/app/chat/chat.js send: return on an empty box whatever the chips hold: the file-only message is never sent.
 * - public/app/chat/attach.js: clear the chips as the upload ids are read (before POST /api/run answers): the message
 *   sent again once the engine is back has no files.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { signIn } from "./new-window-places.mjs";

async function windowWithBranch(t) {
  const scratch = join(tmpdir(), "Codex-session-files");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "branch-attach-followups-ui-"));
  const closing = [];
  t.after(async () => { for (const close of closing.reverse()) await close(); await discardTemp(root); });
  const seen = [];
  const app = await createBranch({
    workspace: join(root, "workspace"), dataDir: join(root, "data"),
    provider: { name: "scripted", async complete(request) { seen.push(request.messages); return { content: "Read it.", toolCalls: [] }; } },
  });
  closing.push(() => app.close());
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  closing.push(() => server.close());
  await fetch(new URL("/api/onboarding", server.url), { method: "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify({ done: true }) });
  const browser = await chromium.launch({ headless: true });
  closing.push(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await signIn(page, server);
  await page.locator("#prompt").waitFor({ timeout: 60000 });
  return { app, page, errors, seen };
}
/** Pastes one small text file into the box, as a list of copied files is pasted, and waits for its chip to be sent ahead. */
async function pasteFile(page, name, words) {
  await page.locator("#prompt").focus();
  await page.evaluate(([name, words]) => {
    const data = new DataTransfer();
    data.items.add(new File([new TextEncoder().encode(words)], name, { type: "application/octet-stream" }));
    document.querySelector("#prompt").dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  }, [name, words]);
  await page.waitForFunction(() => document.querySelectorAll("#attached .att.ready").length === 1, null, { timeout: 30000 });
}
const userMessages = (app) => app.store.runs(app.runtime.owner).flatMap((run) => app.store.messages(run.sessionId)).filter((one) => one.role === "user");

test("Send with an empty box sends a message of files only", async (t) => {
  const { app, page, errors, seen } = await windowWithBranch(t);
  await pasteFile(page, "notes.md", "The gate code changed to 4471.");
  assert.equal(await page.locator("#send.ready").count(), 1, "Send is ready with only a file waiting");
  const posted = page.waitForRequest((request) => request.url().endsWith("/api/run") && request.method() === "POST");
  await page.locator("#send").click();
  const body = (await posted).postDataJSON();
  assert.equal(body.prompt, "", "no words");
  assert.equal(body.uploads?.length, 1, "and the file");
  await page.locator("#conversation").getByText("Read it.").first().waitFor({ timeout: 20000 });
  assert.equal(await page.locator("#attached .att").count(), 0, "the chip went with the message");
  assert.match(JSON.stringify(seen.at(-1)), /gate code changed/, "the model was given what the file says");
  assert.equal(userMessages(app)[0].attachments.length, 1);
  assert.deepEqual(errors, []);
});

test("a message the engine never got keeps its files, and sends them once the engine is back", async (t) => {
  const { app, page, errors, seen } = await windowWithBranch(t);
  await pasteFile(page, "plan.txt", "Move the boat on Friday.");
  // The engine is away for this one send: the request never reaches it. Every try is kept, in order.
  const tries = [];
  page.on("request", (request) => { if (request.url().endsWith("/api/run") && request.method() === "POST") tries.push(request.postDataJSON()); });
  let refused = 0;
  await page.route("**/api/run", (route) => { if (!refused++) return route.abort("connectionrefused"); return route.continue(); });
  await page.locator("#prompt").fill("What is the plan?");
  await page.locator("#send").click();
  await page.waitForFunction(() => document.querySelector("#prompt")?.value === "What is the plan?", null, { timeout: 10000 });
  const firstUpload = tries[0]?.uploads?.[0];
  assert.ok(firstUpload, "control: the first try carried the file");
  // What the engine had waiting may be gone, as after a restart; the window does not count on it either way.
  await app.attachments.unstage(app.runtime.owner, firstUpload);
  await page.waitForFunction(() => /Read it\./.test(document.querySelector("#conversation")?.textContent ?? ""), null, { timeout: 60000 });
  const body = tries.at(-1);
  assert.equal(tries.length, 2, "sent once more, once the engine answered");
  assert.equal(body.prompt, "What is the plan?");
  assert.equal(body.uploads?.length, 1, "the file went with it");
  assert.notEqual(body.uploads[0], firstUpload, "sent ahead again, since the engine may no longer have it");
  await page.locator("#conversation").getByText("Read it.").first().waitFor({ timeout: 20000 });
  assert.match(JSON.stringify(seen.at(-1)), /Move the boat/, "the model was given the file");
  assert.equal(await page.locator("#attached .att").count(), 0, "and the chip went with the message");
  assert.deepEqual(errors, []);
});
