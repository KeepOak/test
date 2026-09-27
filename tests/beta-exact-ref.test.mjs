import test from "node:test";
import assert from "node:assert/strict";
import { remoteHead, betaLine } from "../dist/desktop/dev-build.js";

/* ls-remote matches the end of ref names: a branch whose name ends in Beta's own ref is listed too, and can sort first.
   Only the line naming exactly refs/heads/<betaLine> may be announced as the newest change. */
test("the newest Beta change is read from Beta's exact ref, never from a branch whose name only ends like it", async () => {
  const decoy = "a".repeat(40), real = "b".repeat(40);
  const run = async () => `${decoy}\trefs/heads/x/refs/heads/${betaLine}\n${real}\trefs/heads/${betaLine}\n`;
  assert.equal(await remoteHead(run, "owner/repo"), real);
  await assert.rejects(remoteHead(async () => `${decoy}\trefs/heads/x/refs/heads/${betaLine}\n`, "owner/repo"), /newest change/);
});
