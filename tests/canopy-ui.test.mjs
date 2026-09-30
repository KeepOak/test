import test from "node:test";
import assert from "node:assert/strict";
import { newWindow, openPlace } from "./new-window-places.mjs";

test("Canopy shows current work and controls its exact task, Trunk and board", async (t) => {
  let run, trunk, board;
  const { app, page, errors, call } = await newWindow(t, { seed: async (branch) => {
    trunk = branch.trunks.create({ name: "Elm" });
    board = branch.flowsBoards.orchard.addBoard({ name: "Garden" });
    run = branch.store.createRun(branch.runtime.owner, "Review the plan");
    branch.store.event(run.id, "trunk.turn", { trunkId: trunk.id });
    branch.store.finish(run.id, "needs_input", "Waiting");
  } });
  const place = await openPlace(page, "overview");
  const task = place.locator(`[data-cn-task="${run.id}"]`);
  await task.waitFor();
  assert.match(await task.textContent(), /Review the plan/);
  assert.equal(await task.locator('[data-act="cn-pause"]').count(), 0, "a waiting task has no ineffective Pause");
  const tr = place.locator(`[data-cn-trunk="${trunk.id}"]`);
  await tr.locator('[data-act="cn-trunk-pause"]').click();
  await page.waitForFunction((id) => {
    return document.querySelector(`[data-cn-trunk="${id}"] [data-act="cn-trunk-resume"]`) !== null;
  }, trunk.id);
  assert.equal(app.trunks.records.get(trunk.id).paused, true);
  await tr.locator('[data-act="cn-trunk-resume"]').click();
  await tr.locator('[data-act="cn-trunk-pause"]').waitFor();
  assert.equal(app.trunks.records.get(trunk.id).paused, undefined);
  await task.locator('[data-act="cn-stop"]').click();
  await task.waitFor({ state: "detached" });
  assert.equal(app.store.run(run.id).status, "cancelled");
  await place.locator(`[data-act="cn-board"][data-id="${board.id}"]`).click();
  await page.locator('[data-act="orc-boards"]').waitFor();
  assert.equal((await call(`/api/orchard?board=${board.id}`)).board.name, "Garden");
  assert.match(await page.locator('[data-act="orc-boards"]').textContent(), /Garden/);
  await page.setViewportSize({ width: 400, height: 900 });
  await openPlace(page, "overview");
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth));
  assert.deepEqual(errors, []);
});

test("Canopy steering keeps the draft and sends it to the selected live task", async (t) => {
  let run;
  const { app, page, errors } = await newWindow(t, { seed: async (branch) => {
    run = branch.store.createRun(branch.runtime.owner, "A live task");
  } });
  const place = await openPlace(page, "overview");
  const task = place.locator(`[data-cn-task="${run.id}"]`);
  await task.locator('[data-act="cn-steer"]').click();
  await page.locator("#cn-draft").fill("Check the smaller folder first");
  await task.locator('[data-act="cn-send"]').click();
  await page.locator("#cn-draft").waitFor({ state: "detached" });
  assert.equal(app.store.events(run.id).find((event) => event.kind === "run.steered")?.data.note, "Check the smaller folder first");
  assert.deepEqual(errors, []);
});

test("Canopy pauses a real task, follows its resumed identity, and stops it", async (t) => {
  const waiting = [];
  const release = () => { for (const resolve of waiting.splice(0)) resolve(); };
  const provider = { name: "scripted", async complete() {
    await new Promise((resolve) => waiting.push(resolve));
    return { content: "", toolCalls: [{ id: crypto.randomUUID(), name: "files.list", arguments: JSON.stringify({ path: "." }) }] };
  } };
  let run;
  const { app, page, errors } = await newWindow(t, { provider, seed: async (branch) => {
    await new Promise((resolve) => {
      branch.runtime.run({ prompt: "Canopy pause test", source: "owner", onTextDelta: () => {}, onStarted: (started) => { run = started; resolve(); } });
    });
  } });
  t.after(release);
  const place = await openPlace(page, "overview");
  const task = place.locator(`[data-cn-task="${run.id}"]`);
  await task.locator('[data-act="cn-pause"]').click();
  release();
  await task.locator('[data-act="cn-resume"]').waitFor();
  assert.equal(app.store.run(run.id).status, "interrupted");
  await task.locator('[data-act="cn-resume"]').click();
  await task.waitFor({ state: "detached" });
  const resumed = app.store.runs(app.runtime.owner).find((candidate) => app.store.events(candidate.id).some((event) => event.kind === "run.started" && event.data.resumedFrom === run.id));
  assert.ok(resumed);
  const next = place.locator(`[data-cn-task="${resumed.id}"]`);
  await next.locator('[data-act="cn-stop"]').click();
  release();
  await next.waitFor({ state: "detached" });
  assert.equal(app.store.run(resumed.id).status, "cancelled");
  assert.deepEqual(errors, []);
});
