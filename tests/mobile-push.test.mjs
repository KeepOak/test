/**
 * RES-600: phone push is the owner's opt-in. Its settings hold only locker references, never a key,
 * and a phone that is not paired here cannot register a token.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";

test("RES-600: off by default, references only, and an unpaired phone is refused", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-mobile-push-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  t.after(async () => { await app.close(); await discardTemp(root); });
  assert.equal(app.mobilePush.settings().enabled, false, "ships off");
  assert.throws(() => app.mobilePush.configure({ enabled: true, fcm: { project: "my-project", credential: "-----BEGIN PRIVATE KEY-----" } })); // not-a-real-secret: an inline key is refused
  app.mobilePush.configure({ enabled: true, fcm: { project: "my-project", credential: "secret://default/FCM_SERVICE_ACCOUNT" } });
  assert.equal(app.mobilePush.settings().enabled, true);
  await assert.rejects(app.mobilePush.register("0123456789abcdef", "a".repeat(64), { provider: "fcm", token: "token-for-a-phone-123", enabled: true }), /no longer paired/);
  assert.deepEqual(app.mobilePush.view().devices, []);
});
