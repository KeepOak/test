/**
 * Files on Signal, email and iMessage: files and voice notes in (fetched or read only once answered), files and spoken
 * replies out. signal-cli is a fake process on two streams, mail is parsed and built without a server, and iMessage is
 * a Messages-shaped database with a fake osascript. No real Signal account, mail server or Mac is used, so nothing
 * here proves delivery through the real apps.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { DatabaseSync } from "node:sqlite";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixture, until } from "./channels-parity-kit.mjs";
import { SignalAdapter } from "../dist/channels/signal-cli.js";
import { EmailAdapter } from "../dist/channels/email.js";
import { parseFetched, messageBody } from "../dist/channels/mail-client.js";
import { mimeParts, textOf } from "../dist/personal/mime.js";
import { IMessageChannel, databaseReader, readAttachment, sendFileScript } from "../dist/channels/imessage.js";

/** A signal-cli stand-in: what Branch writes is collected; `say` writes a line on its output. */
function fakeSignal(id = "signal") {
  const written = [];
  const stdout = new PassThrough();
  const child = { stdout, stdin: { writable: true, write: (line) => written.push(JSON.parse(line)) }, on: () => undefined, kill: () => undefined };
  const adapter = new SignalAdapter({ id, path: "anything", account: "+15550000000", exists: async () => true, spawnProcess: () => child });
  return { adapter, written, say: (value) => stdout.write(JSON.stringify(value) + "\n") };
}
const envelope = (dataMessage, source = "+15551111111") => ({ method: "receive", params: { envelope: { source, sourceName: "Alice", timestamp: 42, dataMessage } } });

test("Signal: a file is fetched from signal-cli only when asked, and a voice note becomes a voice note", async (t) => {
  const signal = fakeSignal();
  const got = [];
  await signal.adapter.start(async (message) => { got.push(message); });
  t.after(() => signal.adapter.stop());
  signal.say(envelope({ attachments: [{ id: "att1.pdf", contentType: "application/pdf", filename: "report.pdf", size: 5 }] }));
  const message = await until(() => got[0], "a file-only message comes in");
  assert.equal(message.text, "", "a message that is only a file still counts");
  assert.equal(signal.written.length, 0, "nothing is fetched before the message is answered");
  const [file] = message.attachments;
  assert.deepEqual({ name: file.name, kind: file.kind, mediaType: file.mediaType, size: file.size }, { name: "report.pdf", kind: "document", mediaType: "application/pdf", size: 5 });
  const fetching = file.bytes();
  const call = await until(() => signal.written[0], "getAttachment asked");
  assert.equal(call.method, "getAttachment");
  assert.deepEqual(call.params, { id: "att1.pdf", recipient: "+15551111111" });
  signal.say({ jsonrpc: "2.0", result: { data: Buffer.from("%PDF!").toString("base64") }, id: call.id });
  assert.equal(Buffer.from(await fetching).toString(), "%PDF!");

  // A plain audio file (isVoiceNote false, as signal-cli always writes the flag) stays a file.
  signal.say(envelope({ attachments: [{ id: "song", contentType: "audio/mpeg", filename: "song.mp3", size: 3, isVoiceNote: false }] }));
  const song = await until(() => got[1], "an audio file comes in");
  assert.equal(song.voice, undefined);
  assert.equal(song.attachments[0].name, "song.mp3");
  got.splice(1, 1);
  signal.say(envelope({ attachments: [{ id: "v1", contentType: "audio/aac", size: 3, isVoiceNote: true }], groupInfo: { groupId: "G1" } }));
  const voice = await until(() => got[1], "a voice note comes in");
  assert.equal(voice.voice.mediaType, "audio/aac");
  assert.equal(voice.attachments, undefined);
  const heard = voice.voice.bytes();
  const ask = await until(() => signal.written[1], "the voice note asked for");
  assert.deepEqual(ask.params, { id: "v1", groupId: "G1" }, "a group's file is asked for by the group");
  signal.say({ jsonrpc: "2.0", error: { code: -1, message: "gone" }, id: ask.id });
  await assert.rejects(heard, /signal-cli: gone/);

  signal.say(envelope({ attachments: [{ id: "big", contentType: "video/mp4", size: 9 * 1024 * 1024 }] }));
  const big = await until(() => got[2], "a large file comes in");
  await assert.rejects(big.attachments[0].bytes(), (error) => error.constructor.name === "ArtifactTooLarge", "a file past the limit is not fetched");
  assert.equal(signal.written.length, 2);
});

test("Signal: files and spoken replies go out inline as data addresses, and a name cannot break out of one", async (t) => {
  const signal = fakeSignal();
  await signal.adapter.start(async () => undefined);
  t.after(() => signal.adapter.stop());
  await signal.adapter.sendFile("+15551111111", { name: "a;b,c\nd.pdf", mediaType: "application/pdf", bytes: new Uint8Array([1, 2, 3]), caption: "Here" });
  const [sent] = signal.written;
  assert.equal(sent.method, "send");
  assert.deepEqual(sent.params.recipient, ["+15551111111"]);
  assert.equal(sent.params.message, "Here");
  assert.equal(sent.params.attachments[0], `data:application/pdf;filename=a_b_c_d.pdf;base64,${Buffer.from([1, 2, 3]).toString("base64")}`);
  await signal.adapter.sendVoice("G1", new Uint8Array([9]), "audio/ogg");
  assert.equal(signal.written[1].params.groupId, "G1");
  assert.match(signal.written[1].params.attachments[0], /^data:audio\/ogg;filename=reply\.ogg;base64,/);
  assert.equal(signal.written[1].params.voiceNote, true, "a spoken reply is marked as a voice note");
  assert.equal(signal.written[0].params.voiceNote, undefined, "a file is not");
  await signal.adapter.sendFile("+1555", { name: "x", mediaType: "text/html\r\nX: y", bytes: new Uint8Array(1) });
  assert.match(signal.written[2].params.attachments[0], /^data:application\/octet-stream;/, "a strange type is sent as plain bytes");
  await assert.rejects(signal.adapter.sendFile("+1555", { name: "x", mediaType: "a/b", bytes: new Uint8Array(51 * 1024 * 1024) }), /50 MB/);
});

test("Signal: a file sent to Branch reaches the task, fetched through signal-cli and stored", async (t) => {
  const { app, provider } = await fixture(t);
  const signal = fakeSignal("signal-files");
  await app.channels.attach(signal.adapter, { activation: "always", pairing: false, allowlist: ["+15551111111"] });
  t.after(() => signal.adapter.stop());
  signal.say(envelope({ message: "summarise this", attachments: [{ id: "d1", contentType: "text/plain", filename: "notes.txt", size: 11 }] }));
  const call = await until(() => signal.written.find((line) => line.method === "getAttachment"), "the file asked for");
  signal.say({ jsonrpc: "2.0", result: { data: Buffer.from("hello notes").toString("base64") }, id: call.id });
  const request = await until(() => provider.requests[0], "the task started");
  const said = JSON.stringify(request);
  assert.ok(said.includes("summarise this"));
  assert.match(said, /\[attached file: notes\.txt: [^\]]+\]/, "the stored file is named to the task");
});

const fetched = (headers, body) => `* 1 FETCH (BODY[HEADER] {${Buffer.byteLength(headers)}}\r\n${headers} BODY[TEXT] {${body.length}}\r\n${body})\r\nb1 OK\r\n`;

test("email: a multipart message gives its words and its files, and a formatted one its words", () => {
  const boundary = "XYZ";
  const headers = `From: Ann <ann@example.com>\r\nSubject: Report\r\nMessage-ID: <m1@x>\r\nContent-Type: multipart/mixed; boundary="${boundary}"\r\n\r\n`;
  const body = [`--${boundary}`, "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: quoted-printable", "",
    "Please look at this caf=C3=A9 report.", `--${boundary}`, "Content-Type: application/pdf; name=\"q3.pdf\"",
    "Content-Disposition: attachment; filename=\"q3.pdf\"", "Content-Transfer-Encoding: base64", "", Buffer.from("%PDF-1.7").toString("base64"),
    `--${boundary}--`, ""].join("\r\n");
  const mail = parseFetched(1, fetched(headers, body));
  assert.equal(mail.text, "Please look at this café report.");
  assert.equal(mail.attachments.length, 1);
  assert.equal(mail.attachments[0].name, "q3.pdf");
  assert.equal(mail.attachments[0].mediaType, "application/pdf");
  assert.equal(Buffer.from(mail.attachments[0].bytes).toString(), "%PDF-1.7");

  const html = parseFetched(1, fetched("From: b@example.com\r\nContent-Type: text/html\r\n\r\n", "<p>Hello <b>there</b></p>"));
  assert.equal(html.text, "Hello there");
  assert.equal(html.attachments, undefined);
  const plain = parseFetched(1, fetched("From: c@example.com\r\n\r\n", "just words\r\n"));
  assert.equal(plain.text, "just words", "a plain message reads as before");
});

test("email: the adapter hands files to the task only when asked, and sends a file as an attachment in the thread", async () => {
  const adapter = new EmailAdapter({ id: "email", address: "me@example.com", imap: { host: "x", port: 1, user: "u", password: "p" }, smtp: { host: "x", port: 1, user: "u", password: "p" } });
  const mail = { seq: 1, from: "ann@example.com", fromName: "Ann", subject: "Pics", messageId: "<m2@x>", references: "", text: "",
    authenticationResults: "mx.example.com; dmarc=pass header.from=example.com",
    attachments: [{ name: "cat.jpg", mediaType: "image/jpeg", bytes: new Uint8Array([1, 2]) }, { name: "huge.bin", mediaType: "application/octet-stream", bytes: new Uint8Array(9 * 1024 * 1024) }] };
  const inbound = adapter["inbound"](mail);
  assert.equal(inbound.attachments.length, 2);
  assert.equal(inbound.attachments[0].kind, "picture");
  assert.deepEqual([...await inbound.attachments[0].bytes()], [1, 2]);
  await assert.rejects(inbound.attachments[1].bytes(), (error) => error.constructor.name === "ArtifactTooLarge");
  assert.equal(adapter.maxFileBytes, 18 * 1024 * 1024);
  await assert.rejects(adapter.sendFile(inbound.chatId, { name: "x", mediaType: "a/b", bytes: new Uint8Array(19 * 1024 * 1024) }), /18 MB/);

  const built = messageBody({ from: "me@example.com", to: "ann@example.com", subject: "Re: Pics", text: "Here it is\n.hidden line", messageId: "<r@x>",
    attachments: [{ name: "chart ü.png", mediaType: "image/png", bytes: new Uint8Array([7, 8, 9]) }, { name: "a\"b.txt", mediaType: "text/plain\r\nBcc: x@y", bytes: new Uint8Array([65]) }] });
  assert.ok(built.endsWith("\r\n.\r\n"));
  assert.ok(!/\r\nBcc:/i.test(built), "a strange type cannot add a header");
  assert.ok(built.includes("\r\n..hidden line"), "a line starting with a dot is protected");
  const parts = mimeParts(built.slice(0, -5).replace(/\r\n\.\./g, "\r\n."));
  assert.equal(textOf(parts).trim(), "Here it is\r\n.hidden line".replace(/\r\n/g, "\r\n"));
  assert.deepEqual(parts.slice(1).map((part) => [part.filename, part.contentType, [...part.body]]),
    [["chart ü.png", "image/png", [7, 8, 9]], ["a_b.txt", "application/octet-stream", [65]]]);
  const plain = messageBody({ from: "me@example.com", to: "a@b.c", subject: "s", text: "hi", messageId: "<p@x>" });
  assert.match(plain, /Content-Type: text\/plain; charset=utf-8/, "without files the message stays plain text");
});

function messagesDatabase(path) {
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
    CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, guid TEXT, style INTEGER, display_name TEXT);
    CREATE TABLE message (ROWID INTEGER PRIMARY KEY, handle_id INTEGER, text TEXT, attributedBody BLOB, is_from_me INTEGER, cache_has_attachments INTEGER, is_audio_message INTEGER);
    CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
    CREATE TABLE attachment (ROWID INTEGER PRIMARY KEY, filename TEXT, mime_type TEXT, transfer_name TEXT, total_bytes INTEGER);
    CREATE TABLE message_attachment_join (message_id INTEGER, attachment_id INTEGER);
    INSERT INTO handle VALUES (1, '+15550001111');
    INSERT INTO chat VALUES (1, 'iMessage;-;+15550001111', 45, NULL);
    INSERT INTO message VALUES (1, 1, 'old', NULL, 0, 0, 0);`);
  let next = 2;
  return {
    say(text, files = [], audio = 0) {
      const id = next++;
      db.prepare("INSERT INTO message VALUES (?, 1, ?, NULL, 0, ?, ?)").run(id, text, files.length ? 1 : 0, audio);
      db.prepare("INSERT INTO chat_message_join VALUES (1, ?)").run(id);
      for (const file of files) {
        const row = db.prepare("INSERT INTO attachment (filename, mime_type, transfer_name, total_bytes) VALUES (?, ?, ?, ?)").run(file.path, file.type, file.name ?? null, file.size ?? null);
        db.prepare("INSERT INTO message_attachment_join VALUES (?, ?)").run(id, Number(row.lastInsertRowid));
      }
    },
    close: () => db.close(),
  };
}

test("iMessage: files are read only from the attachments folder, an audio message is a voice note, and files go out by path", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-imessage-files-"));
  const folder = join(root, "Attachments");
  await mkdir(join(folder, "ab"), { recursive: true });
  await writeFile(join(folder, "ab", "IMG_1.heic"), "picture-bytes");
  await writeFile(join(root, "secret.txt"), "not for chats");
  const database = join(root, "chat.db");
  const messages = messagesDatabase(database);
  const runs = [];
  const channel = new IMessageChannel({ id: "imessage", reader: databaseReader(database), pollMs: 20, attachments: folder,
    runner: async (file, args) => { runs.push(args); return { stdout: "", stderr: "" }; } });
  const got = [];
  await channel.start(async (message) => { got.push(message); });
  t.after(async () => { await channel.stop(); messages.close(); await rm(root, { recursive: true, force: true }); });
  await until(() => channel.health().state === "connected", "read the database");

  messages.say("\uFFFC", [{ path: join(folder, "ab", "IMG_1.heic"), type: "image/heic", name: "IMG_1.heic", size: 13 }]);
  const picture = await until(() => got[0], "a picture-only message");
  assert.equal(picture.text, "", "the placeholder where the file sits is not words");
  assert.equal(picture.attachments[0].name, "IMG_1.heic");
  assert.equal(picture.attachments[0].kind, "picture");
  assert.equal(Buffer.from(await picture.attachments[0].bytes()).toString(), "picture-bytes");

  messages.say("look\uFFFC", [{ path: join(folder, "..", "secret.txt"), type: "text/plain", name: "secret.txt" }]);
  const outside = await until(() => got[1], "a file outside the folder");
  assert.equal(outside.text, "look");
  await assert.rejects(outside.attachments[0].bytes(), /not in the Messages attachments folder/);
  const linked = join(folder, "ab", "link.txt");
  const linkMade = await symlink(join(root, "secret.txt"), linked).then(() => true, () => false);
  if (linkMade) await assert.rejects(readAttachment(folder, linked), /not in the Messages attachments folder/, "a link out of the folder is not followed out");
  else t.diagnostic("skipped the link case: this computer does not let the test make a symbolic link");

  messages.say(null, [{ path: join(folder, "ab", "IMG_1.heic"), type: "audio/x-caf", name: "Audio Message.caf" }], 1);
  const voice = await until(() => got[2], "an audio message");
  assert.equal(voice.voice.mediaType, "audio/x-caf");

  await channel.sendFile(picture.chatId, { name: "../chart.png", mediaType: "image/png", bytes: new Uint8Array([1, 2, 3]), caption: "Your chart" });
  assert.equal(runs.length, 2, "the file, then its caption");
  assert.deepEqual(runs[0].slice(0, sendFileScript.length * 2), sendFileScript.flatMap((line) => ["-e", line]), "the script is fixed text");
  const [target, path, group] = runs[0].slice(sendFileScript.length * 2);
  assert.equal(target, "+15550001111");
  assert.equal(group, "no");
  assert.ok(path.startsWith(join(folder, "Branch").split("\\").join("/") + "/"), "written into Branch's own folder inside the attachments folder");
  assert.ok(path.endsWith("/_chart.png") || path.endsWith("/chart.png"), `the name cannot climb out of its folder (${path})`);
  assert.deepEqual([...await readFile(path)], [1, 2, 3]);
  assert.equal(runs[1].at(-2), "Your chart");
  const [outbox] = await readdir(join(folder, "Branch"));
  assert.ok(outbox, "one folder per file sent");
});
