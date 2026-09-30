/* SELF-124: the morning's learning receipt shows on Overview, not only in the learning journal, and Done there marks
   that night as seen through the engine. */
import test from "node:test";
import assert from "node:assert/strict";
import { newWindow, openPlace } from "./new-window-places.mjs";
import { emptyNight } from "../dist/seasons/rings-store.js";

test("Overview shows what was learned last night, and Done puts it away for good", async (t) => {
  const night = "2026-09-27", at = new Date().toISOString();
  const { app, page } = await newWindow(t, { seed: (app) => {
    app.rings.book.saveNight({ id: "night-overview", scope: "local", night, status: "done", startedAt: at, finishedAt: at,
      model: "stand-in", modelKind: "local", data: emptyNight(), seenAt: null });
    app.rings.book.saveCandidate({ id: "fact-1", scope: "local", text: "Prefers cedar notebooks", kind: "preference", status: "promoted",
      evidence: [], memoryId: null, proposalId: null, promotedNight: night, firstAt: at, lastAt: at });
  } });
  await openPlace(page, "overview");
  const tile = page.locator("#main .tile", { hasText: "What I learned last night" });
  await tile.waitFor({ timeout: 30000 });
  assert.match(await tile.innerText(), /Prefers cedar notebooks/);
  await tile.getByRole("button", { name: "Done", exact: true }).click();
  await tile.waitFor({ state: "detached" });
  assert.ok(app.rings.book.night("local", night).seenAt, "the engine keeps that the night was seen");
});
