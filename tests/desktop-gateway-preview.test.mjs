import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { connect } from "node:net";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Gateway } from "../dist/never-break/gateway.js";
import { discardTemp } from "./temp-dir.mjs";
import { previewRequest } from "../dist/never-break/gateway-preview.js";
import { defaultGatewayConfig, saveGatewayConfig } from "../dist/never-break/gateway-config.js";

const tick = () => new Promise((done) => setTimeout(done, 40));
async function listen(handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: server.address().port, close: () => new Promise((resolve) => server.close(resolve)) };
}
function worker(port) {
  const child = new EventEmitter(); Object.assign(child, { pid: 42, exitCode: null, signalCode: null, connected: true,
    send: (message, callback) => { callback?.(null); if (message.type === "stop") { child.exitCode = 0; child.emit("exit", 0, null); } return true; },
    kill: () => { child.exitCode = 1; child.emit("exit", 1, null); return true; } });
  child.port = port;
  child.ready = (version, provisional) => child.emit("message", { type: "ready", contract: 1, accepts: [1, 1], port: child.port, version, pid: 42, ...(provisional ? { provisional: true } : {}) });
  child.checking = () => child.emit("message", { type: "checking" });
  return child;
}

test("provisional engine serves only renderer restore reads; public POST and upgrade wait through a refused candidate", { timeout: 30000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-gateway-preview-")), dataDir = join(root, "data");
  await mkdir(dataDir); t.after(() => discardTemp(root));
  const served = [];
  const old = await listen((req, res) => { served.push(`old:${req.method}:${req.url}`); res.end("old"); });
  old.server.on("upgrade", (_req, wire) => { served.push("old:UPGRADE"); wire.end("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n"); });
  const next = await listen((req, res) => { served.push(`new:${req.method}:${req.url}`); res.end("new"); });
  t.after(async () => { await old.close(); await next.close(); });
  const child = worker(old.port);
  const gateway = new Gateway({ dataDir, script: "unused", port: 0, version: "1.0", spawn: () => child, settleMs: 5000 });
  t.after(() => gateway.stop()); await gateway.start(); child.ready("1.0");
  const url = gateway.url;
  child.checking(); child.port = next.port; child.ready("2.0", true);
  assert.equal((await fetch(`${url}/api/state`)).status, 200);
  assert.equal((await fetch(`${url}/app/main.js`)).status, 200);
  let postDone = false;
  const post = fetch(`${url}/api/run`, { method: "POST", body: "{}" }).then((res) => { postDone = true; return res.text(); });
  const socket = connect(Number(new URL(url).port), "127.0.0.1");
  let upgradeData = ""; socket.on("data", (chunk) => { upgradeData += chunk.toString(); });
  t.after(() => socket.destroy());
  await new Promise((resolve) => socket.once("connect", resolve));
  socket.write(`GET /api/events HTTP/1.1\r\nHost: 127.0.0.1:${new URL(url).port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`);
  await tick();
  assert.equal(postDone, false); assert.equal(upgradeData, "");
  assert.deepEqual(served, ["new:GET:/api/state", "new:GET:/app/main.js"], "candidate received restore reads only");
  child.checking(); child.port = old.port; child.ready("1.0", true);
  await tick(); assert.equal(postDone, false); assert.equal(upgradeData, "");
  child.ready("1.0"); assert.equal(await post, "old");
  for (let attempt = 0; attempt < 20 && !upgradeData; attempt++) await tick();
  assert.match(upgradeData, /101 Switching Protocols/);
  assert.equal(served.includes("old:UPGRADE"), true);
  assert.equal(served.some((call) => call.startsWith("new:POST:")), false);
  assert.equal(gateway.health().worker.state, "ready");
  child.checking(); child.port = next.port; child.ready("2.0", true);
  let accepted = false;
  const after = fetch(`${url}/api/run`, { method: "POST", body: "{}" }).then((response) => { accepted = true; return response.text(); });
  await tick(); assert.equal(accepted, false);
  child.ready("2.0"); assert.equal(await after, "new");
  assert.equal(served.includes("new:POST:/api/run"), true);
});

test("preview allowlist excludes task routes, non-GET methods and traversal", () => {
  for (const path of ["/api/run", "/api/commands/run", "/api/events", "/api/trunks/rooms", "/api/sessions/put-away/empty", "/api/state/../run"])
    assert.equal(previewRequest("GET", path), false, path);
  assert.equal(previewRequest("POST", "/api/state"), false);
  assert.equal(previewRequest("PUT", "/app/main.js"), false);
  assert.equal(previewRequest("GET", "/app/../secret.js"), false);
  for (const path of ["/api/state", "/api/sessions", "/api/profiles", "/app/main.js", "/app.css", "/locales/en.json", "/"])
    assert.equal(previewRequest("GET", path), true, path);
});

test("retained gateway accepts explicit owner OFF only after its successful response finishes", { timeout: 30000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-gateway-owner-off-"));
  t.after(() => discardTemp(root));
  await saveGatewayConfig(root, { ...defaultGatewayConfig(), mode: "on" });
  let off, offCount = 0; const ended = new Promise((resolve) => { off = resolve; });
  const upstream = await listen(async (req, response) => {
    if (req.method === "POST") await saveGatewayConfig(root, { ...defaultGatewayConfig(), mode: "off" });
    response.end("saved");
  });
  t.after(() => upstream.close());
  const child = worker(upstream.port);
  const gateway = new Gateway({ dataDir: root, script: "unused", port: 0, version: "1.0", spawn: () => child,
    onOwnerOff: () => { offCount++; off(); } });
  t.after(() => gateway.stop()); await gateway.start(); child.ready("1.0");
  assert.equal(await (await fetch(`${gateway.url}/api/state`)).text(), "saved"); assert.equal(offCount, 0);
  assert.equal(await (await fetch(`${gateway.url}/api/never-break`, { method: "POST", body: "{}" })).text(), "saved");
  await ended; assert.equal(offCount, 1);
});
