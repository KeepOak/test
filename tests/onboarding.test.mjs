import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

const answering = { name: "answering", calls: 0, async complete(request) {
  answering.calls += 1;
  assert.equal(request.tools.length, 0, "the test call carries no tools");
  return { content: "OK", toolCalls: [], usage: { input: 20, output: 1 } };
} };
const chatty = { name: "chatty", async complete() { return { content: "Hello there.", toolCalls: [], usage: { input: 20, output: 3 } }; } };
const broken = { name: "broken", async complete() { throw new Error("connection refused"); } };

async function fixture(t, presets) {
  const root = await mkdtemp(join(tmpdir(), "branch-onboard-"));
  const options = { workspace: join(root, "workspace"), dataDir: join(root, "data"), presets };
  const app = await createBranch(options);
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close().catch(() => undefined); await discardTemp(root); });
  const call = async (path, body) => {
    const response = await fetch(server.url + "/api/" + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: "Bearer " + server.token, origin: server.url, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, data: await response.json() };
  };
  return { app, call, options };
}

test("setup ends with a real test call and a remembered completion", async (t) => {
  const { app, call, options } = await fixture(t, [
    { id: "good", name: "Good model", provider: answering, model: "g-1" },
    { id: "bad", name: "Broken model", provider: broken, model: "b-1" },
  ]);
  assert.equal((await call("state")).data.onboarding.done, false);
  assert.equal((await call("state")).data.onboarding.done, false, "control");
  const ok = await call("models/test", {});
  assert.equal(ok.status, 200);
  assert.equal(ok.data.ok, true);
  assert.equal(ok.data.presetName, "Good model");
  assert.equal(ok.data.reply, "OK");
  assert.ok(ok.data.ms >= 0);
  assert.equal(answering.calls, 1);
  assert.equal(app.store.runs("local").length, 0, "the test call leaves no conversation behind");
  const failed = await call("models/test", { preset: "bad" });
  assert.equal(failed.status, 502);
  assert.match(failed.data.error, /Broken model did not answer/);
  assert.equal((await call("models/test", { preset: "nope" })).status, 400);
  assert.equal((await call("onboarding", { done: true })).data.done, true);
  assert.equal((await call("state")).data.onboarding.done, true);
  await app.close();
  const reopened = await createBranch(options);
  assert.equal(reopened.store.get("settings", "local", "onboarding").data.done, true, "completion survives restart");
  await reopened.close();
});

test("how far setup got is merged, kept, and never reset by a later write", async (t) => {
  const { app, call, options } = await fixture(t, [{ id: "good", name: "Good model", provider: chatty, model: "g-1" }]);
  const fresh = (await call("onboarding")).data;
  assert.deepEqual(fresh, { done: false, completed: [], trust: false, popups: true, welcomed: false, skipped: false, mine: true }, "control: nothing done yet");
  await call("onboarding", { trust: true, step: "where", completed: ["welcome"] });
  await call("onboarding", { where: "later", completed: ["where"], step: "models" });
  let view = (await call("onboarding")).data;
  assert.deepEqual(view.completed, ["welcome", "where"], "completed steps are added to, never replaced");
  assert.equal(view.step, "models");
  assert.equal(view.where, "later");
  assert.equal(view.trust, true);
  const firstTrust = view.trustAt;
  assert.ok(firstTrust, "when the box was ticked is kept");
  await call("onboarding", { trust: false, completed: [] });
  view = (await call("onboarding")).data;
  assert.equal(view.trust, true, "a ticked trust box stays ticked");
  assert.equal(view.trustAt, firstTrust);
  assert.deepEqual(view.completed, ["welcome", "where"]);
  assert.equal((await call("onboarding", { done: true })).data.step, "models", "{ done: true } alone keeps how far setup got");
  assert.equal((await call("onboarding", { step: "Nope!" })).status, 400, "a step name is checked");
  assert.equal((await call("onboarding", { anything: 1 })).status, 400, "an unknown field is refused");
  await call("onboarding", { done: false });
  await app.runtime.run({ prompt: "hello" });
  view = (await call("onboarding")).data;
  assert.equal(view.done, true, "control: the first real answer ends setup");
  assert.deepEqual(view.completed, ["welcome", "where"], "and keeps how far it got");
  assert.equal((await call("state")).data.onboarding.step, "models", "GET /api/state carries the same record");
  await app.close();
  const reopened = await createBranch(options);
  assert.equal(reopened.store.get("settings", "local", "onboarding").data.where, "later", "how far setup got survives a restart");
  await reopened.close();
});

test("with tips and pop-ups off, achievements are earned without a pop-up; household people cannot change setup", async (t) => {
  const { app, call } = await fixture(t, [{ id: "good", name: "Good model", provider: chatty, model: "g-1" }]);
  await call("delight/achievements"); // the first look finds the past quietly
  assert.equal((await call("onboarding", { popups: false })).data.popups, false);
  for (let i = 0; i < 3; i++) await app.runtime.run({ prompt: "hello " + i });
  const quiet = (await call("delight/achievements")).data;
  assert.deepEqual(quiet.fresh, [], "nothing to celebrate while pop-ups are off");
  assert.ok(quiet.earned > 0, "control: achievements are still earned and counted");
  await call("onboarding", { popups: true });
  assert.deepEqual((await call("delight/achievements")).data.fresh, [], "turning pop-ups back on brings no flood of old ones");
  const person = app.store.profiles.create({ name: "Sam", pin: "1234" });
  app.store.profiles.switch({ profileId: person.id, pin: "1234" });
  t.after(() => app.store.profiles.switch({ profileId: null }));
  const read = await call("onboarding");
  assert.ok(read.status >= 400 && read.status < 500, "a household person cannot read the owner's setup record (Q261: reads fail closed)");
  const theirs = (await call("state")).data.onboarding;
  assert.equal(theirs.mine, false, "their window's state says setup is not theirs");
  assert.deepEqual(theirs.completed, [], "and carries none of the owner's progress");
  assert.equal(theirs.popups, true);
  const refused = await call("onboarding", { popups: false });
  assert.ok(refused.status >= 400 && refused.status < 500, "a household person cannot change the owner's setup");
  assert.equal(app.store.get("settings", "local", "onboarding").data.popups, true, "and the owner's switch is as it was");
});

test("with pop-ups off, an achievement a settings change earns is not kept for later", async (t) => {
  const { saveDelightSettings } = await import("../dist/delight.js");
  const { app, call } = await fixture(t, [{ id: "good", name: "Good model", provider: chatty, model: "g-1" }]);
  await call("delight/achievements"); // the first look finds the past quietly
  assert.equal((await call("onboarding", { popups: false })).data.popups, false);
  saveDelightSettings(app.store, app.runtime.owner, { pets: { on: true, name: "Pip" } });
  const quiet = (await call("delight/achievements")).data;
  assert.deepEqual(quiet.fresh, [], "nothing pops while pop-ups are off");
  assert.ok(quiet.earned > 0, "control: the achievement is still earned");
  await call("onboarding", { popups: true });
  assert.deepEqual((await call("delight/achievements")).data.fresh, [], "and nothing earned while off pops once they are back on");
  saveDelightSettings(app.store, app.runtime.owner, { pets: { on: true, name: "Pim" }, look: { style: "3d" } });
  assert.ok((await call("delight/achievements")).data.fresh.length > 0, "control: with pop-ups on, a new one does pop");
});
