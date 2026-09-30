/* models-ui (MODEL-051): a specialist's own model (src/helper-defaults.ts) is used when a helper call names none, a model
   the call names still comes first, an account is kept only with the model it was saved for, a pinned helper keeps its
   route, and a bad pick is refused before anything is saved. Stand-in models only. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBranch } from "../dist/index.js";
import { withHelperDefault, helperDefaultFor } from "../dist/helper-defaults.js";
import { saveHelperDefault, helperDefaultsView } from "../dist/helper-defaults-api.js";
import { discardTemp } from "./temp-dir.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-helper-defaults-"));
  const provider = (name) => ({ name, async complete(request) {
    return { content: `${name} answered ${request.messages.filter((m) => m.role === "user").at(-1).content}`, toolCalls: [] };
  } });
  const presets = [
    { id: "alpha", name: "Alpha", model: "alpha-1", provider: provider("alpha") },
    { id: "beta", name: "Beta", model: "beta-2", provider: provider("beta") },
  ];
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), presets });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const owner = app.runtime.owner;
  const { id } = await app.registry.execute("specialists.propose", {
    name: "Reviewer", instructions: "You review.", permissions: ["files.read"],
    evaluation: { prompt: "say ready", checks: [{ path: "reviewer.txt", expected: "ready" }] },
  }, app.runtime.context());
  const save = (input) => saveHelperDefault(app.store, owner, app.runtime.models, { specialist: id, ...input });
  return { app, owner, id, save };
}

test("a specialist's saved model answers its helpers, and a model the call names comes first", async (t) => {
  const { app, id, save } = await fixture(t);
  app.runtime.models.configure(app.runtime.owner, { activePreset: "alpha" });
  const parent = await app.runtime.run({ prompt: "parent" });
  const context = app.runtime.context({ runId: parent.id });
  let child = await app.runtime.delegate("check it", context, [], "", { agent: id });
  assert.match(child.output, /^alpha answered/, "nothing saved: the helper keeps the usual route");
  save({ model: "beta" });
  child = await app.runtime.delegate("check it", context, [], "", { agent: id });
  assert.match(child.output, /^beta answered/, "the specialist's own model");
  child = await app.runtime.delegate("check it", context, [], "", { agent: id, model: "alpha" });
  assert.match(child.output, /^alpha answered/, "the call's own model comes first");
  const other = await app.runtime.delegate("check it", context, [], "", {});
  assert.match(other.output, /^alpha answered/, "another helper is not touched");
});

test("a pinned helper keeps its route after its specialist's default changes", async (t) => {
  const { app, id, save } = await fixture(t);
  const parent = await app.runtime.run({ prompt: "parent" });
  save({ model: "beta" });
  const child = await app.runtime.delegate("first", app.runtime.context({ runId: parent.id }), [], "", { agent: id });
  assert.match(child.output, /^beta answered/);
  save({ model: "alpha" });
  const follow = await app.runtime.run({ prompt: "carry on", sessionId: child.sessionId });
  assert.match(follow.output, /^beta answered/);
});

test("an account is kept only with the model it was saved for, and a bad pick is refused before saving", async (t) => {
  const { app, owner, id, save } = await fixture(t);
  const ref = { pool: "cli-claude-code", account: "aaaaaaaa" };
  const saved = { model: "beta", accountRef: ref };
  const has = () => true;
  assert.deepEqual(withHelperDefault({}, saved, has), saved);
  assert.deepEqual(withHelperDefault({ model: "beta" }, saved, has), saved);
  assert.deepEqual(withHelperDefault({ model: "alpha" }, saved, has), { model: "alpha" }, "never handed to another connection");
  assert.deepEqual(withHelperDefault({}, saved, () => false), {}, "a model no longer registered is left out");
  const own = { accountRef: { pool: "alpha", account: "primary" } };
  assert.deepEqual(withHelperDefault(own, saved, has), own, "a call naming its own account keeps its route whole");
  assert.throws(() => save({ model: "missing" }), /Unknown helper model/);
  assert.throws(() => save({ model: "beta", accountRef: ref }), /not one of this model connection's accounts/);
  assert.throws(() => saveHelperDefault(app.store, owner, app.runtime.models, { specialist: "00000000-0000-4000-8000-000000000000", model: "beta" }), /no specialist/);
  assert.equal(helperDefaultFor(app.store, owner, id), null, "nothing was saved by the refusals");
  save({ model: "beta" });
  assert.deepEqual(helperDefaultsView(app.store, owner, app.runtime.models).specialists, { [id]: { model: "beta" } });
  save({ model: null });
  assert.equal(helperDefaultFor(app.store, owner, id), null, "cleared");
});

test("work a Trunk is doing keeps to the Trunk's own account, never the specialist's saved one", async (t) => {
  const { accountsServiceFor } = await import("../dist/accounts/service.js");
  const { addAccount, setMode } = await import("../dist/accounts/manage.js");
  const root = await mkdtemp(join(tmpdir(), "branch-helper-defaults-trunk-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const owner = app.runtime.owner, POOL = "openai-test";
  app.store.save("settings", owner, "model-connections", { connections: [{ id: POOL, name: "OpenAI test", catalogId: "openai", model: "gpt-4o-mini", extras: {} }] });
  app.runtime.models.register({ id: POOL, name: "OpenAI test", model: "gpt-4o-mini", catalogId: "openai",
    provider: { name: "openai-chat", complete: async () => ({ content: "from the first key", toolCalls: [] }) } });
  app.runtime.models.configure(owner, { activePreset: POOL });
  const service = accountsServiceFor(app.runtime.models);
  delete service.deps.policy;
  service.deps.fetchImpl = async (_url, init) => JSON.parse(String(init.body)).stream
    ? new Response(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", content: "from the second key" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } })
    : new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "from the second key" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200, headers: { "content-type": "application/json" } });
  setMode(service, { mode: "on" });
  const second = (await addAccount(service, { pool: POOL, label: "Second", key: "sk-second-key-value-000000" })).accounts.find((a) => a.label === "Second").id; // not-a-real-secret
  for (const part of ["trunks", "rooms", "routines"]) app.trunks.setMode(part, { mode: "on" });
  const ed = app.trunks.create({ name: "Ed" });
  app.trunks.edit(ed.id, { keys: { copyFromOwner: false, accounts: { [POOL]: second } } });
  await app.trunks.introduced();
  const { id } = await app.registry.execute("specialists.propose", { name: "Reviewer", instructions: "You review.", permissions: ["files.read"],
    evaluation: { prompt: "say ready", checks: [{ path: "reviewer.txt", expected: "ready" }] } }, app.runtime.context());
  saveHelperDefault(app.store, owner, app.runtime.models, { specialist: id, model: POOL, accountRef: { pool: POOL, account: "primary" } });

  const own = await app.runtime.run({ prompt: "parent" });
  const mine = await app.runtime.delegate("check it", app.runtime.context({ runId: own.id }), [], "", { agent: id });
  assert.equal(mine.output, "from the first key", "the owner's own helper uses the saved account");
  const chat = await app.runtime.run({ prompt: "parent", sessionId: ed.chatSessionId });
  assert.equal(chat.output, "from the second key", "the Trunk answers with its own pick");
  const helper = await app.runtime.delegate("check it", app.runtime.context({ runId: chat.id }), [], "", { agent: id });
  assert.equal(helper.output, "from the second key", "the Trunk's helper keeps the Trunk's account, not the saved one");
});
