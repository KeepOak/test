import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBranch, DiscordAdapter, SlackAdapter, MatrixAdapter, TelegramAdapter } from "../dist/index.js";
import { channelFormatting, installChannelFormatting, plainChatText, saveChannelFormatting } from "../dist/channels/formatting-settings.js";
import { discardTemp } from "./temp-dir.mjs";
import { chunkText } from "../dist/channels/deliveries.js";

test("plain text retains code symbols and link destinations, with no placeholder interpretation", () => {
  assert.equal(plainChatText("# Heading\n**Bold** and _italic_\n[Guide](https://example.test)\n```shell\ncat *_notes.md\n```\n`a*b`\n\u00000\u0000"),
    "Heading\nBold and italic\nGuide (https://example.test)\ncat *_notes.md\na*b\n\u00000\u0000");
  assert.equal(plainChatText("file_name.txt and a * b"), "file_name.txt and a * b");
});

test("formatting persists by owner and app, applies immediately, and reconnect does not wrap twice", async (t) => {
  const scratch = join(tmpdir(), "Codex-session-files");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "chat-format-"));
  const options = { workspace: join(root, "workspace"), dataDir: join(root, "data") };
  const app = await createBranch(options);
  let restarted;
  t.after(async () => { await (restarted ?? app).close(); await discardTemp(root); });
  const calls = [];
  const adapter = { id: "custom-slack", kind: "slack", botName: () => "test", async start() {}, async stop() {},
    async send(chat, text, reply, format) { assert.equal(this, adapter); calls.push({ text, format }); return "m"; },
    async edit(chat, message, text, format) { assert.equal(this, adapter); calls.push({ text, format }); } };
  await app.channels.attach(adapter, {});
  assert.equal(app.channels.adapter(adapter.id), adapter);
  assert.equal(channelFormatting(app.store, "local", "slack"), "native");
  saveChannelFormatting(app.store, "local", { channel: "slack", mode: "plain" }, ["slack"]);
  assert.equal(channelFormatting(app.store, "other-owner", "slack"), "native");
  assert.equal(channelFormatting(app.store, "local", "discord"), "native");
  await adapter.send("c", "**bold** wildcard *file*", undefined, { quiet: true, spans: [{ offset: 18, length: 6, kind: "inline" }] });
  assert.deepEqual(calls.at(-1), { text: "bold wildcard *file*", format: { plain: true, quiet: true, spans: undefined } });
  await app.channels.detach(adapter.id);
  await app.channels.attach(adapter, {});
  await adapter.edit("c", "m", "**bold**");
  assert.equal(calls.at(-1).text, "bold");
  saveChannelFormatting(app.store, "local", { channel: "slack", mode: "native" }, ["slack"]);
  await adapter.send("c", "**bold**");
  assert.equal(calls.at(-1).text, "**bold**", "reattach did not leave an inner plain wrapper");
  saveChannelFormatting(app.store, "local", { channel: "slack", mode: "plain" }, ["slack"]);
  assert.throws(() => saveChannelFormatting(app.store, "local", { channel: "unknown-app", mode: "plain" }, ["slack"]));
  assert.throws(() => saveChannelFormatting(app.store, "local", { channel: "slack", mode: "html" }, ["slack"]));
  await app.close();
  restarted = await createBranch(options);
  assert.equal(channelFormatting(restarted.store, "local", "slack"), "plain");
});

test("Slack plain text pings nobody: its notification text escapes Slack's control characters", async () => {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ ok: true, ts: "1.2" }), { headers: { "content-type": "application/json" } });
  };
  const adapter = new SlackAdapter({ id: "slack", token: "fake", fetch });
  installChannelFormatting(adapter, () => "plain");
  await adapter.send("c", "hey <!channel> & @here, see <https://x.test|this>");
  assert.equal(calls[0].text, "hey &lt;!channel&gt; &amp; @here, see &lt;https://x.test|this&gt;");
  assert.equal(calls[0].parse, undefined);
  assert.equal(calls[0].blocks[0].text.text, "hey <!channel> & @here, see <https://x.test|this>", "the block shows the words as written");
});

test("native adapters honor plain on sends and edits while keeping quiet and literal code characters", async () => {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 }, id: "m", ts: "1.2", event_id: "$m" }), { headers: { "content-type": "application/json" } });
  };
  const adapters = [new SlackAdapter({ id: "slack", token: "fake", fetch }),
    new DiscordAdapter({ id: "discord", token: "fake", fetch }),
    new MatrixAdapter({ id: "matrix", homeserver: "http://matrix.test", accessToken: "fake", userId: "@b:test", fetch }),
    new TelegramAdapter({ id: "telegram", token: "fake", fetch })];
  for (const adapter of adapters) {
    installChannelFormatting(adapter, () => "plain");
    const id = await adapter.send("c", "**bold** `*file*`", undefined, { quiet: true });
    await adapter.edit("c", id, "**bold** `*file*`");
  }
  assert.equal(calls[0].body.text, "bold *file*");
  assert.deepEqual(calls[0].body.blocks, [{ type: "section", text: { type: "plain_text", text: "bold *file*", emoji: false } }]);
  assert.deepEqual(calls[1].body.blocks, calls[0].body.blocks);
  assert.equal(calls[1].body.mrkdwn, undefined, "chat.update uses documented plain_text blocks, not an unsupported argument");
  assert.equal(calls[1].body.parse, undefined, "parse full would turn a written @channel into a ping");
  assert.equal(calls[2].body.content, "bold \\*file\\*");
  assert.equal(calls[2].body.flags, 4096);
  assert.equal(calls[4].body.body, "bold *file*");
  const slack = calls.slice(0, 2);
  for (const call of slack) assert.equal(call.body.parse, undefined);
  assert.equal(calls[4].body.formatted_body, undefined);
  assert.equal(calls[5].body["m.new_content"].formatted_body, undefined);
  assert.equal(calls[6].body.text, "bold *file*");
  assert.equal(calls[6].body.entities, undefined);
  assert.equal(calls[6].body.disable_notification, true);
  const discord = adapters[1], before = calls.length, code = "*".repeat(3000);
  assert.equal(discord.maxTextLength, 1000, "splitting reserves space for escaped literal symbols");
  for (const chunk of chunkText(code, discord.maxTextLength)) await discord.send("c", chunk, undefined,
    { spans: [{ offset: 0, length: chunk.length, kind: "block" }] });
  assert.equal(calls.slice(before).map((call) => call.body.content.replace(/\\\*/g, "*")).join(""), code);
  assert.ok(calls.slice(before).every((call) => call.body.content.length <= 2000));
});
