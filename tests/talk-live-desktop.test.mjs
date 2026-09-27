/**
 * Talk live in the desktop app: the page there holds no key, so the app signs the task socket's opening request with its
 * own, as it signs every /api/ request; the engine takes that as it takes the key in the socket's protocol. The desktop
 * window refuses every permission except the microphone, and that only for a call the owner started, at Branch's own
 * address, for sound only, once. None of this needs Electron: the real window is checked in tests/desktop.test.mjs.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { tokenFromSocket } from "../dist/ws.js";
import { sameAppOrigin } from "../dist/desktop/signed-headers.js";
import { TalkLiveMic, registerTalkLiveMicIpc, talkLiveMicChannel, talkLiveMicMs } from "../dist/desktop/talk-live-mic.js";

const origin = "http://127.0.0.1:4100";
const asked = (headers) => ({ headers });

test("a task's socket takes the key as its protocol or as the header the desktop app writes", () => {
  const key = "k".repeat(43);
  assert.equal(tokenFromSocket(asked({ "sec-websocket-protocol": `bearer, ${key}` }), key), true);
  assert.equal(tokenFromSocket(asked({ "sec-websocket-protocol": "bearer", authorization: `Bearer ${key}` }), key), true);
  assert.equal(tokenFromSocket(asked({ "sec-websocket-protocol": "bearer", authorization: `Bearer ${"x".repeat(43)}` }), key), false);
  assert.equal(tokenFromSocket(asked({ "sec-websocket-protocol": "bearer" }), key), false);
  assert.equal(tokenFromSocket(asked({ authorization: key }), key), false, "only a Bearer header");
  assert.equal(tokenFromSocket(asked({ authorization: `Bearer ${"é".repeat(43)}` }), key), false, "a wrong key of the same length in letters");
});

test("the window's own address, over http or its socket, and nothing else", () => {
  assert.equal(sameAppOrigin(`${origin}/api/state`, origin), true);
  assert.equal(sameAppOrigin("ws://127.0.0.1:4100/api/runs/x/ws", origin), true);
  assert.equal(sameAppOrigin("wss://127.0.0.1:4100/api/runs/x/ws", origin), false);
  assert.equal(sameAppOrigin("ws://127.0.0.1:4101/api/runs/x/ws", origin), false);
  assert.equal(sameAppOrigin("ws://localhost:4100/api/runs/x/ws", origin), false);
  assert.equal(sameAppOrigin("https://example.com/", origin), false);
  assert.equal(sameAppOrigin("not a url", origin), false);
});

test("the microphone is let through once, for sound, at Branch's own address, after the owner started a call", () => {
  let now = 1000;
  const mic = new TalkLiveMic(origin, 7, () => now);
  const sound = { requestingUrl: `${origin}/?desktop=1`, mediaTypes: ["audio"] };
  assert.equal(mic.take(7, "media", sound), false, "never before a call asks");
  mic.open();
  assert.equal(mic.take(7, "media", { ...sound, mediaTypes: ["audio", "video"] }), false, "never the camera");
  assert.equal(mic.take(7, "media", { ...sound, mediaTypes: [] }), false);
  assert.equal(mic.take(7, "media", { ...sound, requestingUrl: "http://127.0.0.1:9999/" }), false, "another address");
  assert.equal(mic.take(8, "media", sound), false, "another window");
  assert.equal(mic.take(7, "geolocation", sound), false, "another permission");
  assert.equal(mic.take(7, "media", sound), true, "the call's own request");
  assert.equal(mic.take(7, "media", sound), false, "used up by the request it answered");
  mic.open();
  now += talkLiveMicMs;
  assert.equal(mic.take(7, "media", sound), false, "a call's asking does not stay open");
});

test("only the window's own page, at Branch's own address, may say a call is asking", () => {
  const handlers = new Map();
  const ipc = { handle: (channel, handler) => handlers.set(channel, handler), removeHandler: (channel) => handlers.delete(channel) };
  const mainFrame = { url: `${origin}/?desktop=1` };
  const closed = [];
  const window = { webContents: { mainFrame }, on: (_event, listener) => closed.push(listener) };
  let opened = 0;
  registerTalkLiveMicIpc(ipc, window, origin, { open: () => { opened += 1; } });
  const handler = handlers.get(talkLiveMicChannel);
  assert.throws(() => handler({ sender: {}, senderFrame: mainFrame }), /denied/);
  assert.throws(() => handler({ sender: window.webContents, senderFrame: { url: mainFrame.url } }), /denied/, "a frame inside it");
  mainFrame.url = "http://127.0.0.1:9999/";
  assert.throws(() => handler({ sender: window.webContents, senderFrame: mainFrame }), /denied/, "another address");
  assert.equal(opened, 0);
  mainFrame.url = `${origin}/?desktop=1`;
  assert.equal(handler({ sender: window.webContents, senderFrame: mainFrame }), true);
  assert.equal(opened, 1);
  closed.forEach((listener) => listener());
  assert.equal(handlers.has(talkLiveMicChannel), false);
});

/** Asks for the task's socket the way the desktop app's signed request does, and answers the status line. */
function upgrade(server, runId, headers) {
  const url = new URL(server.url);
  return new Promise((done, fail) => {
    const asking = request({ host: url.hostname, port: url.port, path: `/api/runs/${runId}/ws`, headers: {
      connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
      origin: server.url, ...headers } });
    asking.on("upgrade", (response, socket) => { socket.destroy(); done(response.statusCode); });
    asking.on("response", (response) => { response.resume(); done(response.statusCode); });
    asking.on("error", (error) => (error.code === "ECONNRESET" ? done(401) : fail(error)));
    asking.end();
  });
}

test("the engine opens a task's socket signed with the app's key in the header, and refuses it otherwise", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-talk-desktop-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const run = app.store.createRun("local", "A live conversation");
  assert.equal(await upgrade(server, run.id, { "sec-websocket-protocol": "bearer", authorization: `Bearer ${server.token}` }), 101);
  assert.equal(await upgrade(server, run.id, { "sec-websocket-protocol": "bearer" }), 401);
  assert.equal(await upgrade(server, run.id, { "sec-websocket-protocol": "bearer", authorization: `Bearer ${"x".repeat(server.token.length)}` }), 401);
});
