/**
 * Branch's commands in each app's own picker (CHAT-161, CHAT-164): registered with Discord as slash commands from the
 * one command table, following the owner's switches; chosen from Discord's picker or typed as Slack's /branch, they
 * reach the router as the typed command from the person who chose it, with every rule a typed command meets.
 * Discord and Slack are fakes here; no real server is reached.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { saveCommandSettings } from "../dist/commands/settings.js";
import { DiscordAdapter } from "../dist/channels/discord.js";
import { SlackAdapter } from "../dist/channels/slack.js";
import { recipeFor } from "../dist/channel-setup/recipes.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-native-commands-"));
  const provider = { name: "scripted", async complete() { return { content: "hello", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  t.after(async () => { await app.close(); await discardTemp(root); });
  return { app };
}
function recorder(answer = () => Response.json({ ok: true, ts: "1.1", user_id: "UBOT", user: "juniper" })) {
  const calls = [];
  const fetch = async (url, init = {}) => { calls.push({ url: String(url), method: init.method ?? "GET", body: typeof init.body === "string" ? JSON.parse(init.body) : init.body }); return answer(String(url), init); };
  return { calls, fetch };
}

test("the app's picker lists the chat's commands from the one table, and nothing while chat commands are off", async (t) => {
  const { app } = await fixture(t);
  const menus = [];
  await app.channels.attach({ id: "picker", kind: "fake", botName: () => "bot", async start() {}, async stop() {}, async send() { return "1"; },
    async setCommands(commands) { menus.push(commands); } }, {});
  await app.channels.refreshCommandMenus();
  assert.deepEqual(menus.at(-1), [], "chat commands ship off, so the picker offers nothing that would be read as a message");
  app.channels.setSwitches({ commands: "on" });
  saveCommandSettings(app.store, app.runtime.owner, { mode: "on" });
  await app.channels.refreshCommandMenus();
  const names = menus.at(-1).map((one) => one.command);
  for (const name of ["help", "status", "stop", "new", "usage"]) assert.ok(names.includes(name), name);
  assert.ok(!names.includes("lockdown") && !names.includes("preset"), "never a command a chat cannot send");
  assert.ok(menus.at(-1).every((one) => one.description.length > 0));
  app.channels.setSwitches({ commands: "off" });
  await app.channels.refreshCommandMenus();
  assert.deepEqual(menus.at(-1), [], "switching commands off empties the picker too");
});

test("Discord: the list is registered once the application is known, as one overwrite, with a text option each", async () => {
  const discord = recorder(() => Response.json([]));
  const adapter = new DiscordAdapter({ id: "discord", token: "T", fetch: discord.fetch });
  await adapter.setCommands([{ command: "status", description: "what is working right now, and with which model" }, { command: "btw", description: "x".repeat(150) }]);
  assert.equal(discord.calls.length, 0, "nothing to register against before READY names the application");
  adapter.ready({ user: { id: "B1", username: "juniper" }, session_id: "s", application: { id: "APP9" } });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const put = discord.calls[0];
  assert.equal(put.method, "PUT");
  assert.match(put.url, /\/applications\/APP9\/commands$/);
  assert.deepEqual(put.body.map((one) => one.name), ["status", "btw"]);
  assert.equal(put.body[1].description.length, 100, "Discord's 100-character limit");
  assert.deepEqual(put.body[0].options, [{ type: 3, name: "text", description: "What follows the command", required: false, max_length: 4000 }]);
  await adapter.setCommands([]);
  assert.deepEqual(discord.calls.at(-1).body, [], "an empty list clears Discord's picker");
});

test("Discord: a command chosen from the picker is acknowledged to that person alone, then read as the typed command", async () => {
  const discord = recorder(() => new Response(null, { status: 204 }));
  const adapter = new DiscordAdapter({ id: "discord", token: "T", fetch: discord.fetch });
  const got = [];
  const choose = (extra) => adapter.slash({ id: `i${Math.random()}`, token: "tok", type: 2, channel_id: "C1", guild_id: "G1", member: { user: { id: "U1", username: "sam" } },
    data: { name: "btw", options: [{ name: "text", value: "what time is it" }] }, ...extra }, async (message) => { got.push(message); });
  await choose({});
  const ack = discord.calls[0];
  assert.match(ack.url, /\/interactions\/i[\d.]+\/tok\/callback$/);
  assert.deepEqual(ack.body, { type: 4, data: { content: "Running /btw what time is it", flags: 64, allowed_mentions: { parse: [] } } });
  assert.deepEqual([got[0].text, got[0].senderId, got[0].chatKind, got[0].addressed], ["/btw what time is it", "U1", "group", true]);
  await choose({ member: undefined, user: { id: "B2", bot: true } });
  assert.equal(got.length, 1, "a bot's command is not read");
});

test("Slack: /branch <command> is that command from that person; other words are theirs; /branch alone is /help", async (t) => {
  const slack = recorder();
  const adapter = new SlackAdapter({ id: "slack", token: "xoxb-1", appToken: "xapp-1", fetch: slack.fetch });
  adapter.user = { id: "UBOT", name: "juniper" };
  const slash = (text, extra = {}) => adapter.fromSlash({ command: "/branch", text, user_id: "U1", user_name: "sam", channel_id: "D1", trigger_id: "tr1", ...extra });
  assert.equal(slash("status").text, "/status");
  assert.equal(slash("btw what time is it").text, "/btw what time is it");
  assert.equal(slash("").text, "/help");
  assert.equal(slash("what is the weather").text, "what is the weather", "not a command: the person's own words");
  assert.deepEqual([slash("status").chatKind, slash("status", { channel_id: "C1" }).chatKind], ["direct", "group"]);
  assert.equal(adapter.fromSlash({ command: "/other", text: "status", user_id: "U1", channel_id: "D1" }), null, "only Branch's own command");
  assert.equal(slash("status", { user_id: "UBOT" }), null);
  const manifest = recipeFor("slack").manifest;
  assert.equal(manifest.features.slash_commands[0].command, "/branch");
  assert.ok(manifest.oauth_config.scopes.bot.includes("commands"));
  assert.match(recipeFor("discord").create.how, /applications\.commands/);

  // Through the router: a paired person's /branch status is answered in the chat, not in a thread that is not one.
  const { app } = await fixture(t);
  app.channels.setSwitches({ commands: "on" });
  saveCommandSettings(app.store, app.runtime.owner, { mode: "on" });
  const posts = recorder();
  const live = new SlackAdapter({ id: "slack", token: "xoxb-1", appToken: "xapp-1", fetch: posts.fetch, socketUrl: "wss://slack.invalid",
    connect: async () => { let done; const closed = new Promise((resolve) => { done = resolve; }); return { send() {}, close() { done(); }, closed }; } });
  await app.channels.attach(live, { pairing: true, allowlist: ["U1"] });
  live.user = { id: "UBOT", name: "juniper" };
  assert.equal(await app.channels.handle(live.fromSlash({ command: "/branch", text: "status", user_id: "U1", channel_id: "D1", trigger_id: "tr2" })), "replied");
  const reply = posts.calls.filter((call) => call.url.endsWith("chat.postMessage")).at(-1).body;
  assert.match(reply.text, /Nothing is working right now/);
  assert.equal(reply.thread_ts, undefined);
});
