import test from "node:test";
import assert from "node:assert/strict";
import { DiscordAdapter } from "../dist/channels/discord.js";

const fingerprint = "a".repeat(32);
const packet = (extra = {}) => ({ op: 0, t: "INTERACTION_CREATE", d: { id: "press1", token: "test-interaction-token", type: 3,
  channel_id: "dm", context: 1, user: { id: "owner", username: "Owner" },
  data: { custom_id: `y:${fingerprint}`, component_type: 2 }, ...extra } });
function fixture(status = 200) {
  const calls = [], inbound = [];
  const adapter = new DiscordAdapter({ id: "discord", token: "test-bot-token", fetch: async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ id: "message1" }), { status });
  } });
  const receive = (input) => adapter.receive(JSON.stringify(input), async (message) => { inbound.push(message); });
  return { adapter, calls, inbound, receive };
}
test("Discord command buttons show complete code with exact fingerprint", async () => {
  const { adapter, calls } = fixture();
  const text = "Run this?\nnode -p 1+1";
  await adapter.sendButtons("dm", text, [{ label: "Yes", value: `y:${fingerprint}` }], undefined,
    { spans: [{ offset: 10, length: 11, kind: "block", language: "shell" }] });
  assert.equal(calls[0].body.content, "Run this?\n```shell\nnode -p 1+1\n```");
  assert.equal(calls[0].body.components[0].components[0].custom_id, `y:${fingerprint}`);
});
test("Gateway button is acknowledged before routing, identifies actual DM sender, and cannot replay", async () => {
  const { calls, inbound, receive } = fixture();
  await receive(packet());
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/interactions\/press1\/test-interaction-token\/callback$/);
  assert.equal(calls[0].body.type, 6);
  assert.equal(inbound[0].senderId, "owner");
  assert.equal(inbound[0].chatKind, "direct");
  assert.equal(inbound[0].text, `y:${fingerprint}`);
  await receive(packet());
  assert.equal(inbound.length, 1);
  assert.equal(calls.length, 1);
});
for (const [label, extra] of [["guild", { guild_id: "g", context: 0 }], ["group DM", { context: 2 }], ["unknown context", { context: undefined }]])
  test(`Discord ${label} remains group-scoped for the command guard`, async () => {
    const { receive, inbound } = fixture();
    await receive(packet(extra));
    assert.equal(inbound[0].chatKind, "group");
  });
test("a refused interaction acknowledgement starts no task", async () => {
  const { receive, inbound } = fixture(401);
  await receive(packet());
  assert.deepEqual(inbound, []);
});
test("malformed, non-button and bot interaction packets start no task", async () => {
  const { receive, inbound, calls } = fixture();
  await receive(packet({ type: 2 }));
  await receive(packet({ user: { id: "bot", bot: true } }));
  await receive(packet({ data: { custom_id: "run-anything", component_type: 2 } }));
  assert.deepEqual(inbound, []);
  assert.deepEqual(calls, []);
});
