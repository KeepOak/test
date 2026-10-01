import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createServer as createSocketServer, connect as tcpConnect } from "node:net";
import { fixture, until, delay, assertNoSecret, pairingWalk, refusalWalk, socketService, setSwitch } from "./channels-parity-kit.mjs";
import { buildParityChannel } from "../dist/channels/parity-config.js";
import { XmppChannel } from "../dist/channels/xmpp.js";
import { SimplexChannel } from "../dist/channels/simplex.js";
import { connectWebSocket } from "../dist/channels/ws-client.js";
import { DeltaChatChannel } from "../dist/channels/deltachat.js";
import { NostrChannel } from "../dist/channels/nostr.js";
import { KeybaseChannel } from "../dist/channels/keybase.js";
import { MqttChannel, encodeLength, replyTopicFor } from "../dist/channels/mqtt.js";
import { XmlStreamReader, decodeEntities, escapeAttr, escapeText } from "../dist/channels/xmpp-xml.js";
import {
  schnorrSign, schnorrVerify, publicKeyOf, nip04Encrypt, nip04Decrypt, signEvent, verifyEvent, readPrivateKey,
} from "../dist/channels/nostr-crypto.js";

/**
 * The socket and local-program chat services: XMPP, MQTT, Keybase, SimpleX, Delta Chat and Nostr.
 * Every one is driven through a stand-in (a fake server on this computer, or a fake program), and
 * never through a real service or a real installed program.
 */
const XMPP_PASSWORD = "SECRET-XMPP-PASSWORD-11";
const MQTT_PASSWORD = "SECRET-MQTT-PASSWORD-12";
const NOSTR_KEY = "5ec2e7a1b0c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a2b1c0d9e8";

const blocked = { assertAllowed: async (url) => { throw new Error(`Not allowed: ${url.hostname}`); }, guard: (f) => f };
const policy = { activation: "mention", pairing: true, allowlist: [] };

/** A plain socket opener pointed at the stand-in, whatever host the settings name. */
const localSocket = (port, opened = []) => async (target) => new Promise((resolve, reject) => {
  opened.push(target);
  const socket = tcpConnect({ host: "127.0.0.1", port }, () => resolve(socket));
  socket.once("error", reject);
});

/** A raw TCP stand-in; `onConnect(connection)` sets up how each connection is answered. */
async function rawServer(t, onConnect) {
  const connections = [];
  const server = createSocketServer((socket) => {
    const connection = { socket, chunks: [], write: (data) => socket.write(data) };
    socket.on("error", () => undefined);
    socket.on("data", (chunk) => { connection.chunks.push(chunk); connection.onData?.(chunk); });
    connections.push(connection);
    onConnect(connection);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { for (const c of connections) c.socket.destroy(); server.close(resolve); }));
  return { connections, port: server.address().port };
}

// ---------------------------------------------------------------- XMPP

const XMPP_HEADER = "<?xml version='1.0'?><stream:stream from='example.org' id='s1' version='1.0' xmlns='jabber:client' xmlns:stream='http://etherx.jabber.org/streams'>";
const STANZA = /^(?:\s+|<\?xml[^>]*\?>|<stream:stream[^>]*>|<\/stream:stream>|<([\w:]+)(?:[^>"']|"[^"]*"|'[^']*')*\/>|<([\w:]+)(?:[^>"']|"[^"]*"|'[^']*')*>[\s\S]*?<\/\2>)/;

/**
 * A stand-in XMPP server: offers STARTTLS when asked to, checks the SASL PLAIN password, binds a
 * resource, and records every stanza the assistant sends.
 */
function xmppServer(connection, { password, starttls = false, plainOnly = false }) {
  const state = { stanzas: [], secure: false, signedIn: false, pending: "" };
  connection.xmpp = state;
  const features = () => {
    if (state.signedIn) return "<stream:features><bind xmlns='urn:ietf:params:xml:ns:xmpp-bind'/></stream:features>";
    if (starttls && !state.secure) return "<stream:features><starttls xmlns='urn:ietf:params:xml:ns:xmpp-tls'><required/></starttls></stream:features>";
    const mechanism = plainOnly ? "X-OTHER" : "PLAIN";
    return `<stream:features><mechanisms xmlns='urn:ietf:params:xml:ns:xmpp-sasl'><mechanism>${mechanism}</mechanism></mechanisms></stream:features>`;
  };
  const handle = (piece) => {
    state.stanzas.push(piece);
    if (piece.startsWith("<stream:stream")) connection.write(XMPP_HEADER + features());
    else if (piece.startsWith("<starttls")) { state.secure = true; connection.write("<proceed xmlns='urn:ietf:params:xml:ns:xmpp-tls'/>"); }
    else if (piece.startsWith("<auth")) {
      const token = /<auth[^>]*>([^<]*)<\/auth>/.exec(piece)[1];
      const [, user, pass] = Buffer.from(token, "base64").toString("utf8").split("\0");
      state.user = user;
      if (pass === password) { state.signedIn = true; connection.write("<success xmlns='urn:ietf:params:xml:ns:xmpp-sasl'/>"); }
      else connection.write("<failure xmlns='urn:ietf:params:xml:ns:xmpp-sasl'><not-authorized/></failure>");
    } else if (piece.includes("id='bind1'")) {
      connection.write("<iq type='result' id='bind1'><bind xmlns='urn:ietf:params:xml:ns:xmpp-bind'><jid>branch@example.org/branch</jid></bind></iq>");
    }
  };
  connection.onData = (chunk) => {
    state.pending += chunk.toString("utf8");
    for (let match = STANZA.exec(state.pending); match; match = STANZA.exec(state.pending)) {
      state.pending = state.pending.slice(match[0].length);
      if (match[0].trim()) handle(match[0]);
    }
  };
  connection.write(""); // nothing is said until the assistant opens its stream
}
const sentMessages = (connection) => connection.xmpp.stanzas.filter((s) => s.startsWith("<message"));
const bodyOf = (stanza) => decodeEntities(/<body>([\s\S]*)<\/body>/.exec(stanza)?.[1] ?? "");

function xmppChannel(port, extra = {}) {
  return new XmppChannel({ id: "xmpp", jid: "branch@example.org", password: XMPP_PASSWORD, host: "xmpp.example.org", port,
    security: "starttls", allowPlainText: true, open: localSocket(port), retryBaseMs: 20, ...extra });
}

test("XMPP XML: both quote styles, every entity form, and no document types or custom entities", () => {
  const reader = new XmlStreamReader();
  const events = [];
  const feed = (text) => reader.push(text, (event) => events.push(event));
  // Split in awkward places, as a network would.
  for (const part of [XMPP_HEADER.slice(0, 20), XMPP_HEADER.slice(20), "<message from=\"a@b/c\" type='chat'><bo", "dy>1 &lt; 2 &amp;&#65;&#x42;&quot;&apos;</body></mes", "sage> <iq type='get' id='p'/>"])
    feed(part);
  assert.equal(events[0].type, "open");
  assert.equal(events[0].attrs.from, "example.org");
  assert.equal(events[1].element.attrs.from, "a@b/c");
  assert.equal(events[1].element.attrs.type, "chat");
  assert.equal(events[1].element.children[0].text, "1 < 2 &AB\"'");
  assert.equal(events[2].element.name, "iq");
  assert.throws(() => new XmlStreamReader().push("<?xml version='1.0'?><!DOCTYPE x [<!ENTITY a 'b'>]>", () => undefined), /document type/);
  assert.throws(() => decodeEntities("&custom;"), /entity XMPP does not allow/);
  assert.throws(() => decodeEntities("&#0;"), /does not allow/);
  const later = new XmlStreamReader();
  assert.throws(() => later.push(`${XMPP_HEADER}<!ENTITY lol 'lol'>`, () => undefined), /document type/);
  assert.equal(escapeText("<b>&\u0001"), "&lt;b&gt;&amp;");
  assert.equal(escapeAttr(`"it's"`), "&quot;it&apos;s&quot;");
});

test("XMPP: signs in, pairs a stranger through real stanzas, answers them, and ignores its own address", async (t) => {
  const context = await fixture(t);
  const server = await rawServer(t, (connection) => xmppServer(connection, { password: XMPP_PASSWORD }));
  const channel = xmppChannel(server.port);
  await context.app.channels.attach(channel, policy);
  t.after(() => channel.stop());
  await until(() => channel.health().state === "connected", "signed in and bound");
  const link = server.connections[0];
  assert.equal(link.xmpp.user, "branch");
  assert.ok(link.xmpp.stanzas.includes("<presence/>"), "announces itself");

  const texts = () => sentMessages(link).map(bodyOf);
  await pairingWalk(context, { label: "XMPP", sent: texts,
    say: async (text) => link.write(`<message from='carol@example.net/phone' to='branch@example.org' type='chat' id='m${Date.now()}'><body>${escapeText(text)}</body></message>`) });
  const reply = sentMessages(link).at(-1);
  assert.match(reply, /^<message to='carol@example.net' type='chat'/, "answered at the sender's bare address as a chat");

  // Its own address (another of its devices) is never answered, and a ping is answered.
  const asked = context.provider.requests.length;
  link.write("<message from='branch@example.org/other' type='chat'><body>note to self</body></message>");
  link.write("<iq type='get' id='ping1' from='example.org'><ping xmlns='urn:xmpp:ping'/></iq>");
  await until(() => link.xmpp.stanzas.some((s) => s.includes("id='ping1'")), "the ping is answered");
  await delay(80);
  assert.equal(context.provider.requests.length, asked, "its own message is not answered");

  // Whatever a reply contains, it stays inside the body.
  await channel.send("carol@example.net", "</body></message><message to='x@y'><body>owned");
  await until(() => sentMessages(link).some((s) => s.includes("&lt;/body&gt;")), "escaped reply");
  assert.ok(!sentMessages(link).some((s) => s.startsWith("<message to='x@y'")), "no second stanza was smuggled in");
  assert.equal(sentMessages(link).at(-1).match(/<message/g).length, 1);
  await assertNoSecret(context, [XMPP_PASSWORD]);
});

test("XMPP rooms: history and the room's echo are ignored, only a message naming the nick is answered, in the room", async (t) => {
  const context = await fixture(t);
  const server = await rawServer(t, (connection) => xmppServer(connection, { password: XMPP_PASSWORD }));
  const channel = xmppChannel(server.port, { rooms: [{ room: "team@rooms.example.org", nick: "branch" }] });
  await context.app.channels.attach(channel, { activation: "mention", pairing: false, allowlist: ["dave@example.net"] });
  t.after(() => channel.stop());
  await until(() => channel.health().state === "connected", "signed in");
  const link = server.connections[0];
  await until(() => link.xmpp.stanzas.some((s) => s.startsWith("<presence to='team@rooms.example.org/branch'") && s.includes("maxstanzas='0'")), "joined the room");
  const from = "from='team@rooms.example.org/dave' type='groupchat'";
  const real = "<x xmlns='http://jabber.org/protocol/muc#user'><item jid='dave@example.net/laptop'/></x>";
  link.write(`<message ${from}><body>branch: an old question</body><delay xmlns='urn:xmpp:delay' stamp='2020-01-01T00:00:00Z'/>${real}</message>`);
  link.write(`<message from='team@rooms.example.org/branch' type='groupchat'><body>branch: my own words</body></message>`);
  link.write(`<message ${from}><body>lunch anyone?</body>${real}</message>`);
  await delay(150);
  assert.equal(context.provider.requests.length, 0, "history, echo and unaddressed talk are left alone");
  link.write(`<message ${from} id='g1'><body>branch: what is the plan</body>${real}</message>`);
  await until(() => sentMessages(link).some((s) => /Echo:.*what is the plan/.test(bodyOf(s))), "answered in the room");
  assert.match(sentMessages(link).at(-1), /^<message to='team@rooms.example.org' type='groupchat'/);
  await assertNoSecret(context, [XMPP_PASSWORD]);
});

test("XMPP: a stranger is refused when pairing is off", async (t) => {
  const context = await fixture(t);
  const server = await rawServer(t, (connection) => xmppServer(connection, { password: XMPP_PASSWORD }));
  const channel = xmppChannel(server.port);
  await context.app.channels.attach(channel, { activation: "mention", pairing: false, allowlist: [] });
  t.after(() => channel.stop());
  await until(() => channel.health().state === "connected", "signed in");
  const link = server.connections[0];
  await refusalWalk(context, { label: "XMPP", sent: () => sentMessages(link).map(bodyOf),
    say: async (text) => link.write(`<message from='mallory@evil.example/x' type='chat'><body>${text}</body></message>`) });
  await assertNoSecret(context, [XMPP_PASSWORD]);
});

test("XMPP: STARTTLS comes before the password, no password goes out unencrypted, and a wrong one is said plainly", async (t) => {
  const context = await fixture(t);
  const tlsServer = await rawServer(t, (connection) => xmppServer(connection, { password: XMPP_PASSWORD, starttls: true }));
  const upgrades = [];
  const secured = new XmppChannel({ id: "tls", jid: "branch@example.org", password: XMPP_PASSWORD, host: "h", port: tlsServer.port,
    security: "starttls", open: localSocket(tlsServer.port), upgrade: async (socket, name) => { upgrades.push(name); return socket; } });
  await secured.start(async () => undefined);
  t.after(() => secured.stop());
  await until(() => secured.health().state === "connected", "signed in after STARTTLS");
  const stanzas = tlsServer.connections[0].xmpp.stanzas;
  assert.deepEqual(upgrades, ["example.org"]);
  assert.ok(stanzas.findIndex((s) => s.startsWith("<starttls")) < stanzas.findIndex((s) => s.startsWith("<auth")), "encryption first");
  assert.equal(stanzas.filter((s) => s.startsWith("<stream:stream")).length, 3, "the stream restarts after TLS and after sign-in");

  const plainServer = await rawServer(t, (connection) => xmppServer(connection, { password: XMPP_PASSWORD }));
  const careful = new XmppChannel({ id: "plain", jid: "branch@example.org", password: XMPP_PASSWORD, host: "h", port: plainServer.port,
    security: "starttls", open: localSocket(plainServer.port) });
  await careful.start(async () => undefined);
  t.after(() => careful.stop());
  await until(() => careful.health().state === "needs attention", "refuses to sign in unencrypted");
  assert.match(careful.health().reason, /does not offer encryption/);
  assert.ok(!Buffer.concat(plainServer.connections[0].chunks).toString().includes("<auth"), "the password never left");

  const wrongServer = await rawServer(t, (connection) => xmppServer(connection, { password: "another-password" }));
  const wrong = xmppChannel(wrongServer.port);
  await wrong.start(async () => undefined);
  t.after(() => wrong.stop());
  await until(() => wrong.health().state === "needs attention", "a refused password is reported");
  assert.match(wrong.health().reason, /did not accept the password/);
  assert.ok(!wrong.health().reason.includes(XMPP_PASSWORD));
  await delay(100);
  assert.equal(wrongServer.connections.length, 1, "a refused password is not tried again and again");
  await context.app.channels.attach(wrong, policy);
  await assertNoSecret(context, [XMPP_PASSWORD]);
});

test("XMPP settings: the server name is checked before anything opens, and the password is a secret name", async (t) => {
  await assert.rejects(() => buildParityChannel({ type: "xmpp", id: "x", jid: "branch@chat.example.org", ...policy },
    { credential: async () => "x", policy: blocked }), /Not allowed: chat.example.org/);
  await assert.rejects(() => buildParityChannel({ type: "xmpp", id: "x", jid: "branch@chat.example.org", server: "xmpp.example.net", ...policy },
    { credential: async () => "x", policy: blocked }), /Not allowed: xmpp.example.net/);
  await assert.rejects(() => buildParityChannel({ type: "xmpp", id: "x", jid: "branch@chat.example.org", password: "hunter2", ...policy },
    { credential: async () => "x" }), /password|Unrecognized/i, "a password value is never a setting");
  const asked = [];
  const opened = [];
  const channel = await buildParityChannel({ type: "xmpp", id: "x", jid: "branch@chat.example.org", ...policy },
    { credential: async (name) => { asked.push(name); return XMPP_PASSWORD; }, openSocket: localSocket(1, opened) });
  assert.deepEqual(asked, ["XMPP_PASSWORD"]);
  assert.equal(channel.kind, "xmpp");
  await channel.stop();
  assert.equal(opened.length, 0, "a switched-off service opens nothing");
});

// ---------------------------------------------------------------- Nostr cryptography

/** The official BIP-340 vectors (bitcoin/bips bip-0340/test-vectors.csv). */
const BIP340 = [
  [0, "0000000000000000000000000000000000000000000000000000000000000003", "F9308A019258C31049344F85F89D5229B531C845836F99B08601F113BCE036F9", "0000000000000000000000000000000000000000000000000000000000000000", "0000000000000000000000000000000000000000000000000000000000000000", "E907831F80848D1069A5371B402410364BDF1C5F8307B0084C55F1CE2DCA821525F66A4A85EA8B71E482A74F382D2CE5EBEEE8FDB2172F477DF4900D310536C0", true],
  [1, "B7E151628AED2A6ABF7158809CF4F3C762E7160F38B4DA56A784D9045190CFEF", "DFF1D77F2A671C5F36183726DB2341BE58FEAE1DA2DECED843240F7B502BA659", "0000000000000000000000000000000000000000000000000000000000000001", "243F6A8885A308D313198A2E03707344A4093822299F31D0082EFA98EC4E6C89", "6896BD60EEAE296DB48A229FF71DFE071BDE413E6D43F917DC8DCF8C78DE33418906D11AC976ABCCB20B091292BFF4EA897EFCB639EA871CFA95F6DE339E4B0A", true],
  [2, "C90FDAA22168C234C4C6628B80DC1CD129024E088A67CC74020BBEA63B14E5C9", "DD308AFEC5777E13121FA72B9CC1B7CC0139715309B086C960E18FD969774EB8", "C87AA53824B4D7AE2EB035A2B5BBBCCC080E76CDC6D1692C4B0B62D798E6D906", "7E2D58D8B3BCDF1ABADEC7829054F90DDA9805AAB56C77333024B9D0A508B75C", "5831AAEED7B44BB74E5EAB94BA9D4294C49BCF2A60728D8B4C200F50DD313C1BAB745879A5AD954A72C45A91C3A51D3C7ADEA98D82F8481E0E1E03674A6F3FB7", true],
  [3, "0B432B2677937381AEF05BB02A66ECD012773062CF3FA2549E44F58ED2401710", "25D1DFF95105F5253C4022F628A996AD3A0D95FBF21D468A1B33F8C160D8F517", "FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF", "FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF", "7EB0509757E246F19449885651611CB965ECC1A187DD51B64FDA1EDC9637D5EC97582B9CB13DB3933705B32BA982AF5AF25FD78881EBB32771FC5922EFC66EA3", true],
  [4, "", "D69C3509BB99E412E68B0FE8544E72837DFA30746D8BE2AA65975F29D22DC7B9", "", "4DF3C3F68FCC83B27E9D42C90431A72499F17875C81A599B566C9889B9696703", "00000000000000000000003B78CE563F89A0ED9414F5AA28AD0D96D6795F9C6376AFB1548AF603B3EB45C9F8207DEE1060CB71C04E80F593060B07D28308D7F4", true],
  [5, "", "EEFDEA4CDB677750A420FEE807EACF21EB9898AE79B9768766E4FAA04A2D4A34", "", "243F6A8885A308D313198A2E03707344A4093822299F31D0082EFA98EC4E6C89", "6CFF5C3BA86C69EA4B7376F31A9BCB4F74C1976089B2D9963DA2E5543E17776969E89B4C5564D00349106B8497785DD7D1D713A8AE82B32FA79D5F7FC407D39B", false],
  [6, "", "DFF1D77F2A671C5F36183726DB2341BE58FEAE1DA2DECED843240F7B502BA659", "", "243F6A8885A308D313198A2E03707344A4093822299F31D0082EFA98EC4E6C89", "FFF97BD5755EEEA420453A14355235D382F6472F8568A18B2F057A14602975563CC27944640AC607CD107AE10923D9EF7A73C643E166BE5EBEAFA34B1AC553E2", false],
  [7, "", "DFF1D77F2A671C5F36183726DB2341BE58FEAE1DA2DECED843240F7B502BA659", "", "243F6A8885A308D313198A2E03707344A4093822299F31D0082EFA98EC4E6C89", "1FA62E331EDBC21C394792D2AB1100A7B432B013DF3F6FF4F99FCB33E0E1515F28890B3EDB6E7189B630448B515CE4F8622A954CFE545735AAEA5134FCCDB2BD", false],
  [8, "", "DFF1D77F2A671C5F36183726DB2341BE58FEAE1DA2DECED843240F7B502BA659", "", "243F6A8885A308D313198A2E03707344A4093822299F31D0082EFA98EC4E6C89", "6CFF5C3BA86C69EA4B7376F31A9BCB4F74C1976089B2D9963DA2E5543E177769961764B3AA9B2FFCB6EF947B6887A226E8D7C93E00C5ED0C1834FF0D0C2E6DA6", false],
  [9, "", "DFF1D77F2A671C5F36183726DB2341BE58FEAE1DA2DECED843240F7B502BA659", "", "243F6A8885A308D313198A2E03707344A4093822299F31D0082EFA98EC4E6C89", "0000000000000000000000000000000000000000000000000000000000000000123DDA8328AF9C23A94C1FEECFD123BA4FB73476F0D594DCB65C6425BD186051", false],
  [10, "", "DFF1D77F2A671C5F36183726DB2341BE58FEAE1DA2DECED843240F7B502BA659", "", "243F6A8885A308D313198A2E03707344A4093822299F31D0082EFA98EC4E6C89", "00000000000000000000000000000000000000000000000000000000000000017615FBAF5AE28864013C099742DEADB4DBA87F11AC6754F93780D5A1837CF197", false],
  [11, "", "DFF1D77F2A671C5F36183726DB2341BE58FEAE1DA2DECED843240F7B502BA659", "", "243F6A8885A308D313198A2E03707344A4093822299F31D0082EFA98EC4E6C89", "4A298DACAE57395A15D0795DDBFD1DCB564DA82B0F269BC70A74F8220429BA1D69E89B4C5564D00349106B8497785DD7D1D713A8AE82B32FA79D5F7FC407D39B", false],
  [12, "", "DFF1D77F2A671C5F36183726DB2341BE58FEAE1DA2DECED843240F7B502BA659", "", "243F6A8885A308D313198A2E03707344A4093822299F31D0082EFA98EC4E6C89", "FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F69E89B4C5564D00349106B8497785DD7D1D713A8AE82B32FA79D5F7FC407D39B", false],
  [13, "", "DFF1D77F2A671C5F36183726DB2341BE58FEAE1DA2DECED843240F7B502BA659", "", "243F6A8885A308D313198A2E03707344A4093822299F31D0082EFA98EC4E6C89", "6CFF5C3BA86C69EA4B7376F31A9BCB4F74C1976089B2D9963DA2E5543E177769FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141", false],
  [14, "", "FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC30", "", "243F6A8885A308D313198A2E03707344A4093822299F31D0082EFA98EC4E6C89", "6CFF5C3BA86C69EA4B7376F31A9BCB4F74C1976089B2D9963DA2E5543E17776969E89B4C5564D00349106B8497785DD7D1D713A8AE82B32FA79D5F7FC407D39B", false],
];
const hex = (value) => Buffer.from(value, "hex");

test("Nostr: BIP-340 signing and verification match the official test vectors", () => {
  for (const [index, secret, publicKey, aux, message, signature, valid] of BIP340) {
    if (secret) {
      assert.equal(publicKeyOf(hex(secret)).toString("hex").toUpperCase(), publicKey, `vector ${index}: public key`);
      assert.equal(schnorrSign(hex(message), hex(secret), hex(aux)).toString("hex").toUpperCase(), signature, `vector ${index}: signature`);
    }
    assert.equal(schnorrVerify(hex(signature), hex(message), hex(publicKey)), valid, `vector ${index}: verification`);
  }
  assert.throws(() => publicKeyOf(Buffer.alloc(32)), /not a valid key/);
});

test("Nostr: NIP-04 messages round-trip between two keys, events verify, and an nsec key is read", () => {
  const alice = Buffer.alloc(32, 7), bob = Buffer.alloc(32, 9);
  const sealed = nip04Encrypt(alice, publicKeyOf(bob).toString("hex"), "meet at noon ✓");
  assert.match(sealed, /^[A-Za-z0-9+/=]+\?iv=[A-Za-z0-9+/=]{24}$/);
  assert.equal(nip04Decrypt(bob, publicKeyOf(alice).toString("hex"), sealed), "meet at noon ✓");
  // NIP-04 has no MAC: the wrong key passes the padding check about once in 256 (CI run 35453102759),
  // so what holds is that it never gives the message back, and that noise is refused as text.
  for (let i = 0; i < 2000; i++) {
    const again = nip04Encrypt(alice, publicKeyOf(bob).toString("hex"), "meet at noon ✓");
    let opened = null;
    try { opened = nip04Decrypt(bob, publicKeyOf(bob).toString("hex"), again); } catch { /* the usual outcome */ }
    assert.notEqual(opened, "meet at noon ✓", "the wrong key never reads the message");
    assert.ok(opened === null || !opened.includes("\uFFFD"), "undecodable bytes are refused, not turned into text");
  }
  const event = signEvent({ created_at: 1700000000, kind: 4, tags: [["p", "ab"]], content: "line\n\"quoted\"" }, alice);
  assert.equal(verifyEvent(event), true);
  assert.equal(verifyEvent({ ...event, content: "changed" }), false, "a changed event fails its id");
  assert.equal(verifyEvent({ ...event, sig: event.sig.replace(/^./, (c) => (c === "0" ? "1" : "0")) }), false, "a changed signature fails");
  // The NIP-19 example key.
  assert.equal(readPrivateKey("nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5").toString("hex"),
    "67dea2ed018072d675f5415ecfaed7d2597555e202d85b3d65ea4e58d2d92ffa");
  assert.throws(() => readPrivateKey("nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe6"), /not written correctly/);
});

// ---------------------------------------------------------------- MQTT

/** MQTT packets written independently of the adapter, the way the standard lays them out. */
const mq = {
  length(n) { const out = []; do { let b = n % 128; n = Math.floor(n / 128); if (n) b |= 128; out.push(b); } while (n); return Buffer.from(out); },
  str(value) { const bytes = Buffer.from(value); return Buffer.concat([Buffer.from([bytes.length >> 8, bytes.length & 255]), bytes]); },
  packet(first, body = Buffer.alloc(0)) { return Buffer.concat([Buffer.from([first]), mq.length(body.length), body]); },
  publish(topic, payload, { qos = 0, retain = false, id = 7 } = {}) {
    return mq.packet(0x30 | (qos << 1) | (retain ? 1 : 0),
      Buffer.concat([mq.str(topic), qos ? Buffer.from([id >> 8, id & 255]) : Buffer.alloc(0), Buffer.from(payload)]));
  },
};

/** Reads packets out of a byte stream (for the broker side). */
function mqttPackets(buffer) {
  const out = [];
  let at = 0;
  while (at < buffer.length) {
    let length = 0, i = 1, byte;
    do { if (at + i >= buffer.length) return { out, rest: buffer.subarray(at) }; byte = buffer[at + i]; length += (byte & 127) * 128 ** (i - 1); i++; } while (byte & 128);
    if (at + i + length > buffer.length) break;
    out.push({ type: buffer[at] >> 4, flags: buffer[at] & 15, body: buffer.subarray(at + i, at + i + length) });
    at += i + length;
  }
  return { out, rest: buffer.subarray(at) };
}

/**
 * A stand-in MQTT broker: checks the password on CONNECT, grants subscriptions, acknowledges
 * QoS 1, answers pings, and passes every publish on to subscribers of a matching topic (so the
 * assistant's own replies come back to it, as a real broker would do).
 */
function mqttBroker(connection, { password, refuse, retained } = {}) {
  const state = { connect: null, subscriptions: [], published: [], pings: 0, disconnected: false };
  connection.mqtt = state;
  let pending = Buffer.alloc(0);
  const matches = (filter, topic) => new RegExp(`^${filter.replace(/[.]/g, "\\.").replace(/\+/g, "[^/]+").replace(/\/?#$/, "(/.*)?")}$`).test(topic);
  connection.deliver = (topic, payload, options) => { if (state.subscriptions.some((f) => matches(f, topic))) connection.write(mq.publish(topic, payload, options)); };
  connection.onData = (chunk) => {
    const { out, rest } = mqttPackets(Buffer.concat([pending, chunk]));
    pending = rest;
    for (const p of out) {
      if (p.type === 1) {
        const body = p.body;
        const flags = body[7];
        let at = 10;
        const read = () => { const n = body.readUInt16BE(at); const v = body.subarray(at + 2, at + 2 + n).toString(); at += 2 + n; return v; };
        state.connect = { protocol: body.subarray(2, 6).toString(), level: body[6], flags, keepAlive: body.readUInt16BE(8), clientId: read() };
        if (flags & 128) state.connect.username = read();
        if (flags & 64) state.connect.password = read();
        const code = refuse ?? (password && state.connect.password !== password ? 4 : 0);
        connection.write(mq.packet(0x20, Buffer.from([0, code])));
      } else if (p.type === 8) {
        const filter = p.body.subarray(4, 4 + p.body.readUInt16BE(2)).toString();
        state.subscriptions.push(filter);
        state.subscribeFlags = p.flags;
        connection.write(mq.packet(0x90, Buffer.from([p.body[0], p.body[1], 1])));
        if (retained) connection.write(mq.publish(retained.topic, retained.payload, { retain: true }));
      } else if (p.type === 3) {
        const n = p.body.readUInt16BE(0);
        const topic = p.body.subarray(2, 2 + n).toString();
        const qos = (p.flags >> 1) & 3;
        const payload = p.body.subarray(2 + n + (qos ? 2 : 0)).toString();
        state.published.push({ topic, qos, payload: JSON.parse(payload) });
        if (qos) connection.write(mq.packet(0x40, p.body.subarray(2 + n, 4 + n)));
        connection.deliver(topic, payload);
      } else if (p.type === 12) { state.pings++; connection.write(mq.packet(0xd0)); }
      else if (p.type === 14) state.disconnected = true;
    }
  };
}

function mqttChannel(port, extra = {}) {
  return new MqttChannel({ id: "mqtt", host: "broker.example.org", port, tls: false, open: localSocket(port), clientId: "branch",
    username: "assistant", password: MQTT_PASSWORD, inboundTopic: "chat/in/#", replyTopic: "chat/in/{chat}", qos: 1, retryBaseMs: 20, ...extra });
}

test("MQTT: the remaining length is written as the standard's examples show", () => {
  assert.deepEqual([...encodeLength(0)], [0]);
  assert.deepEqual([...encodeLength(127)], [0x7f]);
  assert.deepEqual([...encodeLength(128)], [0x80, 0x01]);
  assert.deepEqual([...encodeLength(16383)], [0xff, 0x7f]);
  assert.deepEqual([...encodeLength(2097152)], [0x80, 0x80, 0x80, 0x01]);
  assert.deepEqual([...encodeLength(268435455)], [0xff, 0xff, 0xff, 0x7f]);
  assert.throws(() => replyTopicFor("out/{chat}", "a/+"), /cannot be used/);
  assert.throws(() => replyTopicFor("out/{chat}", "#"), /cannot be used/);
  assert.throws(() => replyTopicFor("out/{chat}", "a\0b"), /cannot be used/);
  assert.equal(replyTopicFor("out/{chat}/reply", "kitchen"), "out/kitchen/reply");
});

test("MQTT: connects with the password, pairs a stranger, answers on the reply topic, and never answers itself or history", async (t) => {
  const context = await fixture(t);
  const broker = await rawServer(t, (connection) => mqttBroker(connection, { password: MQTT_PASSWORD,
    retained: { topic: "chat/in/old", payload: JSON.stringify({ from: "olga", text: "a retained question from before" }) } }));
  const channel = mqttChannel(broker.port);
  await context.app.channels.attach(channel, policy);
  t.after(() => channel.stop());
  await until(() => broker.connections[0]?.mqtt.subscriptions.length, "subscribed");
  const link = broker.connections[0];
  assert.deepEqual({ ...link.mqtt.connect }, { protocol: "MQTT", level: 4, flags: 0xc2, keepAlive: 60, clientId: "branch", username: "assistant", password: MQTT_PASSWORD });
  assert.deepEqual(link.mqtt.subscriptions, ["chat/in/#"]);
  assert.equal(link.mqtt.subscribeFlags, 2, "SUBSCRIBE carries the flags the standard requires");
  assert.equal(channel.health().state, "connected");
  await delay(80);
  assert.equal(context.provider.requests.length, 0, "the retained message is not answered");
  assert.equal(link.mqtt.published.length, 0);

  // Each message is sent one byte at a time, so every packet arrives split.
  const say = async (text) => {
    const bytes = mq.publish("chat/in/erin", JSON.stringify({ from: "erin", text }), { qos: 1, id: 300 });
    for (const byte of bytes) link.write(Buffer.from([byte]));
  };
  const texts = () => link.mqtt.published.map((p) => p.payload.text);
  await pairingWalk(context, { label: "MQTT", say, sent: texts });
  const reply = link.mqtt.published.at(-1);
  assert.equal(reply.topic, "chat/in/erin");
  assert.equal(reply.qos, 1);
  assert.deepEqual(Object.keys(reply.payload), ["from", "chat", "text"]);
  assert.equal(reply.payload.from, "branch");
  assert.equal(reply.payload.chat, "erin");
  assert.ok(Buffer.concat(link.chunks).includes(Buffer.from([0x40, 0x02, 0x01, 0x2c])), "the QoS 1 message was acknowledged (PUBACK 300)");

  // The replies came back through the broker (same topic tree) and were not answered.
  const asked = context.provider.requests.length;
  await delay(120);
  assert.equal(context.provider.requests.length, asked, "its own replies are never answered");
  const published = link.mqtt.published.length;

  // In a shared chat, only a message naming the assistant is answered, and the answer goes to that chat.
  link.write(mq.publish("chat/in/kitchen", JSON.stringify({ from: "erin", chat: "kitchen", text: "who ate the cake" })));
  await delay(100);
  assert.equal(link.mqtt.published.length, published, "an unaddressed shared message is left alone");
  link.write(mq.publish("chat/in/kitchen", JSON.stringify({ from: "erin", chat: "kitchen", text: "@branch what is for dinner" })));
  await until(() => link.mqtt.published.some((p) => p.topic === "chat/in/kitchen" && /Echo:.*what is for dinner/.test(p.payload.text)), "answered in the shared chat");
  await assert.rejects(() => channel.send("room/#", "x"), /cannot be used/);
  await assertNoSecret(context, [MQTT_PASSWORD]);
});

test("MQTT: a stranger is refused when pairing is off, and plain words come from the configured sender", async (t) => {
  const context = await fixture(t);
  const broker = await rawServer(t, (connection) => mqttBroker(connection, {}));
  const channel = mqttChannel(broker.port, { username: undefined, password: undefined, plainTextSender: "doorbell", qos: 0 });
  await context.app.channels.attach(channel, { activation: "mention", pairing: false, allowlist: [] });
  t.after(() => channel.stop());
  await until(() => broker.connections[0]?.mqtt.subscriptions.length, "subscribed");
  const link = broker.connections[0];
  assert.equal(link.mqtt.connect.flags, 0x02, "no user name or password flags without an account");
  await refusalWalk(context, { label: "MQTT", sent: () => link.mqtt.published.map((p) => p.payload.text),
    say: async (text) => link.write(mq.publish("chat/in/door", text)) });
  await assertNoSecret(context, [MQTT_PASSWORD]);
});

test("MQTT: a refused password is said plainly and not retried; a dropped connection is opened again; pings keep it alive", async (t) => {
  const context = await fixture(t);
  const wrong = await rawServer(t, (connection) => mqttBroker(connection, { password: "another" }));
  const refused = mqttChannel(wrong.port);
  await refused.start(async () => undefined);
  t.after(() => refused.stop());
  await until(() => refused.health().state === "needs attention", "the refusal is reported");
  assert.match(refused.health().reason, /did not accept the user name or password/);
  assert.ok(!refused.health().reason.includes(MQTT_PASSWORD));
  await delay(100);
  assert.equal(wrong.connections.length, 1, "not retried");

  // Pings, on a keep-alive short enough to see several. A ping still unanswered when the next is due
  // closes the link, and on a busy build machine 50 ms can pass before an answer is read, so the
  // link may be opened again here; what is held is that pings go out, are answered, and it is up.
  const pinged = await rawServer(t, (connection) => mqttBroker(connection, { password: MQTT_PASSWORD }));
  const pinging = mqttChannel(pinged.port, { keepAliveSeconds: 0.05 });
  await pinging.start(async () => undefined);
  t.after(() => pinging.stop());
  await until(() => pinged.connections.some((link) => link.mqtt.pings >= 2), "pings answered");
  await until(() => pinging.health().state === "connected", "connected while pinging");
  await pinging.stop();

  // Dropping and saying goodbye, on the usual keep-alive, so no ping can open a third link and the
  // goodbye is owed to exactly the second one.
  const flaky = await rawServer(t, (connection) => mqttBroker(connection, { password: MQTT_PASSWORD }));
  const channel = mqttChannel(flaky.port);
  await channel.start(async () => undefined);
  t.after(() => channel.stop());
  await until(() => flaky.connections[0]?.mqtt.subscriptions.length, "subscribed");
  assert.equal(channel.health().state, "connected");
  flaky.connections[0].socket.destroy();
  await until(() => flaky.connections[1]?.mqtt.subscriptions.length, "reconnected and subscribed again");
  await channel.stop();
  await until(() => flaky.connections[1].mqtt.disconnected, "says goodbye with DISCONNECT");
  assert.equal(flaky.connections.length, 2, "one drop, one new link");
  await context.app.channels.attach(refused, policy);
  await assertNoSecret(context, [MQTT_PASSWORD]);
});

test("MQTT settings: the broker is checked before anything opens, and wildcards never reach a reply topic", async () => {
  await assert.rejects(() => buildParityChannel({ type: "mqtt", id: "m", host: "mqtt.example.org", inboundTopic: "a/#", replyTopic: "b/{chat}", ...policy },
    { credential: async () => "x", policy: blocked }), /Not allowed: mqtt.example.org/);
  await assert.rejects(() => buildParityChannel({ type: "mqtt", id: "m", host: "mqtt.example.org", inboundTopic: "a/#", replyTopic: "b/#", ...policy },
    { credential: async () => "x" }), /cannot contain \+ or #/);
  const asked = [];
  const channel = await buildParityChannel({ type: "mqtt", id: "m", host: "mqtt.example.org", username: "bot", inboundTopic: "a/#", replyTopic: "b/{chat}", ...policy },
    { credential: async (name) => { asked.push(name); return MQTT_PASSWORD; } });
  assert.deepEqual(asked, ["MQTT_PASSWORD"]);
  assert.equal(channel.kind, "mqtt");
  await channel.stop();
});

// ---------------------------------------------------------------- Local programs (Keybase, Delta Chat)

/** A stand-in for a started program: its output is written by the test, its input is recorded. */
function fakeProgram() {
  const started = [];
  const starter = (file, args, env) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stdin = new PassThrough();
    child.input = [];
    let pending = "";
    child.stdin.on("data", (chunk) => {
      pending += chunk.toString();
      let at;
      while ((at = pending.indexOf("\n")) >= 0) { const line = pending.slice(0, at); pending = pending.slice(at + 1); child.input.push(JSON.parse(line)); child.onInput?.(JSON.parse(line)); }
    });
    child.killed = false;
    child.kill = () => { child.killed = true; child.emit("exit", null); };
    child.say = (value) => child.stdout.write(`${typeof value === "string" ? value : JSON.stringify(value)}\n`);
    started.push({ file, args, env, child });
    starter.onStart?.(child);
    return child;
  };
  return { started, starter };
}

// ---------------------------------------------------------------- Keybase

const KEYBASE = "/opt/keybase/bin/keybase";
function fakeKeybase({ user = "branchbot" } = {}) {
  const runs = [];
  const run = async (file, args) => {
    runs.push({ file, args });
    if (args[0] === "whoami") return { stdout: user ? `${user}\n` : "", stderr: "" };
    if (args[0] === "chat" && args[1] === "api") return { stdout: JSON.stringify({ result: { message: "message sent", id: 100 + runs.length } }), stderr: "" };
    throw new Error("unexpected command");
  };
  const sent = () => runs.filter((r) => r.args[1] === "api").map((r) => JSON.parse(r.args[3]));
  return { runs, run, sent };
}
let keybaseMessageId = 1;
function keybaseMessage({ from = "alice", uid = "a1b2c3d4e5f60718293a4b5c6d7e8f90", conversation = "c0ffee".repeat(10) + "abcd", channel = { name: "alice,branchbot", members_type: "impteamnative" }, text }) {
  return { type: "chat", source: "remote", msg: { id: keybaseMessageId++, conversation_id: conversation, channel, sender: { uid, username: from, device_name: "phone" },
    sent_at: 1700000000, content: { type: "text", text: { body: text } }, unread: true } };
}

test("Keybase: checks the program, pairs a stranger from api-listen, answers through chat api arguments, and ignores itself", async (t) => {
  const context = await fixture(t);
  const keybase = fakeKeybase();
  const program = fakeProgram();
  const channel = new KeybaseChannel({ id: "keybase", path: KEYBASE, run: keybase.run, startProcess: program.starter, exists: async (path) => path === KEYBASE });
  await context.app.channels.attach(channel, policy);
  t.after(() => channel.stop());
  await until(() => program.started.length === 1, "api-listen started");
  assert.deepEqual(program.started[0].args, ["chat", "api-listen"]);
  assert.equal(program.started[0].file, KEYBASE);
  assert.deepEqual(keybase.runs[0], { file: KEYBASE, args: ["whoami"] });
  assert.equal(channel.botName(), "branchbot");
  const listen = program.started[0].child;
  const texts = () => keybase.sent().map((request) => request.params.options.message.body);
  await pairingWalk(context, { label: "Keybase", sent: texts, say: async (text) => listen.say(keybaseMessage({ text })) });
  const last = keybase.sent().at(-1);
  assert.deepEqual(Object.keys(last), ["method", "params"]);
  assert.equal(last.method, "send");
  assert.equal(last.params.options.conversation_id, "c0ffee".repeat(10) + "abcd", "answered in the conversation it came from");
  assert.deepEqual(keybase.runs.at(-1).args.slice(0, 3), ["chat", "api", "-m"]);
  assert.ok(context.app.channels.summary().approved.some((p) => p.senderId === "a1b2c3d4e5f60718293a4b5c6d7e8f90"), "the stable user id was approved");

  const asked = context.provider.requests.length;
  listen.say(keybaseMessage({ from: "branchbot", uid: "ffff", text: "my own reply" }));
  listen.say("not json at all");
  // A team channel is only answered when the assistant is mentioned.
  const team = { name: "acme", members_type: "team", topic_name: "general" };
  listen.say(keybaseMessage({ channel: team, conversation: "team-conv", text: "standup at ten" }));
  await delay(120);
  assert.equal(context.provider.requests.length, asked, "its own message, junk and unaddressed team talk are left alone");
  listen.say(keybaseMessage({ channel: team, conversation: "team-conv", text: "@branchbot what is on today" }));
  await until(() => keybase.sent().some((r) => r.params.options.conversation_id === "team-conv" && /Echo:.*what is on today/.test(r.params.options.message.body)), "answered in the team channel");

  // A dropped listener is started again.
  listen.emit("exit", 1);
  await until(() => program.started.length === 2, "api-listen restarted", 400);
});

test("Keybase: a stranger is refused when pairing is off; a missing program or sign-in is said plainly", async (t) => {
  const context = await fixture(t);
  const keybase = fakeKeybase();
  const program = fakeProgram();
  const channel = new KeybaseChannel({ id: "keybase", path: KEYBASE, run: keybase.run, startProcess: program.starter, exists: async () => true });
  await context.app.channels.attach(channel, { activation: "mention", pairing: false, allowlist: [] });
  t.after(() => channel.stop());
  await until(() => program.started.length === 1, "api-listen started");
  await refusalWalk(context, { label: "Keybase", sent: () => keybase.sent().map((r) => r.params.options.message.body),
    say: async (text) => program.started[0].child.say(keybaseMessage({ from: "mallory", uid: "0badc0de", text })) });

  const missing = fakeProgram();
  const absent = new KeybaseChannel({ id: "k2", path: "/nowhere/keybase", run: keybase.run, startProcess: missing.starter, exists: async () => false });
  await assert.rejects(() => absent.start(async () => undefined), /nothing at \/nowhere\/keybase/);
  assert.equal(absent.health().state, "needs attention");
  assert.equal(missing.started.length, 0, "nothing was run");
  const signedOut = new KeybaseChannel({ id: "k3", path: KEYBASE, run: fakeKeybase({ user: "" }).run, startProcess: missing.starter, exists: async () => true });
  await assert.rejects(() => signedOut.start(async () => undefined), /not signed in/);
  assert.match(signedOut.health().reason, /sign in/);
  assert.equal(missing.started.length, 0);
  await assertNoSecret(context, []);
});

test("Keybase settings: only a full program path, and building runs nothing", async () => {
  await assert.rejects(() => buildParityChannel({ type: "keybase", id: "k", path: "keybase", ...policy }, { credential: async () => "x" }), /full path/);
  await assert.rejects(() => buildParityChannel({ type: "keybase", id: "k", path: "/usr/local/bin/keybase", paperKey: "x", ...policy }, { credential: async () => "x" }), /paperKey|Unrecognized/);
  const channel = await buildParityChannel({ type: "keybase", id: "k", path: "/usr/local/bin/keybase", ...policy }, { credential: async () => "x", policy: blocked });
  assert.equal(channel.kind, "keybase");
  await channel.stop();
});

// ---------------------------------------------------------------- SimpleX

/** A stand-in simplex-chat API: answers /user and /_send, and lets the test push new messages. */
function simplexProgram(connection, { name = "Branch Bot" } = {}) {
  connection.sends = [];
  let item = 900;
  connection.onMessage = ({ corrId, cmd }) => {
    if (cmd === "/user") { connection.send({ corrId, resp: { type: "activeUser", user: { userId: 1, localDisplayName: name, profile: { displayName: name } } } }); return; }
    const match = /^\/_send ([@#])(\d+) json (.*)$/s.exec(cmd);
    if (!match) { connection.send({ corrId, resp: { type: "chatCmdError", chatError: { type: "error" } } }); return; }
    const [, kind, chatId, json] = match;
    const [message] = JSON.parse(json);
    connection.sends.push({ ref: `${kind}${chatId}`, text: message.msgContent.text, message });
    const chatInfo = kind === "@" ? { type: "direct", contact: { contactId: Number(chatId), localDisplayName: "x" } } : { type: "group", groupInfo: { groupId: Number(chatId) } };
    const sentItem = { chatInfo, chatItem: { chatDir: { type: kind === "@" ? "directSnd" : "groupSnd" }, meta: { itemId: ++item }, content: { type: "sndMsgContent", msgContent: message.msgContent } } };
    connection.send({ corrId, resp: { type: "newChatItems", user: {}, chatItems: [sentItem] } });
    // A real program also tells every client about the new item; it must not be answered.
    connection.send({ resp: { type: "newChatItems", user: {}, chatItems: [sentItem] } });
  };
  connection.direct = (contactId, text, displayName = "Frank Ocean") => connection.send({ resp: { type: "newChatItems", user: {}, chatItems: [{
    chatInfo: { type: "direct", contact: { contactId, localDisplayName: displayName, profile: { displayName } } },
    chatItem: { chatDir: { type: "directRcv" }, meta: { itemId: ++item, userMention: false }, content: { type: "rcvMsgContent", msgContent: { type: "text", text } } },
  }] } });
  connection.group = (groupId, text, { mention = false, memberId = "bWVtYmVyLTE=" } = {}) => connection.send({ resp: { type: "newChatItems", user: {}, chatItems: [{
    chatInfo: { type: "group", groupInfo: { groupId, localDisplayName: "Book Club" } },
    chatItem: { chatDir: { type: "groupRcv", groupMember: { memberId, localDisplayName: "gina" } }, meta: { itemId: ++item, userMention: mention },
      content: { type: "rcvMsgContent", msgContent: { type: "text", text } } },
  }] } });
}

test("SimpleX: pairs a stranger from newChatItems, answers with /_send by chat number, and never answers its own items", async (t) => {
  const context = await fixture(t);
  const program = await socketService(t, (connection) => simplexProgram(connection));
  const channel = new SimplexChannel({ id: "simplex", address: program.url, connect: connectWebSocket, retryBaseMs: 20 });
  await context.app.channels.attach(channel, policy);
  t.after(() => channel.stop());
  const link = await until(() => program.connections[0], "connected");
  await until(() => channel.botName() === "Branch Bot", "learned its own name");
  assert.equal(link.received[0].cmd, "/user");
  assert.match(link.received[0].corrId, /^branch-/);

  await pairingWalk(context, { label: "SimpleX", sent: () => link.sends.map((s) => s.text), say: async (text) => link.direct(5, text) });
  const last = link.sends.at(-1);
  assert.equal(last.ref, "@5", "answered in the contact's chat, by number");
  assert.deepEqual(link.received.at(-1).cmd.startsWith("/_send @5 json "), true);
  assert.ok(context.app.channels.summary().approved.some((p) => p.senderId === "contact:5"));

  // A group: plain talk is ignored; a mention (marked by the program, or by name with a space in it) is answered in the group.
  const asked = context.provider.requests.length;
  link.group(3, "anyone read chapter two?");
  await delay(120);
  assert.equal(context.provider.requests.length, asked, "its own echoed items and unaddressed group talk are left alone");
  const waiting = context.app.channels.summary().pending.length;
  link.group(3, "@Branch Bot summarise chapter one");
  // UP-CHAT-007: a new group member is not answered and not sent a code in the group; the request waits for the owner.
  await until(() => context.app.channels.summary().pending.length > waiting, "a mention from a new group member waits for the owner");
  assert.ok(!link.sends.some((s) => s.ref === "#3"), "no code is posted in the group");

  // Quotes and newlines in a reply stay inside the JSON.
  await channel.send("@5", "it's \"quoted\"\nand on two lines");
  await until(() => link.sends.at(-1).text === "it's \"quoted\"\nand on two lines", "sent verbatim");
  await assert.rejects(() => channel.send("@5 json []\n/_delete", "x"), /not a SimpleX chat/);
  await assertNoSecret(context, []);
});

test("SimpleX: a stranger is refused when pairing is off, and a lost program is reconnected", async (t) => {
  const context = await fixture(t);
  const program = await socketService(t, (connection) => simplexProgram(connection));
  const channel = new SimplexChannel({ id: "simplex", address: program.url, connect: connectWebSocket, retryBaseMs: 20 });
  await context.app.channels.attach(channel, { activation: "mention", pairing: false, allowlist: [] });
  t.after(() => channel.stop());
  const link = await until(() => program.connections[0], "connected");
  await refusalWalk(context, { label: "SimpleX", sent: () => link.sends.map((s) => s.text), say: async (text) => link.direct(9, text, "Stranger") });
  link.socket.destroy();
  await until(() => program.connections[1], "connected again");
  await until(() => channel.health().state === "connected", "healthy again");
  await assertNoSecret(context, []);
});

test("SimpleX settings: only this computer unless allowed, and the address is checked", async () => {
  await assert.rejects(() => buildParityChannel({ type: "simplex", id: "s", address: "ws://chat.example.org:5225", ...policy }, { credential: async () => "x" }),
    /only connects to it on this computer/);
  await assert.rejects(() => buildParityChannel({ type: "simplex", id: "s", address: "ws://chat.example.org:5225", allowRemote: true, ...policy },
    { credential: async () => "x", policy: blocked }), /Not allowed: chat.example.org/);
  const channel = await buildParityChannel({ type: "simplex", id: "s", ...policy }, { credential: async () => "x" });
  assert.equal(channel.kind, "simplex");
  await channel.stop();
});

// ---------------------------------------------------------------- Delta Chat

const DELTACHAT = "/opt/deltachat/deltachat-rpc-server";
const NOW = 1_800_000_000;

/**
 * A stand-in deltachat-rpc-server: answers JSON-RPC calls from its own small store of chats and
 * messages, and holds `get_next_event` until the test has an event to hand out.
 */
function deltaProgram(program, { configured = true, accounts = [1] } = {}) {
  const state = { messages: new Map(), chats: new Map([[10, { id: 10, name: "Hana", chatType: "Single" }], [20, { id: 20, name: "Garden club", chatType: "Group" }],
    [30, { id: 30, name: "Device messages", chatType: "Single", isDeviceChat: true }]]), sent: [], events: [], waiters: [], nextId: 500 };
  const push = (event) => { const waiter = state.waiters.shift(); if (waiter) waiter(event); else state.events.push(event); };
  state.incoming = ({ chatId = 10, fromId = 12, address = "hana@chat.example", text, timestamp = NOW + 5, isInfo = false, account = 1 }) => {
    const id = state.nextId++;
    state.messages.set(id, { id, chatId, fromId, text, timestamp, isInfo, sender: { address, displayName: address.split("@")[0] } });
    push({ contextId: account, event: { kind: "IncomingMsg", chatId, msgId: id } });
  };
  state.other = () => push({ contextId: 1, event: { kind: "Info", msg: "connected" } });
  program.starter.onStart = (child) => {
    state.child = child;
    child.onInput = ({ id, method, params }) => {
      const reply = (result) => child.say({ jsonrpc: "2.0", id, result });
      switch (method) {
        case "get_all_account_ids": return reply(accounts);
        case "is_configured": return reply(configured);
        case "get_config": return reply(params[1] === "addr" ? "Branch@Chat.Example" : params[1] === "displayname" ? "branch" : null);
        case "start_io": return reply(null);
        case "get_next_event": { const next = state.events.shift(); if (next) reply(next); else state.waiters.push(reply); return; }
        case "get_message": return reply(state.messages.get(params[1]));
        case "get_basic_chat_info": return state.chats.has(params[1]) ? reply(state.chats.get(params[1]))
          : child.say({ jsonrpc: "2.0", id, error: { code: -1, message: "no such chat" } });
        case "misc_send_text_message": state.sent.push({ account: params[0], chatId: params[1], text: params[2] }); return reply(state.nextId++);
        default: return child.say({ jsonrpc: "2.0", id, error: { code: -32601, message: "unknown method" } });
      }
    };
  };
  return state;
}

function deltaChannel(program, extra = {}) {
  return new DeltaChatChannel({ id: "deltachat", path: DELTACHAT, startProcess: program.starter, exists: async (path) => path === DELTACHAT,
    now: () => NOW * 1000, retryBaseMs: 20, accountsPath: "/tmp/dc-accounts", ...extra });
}

test("Delta Chat: JSON-RPC over the program's input and output, pairs a stranger, answers in their chat, and skips history and itself", async (t) => {
  const context = await fixture(t);
  const program = fakeProgram();
  const delta = deltaProgram(program);
  const channel = deltaChannel(program);
  await context.app.channels.attach(channel, policy);
  t.after(() => channel.stop());
  await until(() => channel.health().state === "connected", "the account is running");
  assert.equal(program.started[0].file, DELTACHAT);
  assert.deepEqual(program.started[0].args, []);
  assert.deepEqual(program.started[0].env, { DC_ACCOUNTS_PATH: "/tmp/dc-accounts" });
  const input = program.started[0].child.input;
  assert.deepEqual(input.slice(0, 5).map((c) => c.method), ["get_all_account_ids", "is_configured", "get_config", "get_config", "start_io"]);
  assert.ok(input.every((c) => c.jsonrpc === "2.0" && Array.isArray(c.params)));

  // History, the account's own messages, info lines and the device chat are left alone.
  delta.incoming({ text: "an old message", timestamp: NOW - 3600 });
  delta.incoming({ text: "sent from my other device", fromId: 1 });
  delta.incoming({ text: "echo of my address", address: "branch@chat.example", fromId: 40 });
  delta.incoming({ text: "Hana joined", isInfo: true });
  delta.incoming({ chatId: 30, text: "welcome to Delta Chat" });
  delta.other();
  await delay(120);
  assert.equal(context.provider.requests.length, 0);
  assert.equal(delta.sent.length, 0);

  const texts = () => delta.sent.map((s) => s.text);
  await pairingWalk(context, { label: "Delta Chat", sent: texts, say: async (text) => delta.incoming({ text }) });
  assert.deepEqual({ account: delta.sent.at(-1).account, chatId: delta.sent.at(-1).chatId }, { account: 1, chatId: 10 }, "answered in Hana's chat");
  assert.ok(context.app.channels.summary().approved.some((p) => p.senderId === "hana@chat.example"));

  // A group is answered only when the assistant is named.
  const asked = context.provider.requests.length;
  delta.incoming({ chatId: 20, text: "the tomatoes are in" });
  await delay(120);
  assert.equal(context.provider.requests.length, asked);
  delta.incoming({ chatId: 20, text: "@branch when do we water" });
  await until(() => delta.sent.some((s) => s.chatId === 20 && /Echo:.*when do we water/.test(s.text)), "answered in the group");
  await assert.rejects(() => channel.send("10; rm", "x"), /not a Delta Chat chat/);
});

test("Delta Chat: a stranger is refused when pairing is off; a missing program or account is said plainly; a stopped program is started again", async (t) => {
  const context = await fixture(t);
  const program = fakeProgram();
  const delta = deltaProgram(program);
  const channel = deltaChannel(program);
  await context.app.channels.attach(channel, { activation: "mention", pairing: false, allowlist: [] });
  t.after(() => channel.stop());
  await until(() => channel.health().state === "connected", "running");
  await refusalWalk(context, { label: "Delta Chat", sent: () => delta.sent.map((s) => s.text),
    say: async (text) => delta.incoming({ text, address: "mallory@evil.example" }) });
  program.started[0].child.emit("exit", 1);
  await until(() => program.started.length === 2, "started again");
  await until(() => channel.health().state === "connected", "running again");

  const none = fakeProgram();
  const absent = new DeltaChatChannel({ id: "d2", path: "/nowhere/deltachat-rpc-server", startProcess: none.starter, exists: async () => false });
  await assert.rejects(() => absent.start(async () => undefined), /nothing at \/nowhere/);
  assert.equal(none.started.length, 0, "nothing was run");
  const empty = fakeProgram();
  deltaProgram(empty, { accounts: [] });
  const noAccount = deltaChannel(empty);
  await noAccount.start(async () => undefined);
  t.after(() => noAccount.stop());
  await until(() => noAccount.health().state === "needs attention", "no account");
  assert.match(noAccount.health().reason, /no account/);
  const unset = fakeProgram();
  deltaProgram(unset, { configured: false });
  const notReady = deltaChannel(unset);
  await notReady.start(async () => undefined);
  t.after(() => notReady.stop());
  await until(() => notReady.health().state === "needs attention", "not configured");
  assert.match(notReady.health().reason, /not set up yet/);
  await assertNoSecret(context, []);
});

test("Delta Chat settings: only full paths, and building runs nothing", async () => {
  await assert.rejects(() => buildParityChannel({ type: "deltachat", id: "d", path: "deltachat-rpc-server", ...policy }, { credential: async () => "x" }), /full path/);
  await assert.rejects(() => buildParityChannel({ type: "deltachat", id: "d", path: "/usr/bin/deltachat-rpc-server", password: "x", ...policy }, { credential: async () => "x" }), /password|Unrecognized/);
  const channel = await buildParityChannel({ type: "deltachat", id: "d", path: "/usr/bin/deltachat-rpc-server", accountId: 2, ...policy }, { credential: async () => "x", policy: blocked });
  assert.equal(channel.kind, "deltachat");
  await channel.stop();
});

// ---------------------------------------------------------------- Nostr

/** A stand-in relay: records subscriptions and published events, and says OK to each event. */
function nostrRelay(connection) {
  connection.published = [];
  connection.onMessage = (frame) => {
    if (frame[0] === "REQ") connection.filter = frame[2];
    if (frame[0] === "EVENT") { connection.published.push(frame[1]); connection.send(["OK", frame[1].id, true, ""]); }
  };
}
const STRANGER = Buffer.alloc(32, 0x11);
const STRANGER_PUB = publicKeyOf(STRANGER).toString("hex");
const nowSeconds = () => Math.floor(Date.now() / 1000);

function directMessage(from, toPublicKey, text, { createdAt = nowSeconds(), tagged = toPublicKey } = {}) {
  return signEvent({ created_at: createdAt, kind: 4, tags: [["p", tagged]], content: nip04Encrypt(from, toPublicKey, text) }, from);
}

/** What the assistant published, checked and opened the way the stranger's own client would. */
function repliesTo(relay, assistantPub, secret = STRANGER, publicKey = STRANGER_PUB) {
  return relay.published.map((event) => {
    assert.equal(verifyEvent(event), true, "every reply is correctly signed");
    assert.equal(event.pubkey, assistantPub);
    assert.equal(event.kind, 4);
    assert.deepEqual(event.tags[0], ["p", publicKey], "addressed to the person who wrote");
    return nip04Decrypt(secret, assistantPub, event.content);
  });
}

async function nostrSetup(t, context, attachPolicy) {
  const relayA = await socketService(t, nostrRelay);
  const relayB = await socketService(t, nostrRelay);
  const channel = await buildParityChannel({ type: "nostr", id: "nostr", relays: [relayA.url, relayB.url], ...attachPolicy },
    { credential: async (name) => { assert.equal(name, "NOSTR_PRIVATE_KEY"); return NOSTR_KEY; },
      store: context.app.store, owner: context.app.runtime.owner, connectWs: connectWebSocket });
  setSwitch(context.app, "nostr", "on");
  await context.app.channels.attach(channel, attachPolicy);
  t.after(() => channel.stop());
  const a = await until(() => relayA.connections[0]?.filter && relayA.connections[0], "relay A asked");
  const b = await until(() => relayB.connections[0]?.filter && relayB.connections[0], "relay B asked");
  return { channel, a, b, relayA, relayB };
}

test("Nostr: a stranger's encrypted DM is paired, then answered with an encrypted, correctly signed reply", async (t) => {
  const context = await fixture(t);
  const assistantPub = publicKeyOf(Buffer.from(NOSTR_KEY, "hex")).toString("hex");
  const before = nowSeconds();
  const { a, b } = await nostrSetup(t, context, policy);
  assert.deepEqual(a.filter.kinds, [4]);
  assert.deepEqual(a.filter["#p"], [assistantPub]);
  assert.ok(a.filter.since >= before && a.filter.since <= nowSeconds(), "only messages from now on are asked for");

  // Stored events a relay replays: older than the start, forged, not for us, or from itself.
  a.send(["EVENT", "branch-dm", directMessage(STRANGER, assistantPub, "an old message", { createdAt: before - 600 })]);
  const forged = directMessage(STRANGER, assistantPub, "forged");
  a.send(["EVENT", "branch-dm", { ...forged, sig: directMessage(STRANGER, assistantPub, "other").sig }]);
  a.send(["EVENT", "branch-dm", { ...forged, content: nip04Encrypt(STRANGER, assistantPub, "tampered") }]);
  a.send(["EVENT", "branch-dm", directMessage(STRANGER, assistantPub, "for someone else", { tagged: STRANGER_PUB })]);
  a.send(["EVENT", "branch-dm", directMessage(Buffer.from(NOSTR_KEY, "hex"), assistantPub, "from myself")]);
  a.send(["EVENT", "branch-dm", { ...directMessage(STRANGER, assistantPub, "x"), kind: 1 }]);
  a.send("not json");
  await delay(400);
  assert.equal(context.provider.requests.length, 0);
  assert.equal(a.published.length, 0, "none of them got an answer");

  // Every message arrives from both relays, and is handled once.
  const say = async (text) => {
    const event = directMessage(STRANGER, assistantPub, text);
    a.send(["EVENT", "branch-dm", event]);
    b.send(["EVENT", "branch-dm", event]);
  };
  const sent = () => repliesTo(a, assistantPub);
  await pairingWalk(context, { label: "Nostr", say, sent });
  await delay(200);
  assert.equal(a.published.length, 2, "one pairing offer and one answer, not one per relay");
  assert.deepEqual(b.published.map((e) => e.id), a.published.map((e) => e.id), "each reply goes to every relay");
  assert.ok(context.app.channels.summary().approved.some((p) => p.senderId === STRANGER_PUB), "the sender is their public key");
  const answer = a.published.at(-1);
  assert.ok(answer.tags.some((tag) => tag[0] === "e"), "the answer points at the message it answers");
  assert.ok(!answer.content.includes("what is the time"), "the reply travels encrypted");

  // Its own reply, echoed by a relay, is never answered.
  const asked = context.provider.requests.length;
  a.send(["EVENT", "branch-dm", answer]);
  await delay(200);
  assert.equal(context.provider.requests.length, asked);
  await assertNoSecret(context, [NOSTR_KEY]);
});

test("Nostr: a stranger is refused when pairing is off, and a lost relay is reconnected", async (t) => {
  const context = await fixture(t);
  const assistantPub = publicKeyOf(Buffer.from(NOSTR_KEY, "hex")).toString("hex");
  const refusing = { activation: "mention", pairing: false, allowlist: [] };
  const { a, relayA } = await nostrSetup(t, context, refusing);
  await refusalWalk(context, { label: "Nostr", sent: () => repliesTo(a, assistantPub),
    say: async (text) => a.send(["EVENT", "branch-dm", directMessage(STRANGER, assistantPub, text)]) });
  a.socket.destroy();
  await until(() => relayA.connections[1]?.filter, "asked again after reconnecting");
  await assertNoSecret(context, [NOSTR_KEY]);
});

test("Nostr settings: every relay is checked, the key is a secret name, and a bad key is refused without showing it", async () => {
  await assert.rejects(() => buildParityChannel({ type: "nostr", id: "n", relays: ["wss://relay.example.org"], ...policy },
    { credential: async () => NOSTR_KEY, policy: blocked }), /Not allowed: relay.example.org/);
  await assert.rejects(() => buildParityChannel({ type: "nostr", id: "n", relays: ["wss://relay.example.org"], privateKey: NOSTR_KEY, ...policy },
    { credential: async () => NOSTR_KEY }), /privateKey|Unrecognized/);
  await assert.rejects(() => buildParityChannel({ type: "nostr", id: "n", relays: ["wss://relay.example.org"], ...policy },
    { credential: async () => "not-a-key-SECRETVALUE" }), (error) => /NOSTR_PRIVATE_KEY is not a usable/.test(error.message) && !error.message.includes("SECRETVALUE"));
  const nsec = await buildParityChannel({ type: "nostr", id: "n", relays: ["wss://relay.example.org"], privateKeySecret: "MY_NSEC", ...policy },
    { credential: async (name) => (name === "MY_NSEC" ? "nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5" : "") });
  assert.equal(nsec.kind, "nostr");
  await nsec.stop();
  const direct = new NostrChannel({ id: "n", relays: [], secretKey: Buffer.from(NOSTR_KEY, "hex"), connect: connectWebSocket });
  await assert.rejects(() => direct.send("npub-not-hex", "x"), /not a Nostr public key/);
  await assert.rejects(() => direct.send(STRANGER_PUB, "x"), /No Nostr relay is connected/);
});
