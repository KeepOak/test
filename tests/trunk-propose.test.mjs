/**
 * "Have Branch make a Trunk": the assistant proposes a Trunk with trunk.propose and the owner makes it.
 * The tool makes nothing, exists only while Trunks are on, and a Trunk itself never gets it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { call, fixture, on } from "./trunks-helpers.mjs";

const startedWith = (app, runId) => app.store.events(runId).find((e) => e.kind === "run.started").data.permissions;
const proposal = { name: "Quill", title: "Subscriptions and renewals", description: "Watches subscriptions and says before one renews.", why: "You asked for a Trunk for renewals." };
/* Proposes only when the request offers trunk.propose, as a real model can only call a tool it was given. */
const makeMe = ({ request, last }) => (last?.role === "user" && /^Make me a Trunk:/.test(last.content)
  && request.tools?.some((tool) => tool.name === "trunk.propose") ? call("trunk.propose", proposal) : null);

test("Branch answers 'Make me a Trunk' with a trunk.propose call that makes nothing", async (t) => {
  const { app } = await fixture(t, [makeMe]);
  on(app);
  const run = await app.runtime.run({ prompt: "Make me a Trunk: watch my subscriptions and tell me before anything renews." });
  assert.equal(run.status, "completed");
  const messages = app.store.messages(run.sessionId);
  const asked = messages.find((m) => m.role === "assistant" && m.toolCalls?.some((c) => c.name === "trunk.propose"));
  assert.ok(asked, "the proposal is kept in the conversation for the window's card");
  assert.deepEqual(JSON.parse(asked.toolCalls[0].arguments), proposal);
  const result = JSON.parse(messages.find((m) => m.role === "tool").content);
  assert.equal(result.ok, true);
  assert.equal(result.result.waitingForOwner, true);
  assert.equal(app.trunks.records.list().length, 0, "nothing is made until the owner says so");
});

test("with Trunks as they ship (when needed), the window's words 'Make me a Trunk:' offer Branch trunk.propose", async (t) => {
  const { app, provider } = await fixture(t);
  assert.equal(app.trunks.modes().trunks, "when-needed");
  await app.runtime.run({ prompt: "Make me a Trunk: watch my subscriptions and tell me before anything renews." });
  const first = provider.requests[0];
  assert.ok(first.tools.some((tool) => tool.name === "trunk.propose"), "loaded in full from the first round, so a real model can call it");
});

test("trunk.propose exists only while Trunks are on, and never in a Trunk's own tools", async (t) => {
  const { app } = await fixture(t);
  on(app);
  assert.ok(app.registry.names().includes("trunk.propose"));
  const ada = app.trunks.create({ name: "Ada" });
  await app.trunks.introduced();
  const run = await app.runtime.run({ prompt: "Hello", sessionId: ada.chatSessionId });
  assert.equal(startedWith(app, run.id).includes("trunks.propose"), false, "only Branch proposes a Trunk");
  app.trunks.setMode("trunks", { mode: "off" });
  assert.equal(app.registry.names().includes("trunk.propose"), false);
});
