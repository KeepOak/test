import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { proveOnce, sessionKey } from "../../dist/engine-proof.js";

/** Stops only the proved gateway launched under this fixture's exact home, before Playwright closes its Windows job. */
export async function closeOwnedGateway(electron, home, gatewayPid) {
  await electron.evaluate((_electron, expectedHome) => {
    if (process.env.BRANCH_DESKTOP_HOME !== expectedHome || process.env.BRANCH_TEST_ENGINE_HOOKS !== "1")
      throw new Error("Refusing another shell's gateway cleanup");
  }, home);
  const dataDir = join(home, "state"), presence = JSON.parse(await readFile(join(dataDir, "running.json"), "utf8"));
  assert.equal(presence.pid, gatewayPid, "the exact launched gateway still owns the running record");
  const token = (await readFile(join(dataDir, "session-token"), "utf8")).trim(), boot = await proveOnce(presence.url, token, 5000);
  assert.ok(boot, "the test-owned gateway proves itself before cleanup");
  const response = await fetch(`${presence.url}/api/deployment/quit`, { method: "POST", headers: { authorization: `Bearer ${sessionKey(token, boot)}` }, signal: AbortSignal.timeout(10000) });
  assert.equal(response.status, 200);
  const until = Date.now() + 15000;
  while (Date.now() < until) { try { process.kill(gatewayPid, 0); } catch { break; } await new Promise((resolve) => setTimeout(resolve, 30)); }
  assert.throws(() => process.kill(gatewayPid, 0), "the exact gateway exited after stopping its owned engine");
  await electron.close();
}
