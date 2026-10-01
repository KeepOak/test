/* A price watch sent while Branch locks (or the window switches away from the owner) during the request is refused
   before its first look at the page. A stand-in replaces the page read; nothing reaches the network. */
import test from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

const watch = { url: "https://shop.example/kettle", every: "6h", price: { item: "Blue kettle 1.7 L", currency: "USD", currencyMarker: "$", label: "Total:", below: 50 } };

async function fixture(t) {
  const scratch = join(tmpdir(), "Codex-session-files"); await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "branch-price-lock-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const looked = [];
  app.monitors.observe = async (kind, target) => { looked.push(target); return "Blue kettle\nTotal: $60.00"; };
  return { app, server, looked };
}
/** Sends the headers, lets `meanwhile` run while the body is still on its way, then sends the body. */
function post(server, body, meanwhile) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(new URL("/api/monitors", server.url), { method: "POST",
      headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" } }, (res) => {
      let text = ""; res.setEncoding("utf8"); res.on("data", (c) => { text += c; }); res.on("end", () => resolve({ status: res.statusCode, text }));
    });
    req.on("error", reject);
    req.flushHeaders();
    setTimeout(() => { meanwhile(); req.end(JSON.stringify(body)); }, 50);
  });
}

test("a price watch is refused when Branch locks while its request is still arriving, before the page is read", async (t) => {
  const { app, server, looked } = await fixture(t);
  const locked = await post(server, watch, () => app.sessionLock.lock());
  assert.equal(locked.status, 423, locked.text);
  assert.deepEqual(looked, [], "the page was never read");
  assert.deepEqual(app.monitors.list(app.runtime.owner), []);
});

test("with Branch unlocked the same watch is made after one look at the page", async (t) => {
  const { app, server, looked } = await fixture(t);
  const made = await post(server, watch, () => {});
  assert.equal(made.status, 200, made.text);
  assert.deepEqual(looked, ["https://shop.example/kettle"]);
  assert.equal(app.monitors.list(app.runtime.owner).length, 1);
});
