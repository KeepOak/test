/** The actual Overview module and live controls, on an isolated scripted app. */
import test from "node:test";
import assert from "node:assert/strict";
import { newWindow, openPlace } from "./new-window-places.mjs";

test("the owner's To-do tile and dialog render and complete an existing item", async t => {
  let item;
  const f = await newWindow(t, { seed(app) { item = app.todos.add(app.runtime.owner, { text: "Isolated owner task" }, "owner"); } });
  await openPlace(f.page, "overview");
  await f.page.locator(`[data-act="owner-todo-done"][data-id="${item.id}"]`).waitFor({ state: "visible" });
  const show = f.page.locator('[data-act="owner-todo-list"]');
  assert.equal(await show.isEnabled(), true, "the real control is registered as live");
  await show.click();
  const ownDialog = f.page.locator('.scrim').filter({ has: f.page.locator(`[data-act="owner-todo-done"][data-id="${item.id}"]`) });
  await ownDialog.waitFor({ state: "visible" });
  await ownDialog.locator(`[data-act="owner-todo-done"][data-id="${item.id}"]`).click();
  await f.page.waitForFunction(id => !document.querySelector(`.scrim [data-act="owner-todo-done"][data-id="${id}"]`), item.id);
  assert.equal(f.app.todos.list(f.app.runtime.owner, { includeDone: true }).find(todo => todo.id === item.id)?.done, true);
  assert.deepEqual(f.errors, []);
});
