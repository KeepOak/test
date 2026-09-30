import test from "node:test";
import assert from "node:assert/strict";
import { settingsWindow } from "./settings-window.mjs";
import { Continuity } from "../dist/reach/continuity.js";
import { saveReachMode } from "../dist/reach/settings.js";
import { saveAskMode } from "../dist/asks/settings.js";

test("computer menu transfers the selected conversation and returns it after remote release", async (t) => {
  let sessionId;
  const sent = [], provider = { name: "fixture", complete: async () => ({ content: "Ready.", toolCalls: [] }) };
  const { page, app, errors } = await settingsWindow(t, { name: "continuity-ui", provider, before: async (engine) => {
    const nodes = [{ id: "remote", name: "Remote", address: "https://remote.example", secret: "PAIRED", labels: [] }];
    engine.asks.nodes.save({ nodes });
    saveAskMode(engine.store, "local", "nodes", { mode: "on" });
    saveReachMode(engine.store, "local", "machines", { mode: "on" });
    engine.reachParts.continuity = new Continuity(engine.runtime, { list: () => nodes }, {
      secret: async () => "fixture-key", fetcher: async (url, options) => {
        const body = JSON.parse(options.body); sent.push({ path: new URL(url).pathname, body });
        return new Response(JSON.stringify({ id: body.id, generation: body.generation,
          state: String(url).endsWith("/release") ? "released" : "active", runId: null, output: "", error: null }), { status: 200 });
      },
    }, () => {});
  } });
  // Start the conversation once the window is up, as the owner would, then reload so the side list holds it.
  sessionId = (await app.runtime.run({ prompt: "Continue this conversation on my remote computer" })).sessionId;
  await page.reload();
  await page.locator(`#side [data-act="chat"][data-id="${sessionId}"]`).first().click();
  await page.locator('#side [data-act="machines"]').click();
  await page.getByRole("menuitem", { name: "Carry on elsewhere", exact: true }).click();
  await page.getByLabel("Task and context to send", { exact: true }).fill("Only send these chosen words.");
  await page.getByLabel("Include a preview of this conversation and its latest task", { exact: true }).check();
  await page.getByRole("button", { name: "Stop here and preview transfer", exact: true }).click();
  await page.getByRole("button", { name: "Send this approved task and context", exact: true }).waitFor();
  assert.equal(sent.length, 0, "owner sees context before anything leaves");
  await page.getByRole("button", { name: "Send this approved task and context", exact: true }).click();
  await page.getByRole("button", { name: "Stop remote and return here", exact: true }).waitFor();
  assert.match(sent[0].body.prompt, /^Only send these chosen words\./);
  assert.match(sent[0].body.prompt, /Continue this conversation on my remote computer/);
  assert.deepEqual(Object.keys(sent[0].body).sort(), ["generation", "id", "prompt"]);
  await assert.rejects(app.runtime.run({ sessionId, prompt: "Cannot run here yet" }), /held|continuity/i);
  await page.getByRole("button", { name: "Stop remote and return here", exact: true }).click();
  await page.getByText("Ownership returned", { exact: false }).first().waitFor();
  assert.equal((await app.runtime.run({ sessionId, prompt: "Can work here again" })).status, "completed");
  assert.equal(sent.filter((call) => call.path.endsWith("/release")).length, 1);
  assert.deepEqual(errors, []);
});
