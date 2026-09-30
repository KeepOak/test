/**
 * QA retest 2026-09-28, pass 2: with Settings › Models › Second opinion on, Look inside described the check's model call,
 * which comes after the answer ("Words of context 167 of 8,192" for an answer that sent 2,985), and a check that could
 * not run (Claude Code at its weekly limit) was said nowhere. Look inside now describes the answer's own round, and a
 * failed check is shown in the Second opinion row. Node only: the real dist/ and public/, scripted connections,
 * headless Chromium, port 0.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { newWindow } from "./new-window-places.mjs";
import { saveSecondOpinionSettings } from "../dist/index.js";

const say = (content) => ({ content, toolCalls: [] });

test("Look inside shows the answer's own words of context, and a check that could not run", async (t) => {
  const presets = [
    { id: "worker", name: "Worker", model: "w-1", provider: { name: "worker", complete: async () => say("391") } },
    { id: "checker", name: "Checker", model: "c-1", provider: { name: "checker", complete: async () => { throw new Error("Checker has reached its plan limit."); } } },
  ];
  const { page, app, call, errors } = await newWindow(t, { options: { presets } });
  app.runtime.models.configure(app.runtime.owner, { activePreset: "worker" });
  saveSecondOpinionSettings(app.store, app.runtime.owner, { advisor: true, advisorPreset: "checker", advisorMaxTokens: 5000 });
  const run = await app.runtime.run({ prompt: "What is 17 times 23? Answer with the number only.", onTextDelta: () => undefined });

  const kinds = app.store.events(run.id).map((event) => event.kind);
  assert.ok(kinds.indexOf("advice.started") > kinds.indexOf("model.completed"), "the check comes after the answer");
  const answerWords = app.store.events(run.id).find((event) => event.kind === "model.started").data.estimatedInput;
  const checkWords = app.store.events(run.id).filter((event) => event.kind === "model.started").at(-1).data.estimatedInput;
  assert.notEqual(answerWords, checkWords, "the two calls sent different amounts, so the test can tell them apart");

  const inspect = await call(`/api/runs/${run.id}/inspect`);
  assert.match(inspect.advice.line, /^The second opinion could not check this answer: .*plan limit/);
  assert.equal(app.runtime.advice(run.id), null, "advice given stays what it was: none");

  await page.reload();
  await page.locator("#app #side").waitFor({ state: "visible" });
  await page.locator(`#side [data-act="chat"][data-id="${run.sessionId}"]`).click(); // the answer's own conversation, not the default Trunk's
  await page.getByText("391", { exact: true }).last().hover();
  await page.locator('#main [data-act="inspect"]').last().click({ force: true });
  const dialog = page.locator(".dlg").last();
  await dialog.getByText("Words of context", { exact: true }).waitFor();
  const shown = await dialog.innerText();
  assert.match(shown, new RegExp(`Words of context\\s+${answerWords.toLocaleString("en-US")}\\b`), shown);
  assert.match(shown, /Second opinion\s+The second opinion could not check this answer/, shown);
  assert.deepEqual(errors, []);
});
