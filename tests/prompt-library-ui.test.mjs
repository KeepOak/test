/**
 * Bucket 12 in the app window, used the way a person uses it: the saved-prompts card in
 * Automations › Procedures, a saved command typed in the message box, and the install record in
 * Customize › Skills. Headless browser only; no window opens.
 * Redesign: the new window's Automations › Procedures has "Your saved prompts" with "New prompt" (public/app/flows/prompts.js),
 * and "/" in the message box lists commands and saved prompts (chat/messages.js).
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
import { signIn, openPlace } from "./new-window-places.mjs";

async function fixture(t, viewport = { width: 1280, height: 900 }) {
  const root = await mkdtemp(join(tmpdir(), "branch-prompts-ui-"));
  const seen = [];
  const provider = { name: "prompts-ui", complete: async (request) => {
    seen.push(String(request.messages.filter((m) => m.role === "user").at(-1)?.content ?? ""));
    return { content: "Done", toolCalls: [] };
  } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const httpCall = (path, body) => fetch(new URL(path, server.url), {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).then((response) => response.json());
  await httpCall("/api/onboarding", { done: true });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const page = await browser.newPage({ viewport });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await signIn(page, server);
  const call = (path, body) => fetch(new URL(path, server.url), { method: "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
  return { app, page, errors, seen, call };
}

test("saved prompts: switched on in Procedures, written, saved, then typed as a command in the message box", async (t) => {
  const { page, errors, seen, call } = await fixture(t);
  // Redesign: replaced by the new window (prototype.html has no switch for the library in Procedures), so it is switched
  // on through the engine's own route.
  await call("/api/prompts/settings", { mode: "on" });
  let place = await openPlace(page, "automations", "procedures");
  await place.locator('[data-act="prompt-new"]').click();
  const dialog = page.locator(".dlg");
  await dialog.getByLabel("Name", { exact: true }).fill("Weekly review");
  await dialog.getByLabel("Command", { exact: true }).fill("weekly");
  await dialog.getByLabel("What to ask", { exact: true }).fill("Review the week since {{day}}.");
  assert.equal(await dialog.locator("#pr-blanks").innerText(), "Asked each time: {{day}}");
  // Redesign: replaced by the new window (the prototype's saved prompt has a name, a command and what to ask; no group).
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await dialog.waitFor({ state: "detached" });
  await page.locator(".toast").filter({ hasText: "Type /weekly anywhere." }).waitFor();
  place = await openPlace(page, "automations", "scheduled");
  place = await openPlace(page, "automations", "procedures");
  await place.getByText("Weekly review").waitFor();

  await page.locator('#side [data-act="newmenu"]').click();
  await page.locator('.pop [data-act="newconv"]').click();
  // Typed key by key, as a person does: a new conversation can redraw the box once more, and each key re-opens the menu.
  await page.locator("#prompt").fill("");
  await page.locator("#prompt").pressSequentially("/wee", { delay: 50 });
  await page.locator(".slash6").getByText("/weekly").waitFor();
  await page.locator("#prompt").fill("/weekly day=monday");
  // WINDOW BUG: public/app/chat/chat.js:155 command() shows the engine's words ("Sending your saved prompt …") but never
  // does what its answer asks (client: {do: "send", text: "Review the week since monday."}), so the prompt is never sent.
  await page.locator("#send").click();
  for (let i = 0; i < 200 && !seen.length; i++) await page.waitForTimeout(25);
  assert.deepEqual(seen, ["Review the week since monday."]);
  assert.deepEqual(errors, []);
});

