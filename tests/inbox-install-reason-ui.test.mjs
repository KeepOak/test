import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { newWindow, openPlace } from "./new-window-places.mjs";

/* TRUNK-187 (QA Q002): Allow on an install request stays greyed for its safety review, and says so in its own row. */
test("a waiting install request's greyed Allow says why, and Don't stays live", async (t) => {
  const en = JSON.parse(await readFile(new URL("../public/locales/en.json", import.meta.url), "utf8"));
  const { page, errors } = await newWindow(t, { seed: async (app) => {
    app.flowsBoards.setMode("install-requests", { mode: "on" });
    // Written as the engine keeps a waiting request (src/flows-boards/install-requests.ts), with no network check here.
    app.store.save("settings", app.runtime.owner, "flowboards-install-list", { items: [{ id: "6f1f0c1e-0000-4000-8000-000000000001",
      ask: { kind: "package", ecosystem: "npm", name: "left-pad", why: "to pad the report" }, by: "assistant", from: "the assistant",
      status: "waiting", check: { state: "clean" }, nextStep: null, at: new Date().toISOString(), answeredAt: null }] });
  } });
  const place = await openPlace(page, "inbox", "needs");
  const allow = place.locator('[data-act="xdo"]');
  await allow.waitFor();
  assert.equal(await allow.getAttribute("aria-disabled"), "true", "Allow stays greyed");
  assert.equal(await allow.getAttribute("data-tip"), en["window.why.xdo"]);
  assert.equal(await place.locator('[data-act="xdo-no"]').getAttribute("aria-disabled"), null, "Don't is live");
  assert.deepEqual(errors, []);
});
