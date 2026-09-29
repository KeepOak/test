import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { fixture, until, delay, setSwitch, assertNoSecret, pairingWalk, refusalWalk } from "./channels-parity-kit.mjs";
import { IMessageChannel, databaseReader, textFromAttributedBody, sendScript } from "../dist/channels/imessage.js";
import { buildParityChannel } from "../dist/channels/parity-config.js";

/**
 * iMessage is tested against a Messages-shaped database in a temporary folder and a fake
 * `osascript`. The real Messages app and the real osascript are never touched.
 */
function messagesDatabase(path) {
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
    CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, guid TEXT, style INTEGER, display_name TEXT);
    CREATE TABLE message (ROWID INTEGER PRIMARY KEY, handle_id INTEGER, text TEXT, attributedBody BLOB, is_from_me INTEGER,
      cache_has_attachments INTEGER DEFAULT 0, is_audio_message INTEGER DEFAULT 0);
    CREATE TABLE attachment (ROWID INTEGER PRIMARY KEY, filename TEXT, mime_type TEXT, transfer_name TEXT, total_bytes INTEGER);
    CREATE TABLE message_attachment_join (message_id INTEGER, attachment_id INTEGER);
    CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
    INSERT INTO handle VALUES (1, '+15550001111'), (2, 'friend@example.com');
    INSERT INTO chat VALUES (1, 'iMessage;-;+15550001111', 45, NULL), (2, 'iMessage;+;chat987654321', 43, 'Family');
    INSERT INTO message (ROWID, handle_id, text, attributedBody, is_from_me) VALUES (1, 1, 'an old message from before Branch started', NULL, 0);
    INSERT INTO chat_message_join VALUES (1, 1);`);
  let next = 2;
  return {
    say(handleId, text, { chat = 1, body = null, fromMe = 0, files = [], audio = 0 } = {}) {
      const id = next++;
      db.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?, ?, ?)").run(id, handleId, text, body, fromMe, files.length ? 1 : 0, audio);
      db.prepare("INSERT INTO chat_message_join VALUES (?, ?)").run(chat, id);
      for (const file of files) {
        const row = db.prepare("INSERT INTO attachment (filename, mime_type, transfer_name, total_bytes) VALUES (?, ?, ?, ?)").run(file.path, file.type, file.name ?? null, file.size ?? null);
        db.prepare("INSERT INTO message_attachment_join VALUES (?, ?)").run(id, Number(row.lastInsertRowid));
      }
    },
    close: () => db.close(),
  };
}

/**
 * Windows will not delete an open database, and the kit's own hook deletes the folder. This hook is
 * registered first, so it runs first: the channel stops and the database closes before the folder goes.
 */
async function closingFixture(t) {
  const closers = [];
  t.after(async () => { for (const close of closers.reverse()) await close(); });
  const context = await fixture(t);
  return { ...context, closeFirst: (close) => closers.push(close) };
}

function fakeOsascript() {
  const runs = [];
  const runner = async (file, args) => { runs.push({ file, args }); return { stdout: "", stderr: "" }; };
  /** What was sent, read back out of the arguments after the fixed script. */
  const sent = () => runs.map(({ args }) => args.slice(sendScript.length * 2));
  return { runs, runner, sent };
}

test("the typed-stream body newer Macs store is read back into words", () => {
  const short = Buffer.concat([Buffer.from([0x04, 0x0b, 0x73, 0x74, 0x72, 0x01, 0x2b, 5]), Buffer.from("hello"), Buffer.from([0x86])]);
  assert.equal(textFromAttributedBody(short), "hello");
  const words = "x".repeat(300);
  const long = Buffer.concat([Buffer.from([0x01, 0x2b, 0x81, 0x2c, 0x01]), Buffer.from(words)]);
  assert.equal(textFromAttributedBody(long), words);
  assert.equal(textFromAttributedBody(Buffer.from([0x01, 0x2b, 0x81, 0xff, 0xff])), "", "a length past the end is ignored");
  assert.equal(textFromAttributedBody(null), "");
});

test("iMessage: history is left alone, a stranger pairs, an approved person is answered through osascript arguments", async (t) => {
  const context = await closingFixture(t);
  const database = join(context.root, "chat.db");
  const messages = messagesDatabase(database);
  context.closeFirst(() => messages.close());
  const osascript = fakeOsascript();
  const channel = new IMessageChannel({ id: "imessage", reader: databaseReader(database), runner: osascript.runner, pollMs: 20, account: "owner@example.com" });
  await context.app.channels.attach(channel, { activation: "mention", pairing: true, allowlist: [] });
  context.closeFirst(() => channel.stop());
  await until(() => channel.health().state === "connected", "read the database");
  await delay(80);
  assert.equal(osascript.runs.length, 0, "the message from before Branch started is not answered");

  const texts = () => osascript.sent().map(([, text]) => text);
  await pairingWalk(context, { label: "iMessage", say: async (text) => messages.say(1, text), sent: texts });
  const [target, , group] = osascript.sent().at(-1);
  assert.equal(target, "+15550001111");
  assert.equal(group, "no");
  const run = osascript.runs.at(-1);
  assert.equal(run.file, "/usr/bin/osascript");
  assert.deepEqual(run.args.slice(0, sendScript.length * 2), sendScript.flatMap((line) => ["-e", line]),
    "the script is fixed text; the words travel as arguments");

  // A message the owner sent from this Mac is never answered.
  const asked = context.provider.requests.length;
  messages.say(1, "a note I sent myself", { fromMe: 1 });
  await delay(120);
  assert.equal(context.provider.requests.length, asked);
});

test("iMessage: a group is answered in the group only when named, and a script-looking message stays words", async (t) => {
  const context = await closingFixture(t);
  const database = join(context.root, "chat.db");
  const messages = messagesDatabase(database);
  context.closeFirst(() => messages.close());
  const osascript = fakeOsascript();
  const channel = new IMessageChannel({ id: "imessage", reader: databaseReader(database), runner: osascript.runner, pollMs: 20, account: "owner@example.com" });
  await context.app.channels.attach(channel, { activation: "mention", pairing: false, allowlist: ["friend@example.com"] });
  context.closeFirst(() => channel.stop());
  await until(() => channel.health().state === "connected", "read the database");
  messages.say(2, "dinner at eight?", { chat: 2 });
  await delay(150);
  assert.equal(context.provider.requests.length, 0, "an unaddressed group message is left alone");
  const sneaky = '" & do shell script "id" & " owner, help';
  messages.say(2, sneaky, { chat: 2 });
  await until(() => osascript.sent().length > 0, "answered in the group");
  const [target, text, group] = osascript.sent()[0];
  assert.equal(target, "iMessage;+;chat987654321");
  assert.equal(group, "yes");
  assert.ok(text.includes('do shell script "id"'), "the quote marks arrive as words, in an argument of their own");
  await assert.rejects(() => channel.send("-e", "x"), /not an address/);
});

test("iMessage: a stranger is refused when pairing is off, and a missing permission is said plainly", async (t) => {
  const context = await closingFixture(t);
  const database = join(context.root, "chat.db");
  const messages = messagesDatabase(database);
  context.closeFirst(() => messages.close());
  const osascript = fakeOsascript();
  const channel = new IMessageChannel({ id: "imessage", reader: databaseReader(database), runner: osascript.runner, pollMs: 20 });
  await context.app.channels.attach(channel, { activation: "mention", pairing: false, allowlist: [] });
  context.closeFirst(() => channel.stop());
  await until(() => channel.health().state === "connected", "read the database");
  await refusalWalk(context, { label: "iMessage", say: async (text) => messages.say(1, text), sent: () => osascript.sent().map(([, text]) => text) });

  const locked = new IMessageChannel({ id: "locked", pollMs: 20, runner: osascript.runner,
    reader: databaseReader(join(context.root, "no-such-folder", "chat.db")) });
  await locked.start(async () => undefined);
  context.closeFirst(() => locked.stop());
  await until(() => /Full Disk Access/.test(locked.health().reason ?? ""), "the permission is named");

  const refusing = new IMessageChannel({ id: "refusing", pollMs: 20, reader: async () => [],
    runner: async () => { throw new Error("Not authorized to send Apple events to Messages"); } });
  await assert.rejects(() => refusing.send("+15550001111", "hi"), /Allow Branch to control Messages/);
  await assertNoSecret(context, []);
});

test("iMessage is offered only on a Mac, and ships switched off", async (t) => {
  const context = await fixture(t);
  const config = { type: "imessage", id: "imessage", activation: "mention", pairing: true, allowlist: [] };
  await assert.rejects(() => buildParityChannel(config, { credential: async () => "", platform: "linux" }), /only be reached from a Mac/);
  await assert.rejects(() => buildParityChannel(config, { credential: async () => "", platform: "win32" }), /only be reached from a Mac/);
  const built = await buildParityChannel({ ...config, database: join(context.root, "missing.db") },
    { credential: async () => "", platform: "darwin", store: context.app.store, owner: context.app.runtime.owner });
  await built.start(async () => undefined);
  assert.equal(built.health().state, "needs attention", "off until the owner turns it on");
  await assert.rejects(() => built.send("+15550001111", "hi"), /switched off/, "nothing is sent, so osascript never runs");
  await built.stop();
  setSwitch(context.app, "imessage", "when-needed");
  assert.match(built.health().reason, /when there is something to send/);
});
