/* UP-UI-015: the conversation list reaches past the newest 50: /api/sessions pages by offset, and a "Show older" row in
   the side list loads the next page. A headless window on a temporary Branch with 55 seeded conversations.
   Mutation: drop olderConversationsHTML from the side list in shell/shell.js: red. */
import test from "node:test";
import assert from "node:assert/strict";
import { newWindow } from "./new-window-places.mjs";

function seed(app) {
  const ids = [];
  for (let i = 0; i < 55; i++) {
    const run = app.store.createRun(app.runtime.owner, `topic number ${i}`);
    app.store.message(run.sessionId, { role: "user", content: `topic number ${i}` });
    app.store.finish(run.id, "completed", "ok");
    ids.push(run.sessionId);
  }
  return ids;
}

test("UP-UI-015: the engine pages conversations, and Show older brings the older ones into the side list", { timeout: 180000 }, async (t) => {
  let ids;
  const { page, call, errors } = await newWindow(t, { seed: (app) => { ids = seed(app); } });
  const first = await call("/api/sessions?limit=50");
  assert.equal(first.sessions.length, 50);
  assert.equal(first.nextOffset, 50);
  const second = await call("/api/sessions?limit=50&offset=50");
  assert.equal(second.nextOffset, null);
  const listed = [...first.sessions, ...second.sessions].map((s) => s.sessionId);
  assert.equal(new Set(listed).size, listed.length, "no conversation twice");
  assert.ok(ids.every((id) => listed.includes(id)), "none missed");

  // The side list draws a Trunk's conversations as its one row (trunk-one-row), so what is checked is that the window's
  // list of conversations now holds the older page, and that the row goes once nothing is older.
  const known = (id) => page.evaluate((one) => import("/app/core/state.js").then((m) => m.E.sessions.some((s) => (s.sessionId ?? s.id) === one)), id);
  const older = page.locator('#side [data-act="sessions-older"]');
  await older.waitFor();
  assert.equal(await known(ids[0]), false, "the oldest is past the first page");
  await older.click();
  await older.waitFor({ state: "detached" });
  assert.equal(await known(ids[0]), true, "Show older read the next page");
  assert.equal(await known(ids[54]), true, "and kept the newest");
  assert.deepEqual(errors, []);
});
