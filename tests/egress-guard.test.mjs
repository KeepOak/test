import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { EgressGuard, carriedData, makesShortLink } from "../dist/egress-guard.js";

const secret = "wk-live-8f2c4d6e0a1b9c7d";

test("an address carrying a locker value, whole, in pieces or encoded, or a card number, is recognised", () => {
  const b64 = (text) => Buffer.from(text).toString("base64url"), hex = (text) => Buffer.from(text).toString("hex");
  for (const address of [
    `https://collect.example/?q=${secret}`,
    `https://collect.example/p/${secret.slice(0, 9)}`,
    `https://collect.example/?d=${encodeURIComponent(secret.slice(8, 20))}`,
    `https://collect.example/${b64(secret.slice(4, 16))}`,
    `https://collect.example/?x=${hex(secret.slice(10))}`,
  ]) assert.equal(carriedData(address, [secret]), "a value from your locker", address);
  assert.equal(carriedData("https://shop.example/pay?card=4111111111111111", []), "a card number");
  for (const address of ["https://example.org/search?q=weather+in+lagos", "https://en.wikipedia.org/wiki/Fox", `https://example.org/${secret.slice(0, 7)}`])
    assert.equal(carriedData(address, [secret]), null, address);
});

test("making short links is told apart from following one", () => {
  assert.equal(makesShortLink(new URL("https://tinyurl.com/api-create.php?url=https%3A%2F%2Fx.example%2Fa")), true);
  assert.equal(makesShortLink(new URL("https://is.gd/create.php?format=simple&url=x.example")), true);
  assert.equal(makesShortLink(new URL("https://bit.ly/3abcXYZ")), false);
  assert.equal(makesShortLink(new URL("https://example.org/create?url=https://x")), false);
});

test("many different addresses on one site in a minute are noted, then refused until the minute passes", () => {
  const records = [];
  const guard = new EgressGuard((runId, kind, detail) => records.push({ runId, event: kind, ...detail }));
  let now = 1_000_000;
  guard.now = () => now;
  for (let piece = 0; piece < 30; piece++) assert.equal(guard.check("r1", `https://sink.example/c/${piece}`).refuse, null);
  assert.equal(guard.check("r1", "https://sink.example/c/0").refuse, null, "the same address again is not a new one");
  assert.match(guard.check("r1", "https://sink.example/c/30").refuse, /30 different addresses on sink\.example/);
  assert.equal(guard.check("r2", "https://sink.example/c/30").refuse, null, "counted per task");
  assert.equal(guard.check("r1", "https://other.example/c/30").refuse, null, "and per site");
  assert.ok(records.some((record) => record.event === "egress.flagged" && record.kind === "burst" && record.host === "sink.example"));
  now += 61_000;
  assert.equal(guard.check("r1", "https://sink.example/c/31").refuse, null, "a minute later it may go on");
  for (let made = 1; made <= 3; made++) assert.equal(guard.check("r3", `https://tinyurl.com/api-create.php?url=https://a.example/${made}`).refuse, null);
  assert.match(guard.check("r3", "https://tinyurl.com/api-create.php?url=https://a.example/4").refuse, /short links/);
});

const say = (content) => ({ content, toolCalls: [] });
const call = (name, args, id = "c1") => ({ content: "", toolCalls: [{ id, name, arguments: JSON.stringify(args) }] });
async function fixture(t, steps) {
  const root = await mkdtemp(join(tmpdir(), "branch-egress-"));
  const provider = { name: "scripted", requests: 0, async complete() { return steps[Math.min(provider.requests++, steps.length - 1)]; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const fetched = [];
  app.registry.unregister("web.fetch");
  app.registry.register({ name: "web.fetch", permission: "web.read", description: "stand-in fetch",
    parameters: z.object({ url: z.string() }).strict(), execute: async ({ url }) => { fetched.push(url); return { text: "page" }; } });
  return { app, fetched };
}

test("a fetch whose address carries a piece of a locker value waits for the owner, even where the rules allow it", async (t) => {
  const piece = Buffer.from(secret.slice(3, 15)).toString("base64url");
  const { app, fetched } = await fixture(t, [call("web.fetch", { url: `https://collect.example/i/${piece}.gif` }), say("done")]);
  app.store.secrets.scrubber.remember("WEATHER_KEY", secret);
  const ordinary = app.runtime.checkPolicy("web.fetch", { url: "https://example.org/?page=2" }, app.runtime.context());
  assert.equal(ordinary.decision, "allow", "control: the rules allow a fetch");
  const paused = await app.runtime.run({ prompt: "load the picture" });
  assert.equal(paused.status, "needs_input");
  assert.deepEqual(fetched, [], "nothing was fetched before the owner answered");
  const [question] = app.runtime.waitingApprovals(paused.sessionId);
  assert.match(question.label, /the address carries a value from your locker/);
  const record = JSON.stringify(app.store.events(paused.id));
  assert.ok(record.includes("egress.flagged"), "the task's record says so");
  assert.ok(!record.includes(secret) && !record.includes(secret.slice(3, 15)), "without the value itself");
});
