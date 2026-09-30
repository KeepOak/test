/* PLAT-188 (measured part): /gateway/health says what the gateway process itself uses, measured when asked, with no
   sampler or timer, and names what it leaves out. A Gateway object that is never started; nothing listens. */
import test from "node:test";
import assert from "node:assert/strict";
import { Gateway } from "../dist/never-break/gateway.js";
import { gatewayResources } from "../dist/never-break/gateway-resources.js";

test("PLAT-188: the gateway's health carries its own memory and CPU, measured at the time of asking", () => {
  const health = new Gateway({ dataDir: "/nowhere", script: "/nowhere/worker.js", port: 0, version: "1.0.0" }).health();
  const { resources } = health;
  assert.equal(resources.pid, process.pid);
  assert.equal(resources.scope, "gateway process");
  assert.deepEqual(resources.excludes, ["worker engine", "shell windows"]);
  for (const bytes of ["rssBytes", "peakRssBytes", "heapUsedBytes", "heapTotalBytes", "externalBytes"])
    assert.ok(Number.isFinite(resources.memory[bytes]) && resources.memory[bytes] >= 0, bytes);
  assert.ok(resources.memory.peakRssBytes >= resources.memory.rssBytes / 2, "the peak is in bytes, like the rest");
  assert.ok(resources.cpu.userMicroseconds > 0);
  assert.ok(Date.parse(resources.measuredAt) <= Date.now());
});

test("PLAT-188: each reading is fresh, not a cached sample", async () => {
  const first = gatewayResources();
  let spin = 0; for (let i = 0; i < 2e6; i++) spin += i;
  assert.ok(spin > 0);
  const second = gatewayResources();
  assert.ok(second.cpu.userMicroseconds >= first.cpu.userMicroseconds);
  assert.notEqual(second.measuredAt === first.measuredAt && second.cpu.userMicroseconds === first.cpu.userMicroseconds, true);
});
