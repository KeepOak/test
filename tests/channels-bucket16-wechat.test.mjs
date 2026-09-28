import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { fixture, until, delay, setSwitch, assertNoSecret, httpService } from "./channels-parity-kit.mjs";
import { buildParityChannel, paritySummary } from "../dist/channels/parity-config.js";
import { decryptWechat, encryptWechat, wechatSignature, xmlFields } from "../dist/channels/wechat-crypto.js";
import { isSignedQueryChannel } from "../dist/channels/signed-query.js";
import { startServer } from "../dist/server.js";

/**
 * mac6/bucket-16: WeChat Official Accounts and WeCom apps, driven through the real web address with
 * posts built the way their documentation describes (safe mode). Nothing real is contacted.
 */
const aesKey = () => randomBytes(32).toString("base64").slice(0, 43);
const MP = { appId: "wx0123456789abcdef", secret: "SECRET-WECHAT-APP-SECRET-71", token: "SECRETwechatTOKEN72", aes: aesKey(), access: "SECRET-WECHAT-ACCESS-73" };
const WC = { corpId: "ww0123456789abcdef", agentId: 1000002, secret: "SECRET-WECOM-CORP-SECRET-81", token: "SECRETwecomTOKEN82", aes: aesKey(), access: "SECRET-WECOM-ACCESS-83" };
const policy = { activation: "mention", pairing: true, allowlist: [] };
let counter = 0;

test("the shared encryption opens what it seals, checks who it was meant for, and the XML reader stays small", () => {
  const key = aesKey();
  const sealed = encryptWechat(key, "<xml><Content><![CDATA[你好 & hi]]></Content></xml>", "wx-app");
  assert.equal(decryptWechat(key, sealed, "wx-app"), "<xml><Content><![CDATA[你好 & hi]]></Content></xml>");
  assert.throws(() => decryptWechat(key, sealed, "wx-other"), /different app/);
  assert.throws(() => decryptWechat(aesKey(), sealed, "wx-app"), /could not be opened/);
  assert.throws(() => decryptWechat("short", sealed, "wx-app"), /43 characters/);
  const expected = createHash("sha1").update(["b", "a", "c"].sort().join("")).digest("hex");
  assert.equal(wechatSignature(["c", "a", "b"]), expected);
  assert.deepEqual({ ...xmlFields("<xml><A><![CDATA[x<y]]></A><B>1 &lt; 2</B><A>second</A></xml>") }, { A: "x<y", B: "1 < 2" });
  assert.throws(() => xmlFields('<!DOCTYPE x [<!ENTITY e "boom">]><xml><A>&e;</A></xml>'), /not the XML/);
  assert.throws(() => xmlFields("{\"json\": true}"), /not the XML/);
  assert.equal(xmlFields("<xml><constructor>c</constructor></xml>").constructor, "c", "no prototype names get in the way");
});

function inner(fields) {
  return `<xml>${Object.entries(fields).map(([k, v]) => `<${k}><![CDATA[${v}]]></${k}>`).join("")}</xml>`;
}
/** A signed, encrypted post exactly as WeChat or WeCom would send it. */
function signedPost(cfg, receiveId, fields, { timestamp = String(Math.floor(Date.now() / 1000)), token = cfg.token, mp = false } = {}) {
  const encrypt = encryptWechat(cfg.aes, inner(fields), receiveId);
  const nonce = String(++counter);
  const query = new URLSearchParams({ timestamp, nonce, msg_signature: wechatSignature([token, timestamp, nonce, encrypt]) });
  if (mp) { query.set("encrypt_type", "aes"); query.set("signature", wechatSignature([token, timestamp, nonce])); query.set("openid", fields.FromUserName); }
  return { query, body: `<xml><ToUserName><![CDATA[${receiveId}]]></ToUserName><Encrypt><![CDATA[${encrypt}]]></Encrypt></xml>` };
}

async function serve(t, context, config, secrets, kind) {
  const { app } = context;
  const channel = await buildParityChannel({ ...config, ...policy }, { credential: async (name) => secrets[name], store: app.store, owner: app.runtime.owner });
  assert.ok(isSignedQueryChannel(channel), "the switched channel is recognised by its signed address");
  setSwitch(app, kind, "on");
  await app.channels.attach(channel, policy);
  t.after(() => channel.stop());
  const server = await startServer(app, { dataDir: join(context.root, "data"), port: 0 });
  t.after(() => server.close());
  const listed = await fetch(`${server.url}/api/channels/addresses`, { headers: { authorization: `Bearer ${server.token}`, origin: server.url } }).then((r) => r.json());
  const address = listed.addresses.find((entry) => entry.channel === config.id)?.address;
  assert.match(address ?? "", new RegExp(`^/webhooks/chat/${config.id}/[a-f0-9]{32}$`));
  const call = (query, init = {}) => fetch(`${server.url}${address}?${query}`, init);
  const postIt = ({ query, body }) => call(query, { method: "POST", headers: { "content-type": "text/xml" }, body });
  return { channel, call, postIt };
}

function mpApi(t, { windowClosed = false } = {}) {
  const sent = [];
  return httpService(t, (call) => {
    if (call.path === "/cgi-bin/stable_token") {
      if (call.json?.secret !== MP.secret) return { body: { errcode: 40125, errmsg: "invalid appsecret" } };
      return { body: { access_token: MP.access, expires_in: 7200 } };
    }
    if (call.path === "/cgi-bin/message/custom/send") {
      if (call.query.access_token !== MP.access) return { body: { errcode: 40001, errmsg: "invalid credential" } };
      if (windowClosed) return { body: { errcode: 45015, errmsg: "response out of time limit" } };
      sent.push(call.json);
      return { body: { errcode: 0, errmsg: "ok" } };
    }
    return undefined;
  }).then((api) => ({ ...api, sent }));
}
const mpConfig = (api) => ({ type: "wechat-mp", id: "wechat", appId: MP.appId, apiBase: api.base });
const mpSecrets = { WECHAT_MP_APP_SECRET: MP.secret, WECHAT_MP_TOKEN: MP.token, WECHAT_MP_AES_KEY: MP.aes };
const mpText = (content, extra = {}) => ({ ToUserName: "gh_abc", FromUserName: "oUSER123456", CreateTime: "1", MsgType: "text", Content: content, MsgId: String(++counter), ...extra });

test("WeChat Official Account: the address check, a signed stranger pairs, and answers go out as customer-service messages", async (t) => {
  const context = await fixture(t);
  const api = await mpApi(t);
  const { call, postIt } = await serve(t, context, mpConfig(api), mpSecrets, "wechat-mp");
  const timestamp = String(Math.floor(Date.now() / 1000));
  const check = new URLSearchParams({ timestamp, nonce: "n1", echostr: "echo-123", signature: wechatSignature([MP.token, timestamp, "n1"]) });
  const verified = await call(check);
  assert.equal(verified.status, 200);
  assert.equal(await verified.text(), "echo-123");
  check.set("signature", wechatSignature(["guess", timestamp, "n1"]));
  assert.equal((await call(check)).status, 401, "a wrongly signed check is refused");

  const first = await postIt(signedPost(MP, MP.appId, mpText("hello there"), { mp: true }));
  assert.equal(first.status, 200);
  assert.equal(await first.text(), "success");
  const offer = await until(() => api.sent.find((m) => /\b\d{6}\b/.test(m.text.content)), "a pairing code");
  assert.equal(offer.touser, "oUSER123456");
  assert.equal(offer.msgtype, "text");
  assert.equal(context.provider.requests.length, 0);
  context.app.channels.approve(context.app.runtime.owner, { code: /\b(\d{6})\b/.exec(offer.text.content)[1] });

  const message = mpText("what is the time");
  const again = signedPost(MP, MP.appId, message, { mp: true });
  await postIt(again);
  await until(() => api.sent.some((m) => /Echo: .*what is the time/.test(m.text.content)), "answered");
  assert.equal((await postIt(again)).status, 200, "an identical copy is acknowledged");
  await postIt(signedPost(MP, MP.appId, message, { mp: true }));
  await delay(120);
  assert.equal(context.provider.requests.length, 1, "WeChat's resend of the same message is answered once");
  await assertNoSecret(context, [MP.secret, MP.token, MP.aes, MP.access]);
});

test("WeChat Official Account: plain-text mode, forged, altered and old posts are refused; switched off is 503", async (t) => {
  const context = await fixture(t);
  const api = await mpApi(t);
  const { postIt } = await serve(t, context, mpConfig(api), mpSecrets, "wechat-mp");
  setSwitch(context.app, "wechat-mp", "off");
  assert.equal((await postIt(signedPost(MP, MP.appId, mpText("hello"), { mp: true }))).status, 503);
  setSwitch(context.app, "wechat-mp", "on");
  const plain = signedPost(MP, MP.appId, mpText("hello"), { mp: true });
  plain.query.delete("encrypt_type");
  assert.equal((await postIt(plain)).status, 401, "plain-text mode signs nothing of the message");
  assert.equal((await postIt(signedPost(MP, MP.appId, mpText("hello"), { mp: true, token: "not-the-token" }))).status, 401);
  const altered = signedPost(MP, MP.appId, mpText("hello"), { mp: true });
  altered.body = altered.body.replace(/<Encrypt><!\[CDATA\[(.)/, (_all, c) => `<Encrypt><![CDATA[${c === "A" ? "B" : "A"}`);
  assert.equal((await postIt(altered)).status, 401, "changed words break the signature");
  const old = signedPost(MP, MP.appId, mpText("hello"), { mp: true, timestamp: String(Math.floor(Date.now() / 1000) - 3600) });
  assert.equal((await postIt(old)).status, 401, "an hour-old post is refused");
  const foreign = signedPost(MP, "wxsomeoneelse00000", mpText("hello"), { mp: true });
  assert.equal((await postIt(foreign)).status, 401, "a post sealed for another app is refused");
  // mac7/lockout: after five refusals the sender IS waiting — but the wait is read only once a post
  // has been found wrong, so a properly sealed and properly signed post goes through anyway. A wait
  // that turned this away would be the fault this wave closed: a stale address or a mistyped secret
  // silencing real messages, with nothing telling the owner why they stopped arriving.
  const good = await postIt(signedPost(MP, MP.appId, mpText("hello"), { mp: true }));
  assert.equal(good.status, 200, "a correctly addressed, correctly sealed post is never made to wait");
  assert.equal((await postIt(signedPost(MP, MP.appId, mpText("hello"), { mp: true, token: "not-the-token" }))).status, 401,
    "and a wrong one is still refused; the good post cleared this sender's count rather than the limit going away");
  await delay(50);
  assert.equal(context.provider.requests.length, 0);
});

test("WeChat Official Account: a closed reply window and a refused app secret are said plainly", async (t) => {
  const context = await fixture(t);
  const closed = await mpApi(t, { windowClosed: true });
  const channel = (await buildParityChannel({ ...mpConfig(closed), ...policy }, { credential: async (name) => mpSecrets[name] })).inner;
  await assert.rejects(() => channel.send("oUSER123456", "late"), /reply window/);
  const wrong = await buildParityChannel({ ...mpConfig(closed), ...policy }, { credential: async (name) => (name === "WECHAT_MP_APP_SECRET" ? "nope" : mpSecrets[name]) });
  await assert.rejects(() => wrong.inner.send("oUSER123456", "hi"), (error) => /WeChat refused the request \(40125\)/.test(error.message) && !error.message.includes(MP.secret));
  assert.equal(wrong.inner.health().state, "needs attention");
  assert.match(wrong.inner.health().reason, /WECHAT_MP_APP_SECRET/);
  void context;
});

function wecomApi(t) {
  const sent = [];
  let tokens = 0;
  return httpService(t, (call) => {
    if (call.path === "/cgi-bin/gettoken") {
      if (call.query.corpsecret !== WC.secret || call.query.corpid !== WC.corpId) return { body: { errcode: 40001, errmsg: "invalid secret" } };
      tokens++;
      return { body: { errcode: 0, access_token: `${WC.access}-${tokens}`, expires_in: 7200 } };
    }
    if (call.path === "/cgi-bin/message/send") {
      // The first token is treated as expired, so Branch has to fetch a new one and try again.
      if (call.query.access_token !== `${WC.access}-2`) return { body: { errcode: 42001, errmsg: "access_token expired" } };
      sent.push(call.json);
      return { body: { errcode: 0, errmsg: "ok" } };
    }
    return undefined;
  }).then((api) => ({ ...api, sent }));
}

test("WeCom app: the encrypted address check, a colleague pairs, another app's messages are ignored, and an expired token is renewed", async (t) => {
  const context = await fixture(t);
  const api = await wecomApi(t);
  const secrets = { WECOM_APP_SECRET: WC.secret, WECOM_APP_TOKEN: WC.token, WECOM_APP_AES_KEY: WC.aes };
  const config = { type: "wecom-app", id: "wecom", corpId: WC.corpId, agentId: WC.agentId, apiBase: api.base };
  const { call, postIt } = await serve(t, context, config, secrets, "wecom-app");
  const timestamp = String(Math.floor(Date.now() / 1000));
  const echostr = encryptWechat(WC.aes, "plain-echo-9", WC.corpId);
  const check = new URLSearchParams({ timestamp, nonce: "n2", echostr, msg_signature: wechatSignature([WC.token, timestamp, "n2", echostr]) });
  const verified = await call(check);
  assert.equal(await verified.text(), "plain-echo-9", "the decrypted word is echoed");
  check.set("msg_signature", wechatSignature([WC.token, timestamp, "n3", echostr]));
  assert.equal((await call(check)).status, 401);

  const text = (content, extra = {}) => ({ ToUserName: WC.corpId, FromUserName: "zhang.san", CreateTime: "1", MsgType: "text",
    Content: content, MsgId: String(++counter), AgentID: String(WC.agentId), ...extra });
  const ok = await postIt(signedPost(WC, WC.corpId, text("hello there")));
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), "");
  const offer = await until(() => api.sent.find((m) => /\b\d{6}\b/.test(m.text.content)), "a pairing code");
  assert.deepEqual({ touser: offer.touser, agentid: offer.agentid, msgtype: offer.msgtype }, { touser: "zhang.san", agentid: WC.agentId, msgtype: "text" });
  context.app.channels.approve(context.app.runtime.owner, { code: /\b(\d{6})\b/.exec(offer.text.content)[1] });
  await postIt(signedPost(WC, WC.corpId, text("for another app", { AgentID: "999" })));
  await postIt(signedPost(WC, WC.corpId, text("an event", { MsgType: "event" })));
  await postIt(signedPost(WC, WC.corpId, text("what is the time")));
  await until(() => api.sent.some((m) => /Echo: .*what is the time/.test(m.text.content)), "answered");
  assert.equal(context.provider.requests.length, 1, "only the app's own text messages reach the model");
  await assertNoSecret(context, [WC.secret, WC.token, WC.aes, WC.access]);
});

test("WeChat and WeCom take strict settings with secret names, check their hosts, and ship switched off", async (t) => {
  const context = await fixture(t);
  const blocked = { assertAllowed: async (url) => { throw new Error(`Not allowed: ${url.hostname}`); }, guard: (f) => f };
  const mp = { type: "wechat-mp", id: "mp", appId: MP.appId, ...policy };
  const wc = { type: "wecom-app", id: "wc", corpId: WC.corpId, agentId: 5, ...policy };
  await assert.rejects(() => buildParityChannel(mp, { credential: async () => "x", policy: blocked }), /Not allowed: api\.weixin\.qq\.com/);
  await assert.rejects(() => buildParityChannel(wc, { credential: async () => "x", policy: blocked }), /Not allowed: qyapi\.weixin\.qq\.com/);
  await assert.rejects(() => buildParityChannel({ ...mp, appSecretSecret: "real-secret-value" }, { credential: async () => "x" }));
  await assert.rejects(() => buildParityChannel({ ...mp, appId: "not-an-app" }, { credential: async () => "x" }));
  await assert.rejects(() => buildParityChannel({ ...wc, secret: "raw" }, { credential: async () => "x" }), /secret|Unrecognized/i);
  const asked = [];
  const host = { credential: async (name) => { asked.push(name); return "x"; }, store: context.app.store, owner: context.app.runtime.owner };
  for (const config of [mp, wc]) {
    const built = await buildParityChannel(config, host);
    assert.equal(built.health().state, "needs attention", `${config.type} starts off`);
  }
  assert.deepEqual(asked, ["WECHAT_MP_APP_SECRET", "WECHAT_MP_TOKEN", "WECHAT_MP_AES_KEY", "WECOM_APP_SECRET", "WECOM_APP_TOKEN", "WECOM_APP_AES_KEY"]);
  const cards = (await paritySummary(context.app.store, context.app.runtime.owner)).filter((s) => /^we(chat|com)-/.test(s.kind));
  assert.deepEqual(cards.map((c) => [c.kind, c.switch, c.receives]), [["wechat-mp", "off", "posted"], ["wecom-app", "off", "posted"]]);
});
