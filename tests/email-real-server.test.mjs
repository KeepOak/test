/**
 * Email files against a real mail server (GreenMail), not a fake: a multipart message with two files goes in over SMTP,
 * Branch reads it over IMAP and hands both files and the words to the task, and the reply and a file go back in the same
 * thread. Opt-in, so it stays out of the default CI share: start GreenMail, then point the test at it.
 *
 *   docker run -d --rm --name branch-greenmail -p 3825:3025 -p 3943:3143 \
 *     -e GREENMAIL_OPTS="-Dgreenmail.setup.test.all -Dgreenmail.hostname=0.0.0.0 -Dgreenmail.users=bot:secret@example.com,ann:secret@example.com" \
 *     greenmail/standalone:2.1.3
 *   BRANCH_TEST_GREENMAIL=127.0.0.1:3825:3943 node --test tests/email-real-server.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { connect } from "node:net";
import { fixture, until } from "./channels-parity-kit.mjs";
import { EmailAdapter } from "../dist/channels/email.js";
import { ImapClient } from "../dist/channels/mail-client.js";

const target = process.env.BRANCH_TEST_GREENMAIL ?? "";
const [host, smtpPort, imapPort] = target.split(":");
const skip = target ? false : "set BRANCH_TEST_GREENMAIL=host:smtpPort:imapPort to a running GreenMail (see the top of this file)";
const server = (user, port) => ({ host, port: Number(port), user, password: "secret", tls: false, timeoutMs: 10000 });

/** Speaks SMTP by hand, the way another mail program would, so the message in is not built by Branch's own code. */
async function smtpSend(raw) {
  const socket = connect({ host, port: Number(smtpPort) });
  socket.setEncoding("utf8");
  let buffer = "";
  socket.on("data", (chunk) => { buffer += chunk; });
  const expect = async (code) => {
    await until(() => new RegExp(`^${code} `, "m").test(buffer), `SMTP ${code}`);
    buffer = "";
  };
  await expect(220);
  for (const [line, code] of [["EHLO test", 250], ["MAIL FROM:<ann@example.com>", 250], ["RCPT TO:<bot@example.com>", 250], ["DATA", 354]]) {
    socket.write(`${line}\r\n`);
    await expect(code);
  }
  socket.write(`${raw.replace(/\r?\n/g, "\r\n")}\r\n.\r\n`);
  await expect(250);
  socket.end("QUIT\r\n");
}

test("email through a real mail server: two files and the words in, the reply and a file out in the same thread", { skip }, async (t) => {
  const { app, provider } = await fixture(t);
  // GreenMail checks no senders, so the message carries the verdict a receiving server would stamp, and the adapter is
  // told to trust that server's name (src/channels/mail-auth.ts).
  const adapter = new EmailAdapter({ id: "email-real", address: "bot@example.com", imap: server("bot", imapPort), smtp: server("bot", smtpPort), pollMs: 300,
    trustedAuthservIds: ["greenmail.test"] });
  await app.channels.attach(adapter, { activation: "always", pairing: false, allowlist: ["ann@example.com"] });
  t.after(() => adapter.stop());

  const messageId = `<real-${Date.now()}@example.com>`;
  await smtpSend([
    "Authentication-Results: greenmail.test; dmarc=pass header.from=example.com",
    "From: Ann <ann@example.com>", "To: bot@example.com", "Subject: Two files", `Message-ID: ${messageId}`, "MIME-Version: 1.0",
    "Content-Type: multipart/mixed; boundary=\"outer\"", "",
    "--outer", "Content-Type: text/plain; charset=utf-8", "Content-Transfer-Encoding: quoted-printable", "",
    "Please compare these two caf=C3=A9 notes.", "",
    "--outer", "Content-Type: text/plain; name=\"first.txt\"", "Content-Disposition: attachment; filename=\"first.txt\"", "Content-Transfer-Encoding: base64", "",
    Buffer.from("first file body").toString("base64"),
    "--outer", "Content-Type: application/pdf", "Content-Disposition: attachment; filename=\"second.pdf\"", "Content-Transfer-Encoding: base64", "",
    Buffer.from("%PDF-1.4 second").toString("base64"),
    "--outer--", "",
  ].join("\n"));

  const request = await until(() => provider.requests[0], "the task started from the mail", 1500);
  const said = JSON.stringify(request);
  assert.ok(said.includes("Please compare these two café notes."), "the words, decoded");
  assert.match(said, /\[attached file: first\.txt: [^\]]+\]/, "the first file");
  assert.match(said, /\[attached file: second\.pdf: [^\]]+\]/, "the second file");

  // The answer goes back to Ann in the same thread; then a file, as chat.send_file would send it.
  const inbox = async () => {
    const client = new ImapClient(server("ann", imapPort));
    await client.connect();
    try { return await client.unread(10); } finally { await client.close(); }
  };
  const replies = [];
  await until(async () => { replies.push(...await inbox()); return replies.length >= 1; }, "the reply arrived", 1500);
  const reply = replies[0];
  assert.equal(reply.subject, "Re: Two files");
  assert.ok(reply.text.includes("Echo:"), "the task's answer");

  const chatId = "ann@example.com";
  await adapter.sendFile(chatId, { name: "answer.csv", mediaType: "text/csv", bytes: new TextEncoder().encode("a,b\n1,2\n"), caption: "The comparison" });
  await until(async () => { replies.push(...await inbox()); return replies.length >= 2; }, "the file arrived", 1500);
  const withFile = replies[1];
  assert.equal(withFile.subject, "Re: Two files");
  assert.equal(withFile.text, "The comparison");
  assert.equal(withFile.attachments?.length, 1);
  assert.equal(withFile.attachments[0].name, "answer.csv");
  assert.equal(Buffer.from(withFile.attachments[0].bytes).toString(), "a,b\n1,2\n");

  // Both are threaded onto Ann's message.
  const client = new ImapClient(server("ann", imapPort));
  await client.connect();
  t.after(() => client.close());
  const uids = await client.searchUids("ALL", 10);
  const headers = await Promise.all(uids.map(async (uid) => (await client.whole(uid, 1 << 20)).split(/\r?\n\r?\n/)[0]));
  assert.equal(headers.length, 2);
  for (const head of headers) assert.match(head, new RegExp(`^In-Reply-To: ${messageId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "mi"));
});
