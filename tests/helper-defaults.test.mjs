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
  assert.throws(() => save({ model: "missing" }), /Unknown helper model/);
  assert.throws(() => save({ model: "beta", accountRef: ref }), /not one of this model connection's accounts/);
  assert.throws(() => saveHelperDefault(app.store, owner, app.runtime.models, { specialist: "00000000-0000-4000-8000-000000000000", model: "beta" }), /no specialist/);
  assert.equal(helperDefaultFor(app.store, owner, id), null, "nothing was saved by the refusals");
  save({ model: "beta" });
  assert.deepEqual(helperDefaultsView(app.store, owner, app.runtime.models).specialists, { [id]: { model: "beta" } });
  save({ model: null });
  assert.equal(helperDefaultFor(app.store, owner, id), null, "cleared");
});
