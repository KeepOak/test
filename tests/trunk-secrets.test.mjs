/* RES-260: a Trunk's own secrets reach only its own turns. Another Trunk, a helper and the owner's own conversations
   never read them; a Trunk that does not use the owner's keys gets nothing of the owner's either. The owner sets and
   removes them by name on the Trunk (never a value back), a script's key cannot reach them, no project can share their
   locker space, and they go when the Trunk does.
   Mutation: in src/trunks/secrets.ts secretSources, read a helper's names from the Trunk's own secrets too (drop
   `work.helper ? [] :`), or let a Trunk that does not copy the owner's keys fall back to them, and this goes red. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-trunk-secrets-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const call = async (method, path, body, token = server.token) => {
    const response = await fetch(new URL(path, server.url), { method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  /** A task as `started` says, and the context a command in it would have. */
  const work = (started, extra = {}) => {
    const run = app.store.createRun(app.runtime.owner, "a command");
    app.store.event(run.id, "run.started", { source: "owner", ...started });
    return { ...app.runtime.context({ runId: run.id }), ...extra };
  };
  return { app, call, work };
}

test("a Trunk's own secrets reach only its own turns", async (t) => {
  const { app, call, work } = await fixture(t);
  const owner = app.runtime.owner;
  const ada = app.trunks.create({ name: "Ada" }), bo = app.trunks.create({ name: "Bo" });
  app.trunks.edit(bo.id, { keys: { copyFromOwner: false, accounts: {} } });
  await app.store.secrets.put(owner, app.store.projects.active(owner).id, "DEPLOY_TOKEN", "owner-deploy");
  await app.store.secrets.put(owner, app.store.projects.active(owner).id, "OTHER_KEY", "owner-other");
  const saved = await call("POST", `/api/trunks/${ada.id}/secrets`, { name: "DEPLOY_TOKEN", value: "ada-deploy" });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));

  const listed = await call("GET", `/api/trunks/${ada.id}/secrets`);
  assert.deepEqual(listed.body.secrets.map((s) => s.name), ["DEPLOY_TOKEN"]);
  assert.equal(JSON.stringify(listed.body).includes("ada-deploy"), false, "a value never comes back");

  assert.deepEqual(await app.secretsFor(work({}, { trunk: ada.id }), ["DEPLOY_TOKEN", "OTHER_KEY"]),
    { DEPLOY_TOKEN: "ada-deploy", OTHER_KEY: "owner-other" }, "its own first, the owner's for the rest (it copies the owner's keys)");
  assert.deepEqual(await app.secretsFor(work({}), ["DEPLOY_TOKEN"]), { DEPLOY_TOKEN: "owner-deploy" }, "the owner's own work never reads a Trunk's");
  assert.deepEqual(await app.secretsFor(work({ parentRunId: crypto.randomUUID() }, { trunk: ada.id }), ["DEPLOY_TOKEN"]),
    { DEPLOY_TOKEN: "owner-deploy" }, "a helper the Trunk set going never reads its own secrets");
  await assert.rejects(app.secretsFor(work({}, { trunk: bo.id }), ["DEPLOY_TOKEN"]), /not among this Trunk's own secrets/,
    "another Trunk that does not use the owner's keys gets neither Ada's nor the owner's");

  const key = app.sessionTokens.create(owner, { name: "script", scope: "run", minutes: 5 }).token;
  assert.equal((await call("GET", `/api/trunks/${ada.id}/secrets`, undefined, key)).status, 401, "a script's key cannot read the names");
  assert.equal((await call("POST", `/api/trunks/${ada.id}/secrets`, { name: "X_KEY", value: "x" }, key)).status, 401);
  assert.equal((await call("GET", `/api/secrets/t-${ada.id}`)).status, 404, "the generic secrets route never reaches it");
  assert.notEqual((await call("POST", "/api/projects", { id: `t-${ada.id}`, name: "Look-alike" })).status, 200, "no project can share its space");

  assert.equal((await call("POST", `/api/trunks/${ada.id}/secrets`, { name: "DEPLOY_TOKEN", remove: true })).body.removed, true);
  await call("POST", `/api/trunks/${ada.id}/secrets`, { name: "DEPLOY_TOKEN", value: "ada-deploy-2" });
  app.trunks.remove(ada.id);
  assert.deepEqual(app.store.secrets.list(owner, `t-${ada.id}`), [], "they go when the Trunk does");
});
