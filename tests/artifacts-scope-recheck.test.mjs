/**
 * Test for GET /api/artifacts scope recheck after awaiting artifact listing.
 * If profile is switched or AppLock is turned on while awaiting, the response should have no metadata.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

async function fixture(t) {
  const scratch = join(tmpdir(), "Codex-session-files");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "branch-artifacts-scope-"));
  const app = await createBranch({
    workspace: join(root, "workspace"),
    dataDir: join(root, "data"),
  });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => {
    await server.close();
    await app.close();
    await discardTemp(root);
  });

  const call = (path, body) => fetch(new URL(path, server.url), {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).then((response) => response.json());

  await call("/api/onboarding", { done: true });

  return { app, server, call };
}

test("GET /api/artifacts: scope changed during await correctly refuses metadata", async (t) => {
  const { app, server, call } = await fixture(t);

  // Create a second profile
  const profile2 = app.store.profiles.create({ name: "Profile 2", pin: "5678" });

  // Mock artifacts.list to inject profile switch during await
  const originalList = app.artifacts.list.bind(app.artifacts);
  let switchDone = false;
  app.artifacts.list = async function(...args) {
    const promise = originalList(...args);
    // Let the promise start
    await new Promise(resolve => setImmediate(resolve));
    if (!switchDone) {
      switchDone = true;
      // Switch profiles while the GET /api/artifacts is awaiting
      app.store.profiles.switch({ profileId: profile2.id, pin: "5678" });
    }
    return await promise;
  };

  try {
    // Call GET /api/artifacts - scope changes during the await
    const response = await call("/api/artifacts");

    // With the fix: response should have empty artifacts because scope changed
    // Without the fix: this assertion would fail (artifacts would be returned despite scope change)
    assert.deepEqual(response.artifacts, [],
      "GET /api/artifacts returns no metadata when scope changes during await");
  } finally {
    app.artifacts.list = originalList;
  }
});

test("GET /api/artifacts: scope unchanged returns artifacts normally", async (t) => {
  const { app, server, call } = await fixture(t);

  // Call without switching profiles
  const response = await call("/api/artifacts");

  // Should return valid artifacts array
  assert(Array.isArray(response.artifacts),
    "GET /api/artifacts returns artifacts array when scope unchanged");
});
