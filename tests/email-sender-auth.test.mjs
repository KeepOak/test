/**
 * The From: line of a mail is written by whoever sent it, so a mail is taken as coming from its From: address only
 * when the receiving server's Authentication-Results header vouches for that domain (src/channels/mail-auth.ts,
 * ported from Hermes Agent). Everything else is a stranger's mail: never the owner, never paired, never allowlisted.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkSender, fromAddress } from "../dist/channels/mail-auth.js";
import { parseFetched } from "../dist/channels/mail-client.js";
import { EmailAdapter } from "../dist/channels/email.js";
import { platformGate, saveOwnerAccounts } from "../dist/reach/platform.js";
import { createBranch } from "../dist/index.js";
import { discardTemp } from "./temp-dir.mjs";

const from = "alice@example.com";
const ok = (results, pin) => checkSender(results, from, pin).authenticated;

test("a forged From with no passing verdict is not authenticated", () => {
  assert.equal(ok([]), false, "no Authentication-Results at all");
  assert.equal(ok(["mx.example.net; dmarc=fail header.from=example.com; spf=fail smtp.mailfrom=example.com; dkim=none"]), false);
  assert.equal(ok(["mx.example.net; dmarc=pass header.from=evil.test"]), false, "a pass for another domain");
  assert.equal(ok(["mx.example.net; dkim=pass header.d=evil.test"]), false, "a signature from another domain");
  assert.equal(ok(["mx.example.net; spf=pass smtp.mailfrom=bounce@evil.test"]), false, "an envelope from another domain");
  assert.equal(ok(["mx.example.net; spf=pass smtp.mailfrom=a@example.com; spf=fail smtp.mailfrom=a@example.com"]), false, "two SPF verdicts");
  assert.equal(ok(["mx.example.net; dmarc=pass header.from=example.com; dmarc=fail header.from=example.com"]), false, "two DMARC verdicts");
  assert.equal(checkSender(["mx.example.net; dmarc=pass"], "").authenticated, false, "no sender address");
});

test("an aligned pass from the receiving server is accepted", () => {
  assert.equal(ok(["mx.example.net; dmarc=pass (p=REJECT) header.from=example.com"]), true);
  assert.equal(ok(["mx.example.net; spf=pass smtp.mailfrom=bounces@mail.example.com"]), true, "relaxed alignment");
  assert.equal(ok(["mx.example.net; dkim=pass header.d=example.com header.s=s1; dkim=fail header.d=evil.test"]), true);
  assert.equal(ok(["mx.google.com; dkim=pass header.i=@example.com header.s=s1 header.b=abc"]), true, "Gmail names the signer with header.i");
  assert.equal(ok(["spf=pass (sender IP is 192.0.2.1) smtp.mailfrom=example.com; dkim=none; dmarc=pass action=none header.from=example.com"]), true,
    "a header that starts with a verdict has no server name");
  assert.equal(ok(["mx.google.com; dmarc=pass header.from=example.com"], "mx.google.com"), true, "pinned to the owner's server");
  assert.equal(ok(["MX.Google.com 1; dmarc=pass header.from=example.com"], "google.com"), true, "a pin matches its subdomains");
});

test("untrusted and repeated Authentication-Results headers are ignored", () => {
  const pass = "dmarc=pass header.from=example.com";
  assert.equal(ok([`attacker.test; ${pass}`], "mx.google.com"), false, "a header from a server that is not the owner's");
  assert.equal(ok([`mx.google.com; dmarc=fail header.from=example.com`, `attacker.test; ${pass}`], "mx.google.com"), false);
  assert.equal(ok([`mx.example.net; dmarc=fail header.from=example.com`, `attacker.test; ${pass}`]), false,
    "with no pin, only the top header counts: the receiving server writes above what the sender wrote");
  assert.equal(ok([`mx.google.com; ${pass}`, `mx.google.com; ${pass}`], "mx.google.com"), false, "two headers claim the trusted server");
  assert.equal(ok([`mx.example.net; ${pass}`, `mx.example.net; dmarc=fail`]), false, "a copy of the top server's header");
  assert.equal(ok([`dmarc=fail`, `spf=pass smtp.mailfrom=example.com`]), false, "two headers with no server name");
  // Words inside a quoted string or a comment are not verdicts.
  assert.equal(ok([`mx.example.net; dmarc=fail header.from="x; dmarc=pass header.from=example.com"`]), false);
  assert.equal(ok([`mx.example.net; dmarc=fail (dmarc=pass header.from=example.com) header.from=example.com`]), false);
  assert.equal(ok([`mx.example.net; dmarc=fail header.from="example.com`]), false, "an open quote");
});

test("the sender is the one address From: names, never an address spelled in its display name", () => {
  assert.equal(fromAddress("Alice <Alice@Example.com>"), "alice@example.com");
  assert.equal(fromAddress("alice@example.com"), "alice@example.com");
  assert.equal(fromAddress('"boss@example.com <boss@example.com>" <mallory@evil.test>'), "mallory@evil.test");
  assert.equal(fromAddress("Mallory (boss@example.com <boss@example.com>) <mallory@evil.test>"), "mallory@evil.test");
  assert.equal(fromAddress("Doe, John <j@example.com>"), "j@example.com");
  assert.equal(fromAddress("alice@example.com <alice@example.com>"), "alice@example.com");
  for (const bad of ["boss@example.com <mallory@evil.test>", "<a@example.com>, <b@example.com>", "a@example.com, b@example.com",
    "Friends: <a@example.com>;", "John", '"open <a@example.com>', "x".repeat(3000) + " <a@example.com>"])
    assert.equal(fromAddress(bad), "", bad);
  const fetched = (headers) => `* 1 FETCH (BODY[HEADER] {${Buffer.byteLength(headers)}}\r\n${headers} BODY[TEXT] {2}\r\nhi)\r\nb1 OK\r\n`;
  const mail = parseFetched(1, fetched("Authentication-Results: mx.example.net;\r\n dmarc=pass header.from=example.com\r\n"
    + "From: \"boss@example.com\" <alice@example.com>\r\nAuthentication-Results: attacker.test; dmarc=pass\r\n\r\n"));
  assert.equal(mail.from, "alice@example.com");
  assert.deepEqual(mail.authResults, ["mx.example.net; dmarc=pass header.from=example.com", "attacker.test; dmarc=pass"], "folded lines are joined, order kept");
});

test("the email adapter marks an unauthenticated sender, and the owner's pause command is not read from one", async (t) => {
  const adapter = new EmailAdapter({ id: "email", address: "me@example.com", imap: { host: "x", port: 1, user: "u", password: "p" },
    smtp: { host: "x", port: 1, user: "u", password: "p" } });
  const mail = { seq: 1, from, fromName: "Alice", subject: "Hi", messageId: "<m1@x>", references: "", text: "/platform pause" };
  assert.equal(adapter["inbound"](mail).unverifiedSender, true);
  const signed = adapter["inbound"]({ ...mail, messageId: "<m2@x>", authResults: ["mx.example.net; dmarc=pass header.from=example.com"] });
  assert.equal(signed.unverifiedSender, undefined);

  const root = await mkdtemp(join(tmpdir(), "branch-mail-auth-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"),
    provider: { name: "none", async complete() { throw new Error("not used"); } } });
  t.after(async () => { await app.close(); await discardTemp(root); });
  saveOwnerAccounts(app.store, app.runtime.owner, [{ channel: "email", sender: from }]);
  const message = { channel: "email", chatId: from, chatKind: "direct", senderId: from, senderName: "Alice", text: "/platform pause", addressed: true, messageId: "m" };
  assert.equal(platformGate(app.store, app.runtime.owner, { ...message, unverifiedSender: true }), null, "a forged owner cannot pause a chat app");
  assert.match(platformGate(app.store, app.runtime.owner, message)?.reply ?? "", /paused/, "the owner's authenticated mail still can");
});
