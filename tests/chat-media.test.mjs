/**
 * Files and voice beyond Telegram (CHAT-094, 102, 104, 105): pictures sent to Telegram as photos; files in from Discord,
 * Slack, Matrix and WhatsApp, fetched only from each app's own host and only when asked; files and spoken replies out
 * on Discord, Slack, Matrix and WhatsApp. Every service is a fake fetch; nothing leaves this computer.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { TelegramAdapter, telegramPhoto } from "../dist/channels/telegram.js";
import { DiscordAdapter } from "../dist/channels/discord.js";
import { SlackAdapter } from "../dist/channels/slack.js";
import { MatrixAdapter } from "../dist/channels/matrix.js";
import { WhatsAppAdapter } from "../dist/channels/whatsapp.js";
import { attachmentKind, fetchCapped } from "../dist/channels/media.js";

/** A fake service: answers each call with `answer(url, init)` and records it, form bodies included. */
function service(answer) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const body = init.body instanceof FormData ? Object.fromEntries([...init.body.entries()].map(([k, v]) => [k, typeof v === "string" ? v : `blob:${v.type}:${v.size}`]))
      : typeof init.body === "string" ? (() => { try { return JSON.parse(init.body); } catch { return init.body; } })() : init.body ? `bytes:${init.body.size ?? ""}` : undefined;
    calls.push({ url: String(url), method: init.method ?? "GET", headers: init.headers ?? {}, body });
    return answer(String(url), init);
  };
  return { calls, fetch };
}
const png = { name: "chart.png", mediaType: "image/png", bytes: new Uint8Array(2048) };

test("the shared pieces: kinds, and a file fetched only from the app's own host and never beyond the limit", async () => {
  assert.deepEqual(["image/png", "video/mp4", "application/pdf"].map(attachmentKind), ["picture", "video", "document"]);
  const ok = service(() => new Response(new Uint8Array(10)));
  assert.equal((await fetchCapped(ok.fetch, "https://files.slack.com/x", {}, /(^|\.)slack\.com$/i, "file")).byteLength, 10);
  await assert.rejects(fetchCapped(ok.fetch, "https://evil.example/x", {}, /(^|\.)slack\.com$/i, "file"), /not hosted by the chat app/);
  await assert.rejects(fetchCapped(ok.fetch, "http://files.slack.com/x", {}, /(^|\.)slack\.com$/i, "file"), /not hosted by the chat app/, "https only");
  await assert.rejects(fetchCapped(ok.fetch, "https://files.slack.com/x", {}, /(^|\.)slack\.com$/i, "file", 30 * 1024 * 1024), /larger than 20 MB/);
  const big = service(() => new Response(new Uint8Array(64)));
  await assert.rejects(fetchCapped(big.fetch, "https://files.slack.com/x", {}, /(^|\.)slack\.com$/i, "file", 0, 32), /larger than 0 MB/, "what really arrived is counted");
  assert.equal(ok.calls[0].url, "https://files.slack.com/x");
});

test("Telegram sends a picture it can show as a photo, and anything else (or a picture over 10 MB) as a file", async () => {
  assert.equal(telegramPhoto(png), true);
  assert.equal(telegramPhoto({ mediaType: "image/png", bytes: new Uint8Array(11 * 1024 * 1024) }), false);
  assert.equal(telegramPhoto({ mediaType: "image/gif", bytes: new Uint8Array(10) }), false);
  const tg = service(() => Response.json({ ok: true, result: { message_id: 7 } }));
  const adapter = new TelegramAdapter({ id: "telegram", token: "123:abc", fetch: tg.fetch });
  assert.equal(await adapter.sendFile("501", { ...png, caption: "Here" }), "7");
  await adapter.sendFile("501", { name: "notes.pdf", mediaType: "application/pdf", bytes: new Uint8Array(10) });
  assert.deepEqual(tg.calls.map((call) => call.url.split("/").pop()), ["sendPhoto", "sendDocument"]);
  assert.equal(tg.calls[0].body.photo, "blob:image/png:2048");
  assert.equal(tg.calls[0].body.caption, "Here");
  assert.equal(tg.calls[1].body.document, "blob:application/pdf:10");
});

test("Discord: pictures and files come in as material, fetched only when asked; a spoken reply goes out as audio", async () => {
  const discord = service((url) => (url.includes("cdn.discordapp.com") ? new Response(new Uint8Array(5)) : Response.json({ id: "m9" })));
  const adapter = new DiscordAdapter({ id: "discord", token: "t", fetch: discord.fetch });
  const message = adapter.inbound({ id: "m1", channel_id: "D1", content: "look at this", author: { id: "U1", username: "sam" }, mentions: [],
    attachments: [{ url: "https://cdn.discordapp.com/a/photo.png", content_type: "image/png", filename: "photo.png", size: 5 },
      { url: "https://cdn.discordapp.com/a/notes.pdf", content_type: "application/pdf", filename: "notes.pdf", size: 5 }] });
  assert.deepEqual(message.attachments.map((a) => [a.name, a.kind, a.mediaType]), [["photo.png", "picture", "image/png"], ["notes.pdf", "document", "application/pdf"]]);
  assert.equal(discord.calls.length, 0, "nothing is fetched until the message is answered");
  assert.equal((await message.attachments[0].bytes()).byteLength, 5);
  const onlyFile = adapter.inbound({ id: "m2", channel_id: "D1", content: "", author: { id: "U1" }, mentions: [], attachments: [{ url: "https://evil.example/x.png", content_type: "image/png" }] });
  assert.ok(onlyFile, "a message that is only a file is still a message");
  await assert.rejects(onlyFile.attachments[0].bytes(), /not hosted by the chat app/);
  await adapter.sendVoice("D1", new Uint8Array(30), "audio/ogg");
  const sent = discord.calls.at(-1);
  assert.match(sent.url, /\/channels\/D1\/messages$/);
  assert.equal(sent.body["files[0]"], "blob:audio/ogg:30");
  assert.match(sent.body.payload_json, /"filename":"reply.ogg"/);
});

test("Slack: a shared file is a message, fetched with the bot token from Slack's own host; a spoken reply is uploaded", async () => {
  const slack = service((url) => (url.startsWith("https://files.slack.com/") ? new Response(new Uint8Array(12))
    : url.endsWith("files.getUploadURLExternal") ? Response.json({ ok: true, upload_url: "https://files.slack.com/upload/v1/abc", file_id: "F9" })
      : url.startsWith("https://files.slack.com/upload") ? new Response("OK") : Response.json({ ok: true })));
  const adapter = new SlackAdapter({ id: "slack", token: "xoxb-1", appToken: "xapp-1", fetch: slack.fetch });
  const shared = adapter.inbound({ type: "message", subtype: "file_share", channel: "D1", channel_type: "im", user: "U1", ts: "1.0",
    files: [{ id: "F1", name: "report.pdf", mimetype: "application/pdf", size: 12, url_private_download: "https://files.slack.com/files-pri/T/report.pdf" }] });
  assert.equal(shared.text, "");
  assert.deepEqual(shared.attachments.map((a) => [a.name, a.kind, a.sourceId]), [["report.pdf", "document", "F1"]]);
  assert.equal((await shared.attachments[0].bytes()).byteLength, 12);
  assert.equal(slack.calls[0].headers.authorization, "Bearer xoxb-1");
  assert.equal(adapter.inbound({ type: "message", subtype: "message_changed", channel: "D1", user: "U1", ts: "2.0", text: "edited" }), null, "other subtypes stay out");
  await adapter.sendVoice("D1", new Uint8Array(40), "audio/mpeg", "1.0");
  const complete = slack.calls.find((call) => call.url.endsWith("files.completeUploadExternal"));
  assert.deepEqual(complete.body.files, [{ id: "F9", title: "reply.mp3" }]);
  assert.equal(complete.body.thread_ts, "1.0");
});

test("Matrix: files and audio in from the homeserver's authenticated media; files out uploaded, a spoken reply marked as voice", async () => {
  const matrix = service((url) => (url.includes("/media/download/") ? new Response(new Uint8Array(9))
    : url.includes("/_matrix/media/v3/upload") ? Response.json({ content_uri: "mxc://m.example.org/up1" }) : Response.json({ event_id: "$sent1" })));
  const adapter = new MatrixAdapter({ id: "matrix", homeserver: "https://m.example.org", userId: "@juniper:m.example.org", accessToken: "tok", fetch: matrix.fetch });
  const read = (content) => adapter.inbound("!room:m", { type: "m.room.message", event_id: "$in1", sender: "@alice:m", content });
  const picture = read({ msgtype: "m.image", body: "cat.jpg", url: "mxc://m.example.org/abc", info: { mimetype: "image/jpeg", size: 9 } });
  assert.deepEqual(picture.attachments.map((a) => [a.name, a.kind, a.mediaType]), [["cat.jpg", "picture", "image/jpeg"]]);
  assert.equal((await picture.attachments[0].bytes()).byteLength, 9);
  assert.equal(matrix.calls[0].url, "https://m.example.org/_matrix/client/v1/media/download/m.example.org/abc");
  assert.equal(matrix.calls[0].headers.authorization, "Bearer tok");
  const spoken = read({ msgtype: "m.audio", body: "voice", url: "mxc://m.example.org/v1", info: { mimetype: "audio/ogg", duration: 3000 } });
  assert.deepEqual([spoken.voice.mediaType, spoken.voice.seconds], ["audio/ogg", 3]);
  assert.equal(read({ msgtype: "m.image", body: "x", url: "https://evil.example/x" }), null, "only an mxc address on the homeserver");
  await adapter.sendFile("!room:m", { ...png, caption: "the chart" });
  const [upload, event, caption] = matrix.calls.slice(-3);
  assert.match(upload.url, /\/_matrix\/media\/v3\/upload\?filename=chart\.png$/);
  assert.deepEqual([event.body.msgtype, event.body.url, event.body.info.mimetype], ["m.image", "mxc://m.example.org/up1", "image/png"]);
  assert.equal(caption.body.body, "the chart");
  await adapter.sendVoice("!room:m", new Uint8Array(20), "audio/ogg");
  const voice = matrix.calls.at(-1).body;
  assert.equal(voice.msgtype, "m.audio");
  assert.deepEqual(voice["org.matrix.msc3245.voice"], {});
});

test("WhatsApp: a picture with a caption comes in; a file goes out uploaded then sent as its own kind, within WhatsApp's limits and window", async () => {
  const secret = "app-secret";
  const wa = service((url) => (url.endsWith("/media") ? Response.json({ id: "media-1" }) : url.includes("/media-in") ? Response.json({ url: "https://lookaside.fbsbx.com/x" })
    : url.startsWith("https://lookaside.fbsbx.com/") ? new Response(new Uint8Array(7)) : Response.json({ messages: [{ id: "wamid.9" }] })));
  let now = 1_000_000;
  const adapter = new WhatsAppAdapter({ id: "whatsapp", token: "tok", phoneNumberId: "123", verifyToken: "v", appSecret: secret, fetch: wa.fetch, apiBase: "https://graph.example.test/v21.0", now: () => now });
  const got = [];
  await adapter.start(async (message) => { got.push(message); });
  const raw = Buffer.from(JSON.stringify({ entry: [{ changes: [{ value: { contacts: [{ wa_id: "15551234567", profile: { name: "Sam" } }],
    messages: [{ id: "wamid.in1", from: "15551234567", type: "image", image: { id: "media-in", mime_type: "image/jpeg", caption: "what is this?" } }] } }] }] }));
  await adapter.receive(raw, `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`);
  assert.equal(got[0].text, "what is this?");
  assert.deepEqual(got[0].attachments.map((a) => [a.kind, a.mediaType, a.sourceId]), [["picture", "image/jpeg", "media-in"]]);
  assert.equal((await got[0].attachments[0].bytes()).byteLength, 7);

  assert.equal(await adapter.sendFile("15551234567", { ...png, mediaType: "image/png", caption: "your chart" }), "wamid.9");
  const [upload, message] = wa.calls.slice(-2);
  assert.match(upload.url, /\/123\/media$/);
  assert.deepEqual([upload.body.messaging_product, upload.body.type, upload.body.file], ["whatsapp", "image/png", "blob:image/png:2048"]);
  assert.deepEqual([message.body.type, message.body.image], ["image", { id: "media-1", caption: "your chart" }]);
  await adapter.sendFile("15551234567", { name: "notes.pdf", mediaType: "application/pdf", bytes: new Uint8Array(3) });
  assert.deepEqual(wa.calls.at(-1).body.document, { id: "media-1", filename: "notes.pdf" });
  await adapter.sendVoice("15551234567", new Uint8Array(3), "audio/ogg");
  assert.deepEqual(wa.calls.at(-1).body.audio, { id: "media-1" });
  await assert.rejects(adapter.sendFile("15551234567", { name: "big.png", mediaType: "image/png", bytes: new Uint8Array(6 * 1024 * 1024) }), /pictures up to 5 MB/);
  now += 25 * 60 * 60 * 1000;
  await assert.rejects(adapter.sendFile("15551234567", png), /24-hour reply window/, "files keep the reply window too");
});
