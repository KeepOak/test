import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, watch } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { healthReport } from "../dist/health.js";

/** Audit #36: a health check (branch doctor, the Health page, the start-up check) changes nothing; only a probe writes. */
test("an ordinary health check leaves the workspace as it was; only a probe writes a file, and removes it", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-health-look-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const controller = new AbortController();
  t.after(async () => { controller.abort(); await app.close(); await discardTemp(root); });
  const seen = [];
  void (async () => { try { for await (const event of watch(app.runtime.workspace, { signal: controller.signal })) seen.push(String(event.filename)); } catch { /* stopped */ } })();
  await new Promise((resolve) => setTimeout(resolve, 100));
  const report = await healthReport(app);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(report.items.find((item) => item.name === "Workspace folder").ok, true);
  assert.deepEqual(seen, [], "nothing was written to the workspace");
  await healthReport(app, { probeProvider: true }).catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.ok(seen.some((name) => name.startsWith("health-")), "the probe wrote its test file");
  assert.deepEqual((await readdir(app.runtime.workspace)).filter((name) => name.startsWith("health-")), [], "and removed it");
});
