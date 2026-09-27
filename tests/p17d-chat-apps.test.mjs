/**
 * P17-D §8: a revoked Telegram bot token is said, not retried in silence. Telegram answers getUpdates with 401 once
 * the token is revoked or replaced in BotFather; the adapter's health then says "needs attention" with the reason,
 * which GET /api/channels hands to Settings › Chat apps and the Inbox. It goes back to connected once the token works.
 * Any other failure (the network, a 500) stays a quiet retry, as before.
 *
 * A token revoked while Branch was closed is refused at getMe, before polling: the adapter still starts, says so, and
 * comes back (with its bot name) once the token works.
 *
 * Mutation notes: in src/channels/telegram.ts, dropping `if (refusedToken) this.refused = tokenRefused;` fails the
 * "needs attention" check; dropping `this.refused = null;` after a good getUpdates fails the "back to connected" check;
 * dropping `{ status: response.status }` from call() fails both; making start() rethrow a 401 from getMe fails the
 * "revoked while closed" test.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { TelegramAdapter } from "../dist/index.js";
import { tokenRefused } from "../dist/channels/telegram.js";

async function until(check) {
  for (let i = 0; i < 300; i++) { if (check()) return; await delay(10); }
  assert.fail("timed out waiting for the poll");
}

test("Telegram: a refused token shows in health with its reason, and clears once the token works again", async (t) => {
  let answer = "refused";
  const polls = [];
  const fakeFetch = async (url) => {
    const method = url.split("/").pop();
    if (method === "getMe") return { status: 200, json: async () => ({ ok: true, result: { id: 1, is_bot: true, username: "TestBot" } }) };
    polls.push(answer);
    await delay(5);
    if (answer === "refused") return { status: 401, json: async () => ({ ok: false, error_code: 401, description: "Unauthorized" }) };
    if (answer === "broken") return { status: 502, json: async () => ({ ok: false, error_code: 502, description: "Bad Gateway" }) };
    return { status: 200, json: async () => ({ ok: true, result: [] }) };
  };
  const adapter = new TelegramAdapter({ id: "telegram", token: "fake", fetch: fakeFetch, pollTimeoutSeconds: 1, refusedRetryMs: 20 });
  assert.deepEqual(adapter.health(), { state: "connected" });
  await adapter.start(async () => undefined);
  t.after(() => adapter.stop());
  await until(() => adapter.health().state === "needs attention");
  assert.deepEqual(adapter.health(), { state: "needs attention", reason: tokenRefused });
  answer = "ok";
  await until(() => adapter.health().state === "connected");
  // Another kind of failure is not a refused token.
  answer = "broken";
  const before = polls.length;
  await until(() => polls.length > before);
  await delay(30);
  assert.deepEqual(adapter.health(), { state: "connected" });
});

test("Telegram: a token revoked while Branch was closed is refused at getMe; it still starts, says so, and comes back", async (t) => {
  let answer = "refused";
  const fakeFetch = async (url) => {
    const method = url.split("/").pop();
    await delay(5);
    if (answer === "refused") return { status: 401, json: async () => ({ ok: false, error_code: 401, description: "Unauthorized" }) };
    if (method === "getMe") return { status: 200, json: async () => ({ ok: true, result: { id: 1, is_bot: true, username: "TestBot" } }) };
    return { status: 200, json: async () => ({ ok: true, result: [] }) };
  };
  const adapter = new TelegramAdapter({ id: "telegram", token: "fake", fetch: fakeFetch, pollTimeoutSeconds: 1, refusedRetryMs: 20 });
  await adapter.start(async () => undefined);
  t.after(() => adapter.stop());
  assert.deepEqual(adapter.health(), { state: "needs attention", reason: tokenRefused });
  assert.equal(adapter.botName(), null);
  answer = "ok";
  await until(() => adapter.health().state === "connected" && adapter.botName() === "TestBot");
});

test("Telegram: any other failure at getMe still stops the start, as before", async () => {
  const fakeFetch = async () => ({ status: 502, json: async () => ({ ok: false, error_code: 502, description: "Bad Gateway" }) });
  const adapter = new TelegramAdapter({ id: "telegram", token: "fake", fetch: fakeFetch, pollTimeoutSeconds: 1 });
  await assert.rejects(adapter.start(async () => undefined), /Telegram getMe failed: Bad Gateway/);
});
