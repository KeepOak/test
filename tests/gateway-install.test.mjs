/* The gateway's own install with no window open (src/desktop/gateway-install.ts), driven by the same update loop main
   runs (src/desktop/update-loop.ts). Stand-ins for the updater: nothing is built, downloaded or installed here. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gatewayInstall } from "../dist/desktop/gateway-install.js";
import { UpdateLoop } from "../dist/desktop/update-loop.js";
import { WindowUpdateDeferred } from "../dist/desktop/live-window-ipc.js";
import { discardTemp } from "./temp-dir.mjs";

function fakeUpdater(result) {
  const calls = [];
  return {
    calls, status: { phase: "available", release: { tag: "dev-bbbbbbb" }, outcome: null, message: "", installed: { version: "2.0.0" } },
    inProgress: false, selectedChannel: "beta",
    setChannel() {}, async check() { return this.status; },
    useLive(hooks) { calls.push(`live ${hooks ? "hooks" : "none"}`); },
    async install(options) { calls.push(`install automatic=${options.automatic}`); if (result instanceof Error) throw result; return result; },
    switchedWithoutWindow() { calls.push("switched"); },
    failed(message) { calls.push(`failed ${message}`); },
  };
}

async function folders(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-gateway-install-"));
  t.after(() => discardTemp(root));
  await writeFile(join(root, "current.json"), JSON.stringify({ folder: "app-1.0.0" }));
  await writeFile(join(root, "current.next.json"), JSON.stringify({ folder: "app-2.0.0" }));
  return { root, folder: "app-1.0.0", executable: join(root, "app-1.0.0", "Branch Agent.exe") };
}

test("with no window, the gateway's loop installs by itself: a change to the app is put in use for the next window", async (t) => {
  const layout = await folders(t), updater = fakeUpdater({ script: "switch.cmd", stagedDir: "staged" });
  let adopted = 0;
  const loop = new UpdateLoop({
    readiness: async () => ({ channel: "beta", autoUpdate: "install" }),
    plan: async () => ({ mode: "install", step: "install", reason: "" }), updater,
    install: async () => { await gatewayInstall({ shellOpen: () => false, updater, live: () => ({}), appFolders: layout,
      adopt: async (action) => { adopted++; return action(); } }); },
    setTimer: () => ({ cancel() {} }),
  });
  assert.equal(await loop.look(), 30_000);
  assert.deepEqual(updater.calls, ["live hooks", "install automatic=true", "switched"]);
  assert.equal(adopted, 1, "the install ran as the gateway's one adoption");
  assert.equal(JSON.parse(await readFile(join(layout.root, "current.json"), "utf8")).folder, "app-2.0.0", "the next window opens as the new version");
});

test("a live change goes through the gateway's own engine and switches nothing", async (t) => {
  const layout = await folders(t), updater = fakeUpdater({ live: { tier: "engine" } });
  assert.equal(await gatewayInstall({ shellOpen: () => false, updater, live: () => ({}), appFolders: layout }), "live");
  assert.equal(JSON.parse(await readFile(join(layout.root, "current.json"), "utf8")).folder, "app-1.0.0");
  assert.ok(!updater.calls.includes("switched"));
});

test("a window that opened takes the update; a busy adoption waits and says so; a flat copy says why, never silently", async (t) => {
  const layout = await folders(t);
  const opened = fakeUpdater({ live: {} });
  await assert.rejects(gatewayInstall({ shellOpen: () => true, updater: opened, live: () => null, appFolders: layout }), { name: "UpdateDeferredError" });
  assert.deepEqual(opened.calls, [], "nothing was installed beside the window's own loop");
  const busy = fakeUpdater(new WindowUpdateDeferred("A checked update is already being applied."));
  await assert.rejects(gatewayInstall({ shellOpen: () => false, updater: busy, live: () => null, appFolders: layout }), { name: "UpdateDeferredError", message: /already being applied/ });
  const flat = fakeUpdater({ script: "swap.cmd", stagedDir: "staged" });
  await assert.rejects(gatewayInstall({ shellOpen: () => false, updater: flat, live: () => null, appFolders: null }), /waits for its window/);
  assert.match(flat.calls.at(-1), /^failed .*waits for its window/, "the updater says it");
  // Through the loop, a deferral is not an error: it is kept as the reason the update waits.
  const said = [];
  const loop = new UpdateLoop({ readiness: async () => ({ channel: "beta", autoUpdate: "install" }), plan: async () => ({ mode: "install", step: "install", reason: "" }),
    updater: opened, install: () => gatewayInstall({ shellOpen: () => true, updater: opened, live: () => null, appFolders: layout }).then(() => undefined),
    tell: (words) => said.push(words), setTimer: () => ({ cancel() {} }) });
  await loop.look();
  assert.match(loop.last.wait ?? "", /window opened/);
  assert.deepEqual(said, []);
});
