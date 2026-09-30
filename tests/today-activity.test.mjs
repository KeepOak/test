// UI-268: Today's activity counts the owner's own tasks finished today in the owner's timezone, from this computer's
// window only; a bad timezone is refused, and nothing said in a task is shown.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

test("the owner's finished tasks today are counted by title only, and a bad timezone is refused", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-today-"));
  const provider = { name: "scripted", async complete() { return { content: "a private answer", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const call = (path, body) => fetch(server.url + path, { method: body ? "POST" : "GET",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  await call("/api/onboarding", { done: true });
  const ran = await (await call("/api/run", { prompt: "my private question" })).json();
  app.store.event(ran.id ?? ran.run?.id ?? ran.runId, "run.titled", { title: "Tax check" });
  await app.runtime.run({ prompt: "not from the window" }); // no window caller: not counted
  const today = await (await call(`/api/activity/today?timezone=${encodeURIComponent("UTC")}`)).json();
  assert.equal(today.count, 1, JSON.stringify(today));
  assert.doesNotMatch(JSON.stringify(today), /private question|private answer/);
  assert.equal((await call("/api/activity/today?timezone=Not%2FAZone")).status, 400);
});
