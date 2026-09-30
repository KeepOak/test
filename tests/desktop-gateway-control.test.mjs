import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { serveDesktopControl, connectDesktopControl } from "../dist/desktop/gateway-control.js";
import { discardTemp } from "./temp-dir.mjs";
import { protectedAreas, protectedTarget } from "../dist/never-break/protected.js";

test("a private proved desktop channel carries requests and awaited renderer acknowledgments in both directions", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "branch-desktop-control-")); let host, client;
  t.after(async () => { client?.close(); await host?.close(); await discardTemp(home); });
  host = await serveDesktopControl(home, { "use-window": (args) => args, "vault-forbidden": () => { throw new Error("refused"); } });
  client = await connectDesktopControl(home, { "window-update": async (update) => ({ painted: update.commit }) });
  assert.deepEqual(await client.link.call("use-window", { commit: "a".repeat(40) }), { commit: "a".repeat(40) });
  assert.deepEqual(await host.current().call("window-update", { commit: "a".repeat(40) }), { painted: "a".repeat(40) });
  await assert.rejects(client.link.call("arbitrary-shell", {}), /Unknown request/);
  await assert.rejects(client.link.call("vault-forbidden", {}), /refused/);
  client.close(); await host.close(); host = null;
  assert.equal(await access(join(home, "desktop-control", "authority.json")).then(() => true, () => false), false);
});

test("a stale or changed private descriptor cannot authenticate another shell", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "branch-desktop-control-refused-")); let host;
  t.after(async () => { await host?.close(); await discardTemp(home); });
  host = await serveDesktopControl(home, {});
  const path = join(home, "desktop-control", "authority.json"), saved = JSON.parse(await readFile(path, "utf8"));
  await writeFile(path, JSON.stringify({ ...saved, key: "0".repeat(64) }));
  await assert.rejects(connectDesktopControl(home), /refused|prove/);
  assert.equal(host.current(), null);
  await writeFile(path, JSON.stringify({ ...saved, pid: 2147483647 }));
  await assert.rejects(connectDesktopControl(home));
});

test("a departing shell cannot erase a successor's private connection or descriptor", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "branch-desktop-control-successor-")); let host, first, second;
  t.after(async () => { first?.close(); second?.close(); await host?.close(); await discardTemp(home); });
  host = await serveDesktopControl(home, {});
  first = await connectDesktopControl(home, { identity: () => "old" });
  second = await connectDesktopControl(home, { identity: () => "new" });
  first.close(); await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(await host.current().call("identity", {}), "new");
  const saved = JSON.parse(await readFile(join(home, "desktop-control", "authority.json"), "utf8"));
  await writeFile(join(home, "desktop-control", "authority.json"), JSON.stringify({ ...saved, key: "a".repeat(64) }));
  await host.close(); host = null;
  assert.equal(await access(join(home, "desktop-control", "authority.json")).then(() => true, () => false), true, "a replacement descriptor is preserved");
});

test("model tools cannot read or replace the private broker authority even from a workspace inside its data folder", () => {
  const dataDir = join(tmpdir(), "branch-control-protected"), workspace = join(dataDir, "workspace");
  const areas = protectedAreas({ dataDir, workspace });
  for (const name of ["authority.json", "authority.json.123.tmp"]) for (const readOnly of [true, false]) {
    const target = join(dataDir, "desktop-control", name);
    assert.notEqual(protectedTarget({ tool: readOnly ? "files.read" : "files.write", readOnly, args: { path: target }, target, workspace }, areas), null);
  }
});
