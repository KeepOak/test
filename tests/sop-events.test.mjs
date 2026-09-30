/* RES-194: an event bound to an imported typed macro only proposes work; nothing runs until the owner approves that
   exact proposal (src/sop-events.ts). New procedures start switched off. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";

test("a due cron event proposes the macro run, and only the owner's approval of that proposal starts it", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-sop-events-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const macro = app.flows.saveMacro({ format: "branch-tool-macro/1", name: "Stamp", input: { note: "text" },
    steps: [{ name: "Write", tool: "files.write", args: { path: "stamp.txt", content: { $value: "note" } } }] });
  const sop = app.sops.save({ name: "Hourly stamp", macroId: macro.id, event: { kind: "cron", cron: "0 * * * *", timezone: "UTC" }, input: { note: "tick" } });
  assert.equal(sop.enabled, false, "a new procedure starts off");
  await app.sops.tick(new Date(Date.now() + 2 * 3_600_000));
  assert.deepEqual(app.sops.list()[0].pending, [], "nothing is proposed while it is off");
  app.sops.enable(sop.id, true);
  await app.sops.tick(new Date(Date.now() + 2 * 3_600_000));
  const [proposal] = app.sops.list()[0].pending;
  assert.ok(proposal, "the due event became a proposal");
  assert.deepEqual(proposal.input, { note: "tick" });
  assert.equal(app.store.sqlite.prepare("SELECT COUNT(*) AS n FROM flow_graph_runs").get().n, 0, "no run before the owner says yes");
  assert.throws(() => app.sops.approve(sop.id, "00000000-0000-4000-8000-000000000000"), /expired or was disabled/);
  const started = app.sops.approve(sop.id, proposal.id);
  assert.equal(started.flowId, macro.id);
  assert.deepEqual(app.sops.list()[0].pending, [], "an approved proposal is used once");
  assert.throws(() => app.sops.approve(sop.id, proposal.id), /expired or was disabled/);
});
