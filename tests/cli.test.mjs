import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { discardTemp } from "./temp-dir.mjs";
import { fixtureModel } from "./fixtures/fixture-model.mjs";

test("CLI loads explicitly configured integrations before doctor", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-cli-"));
  t.after(() => discardTemp(root));
  const config = join(root, "integrations.json");
  await writeFile(
    config,
    JSON.stringify({ browser: { allowedOrigins: ["http://127.0.0.1:3456"] } }),
  );
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ["dist/cli.js", "doctor", "--json"],
    {
      env: {
        ...process.env,
        ...(await fixtureModel()).env,
        BRANCH_WORKSPACE: join(root, "workspace"),
        BRANCH_DATA_DIR: join(root, "data"),
        BRANCH_INTEGRATIONS: config,
      },
    },
  );
  assert.ok(JSON.parse(stdout).registeredTools.includes("browser.read"));
});
