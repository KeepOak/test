/* UI-025 / UI-063: the Branch mascot is the logo only. A conversation with no Trunk wears a neutral chat tile, in its
   list row, on its replies and in quick-ask's "To" chips, with its working ring while it works, until the default Trunk
   (#594) takes such conversations in. The logo itself (the title bar's mark) stays.
   Headless, one window.
   Mutation: in public/app/core/ui.js av(), draw the old `av brand` + `.mark-face` for kind "main" again and every
   assertion here goes red (and check-fakes names core/ui.js). */
import test from "node:test";
import assert from "node:assert/strict";
import { newWindow } from "./new-window-places.mjs";

test("a conversation with no Trunk wears a neutral face in its row, its replies and quick-ask, never the mascot", async (t) => {
  const provider = { name: "scripted", async complete() { return { content: "Here it is.", toolCalls: [] }; } };
  const { page, errors } = await newWindow(t, { provider });
  await page.locator("#prompt").fill("Say hello.");
  await page.locator("#prompt").press("Enter");
  await page.locator("#main .b").filter({ hasText: "Here it is." }).first().waitFor({ timeout: 20000 });

  const row = page.locator("#side .row").first();
  await row.locator(".av.none18c").waitFor();
  assert.equal(await page.locator("#side .row .mark-face, #side .row .fig17r").count(), 0, "no mascot in the list's rows");
  assert.equal(await page.locator("#main .gut .mark-face").count(), 0, "no mascot on a reply");
  assert.ok(await page.locator("#main .gut .av.none18c").count() >= 1, "the reply is signed with the neutral tile");

  // Quick-ask's "To" chips: the assistant with no Trunk wears the same neutral face.
  await page.evaluate(async () => (await import("/app/core/actions.js")).run("qa17c"));
  const chips = page.locator(".qa17c .qato17c");
  await chips.waitFor();
  assert.equal(await chips.locator(".mark-face, .fig17r").count(), 0, "no mascot in quick-ask");
  assert.equal(await chips.locator('[data-v="branch"] .av.none18c').count(), 1, "the assistant's chip wears the neutral face");
  assert.deepEqual(errors, []);
});
