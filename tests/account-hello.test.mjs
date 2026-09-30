/* UP-UI-059: switching an account on in setup says hello through exactly that account, never another in its pool, and a
   switched-off account is refused. A stand-in provider and a fake fetch answer; nothing reaches a provider. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { accountsServiceFor } from "../dist/accounts/service.js";
import { addAccount, setMode, updateAccount } from "../dist/accounts/manage.js";

const POOL = "openai-test";
const SECOND_KEY = "sk-second-key-value-000000"; // not-a-real-secret

test("the setup hello goes through the chosen account only, and a switched-off account is refused", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-account-hello-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const service = accountsServiceFor(app.runtime.models), owner = app.runtime.owner;
  delete service.deps.policy; // the stand-in fetch below is the whole network
  app.store.save("settings", owner, "model-connections", { connections: [{ id: POOL, name: "OpenAI test", catalogId: "openai", model: "gpt-4o-mini", extras: {} }] });
  const calls = { first: 0, second: 0 };
  app.runtime.models.register({ id: POOL, name: "OpenAI test", model: "gpt-4o-mini", catalogId: "openai",
    provider: { name: "openai-chat", complete: async () => { calls.first++; return { content: "from the first key", toolCalls: [] }; } } });
  app.runtime.models.configure(owner, { activePreset: POOL });
  service.deps.fetchImpl = async (_url, init) => {
    assert.equal(new Headers(init.headers).get("authorization"), `Bearer ${SECOND_KEY}`);
    calls.second++;
    return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "OK" } }], usage: { prompt_tokens: 5, completion_tokens: 1 } }),
      { status: 200, headers: { "content-type": "application/json" } });
  };
  setMode(service, { mode: "on" });
  const second = (await addAccount(service, { pool: POOL, label: "Second", key: SECOND_KEY })).accounts.find((a) => a.label === "Second").id;
  let guarded = 0;
  const hello = await service.hello(POOL, second, () => { guarded++; });
  assert.deepEqual([hello.ok, hello.account, hello.accountLabel, hello.model, hello.reply], [true, second, "Second", "gpt-4o-mini", "OK"]);
  assert.deepEqual(calls, { first: 0, second: 1 }, "only the chosen account was asked");
  assert.ok(guarded >= 3, "the owner check is asked again across every wait");
  await updateAccount(service, { pool: POOL, account: second, disabled: true });
  await assert.rejects(service.hello(POOL, second, () => {}), /not available|disabled/);
  assert.equal(calls.second, 1);
});
