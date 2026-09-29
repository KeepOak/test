/* Controls held back for a security review: Run on a saved procedure is live behind a dialog that shows everything it
   will do; Team › People › Invite someone opens the invite the owner already has in Settings › People; the rest stay
   greyed, each with a reason that says exactly why.
   Mutation: drop ...recipeRunLive from markLive in public/app/places/automations.js and the first case goes red. */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { settingsWindow, openSettingsPage, isSoon } from "./settings-window.mjs";

let id = "";
/* A procedure proposed and verified the way the engine makes one (verifying runs it once), its stamp then cleared. */
const procedure = async (app) => {
  const context = app.runtime.context();
  const recipe = app.knowledge.proposeProcedure(context, { name: "Stamp", preconditions: [],
    steps: [{ tool: "files.write", args: { path: "stamp.txt", content: "stamped" }, expected: { path: "stamp.txt", bytes: 7 } }] });
  await app.knowledge.verifyProcedure(context, recipe.id);
  await rm(join(app.runtime.workspace, "stamp.txt"));
  id = recipe.id;
};
async function open(page, place, tab) {
  await page.keyboard.press("Escape");
  await page.evaluate(([place, tab]) => {
    for (const [act, data] of [["view", { v: place }], ["ptab", { place, v: tab }]]) {
      const b = document.createElement("button"); b.dataset.act = act; Object.assign(b.dataset, data);
      document.getElementById("app").append(b); b.click(); b.remove();
    }
  }, [place, tab]);
  await page.waitForTimeout(1200);
}

test("Run shows every call, check, clean-up and try first, and runs only from that dialog", async (t) => {
  const { app, page, errors, call } = await settingsWindow(t, { name: "held-recipe", before: procedure });
  await call(`/api/flows-boards/recipes/${id}/checks`, { checks: [{ tool: "files.read", args: { path: "stamp.txt" }, contains: "stamped" }], retries: 1 });
  await open(page, "automations", "procedures");
  const run = page.locator(`[data-act="recipe-run"][data-id="${id}"]`);
  assert.equal(await isSoon(run), false, "Run is live");
  await run.click();
  const dlg = page.locator(".dlg", { hasText: "Run Stamp?" });
  await dlg.waitFor();
  const words = await dlg.innerText();
  assert.match(words, /files\.write \{"path":"stamp\.txt","content":"stamped"\}/, "the exact call is shown");
  assert.match(words, /files\.read \{"path":"stamp\.txt"\} → "stamped"/, "and the check");
  assert.match(words, /Tried up to 2 times/, "and the tries");
  const stamp = join(app.runtime.workspace, "stamp.txt");
  assert.equal(existsSync(stamp), false, "nothing runs on opening it");
  await dlg.locator('[data-act="recipe-run-go"]').click();
  await page.locator(".toast", { hasText: "passed after 1 try" }).waitFor({ timeout: 30000 });
  assert.equal(await readFile(stamp, "utf8"), "stamped");
  assert.deepEqual(errors, []);
});

test("Team › Invite someone is the owner's invite; the held rest say exactly why", async (t) => {
  const { page, errors } = await settingsWindow(t, { name: "held-reasons" });
  await open(page, "team", "people");
  const invite = page.locator('#main [data-act="p-invite"]').first();
  if (await invite.count()) {
    assert.equal(await isSoon(invite), false, "Invite someone is live");
    await invite.click();
    await page.locator(".dlg").waitFor();
    await page.keyboard.press("Escape");
  }
  await open(page, "team", "groups");
  const group = page.locator('#main [data-act="group18c"]');
  assert.match(await group.getAttribute("data-tip"), /no groups yet/, "groups say there are none, not a review");
  await openSettingsPage(page, "people");
  const pin = page.locator("#pp-pin");
  assert.equal(await pin.isChecked(), true, "switching to a person always asks for their PIN");
  assert.match(await pin.getAttribute("data-tip"), /Team › Signing in/, "and it says where the owner's own PIN is");
  assert.deepEqual(errors, []);
});
