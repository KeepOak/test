/**
 * Redesign security review: GET /api/activity (the new window's tasks popover, with ?waiting=1) lists the tasks of whoever
 * is at the window. With a household profile active it never shows the owner's tasks or what waits for the owner; back on
 * the owner's profile it does. A scripted model; nothing reaches a provider.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { savePolicy } from "../dist/policy.js";

test("a household profile's activity never lists the owner's tasks or what waits for the owner", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-activity-profile-"));
  const provider = { name: "scripted", async complete(request) {
    if (request.messages.at(-1)?.role === "tool") return { content: "ok", toolCalls: [] };
    return { content: "", toolCalls: [{ id: "w", name: "files.write", arguments: JSON.stringify({ path: "plan.txt", content: "x" }) }] };
  } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  savePolicy(app.store, app.runtime.owner, { preset: "custom", rules: [{ tool: "files.write", decision: "ask" }] });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const call = (method, path, body) => fetch(server.url + path, { method,
    headers: { authorization: "Bearer " + server.token, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) })
    .then(async (response) => ({ status: response.status, body: await response.json().catch(() => null) }));
  await app.runtime.run({ prompt: "OWNER PRIVATE: draft my resignation letter" });
  assert.match(JSON.stringify((await call("GET", "/api/activity?waiting=1")).body), /OWNER PRIVATE/, "the owner sees it");

  const person = (await call("POST", "/api/profiles", { name: "Sam", pin: "2468" })).body;
  assert.equal((await call("POST", "/api/profiles/switch", { profileId: person.id, pin: "2468" })).status, 200);
  const theirs = await call("GET", "/api/activity?waiting=1");
  assert.equal(theirs.status, 200);
  assert.doesNotMatch(JSON.stringify(theirs.body), /OWNER PRIVATE/, "a household profile never sees the owner's task");
  assert.doesNotMatch(JSON.stringify((await call("GET", "/api/activity")).body), /OWNER PRIVATE/);
});
