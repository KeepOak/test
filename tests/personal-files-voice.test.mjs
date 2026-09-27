/**
 * R17-022, R17-025, R17-026, R17-031, R17-032: files into chats (and the three adapters' uploads),
 * the spoken briefing, a spoken yes, searching the email channel's inbox, and the webhook-only
 * tunnel. Temporary folders, a loopback fake mail server and fake programs only.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { request as httpRequest, createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { discardTemp } from "./temp-dir.mjs";
import { fakeStore, on } from "./personal-kit.mjs";
import { WorkspaceFiles } from "../dist/files.js";
import { ImapClient } from "../dist/channels/mail-client.js";
import { TelegramAdapter } from "../dist/channels/telegram.js";
import { DiscordAdapter } from "../dist/channels/discord.js";
import { SlackAdapter } from "../dist/channels/slack.js";
import { ChatFiles, mediaTypeOf } from "../dist/personal/chat-files.js";
import { imapDate, MailSearch, safeFileName, searchKeys } from "../dist/personal/mail-search.js";
import { attachmentsOf, mimeParts, textOf } from "../dist/personal/mime.js";
import { offerLifetimeMs, spokenDecision, VoiceApprovals } from "../dist/personal/voice-approvals.js";
import { eventLine, mailLine, speakable, SpokenBrief } from "../dist/personal/spoken-brief.js";
import { tunnelCommand, webhookOnly, WebhookTunnel } from "../dist/personal/tunnel.js";

async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-personal-files-"));
  t.after(async () => { await discardTemp(root); });
  await mkdir(join(root, "reports"), { recursive: true });
  return { root, files: new WorkspaceFiles(root) };
}

function chatFiles(files, over = {}) {
  const store = fakeStore();
  on(store, "chat-files");
  const sent = [];
  const adapter = { kind: "telegram", maxFileBytes: 1024 * 1024, async sendFile(chatId, file, replyTo) { sent.push({ chatId, file, replyTo }); return "m9"; } };
  const deps = { store, owner: "local", files, adapter: (id) => (id === "tg" ? adapter : undefined),
    reachable: (channel, chatId) => chatId === "42", outboundGuard: async (text) => ({ text: text.replace("Ada", "[name]"), blocked: false }),
    holdsKnownSecret: (text) => text.includes("locker-value-123"), requireOwner: () => undefined, ...over };
  return { chat: new ChatFiles(deps), sent, store, adapter };
}

test("R17-022: a workspace file goes to a chat that talks to the assistant, with its caption checked, and is recorded", async (t) => {
  const { root, files } = await workspace(t);
  await writeFile(join(root, "reports", "chart.csv"), "month,trees\nMay,4\n");
  const { chat, sent, store } = chatFiles(files);
  const result = await chat.send({ channel: "tg", chatId: "42", path: "reports/chart.csv", caption: "For Ada", replyTo: "7" });
  assert.equal(result.sent, "chart.csv");
  assert.equal(sent[0].file.mediaType, "text/csv");
  assert.equal(sent[0].file.caption, "For [name]");
  assert.equal(sent[0].replyTo, "7");
  assert.equal(Buffer.from(sent[0].file.bytes).toString(), "month,trees\nMay,4\n");
  assert.equal(store.audits[0].action, "data.exported");
  assert.equal(mediaTypeOf("a.XLSX"), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
});

test("R17-022: nothing is sent to a stranger, from outside the workspace, over the limit, or holding a key", async (t) => {
  const { root, files } = await workspace(t);
  await writeFile(join(root, "reports", "keys.txt"), "token = sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH\n"); // not-a-real-secret
  await writeFile(join(root, "reports", "known.txt"), "the value is locker-value-123\n");
  await writeFile(join(root, "reports", "big.bin"), Buffer.alloc(2 * 1024 * 1024));
  await writeFile(join(root, "reports", "ok.txt"), "fine\n");
  const { chat, sent } = chatFiles(files);
  await assert.rejects(chat.send({ channel: "tg", chatId: "99", path: "reports/ok.txt" }), /never talked to the assistant/);
  await assert.rejects(chat.send({ channel: "slack", chatId: "42", path: "reports/ok.txt" }), /No chat app called slack/);
  await assert.rejects(chat.send({ channel: "tg", chatId: "42", path: "../etc/passwd" }), /Path denied/);
  await assert.rejects(chat.send({ channel: "tg", chatId: "42", path: "/etc/hosts" }), /Path denied/);
  await assert.rejects(chat.send({ channel: "tg", chatId: "42", path: ".env" }), /Path denied/);
  await assert.rejects(chat.send({ channel: "tg", chatId: "42", path: "reports/big.bin" }), /over the 1 MB/);
  await assert.rejects(chat.send({ channel: "tg", chatId: "42", path: "reports/keys.txt" }), /looks like a key/);
  await assert.rejects(chat.send({ channel: "tg", chatId: "42", path: "reports/known.txt" }), /saved secrets/);
  assert.equal(sent.length, 0);
  const noFiles = chatFiles(files, { adapter: () => ({ kind: "irc" }) });
  await assert.rejects(noFiles.chat.send({ channel: "irc", chatId: "42", path: "reports/ok.txt" }), /cannot take files/);
  const locked = chatFiles(files, { outboundGuard: async () => ({ text: "", blocked: true, reason: "Lockdown is on, so nothing is being sent out." }) });
  await assert.rejects(locked.chat.send({ channel: "tg", chatId: "42", path: "reports/ok.txt" }), /Lockdown is on/);
  assert.equal(locked.sent.length, 0);
  const notOwner = chatFiles(files, { requireOwner: () => { throw new Error("Only the owner can do that"); } });
  await assert.rejects(notOwner.chat.send({ channel: "tg", chatId: "42", path: "reports/ok.txt" }), /Only the owner/);
  const off = chatFiles(files);
  off.store.save("settings", "local", "personal-chat-files", { mode: "off" });
  await assert.rejects(off.chat.send({ channel: "tg", chatId: "42", path: "reports/ok.txt" }), /switched off/);
});

/** A fetch that records what each adapter sent and answers in that service's shape. */
function recorder(answer) {
  const seen = [];
  return { seen, fetch: async (url, init = {}) => { seen.push({ url: String(url), init }); return new Response(JSON.stringify(answer(String(url))), { status: 200 }); } };
}
const file = { name: "chart.png", mediaType: "image/png", bytes: new Uint8Array([1, 2, 3]), caption: "Here it is" };

test("R17-022: Telegram sends a document, Discord a multipart message, Slack the three-step upload", async () => {
  const tg = recorder(() => ({ ok: true, result: { message_id: 5 } }));
  assert.equal(await new TelegramAdapter({ id: "tg", token: "T0K", fetch: tg.fetch }).sendFile("42", file, "3"), "5");
  const form = tg.seen[0].init.body;
  assert.ok(tg.seen[0].url.endsWith("/botT0K/sendDocument"));
  assert.equal(form.get("chat_id"), "42");
  assert.equal(form.get("caption"), "Here it is");
  assert.equal(form.get("reply_to_message_id"), "3");
  assert.equal(form.get("document").name, "chart.png");

  const dc = recorder(() => ({ id: "900" }));
  assert.equal(await new DiscordAdapter({ id: "dc", token: "D", fetch: dc.fetch }).sendFile("c1", file), "900");
  const payload = JSON.parse(dc.seen[0].init.body.get("payload_json"));
  assert.deepEqual(payload, { content: "Here it is", attachments: [{ id: 0, filename: "chart.png" }] });
  assert.equal(dc.seen[0].init.body.get("files[0]").size, 3);
  assert.equal(dc.seen[0].init.headers.authorization, "Bot D");

  const sl = recorder((url) => url.includes("getUploadURLExternal") ? { ok: true, upload_url: "https://files.slack.com/upload/v1/abc", file_id: "F1" } : { ok: true });
  assert.equal(await new SlackAdapter({ id: "sl", token: "xoxb-1", appToken: "xapp-1", fetch: sl.fetch }).sendFile("C1", file, "171.2"), "F1");
  assert.deepEqual(sl.seen.map((r) => r.url), ["https://slack.com/api/files.getUploadURLExternal", "https://files.slack.com/upload/v1/abc", "https://slack.com/api/files.completeUploadExternal"]);
  assert.equal(sl.seen[0].init.body, "filename=chart.png&length=3");
  assert.equal(sl.seen[1].init.headers, undefined, "the upload address gets no bot token");
  const elsewhere = recorder((url) => url.includes("getUploadURLExternal") ? { ok: true, upload_url: "https://attacker.example/slack.com/x", file_id: "F2" } : { ok: true });
  await assert.rejects(new SlackAdapter({ id: "sl", token: "xoxb-1", appToken: "xapp-1", fetch: elsewhere.fetch }).sendFile("C1", file), /outside slack\.com/);
  assert.equal(elsewhere.seen.length, 1);
  assert.deepEqual(JSON.parse(sl.seen[2].init.body), { files: [{ id: "F1", title: "chart.png" }], channel_id: "C1", initial_comment: "Here it is", thread_ts: "171.2" });
});

/* ---------- R17-031: the inbox ---------- */
const raw = [
  "From: Ada <ada@example.com>", "Subject: Plans", "MIME-Version: 1.0",
  'Content-Type: multipart/mixed; boundary="XX"', "", "--XX", "Content-Type: text/plain; charset=utf-8",
  "Content-Transfer-Encoding: quoted-printable", "", "Here are the plans =E2=9C=93", "--XX",
  'Content-Type: application/pdf; name="plan.pdf"', 'Content-Disposition: attachment; filename="../../plan.pdf"',
  "Content-Transfer-Encoding: base64", "", Buffer.from("%PDF-1.4 oak").toString("base64"), "--XX--", "",
].join("\r\n");

/** A loopback IMAP server that answers just the commands the inbox search sends. */
async function fakeImap(t) {
  const commands = [];
  const server = createServer((socket) => {
    socket.write("* OK ready\r\n");
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      for (let at = buffer.indexOf("\r\n"); at >= 0; at = buffer.indexOf("\r\n")) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        const [tag, ...rest] = line.split(" ");
        const command = rest.join(" ");
        commands.push(command);
        const header = "From: Ada <ada@example.com>\r\nSubject: Plans\r\n\r\n", text = "Here are the plans";
        let body = "";
        if (command.startsWith("UID SEARCH")) body = "* SEARCH 3 7\r\n";
        else if (command.includes("RFC822.SIZE")) body = `* 1 FETCH (UID 7 RFC822.SIZE ${raw.length})\r\n`;
        else if (command.includes("BODY.PEEK[])")) body = `* 1 FETCH (UID 7 BODY[] {${raw.length}}\r\n${raw})\r\n`;
        else if (command.startsWith("UID FETCH")) body = `* 1 FETCH (UID 7 BODY[HEADER] {${header.length}}\r\n${header} BODY[TEXT]<0> {${text.length}}\r\n${text})\r\n`;
        socket.write(`${body}${tag} OK done\r\n`);
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { port: server.address().port, commands };
}

test("R17-031: search keys are quoted, dates are IMAP dates, and nothing becomes a command", () => {
  assert.equal(searchKeys({ from: 'ada" OR ALL', unread: true, since: "2026-09-01", max: 5 }), 'FROM "ada\\" OR ALL" SINCE 1-Sep-2026 UNSEEN');
  assert.equal(searchKeys({ max: 5 }), "ALL");
  assert.equal(imapDate("2026-12-31"), "31-Dec-2026");
  assert.throws(() => imapDate("2026-13-01"), /not a real date/);
  assert.equal(safeFileName("../../evil\u0000.pdf", 1), "_.._evil_.pdf");
  assert.equal(safeFileName("...", 2), "attachment-2");
});

test("R17-031: the inbox is searched and opened without marking anything read, and an attachment is saved in the workspace", async (t) => {
  const imap = await fakeImap(t);
  const { root, files } = await workspace(t);
  const store = fakeStore();
  const hosts = [];
  const mail = new MailSearch({ store, owner: "local", files, secret: async (name) => (name === "EMAIL_PASSWORD" ? "pw" : ""),
    assertHost: async (host, port) => { hosts.push([host, port]); },
    imap: (server) => new ImapClient({ ...server, host: "127.0.0.1", port: imap.port, tls: false }) });
  on(store, "mail-search", "off"); // ships "when needed" (the owner's rule, 2026-09-26); "off" is tested switched off
  await assert.rejects(mail.search({}), /switched off/);
  on(store, "mail-search");
  await assert.rejects(mail.search({}), /mail server/);
  mail.save({ host: "imap.example.com", user: "me@example.com" });
  const found = await mail.search({ subject: "Plans", unread: true, max: 5 });
  assert.deepEqual(found.messages.map((m) => [m.uid, m.subject]), [[7, "Plans"], [3, "Plans"]]);
  assert.deepEqual(hosts[0], ["imap.example.com", 993]);
  assert.ok(imap.commands.includes('UID SEARCH SUBJECT "Plans" UNSEEN'));
  const opened = await mail.open({ uid: 7 });
  assert.equal(opened.text.trim(), "Here are the plans ✓");
  assert.deepEqual(opened.attachments, [{ index: 1, filename: "../../plan.pdf", contentType: "application/pdf", bytes: 12 }]);
  const saved = await mail.saveAttachment({ uid: 7, index: 1 });
  assert.equal(saved.saved, "mail-attachments/_.._plan.pdf");
  assert.equal(await readFile(join(root, "mail-attachments", "_.._plan.pdf"), "utf8"), "%PDF-1.4 oak");
  assert.equal((await mail.saveAttachment({ uid: 7, index: 1 })).saved, "mail-attachments/_.._plan (2).pdf");
  await assert.rejects(mail.saveAttachment({ uid: 7, index: 0 }), /no attachment with that number/);
  assert.equal(imap.commands.some((c) => /STORE|\\Seen|EXPUNGE|DELETE/.test(c)), false, "nothing is marked or removed");
  await assert.rejects(mail.search({ text: "café" }), /plain letters/);
});

test("R17-031: MIME parts decode, and nesting is bounded", () => {
  const parts = mimeParts(raw);
  assert.equal(textOf(parts).trim(), "Here are the plans ✓");
  assert.equal(attachmentsOf(parts).length, 1);
  let deep = "Content-Type: text/plain\r\n\r\nbottom";
  for (let i = 0; i < 12; i++) deep = `Content-Type: multipart/mixed; boundary=b${i}\r\n\r\n--b${i}\r\n${deep}\r\n--b${i}--`;
  assert.ok(mimeParts(deep).length <= 1);
  assert.equal(textOf(mimeParts("Content-Type: text/html\r\n\r\n<p>Hi<script>x()</script></p>")), "Hi");
});

/* ---------- R17-026: a spoken yes ---------- */
test("R17-026: only a plain yes or no decides; anything longer or mixed decides nothing", () => {
  for (const said of ["Yes", "yes.", "Oui !", "go ahead", "D’accord"]) assert.equal(spokenDecision(said), "allow", said);
  for (const said of ["No", "non", "don't", "Stop!"]) assert.equal(spokenDecision(said), "deny", said);
  for (const said of ["", "yes no", "not yet", "yes but only the first file please", "yesterday", "no yes"]) assert.equal(spokenDecision(said), null, said);
});

test("R17-026: a spoken answer is bound to one request, used once, and runs out after two minutes", async () => {
  const store = fakeStore();
  on(store, "voice-approvals");
  let now = 1_000_000;
  const approved = [];
  const waiting = new Map([["s1:fp-a", { label: "Delete the old report" }]]);
  const voice = new VoiceApprovals({ store, owner: "local", now: () => now,
    question: (sessionId, fingerprint) => waiting.get(`${sessionId}:${fingerprint}`),
    approve: (...args) => approved.push(args), risky: () => false,
    transcribe: async (clip) => (clip.bytes.toString() === "spoken-yes" ? "Yes." : "hmm") });
  const session = "11111111-1111-4111-8111-111111111111";
  waiting.set(`${session}:fp-a`, { label: "Delete the old report" });
  assert.throws(() => voice.offer({ sessionId: session, fingerprint: "fp-other" }), /no longer waiting/);
  const offer = voice.offer({ sessionId: session, fingerprint: "fp-a" });
  const unclear = await voice.answer({ id: offer.id, audio: Buffer.from("mumble").toString("base64") });
  assert.equal(unclear.decision, null);
  assert.equal(approved.length, 0);
  const yes = await voice.answer({ id: offer.id, audio: Buffer.from("spoken-yes").toString("base64"), mediaType: "audio/webm" });
  assert.equal(yes.decision, "allow");
  assert.deepEqual(approved, [[session, "allow", "fp-a"]]);
  await assert.rejects(voice.answer({ id: offer.id, transcript: "yes" }), /run out|already used/);
  const late = voice.offer({ sessionId: session, fingerprint: "fp-a" });
  now += offerLifetimeMs + 1;
  await assert.rejects(voice.answer({ id: late.id, transcript: "yes" }), /run out/);
  assert.equal(approved.length, 1);
  await assert.rejects(voice.answer({ id: late.id }), /either the words or a recording/);
  store.save("settings", "local", "personal-voice-approvals", { mode: "off" });
  assert.throws(() => voice.offer({ sessionId: session, fingerprint: "fp-a" }), /switched off/);
});

/* ---------- R17-025: the spoken briefing ---------- */
test("R17-025: the briefing reads connected calendars and mail, carries on past a failure, and is sent only after the checks", async () => {
  const store = fakeStore();
  on(store, "spoken-brief");
  on(store, "google");
  on(store, "microsoft");
  const spoken = [], sent = [];
  const brief = new SpokenBrief({ store, owner: "local",
    speak: async (text) => { spoken.push(text); return { bytes: new Uint8Array([9]), mediaType: "audio/mpeg" }; },
    sendVoice: async (...args) => { sent.push(args); },
    sources: { morningBrief: () => "## Good morning\n- **Water** the oak",
      googleEvents: async () => ({ events: [{ title: "Dentist", starts: "2026-09-17T09:30:00Z" }] }),
      googleMail: async () => ({ messages: [{ unread: true }, { unread: false }] }),
      outlookEvents: async () => { throw new Error("offline"); },
      outlookMail: async () => ({ messages: [] }) } });
  const result = await brief.run({ channel: "tg", chatId: "42" });
  assert.equal(result.text, "1 event on your Google calendar: 09:30 Dentist.\nOutlook could not be reached just now.\n1 unread message in Gmail.\nNo unread mail in Outlook.\nGood morning\nWater the oak");
  assert.deepEqual(spoken, [result.text]);
  assert.equal(sent[0][0], "tg");
  assert.equal(sent[0][3], result.text);
  await assert.rejects(brief.run({ channel: "tg" }), /both the chat app and the chat/);
  store.save("settings", "local", "personal-google", { mode: "off" });
  store.save("settings", "local", "personal-microsoft", { mode: "off" });
  assert.equal(await brief.script(), "Good morning\nWater the oak");
  assert.equal(eventLine("Google", []), "Nothing is on your Google calendar for the next day.");
  assert.equal(mailLine("Gmail", Array.from({ length: 10 }, () => ({ unread: true }))), "10 or more unread messages in Gmail.");
  assert.equal(speakable("```js\nx\n```\n# Title"), "Title");
  store.save("settings", "local", "personal-spoken-brief", { mode: "off" });
  await assert.rejects(brief.run({}), /switched off/);
});

/* ---------- R17-032: the webhook-only tunnel ---------- */
test("R17-032: only webhook addresses pass the door, and each program is started with a plain argument list", () => {
  for (const [method, path] of [["POST", "/webhooks/chat/telegram/0123456789abcdef0123456789abcdef"], ["POST", "/webhooks/whatsapp/main"],
    ["GET", "/webhooks/whatsapp/main"], ["POST", "/hooks/abc-123"], ["POST", "/api/triggers/11111111-1111-4111-8111-111111111111/fire"]])
    assert.equal(webhookOnly(method, path), true, path);
  for (const [method, path] of [["GET", "/"], ["POST", "/api/run"], ["GET", "/api/triggers/11111111-1111-4111-8111-111111111111/fire"],
    ["POST", "/webhooks/chat/../../api/run"], ["GET", "/app.js"], ["POST", "/webhooks//chat/x"], ["POST", "/api/personal/tunnel"], ["GET", "/mcp"]])
    assert.equal(webhookOnly(method, path), false, path);
  assert.deepEqual(tunnelCommand("cloudflared", 4000).args, ["tunnel", "--no-autoupdate", "--url", "http://127.0.0.1:4000"]);
  assert.deepEqual(tunnelCommand("tailscale", 4000).args, ["funnel", "http://127.0.0.1:4000"]);
  assert.equal(tunnelCommand("tailscale", 1).args.includes("--bg"), false, "nothing is left configured after it stops");
  assert.deepEqual(tunnelCommand("ngrok", 4000).args.slice(0, 2), ["http", "http://127.0.0.1:4000"]);
});

function fakeProgram(printed) {
  const calls = [];
  const spawn = (file, args) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = (signal) => { calls.push(["kill", signal]); setImmediate(() => child.emit("exit")); return true; };
    calls.push([file, args]);
    if (printed) setImmediate(() => child.stderr.write(printed));
    return child;
  };
  return { spawn, calls };
}
function post(url, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(new URL(path, url), { method: "POST", headers }, (response) => {
      let body = "";
      response.on("data", (c) => { body += c; });
      response.on("end", () => resolve({ status: response.statusCode, body }));
    });
    request.on("error", reject);
    request.end("{\"hello\":1}");
  });
}

test("R17-032: the tunnel starts the owner's program, passes webhooks on without keys, and stops cleanly", async (t) => {
  const reached = [];
  const branch = createHttpServer((request, response) => {
    let body = "";
    request.on("data", (c) => { body += c; });
    request.on("end", () => { reached.push({ path: request.url, headers: request.headers, body }); response.end("{\"ok\":true}"); });
  });
  await new Promise((resolve) => branch.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => branch.close(resolve)));
  const store = fakeStore();
  on(store, "tunnel");
  const program = fakeProgram("INF |  https://oak-leaf-42.trycloudflare.com  |\n");
  const tunnel = new WebhookTunnel({ store, owner: "local", refusal: () => null, spawn: program.spawn, waitMs: 2000 });
  await assert.rejects(tunnel.start(), /not listening yet/);
  tunnel.localAddress = `http://127.0.0.1:${branch.address().port}`;
  tunnel.save({ program: "cloudflared", executable: "/opt/homebrew/bin/cloudflared" });
  const started = await tunnel.start();
  assert.deepEqual(started, { running: true, address: "https://oak-leaf-42.trycloudflare.com" });
  const [file, args] = program.calls[0];
  assert.equal(file, "/opt/homebrew/bin/cloudflared");
  const door = args.at(-1);
  const passed = await post(door, "/webhooks/chat/telegram/0123456789abcdef0123456789abcdef", { authorization: "Bearer stolen", cookie: "s=1", "x-telegram-bot-api-secret-token": "sig" });
  assert.equal(passed.status, 200);
  assert.equal(reached[0].body, "{\"hello\":1}");
  assert.equal(reached[0].headers.authorization, undefined);
  assert.equal(reached[0].headers.cookie, undefined);
  assert.equal(reached[0].headers["x-telegram-bot-api-secret-token"], "sig");
  assert.equal(reached[0].headers.host, `127.0.0.1:${branch.address().port}`);
  const blocked = await post(door, "/api/run", { authorization: "Bearer guess" });
  assert.equal(blocked.status, 404);
  assert.equal(reached.length, 1, "the window's own routes never see the request");
  assert.deepEqual(await tunnel.stop(), { running: false, address: null });
  assert.deepEqual(program.calls.at(-1), ["kill", "SIGTERM"]);
  await assert.rejects(post(door, "/hooks/abc"));
});

test("R17-032: a program that prints no address is stopped, and Lockdown or the switch refuse before anything starts", async () => {
  const store = fakeStore();
  on(store, "tunnel");
  const silent = fakeProgram("");
  const tunnel = new WebhookTunnel({ store, owner: "local", refusal: () => null, spawn: silent.spawn, waitMs: 50 });
  tunnel.localAddress = "http://127.0.0.1:9";
  await assert.rejects(tunnel.start(), /did not give a public address/);
  assert.deepEqual(silent.calls.at(-1), ["kill", "SIGTERM"]);
  assert.equal(tunnel.status().running, false);
  const refusing = fakeProgram("https://x.trycloudflare.com");
  const locked = new WebhookTunnel({ store, owner: "local", refusal: () => "Lockdown is on.", spawn: refusing.spawn });
  locked.localAddress = "http://127.0.0.1:9";
  await assert.rejects(locked.start(), /Lockdown is on/);
  store.save("settings", "local", "personal-tunnel", { mode: "off" });
  await assert.rejects(locked.start(), /switched off/);
  assert.equal(refusing.calls.length, 0);
  assert.throws(() => tunnel.save({ executable: "cloudflared; rm -rf /" }), /full path/);
});
