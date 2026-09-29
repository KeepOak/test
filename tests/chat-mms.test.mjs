/**
 * Pictures and files by MMS on the Twilio text-message channel (CHAT-171), against a fake Twilio: the Media list is read
 * for what came, bytes are fetched only when asked (with the key from Twilio, without it from the https address Twilio
 * redirects to), and nothing past the task's size limit is taken. No real Twilio account is used.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { until } from "./channels-parity-kit.mjs";
import { TwilioSmsChannel } from "../dist/channels/twilio-sms.js";

const ACCOUNT = `AC${"0123456789abcdef".repeat(2)}`;
const OURS = "+15557654321";
const hex = (prefix, n) => `${prefix}${String(n).padStart(32, "0")}`;

function fakeTwilio() {
  const calls = [];
  const messages = [];
  const media = new Map();
  const fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    calls.push({ url: u.href, auth: init.headers?.authorization ?? null, redirect: init.redirect });
    const base = `/2010-04-01/Accounts/${ACCOUNT}/Messages`;
    if (u.host === "cdn.example.com") {
      const body = media.get(u.pathname.slice(1));
      return new Response(body.bytes, { headers: { "content-type": body.type, "content-length": String(body.bytes.byteLength) } });
    }
    if (u.pathname === `${base}.json`) return Response.json({ messages: messages.slice() });
    const list = new RegExp(`^${base}/(MM\\w+)/Media\\.json$`).exec(u.pathname);
    if (list) return Response.json({ media_list: [...media.entries()].filter(([, m]) => m.message === list[1]).map(([sid, m]) => ({ sid, content_type: m.type })) });
    const one = new RegExp(`^${base}/(MM\\w+)/Media/(ME\\w+)$`).exec(u.pathname);
    if (one) return new Response(null, { status: 307, headers: { location: media.get(one[2]).location ?? `https://cdn.example.com/${one[2]}` } });
    return new Response("{}", { status: 404 });
  };
  let n = 0;
  const mms = (from, body, files) => {
    const sid = hex("MM", ++n);
    files.forEach((file, i) => media.set(hex("ME", n * 10 + i), { message: sid, ...file }));
    messages.unshift({ sid, from, to: OURS, body, direction: "inbound", num_media: String(files.length) });
  };
  return { calls, fetch, mms };
}

test("MMS: pictures and files come in by their Media list, and bytes are fetched only when asked, without the key off Twilio", async (t) => {
  const twilio = fakeTwilio();
  const got = [];
  const channel = new TwilioSmsChannel({ id: "sms", accountSid: ACCOUNT, authToken: "SECRET-TOKEN", authTokenSecret: "TWILIO_AUTH_TOKEN",
    from: OURS, apiBase: "https://api.twilio.com", pollMs: 20, fetch: twilio.fetch });
  await channel.start(async (message) => { got.push(message); });
  t.after(() => channel.stop());
  await until(() => channel.health().state === "connected", "took stock");

  twilio.mms("+15550001111", "", [{ type: "image/jpeg", bytes: new Uint8Array([1, 2, 3]) }, { type: "application/pdf", bytes: new Uint8Array([4]) }]);
  const message = await until(() => got[0], "a picture-only MMS");
  assert.equal(message.text, "", "a message that is only pictures still counts");
  assert.deepEqual(message.attachments.map((a) => [a.kind, a.mediaType, /^mms-\w{8}\.(jpg|pdf)$/.test(a.name)]),
    [["picture", "image/jpeg", true], ["document", "application/pdf", true]]);
  assert.equal(twilio.calls.filter((c) => c.url.includes("cdn.example.com") || /\/Media\/ME/.test(c.url)).length, 0, "no bytes before the message is answered");

  assert.deepEqual([...await message.attachments[0].bytes()], [1, 2, 3]);
  const [asked, fetched] = twilio.calls.slice(-2);
  assert.match(asked.url, /\/Messages\/MM\w+\/Media\/ME\w+$/);
  assert.ok(asked.auth?.startsWith("Basic "), "Twilio is asked with the key");
  assert.equal(asked.redirect, "manual", "the redirect is not followed with the key");
  assert.equal(fetched.url.startsWith("https://cdn.example.com/"), true);
  assert.equal(fetched.auth, null, "the key never goes to the address Twilio points at");

  twilio.mms("+15550001111", "look", [{ type: "image/png", bytes: new Uint8Array(9 * 1024 * 1024) }, { type: "image/png", bytes: new Uint8Array(1), location: "http://cdn.example.com/x" }]);
  const risky = await until(() => got[1], "a second MMS");
  assert.equal(risky.text, "look");
  await assert.rejects(risky.attachments[0].bytes(), (error) => error.constructor.name === "ArtifactTooLarge", "past the size a task takes");
  await assert.rejects(risky.attachments[1].bytes(), /not https/, "a plain-http address is not fetched");
});
