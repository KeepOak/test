import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { DiscordAdapter } from "../dist/index.js";
import { acceptKey, frame, readFrame } from "../dist/ws.js";

async function until(check, label) {
  for (let i = 0; i < 300; i++) { const value = check(); if (value) return value; await delay(20); }
  assert.fail(`Timed out: ${label}`);
}

/** A stand-in Discord gateway over a real WebSocket; `ack` decides whether heartbeats are acknowledged. */
async function gateway(t, { ack = true } = {}) {
  const connections = [], sockets = new Set();
  const server = createServer((_request, response) => { response.writeHead(404); response.end(); });
  server.on("upgrade", (request, socket) => {
    sockets.add(socket);
    socket.write(["HTTP/1.1 101 Switching Protocols", "Upgrade: websocket", "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${acceptKey(String(request.headers["sec-websocket-key"] ?? ""))}`, "", ""].join("\r\n"));
    const connection = { received: [], ended: false, send: (value) => socket.write(frame(JSON.stringify(value))),
      // A close frame carrying a status code, as Discord ends a connection it refuses.
      closeWith: (code) => { const payload = Buffer.alloc(2); payload.writeUInt16BE(code); socket.write(Buffer.concat([Buffer.from([0x88, 2]), payload])); } };
    let pending = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      for (let decoded = readFrame(pending); decoded; decoded = readFrame(pending)) {
        pending = pending.subarray(decoded.consumed);
        if (decoded.opcode === 0x8) { socket.end(); continue; }
        if (decoded.opcode !== 0x1) continue;
        const message = JSON.parse(decoded.payload.toString("utf8"));
        connection.received.push(message);
        if (message.op === 1 && ack) connection.send({ op: 11 });
      }
    });
    socket.on("close", () => { connection.ended = true; });
    socket.on("error", () => undefined);
    connections.push(connection);
    connection.send({ op: 10, d: { heartbeat_interval: 45000 } });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  // An upgraded socket is no longer the server's to close, so each is ended here or the server waits on it forever.
  t.after(() => { for (const socket of sockets) socket.destroy(); return new Promise((resolve) => server.close(resolve)); });
  return { connections, url: `ws://127.0.0.1:${server.address().port}` };
}

async function started(t, service, options = {}) {
  const adapter = new DiscordAdapter({ id: "discord", token: "not-a-real-secret", apiBase: "http://discord.test/api", gatewayUrl: service.url,
    reconnectBaseMs: 10, fetch: async () => new Response("{}"), ...options });
  t.after(() => adapter.stop());
  await adapter.start(async () => {});
  const first = await until(() => service.connections[0], "first connection");
  await until(() => first.received.some((message) => message.op === 2), "identify");
  first.send({ op: 0, s: 1, t: "READY", d: { user: { id: "bot-1", username: "BranchBot" }, session_id: "sess-1", resume_gateway_url: service.url } });
  await until(() => adapter.health().state === "connected", "ready");
  return { adapter, first };
}

test("Discord: a 4014 close stops reconnecting and the card says to enable the Message Content intent", async (t) => {
  const service = await gateway(t);
  const { adapter, first } = await started(t, service);
  first.closeWith(4014);
  await until(() => adapter.health().state === "needs attention", "needs attention");
  assert.match(adapter.health().reason, /Message Content intent/);
  await delay(300); // thirty reconnect bases: a loop would have dialled again many times
  assert.equal(service.connections.length, 1, "no reconnect after a close no reconnect can fix");
});

test("Discord: a 4007 close starts a new session (identify, not resume) and backs off", async (t) => {
  const service = await gateway(t);
  const { adapter, first } = await started(t, service);
  first.closeWith(4007);
  const second = await until(() => service.connections[1], "second connection");
  await until(() => second.received.length, "second handshake");
  assert.equal(second.received[0].op, 2, "a fresh identify");
  assert.match(adapter.health().reason, /4007/);
  second.closeWith(4009);
  const third = await until(() => service.connections[2], "third connection");
  await until(() => third.received.length, "third handshake");
  assert.equal(third.received[0].op, 2);
});

test("Discord: a heartbeat that is never acknowledged marks a zombie connection, which is closed and resumed", async (t) => {
  const service = await gateway(t, { ack: false });
  const { first } = await started(t, service, { heartbeatMs: 250 });
  await until(() => first.received.some((message) => message.op === 1), "first heartbeat");
  const second = await until(() => service.connections[1], "reconnect after the missed acknowledgement");
  assert.ok(first.received.filter((message) => message.op === 1).length <= 2, "it did not keep beating into the void");
  const resume = await until(() => second.received.find((message) => message.op === 6 || message.op === 2), "handshake");
  assert.equal(resume.op, 6, "a resume, not a new identify");
  assert.equal(resume.d.session_id, "sess-1");
});

test("Discord: acknowledged heartbeats keep the connection", async (t) => {
  const service = await gateway(t);
  const { first } = await started(t, service, { heartbeatMs: 30 });
  await until(() => first.received.filter((message) => message.op === 1).length >= 4, "several heartbeats");
  assert.equal(service.connections.length, 1);
});

test("Discord: op 9 resumes when its flag says it can, and identifies afresh when not, after a wait", async (t) => {
  const service = await gateway(t);
  const { first } = await started(t, service);
  first.send({ op: 9, d: true });
  const second = await until(() => service.connections[1], "second connection");
  const resumed = await until(() => second.received[0], "second handshake");
  assert.equal(resumed.op, 6, "a resumable invalid session resumes");
  second.send({ op: 9, d: false });
  const at = Date.now();
  const third = await until(() => service.connections[2], "third connection");
  assert.ok(Date.now() - at >= 10, "it waited at least the reconnect base");
  const fresh = await until(() => third.received[0], "third handshake");
  assert.equal(fresh.op, 2, "a session that cannot be resumed is identified afresh");
});
