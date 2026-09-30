/**
 * UP-RESEARCH-050: an email is answered only when the receiving server says its sender is authentic (DMARC pass for
 * the From domain, or an aligned SPF or DKIM pass), read from the first Authentication-Results header only.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { authenticatedSender } from "../dist/channels/mail-auth.js";
import { EmailAdapter } from "../dist/channels/email.js";

test("DMARC, or SPF or DKIM aligned exactly with the From domain, authenticates a sender", () => {
  assert.equal(authenticatedSender("ann@example.com", "mx.google.com; dmarc=pass header.from=example.com"), true);
  assert.equal(authenticatedSender("ann@example.com", "mx.google.com; spf=pass smtp.mailfrom=bounce@example.com"), true);
  assert.equal(authenticatedSender("ann@example.com", "mx.google.com; dkim=pass header.d=example.com"), true);
  assert.equal(authenticatedSender("ann@example.com", "mx.google.com; dkim=pass header.d=mailer.example.net"), false, "a signature for another domain");
  assert.equal(authenticatedSender("ann@example.com", "mx.google.com; spf=pass smtp.mailfrom=x@sub.example.com"), false, "no guessed relationships");
  assert.equal(authenticatedSender("ann@example.com", "mx.google.com; dmarc=fail header.from=example.com"), false);
  assert.equal(authenticatedSender("ann@example.com", undefined), false, "no verdict, no answer");
});

test("comments and quotes cannot smuggle a verdict, and a pinned mailbox id must match exactly", () => {
  assert.equal(authenticatedSender("ann@example.com", "mx.google.com; spf=fail (dmarc=pass header.from=example.com) smtp.mailfrom=example.com"), false);
  assert.equal(authenticatedSender("ann@example.com", 'mx.google.com; x-note="; dmarc=pass header.from=example.com"'), false);
  assert.equal(authenticatedSender("ann@example.com", "mx.google.com; dmarc=pass (unclosed header.from=example.com"), false);
  const pinned = ["mx.google.com"];
  assert.equal(authenticatedSender("ann@example.com", "mx.google.com; dmarc=pass header.from=example.com", pinned), true);
  assert.equal(authenticatedSender("ann@example.com", "evil-mx.google.com; dmarc=pass header.from=example.com", pinned), false);
});

test("the email channel skips an unauthenticated sender unless the owner turns the check off", () => {
  const options = { id: "email", address: "me@example.com", imap: { host: "x", port: 1, user: "u", password: "p" },
    smtp: { host: "x", port: 1, user: "u", password: "p" } };
  const mail = (authenticationResults) => ({ seq: 1, from: "ann@example.com", fromName: "Ann", subject: "Hi", messageId: "<m@x>",
    references: "", text: "hello", ...(authenticationResults ? { authenticationResults } : {}) });
  assert.equal(new EmailAdapter(options)["inbound"](mail()), null, "no verdict: not routed");
  assert.ok(new EmailAdapter(options)["inbound"](mail("mx.example.com; dmarc=pass header.from=example.com")));
  assert.ok(new EmailAdapter({ ...options, requireAuthenticatedSender: false })["inbound"](mail()), "the owner's choice to turn it off");
});
