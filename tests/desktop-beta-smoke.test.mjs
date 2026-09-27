/* The Beta try-out in the new version's own app (src/desktop/beta-smoke-window.ts): started as
   `<app> --branch-smoke=<report>` exactly as the updater starts a staged copy (runStagedSmoke), it runs its own engine on
   a folder of its own, walks the steps in a hidden window, reports, and quits. The owner's data folder named in the
   running install's environment is never used, and the try-out's folder is gone afterwards.
   Mutation: in src/desktop/main.ts drop the `--branch-smoke` branch (the app then starts as usual and never reports)
   → "the new version's own app passes its try-out" goes red. */
import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import electron from "electron";
import { discardTemp } from "./temp-dir.mjs";
import { runStagedSmoke } from "../dist/desktop/beta-smoke.js";

const exists = (path) => access(path).then(() => true, () => false);

test("the new version's own app passes its try-out, on nothing of the owner's, and leaves nothing behind", { timeout: 300000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-desktop-try-out-"));
  t.after(() => discardTemp(root));
  const app = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const owners = join(root, "owners-data"), folder = join(root, "try-out");
  const failure = await runStagedSmoke({ executable: electron, args: [app] }, folder,
    { ...process.env, BRANCH_DATA_DIR: owners, BRANCH_DESKTOP_HOME: join(root, "owners-home"), BRANCH_PROVIDER: "demo" }, 240000);
  assert.equal(failure, null);
  assert.equal(await exists(owners), false, "the owner's data folder was never opened");
  assert.equal(await exists(join(root, "owners-home")), false, "nor the owner's app folder");
  assert.equal(await exists(folder), false, "the try-out's own folder is removed");
});
