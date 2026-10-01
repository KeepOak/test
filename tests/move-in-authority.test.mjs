import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBranch } from "../dist/index.js";
import { moveInApi } from "../dist/migrate-api.js";
import { bringOver } from "../dist/migrate/apply.js";
import { movedIn } from "../dist/migrate/record.js";
import { discardTemp } from "./temp-dir.mjs";

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-import-authority-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"),
    provider: { name: "fixture", async complete() { return { content: "ok", toolCalls: [] }; } } });
  t.after(async () => { await app.close(); await discardTemp(root); });
  return { app, root };
}
for (const transition of ["profile-return", "lock-unlock"]) {
  test(`move-in revokes ${transition} while waiting for the body`, async t => {
    const { app, root } = await fixture(t), body = deferred();
    const pending = moveInApi(app, { method: "POST" }, "/api/move-in/switch", () => body.promise,
      { platform: process.platform, env: {}, home: root });
    // Observe rejection immediately, before releasing the deferred boundary.
    const rejected = assert.rejects(pending, e => e.status === 403);
    if (transition === "profile-return") {
      const person = app.store.profiles.create({ name: "Fixture", pin: "1234" });
      app.store.profiles.switch({ profileId: person.id, pin: "1234" });
      app.store.profiles.switch({ profileId: null });
      app.store.profiles.remove(person.id);
    } else { app.sessionLock.lock(); app.sessionLock.unlock(); }
    const afterTransition = JSON.stringify(app.store.backup("after-transition").tables);
    body.resolve({ mode: "off" });
    await rejected;
    assert.equal(JSON.stringify(app.store.backup("after").tables), afterTransition, "stale body writes nothing");
  });
}

test("payload await revocation prevents private session and provenance writes", async t => {
  const { app } = await fixture(t), loaded = deferred(), entered = deferred();
  let revoked = false;
  const assertAuthority = () => { if (revoked) throw new Error("import revoked"); };
  const item = { key: "a".repeat(32), title: "Fixture chat", kind: "chat", needsKeys: [],
    async load() { entered.resolve(); return loaded.promise; },
    provenance: { conversationId: "original", leafId: "leaf", nodePath: ["leaf"], current: true, omittedParts: 0 } };
  const before = JSON.stringify(app.store.backup("before").tables);
  const pending = bringOver(app.store, app.runtime.owner, "chatgpt", { items: [item], keys: [], notes: [] },
    [item.key], new Set(), undefined, assertAuthority);
  const rejected = assert.rejects(pending, /import revoked/);
  await entered.promise;
  revoked = true;
  loaded.resolve({ kind: "chat", messages: [{ role: "user", content: "private fixture" }], folder: "" });
  await rejected;
  assert.equal(JSON.stringify(app.store.backup("after").tables), before);
  assert.deepEqual(movedIn(app.store, app.runtime.owner, "chatgpt"), {});
});

// Run the actual API source with only its scan/tree dependencies isolated, so cleanup timing is deterministic.
test("private preview is refused if the profile changes during asynchronous scan cleanup", async t => {
  const { app, root } = await fixture(t), closing = deferred(), release = deferred();
  const [{ readFile }, { runInNewContext }, { transpileModule, ScriptTarget, ModuleKind }, { z }, { MoveInSourceSchema, sourceNames }] = await Promise.all([
    import("node:fs/promises"), import("node:vm"), import("typescript"), import("zod"), import("../dist/migrate/types.js"),
  ]);
  const source = await readFile(new URL("../src/migrate-api.ts", import.meta.url), "utf8");
  const code = transpileModule(source, { compilerOptions: { target: ScriptTarget.ES2022, module: ModuleKind.ESNext } }).outputText
    .replace(/^import [^\r\n]*\r?\n/gm, "").replace(/export /g, "");
  const context = { z, MoveInSourceSchema, sourceNames, Buffer, URL, structuredClone,
    errorText: error => error.message, moveInMode: () => "when-needed", requireMoveInAllowed() {},
    archiveTree: () => ({ label: "private-fixture.zip" }),
    scanSource: async () => ({ items: [], keys: [], notes: [], async close() { closing.resolve(); await release.promise; } }),
    previewOf: () => ({ privateHistory: "Only the original owner may receive this preview" }),
  };
  runInNewContext(code + "\nglobalThis.actualMoveInApi = moveInApi;", context);
  const pending = context.actualMoveInApi(app, { method: "POST" }, "/api/move-in/preview",
    async () => ({ source: "chatgpt", archive: { name: "fixture.zip", data: "" } }),
    { platform: process.platform, env: {}, home: root });
  const rejected = assert.rejects(pending, error => error.status === 403);
  await closing.promise;
  const profile = app.store.profiles.create({ name: "Preview fixture", pin: "1234" });
  app.store.profiles.switch({ profileId: profile.id, pin: "1234" });
  release.resolve();
  await rejected;
});
