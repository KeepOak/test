import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";

const say = (content) => ({ content, toolCalls: [] });
const call = (name, args) => ({ content: "", toolCalls: [{ id: `c${Math.random().toString(36).slice(2, 9)}`, name, arguments: JSON.stringify(args) }] });

/* TRUNK-190: each kind of handed-over work has its own action (Done, I've signed it, Finish now, Stop waiting), and the
   engine refuses an action that does not match the kind it saved. */
async function fixture(t, first) {
  const root = await mkdtemp(join(tmpdir(), "branch-deferred-kinds-"));
  let round = 0;
  const provider = { name: "scripted", async complete(request) {
    const user = [...request.messages].reverse().find((m) => m.role === "user")?.content ?? "";
    if (/handed over earlier/.test(user)) return say(`picked up: ${user}`);
    round++;
    return round === 1 ? first : say("Carried on.");
  } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  app.coding.setMode("read-first", "off");
  t.after(async () => { await app.close(); await discardTemp(root); });
  return app;
}
async function followUp(app, runId) {
  for (let at = 0; at < 200; at++) {
    const next = app.store.runs(app.runtime.owner).find((run) => run.id !== runId && run.status !== "running");
    if (next) return next;
    await delay(20);
  }
  throw new Error("no follow-up task");
}

test("a signing step is settled only with I've signed it, and says Branch did not verify it", async (t) => {
  const app = await fixture(t, call("user.task", { description: "sign the lease", kind: "signing" }));
  const run = await app.runtime.run({ prompt: "get the lease signed" });
  const [waiting] = app.runtime.deferrals.list({ waiting: true });
  assert.equal(waiting.kind, "signing");
  assert.throws(() => app.runtime.settleDeferred(waiting.id, undefined, "done"), /does not match/);
  assert.equal(app.runtime.deferrals.list({ waiting: true }).length, 1, "a refused action leaves it waiting");
  app.runtime.settleDeferred(waiting.id, undefined, "signed");
  const next = await followUp(app, run.id);
  assert.match(app.store.run(next.id).output, /reports that they signed it\. Branch did not perform or verify the signing\./);
  assert.throws(() => app.runtime.settleDeferred(waiting.id, undefined, "signed"), /already been answered/);
});

test("work set aside with user.later is continued with Finish now and is not claimed finished", async (t) => {
  const app = await fixture(t, call("user.later", { description: "write the second chapter" }));
  const run = await app.runtime.run({ prompt: "leave chapter two for later" });
  const [waiting] = app.runtime.deferrals.list({ waiting: true });
  assert.equal(waiting.kind, "later");
  assert.throws(() => app.runtime.settleDeferred(waiting.id, undefined, "stop"), /does not match/);
  app.runtime.settleDeferred(waiting.id, undefined, "finish");
  const next = await followUp(app, run.id);
  assert.match(app.store.run(next.id).output, /is ready to continue now/);
  assert.match(app.store.run(next.id).output, /It is still unfinished\./);
});

test("an older job saved without a kind keeps its action by its tool", async (t) => {
  const app = await fixture(t, say("nothing"));
  const saved = app.runtime.deferrals.open({ id: "old-job", runId: "", sessionId: app.store.createRun(app.runtime.owner, "x").sessionId,
    tool: "web.crawl", description: "check a page by hand" });
  assert.equal(saved.kind, "manual");
  const service = app.runtime.deferrals.open({ id: "old-service", runId: "", sessionId: saved.sessionId, tool: "mcp.remote", description: "" });
  assert.equal(service.kind, "service");
});
