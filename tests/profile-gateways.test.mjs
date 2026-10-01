// PLAT-184: a household profile's isolated gateway is made only with fresh credentials, history kept where it was and no
// sharing; its home is its own folder, a second creation is refused, and routing never falls back to the shared store.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { ProfileGateways } from "../dist/profile-gateways.js";

const id = "0f8c2d4e-1b2a-4c3d-9e8f-123456789abc";
const choices = { credentials: "fresh", history: "keep-in-original", sharing: "none" };

test("an isolated gateway is made once, in its own home, only on the explicit contract; not running means no route", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-profile-gw-"));
  t.after(() => discardTemp(root));
  const gateways = new ProfileGateways(root);
  assert.deepEqual(await gateways.view(id), { profileId: id, configured: false });
  await assert.rejects(gateways.create(id, { ...choices, credentials: "copy" }));
  await assert.rejects(gateways.create(id, { ...choices, sharing: "household" }));
  const made = await gateways.create(id, choices);
  assert.deepEqual([made.profileId, made.isolation, made.running], [id, "separate-process-and-data-home", null]);
  const home = join(root, "profile-gateways", id);
  assert.equal(JSON.parse(await readFile(join(home, "binding.json"), "utf8")).choices.sharing, "none");
  if (process.platform !== "win32") assert.equal((await stat(home)).mode & 0o777, 0o700, "the home is the owner's alone");
  await assert.rejects(gateways.create(id, choices), /EEXIST/, "made once");
  await assert.rejects(gateways.create("../escape", choices));
  let asked = 0;
  await assert.rejects(gateways.route(id, { operation: "sessions" }, () => { asked++; }), /not ready/, "no worker, no answer from anywhere else");
  assert.equal(asked, 1);
});
