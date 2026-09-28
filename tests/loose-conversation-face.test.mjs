/* UI-025 / UI-063: the Branch mascot is the logo only. A conversation with no Trunk of its own is answered by the owner's
   default Trunk (#594), so it wears that Trunk's face in its list row, on its replies and in quick-ask's "To" chips,
   where the default is offered once. Without a default Trunk it wears the neutral chat tile. Never the mascot; the
   logo itself (the title bar's mark) stays.
   Headless, one window.
   Mutation: in public/app/chat/quick.js who(), drop the default Trunk's face or its exclusion and the quick-ask
   assertions go red; in public/app/core/state.js chatFace(), drop defaultTrunk() and the row and reply assertions do. */
import test from "node:test";
import assert from "node:assert/strict";
import { newWindow } from "./new-window-places.mjs";

test("a conversation with no Trunk of its own wears the default Trunk's face in its row, replies and quick-ask, never the mascot", async (t) => {
  const provider = { name: "scripted", async complete() { return { content: "Here it is.", toolCalls: [] }; } };
  const { app, page, errors } = await newWindow(t, { provider });
  await page.locator("#prompt").fill("Say hello.");
  await page.locator("#prompt").press("Enter");
  await page.locator("#main .b").filter({ hasText: "Here it is." }).first().waitFor({ timeout: 20000 });
  const home = app.trunks.ownerDefault();
  assert.ok(home, "the owner has a default Trunk");
  const face = `.av[data-rk="t:${home.id}"]`;

  const sessionId = app.store.runs(app.runtime.owner).find((run) => run.prompt === "Say hello.")?.sessionId;
  const row = page.locator(`#side .row[data-id="${sessionId}"]`);
  await row.locator(face).waitFor();
  assert.equal(await page.locator("#side .row .mark-face").count(), 0, "no mascot in the list's rows");
  assert.equal(await page.locator("#main .gut .mark-face").count(), 0, "no mascot on a reply");
  assert.ok(await page.locator(`#main .gut ${face}`).count() >= 1, "the reply is signed by the default Trunk");

  // Quick-ask's "To" chips: a new conversation goes to the default Trunk, offered once and wearing its face.
  await page.evaluate(async () => (await import("/app/core/actions.js")).run("qa17c"));
  const chips = page.locator(".qa17c .qato17c");
  await chips.waitFor();
  assert.equal(await chips.locator(".mark-face").count(), 0, "no mascot in quick-ask");
  assert.equal(await chips.locator(`[data-v="branch"] ${face}`).count(), 1, "the new-conversation chip wears the default Trunk's face");
  assert.equal(await chips.locator(`[data-v="${home.id}"]`).count(), 0, "the default Trunk is not offered twice");
  assert.equal((await chips.locator('[data-act="qato17c"]').allTextContents()).filter((name) => name === home.name).length, 1);
  assert.deepEqual(errors, []);
});
