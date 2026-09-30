// CHAT-175: Revolt and KOOK show the status reaction on the person's message and take the previous one away, through
// each app's own reaction routes; nobody else's reactions are touched. Stand-in services only.
import test from "node:test";
import assert from "node:assert/strict";
import { httpService } from "./channels-parity-kit.mjs";
import { RevoltChannel } from "../dist/channels/revolt.js";
import { KookChannel } from "../dist/channels/kook.js";

test("Revolt: the new status reaction is put and the bot's previous one removed", async (t) => {
  const api = await httpService(t, () => ({ status: 204, body: "" , type: "text/plain" }));
  const revolt = new RevoltChannel({ id: "revolt", token: "revolt-test-token", apiBase: api.base });
  await revolt.react("CH1", "M1", "👀", "✅");
  assert.deepEqual(api.calls.map((c) => [c.method, decodeURIComponent(c.path)]), [
    ["DELETE", "/channels/CH1/messages/M1/reactions/✅"], ["PUT", "/channels/CH1/messages/M1/reactions/👀"]]);
});

test("KOOK: a channel reaction uses KOOK's emoji code, a DM uses the direct-message route", async (t) => {
  const api = await httpService(t, () => ({ body: { code: 0, message: "", data: {} } }));
  const kook = new KookChannel({ id: "kook", token: "kook-test-token", apiBase: `${api.base}/api/v3`, retryBaseMs: 20 });
  await kook.react("c:123", "msg-1", "👀");
  await kook.react("u:456", "msg-2", "✅", "👀");
  assert.deepEqual(api.calls.map((c) => [c.path, c.json?.emoji]), [
    ["/api/v3/message/add-reaction", "[#128064;]"],
    ["/api/v3/direct-message/delete-reaction", "[#128064;]"], ["/api/v3/direct-message/add-reaction", "[#9989;]"]]);
  await assert.rejects(kook.react("x:1", "msg", "👀"), /Invalid KOOK/);
});
