/* SCREEN-091/RES-407: a paid Daytona sandbox is made only after the owner confirms the exact proposal, once, within two
   minutes (src/remote/daytona-workspace.ts). No Daytona service is reached here. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";

test("nothing paid is created without the owner's exact, fresh confirmation, and a confirmation is used once", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-daytona-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  t.after(async () => { await app.close(); await discardTemp(root); });
  assert.equal(app.daytona.state().workspace, null, "no workspace until the owner makes one");
  await assert.rejects(app.daytona.create("11111111-1111-4111-8111-111111111111"), /approval expired/, "no proposal, no creation");
  const proposal = app.daytona.prepare({ secret: "DAYTONA_API_KEY", snapshot: "daytona-small", target: "eu", ttlMinutes: 15 });
  assert.match(proposal.question, /paid/);
  assert.match(proposal.question, /destroyed within 15 minutes/);
  await assert.rejects(app.daytona.create("22222222-2222-4222-8222-222222222222"), /approval expired/, "a different confirmation is refused");
  await assert.rejects(app.daytona.create(proposal.token), /approval expired/, "and the proposal it named is gone");
  assert.equal(app.daytona.state().workspace, null, "nothing was recorded as made");
  assert.throws(() => app.daytona.prepare({ secret: "lowercase", snapshot: "x" }), "only a locker secret name is accepted");
});

test("a bound sandbox Daytona no longer has is known to be gone; a creation whose reply never came stays uncertain", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-daytona-gone-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const settings = { secret: "DAYTONA_API_KEY", snapshot: "daytona-small", target: "us", ttlMinutes: 30 };
  const save = (extra) => app.store.save("settings", app.runtime.owner, "daytona-workspace",
    { settings, name: "branch-11111111-1111-4111-8111-111111111111", expiresAt: Date.now() + 60_000, ...extra });
  app.daytona.request = async () => null; // Daytona answers 404: no such sandbox
  save({ phase: "creating" });
  await assert.rejects(app.daytona.inspect(), /uncertain/, "an unanswered creation is never assumed gone");
  save({ phase: "bound", id: "sb-1" });
  assert.equal((await app.daytona.inspect()).state, "deleted", "its TTL deletion is recognised");
  save({ phase: "bound", id: "sb-1" });
  assert.match((await app.daytona.lifecycle("delete", "branch-11111111-1111-4111-8111-111111111111")).note, /no longer has/);
  assert.equal(app.daytona.state().workspace.phase, "deleted", "and a new workspace can be made again");
});
