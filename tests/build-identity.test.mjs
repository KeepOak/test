/**
 * Q55: "Built from commit" names the commit only when it is the build that is running. An installed
 * app keeps its stamp; a copy running from source keeps an old dist/build-info.json across later
 * builds, so there the stamp counts only while the checkout is still at that commit.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { builtFrom } from "../dist/desktop/build-identity.js";

const STAMPED = "0123456789abcdef0123456789abcdef01234567";
const LATER = "fedcba9876543210fedcba9876543210fedcba98";

async function appWith(t, info) {
  const root = await mkdtemp(join(tmpdir(), "branch-build-identity-"));
  t.after(() => discardTemp(root));
  await mkdir(join(root, "dist"), { recursive: true });
  if (info !== undefined) await writeFile(join(root, "dist", "build-info.json"), JSON.stringify(info));
  return root;
}

test("running from source, a stamp from an older build is not recorded", async (t) => {
  const root = await appWith(t, { commit: STAMPED });
  assert.equal(await builtFrom(root, false, async () => LATER), null, "the checkout moved on since the stamp was written");
  assert.equal(await builtFrom(root, false, async () => null), null, "git cannot say where the checkout is");
});

test("running from source, a stamp that matches the checkout is shown", async (t) => {
  const root = await appWith(t, { commit: STAMPED });
  assert.equal(await builtFrom(root, false, async () => STAMPED), STAMPED);
});

test("an installed app keeps its stamp and never asks git", async (t) => {
  const root = await appWith(t, { commit: STAMPED });
  assert.equal(await builtFrom(root, true, async () => { throw new Error("git was asked"); }), STAMPED);
});

test("no stamp, or one that is not a commit, is not recorded", async (t) => {
  assert.equal(await builtFrom(await appWith(t), true), null);
  assert.equal(await builtFrom(await appWith(t, { commit: "main" }), true), null);
  assert.equal(await builtFrom(await appWith(t, { commit: STAMPED.slice(0, 12) }), false, async () => STAMPED), null);
});
