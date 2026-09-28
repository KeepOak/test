/**
 * iMessage through BlueBubbles (CHAT-153), against a fake BlueBubbles server shaped from bluebubbles-server's own routes
 * (f2e2286). The server only takes its password in the address, so the tests below also prove that password never
 * reaches an error, a health line, the console, the chat or anything Branch writes to disk, including when the network
 * layer fails with the whole address in its message. No real Mac or BlueBubbles server is used.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { fixture, until, delay, pairingWalk, assertNoSecret } from "./channels-parity-kit.mjs";
import { BlueBubblesChannel, blueBubblesService, serverAllowed } from "../dist/channels/bluebubbles.js";
import { buildParityChannel } from "../dist/channels/parity-config.js";
import { NetworkPolicy } from "../dist/network-policy.js";

const PASSWORD = "SECRET-BLUEBUBBLES-PW-/+&?= 42";
const SERVER = "https://mac.example.org";

function fakeServer({ password = PASSWORD } = {}) {
  const calls = [];
  const messages = [];
  let time = 1_000_000;
  let failWith = null;
  const fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    if (failWith) throw failWith(u.href);
    const body = init.body instanceof FormData ? Object.fromEntries([...init.body.entries()].map(([k, v]) => [k, typeof v === "string" ? v : `file:${v.name}:${v.type}:${v.size}`]))
      : init.body ? JSON.parse(init.body) : undefined;
    calls.push({ path: u.pathname, password: u.searchParams.get("password"), method: init.method, body, redirect: init.redirect });
    if (u.searchParams.get("password") !== password) return Response.json({ status: 401, message: "Unauthorized" }, { status: 401 });
    if (u.pathname === "/api/v1/message/query") {
      // The where clause Branch sends, applied the way the server applies it (message.ROWID > :rowid); ordered by date.
      const after = body.where?.find((w) => w.statement === "message.ROWID > :rowid")?.args.rowid;
      const list = body.sort === "DESC" ? messages.slice(-body.limit).reverse()
        : messages.filter((m) => m.originalROWID > after).sort((a, b) => a.dateCreated - b.dateCreated).slice(0, body.limit);
      return Response.json({ status: 200, data: list });
    }
    if (u.pathname === "/api/v1/message/text" || u.pathname === "/api/v1/message/attachment") return Response.json({ status: 200, data: { guid: `sent-${calls.length}` } });
    const download = /^\/api\/v1\/attachment\/([^/]+)\/download$/.exec(u.pathname);
    if (download) return new Response(new Uint8Array([7, 7, 7]), { headers: { "content-type": "image/jpeg" } });
    return new Response("{}", { status: 404 });
  };
  const say = (text, { from = "+15550001111", chat = "iMessage;-;+15550001111", style = 45, attachments = [], isAudioMessage = false, isFromMe = false, sentAt = ++time } = {}) =>
    messages.push({ guid: `m-${messages.length + 1}`, originalROWID: messages.length + 1, text, isFromMe, dateCreated: sentAt, handle: { address: from }, chats: [{ guid: chat, style, displayName: style === 43 ? "Family" : "" }], attachments, isAudioMessage });
  return { calls, fetch, say, fail: (make) => { failWith = make; } };
}
const channelOn = (server, extra = {}) => new BlueBubblesChannel({ id: "bluebubbles", server: SERVER, password: PASSWORD, passwordSecret: "BLUEBUBBLES_PASSWORD",
  pollMs: 20, retryBaseMs: 10, fetch: server.fetch, ...extra });

test("the address rule: https anywhere, plain http only on this computer or the local network, never credentials in it", () => {
  assert.equal(serverAllowed("https://abc.trycloudflare.com"), true);
  for (const lan of ["http://192.168.1.20:1234", "http://10.0.0.5:1234", "http://172.16.4.1", "http://my-mac.local:1234", "http://localhost:1234", "http://[fd00::1]:1234"])
    assert.equal(serverAllowed(lan), true, lan);
  for (const bad of ["http://mac.example.org", "http://8.8.8.8:1234", "http://172.32.0.1", "ftp://x", "https://u:p@x.org", "https://x.org/?password=1", "not a url"])
    assert.equal(serverAllowed(bad), false, bad);
  assert.equal(blueBubblesService.settings.safeParse({ server: "http://mac.example.org" }).success, false, "the setting refuses it too");
  assert.equal(blueBubblesService.settings.safeParse({ server: "http://192.168.1.20:1234" }).success, true);
  assert.throws(() => new BlueBubblesChannel({ id: "b", server: "http://mac.example.org", password: "x", passwordSecret: "B" }), /https address/);
});

test("with the network rules as shipped, a server on the local network is refused until private addresses are allowed", async () => {
  const config = { type: "bluebubbles", id: "bb", server: "http://192.168.1.20:1234", activation: "mention", pairing: true, allowlist: [] };
  const credential = async () => PASSWORD;
  await assert.rejects(buildParityChannel(config, { credential, policy: new NetworkPolicy({}, async () => []) }), /private or local address/);
  await assert.rejects(buildParityChannel({ ...config, server: "http://my-mac.local:1234" }, { credential, policy: new NetworkPolicy({}, async () => []) }), /private network/);
  const allowed = await buildParityChannel(config, { credential, policy: new NetworkPolicy({ allowPrivateAddresses: true }, async () => []) });
  assert.equal(allowed.kind, "bluebubbles", "allowed once the owner allows private addresses");
  const https = await buildParityChannel({ ...config, server: "https://mac.example.org" }, { credential, policy: new NetworkPolicy({}, async () => ["93.184.216.34"]) });
  assert.equal(https.kind, "bluebubbles", "the https link BlueBubbles gives works as shipped");
});

test("BlueBubbles: history is left alone, a stranger pairs, and replies go back through AppleScript with the password only in the address", async (t) => {
  const context = await fixture(t);
  const server = fakeServer();
  server.say("an old message from before Branch started");
  const channel = channelOn(server);
  await context.app.channels.attach(channel, { activation: "mention", pairing: true, allowlist: [] });
  t.after(() => channel.stop());
  await until(() => channel.health().state === "connected", "took stock");
  await until(() => server.calls.length >= 3, "polled again");
  assert.deepEqual(server.calls[0].body, { limit: 1, sort: "DESC" }, "the first look only takes stock");
  assert.deepEqual(server.calls[1].body, { limit: 100, sort: "ASC", where: [{ statement: "message.ROWID > :rowid", args: { rowid: 1 } }], with: ["chat", "attachment"] });
  assert.ok(server.calls.every((call) => call.password === PASSWORD && call.redirect === "error"), "the password in the address, and no redirect followed with it");

  const texts = () => server.calls.filter((c) => c.path === "/api/v1/message/text").map((c) => c.body.message);
  await pairingWalk(context, { label: "BlueBubbles", say: async (text) => server.say(text), sent: texts });
  const reply = server.calls.filter((c) => c.path === "/api/v1/message/text").at(-1).body;
  assert.equal(reply.chatGuid, "iMessage;-;+15550001111");
  assert.equal(reply.method, "apple-script", "no Private API needed");
  assert.match(reply.tempGuid, /^[0-9a-f-]{36}$/, "AppleScript sends need a tempGuid");

  // A message that reaches the Mac late keeps its sender's earlier time; it is still read, because the cursor is the row.
  const before = context.provider.requests.length;
  server.say("sent while my phone was offline", { sentAt: 5 });
  await until(() => context.provider.requests.length > before, "the late message is answered");
  const asked = context.provider.requests.length;
  server.say("sent from the Mac itself", { isFromMe: true });
  await delay(120);
  assert.equal(context.provider.requests.length, asked, "the owner's own messages are not answered");
  await assertNoSecret(context, [PASSWORD, encodeURIComponent(PASSWORD)]);
});

test("BlueBubbles: files in are downloaded only when asked, an audio message is a voice note, files go out as an attachment upload", async (t) => {
  const server = fakeServer();
  const got = [];
  const channel = channelOn(server);
  await channel.start(async (message) => { got.push(message); });
  t.after(() => channel.stop());
  await until(() => channel.health().state === "connected", "took stock");
  server.say("￼", { attachments: [{ guid: "at-1", mimeType: "image/heic", transferName: "IMG_1.HEIC", totalBytes: 3 }] });
  const picture = await until(() => got[0], "a picture");
  assert.equal(picture.text, "");
  assert.deepEqual(picture.attachments.map((a) => [a.name, a.kind, a.size]), [["IMG_1.HEIC", "picture", 3]]);
  assert.equal(server.calls.some((c) => c.path.includes("/attachment/")), false, "nothing downloaded before the message is answered");
  assert.deepEqual([...await picture.attachments[0].bytes()], [7, 7, 7]);
  assert.equal(server.calls.at(-1).path, "/api/v1/attachment/at-1/download");

  server.say(null, { attachments: [{ guid: "at-2", mimeType: "audio/x-caf", transferName: "Audio Message.caf" }], isAudioMessage: true });
  const voice = await until(() => got[1], "an audio message");
  assert.equal(voice.voice.mediaType, "audio/x-caf");
  server.say("big", { attachments: [{ guid: "at-3", mimeType: "video/mp4", totalBytes: 9 * 1024 * 1024 }] });
  const big = await until(() => got[2], "a large file");
  await assert.rejects(big.attachments[0].bytes(), (error) => error.constructor.name === "ArtifactTooLarge");
  server.say("group hello", { chat: "iMessage;+;chat99", style: 43 });
  const group = await until(() => got[3], "a group message");
  assert.deepEqual([group.chatKind, group.chatTitle, group.addressed], ["group", "Family", false]);

  await channel.sendFile(picture.chatId, { name: "../chart.png", mediaType: "image/png", bytes: new Uint8Array([1, 2]), caption: "Your chart" });
  const [upload, caption] = server.calls.filter((c) => c.method === "POST" && c.path !== "/api/v1/message/query").slice(-2);
  assert.equal(upload.path, "/api/v1/message/attachment");
  assert.deepEqual([upload.body.attachment, upload.body.name, upload.body.method, upload.body.isAudioMessage, upload.body.chatGuid],
    ["file:.._chart.png:image/png:2", ".._chart.png", "apple-script", "false", "iMessage;-;+15550001111"]);
  assert.equal(caption.body.message, "Your chart");
  await channel.sendVoice(picture.chatId, new Uint8Array([9]), "audio/mpeg");
  assert.equal(server.calls.at(-1).body.isAudioMessage, "true");
  assert.equal(server.calls.at(-1).body.name, "reply.mp3");
});

test("BlueBubbles: the password never shows in an error, a health line or the console, even when the network layer quotes the address", async (t) => {
  const context = await fixture(t);
  const wrong = fakeServer({ password: "the-real-one" });
  const refused = channelOn(wrong);
  await refused.start(async () => undefined);
  t.after(() => refused.stop());
  await until(() => refused.health().state === "needs attention", "a wrong password is named");
  assert.match(refused.health().reason, /refused the password.*BLUEBUBBLES_PASSWORD/);

  const broken = fakeServer();
  broken.fail((href) => new TypeError(`fetch failed: connect ECONNREFUSED for ${href} (password=${PASSWORD}; ${encodeURIComponent(PASSWORD)})`));
  const down = channelOn(broken);
  await down.start(async () => undefined);
  t.after(() => down.stop());
  await until(() => down.health().state === "reconnecting" && /could not be reached/.test(down.health().reason ?? ""), "the failure is said");
  const error = await down.send("iMessage;-;+1", "hi").catch((e) => e);
  const words = [refused.health().reason, down.health().reason, error.message, error.stack].join("\n");
  for (const form of [PASSWORD, encodeURIComponent(PASSWORD), new URLSearchParams({ p: PASSWORD }).toString().slice(2)])
    assert.ok(!words.includes(form), `the password (${form.slice(0, 12)}…) is not in: ${words}`);
  assert.match(error.message, /password=…/, "where it stood, it is replaced");
  await assertNoSecret(context, [PASSWORD, encodeURIComponent(PASSWORD)]);
});
