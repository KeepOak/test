/**
 * The lead's workbench (SELF-303): a helper keeps its context. A helper that finished, or that the lead stopped, is
 * carried on by a message: it works again in its own conversation, with its brief and everything it already said in
 * front of it, on the model and account it was pinned to, never with more tools than it had, and the lead is told
 * when it finishes again.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { createBranch } from "../dist/index.js";
import { discardTemp } from "./temp-dir.mjs";

const until = async (check, ms = 20000) => {
  for (const end = Date.now() + ms; Date.now() < end; await wait(50)) if (check()) return true;
  return false;
};
const call = (name, args, id) => ({ content: "", toolCalls: [{ id, name, arguments: JSON.stringify(args) }] });

async function fixture(t, { holdFirst = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-helper-resume-"));
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const seen = { helperRequests: [], leadPrompts: [] };
  const provider = { name: "scripted", async complete(request) {
    const system = request.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
    const last = request.messages.filter((m) => m.role !== "system" && !String(m.content).startsWith("<system-reminder>")).at(-1);
    if (/You are a helper working in the background/.test(system)) {
      seen.helperRequests.push(request.messages.map((m) => `${m.role}: ${m.content}`).join("\n"));
      const carriedOn = request.messages.some((m) => m.role === "user" && /Carry on from where you stopped/.test(m.content));
      if (!carriedOn && holdFirst) {
        await new Promise((resolve, reject) => { gate.then(resolve); request.signal?.addEventListener("abort", () => reject(request.signal.reason), { once: true }); });
      }
      return { content: carriedOn ? "Fixed shard linux 3 as asked." : "Found the failing shard: linux 3. SHARD-NOTE-7781", toolCalls: [] };
    }
    if (last?.role === "user") seen.leadPrompts.push(last.content);
    if (last?.role === "user" && /Fix CI/.test(last.content)) return call("helpers.start", { brief: "Find the failing CI shard.", minutes: 5 }, "start");
    return { content: "Carrying on.", toolCalls: [] };
  } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  t.after(async () => { release(); await app.close(); await discardTemp(root); });
  return { app, seen, release };
}

test("a finished helper carries on in its own conversation, with what it did in front of it, when the lead messages it", async (t) => {
  const { app, seen } = await fixture(t);
  const lead = await app.runtime.run({ prompt: "Fix CI", mode: "full" });
  const helper = app.store.events(lead.id).find((event) => event.kind === "delegation.background_started").data.childRunId;
  assert.ok(await until(() => app.store.run(helper).status === "completed"));
  assert.ok(await until(() => seen.leadPrompts.some((p) => /SHARD-NOTE-7781/.test(p))), "the lead heard the first report");
  const later = () => app.store.runs(app.runtime.owner).find((one) => one.sessionId === lead.sessionId && one.id !== lead.id);
  assert.ok(await until(() => later() && app.store.run(later().id).status === "completed"));
  const context = app.runtime.context({ runId: later().id });
  const resumed = await app.registry.execute("helpers.message", { helper, text: "Now fix it." }, context);
  assert.equal(resumed.resumed, true);
  assert.equal(resumed.from, helper);
  assert.notEqual(resumed.helper, helper);
  assert.ok(await until(() => app.store.run(resumed.helper)?.status === "completed"));
  const again = app.store.run(resumed.helper);
  assert.equal(again.sessionId, app.store.run(helper).sessionId, "it carries on in its own conversation");
  const sent = seen.helperRequests.at(-1);
  assert.match(sent, /Find the failing CI shard/, "its brief is still in front of it");
  assert.match(sent, /SHARD-NOTE-7781/, "what it said before is still in front of it");
  assert.match(sent, /Carry on from where you stopped:\nNow fix it\./);
  const permissions = app.store.events(resumed.helper).find((event) => event.kind === "run.started").data.permissions;
  const before = app.store.events(helper).find((event) => event.kind === "run.started").data.permissions;
  assert.ok(permissions.every((one) => before.includes(one)), "never more than it had");
  assert.ok(await until(() => seen.leadPrompts.some((p) => /Fixed shard linux 3 as asked/.test(p))), "the lead is told when it finishes again");
  const listed = (await app.registry.execute("helpers.list", {}, app.runtime.context({ runId: later().id }))).helpers;
  assert.deepEqual(listed.map((one) => [one.helper, one.continues ?? null]), [[helper, null], [resumed.helper, helper]]);
});

test("the lead stops a working helper and later carries it on; nobody else can do either", async (t) => {
  const { app, seen } = await fixture(t, { holdFirst: true });
  const lead = await app.runtime.run({ prompt: "Fix CI", mode: "full" });
  const helper = app.store.events(lead.id).find((event) => event.kind === "delegation.background_started").data.childRunId;
  assert.ok(await until(() => seen.helperRequests.length === 1));
  const other = await app.runtime.run({ prompt: "something else" });
  const otherContext = app.runtime.context({ runId: other.id });
  await assert.rejects(app.registry.execute("helpers.stop", { helper }, otherContext), /no helper with that number/);
  const context = app.runtime.context({ runId: lead.id });
  assert.deepEqual(await app.registry.execute("helpers.stop", { helper }, context), { stopped: true });
  assert.ok(await until(() => app.store.run(helper).status !== "running"));
  await assert.rejects(app.registry.execute("helpers.message", { helper, text: "go on" }, otherContext), /no helper with that number/);
  const resumed = await app.registry.execute("helpers.message", { helper, text: "Go on, then fix it." }, context);
  assert.equal(resumed.resumed, true);
  assert.ok(await until(() => app.store.run(resumed.helper)?.status === "completed"));
  assert.equal(app.store.run(resumed.helper).output, "Fixed shard linux 3 as asked.");
  assert.match(seen.helperRequests.at(-1), /Find the failing CI shard/);
});

test("only a helper's own conversation can be carried on as one", async (t) => {
  const { app } = await fixture(t);
  const lead = await app.runtime.run({ prompt: "hello", mode: "full" });
  const context = app.runtime.context({ runId: lead.id });
  await assert.rejects(app.runtime.delegateBackground("x", context, [], "", { sessionId: lead.sessionId }), /not a helper's own/);
});
