/* The Trunks rail after the approved Grown-Up sample: the drawn face retired (DG-108), the studio
   preview's three states in one line and its conversation-header row (DG-109, DG-110), one Trunk
   menu from the strip and the sidebar list (DG-112), the sidebar's Trunks here list (DG-102), and
   the pet tiles eight in a row (DG-167). Headless, 127.0.0.1. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

const scripted = { name: "scripted", async complete() { return { content: "Here it is.", toolCalls: [] }; } };

/* Redesign: prototype.html has no Trunk strip, no "Trunks here" list and no pet tiles. A Trunk's conversation is a row in
   the sidebar's list with its face (core/ui.js av()), and its menu is that row's own (right-click, or Shift+F10 from the
   keyboard). The engine's retirement of the drawn face is still checked. */
async function signedIn(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-trunks-rail-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: scripted });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const call = (path, body) => fetch(new URL(path, server.url), {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).then((response) => response.json());
  await call("/api/onboarding", { done: true });
  await call("/api/trunks/switch", { part: "trunks", mode: "on" });
  const trunks = [];
  for (const name of ["Scout", "Ledger"]) {
    const { trunk } = await call("/api/trunks", { name, title: "Watches prices", description: "" });
    await call(`/api/trunks/${trunk.id}`, { look: { face: "drawn" } });
    trunks.push(trunk);
  }
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 950 }, serviceWorkers: "block" })).newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  return { call, page, errors, trunks };
}

test("the drawn face is retired, and every Trunk's row opens one menu by right-click and Shift+F10", { timeout: 300000 }, async (t) => {
  const f = await signedIn(t);
  const { page } = f;
  // DG-108: a stored or sent drawn face comes back as the pixel pattern.
  const roster = await f.call("/api/trunks");
  assert.deepEqual(f.trunks.map(({ id }) => roster.trunks.find(trunk => trunk.id === id).look.face), ["pattern", "pattern"], "both seeded drawn faces migrate independently of the default roster entry");
  const [scout, ledger] = f.trunks;
  const row = (trunk) => page.locator(`#side .row[data-id="${trunk.chatSessionId}"]`);
  await row(scout).waitFor();
  await row(ledger).waitFor();
  // DG-112: right-click and Shift+F10 open the same menu for the same Trunk.
  await row(scout).click({ button: "right" });
  const menu = page.locator(".pop[role=menu]");
  await menu.waitFor();
  const byMouse = await menu.getByRole("menuitem").allInnerTexts();
  assert.ok(byMouse.some((words) => words.includes("New conversation with Scout")), "the menu is Scout's");
  assert.ok(byMouse.some((words) => words.includes("Edit Trunk…")));
  await page.keyboard.press("Escape");
  await menu.waitFor({ state: "detached" });
  await row(scout).focus();
  await page.keyboard.press("Shift+F10");
  await menu.waitFor({ state: "visible" });
  assert.deepEqual(await menu.getByRole("menuitem").allInnerTexts(), byMouse, "the keyboard opens the same menu");
  await page.keyboard.press("Escape");
  await menu.waitFor({ state: "detached" });
  await row(ledger).click({ button: "right" });
  await menu.waitFor();
  assert.ok((await menu.getByRole("menuitem").allInnerTexts()).some((words) => words.includes("New conversation with Ledger")), "each Trunk's row, its own menu");
  await page.keyboard.press("Escape");
  await menu.waitFor({ state: "detached" });
  /* The menu says whose it is, and the arrow keys move between the rows (as the old Trunks list did). */
  const order = await page.locator("#side .row[data-id]").evaluateAll((nodes) => nodes.map((node) => node.dataset.id));
  await page.locator(`#side .row[data-id="${order[0]}"]`).focus();
  await page.keyboard.press("ArrowDown");
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.id), order[1], "arrow keys move between rows");
  await row(scout).click({ button: "right" });
  await menu.waitFor();
  assert.equal(await menu.getAttribute("aria-label"), "Scout", "the menu is named for its Trunk");
  await page.keyboard.press("Escape");
  assert.deepEqual(f.errors, []);
});
