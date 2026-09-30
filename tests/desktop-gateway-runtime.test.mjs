import test from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { EngineHost } from "../dist/desktop/engine-host.js";
import { startDesktopGateway } from "../dist/desktop/gateway-runtime.js";
import { proveOnce, sessionKey } from "../dist/engine-proof.js";
import { defaultGatewayConfig } from "../dist/never-break/gateway-config.js";
import { daemonCommand } from "../dist/install/daemon.js";
import { discardTemp } from "./temp-dir.mjs";
const entry = fileURLToPath(new URL("./fixtures/engine-in-node.mjs", import.meta.url));

function engine(home, dataDir, gone, children) {
  return new EngineHost({ config: { dataDir, workspace: join(home, "work"), version: "0.0.0", gateway: true,
    executable: null, installRoot: null, packaged: false, loginItem: null, appPid: process.pid, testHooks: false, providerEnv: null },
  handlers: { "vault-read": () => null }, onGone: gone,
  fork: () => {
    const child = fork(entry, [], { stdio: ["ignore", "ignore", "inherit", "ipc"], env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
      TEMP: process.env.TEMP, TMP: process.env.TMP, HOME: home, USERPROFILE: home, APPDATA: join(home, "roaming"), LOCALAPPDATA: join(home, "local") } });
    children.push(child);
    return { get pid() { return child.pid; }, postMessage: (message) => { if (child.connected) child.send(message); },
      on: (event, listener) => event === "exit" ? child.on("exit", (code) => listener(code ?? 1)) : child.on("message", listener), kill: () => child.kill() };
  } });
}

test("retained desktop gateway keeps its public proof and presence while replacing a crashed engine", { timeout: 120000 }, async (t) => {
  const home = await mkdtemp(join(tmpdir(), "branch-gateway-runtime-")), dataDir = join(home, "data");
  await mkdir(dataDir); const children = [], ready = [];
  let gateway, closed = 0;
  t.after(async () => { await gateway?.stop(); for (const child of children) if (child.exitCode === null) child.kill(); await discardTemp(home); });
  const nextReady = async (count) => {
    const until = Date.now() + 50000;
    while (ready.length < count && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 30));
    assert.ok(ready.length >= count, `engine ${count} becomes ready`); return ready[count - 1];
  };
  await assert.rejects(daemonCommand("install", { platform: "win32", executable: process.execPath, script: entry,
    dataDir, workspace: join(home, "work"), port: 0, launcherPath: join(home, "daemon.vbs") },
  { write: async () => {}, run: async () => { throw new Error("Access is denied"); } }), /Access is denied/);
  gateway = await startDesktopGateway({ dataDir, engineFile: entry, port: 0, version: "0.0.0",
    worker: () => ({ create: async (gone) => engine(home, dataDir, gone, children), version: "0.0.0", closeBroker: () => closed++ }),
    onWorker: (event) => { if (event.kind === "ready") ready.push(event.ready); } });
  assert.ok(gateway); const first = await nextReady(1), publicUrl = gateway.url;
  assert.equal(gateway.health().worker.state, "ready", "scheduled-task denial did not disable retained window-close work");
  const token = (await readFile(join(dataDir, "session-token"), "utf8")).trim();
  const boot = await proveOnce(publicUrl, token, 5000); assert.ok(boot);
  const get = async (path) => {
    const response = await fetch(`${publicUrl}${path}`, { headers: { authorization: `Bearer ${sessionKey(token, boot)}` }, signal: AbortSignal.timeout(50000) });
    assert.equal(response.status, 200); return response.json();
  };
  assert.equal((await get("/api/never-break")).underGateway, true);
  const servedVersion = (await get("/api/state")).version;
  const presence = JSON.parse(await readFile(join(dataDir, "running.json"), "utf8"));
  assert.equal(presence.pid, process.pid); assert.equal(presence.url, publicUrl);
  assert.notEqual(first.pid, process.pid); assert.notEqual(first.port, presence.port);
  children[0].kill(); const held = get("/api/state"), second = await nextReady(2);
  assert.notEqual(second.pid, first.pid); assert.equal((await held).version, servedVersion);
  assert.equal(await proveOnce(publicUrl, token, 5000), boot);
  assert.equal(gateway.url, publicUrl); assert.equal(gateway.restarts, 1); assert.equal(closed, 1);
  assert.equal((await get("/api/never-break")).underGateway, true);
  assert.deepEqual(JSON.parse(await readFile(join(dataDir, "running.json"), "utf8")), presence);
  await gateway.stop(); assert.equal(closed, 2);
  assert.equal(await access(join(dataDir, "running.json")).then(() => true, () => false), false);
});

test("an explicit desktop gateway OFF never creates an engine or public presence", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "branch-gateway-off-")); t.after(() => discardTemp(home));
  const preference = JSON.stringify({ ...defaultGatewayConfig(), mode: "off" });
  await writeFile(join(home, "gateway.json"), preference); let created = false;
  assert.equal(await startDesktopGateway({ dataDir: home, engineFile: entry, port: 0, version: "0.0.0",
    worker: () => { created = true; throw new Error("OFF must not launch"); } }), null);
  assert.equal(created, false); assert.equal(await readFile(join(home, "gateway.json"), "utf8"), preference);
  assert.equal(await access(join(home, "running.json")).then(() => true, () => false), false);
});
