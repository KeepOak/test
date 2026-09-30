import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { newWindow, openPlace } from "./new-window-places.mjs";

test("Guide shows the example server config and fills arguments before preparing an unsent prompt", async (t) => {
  assert.equal(typeof chromium.launch, "function");
  const { page, errors, call } = await newWindow(t);
  const runsBefore = (await call("/api/state")).runs.length;
  await openPlace(page, "overview");
  await page.locator('[data-act="whatcan"]').first().click();
  await page.locator('[data-act="whatcan-tab"][data-v="prompts"]').click();
  const card = page.locator(".wc-card").filter({ has: page.locator("b", { hasText: "Try a tool server" }) });
  await card.locator("summary").click();
  const config = JSON.parse(await card.locator("pre code").textContent());
  assert.equal(config.mcp[0].id, "example-notes");
  assert.ok(config.mcp[0].args[0].endsWith("mcp-notes-server.js"));
  await card.locator('[data-act="whatcan-try"]').click();
  await page.getByLabel("Your text", { exact: true }).fill("Remember that my sample notebook is blue.");
  await page.getByRole("button", { name: "Prepare draft", exact: true }).click();
  await page.locator("#prompt").waitFor();
  const prompt = await page.locator("#prompt").inputValue();
  assert.match(prompt, /Remember that my sample notebook is blue/);
  assert.doesNotMatch(prompt, /\{\{input\}\}/);
  assert.equal((await call("/api/state")).runs.length, runsBefore, "preparing a prompt starts no task");
  assert.deepEqual(errors, []);
});
