import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { z } from "zod";
import { createBranch } from "../dist/index.js";
import { startServer, offLimitsToShortLivedKeys } from "../dist/server.js";
import { shortLivedKeyTaskRoutes, taskRouteFor } from "../dist/short-lived-keys.js";
import { ROUTES, OUTBOUND, SAMPLE_ID, entry, expandRoute, routeLiterals } from "./short-lived-key-routes.mjs";

/* mac5/key-sweep: one rule that fails closed. A short-lived key may look; a "run" key may also use
   the task routes; every other change is the owner's, including any route added later. */

const ROOT = join(import.meta.dirname, "..");
const concrete = (path) => path.replaceAll(":id", SAMPLE_ID);
const rows = Object.entries(ROUTES).map(([path, value]) => ({ path, ...entry(value) }));

async function sourceFiles(dir) {
  const found = [];
  for (const item of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, item.name);
    if (item.isDirectory()) found.push(...await sourceFiles(full));
    else if (item.name.endsWith(".ts")) found.push(full);
  }
  return found;
}

async function writtenRoutes() {
  const routes = new Map();
  for (const file of await sourceFiles(join(ROOT, "src"))) {
    const name = relative(ROOT, file).replaceAll("\\", "/");
    if (OUTBOUND.some((pattern) => pattern.test(name))) continue;
    for (const literal of routeLiterals(await readFile(file, "utf8")))
      for (const path of expandRoute(literal)) routes.set(path, `${name}: ${literal}`);
  }
  return routes;
}

test("guard: every route written in src/ is classified for short-lived keys, and the table has nothing stale", async () => {
  const written = await writtenRoutes();
  const missing = [...written].filter(([path]) => !(path in ROUTES)).map(([path, where]) => `${path}  (${where})`);
  assert.deepEqual(missing, [], "Classify these in tests/short-lived-key-routes.mjs, and if a run key may use one, add it to src/short-lived-keys.ts");
  const stale = Object.keys(ROUTES).filter((path) => !written.has(path));
  assert.deepEqual(stale, [], "These are no longer written anywhere in src/; take them out of the table");
});

test("the rule: task routes are open to a run key, every other change is refused, and reads stay open", () => {
  for (const { path, kind, methods } of rows) {
    const at = concrete(path);
    if (kind === "task") for (const method of methods) {
      assert.equal(offLimitsToShortLivedKeys(method, at), null, `${method} ${path} is a task route`);
      assert.ok(taskRouteFor(method, at), `${method} ${path} is not on the allowlist in src/short-lived-keys.ts`);
    }
    if (kind === "owner" || kind === "other") for (const method of methods)
      assert.ok(offLimitsToShortLivedKeys(method, at), `${method} ${path} must be refused to short-lived keys`);
    if (kind === "look") {
      assert.equal(offLimitsToShortLivedKeys("GET", at), null, `GET ${path} is a read`);
      assert.ok(offLimitsToShortLivedKeys("POST", at), `POST ${path} is not a task route, so it fails closed`);
    }
    if (kind === "secret-read") assert.ok(offLimitsToShortLivedKeys("GET", at), `GET ${path} hands back a secret or everybody's data`);
  }
  // Nothing is on the allowlist that the table does not call a task route.
  const tasks = rows.filter((row) => row.kind === "task");
  for (const route of shortLivedKeyTaskRoutes)
    assert.ok(tasks.some((row) => route.pattern.test(concrete(row.path))), `allowlisted ${route.pattern} matches no task route in the table`);
  // A route nobody has written yet is refused too: that is what "fails closed" means.
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    assert.match(offLimitsToShortLivedKeys(method, "/api/some-new-settings"), /short-lived key/);
    assert.match(offLimitsToShortLivedKeys(method, "/v1/something-new"), /short-lived key/);
  }
  assert.equal(offLimitsToShortLivedKeys("GET", "/api/some-new-view"), null);
});

async function served(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-key-sweep-"));
  const provider = { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const keys = {
    read: app.sessionTokens.create(app.runtime.owner, { name: "wall", scope: "read", minutes: 5 }).token,
    run: app.sessionTokens.create(app.runtime.owner, { name: "script", scope: "run", minutes: 5 }).token,
  };
  const call = (method, path, key, body) => fetch(server.url + path, {
    method,
    headers: { authorization: `Bearer ${key}`, ...(method === "GET" ? {} : { "content-type": "application/json" }) },
    ...(method === "GET" ? {} : { body: JSON.stringify(body ?? {}) }),
  }).then(async (response) => ({ status: response.status, body: await response.json().catch(() => ({})) }));
  return { app, server, keys, call };
}

test("generated: a run key gets 401 on every owner-only change, and neither key reads a secret", async (t) => {
  const { keys, call } = await served(t);
  const through = [];
  for (const { path, kind, methods } of rows) {
    if (kind === "owner" || kind === "other") for (const method of methods) {
      const answer = await call(method, concrete(path), keys.run);
      if (answer.status !== 401 || !/short-lived key/.test(answer.body.error ?? "")) through.push(`${method} ${path} → ${answer.status}`);
    }
    if (kind === "secret-read") for (const key of [keys.read, keys.run]) {
      const answer = await call("GET", concrete(path), key);
      if (answer.status !== 401) through.push(`GET ${path} → ${answer.status}`);
    }
  }
  assert.deepEqual(through, [], "a short-lived key got through");
});

test("review: the six settings routes found open are closed to a run key, and still open to this computer's key", async (t) => {
  const { server, keys, call } = await served(t);
  const found = ["/api/desktop/settings", "/api/credentials/settings", "/api/lock/settings", "/api/trace/settings", "/api/mcp/settings", "/api/models/profiles"];
  for (const path of found) {
    const refused = await call("POST", path, keys.run, {});
    assert.equal(refused.status, 401, path);
    assert.match(refused.body.error, /cannot change settings, permissions or security/, path);
  }
  const saved = await call("POST", "/api/desktop/settings", server.token, {});
  assert.notEqual(saved.status, 401, "the key of this computer still changes settings");
  // A restore replaces everything, so it is not a task either.
  assert.equal((await call("POST", "/api/restore", keys.run, {})).status, 401);
  assert.equal((await call("POST", "/api/restore?replace=1", keys.run, {})).status, 401);
});

test("review (bucket 16): the waiting Slack events are not readable with a short-lived key, only with this computer's key", async (t) => {
  const { server, keys, call } = await served(t);
  for (const key of [keys.run, keys.read]) {
    const refused = await call("GET", "/api/channels/slack-automations", key);
    assert.equal(refused.status, 401);
    assert.match(refused.body.error, /short-lived key cannot read/);
  }
  const owner = await call("GET", "/api/channels/slack-automations", server.token);
  assert.equal(owner.status, 200, JSON.stringify(owner.body));
});

test("a run key may still start and answer work, but not make a standing rule while answering", async (t) => {
  const { keys, call } = await served(t);
  const started = await call("POST", "/api/run", keys.run, { prompt: "say hello" });
  assert.equal(started.status, 200);
  assert.notEqual((await call("POST", "/api/sessions/search", keys.run, { query: "hello" })).status, 401);
  const always = await call("POST", "/api/policy/approve", keys.run, { sessionId: started.body.sessionId, decision: "allow", remember: "always" });
  assert.equal(always.status, 401);
  assert.match(always.body.error, /cannot make a standing rule/);
  const once = await call("POST", "/api/policy/approve", keys.run, { sessionId: started.body.sessionId, decision: "allow", remember: "session" });
  assert.notEqual(once.status, 401, "answering for this conversation stays a run key's job");
});

/* ---- Integration review (mac5/key-sweep): holes found after the builder's round. ---- */

async function servedWithDefaultLimits(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-key-sweep-limits-"));
  const provider = { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const make = (scope) => app.sessionTokens.create(app.runtime.owner, { name: scope, scope, minutes: 5 }).token;
  const call = (method, path, key, body) => fetch(server.url + path, {
    method,
    headers: { authorization: `Bearer ${key}`, ...(method === "GET" ? {} : { "content-type": "application/json" }) },
    ...(method === "GET" ? {} : { body: JSON.stringify(body ?? {}) }),
  }).then(async (response) => ({ status: response.status, body: await response.json().catch(() => ({})) }));
  return { app, server, make, call };
}

test("review: a working key refused a route is not a wrong key, so a script cannot lock out the phone or the dashboard", async (t) => {
  const { app, make, call } = await servedWithDefaultLimits(t);
  const run = make("run"), read = make("read");
  for (let i = 0; i < 8; i++) {
    const refused = await call("POST", "/api/desktop/settings", run, {});
    assert.equal(refused.status, 401, `refusal ${i + 1} is a refusal, not a wait`);
    assert.match(refused.body.error, /short-lived key/);
  }
  for (let i = 0; i < 6; i++) assert.equal((await call("GET", "/api/backup", read)).status, 401);
  // Another key from the same place (the dashboard, a paired phone behind the same address) still works.
  assert.equal((await call("GET", "/api/state", read)).status, 200);
  assert.equal((await call("POST", "/api/sessions/search", run, { query: "x" })).status, 200);
  assert.deepEqual(app.store.audit.list(app.runtime.owner, { action: "auth.refused" }), [], "a refused working key is not written down as a wrong key");
  // A key that is not one of this computer's is still counted.
  let last;
  for (let i = 0; i < 6; i++) last = await call("POST", "/api/desktop/settings", "bat_not-a-real-key-000000000000", {});
  assert.equal(last.status, 429);
});

test("dogfood E7: no key is no guess, so the window asking before sign-in never makes this computer wait", async (t) => {
  const { app, server, make, call } = await servedWithDefaultLimits(t);
  const read = make("read");
  for (const authorization of [undefined, "Bearer ", "Bearer"])
    for (let i = 0; i < 8; i++) {
      const asked = await fetch(`${server.url}/api/state`, authorization === undefined ? {} : { headers: { authorization } });
      assert.equal(asked.status, 401, `${authorization ?? "no header"}, ask ${i + 1}: a refusal, not a wait`);
    }
  assert.equal((await call("GET", "/api/state", read)).status, 200, "a script's key from this computer still works");
  assert.deepEqual(app.store.audit.list(app.runtime.owner, { action: "auth.refused" }), [], "and no wrong tries are written down");
  let last;
  for (let i = 0; i < 6; i++) last = await call("GET", "/api/state", "not-the-key-000000000000");
  assert.equal(last.status, 429, "a wrong key is still counted");
});

test("review: spellings and methods that differ from a task route are refused, not let through", () => {
  const id = SAMPLE_ID;
  for (const path of ["/api/run/", "//api/run", "/API/run", "/api/run;x", "/api/run%2F", "/api/runs", `/api/runs/${id}/cancel/`,
    `/api/runs/${id}/cancelx`, `/api/runs/${id}/trace`, "/api/runx", "/api/sessions/search/", "/mcp/", "/mcpx"])
    assert.ok(offLimitsToShortLivedKeys("POST", path), `POST ${path}`);
  for (const method of ["PUT", "PATCH", "HEAD", "OPTIONS", "DELETE", undefined])
    assert.ok(offLimitsToShortLivedKeys(method, "/api/run"), `${method} /api/run`);
  assert.equal(offLimitsToShortLivedKeys("POST", "/api/run"), null);
});

function standIn(app, ran) {
  app.registry.register({ name: "probe.change", permission: "probe.write", description: "stand-in", parameters: z.object({}).passthrough(), execute: async () => { ran.push(1); return { ok: true }; } });
}

test("review: /api/action with a short-lived key goes through the approval rules and is never its own yes", async (t) => {
  const { app, server, make, call } = await servedWithDefaultLimits(t);
  const ran = [];
  standIn(app, ran);
  const run = make("run");
  for (const decision of ["ask", "deny"]) {
    assert.equal((await call("POST", "/api/policy", server.token, { rules: [{ tool: "probe.change", match: "*", decision }] })).status, 200);
    const refused = await call("POST", "/api/action", run, { tool: "probe.change", args: {} });
    assert.equal(refused.status, 401, `${decision}: ${JSON.stringify(refused.body)}`);
    assert.match(refused.body.error, /short-lived key/);
    const tried = await call("POST", "/api/tools/try", run, { name: "probe.change", arguments: {}, confirm: true });
    assert.notEqual(tried.body.status, "ran", `${decision}: a run key cannot confirm its own question`);
  }
  assert.deepEqual(ran, [], "the tool never ran");
  // The owner's own "try" still answers its own question, as before.
  assert.equal((await call("POST", "/api/policy", server.token, { rules: [{ tool: "probe.change", match: "*", decision: "ask" }], confirmLoosening: true })).status, 200); // Q257: from a refusal this loosens
  assert.equal((await call("POST", "/api/tools/try", server.token, { name: "probe.change", arguments: {}, confirm: true })).body.status, "ran");
  assert.equal((await call("POST", "/api/policy", server.token, { rules: [{ tool: "probe.change", match: "*", decision: "allow" }], confirmLoosening: true })).status, 200); // Q257: loosens
  const allowed = await call("POST", "/api/action", run, { tool: "probe.change", args: {} });
  assert.equal(allowed.status, 200, "a tool the rules allow still runs for a run key");
  assert.equal(ran.length, 2);
});
