/**
 * Dogfood B8: every message can be copied, the owner's and the assistant's, with a Copy button (as in Claude Code and
 * ChatGPT) and by plain selection. A real window with the clipboard allowed; the calm window, so the buttons appear
 * on the pointer as a person would find them.
 *
 * Redesign: the new window (public/app/chat/chat.js). A reply's own actions (prototype msgActs('b'): Copy, Try again,
 * Look inside, Report a problem, Branch from here) show on the pointer; a reply is #conversation .b, its words .txt.
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
import { saveConversationModeSettings } from "../dist/conversation-mode.js";

const reply = "Here is `npm test` and **bold** words.\n\n- one\n- two";
const typed = "Please  keep   my spacing\nand this second line.";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-copy-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"),
    provider: { name: "scripted", async complete() { return { content: reply, toolCalls: [] }; } } });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  saveConversationModeSettings(app.store, app.runtime.owner, { newConversation: "follow" });
  await fetch(new URL("/api/onboarding", server.url), { method: "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify({ done: true }) });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: "block" });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: server.url });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  await page.locator("#prompt").fill(typed);
  await page.locator("#send").click();
  await page.locator("#conversation .b .txt").first().waitFor({ timeout: 20000 });
  return { page, errors };
}
const clipboard = (page) => page.evaluate(() => navigator.clipboard.readText());
async function copyFrom(page, which) {
  const message = page.locator(which === "assistant" ? "#conversation .b" : "#conversation .u").last();
  await message.hover();
  await message.getByRole("button", { name: "Copy", exact: true }).click({ timeout: 10000 });
}

test("B8 the owner's message and the assistant's each copy as they were written", async (t) => {
  const { page, errors } = await fixture(t);
  // Windows' clipboard writes a line break as CRLF, which is how it should paste there; the words are compared as lines.
  const lines = (text) => String(text).replace(/\r\n/g, "\n");
  // Redesign: replaced by the new window (the person's own message has Edit and Branch from here, not Copy:
  // prototype msgActs('u')). What they typed is still shown as typed (the row's own buttons and "Sent at" time aside):
  assert.equal(lines(await page.locator("#conversation .u").last().evaluate((node) => { const copy = node.cloneNode(true); copy.querySelector(".msg-acts")?.remove(); return copy.textContent; })), typed,
    "what was typed, spacing and line breaks and all");
  await copyFrom(page, "assistant");
  assert.equal(lines(await clipboard(page)), reply, "the answer as it was written, markdown and all");
  await page.locator(".toast").filter({ hasText: "Copied." }).waitFor({ state: "attached" });
  assert.deepEqual(errors, []);
});

test("B8 a window that refuses the clipboard still copies, through the selection", async (t) => {
  const { page, errors } = await fixture(t);
  await page.evaluate(() => {
    const used = [];
    globalThis.copiedThroughSelection = used;
    navigator.clipboard.writeText = () => Promise.reject(new Error("refused"));
    const exec = document.execCommand.bind(document);
    document.execCommand = (name, ...rest) => { if (name === "copy") used.push(String(document.getSelection() ?? document.activeElement?.value ?? "")); return exec(name, ...rest) || name === "copy"; };
  });
  await copyFrom(page, "assistant");
  assert.equal((await page.evaluate(() => globalThis.copiedThroughSelection)).length, 1, "the fallback copy ran once");
  await page.locator(".toast").filter({ hasText: "Copied." }).waitFor({ state: "attached" });
  assert.deepEqual(errors, []);
});

test("B8 a message's text can be selected like any page's", async (t) => {
  const { page } = await fixture(t);
  const selected = await page.evaluate(() => {
    const body = [...document.querySelectorAll("#conversation .b .txt")].at(-1);
    const range = document.createRange();
    range.selectNodeContents(body);
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    return { text: selection.toString(), style: getComputedStyle(body).userSelect };
  });
  assert.match(selected.text, /bold words/);
  assert.notEqual(selected.style, "none", "nothing turns selection off on a message");
});
