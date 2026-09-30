/**
 * The mailbox password never goes over a plain connection to another computer (UP-RESEARCH-059). A server reached
 * without TLS must switch with STARTTLS first, for reading mail (IMAP) and for sending it (SMTP); one that does not
 * offer it is refused with words the owner can act on. Only a mail server on this computer may be used in the clear.
 *
 * "::ffff:127.0.0.1" reaches the stand-in server on this computer but is not one of the names Branch exempts
 * (localhost, 127.x.x.x, ::1), so it stands in for a mail server somewhere else.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { ImapClient, implicitTls, sendMail, tlsServerName } from "../dist/channels/mail-client.js";

const remote = "::ffff:127.0.0.1";
const password = "mailbox-password";
const b64 = (text) => Buffer.from(text).toString("base64");

/** A server speaking one protocol by hand; `answer` gets each line and says what to write back. */
async function standIn(t, greeting, answer) {
  const seen = { text: "", afterStarttls: [] };
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    let started = false, buffer = "";
    socket.on("error", () => undefined);
    socket.on("data", (chunk) => {
      if (started) { seen.afterStarttls.push(chunk[0]); socket.destroy(); return; }
      seen.text += chunk.toString("latin1");
      buffer += chunk.toString("latin1");
      for (let eol = buffer.indexOf("\r\n"); eol !== -1; eol = buffer.indexOf("\r\n")) {
        const line = buffer.slice(0, eol); buffer = buffer.slice(eol + 2);
        const reply = answer(line);
        if (reply.starttls) started = true;
        socket.write(reply.text);
      }
    });
    socket.write(greeting);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  // Open connections are cut, so a client that never hangs up cannot hold the test open.
  t.after(() => new Promise((resolve) => { for (const socket of sockets) socket.destroy(); server.close(resolve); }));
  return { port: server.address().port, seen };
}
function imapServer(t, { starttls, inject = "" }) {
  return standIn(t, "* OK ready\r\n", (line) => {
    const [tag, command] = line.split(" ");
    if (command === "CAPABILITY") return { text: `* CAPABILITY IMAP4rev1${starttls ? " STARTTLS" : ""}\r\n${tag} OK done\r\n` };
    if (command === "STARTTLS") return { text: `${tag} OK begin TLS\r\n${inject}`, starttls: true };
    return { text: `${tag} OK done\r\n` };
  });
}
function smtpServer(t, { starttls }) {
  return standIn(t, "220 ready\r\n", (line) => {
    if (/^EHLO/i.test(line)) return { text: `250-mail.example.net\r\n${starttls ? "250-STARTTLS\r\n" : ""}250 AUTH PLAIN LOGIN\r\n` };
    if (/^STARTTLS/i.test(line)) return { text: "220 go ahead\r\n", starttls: true };
    if (/^AUTH/i.test(line)) return { text: "235 welcome\r\n" };
    return { text: "250 ok\r\n" };
  });
}
const noSecret = (seen) => !seen.text.includes(password) && !seen.text.includes(b64(password)) && !seen.text.includes(b64(`\0u\0${password}`));
const mail = { from: "u@example.com", to: "b@example.com", subject: "s", text: "t", messageId: "<1@b>" };

test("IMAP: a server that offers no STARTTLS is refused before the password is sent", async (t) => {
  const { port, seen } = await imapServer(t, { starttls: false });
  const client = new ImapClient({ host: remote, port, user: "u", password, tls: false, timeoutMs: 3000 });
  await assert.rejects(client.connect(), (error) => {
    assert.match(error.message, /did not offer to encrypt the connection \(STARTTLS\) for reading mail, so Branch did not send your password/);
    assert.match(error.message, /993/, "the owner is told what to use instead");
    return true;
  });
  await client.close();
  assert.equal(/LOGIN/.test(seen.text), false, "no LOGIN went out");
  assert.ok(noSecret(seen));
});

test("IMAP: STARTTLS is sent and TLS begins before LOGIN, and bytes slipped in after the OK are refused", async (t) => {
  const { port, seen } = await imapServer(t, { starttls: true });
  const client = new ImapClient({ host: remote, port, user: "u", password, tls: false, timeoutMs: 3000 });
  await assert.rejects(client.connect()); // the stand-in cannot finish a TLS handshake
  await client.close();
  assert.match(seen.text, /STARTTLS/);
  assert.equal(seen.afterStarttls[0], 0x16, "the next bytes were a TLS handshake");
  assert.equal(/LOGIN/.test(seen.text), false);
  assert.ok(noSecret(seen));

  const injected = await imapServer(t, { starttls: true, inject: "* OK injected before encryption\r\n" });
  const second = new ImapClient({ host: remote, port: injected.port, user: "u", password, tls: false, timeoutMs: 3000 });
  await assert.rejects(second.connect(), /sent more before encryption began/);
  await second.close();
  assert.equal(injected.seen.afterStarttls.length, 0, "no handshake is attempted over a stream someone wrote into");
  assert.ok(noSecret(injected.seen));
});

test("SMTP: a server that offers no STARTTLS is refused before the password is sent, and one that does is encrypted first", async (t) => {
  const plain = await smtpServer(t, { starttls: false });
  await assert.rejects(sendMail({ host: remote, port: plain.port, user: "u", password, tls: false, timeoutMs: 3000 }, mail),
    /did not offer to encrypt the connection \(STARTTLS\) for sending mail, so Branch did not send your password/);
  assert.equal(/AUTH/i.test(plain.seen.text), false, "no AUTH went out");
  assert.ok(noSecret(plain.seen));

  const offered = await smtpServer(t, { starttls: true });
  await assert.rejects(sendMail({ host: remote, port: offered.port, user: "u", password, tls: false, timeoutMs: 3000 }, mail));
  assert.match(offered.seen.text, /STARTTLS/);
  assert.equal(offered.seen.afterStarttls[0], 0x16, "the next bytes were a TLS handshake");
  assert.equal(/AUTH/i.test(offered.seen.text), false);
  assert.ok(noSecret(offered.seen));
});

test("a mail server on this computer may still be used in the clear", async (t) => {
  const { port, seen } = await imapServer(t, { starttls: false });
  const client = new ImapClient({ host: "127.0.0.1", port, user: "u", password, tls: false, timeoutMs: 3000 });
  await client.connect();
  await client.close();
  assert.match(seen.text, /LOGIN/);
});

test("left unset, the standard STARTTLS ports use STARTTLS and every other port TLS from the start", () => {
  assert.equal(implicitTls({ port: 993 }), true);
  assert.equal(implicitTls({ port: 465 }), true);
  assert.equal(implicitTls({ port: 143 }), false);
  assert.equal(implicitTls({ port: 587 }), false);
  assert.equal(implicitTls({ port: 25 }), false);
  assert.equal(implicitTls({ port: 587, tls: true }), true, "the owner's choice wins");
  assert.equal(implicitTls({ port: 993, tls: false }), false);
});

test("a server reached by its IP address is greeted over TLS without a name, which may only be a host name", () => {
  assert.equal(tlsServerName("mail.example.net"), "mail.example.net");
  assert.equal(tlsServerName("192.0.2.7"), undefined);
  assert.equal(tlsServerName("::ffff:127.0.0.1"), undefined);
  assert.equal(tlsServerName("[2001:db8::1]"), undefined);
});
