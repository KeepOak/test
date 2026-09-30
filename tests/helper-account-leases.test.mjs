/**
 * MODEL-050: helpers working side by side spread over a connection's accounts. Each helper no account was named for
 * leases the least-leased ready account (Hermes Agent's acquire_lease, one job per account by default) and gives it
 * back when it ends. Every service here is a stand-in.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { accountsServiceFor } from "../dist/accounts/service.js";
import { addAccount, setMode, updatePool } from "../dist/accounts/manage.js";
import { AccountLeases } from "../dist/accounts/leases.js";

const POOL = "openai-test";
const SECOND_KEY = "sk-second-key-value-000000"; // not-a-real-secret

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-leases-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  let open;
  const gate = new Promise((resolve) => { open = resolve; });
  t.after(async () => { open(); await app.close(); await discardTemp(root); });
  const service = accountsServiceFor(app.runtime.models);
  delete service.deps.policy; // the stand-in fetch below is the whole network
  const owner = app.runtime.owner, seen = [];
  const held = async (who, prompt) => { if (prompt.startsWith("held")) { seen.push(who); await gate; } };
  app.store.save("settings", owner, "model-connections", { connections: [{ id: POOL, name: "OpenAI test", catalogId: "openai", model: "gpt-4o-mini", extras: {} }] });
  app.runtime.models.register({ id: POOL, name: "OpenAI test", model: "gpt-4o-mini", catalogId: "openai", provider: { name: "openai-chat", async complete(request) {
    const prompt = request.messages.filter((message) => message.role === "user").at(-1).content;
    await held("first", prompt);
    return { content: "from the first key", toolCalls: [] };
  } } });
  app.runtime.models.configure(owner, { activePreset: POOL });
  service.deps.fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    await held("second", body.messages.filter((message) => message.role === "user").at(-1).content);
    return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "from the second key" } }], usage: { prompt_tokens: 10, completion_tokens: 10 } }),
      { status: 200, headers: { "content-type": "application/json" } });
  };
  setMode(service, { mode: "on" });
  await addAccount(service, { pool: POOL, label: "Second", key: SECOND_KEY });
  const parent = await app.runtime.run({ prompt: "parent" });
  const helpers = () => [1, 2].map((n) => app.runtime.delegate(`held helper ${n}`, app.runtime.context({ runId: parent.id }), [], "", { model: POOL }));
  const started = async (count) => {
    for (let tries = 0; tries < 400 && seen.length < count; tries++) await new Promise((done) => setTimeout(done, 5));
  };
  return { app, service, seen, open, helpers, started };
}

test("two parallel helpers take two different accounts, and give them back when they end", async (t) => {
  const f = await fixture(t);
  const running = f.helpers();
  await f.started(2);
  assert.deepEqual([...f.seen].sort(), ["first", "second"], "one helper on each key, not both on the conversation's");
  f.open();
  const runs = await Promise.all(running);
  assert.deepEqual(runs.map((run) => run.status), ["completed", "completed"]);
  assert.deepEqual(runs.map((run) => run.output).sort(), ["from the first key", "from the second key"]);
  const pool = f.service.pool(POOL);
  assert.deepEqual(pool.accounts.map((account) => f.service.leases.count(POOL, account.id)), [0, 0], "every lease was given back");
});

test("jobs per account is the owner's to raise; a lease never blocks when every account is busy", async (t) => {
  const f = await fixture(t);
  updatePool(f.service, { pool: POOL, jobsPerAccount: 2 });
  assert.equal(f.service.pool(POOL).jobsPerAccount, 2);
  const running = f.helpers();
  await f.started(2);
  assert.deepEqual(f.seen, ["first", "first"], "with room for two jobs, both helpers stay on the conversation's key");
  f.open();
  await Promise.all(running);
  const leases = new AccountLeases();
  const one = leases.acquire("p", ["a", "b"]), two = leases.acquire("p", ["a", "b"]), three = leases.acquire("p", ["a", "b"]);
  assert.deepEqual([one.account, two.account, three.account], ["a", "b", "a"], "least leased first; when all are full, still handed out");
  three.release(); three.release();
  assert.equal(leases.count("p", "a"), 1, "a release gives back once, however often it is called");
});
