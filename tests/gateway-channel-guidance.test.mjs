import test from "node:test";
import assert from "node:assert/strict";
import { setupList, setupPanel, saveSetup, saveSetupMode } from "../dist/channel-setup/service.js";
import { createBranch } from "../dist/index.js";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";

test("iMessage setup is gated by the engine platform before anything is saved or fetched", async (t) => {
  const parent = join(tmpdir(), "Codex-session-files");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "channel-prereq-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  t.after(async () => { await app.close(); await discardTemp(root); });
  saveSetupMode(app.store, "local", { mode: "on" });
  assert.match(setupPanel(app.store, "local", "imessage", "win32").unavailableReason, /Mac.*Full Disk Access/);
  assert.match(setupPanel(app.store, "local", "imessage", "linux").unavailableReason, /Mac/);
  assert.equal(setupPanel(app.store, "local", "imessage", "darwin").unavailableReason, null);
  let fetched = 0;
  const host = { store: app.store, owner: "local", platform: "win32", fetch: async () => { fetched++; throw new Error("network should not run"); } };
  await assert.rejects(saveSetup(host, "imessage", { values: {}, enable: "on" }), /Mac.*Messages/);
  assert.equal(fetched, 0);
  assert.equal(app.store.get("settings", "local", "channel-setup-done"), undefined);
  assert.match(setupPanel(app.store, "local", "signal").prerequisites, /Installation.*setup/);
  const flagged = (platform) => setupList(app.store, "local", platform).channels.filter((c) => c.needsMac).map((c) => c.id);
  assert.deepEqual(flagged("win32"), ["imessage"], "the catalog marks iMessage, and only iMessage, as needing a Mac");
  assert.deepEqual(flagged("darwin"), []);
});
