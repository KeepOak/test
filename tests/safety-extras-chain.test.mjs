/**
 * mac7/r17-g (R17-066): the tamper-evident chain over what happened, and its verify command.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { ActivityChain, chainEventFor, genesisHash } from "../dist/safety-extras/activity-chain.js";
import { activityCommand } from "../dist/safety-extras/cli.js";
import { cliCommands } from "../dist/cli-completion.js";

function filled() {
  const db = new DatabaseSync(":memory:");
  const chain = new ActivityChain(db);
  for (const kind of ["approval.decided", "policy.denied", "tool.started"]) chain.append("local", { kind, runId: "r1", detail: `about ${kind}`, outcome: "done" });
  return { db, chain };
}
const tamper = (db, sql) => {
  db.exec("DROP TRIGGER activity_chain_no_update; DROP TRIGGER activity_chain_no_delete;");
  db.exec(sql);
};

test("each entry follows the one before, and the database refuses edits", () => {
  const { db, chain } = filled();
  const [newest, , oldest] = chain.list("local");
  assert.equal(oldest.prev, genesisHash);
  assert.equal(newest.seq, 2);
  assert.deepEqual(chain.verify("local"), { ok: true, entries: 3, tip: newest.hash, brokenAt: null, reason: "Every entry follows the one before it." });
  assert.deepEqual(chain.summary("local"), { entries: 3, tip: newest.hash });
  assert.throws(() => db.exec("UPDATE activity_chain SET detail='x' WHERE seq=1"), /cannot be changed/);
  assert.throws(() => db.exec("DELETE FROM activity_chain WHERE seq=1"), /cannot be removed/);
  assert.equal(chain.verify("somebody-else").entries, 0, "each owner has a chain of their own");
  assert.equal(chain.verify("local", newest.hash).ok, true);
  assert.equal(chain.verify("local", "f".repeat(64)).ok, false, "a fingerprint written down elsewhere must still be there");
});

test("a changed, removed or rebuilt entry is found", () => {
  let { db, chain } = filled();
  tamper(db, "UPDATE activity_chain SET detail='nothing to see' WHERE seq=1");
  assert.deepEqual({ ...chain.verify("local"), tip: undefined }, { ok: false, entries: 1, tip: undefined, brokenAt: 1, reason: "entry 1 was changed after it was written" });
  ({ db, chain } = filled());
  tamper(db, "DELETE FROM activity_chain WHERE seq=1");
  assert.equal(chain.verify("local").reason, "entry 1 is missing");
  ({ db, chain } = filled());
  const tip = chain.summary("local").tip;
  tamper(db, "DELETE FROM activity_chain WHERE seq=2");
  const fresh = new ActivityChain(db);
  fresh.append("local", { kind: "tool.started", runId: "r1", detail: "a different story", outcome: "done" });
  assert.equal(fresh.verify("local").ok, true, "a rebuilt tail hangs together on its own");
  assert.equal(fresh.verify("local", tip).ok, false, "but the fingerprint written down earlier is gone");
});

test("what goes in: refusals always, tools only when on, never the arguments", () => {
  assert.equal(chainEventFor("tool.started", { name: "files.read" }, false), null);
  assert.equal(chainEventFor("model.completed", {}, true), null);
  const denied = chainEventFor("policy.denied", { name: "shell.execute", label: "Running a command", secret: "hunter2" }, false);
  assert.match(denied.detail, /^shell\.execute — Running a command \[[a-f0-9]{16}\]$/);
  assert.equal(denied.detail.includes("hunter2"), false);
  assert.equal(chainEventFor("tool.completed", { name: "files.read", result: "text" }, true).outcome, "completed");
});

test("the verify command says it plainly and answers with an exit code", () => {
  const { db, chain } = filled();
  const lines = [];
  assert.equal(activityCommand(chain, "local", ["verify"], (text) => lines.push(text)), 0);
  assert.match(lines.pop(), /^The activity record is unbroken: 3 entries\. Latest hash: [a-f0-9]{64}$/);
  assert.equal(activityCommand(chain, "local", ["verify", "--json"], (text) => lines.push(text)), 0);
  assert.equal(JSON.parse(lines.pop()).entries, 3);
  assert.equal(activityCommand(chain, "local", ["verify", "--tip", "nope"], (text) => lines.push(text)), 2);
  assert.equal(activityCommand(chain, "local", [], (text) => lines.push(text)), 2);
  tamper(db, "UPDATE activity_chain SET outcome='fine' WHERE seq=0");
  assert.equal(activityCommand(chain, "local", ["verify"], (text) => lines.push(text)), 1);
  assert.match(lines.pop(), /broken at entry 0/);
  assert.ok(cliCommands.some((command) => command.name === "activity"));
});

test("inside the app: ships when needed; switched off writes nothing; when needed follows the record and refusals; on adds tools", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-safety-chain-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"),
    provider: { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } } });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const api = async (method, path, body) => (await fetch(server.url + path, { method,
    headers: { authorization: `Bearer ${server.token}`, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) })).json();
  const owner = app.runtime.owner, chain = app.safetyExtras.chain;
  const runId = app.store.createRun(owner, "a task").id;
  assert.equal((await api("GET", "/api/safety-extras")).modes["activity-chain"], "when-needed", "ships when needed");
  await api("POST", "/api/safety-extras/switch", { part: "activity-chain", mode: "off" });
  const offBase = chain.summary(owner).entries;
  app.store.audit.record(owner, { action: "policy.changed", subject: "before", outcome: "saved" });
  app.store.event(runId, "policy.denied", { name: "shell.execute" });
  assert.equal(chain.summary(owner).entries, offBase, "off: nothing is written");
  await api("POST", "/api/safety-extras/switch", { part: "activity-chain", mode: "when-needed" });
  const before = chain.summary(owner).entries;
  app.store.event(runId, "tool.started", { name: "files.read" });
  app.store.event(runId, "policy.denied", { name: "shell.execute", label: "Running a command" });
  app.store.audit.record(owner, { action: "approval.decided", subject: "shell.execute", reason: "yes", outcome: "allowed" });
  const kinds = chain.list(owner).slice(0, chain.summary(owner).entries - before).map((entry) => entry.kind);
  assert.deepEqual(kinds, ["approval.decided", "policy.denied"]);
  await api("POST", "/api/safety-extras/switch", { part: "activity-chain", mode: "on" });
  app.store.event(runId, "tool.started", { name: "files.read" });
  assert.equal(chain.list(owner, 1)[0].kind, "tool.started");
  const overview = await api("GET", "/api/safety-extras");
  assert.deepEqual(overview.chain, chain.summary(owner));
  const checked = await api("POST", "/api/safety-extras/activity/verify", { tip: overview.chain.tip });
  assert.equal(checked.check.ok, true, JSON.stringify(checked));
  const listed = await api("GET", "/api/safety-extras/activity?limit=2");
  assert.equal(listed.entries.length, 2);
});
