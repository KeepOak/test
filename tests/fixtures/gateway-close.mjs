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

/**
 * Ends the detached broker a gateway test started under its exact home, whatever state the test stopped in: the broker
 * named by that home's own running note is asked to quit (proved, with the session key), and if it is still there it is
 * ended by the pid its own note gave. Nothing outside the test's home is read or touched. Returns the pid it ended, if any.
 */
export async function stopHomeBroker(home) {
  const dataDir = join(home, "state");
  let note = null, token = null;
  try { note = JSON.parse(await readFile(join(dataDir, "running.json"), "utf8")); } catch { return null; }
  try { token = (await readFile(join(dataDir, "session-token"), "utf8")).trim(); } catch { /* no key: go straight to the pid */ }
  const alive = () => { try { process.kill(note.pid, 0); return true; } catch { return false; } };
  if (!Number.isInteger(note?.pid) || !alive()) return null;
  const boot = token ? await proveOnce(note.url, token, 5000).catch(() => null) : null;
  if (boot) await fetch(`${note.url}/api/deployment/quit`, { method: "POST", headers: { authorization: `Bearer ${sessionKey(token, boot)}` },
    signal: AbortSignal.timeout(15000) }).catch(() => undefined);
  for (const until = Date.now() + 15000; Date.now() < until && alive();) await new Promise((resolve) => setTimeout(resolve, 50));
  if (alive()) { try { process.kill(note.pid); } catch { /* gone meanwhile */ } }
  for (const until = Date.now() + 10000; Date.now() < until && alive();) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(alive(), false, "the test-owned detached broker exited");
  return note.pid;
}
