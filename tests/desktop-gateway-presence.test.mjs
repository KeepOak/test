import test from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { EngineHost } from "../dist/desktop/engine-host.js";
import { proveOnce } from "../dist/engine-proof.js";
import { discardTemp } from "./temp-dir.mjs";
const entry = fileURLToPath(new URL("./fixtures/engine-in-node.mjs", import.meta.url));
test("a trusted gateway worker binds an internal dynamic port, proves identity and leaves public presence to its broker", { timeout: 120000 }, async (t) => {
  const home = await mkdtemp(join(tmpdir(), "branch-gateway-presence-")), dataDir = join(home, "data");
  await mkdir(dataDir); const remembered = JSON.stringify({ port: 45009 });
  await writeFile(join(dataDir, "local-port.json"), remembered);
  let child;
  const host = new EngineHost({ config: { dataDir, workspace: join(home, "work"), version: "0.0.0", gateway: true,
    executable: null, installRoot: null, packaged: false, loginItem: null, appPid: process.pid, testHooks: false, providerEnv: null }, handlers: { "vault-read": () => null },
    fork: () => {
      child = fork(entry, [], { stdio: ["ignore", "ignore", "inherit", "ipc"], env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
        TEMP: process.env.TEMP, TMP: process.env.TMP, HOME: home, USERPROFILE: home, APPDATA: join(home, "roaming"), LOCALAPPDATA: join(home, "local") } });
      return { get pid() { return child.pid; }, postMessage: (message) => { if (child.connected) child.send(message); },
        on: (event, listener) => event === "exit" ? child.on("exit", (code) => listener(code ?? 1)) : child.on("message", listener), kill: () => child.kill() };
    } });
  t.after(async () => { await host.end(3000); if (child?.exitCode === null) child.kill(); await discardTemp(home); });
  const url = await host.start(); assert.notEqual(Number(new URL(url).port), 45009);
  assert.ok(await proveOnce(url, host.token, 5000), "the worker proves its served identity");
  assert.equal(await access(join(dataDir, "running.json")).then(() => true, () => false), false);
  assert.equal(await readFile(join(dataDir, "local-port.json"), "utf8"), remembered);
  const view = await fetch(`${url}/api/never-break`, { headers: { authorization: `Bearer ${host.token}` } }).then((response) => response.json());
  assert.equal(view.underGateway, true);
});
