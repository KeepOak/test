import test from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fixture, httpService } from "./channels-parity-kit.mjs";
import { parityServices } from "../dist/channels/parity-services.js";
import { channelEntry } from "../dist/channels/catalog.js";
import { ChannelConfigSchema, loadIntegrations } from "../dist/integrations/bootstrap.js";

/**
 * mac6/bucket-16 ("the rest of the chat apps"): each audit row names services it found missing.
 * This proves every one of them is a service Branch registers and the connections file accepts;
 * the behaviour of each is proved in its own test file (named beside it below).
 */
const rows = {
  // Reddit, Twitch, X, Nostr: channels-parity-social, channels-parity, channels-parity-sockets.
  A2066: ["reddit", "twitch", "x-dm", "nostr"],
  // Weixin and QQ: channels-bucket16-wechat, channels-parity-gateways.
  A2117: ["wechat-mp", "wecom-app", "qq-bot"],
  // KOOK and QQ: channels-bucket16-kook, channels-parity-gateways.
  A2156: ["kook", "qq-bot"],
  // IRC: channels-parity, channels-bucket16-followups.
  A2349: ["irc"],
  // family channel-adapter's missing list: Signal, Matrix, Teams, iMessage and the Chinese apps.
  "channel-adapter": ["msteams-bot", "imessage", "qq-bot", "wechat-mp", "wecom-app"],
  // family messaging-channel: the WeChat gateway channel (the personal iLink one stays unbuilt).
  "messaging-channel": ["wechat-mp"],
};

test("every service an audit row names is registered, switched off, and documented", async () => {
  const kinds = new Set(parityServices.map((service) => service.kind));
  const { readFile } = await import("node:fs/promises");
  const docs = await readFile(join(import.meta.dirname, "..", "docs", "configuration.md"), "utf8");
  for (const [row, wanted] of Object.entries(rows))
    for (const kind of wanted) {
      assert.ok(kinds.has(kind), `${row}: ${kind} is a registered service`);
      assert.ok(docs.includes(`(\`${kind}\`)`), `${row}: ${kind} has its own section in docs/configuration.md`);
    }
  // The rest of the family rows ship through the core adapters and the shared-address services.
  for (const service of ["feishu", "dingtalk", "wecom"]) assert.ok(channelEntry(service), `${service} is in data/channels.json`);
  const base = { activation: "mention", pairing: true, allowlist: [] };
  assert.ok(ChannelConfigSchema.safeParse({ type: "signal", path: "/usr/local/bin/signal-cli", account: "+15551234567", ...base }).success);
  assert.ok(ChannelConfigSchema.safeParse({ type: "matrix", homeserver: "https://matrix.org", userId: "@branch:matrix.org", ...base }).success);
  assert.ok(ChannelConfigSchema.safeParse({ type: "chat", id: "lark", service: "feishu", ...base }).success);
  // The unofficial clients stay unbuilt, with the reason written in the parity table.
  for (const refused of ["Personal WeChat (iLink", "Personal QQ (OneBot", "Personal Zalo", "WhatsApp personal account", "Telegram userbot"])
    assert.match(docs, new RegExp(`\\| ${refused.replace(/[()]/g, "\\$&")}[^\\n]*\\| not built: `), `${refused} is listed as not built, with why`);
});

test("the connections file takes the new services by type and keeps each one off", async (t) => {
  const context = await fixture(t);
  const { app, root } = context;
  const stand = await httpService(t, () => ({ body: {} }));
  const path = join(root, "connections.json");
  const channels = [
    { type: "kook", id: "kook", apiBase: `${stand.base}/api/v3` },
    { type: "wechat-mp", id: "wechat", appId: "wx0123456789abcdef", apiBase: stand.base },
    { type: "wecom-app", id: "wecom", corpId: "ww0123456789abcdef", agentId: 1000002, apiBase: stand.base },
    { type: "irc", id: "irc", server: "127.0.0.1", port: 6697, nick: "branch" },
  ];
  await writeFile(path, JSON.stringify({ web: { allowPrivateAddresses: true }, channels }));
  const env = { KOOK_BOT_TOKEN: "k", WECHAT_MP_APP_SECRET: "a", WECHAT_MP_TOKEN: "t", WECHAT_MP_AES_KEY: "k".repeat(43),
    WECOM_APP_SECRET: "s", WECOM_APP_TOKEN: "t", WECOM_APP_AES_KEY: "k".repeat(43) };
  const loaded = await loadIntegrations(app.registry, path, env, app.secretsFor, app.channelHost);
  t.after(() => loaded.close());
  for (const { id, type } of channels) {
    const summary = app.channels.summary().channels.find((c) => c.id === id);
    assert.equal(summary.kind, type);
    assert.equal(summary.health.state, "needs attention", `${type} is off until switched on`);
  }
  assert.equal(stand.calls.length, 0, "nothing left the computer while they were off");
});
