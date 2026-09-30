/**
 * Helper lifecycle in the window: the New conversation button stops the helpers the open conversation left working,
 * as typed /new does (public/app/chat/chat.js startFresh, src/commands/handlers.ts freshConversation). A scripted model.
 *
 * Mutation note: drop the `commands/run` call in startFresh and the helper keeps working after New conversation.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as wait } from "node:timers/promises";
import { newWindow } from "./new-window-places.mjs";

const say = (content) => ({ content, toolCalls: [] });
const call = (name, args) => ({ content: "", toolCalls: [{ id: `c${Math.random().toString(36).slice(2, 9)}`, name, arguments: JSON.stringify(args) }] });
const until = async (check, ms = 15000) => { for (const end = Date.now() + ms; Date.now() < end; await wait(25)) if (await check()) return true; return check(); };

/** The lead starts one helper and finishes; the helper works until it is stopped. */
const provider = { name: "scripted", async complete(request) {
  const system = request.messages.filter((m) => m.role === "system").map((m) => String(m.content)).join("\n");
  if (/You are a helper working in the background/.test(system)) {
    await new Promise((_, reject) => request.signal?.addEventListener("abort", () => reject(request.signal.reason), { once: true }));
  }
  if (request.messages.some((m) => m.role === "tool")) return say("It is working.");
  return call("helpers.start", { brief: "keep working", minutes: 5 });
} };

test("New conversation in the window stops the helpers the open conversation left working", async (t) => {
  const { app, page, errors } = await newWindow(t, { provider });
  const lead = await app.runtime.run({ prompt: "start a helper", permissions: [...app.runtime.context().permissions], mode: "full" });
  assert.equal(lead.status, "completed", lead.output);
  const helper = app.store.events(lead.id).find((event) => event.kind === "delegation.background_started")?.data.childRunId;
  assert.ok(helper, "the helper started");
  assert.equal(app.store.run(helper).status, "running");
  await page.evaluate((id) => { location.hash = "open=" + id; }, lead.sessionId);
  await page.waitForFunction((id) => document.querySelector('#side .list [data-act="chat"][aria-current="true"]')?.dataset.id === id, lead.sessionId, { timeout: 15000 });
  await page.locator('[data-act="newmenu"]:visible').first().click();
  await page.locator('[data-act="newconv"]:visible').first().click();
  assert.ok(await until(() => app.store.run(helper).status === "cancelled"), app.store.run(helper).status);
  assert.deepEqual(errors, []);
});
