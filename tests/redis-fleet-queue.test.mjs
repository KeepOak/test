/* RES-339: the Redis fleet queue ships off, is configured only from the owner's window, and asks for an HTTPS endpoint
   (src/interop/redis-queue.ts, /api/interop/redis-queue). No Redis is reached here. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

test("the Redis queue starts off, takes only an HTTPS endpoint, and its tools stay out of the catalog while the fleet is off", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-redis-queue-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const call = async (path, body) => { const response = await fetch(server.url + path, { method: body ? "POST" : "GET",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json().catch(() => null) }; };
  assert.deepEqual((await call("/api/interop/redis-queue")).body, { mode: "off" });
  assert.equal(app.registry.permissionOf("fleet.queue.claim"), "", "not in the catalog while the fleet is off");
  const config = { mode: "on", endpoint: "http://redis.example.test", fleet: "11111111-1111-4111-8111-111111111111",
    project: app.store.projects.active(app.runtime.owner).id, tokenName: "REDIS_REST_TOKEN" };
  assert.ok((await call("/api/interop/redis-queue", config)).status >= 400, "a plain-http endpoint is refused");
  assert.deepEqual((await call("/api/interop/redis-queue")).body, { mode: "off" }, "nothing was saved");
  const saved = await call("/api/interop/redis-queue", { ...config, endpoint: "https://redis.example.test" });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.mode, "on");
});
