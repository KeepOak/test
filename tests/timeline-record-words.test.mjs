/* The Timeline's "Check the record" says exactly what the activity chain holds (src/safety-extras/activity-chain.ts
   followActivity): permission answers and refusals always, tool runs only while the chain is "on", model steps never.
   The old words ("Each step is chained to the one before it") claimed every step shown, model steps included.
   A scripted model writes one file; the chain is read at "when-needed" (the default) and at "on", in a headless window.
   Mutation: in public/app/chat/timeline.js verify(), always use the "on" words (drop the `-asks` choice) and the
   when-needed half goes red; name tools in the -asks words and the "no tool runs" check goes red. */
import test from "node:test";
import assert from "node:assert/strict";
import { savePolicy } from "../dist/index.js";
import { newWindow } from "./new-window-places.mjs";

const writer = { name: "scripted", async complete(request) {
  const last = request.messages.at(-1);
  const named = /^write (\S+)/.exec(String(last?.content ?? ""));
  if (last?.role === "user" && named) return { content: "", toolCalls: [{ id: `w${Math.random()}`, name: "files.write", arguments: JSON.stringify({ path: named[1], content: "hello" }) }] };
  return { content: "Done.", toolCalls: [] };
} };

/* Opens the conversation of `run`, then its Timeline, and returns the check's words before and after checking. */
async function checkWords(page, run) {
  await page.evaluate(() => { location.hash = ""; });
  await page.reload();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  await page.locator(`#side [data-act="chat"][data-id="${run.sessionId}"]`).first().click();
  await page.locator('[data-act="tlopen17c"], .head [data-act="pane"]').first().waitFor();
  if (!(await page.locator("#pane").isVisible())) await page.locator('.head [data-act="pane"]').click();
  await page.locator('#pane .ptab[data-p="tl17c"]').click();
  const box = page.locator("#pane .tlver17c");
  await box.locator('[data-act="tlver17c"]').waitFor();
  const before = (await box.locator("small").textContent()).trim();
  await box.locator('[data-act="tlver17c"]').click();
  await page.locator("#pane .tlver17c.ok17c").waitFor({ timeout: 20000 });
  const after = (await box.locator("small").textContent()).trim();
  return { before, after };
}

test("Check the record names what the chain holds: permission answers always, tool runs only when the chain is on", async (t) => {
  const { app, page, call, errors } = await newWindow(t, { provider: writer });
  savePolicy(app.store, app.runtime.owner, { preset: "ask-before-changes" });

  // when-needed (the default): the question is in the chain, the tool run and the model steps are not.
  const asked = await app.runtime.run({ prompt: "write a.txt" });
  assert.equal(asked.status, "needs_input", "control: it stopped to ask, so the chain has a permission entry");
  const quiet = await checkWords(page, asked);
  assert.match(quiet.before, /permission answers and refusals/);
  assert.match(quiet.before, /Tool and model steps are not in it/);
  assert.match(quiet.after, /^All \d+ signed entries for permission answers and refusals link up/);
  assert.doesNotMatch(quiet.after, /tool/i, "no tool runs are claimed while the chain keeps none");
  assert.doesNotMatch(`${quiet.before} ${quiet.after}`, /Each step is chained/, "never every step");

  // on: tool runs join the record, model steps still do not.
  await call("/api/safety-extras/switch", { part: "activity-chain", mode: "on" });
  const ran = await app.runtime.run({ prompt: "write b.txt" });
  const full = await checkWords(page, ran);
  assert.match(full.before, /tool runs and permission answers/);
  assert.match(full.before, /Model steps are not in it/);
  assert.match(full.after, /^All \d+ signed entries for tool runs and permission answers link up/);
  assert.deepEqual(errors, []);
});
