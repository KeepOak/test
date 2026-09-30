/* wire-greyed: Settings › Computer › Branch in CI › Copy the setup was greyed ("this row has no boxes"). It opens boxes for
   where it runs, the model service, the model, its address and the CI secret's name, and shows the lines the engine
   writes (POST /api/coding/ci), ready to copy. The key itself is never asked for.
   Mutation: in public/app/settings/pages/computer.js put "soon" back as the row's action, and this goes red. */
import test from "node:test";
import assert from "node:assert/strict";
import { openSettingsPage, settingsWindow, setLevel } from "./settings-window.mjs";

const provider = { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } };

test("Copy the setup writes the workflow lines from the boxes", async (t) => {
  const { page, errors } = await settingsWindow(t, { provider, name: "wire-ci" });
  await openSettingsPage(page, "general");
  await setLevel(page, "technical");
  await openSettingsPage(page, "computer");
  const open = page.locator('[data-act="ci-open"]');
  await open.waitFor();
  assert.equal(await open.getAttribute("aria-disabled"), null, "Copy the setup is live");
  await open.click();
  await page.locator("#ci-model").waitFor();
  assert.equal(await page.locator("#ci-key").inputValue(), "ANTHROPIC_API_KEY");
  // The engine's own refusal of an empty model is shown in its words.
  await page.locator('[data-act="ci-write"]').click();
  await page.locator(".toast").first().waitFor();
  await page.locator('[data-act="ci-kind"][data-v="gitlab"]').click();
  await page.locator('[data-act="ci-provider"][data-v="openai"]').click();
  assert.equal(await page.locator("#ci-endpoint").inputValue(), "https://api.openai.com/v1");
  await page.locator("#ci-model").fill("gpt-test-model");
  await page.locator("#ci-key").fill("CI_MODEL_KEY");
  await page.locator('[data-act="ci-write"]').click();
  const lines = page.locator(".dlg pre");
  await lines.waitFor();
  const text = await lines.innerText();
  assert.match(text, /component: .*branch@main/);
  assert.match(text, /model: "gpt-test-model"/);
  assert.match(text, /CI_MODEL_KEY/);
  assert.match(await page.locator(".dlg").innerText(), /\.gitlab-ci\.yml/);
  assert.deepEqual(errors, []);
});
