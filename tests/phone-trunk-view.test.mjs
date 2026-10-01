// A paired phone sees a Trunk's screen only with the owner's short grant for that phone, profile and Trunk, made in the
// local window; the grant is read-only, is found by the phone's own key, and ends when revoked. Stand-in screen only.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { GatewayAuth } from "../dist/remote/gateway-auth.js";
import { phoneViewGrants, phoneViewFrame } from "../dist/phone-view-grants.js";

test("only the owner's local window grants a phone a read-only Trunk view, and revoking ends it", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-phone-view-"));
  const provider = { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const { sessionId } = await app.runtime.run({ prompt: "hello" });
  const { device, key } = new GatewayAuth(app.store, app.runtime.owner).remember("Pixel");
  let frames = 0;
  const deps = { store: app.store, owner: app.runtime.owner, profiles: app.store.profiles, browser: null, locked: () => null,
    trunkOf: (id) => (id === sessionId ? "trunk-1" : null),
    desktop: { liveFrames: () => ({ next: async () => { frames++; return { type: "image/png", bytes: Buffer.from("png") }; }, close() {} }) } };
  const phone = { headers: { authorization: `Bearer ${key}` } }, query = new URLSearchParams({ session: sessionId, kind: "computer" });
  const grant = { deviceId: device.id, profileId: app.store.profiles.localWindowProfileId(), sessionId, kind: "computer", minutes: 5 };
  assert.throws(() => phoneViewGrants(deps, true, "POST", grant), /local Branch window/, "never through the door");
  await assert.rejects(phoneViewFrame(deps, phone, query), /No current owner grant/);
  const made = phoneViewGrants(deps, false, "POST", grant);
  assert.equal(made.grants.length, 1);
  const seen = await phoneViewFrame(deps, phone, query);
  assert.deepEqual([seen.readonly, seen.frame], [true, "data:image/png;base64,cG5n"]);
  await assert.rejects(phoneViewFrame(deps, { headers: { authorization: `Bearer ${"0".repeat(64)}` } }, query), /No current owner grant/, "another key finds nothing");
  phoneViewGrants(deps, false, "DELETE", { id: made.grants[0].id });
  await assert.rejects(phoneViewFrame(deps, phone, query), /No current owner grant/);
  assert.equal(frames, 1);
});
