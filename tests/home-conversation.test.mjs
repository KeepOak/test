// UI-272: Home pins one saved conversation the owner chose, or a new empty one; a conversation holding work that did
// not start in the owner's window cannot be pinned, and unpinning changes nothing else.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

test("Home pins a new or chosen window conversation, refuses one with outside work, and unpins", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-home-conv-"));
  const provider = { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const call = (body) => fetch(server.url + "/api/home-conversation", { method: body ? "POST" : "GET",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  assert.equal((await (await call()).json()).pinned, null);
  const made = await (await call({ action: "create" })).json();
  assert.ok(made.pinned?.sessionId, JSON.stringify(made));
  const outside = await app.runtime.run({ prompt: "started by a script, not the window" });
  const refused = await call({ action: "pin", sessionId: outside.sessionId });
  assert.equal(refused.status, 400);
  assert.equal((await (await call()).json()).pinned.sessionId, made.pinned.sessionId, "the earlier pin stays");
  assert.equal((await (await call({ action: "unpin" })).json()).pinned, null);
});
