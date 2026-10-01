/**
 * The From: line of a mail is written by whoever sent it, so a mail is taken as coming from its From: address only
 * when the receiving server's first Authentication-Results header vouches for that domain (src/channels/mail-auth.ts).
 * Everything else is set aside before pairing, approvals or a task. #918's cases, run against the check base landed (#979).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { authenticatedSender } from "../dist/channels/mail-auth.js";
import { parseFetched } from "../dist/channels/mail-client.js";
import { EmailAdapter } from "../dist/channels/email.js";

const from = "alice@example.com";
const ok = (result, pins) => authenticatedSender(from, result, pins);
const fetched = (headers) => `* 1 FETCH (BODY[HEADER] {${Buffer.byteLength(headers)}}\r\n${headers} BODY[TEXT] {2}\r\nhi)\r\nb1 OK\r\n`;

test("a forged From with no passing verdict is not authenticated", () => {
  assert.equal(ok(undefined), false, "no Authentication-Results at all");
  assert.equal(ok("mx.example.net; dmarc=fail header.from=example.com; spf=fail smtp.mailfrom=example.com; dkim=none"), false);
  assert.equal(ok("mx.example.net; dmarc=pass header.from=evil.test"), false, "a pass for another domain");
  assert.equal(ok("mx.example.net; dkim=pass header.d=evil.test"), false, "a signature from another domain");
  assert.equal(ok("mx.example.net; spf=pass smtp.mailfrom=bounce@evil.test"), false, "an envelope from another domain");
  assert.equal(ok("mx.example.net; spf=pass smtp.mailfrom=a@example.com; spf=fail smtp.mailfrom=a@example.com"), false, "two SPF verdicts");
  assert.equal(ok("mx.example.net; dmarc=pass header.from=example.com; dmarc=fail header.from=example.com"), false, "two DMARC verdicts");
  assert.equal(authenticatedSender("", "mx.example.net; dmarc=pass"), false, "no sender address");
});

test("an aligned pass from the receiving server is accepted", () => {
  assert.equal(ok("mx.example.net; dmarc=pass (p=REJECT) header.from=example.com"), true);
  assert.equal(ok("mx.example.net; dkim=pass header.d=example.com header.s=s1; dkim=fail header.d=evil.test"), true);
  assert.equal(ok("mx.google.com; dmarc=pass header.from=example.com", ["mx.google.com"]), true, "pinned to the owner's server");
});

test("an untrusted server, and words inside quotes or comments, are not verdicts", () => {
  assert.equal(ok("attacker.test; dmarc=pass header.from=example.com", ["mx.google.com"]), false, "a server that is not the owner's");
  assert.equal(ok('mx.example.net; dmarc=fail header.from="x; dmarc=pass header.from=example.com"'), false);
  assert.equal(ok("mx.example.net; dmarc=fail (dmarc=pass header.from=example.com) header.from=example.com"), false);
  assert.equal(ok('mx.example.net; dmarc=fail header.from="example.com'), false, "an open quote");
  // Only the top header counts: the receiving server writes above what the sender wrote.
  const mail = parseFetched(1, fetched("Authentication-Results: mx.example.net;\r\n dmarc=fail header.from=example.com\r\n"
    + "From: Alice <alice@example.com>\r\nAuthentication-Results: attacker.test; dmarc=pass header.from=example.com\r\n\r\n"));
  assert.equal(mail.authenticationResults, "mx.example.net; dmarc=fail header.from=example.com", "folded lines are joined, the first is kept");
  assert.equal(authenticatedSender(mail.from, mail.authenticationResults), false);
});

test("the sender is the one address From: names; an ambiguous From names nobody", () => {
  const sender = (value) => parseFetched(1, fetched(`From: ${value}\r\n\r\n`)).from;
  assert.equal(sender("Alice <Alice@Example.com>"), "alice@example.com");
  assert.equal(sender("alice@example.com"), "alice@example.com");
  assert.equal(sender("Doe, John <j@example.com>"), "j@example.com");
  for (const bad of ["boss@example.com <mallory@evil.test>", "<a@example.com>, <b@example.com>", "a@example.com, b@example.com",
    "Friends: <a@example.com>;", "John", "x".repeat(3000) + " <a@example.com>"])
    assert.equal(sender(bad), "", bad);
});

test("the email adapter sets aside a mail whose sender is not authenticated", () => {
  const adapter = new EmailAdapter({ id: "email", address: "me@example.com", imap: { host: "x", port: 1, user: "u", password: "p" },
    smtp: { host: "x", port: 1, user: "u", password: "p" } });
  const mail = { seq: 1, from, fromName: "Alice", subject: "Hi", messageId: "<m1@x>", references: "", text: "/platform pause" };
  assert.equal(adapter["inbound"](mail), null);
  const signed = adapter["inbound"]({ ...mail, messageId: "<m2@x>", authenticationResults: "mx.example.net; dmarc=pass header.from=example.com" });
  assert.equal(signed.senderId, from);
});
