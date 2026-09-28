/**
 * WhatsApp with a personal number through the WAHA bridge the owner runs on this computer (option b: Branch ships
 * nothing of the bridge). A fake WAHA stands in on 127.0.0.1; its socket is a fake connection handed in. No WhatsApp
 * account, no Docker and no real bridge are used.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { WhatsAppWebChannel, bridgeAddress, whatsappWebService } from "../dist/channels/whatsapp-web.js";
import { recipeFor } from "../dist/channel-setup/recipes.js";
import { bridgeLink, saveSetup, saveSetupMode, setupPanel } from "../dist/channel-setup/service.js";
import { rememberEntry } from "../dist/channel-setup/live.js";
import { parityKinds } from "../dist/channels/parity-config.js";

const KEY = "waha-test-key-4f1c";
/** A fake WAHA: sessions, the pairing code, sending; `state.status` is what the session says. */
async function fakeWaha(t) {
  const state = { status: null, calls: [], sent: [], me: { id: "15550001111:3@c.us", pushName: "Juniper" } };
  const server = createServer(async (request, response) => {
    let raw = ""; for await (const part of request) raw += part;
    state.calls.push({ method: request.method, url: request.url, key: request.headers["x-api-key"] });
    const json = (code, body) => { response.writeHead(code, { "content-type": "application/json" }); response.end(JSON.stringify(body)); };
    if (request.headers["x-api-key"] !== KEY) return json(401, { error: "Unauthorized" });
    if (request.method === "GET" && request.url === "/api/sessions/default")
      return state.status ? json(200, { name: "default", status: state.status, me: state.status === "WORKING" ? state.me : null }) : json(404, {});
    if (request.method === "POST" && request.url === "/api/sessions") { state.status = "SCAN_QR_CODE"; return json(201, { name: "default", status: "STARTING" }); }
    if (request.method === "GET" && request.url === "/api/default/auth/qr?format=raw") return json(200, { value: "2@abc,def,ghi,jkl" });
    if (request.method === "POST" && ["/api/sendText", "/api/sendImage", "/api/sendFile", "/api/sendVoice"].includes(request.url)) {
      state.sent.push({ path: request.url, ...JSON.parse(raw) }); return json(201, { id: "true_15551234567@c.us_ABC" }); }
    if (request.method === "GET" && request.url === "/api/files/default/photo.jpg") { response.writeHead(200, { "content-type": "image/jpeg" }); response.end(Buffer.alloc(9)); return; }
    return json(404, {});
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => new Promise((done) => server.close(done)));
  return { state, base: `http://127.0.0.1:${server.address().port}` };
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-wa-bridge-"));
  const provider = { name: "scripted", async complete() { return { content: "hello", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  t.after(async () => { await app.close(); await discardTemp(root); });
  return { app };
}

test("the bridge must run on this computer, and the recipe says the risk plainly and keeps the official path", () => {
  assert.equal(bridgeAddress("http://127.0.0.1:3000/"), "http://127.0.0.1:3000");
  assert.equal(bridgeAddress("http://localhost:3000"), "http://localhost:3000");
  for (const address of ["http://192.168.1.5:3000", "https://waha.example.org", "http://user:pw@127.0.0.1:3000", "ftp://127.0.0.1"])
    assert.throws(() => bridgeAddress(address), address);
  assert.equal(whatsappWebService.settings.safeParse({ server: "http://10.0.0.2:3000" }).success, false);
  assert.ok(parityKinds().includes("whatsapp-web"));
  const recipe = recipeFor("whatsapp-web");
  assert.match(recipe.warning, /unofficial client/);
  assert.match(recipe.warning, /can be banned/);
  assert.match(recipe.warning, /spare number/);
  assert.match(recipe.warning, /Cloud API/);
  assert.match(recipe.steps.join(" "), /administrator rights/, "no two-minute promise: Docker is an install");
  assert.equal(recipe.link, "bridge");
  assert.ok(recipeFor("whatsapp"), "the official Cloud API recipe stays");
  assert.ok(!JSON.stringify(recipe).includes("Baileys"));
});

test("setup through the bridge: saved and off until set up, then Link starts a session and shows the code, then linked", async (t) => {
  const waha = await fakeWaha(t);
  const { app } = await fixture(t);
  const owner = app.runtime.owner;
  saveSetupMode(app.store, owner, { mode: "on" });
  const host = { store: app.store, owner, fetch: async () => { throw new Error("the network settings are not asked about a loopback bridge"); },
    live: { connect: async () => ({ connected: false, channel: "whatsapp-web", botName: null, address: null, note: "The number is not linked." }), disconnect: async () => true } };
  await assert.rejects(bridgeLink(host, "whatsapp-web"), (error) => error.status === 409, "nothing to link before the settings are saved");
  const saved = await saveSetup(host, "whatsapp-web", { values: { server: waha.base, WAHA_API_KEY: KEY }, enable: "on" });
  assert.equal(saved.connected, false);
  assert.equal(setupPanel(app.store, owner, "whatsapp-web").setUpHere, true);

  assert.deepEqual(await bridgeLink(host, "whatsapp-web"), { state: "starting", status: "STARTING" }, "a new session starts first");
  const scan = await bridgeLink(host, "whatsapp-web"); // the wizard asks again every few seconds
  assert.equal(scan.state, "scan");
  assert.equal(waha.state.calls.filter((call) => call.method === "POST" && call.url === "/api/sessions").length, 1, "made once");
  assert.ok(scan.qr?.rows?.length > 20, "the code is drawn here from the bridge's raw value");
  assert.ok(waha.state.calls.every((call) => call.key === KEY), "every call carries the key");
  assert.ok(!JSON.stringify(scan).includes(KEY), "the key never comes back");
  waha.state.status = "WORKING";
  assert.deepEqual(await bridgeLink(host, "whatsapp-web"), { state: "linked", number: "15550001111", name: "Juniper" });
  await assert.rejects(bridgeLink({ ...host, thisComputer: false }, "whatsapp-web"), (error) => error.status === 403, "linking is only at this computer");
  await assert.rejects(bridgeLink(host, "telegram"), (error) => error.status === 404);
  rememberEntry(app.store, owner, "whatsapp-web", { type: "whatsapp-web", id: "whatsapp-web", server: "http://127.0.0.1:1" });
  await assert.rejects(bridgeLink(host, "whatsapp-web"), (error) => error.status === 502 && /Is it running/.test(error.message) && !error.message.includes(KEY));
});

test("the channel: direct messages and group mentions or replies in, status and its own messages out, text sent through the bridge", async (t) => {
  const waha = await fakeWaha(t);
  waha.state.status = "WORKING";
  let socket;
  const connect = async (url, options) => {
    let done; const closed = new Promise((resolve) => { done = resolve; });
    socket = { url, options, send() {}, close() { done(); }, closed };
    return socket;
  };
  const channel = new WhatsAppWebChannel({ id: "whatsapp-web", server: waha.base, session: "default", apiKey: KEY, connect });
  const got = [];
  await channel.start(async (message) => { got.push(message); });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(channel.health(), { state: "connected" });
  assert.equal(channel.botName(), "Juniper");
  const url = new URL(socket.url);
  assert.deepEqual([url.protocol, url.pathname, url.searchParams.get("session"), url.searchParams.get("events")], ["ws:", "/ws", "default", "message"]);
  const say = (payload) => socket.options.onMessage(JSON.stringify({ event: "message", session: "default", payload }));
  say({ id: "m1", from: "15551234567@c.us", body: "hello", _data: { notifyName: "Sam" } });
  say({ id: "m2", from: "15551234567@c.us", body: "mine", fromMe: true });
  say({ id: "m3", from: "status@broadcast", body: "a status" });
  say({ id: "m4", from: "120363@g.us", participant: "15552223333@c.us", body: "just chatting" });
  say({ id: "m5", from: "120363@g.us", participant: "15552223333@c.us", body: "@15550001111 can you help" });
  say({ id: "m6", from: "120363@g.us", participant: "15552223333@c.us", body: "yes", replyTo: { id: "x", participant: "15550001111@c.us" } });
  assert.deepEqual(got.map((m) => [m.messageId, m.chatKind, m.senderId, m.addressed]), [
    ["m1", "direct", "15551234567@c.us", true], ["m4", "group", "15552223333@c.us", false], ["m5", "group", "15552223333@c.us", true], ["m6", "group", "15552223333@c.us", true]]);
  assert.equal(got[0].senderName, "Sam");
  assert.equal(await channel.send("15551234567@c.us", "hi there", "false_15551234567@c.us_M1"), "true_15551234567@c.us_ABC");
  assert.deepEqual(waha.state.sent[0], { path: "/api/sendText", session: "default", chatId: "15551234567@c.us", text: "hi there", reply_to: "false_15551234567@c.us_M1" });
  await channel.stop();

  const wrongKey = new WhatsAppWebChannel({ id: "w2", server: waha.base, session: "default", apiKey: "nope", connect });
  await assert.rejects(wrongKey.start(async () => {}), /refused the API key/);
});

test("media through the bridge: pictures and voice notes in (fetched only from the bridge), pictures, files and voice out", async (t) => {
  const waha = await fakeWaha(t);
  waha.state.status = "WORKING";
  let socket;
  const connect = async (url, options) => { let done; const closed = new Promise((resolve) => { done = resolve; }); socket = { options, send() {}, close() { done(); }, closed }; return socket; };
  const channel = new WhatsAppWebChannel({ id: "whatsapp-web", server: waha.base, session: "default", apiKey: KEY, connect });
  const got = [];
  await channel.start(async (message) => { got.push(message); });
  await new Promise((resolve) => setTimeout(resolve, 30));
  const say = (payload) => socket.options.onMessage(JSON.stringify({ event: "message", session: "default", payload }));
  say({ id: "p1", from: "15551234567@c.us", body: "", hasMedia: true, media: { url: `${waha.base}/api/files/default/photo.jpg`, mimetype: "image/jpeg", filename: "photo.jpg" } });
  say({ id: "v1", from: "15551234567@c.us", body: "", hasMedia: true, media: { url: `${waha.base}/api/files/default/voice.oga`, mimetype: "audio/ogg; codecs=opus" } });
  say({ id: "x1", from: "15551234567@c.us", body: "", hasMedia: true, media: { url: "http://evil.example/steal", mimetype: "image/png" } });
  assert.equal(got.length, 3, "a message that is only a file is still a message");
  assert.deepEqual(got[0].attachments.map((a) => [a.name, a.kind, a.mediaType]), [["photo.jpg", "picture", "image/jpeg"]]);
  const before = waha.state.calls.length;
  assert.equal((await got[0].attachments[0].bytes()).byteLength, 9);
  assert.equal(waha.state.calls.at(-1).key, KEY, "fetched from the bridge with its key");
  assert.equal(waha.state.calls.length, before + 1, "and only when asked");
  assert.equal(got[1].voice.mediaType, "audio/ogg");
  await assert.rejects(got[2].attachments[0].bytes(), /not held by the WhatsApp bridge/, "never another host");

  await channel.sendFile("15551234567@c.us", { name: "chart.png", mediaType: "image/png", bytes: new Uint8Array([1, 2, 3]), caption: "your chart" });
  await channel.sendFile("15551234567@c.us", { name: "notes.pdf", mediaType: "application/pdf", bytes: new Uint8Array([4]) });
  await channel.sendVoice("15551234567@c.us", new Uint8Array([5, 6]), "audio/ogg");
  const [image, file, voice] = waha.state.sent.slice(-3);
  assert.deepEqual([image.path, image.caption, image.file.mimetype, image.file.filename, image.file.data], ["/api/sendImage", "your chart", "image/png", "chart.png", Buffer.from([1, 2, 3]).toString("base64")]);
  assert.deepEqual([file.path, file.file.filename], ["/api/sendFile", "notes.pdf"]);
  assert.deepEqual([voice.path, voice.convert, voice.file.data], ["/api/sendVoice", true, Buffer.from([5, 6]).toString("base64")]);
  await assert.rejects(channel.sendFile("15551234567@c.us", { name: "big.bin", mediaType: "application/octet-stream", bytes: new Uint8Array(17 * 1024 * 1024) }), /16 MB/);
  await channel.stop();
});
