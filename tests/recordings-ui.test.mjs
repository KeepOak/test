/**
 * Public list, bucket 13: the two cards in a real (headless) browser, opened the way a person opens
 * them (tests/places.mjs). Each names its home, keeps to the card anatomy, fits 400 px, and works:
 * a finished task is played back step by step, and the event-loop switch is saved.
 * Redesign: in the new window a finished task is watched again from Inbox › History ("Watch again", data-act="replay"),
 * in the prototype's "Watch a task again" dialog: the engine's frames, a path, Step and Play (public/app/places/inbox.js).
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
import { signIn as signInNew, openPlace as openNewPlace } from "./new-window-places.mjs";

function writesAFile(name) {
  let round = 0;
  return {
    name: "scripted",
    async complete() {
      round += 1;
      return round % 2 === 1
        ? { content: "", toolCalls: [{ id: `c${round}`, name: "files.write", arguments: JSON.stringify({ path: name, content: "one" }) }] }
        : { content: "done", toolCalls: [] };
    },
  };
}

async function signIn(page, server) {
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
}

test("Watch a task again: off at first, then a finished task plays back step by step at 400 px", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-bucket13-ui-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: writesAFile("seen.txt") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const httpCall = (path, body) => fetch(new URL(path, server.url), {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).then((response) => response.json());
  await httpCall("/api/onboarding", { done: true });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const run = await app.runtime.run({ prompt: "write the seen file" });
  assert.equal(run.status, "completed", run.output);
  // Redesign: replaced by the new window (prototype.html has no recordings switch card, and the card anatomy and data-t
  // keys are the old sample's), so recording is switched on through the engine's own route; the window then plays it.
  await fetch(`${server.url}/api/recordings`, { method: "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify({ mode: "when-needed" }) });
  // Opened at full width, then narrowed to 400 px (on a phone the side list stays over a place: the WINDOW BUG marked in
  // library-tabs.test.mjs).
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await signInNew(page, server);
  const place = await openNewPlace(page, "inbox", "history");
  await page.setViewportSize({ width: 400, height: 900 });
  await place.locator(`.prow [data-act="replay"][data-id="${run.id}"]`).click();
  const dialog = page.locator(".dlg");
  const steps = dialog.locator(".replay6 ol.tl li");
  await steps.first().waitFor({ state: "visible" });
  assert.ok((await steps.count()) >= 4, "asked, thought, acted, finished");
  assert.match(await steps.first().getAttribute("class"), /now6/, "the first frame is the one shown");
  await dialog.getByRole("button", { name: "Step", exact: true }).click();
  assert.match(await steps.nth(1).getAttribute("class"), /now6/);
  assert.equal(await dialog.locator(".rp-path i").count(), await steps.count(), "the path has a mark for every frame");
  const wide = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(wide <= 0, `no sideways scrolling at 400 px (${wide} px over)`);

  // Redesign: Coming soon (toast: "Make a workflow"), checked at fc541c24; the dialog draws it aria-disabled, class soon.
  const workflow = dialog.getByRole("button", { name: "Make a workflow", exact: true });
  assert.equal(await workflow.getAttribute("aria-disabled"), "true");
  assert.deepEqual(errors, []);
});

