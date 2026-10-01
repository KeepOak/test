/* UP-UI-058: while a dialog is open the window behind it is inert (no pointer, keyboard focus or screen-reader
   navigation into it), and closing the dialog gives each part back as it was (public/app/core/modal-background.js). */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

async function signedIn(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-modal-background-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const call = (method, path, body) => fetch(new URL(path, server.url), {
    method, headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}),
  });
  await call("POST", "/api/onboarding", { done: true });
  await call("POST", "/api/trunks/switch", { part: "trunks", mode: "on" });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce", serviceWorkers: "block" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  return { page, errors, call };
}

test("a dialog keeps the window behind it inert, and closing it gives the window back", async (t) => {
  const { page, errors, call } = await signedIn(t);
  const made = (await (await call("POST", "/api/trunks", { name: "Behind" })).json()).trunk;
  await page.reload();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  const behind = () => page.evaluate(() => [...document.querySelectorAll("#app > *")]
    .filter((node) => !node.matches(".scrim, .pop")).map((node) => node.inert));
  assert.ok((await behind()).every((inert) => inert === false), "nothing is inert with no dialog open");
  // "Edit Trunk…" from the Trunk's own conversation row, the way a person opens it.
  const row = page.locator(`#side .row[data-id="${made.chatSessionId}"]`);
  await row.waitFor();
  await row.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Edit Trunk…" }).click();
  await page.getByRole("dialog", { name: "Edit Behind" }).waitFor();
  const whileOpen = await behind();
  assert.ok(whileOpen.length > 0 && whileOpen.every((inert) => inert === true), "everything behind the dialog is inert");
  assert.equal(await page.locator(".scrim").evaluate((node) => node.inert), false, "the dialog itself is not");
  await page.keyboard.press("Escape");
  await page.locator(".dlg").waitFor({ state: "detached" });
  assert.ok((await behind()).every((inert) => inert === false), "closing the dialog gives the window back");
  assert.deepEqual(errors, []);
});
