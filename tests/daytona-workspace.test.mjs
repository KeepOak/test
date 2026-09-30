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
