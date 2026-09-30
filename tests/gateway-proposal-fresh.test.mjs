/* PLAT-183 (stale-suggestion part): a gateway timing suggestion is accepted only against the timings it was made from.
   If the owner edited a timing since, accepting it is refused and the owner's edit is kept. A temporary data folder. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { acceptProposal, loadGatewayConfig, proposeConfig, proposedFile, saveGatewayConfig } from "../dist/never-break/gateway-config.js";

const passes = async () => ({ ok: true, detail: "started" });
async function folder(t) {
  const dataDir = await mkdtemp(join(tmpdir(), "branch-proposal-"));
  t.after(() => discardTemp(dataDir));
  return dataDir;
}

test("PLAT-183: a suggestion made before the owner changed a timing is refused, and the owner's change stays", async (t) => {
  const dataDir = await folder(t);
  const proposal = await proposeConfig(dataDir, { holdSeconds: 5 }, "shorter waits", passes);
  assert.equal(proposal.basedOn.holdSeconds, 20);
  const { config } = await loadGatewayConfig(dataDir);
  await saveGatewayConfig(dataDir, { ...config, startSeconds: 120 });
  await assert.rejects(acceptProposal(dataDir), /timings changed since this suggestion was prepared: startSeconds/);
  const kept = (await loadGatewayConfig(dataDir)).config;
  assert.equal(kept.startSeconds, 120);
  assert.equal(kept.holdSeconds, 20, "nothing of the stale suggestion was taken");
});

test("PLAT-183: a fresh suggestion is accepted; an older one with no record of its basis is refused", async (t) => {
  const dataDir = await folder(t);
  await proposeConfig(dataDir, { holdSeconds: 5 }, "shorter waits", passes);
  assert.equal((await acceptProposal(dataDir)).holdSeconds, 5);
  await proposeConfig(dataDir, { holdSeconds: 7 }, "a little longer", passes);
  const saved = JSON.parse(await readFile(join(dataDir, proposedFile), "utf8"));
  delete saved.basedOn;
  await writeFile(join(dataDir, proposedFile), JSON.stringify(saved));
  await assert.rejects(acceptProposal(dataDir), /no record of the timings it was based on/);
  assert.equal((await loadGatewayConfig(dataDir)).config.holdSeconds, 5);
});
