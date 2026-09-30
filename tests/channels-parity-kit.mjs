/**
 * Shared pieces for the channels-parity tests: a Branch with a scripted model, stand-in servers that
 * answer the way each service's documentation says, and the checks every service must pass —
 * a stranger gets a pairing code, an approved person is answered, and no secret is ever written
 * down. Nothing here reaches a real chat service.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createServer as createSocketServer } from "node:net";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { acceptKey, frame, readFrame } from "../dist/ws.js";
import { saveParitySwitches } from "../dist/channels/parity-switch.js";
import { parityServices } from "../dist/channels/parity-services.js";
import { saveChatLiveSwitches } from "../dist/channels/chat-live-settings.js";
import { saveChatIntake } from "../dist/channels/intake-settings.js";

export { delay };

export async function until(check, label, tries = 400) {
  for (let i = 0; i < tries; i++) { const value = await check(); if (value) return value; await delay(20); }
  assert.fail(`Timed out: ${label}`);
}

export function scripted() {
  const provider = { name: "scripted", requests: [], async complete(request) {
    provider.requests.push(request);
    return { content: `Echo: ${request.messages.at(-1).content}`, toolCalls: [] };
  } };
  return provider;
}

/** A Branch in a temporary folder. Console output is captured so a test can prove no secret reached it. */
export async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-parity-"));
  const provider = scripted();
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  // The ship-on rule turns the chat extras on (a live status line, steering, splitting long replies); these tests are
  // about each service's own posts, one reply per message, so the owner switches the extras off.
  saveChatLiveSwitches(app.store, app.runtime.owner, { liveStatus: "off", steering: "off", splitting: "off" });
  // One reply per message: the wait for messages split in two (Settings › Chat apps, on as shipped) is off here too.
  saveChatIntake(app.store, app.runtime.owner, { splitWaitMs: 0 });
  const printed = [];
  const originals = {};
  for (const name of ["log", "info", "warn", "error", "debug"]) {
    originals[name] = console[name];
    console[name] = (...args) => { printed.push(args.map(String).join(" ")); };
  }
  t.after(async () => {
    Object.assign(console, originals);
    await app.close();
    await discardTemp(root);
  });
  return { app, root, provider, printed };
}

/** Turns one service's switch to a position, as the card would. */
export function setSwitch(app, kind, position) {
  return saveParitySwitches(app.store, app.runtime.owner, { [kind]: position }, parityServices.map((s) => s.kind));
}

/** Every file Branch wrote, and everything printed, must be free of the secret. */
export async function assertNoSecret(context, secrets) {
  const { app, root, printed } = context;
  const texts = [printed.join("\n"), JSON.stringify(app.channels.summary()), JSON.stringify(app.channels.outstanding())];
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else texts.push((await readFile(path).catch(() => Buffer.alloc(0))).toString("latin1"));
    }
  };
  await walk(root);
  for (const secret of secrets)
    for (const text of texts) assert.ok(!text.includes(secret), `a secret was written down or printed: ${secret.slice(0, 4)}…`);
}

/** An HTTP stand-in that records every request; `route(call)` answers it. */
export async function httpService(t, route) {
  const calls = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const part of request) chunks.push(part);
    const raw = Buffer.concat(chunks).toString("utf8");
    const url = new URL(request.url, "http://127.0.0.1");
    let json; try { json = raw ? JSON.parse(raw) : undefined; } catch { json = undefined; }
    const form = /x-www-form-urlencoded/.test(String(request.headers["content-type"] ?? "")) ? Object.fromEntries(new URLSearchParams(raw)) : undefined;
    const call = { method: request.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: request.headers, raw, json, form };
    calls.push(call);
    const answer = (await route(call)) ?? { status: 404, body: { error: "not here" } };
    if (answer.hold) { request.socket.setTimeout(0); await answer.hold; }
    response.writeHead(answer.status ?? 200, { "content-type": answer.type ?? "application/json", ...answer.headers });
    response.end(typeof answer.body === "string" ? answer.body : JSON.stringify(answer.body ?? {}));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }));
  return { calls, base: `http://127.0.0.1:${server.address().port}`, port: server.address().port };
}

/** A plain TCP stand-in. Each connection records the lines it received and can write lines back. */
export async function lineServer(t, onConnect) {
  const connections = [];
  const server = createSocketServer((socket) => {
    const connection = { lines: [], socket, write: (line) => socket.write(`${line}\r\n`), bytes: [] };
    let pending = "";
    socket.on("data", (chunk) => {
      connection.bytes.push(chunk);
      pending += chunk.toString("utf8");
      let at;
      while ((at = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, at).replace(/\r$/, "");
        pending = pending.slice(at + 1);
        connection.lines.push(line);
        connection.onLine?.(line);
      }
    });
    socket.on("error", () => undefined);
    connections.push(connection);
    onConnect?.(connection);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { for (const c of connections) c.socket.destroy(); server.close(resolve); }));
  return { connections, port: server.address().port };
}

/** A WebSocket stand-in that trades text frames; `json` parses what it receives. */
export async function socketService(t, onConnect, { json = true } = {}) {
  const connections = [];
  const server = createServer((_request, response) => { response.writeHead(404); response.end(); });
  server.on("upgrade", (request, socket) => {
    socket.write(["HTTP/1.1 101 Switching Protocols", "Upgrade: websocket", "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${acceptKey(String(request.headers["sec-websocket-key"] ?? ""))}`, "", ""].join("\r\n"));
    let pending = Buffer.alloc(0);
    const connection = { received: [], headers: request.headers, path: request.url, socket,
      send: (value) => socket.write(frame(typeof value === "string" ? value : JSON.stringify(value))) };
    socket.on("data", (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      for (let decoded = readFrame(pending); decoded; decoded = readFrame(pending)) {
        pending = pending.subarray(decoded.consumed);
        if (decoded.opcode === 0x1) {
          const text = decoded.payload.toString("utf8");
          const value = json ? JSON.parse(text) : text;
          connection.received.push(value);
          connection.onMessage?.(value);
        }
        if (decoded.opcode === 0x8) socket.end();
      }
    });
    socket.on("error", () => undefined);
    connections.push(connection);
    onConnect?.(connection);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { for (const c of connections) c.socket.destroy(); server.close(resolve); }));
  return { connections, url: `ws://127.0.0.1:${server.address().port}` };
}

/**
 * The walk every two-way service is put through: a stranger is offered a pairing code and never
 * reaches the model; once the owner approves the code the same person is answered.
 * `say(text)` makes the service deliver a message from the stranger; `sent()` lists what the
 * assistant has sent so far, as plain strings.
 */
export async function pairingWalk({ app, provider }, { say, sent, label = "service", group = false }) {
  await say("hello there");
  // UP-CHAT-007: a direct chat is sent its code; in a group the code is never posted, and the request waits for the
  // owner under Settings → Channels.
  const offer = group
    ? (await until(() => app.channels.summary().pending[0], `${label}: a pairing request`)).code
    : /\b(\d{6})\b/.exec(await until(() => sent().find((text) => /\b\d{6}\b/.test(text)), `${label}: pairing code`))[1];
  if (group) { await delay(50); assert.ok(!sent().some((text) => text.includes(offer)), `${label}: no code is posted in a group`); }
  assert.equal(provider.requests.length, 0, `${label}: a stranger never reaches the model`);
  app.channels.approve(app.runtime.owner, { code: offer });
  await say("what is the time");
  const answer = await until(() => sent().find((text) => /Echo:.*what is the time/.test(text)), `${label}: an answer`);
  return answer;
}

/**
 * With pairing off and nobody on the list, a stranger is refused and the model is never asked. UP-CHAT-008: the refusal
 * is silent, so it does not even confirm the bot is there.
 */
export async function refusalWalk({ provider }, { say, sent, label = "service" }) {
  const before = sent().length;
  await say("let me in please");
  await delay(400);
  assert.equal(sent().length, before, `${label}: a refused stranger is told nothing`);
  assert.equal(provider.requests.length, 0, `${label}: a refused stranger never reaches the model`);
}
