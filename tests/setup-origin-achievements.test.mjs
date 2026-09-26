/**
 * Setup polish 2: "how am I getting achievements when I am still in onboarding". What the window's setup asks for
 * (sent with `x-branch-origin: setup`) is first-run configuration: switching Devices on to pair a phone is not
 * "Rule maker", a first Trunk introducing itself is not a finished task, a conversation or a Trunk turn, and the look
 * picked there is not a theme worn. A look from setup celebrates nothing. Once setup is over, the same things count.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-setup-origin-"));
  const provider = { name: "scripted", async complete() { return { content: "Hello, I am here.", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  /* One client for both, as the window sends them, so a mark cannot ride along to the next request on the same
     connection unseen. */
  const call = async (method, path, body, setup = false) => {
    const response = await fetch(new URL(path, server.url), {
      method, headers: { authorization: `Bearer ${server.token}`, "x-branch-origin": setup ? "setup" : "window",
        ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = await response.json().catch(() => ({}));
    assert.ok(response.status < 400, `${method} ${path}: ${response.status} ${data.error ?? ""}`);
    return data;
  };
  const got = async () => new Set((await call("GET", "/api/delight/achievements")).list.filter((a) => a.got).map((a) => a.id));
  return { app, call, got };
}

test("what setup asks for earns nothing, and a look from setup celebrates nothing", async (t) => {
  const { app, call, got } = await fixture(t);
  const before = await got(); // the first look, found quietly
  await call("POST", "/api/devices/mode", { mode: "when-needed" }, true);
  await call("POST", "/api/trunks/switch", { part: "trunks", mode: "on" }, true);
  await call("POST", "/api/trunks", { name: "Inbox Manager", description: "Clears your inbox" }, true);
  await app.trunks.introduced();
  assert.equal((await call("POST", "/api/delight/noticed", { what: "theme", mode: "dark", theme: "forest" }, true)).kept, false);
  const during = await call("GET", "/api/delight/achievements", undefined, true);
  assert.deepEqual(during.fresh, [], "nothing is celebrated over setup");

  const after = await got();
  const earned = [...after].filter((id) => !before.has(id));
  assert.deepEqual(earned, [], "neither Rule maker, nor the introduction's task, conversation and Trunk turn, nor the theme");
  assert.equal((await call("GET", "/api/delight/achievements")).fresh.length, 0);
  const policy = app.store.audit.counts(app.runtime.owner).find((row) => row.action === "policy.changed");
  assert.ok(policy.count >= 1, "the audit record itself still says what happened");
});

test("once setup is over, the same things count and are celebrated", async (t) => {
  const { app, call, got } = await fixture(t);
  await got();
  await call("POST", "/api/devices/mode", { mode: "when-needed" }, true);
  await call("POST", "/api/trunks/switch", { part: "trunks", mode: "on" }, true);
  await call("POST", "/api/trunks", { name: "Researcher", description: "Reads the web" }, true);
  await app.trunks.introduced();
  // The owner's own requests, without the header, from the same client: setup is over.
  await call("POST", "/api/devices/mode", { mode: "off" });
  await call("POST", "/api/run", { prompt: "Say hello." });
  const view = await call("GET", "/api/delight/achievements");
  const fresh = view.fresh.map((a) => a.id);
  assert.ok(fresh.includes("audit:policy.changed:1"), "Rule maker, for the owner's own change");
  assert.ok(fresh.includes("tasks:1") && fresh.includes("conversations:1"), "the owner's own task and conversation");
  assert.equal(fresh.includes("event:trunk.turn:1"), false, "the introduction made in setup still is not counted");
  assert.ok((await got()).has("audit:policy.changed:1"));
});

test("work setup left running is marked only until the window asks for something from outside setup", async () => {
  const { noteSetupOrigin, fromSetup } = await import("../dist/setup-origin.js");
  /* A timer made inside a setup request carries its mark; `next` is the header of the request that arrives meanwhile. */
  const leftRunning = (next) => new Promise((resolve) => setImmediate(() => {
    noteSetupOrigin("setup");
    const during = fromSetup();
    setTimeout(() => resolve([during, fromSetup()]), 20);
    setTimeout(() => noteSetupOrigin(next), 5);
  }));
  assert.deepEqual(await leftRunning(undefined), [true, true], "the terminal or the desktop app's own checks say nothing either way");
  assert.deepEqual(await leftRunning("window"), [true, false], "the window outside setup ends it");
  noteSetupOrigin("window");
});

test("a Trunk made in setup counts as a conversation once the owner talks in it", async (t) => {
  const { app, call, got } = await fixture(t);
  await got();
  await call("POST", "/api/trunks/switch", { part: "trunks", mode: "on" }, true);
  const { trunk } = await call("POST", "/api/trunks", { name: "Trip Planner", description: "Plans trips" }, true);
  await app.trunks.introduced();
  assert.equal((await got()).has("conversations:1"), false);
  await call("POST", "/api/run", { prompt: "Hello.", sessionId: trunk.chatSessionId });
  assert.ok((await got()).has("conversations:1"));
});
