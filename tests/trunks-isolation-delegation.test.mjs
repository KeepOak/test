/**
 * FQ-routing.isolated-agents (NAS caa1843): one Trunk must never reach another Trunk's memory one
 * delegation away, nor another Trunk's kept file bytes through workspace.undo.
 *
 * A specialist runs with `agent` set to its own id, so every Trunk's hand-off to one specialist used to
 * share one `agent:<specialist>` memory scope: what Ada's researcher saved, Bo's researcher found. And
 * workspace.undo read the kept versions of a conversation without asking which scope kept them, so a
 * conversation the owner re-chose from Ada to Bo handed Bo the bytes Ada's own Trunk Chat had written.
 * Everything here goes through real Trunk turns (`trunks.say`, a started conversation), a scripted model
 * and the real tools, never a helper the fix adds.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { call, fixture, on } from "./trunks-helpers.mjs";

const secret = "SECRETXYZZY4417";

/** The owner makes a specialist, evaluated and promoted, as tests/orchestration.test.mjs does. */
async function specialist(app, name, permissions) {
  const context = app.runtime.context();
  const proposed = await app.registry.execute("specialists.propose", {
    name, instructions: `You are the ${name}.`, permissions,
    evaluation: { prompt: "say ready", checks: [{ path: `${name}.txt`, expected: "ready" }] },
  }, context);
  await writeFile(join(app.runtime.workspace, `${name}.txt`), "ready");
  await app.registry.execute("specialists.evaluate", { id: proposed.id }, context);
  await app.registry.execute("specialists.promote", { id: proposed.id }, context);
  return proposed.id;
}

/** Q119: a workflow a Trunk made during its own work, saved as that Trunk's tool call would save it. */
async function madeBy(app, trunk, definition) {
  const { withAccountCall } = await import("../dist/accounts/context.js");
  return withAccountCall({ owner: app.runtime.owner, sessionId: "", runId: "", trunk: { keys: trunk.keys, id: trunk.id } },
    async () => app.registry.execute("workflows.create", definition, app.runtime.context()));
}

const lastEvent = (app) => Number(app.store.sqlite.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM events").get().id);
/** Every result (or error) of one tool since event `after`, oldest first, as text. */
function outcomesSince(app, after, name) {
  return app.store.sqlite.prepare("SELECT kind, data FROM events WHERE id > ? AND kind IN ('tool.completed','tool.failed') ORDER BY id")
    .all(after).map((row) => JSON.parse(row.data)).filter((data) => data.name === name)
    .map((data) => JSON.stringify(data.result ?? data.error ?? null));
}
/** Waits for background specialists: until no task is still running. */
async function settled(app) {
  for (let tries = 0; tries < 200; tries++) {
    if (!app.store.sqlite.prepare("SELECT 1 FROM tasks WHERE status IN ('running','queued') LIMIT 1").get()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("a task never finished");
}

/**
 * A Trunk's turn "<how>: <brief>" sends the brief to the researcher by that route; the researcher saves
 * "remember …" and searches "recall …", then says what the tool gave back.
 */
function rules(ids) {
  const route = {
    handoff: (brief) => call("delegate.handoff", { specialist: ids.researcher, brief }),
    parallel: (brief) => call("delegate.parallel", { tasks: [{ specialist: ids.researcher, prompt: brief }] }),
    delegate: (brief) => call("specialists.delegate", { id: ids.researcher, prompt: brief }),
    background: (brief) => call("specialists.delegate", { id: ids.researcher, prompt: brief, background: true }),
    onward: (brief) => call("delegate.handoff", { specialist: ids.writer, brief }),
  };
  return [({ system, last }) => {
    if (!/You are the (researcher|writer)/.test(system)) return null;
    if (last?.role === "tool") return `Found: ${last.content}`;
    const text = String(last?.content ?? "");
    if (text.startsWith("remember ")) return call("memory.put", { text: text.slice("remember ".length), source: "the researcher" });
    if (text.startsWith("recall ")) return call("memory.search", { query: text.slice("recall ".length) });
    if (text.startsWith("share ")) return call("memory.put", { text: text.slice("share ".length), source: "the researcher", scope: "shared" });
    if (text.startsWith("onward: ")) return route.onward(text.slice("onward: ".length));
    return null;
  }, ({ last }) => {
    if (last?.role === "tool") return "Done.";
    const text = String(last?.content ?? ""), at = text.indexOf(": ");
    return at > 0 ? route[text.slice(0, at)]?.(text.slice(at + 2)) ?? null : null;
  }];
}

async function twoTrunks(t, extra = {}) {
  const ids = {};
  const { app } = await fixture(t, rules(ids));
  on(app);
  ids.researcher = await specialist(app, "researcher", ["memory.read", "memory.write", "specialists.use"]);
  ids.writer = await specialist(app, "writer", ["memory.read"]);
  const ada = app.trunks.create({ name: "Ada" }), bo = app.trunks.create({ name: "Bo" });
  for (const trunk of [ada, bo])
    app.trunks.edit(trunk.id, { permissions: ["specialists.use", "memory.read", "memory.write"], ...extra });
  await app.trunks.introduced();
  const say = async (trunk, text) => { await app.trunks.say(trunk.id, text); await settled(app); };
  return { app, ids, ada, bo, say };
}

for (const how of ["handoff", "parallel", "delegate", "background"]) {
  test(`a specialist a Trunk works through (${how}) keeps that Trunk's facts from every other Trunk`, async (t) => {
    const { app, ada, bo, say } = await twoTrunks(t);
    await say(ada, `${how}: remember Launch code ${secret}`);
    let after = lastEvent(app);
    await say(bo, `${how}: recall launch code`);
    const bos = outcomesSince(app, after, "memory.search");
    assert.equal(bos.length, 1, "Bo's researcher searched");
    assert.doesNotMatch(bos[0], new RegExp(secret), "Bo's researcher never finds what Ada's saved");
    assert.equal(bos[0], "[]", "an empty answer, not an error");
    after = lastEvent(app);
    await say(ada, `${how}: recall launch code`);
    const adas = outcomesSince(app, after, "memory.search");
    assert.equal(adas.length, 1, "Ada's researcher searched");
    assert.match(adas[0], new RegExp(secret), "Ada's researcher still finds its own fact");
  });
}

test("the owner's own specialist keeps the memory it always had, apart from every Trunk's", async (t) => {
  const { app, ids, ada, say } = await twoTrunks(t);
  const ownerSays = async (text) => {
    const parent = await app.runtime.run({ prompt: "owner" });
    await app.registry.execute("delegate.handoff", { specialist: ids.researcher, brief: text }, app.runtime.context({ runId: parent.id }));
  };
  await ownerSays(`remember Owner code ${secret}`);
  const saved = app.store.list("memory", app.runtime.owner).find((record) => String(record.data.text).includes(secret));
  assert.equal(saved.data.scope, `agent:${ids.researcher}`, "the key the owner's specialist always used");
  let after = lastEvent(app);
  await say(ada, "handoff: recall owner code");
  assert.doesNotMatch(outcomesSince(app, after, "memory.search")[0], new RegExp(secret), "Ada's researcher is not the owner's");
  after = lastEvent(app);
  await ownerSays("recall owner code");
  assert.match(outcomesSince(app, after, "memory.search")[0], new RegExp(secret), "the owner's specialist finds its own fact");
});

test("a Trunk that keeps to itself keeps its specialists from the owner's shared facts too", async (t) => {
  const { app, ada, say } = await twoTrunks(t, { sharedFacts: false });
  await app.registry.execute("memory.put", { text: `Shared code ${secret}`, source: "the owner", scope: "shared" }, app.runtime.context());
  const after = lastEvent(app);
  await say(ada, "handoff: recall shared code");
  const [found] = outcomesSince(app, after, "memory.search");
  assert.doesNotMatch(found, new RegExp(secret));
  assert.equal(found, "[]", "an empty answer, not an error");
});

test("under a Trunk a specialist is still itself by name: the owner's hand-on rules for it still hold", async (t) => {
  const { app, ids, ada, say } = await twoTrunks(t);
  app.runtime.handoffs.save(ids.researcher, [ids.researcher]); // the researcher may hand work only to itself
  const after = lastEvent(app);
  await say(ada, "handoff: onward: write it up");
  const refused = outcomesSince(app, after, "delegate.handoff");
  assert.ok(refused.some((text) => /only set up to hand work on to/.test(text)), refused.join("\n"));
});

test("workspace.undo in a conversation the owner re-chose never hands one Trunk another Trunk's kept bytes", async (t) => {
  const { app } = await fixture(t, [({ last }) => {
    if (last?.role !== "user") return null;
    const text = String(last.content ?? "");
    if (text === "write private") return call("files.write", { path: "plan.md", content: `Ada private plan ${secret}` });
    if (text === "write public") return call("files.write", { path: "plan.md", content: "Ada public plan" });
    if (text === "preview undo") return call("workspace.undo", { preview: true });
    if (text === "undo") return call("workspace.undo", {});
    if (text === "read plan") return call("files.read", { path: "plan.md" });
    return null;
  }, ({ last }) => (last?.role === "tool" ? "Done." : null)]);
  on(app);
  const ada = app.trunks.create({ name: "Ada" }), bo = app.trunks.create({ name: "Bo" });
  for (const trunk of [ada, bo]) app.trunks.edit(trunk.id, { permissions: ["files.read", "files.write"] });
  await app.trunks.introduced();
  await app.trunks.say(ada.id, "write private"); // in Ada's own Trunk Chat, which Bo never joins
  const { sessionId } = app.trunks.startConversation({ trunkId: ada.id });
  await app.runtime.run({ prompt: "write public", sessionId });
  app.trunks.conversations.choose(sessionId, { trunkId: bo.id });
  let after = lastEvent(app);
  await app.runtime.run({ prompt: "preview undo", sessionId });
  const [preview] = outcomesSince(app, after, "workspace.undo");
  assert.doesNotMatch(preview, new RegExp(secret), "Bo's preview shows none of Ada's bytes");
  assert.match(preview, /"change":null/, "nothing of Bo's own to undo here");
  after = lastEvent(app);
  await app.runtime.run({ prompt: "undo", sessionId });
  await app.runtime.run({ prompt: "read plan", sessionId });
  const [undone] = outcomesSince(app, after, "workspace.undo");
  assert.doesNotMatch(undone, new RegExp(secret), "nor does the undo itself");
  assert.match(undone, /nothing to undo/);
  assert.doesNotMatch(outcomesSince(app, after, "files.read").join(""), new RegExp(secret), "nothing of Ada's was written into Bo's folder");
});

test("workspace.redo in a conversation the owner re-chose never hands one Trunk another Trunk's kept bytes", async (t) => {
  const later = "SECRETLATER5521";
  const { app } = await fixture(t, [({ last }) => {
    if (last?.role !== "user") return null;
    const text = String(last.content ?? "");
    if (text === "write first") return call("files.write", { path: "plan.md", content: "Ada first plan" });
    if (text === "write later") return call("files.write", { path: "plan.md", content: `Ada later plan ${later}` });
    if (text === "undo") return call("workspace.undo", {});
    if (text === "preview redo") return call("workspace.redo", { preview: true });
    if (text === "redo") return call("workspace.redo", {});
    if (text === "read plan") return call("files.read", { path: "plan.md" });
    return null;
  }, ({ last }) => (last?.role === "tool" ? "Done." : null)]);
  on(app);
  const ada = app.trunks.create({ name: "Ada" }), bo = app.trunks.create({ name: "Bo" });
  for (const trunk of [ada, bo]) app.trunks.edit(trunk.id, { permissions: ["files.read", "files.write"] });
  await app.trunks.introduced();
  const { sessionId } = app.trunks.startConversation({ trunkId: ada.id });
  for (const prompt of ["write first", "write later", "undo"]) await app.runtime.run({ prompt, sessionId });
  app.trunks.conversations.choose(sessionId, { trunkId: bo.id });
  const after = lastEvent(app);
  for (const prompt of ["preview redo", "redo", "read plan"]) await app.runtime.run({ prompt, sessionId });
  const [preview, redo] = outcomesSince(app, after, "workspace.redo");
  for (const text of [preview, redo]) assert.doesNotMatch(text, new RegExp(later), "Bo's redo shows none of Ada's bytes");
  assert.match(preview, /"change":null/, "Ada's undo is not Bo's to redo");
  assert.match(redo, /nothing to put back/);
  assert.doesNotMatch(outcomesSince(app, after, "files.read").join(""), new RegExp(later), "nothing of Ada's was written into Bo's folder");
});

test("a Trunk's specialist asked to save a shared fact keeps it to that Trunk, as the Trunk itself does", async (t) => {
  const { app, ada, bo, say } = await twoTrunks(t);
  const after = lastEvent(app);
  await say(ada, `handoff: share Launch code ${secret}`);
  const saved = app.store.list("memory", app.runtime.owner).find((record) => String(record.data.text).includes(secret));
  assert.ok(saved, outcomesSince(app, after, "memory.put").join("\n"));
  assert.notEqual(saved.data.scope, "shared", "never shared");
  assert.match(saved.data.scope, new RegExp(`^agent:trunk:${ada.id}:`), "Ada's researcher's own");
  const before = lastEvent(app);
  await say(bo, "handoff: recall launch code");
  assert.equal(outcomesSince(app, before, "memory.search")[0], "[]");
});

for (const [who, first] of [["another Trunk's", "Ada"], ["the owner's", "owner"]])
  test(`a conversation the owner re-chose never shows the next Trunk ${who} remembered facts`, async (t) => {
    const secretSnap = "SECRETSNAP8812";
    const { app, provider } = await fixture(t, [({ last }) => (last?.role === "user" && last.content === "remember"
      ? call("memory.put", { text: `Snap code ${secretSnap}`, source: "Ada" }) : null),
    ({ last }) => (last?.role === "tool" ? "Done." : null)]);
    on(app);
    const ada = app.trunks.create({ name: "Ada" }), bo = app.trunks.create({ name: "Bo" });
    for (const trunk of [ada, bo]) app.trunks.edit(trunk.id, { permissions: ["memory.read", "memory.write"] });
    await app.trunks.introduced();
    let sessionId, next;
    if (first === "Ada") {
      await app.trunks.say(ada.id, "remember"); // saved in Ada's own Trunk Chat
      ({ sessionId } = app.trunks.startConversation({ trunkId: ada.id }));
      next = bo;
    } else {
      await app.registry.execute("memory.put", { text: `Snap code ${secretSnap}`, source: "the owner" }, app.runtime.context());
      sessionId = (await app.runtime.run({ prompt: "hello" })).sessionId; // the owner's own conversation
      next = ada;
    }
    await app.runtime.run({ prompt: "hello", sessionId });
    assert.match(JSON.stringify(provider.requests.at(-1).messages), new RegExp(secretSnap), "the first speaker is shown its own fact");
    app.trunks.conversations.choose(sessionId, { trunkId: next.id });
    await app.runtime.run({ prompt: "hello again", sessionId });
    assert.doesNotMatch(JSON.stringify(provider.requests.at(-1).messages), new RegExp(secretSnap), `${next.name} is not shown it`);
  });

test("the reviewer of a Trunk's answer sees only what that Trunk remembers, and hands back nothing else", async (t) => {
  const { saveOrchestrationSettings } = await import("../dist/orchestration.js");
  const seen = [];
  const { app, provider } = await fixture(t, [({ system, last }) => {
    if (!/You review a finished answer/.test(system)) return null;
    seen.push(String(last?.content ?? ""));
    // A reviewer that quotes what it was shown, so anything it saw would reach the Trunk's own model too.
    return seen.length === 1 ? JSON.stringify({ verdict: "revise", fixes: [`mention: ${seen[0].replace(/\s+/g, " ").slice(0, 1500)}`] })
      : JSON.stringify({ verdict: "accept", fixes: [] });
  }, ({ last }) => {
    if (last?.role !== "user") return null;
    const text = String(last.content ?? "");
    if (text.startsWith("remember ")) return call("memory.put", { text: text.slice("remember ".length), source: "me" });
    return null;
  }, ({ last }) => (last?.role === "tool" ? "Done." : null)]);
  on(app);
  const ada = app.trunks.create({ name: "Ada" }), bo = app.trunks.create({ name: "Bo" });
  for (const trunk of [ada, bo]) app.trunks.edit(trunk.id, { permissions: ["memory.read", "memory.write"] });
  await app.trunks.introduced();
  await app.registry.execute("memory.put", { text: "zebra owner OWNERPRIV3391", source: "the owner" }, app.runtime.context());
  await app.trunks.say(bo.id, "remember zebra Bo BOSECRET7714");
  await app.trunks.say(ada.id, "remember zebra Ada ADAOWN5150");
  saveOrchestrationSettings(app.store, app.runtime.owner, { verify: true });
  seen.length = 0;
  const before = provider.requests.length;
  // A new conversation with Ada, so her snapshot is taken now that the facts exist.
  const { sessionId } = app.trunks.startConversation({ trunkId: ada.id });
  await app.runtime.run({ prompt: "how is the zebra", sessionId });
  assert.ok(seen.length >= 1, "the reviewer looked at Ada's answer");
  assert.doesNotMatch(seen[0], /OWNERPRIV3391|BOSECRET7714/, "the reviewer is shown only Ada's memory");
  assert.match(seen[0], /ADAOWN5150/, "including Ada's own fact");
  const handed = provider.requests.slice(before).filter((request) => !/You review a finished answer/.test(request.messages.map((m) => m.content).join("\n")));
  assert.doesNotMatch(JSON.stringify(handed.map((request) => request.messages)), /OWNERPRIV3391|BOSECRET7714/, "nor does Ada's own model get it back");
});

test("work a Trunk sets going through a saved workflow remembers as that Trunk, never with the owner's whole memory", async (t) => {
  const steps = {
    tool: [{ name: "look", kind: "tool", tool: "memory.search", args: { query: "zebra" } }],
    prompt: [{ name: "look", kind: "prompt", prompt: "look for zebra" }],
    share: [{ name: "keep", kind: "tool", tool: "memory.put", args: { text: "zebra shared by a step SHAREDW3", source: "a step", scope: "shared" } }],
  };
  const { app } = await fixture(t, [({ last }) => {
    if (last?.role !== "user") return null;
    const text = String(last.content ?? "");
    if (text.startsWith("remember ")) return call("memory.put", { text: text.slice("remember ".length), source: "me" });
    if (text.startsWith("make ")) return call("workflows.create", { name: text.slice("make ".length), steps: steps[text.slice("make ".length)] });
    if (text.startsWith("run ")) return call("workflows.run", { id: text.slice("run ".length) });
    if (text === "look for zebra") return call("memory.search", { query: "zebra" });
    return null;
  }, ({ last }) => (last?.role === "tool" ? `Found: ${last.content}` : null)]);
  on(app);
  const ada = app.trunks.create({ name: "Ada" }), bo = app.trunks.create({ name: "Bo" });
  for (const trunk of [ada, bo])
    app.trunks.edit(trunk.id, { permissions: ["memory.read", "memory.write", "workflows.manage", "workflows.read"] });
  await app.trunks.introduced();
  await app.registry.execute("memory.put", { text: "zebra owner OWNERPRIV3391", source: "the owner" }, app.runtime.context());
  await app.trunks.say(bo.id, "remember zebra Bo BOSECRET7714");
  await app.trunks.say(ada.id, "remember zebra Ada ADAOWN5150");
  const saved = (name) => app.store.list("workflows", app.runtime.owner).find((record) => record.data.name === name)?.id;
  const ran = async (name) => {
    await app.trunks.say(ada.id, `make ${name}`);
    const after = lastEvent(app);
    await app.trunks.say(ada.id, `run ${saved(name)}`);
    await settled(app);
    return outcomesSince(app, after, "workflows.run").join("") + outcomesSince(app, after, "memory.search").join("");
  };
  for (const name of ["tool", "prompt"]) {
    const found = await ran(name);
    assert.doesNotMatch(found, /OWNERPRIV3391|BOSECRET7714/, `a ${name} step reads only Ada's memory`);
    assert.match(found, /ADAOWN5150/, `a ${name} step still finds Ada's own fact`);
  }
  await ran("share");
  const kept = app.store.list("memory", app.runtime.owner).find((record) => String(record.data.text).includes("SHAREDW3"));
  assert.ok(kept, "the step saved its fact");
  assert.equal(kept.data.scope, `agent:trunk:${ada.id}`, "kept to Ada, never shared");
});

test("a workflow one Trunk runs because another Trunk messaged it remembers as the Trunk that runs it", async (t) => {
  const { app } = await fixture(t, [({ system, last }) => {
    if (last?.role !== "user") return null;
    const text = String(last.content ?? "");
    const run = /run workflow ([0-9a-f-]{36})/.exec(text);
    if (run && /\nYou are Bo /.test(system)) return call("workflows.run", { id: run[1] });
    if (text.startsWith("tell bo ")) return call("trunk.message", { to: "@bo", message: text.slice("tell bo ".length) });
    return null;
  }, ({ last }) => (last?.role === "tool" ? "Done." : null)]);
  on(app, "messages");
  const ada = app.trunks.create({ name: "Ada" }), bo = app.trunks.create({ name: "Bo" });
  // A message carries its sender's limits, so Ada holds what Bo's work will need.
  app.trunks.edit(ada.id, { permissions: ["trunks.message", "workflows.manage", "workflows.read", "memory.write"] });
  app.trunks.edit(bo.id, { permissions: ["workflows.manage", "workflows.read", "memory.write"] });
  await app.trunks.introduced();
  const workflow = await madeBy(app, bo, { name: "note", steps: [{ name: "keep", kind: "tool", tool: "memory.put",
    args: { text: "kept by a step Bo ran BOSTEP4242", source: "a step" } }] });
  // Ada's message sets Bo's turn going while Ada's own work is still marked as hers.
  await app.trunks.say(ada.id, `tell bo run workflow ${workflow.id}`);
  let kept;
  for (let tries = 0; tries < 200 && !kept; tries++) {
    await settled(app);
    kept = app.store.list("memory", app.runtime.owner).find((record) => String(record.data.text).includes("BOSTEP4242"));
    if (!kept) await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(kept, "Bo's workflow ran and kept its fact");
  assert.equal(kept.data.scope, `agent:trunk:${bo.id}`, "as Bo, not as Ada who sent the message");
});

test("a workflow a Trunk started carries on as that Trunk, whoever resumes it, and never as another Trunk", async (t) => {
  const { mkdir: makeFolder, writeFile: write } = await import("node:fs/promises");
  const { app } = await fixture(t, [({ system, last }) => {
    if (last?.role !== "user") return null;
    const text = String(last.content ?? "");
    if (text.startsWith("run ")) return call("workflows.run", { id: text.slice("run ".length) });
    if (text.startsWith("resume ")) return call("workflows.resume", { id: text.slice("resume ".length) });
    if (text.startsWith("remember ")) return call("memory.put", { text: text.slice("remember ".length), source: "me" });
    return null;
  }, ({ last }) => (last?.role === "tool" ? `Result: ${last.content}` : null)]);
  on(app);
  const ada = app.trunks.create({ name: "Ada" }), bo = app.trunks.create({ name: "Bo" });
  for (const trunk of [ada, bo])
    app.trunks.edit(trunk.id, { permissions: ["memory.read", "memory.write", "files.read", "workflows.manage", "workflows.read"] });
  await app.trunks.introduced();
  await app.registry.execute("memory.put", { text: "zebra owner OWNERPRIV3391", source: "the owner" }, app.runtime.context());
  await app.trunks.say(ada.id, "remember zebra Ada ADAOWN5150");
  await write(join(app.runtime.workspace, "note.md"), "SHARED-NOTE");
  await makeFolder(join(app.runtime.workspace, ".branch-agents", ada.id), { recursive: true });
  await write(join(app.runtime.workspace, ".branch-agents", ada.id, "note.md"), "ADA-NOTE");
  const workflow = await madeBy(app, ada, { name: "later", steps: [
    { name: "ok?", kind: "approval", question: "Carry on?" },
    { name: "look", kind: "tool", tool: "memory.search", args: { query: "zebra" } },
    { name: "read", kind: "tool", tool: "files.read", args: { path: "note.md" } }] });
  await app.trunks.say(ada.id, `run ${workflow.id}`); // Ada starts it; it stops to ask the owner
  assert.equal(app.workflows.view(app.runtime.owner, workflow.id).status, "waiting_approval");
  // Bo cannot carry Ada's work on: here a wait Ada's workflow stopped at, which asks nobody.
  const waiting = await madeBy(app, ada, { name: "wait", steps: [
    { name: "a while", kind: "wait", waitMinutes: 60 }, { name: "look", kind: "tool", tool: "memory.search", args: { query: "zebra" } }] });
  await app.trunks.say(ada.id, `run ${waiting.id}`);
  assert.equal(app.workflows.view(app.runtime.owner, waiting.id).status, "waiting_time");
  const after = lastEvent(app);
  await app.trunks.say(bo.id, `resume ${waiting.id}`);
  assert.match(outcomesSince(app, after, "workflows.resume").join(""), /Workflow not found/); // Q119: not even there for Bo
  // The owner says yes on their own screen: the rest runs as Ada, not with the owner's whole memory and files.
  const done = await app.workflows.resume(app.runtime.owner, workflow.id);
  const text = JSON.stringify(done.state);
  assert.equal(done.status, "completed", text.slice(0, 400));
  assert.doesNotMatch(text, /OWNERPRIV3391/, "the owner's private fact is not handed to Ada's workflow");
  assert.match(text, /ADAOWN5150/, "Ada's own fact");
  assert.match(text, /ADA-NOTE/, "Ada's own folder");
  assert.doesNotMatch(text, /SHARED-NOTE/);
  // Run again by Ada and stopped again, then Ada is removed: nobody carries her work on.
  await app.trunks.say(ada.id, `run ${workflow.id}`);
  app.trunks.remove(ada.id);
  await assert.rejects(app.workflows.resume(app.runtime.owner, workflow.id), /no longer here/);
});

test("a flow a Trunk set going carries on as that Trunk when the owner approves it later", async (t) => {
  const { withAccountCall } = await import("../dist/accounts/context.js");
  const { existsSync: exists } = await import("node:fs");
  const { app } = await fixture(t, []);
  on(app);
  const ada = app.trunks.create({ name: "Ada" });
  await app.trunks.introduced();
  await app.registry.execute("memory.put", { text: "zebra owner OWNERPRIV3391", source: "the owner" }, app.runtime.context());
  const saved = app.flows.saveGraph({ name: "Later", input: {}, state: { found: "text" }, entry: "write",
    nodes: [
      { id: "write", name: "Write", kind: "tool", tool: "files.write", args: { path: "graph.md", content: "g" }, output: {} },
      { id: "look", name: "Look", kind: "tool", tool: "memory.search", args: { query: "zebra" }, output: { found: "text" } },
    ],
    edges: [{ from: "write", to: "look" }] });
  // Set going by Ada's own work (as a flow tool in her turn would), held as a schedule so its write stops to ask.
  const { runId } = await withAccountCall({ owner: app.runtime.owner, sessionId: "", runId: "", trunk: { keys: ada.keys, id: ada.id } },
    async () => app.flows.startGraph(saved.id, {}, undefined, "schedule"));
  const paused = await app.flows.settled(runId);
  assert.ok(paused.question, `it stopped to ask: ${paused.status} ${paused.error ?? ""}`);
  app.flows.resumeGraph(saved.id, { runId, approve: true }); // the owner, on their own screen
  const done = await app.flows.settled(runId);
  const text = JSON.stringify(done);
  assert.equal(done.status, "completed", text.slice(0, 400));
  assert.doesNotMatch(text, /OWNERPRIV3391/, "the owner's private fact is not handed to Ada's flow");
  assert.ok(exists(join(app.runtime.workspace, ".branch-agents", ada.id, "graph.md")), "written in Ada's own folder");
  assert.equal(exists(join(app.runtime.workspace, "graph.md")), false);
});

test("saving a Trunk's paused workflow again, or forking its flow run, still carries it on as that Trunk", async (t) => {
  const { withAccountCall } = await import("../dist/accounts/context.js");
  const { app } = await fixture(t, [({ last }) => {
    if (last?.role !== "user") return null;
    const text = String(last.content ?? "");
    if (text.startsWith("run ")) return call("workflows.run", { id: text.slice("run ".length) });
    return null;
  }, ({ last }) => (last?.role === "tool" ? "Done." : null)]);
  on(app);
  const ada = app.trunks.create({ name: "Ada" });
  app.trunks.edit(ada.id, { permissions: ["memory.read", "workflows.manage", "workflows.read"] });
  await app.trunks.introduced();
  await app.registry.execute("memory.put", { text: "zebra owner OWNERPRIV3391", source: "the owner" }, app.runtime.context());
  const steps = [{ name: "ok?", kind: "approval", question: "Carry on?" },
    { name: "look", kind: "tool", tool: "memory.search", args: { query: "zebra" } }];
  const workflow = await madeBy(app, ada, { name: "later", steps });
  await app.trunks.say(ada.id, `run ${workflow.id}`);
  assert.equal(app.workflows.view(app.runtime.owner, workflow.id).status, "waiting_approval");
  // Saved again (here by the owner's own edit) while it waits: it is still Ada's.
  await app.registry.execute("workflows.create", { id: workflow.id, name: "later, renamed", steps }, app.runtime.context());
  const done = await app.workflows.resume(app.runtime.owner, workflow.id);
  assert.equal(done.status, "completed");
  assert.doesNotMatch(JSON.stringify(done.state), /OWNERPRIV3391/, "the rest ran as Ada, not as the owner");
  // A flow run of Ada's, forked from its first step by the owner: the copy is Ada's work too.
  app.flowsBoards.setMode("time-travel", { mode: "on" });
  const graph = app.flows.saveGraph({ name: "Twice", input: {}, state: { first: "text", second: "text" }, entry: "a",
    nodes: [
      { id: "a", name: "First", kind: "tool", tool: "memory.search", args: { query: "zebra" }, output: { first: "text" } },
      { id: "b", name: "Second", kind: "tool", tool: "memory.search", args: { query: "zebra" }, output: { second: "text" } },
    ], edges: [{ from: "a", to: "b" }] });
  const { runId } = await withAccountCall({ owner: app.runtime.owner, sessionId: "", runId: "", trunk: { keys: ada.keys, id: ada.id } },
    async () => app.flows.startGraph(graph.id, {}));
  const first = await app.flows.settled(runId);
  assert.doesNotMatch(JSON.stringify(first), /OWNERPRIV3391/, "Ada's own run");
  const copy = app.flowsBoards.timeTravel.fork(runId, { seq: 1 });
  let view;
  for (let tries = 0; tries < 200; tries++) {
    view = app.flows.runState(copy.runId);
    if (view.status !== "running") break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(view.status, "completed", JSON.stringify(view).slice(0, 300));
  assert.doesNotMatch(JSON.stringify(view), /OWNERPRIV3391/, "the copy runs as Ada too");
});

test("a schedule a Trunk made fires as that Trunk, never with the owner's whole memory, and not at all once it is gone", async (t) => {
  const { app } = await fixture(t, [({ last }) => {
    if (last?.role !== "user") return null;
    const text = String(last.content ?? "");
    if (text.startsWith("remember ")) return call("memory.put", { text: text.slice("remember ".length), source: "me" });
    if (text.startsWith("schedule ")) return call("schedules.create", { prompt: "look for zebra", kind: "task",
      dueAt: new Date(Date.now() + Number(text.slice("schedule ".length)) * 60000).toISOString() });
    if (text.endsWith("look for zebra")) return call("memory.search", { query: "zebra" });
    return null;
  }, ({ last }) => (last?.role === "tool" ? `Found: ${last.content}` : null)]);
  on(app);
  const ada = app.trunks.create({ name: "Ada" });
  app.trunks.edit(ada.id, { permissions: ["memory.read", "memory.write", "schedules.manage", "schedules.read"] });
  await app.trunks.introduced();
  await app.registry.execute("memory.put", { text: "zebra owner OWNERPRIV3391", source: "the owner" }, app.runtime.context());
  await app.trunks.say(ada.id, "remember zebra Ada ADAOWN5150");
  await app.trunks.say(ada.id, "schedule 1");
  await app.trunks.say(ada.id, "schedule 120");
  const mine = () => app.store.list("schedules", app.runtime.owner).sort((a, b) => a.data.dueAt.localeCompare(b.data.dueAt));
  assert.equal(mine().length, 2, "Ada made two schedules");
  await app.scheduler.tick(new Date(Date.now() + 5 * 60000));
  const fired = mine()[0].data;
  assert.doesNotMatch(String(fired.lastResult ?? ""), /OWNERPRIV3391/, "the owner's private fact never reaches Ada's schedule");
  assert.match(String(fired.lastResult ?? ""), /ADAOWN5150/, "Ada's own fact does");
  app.trunks.remove(ada.id);
  await app.scheduler.tick(new Date(Date.now() + 180 * 60000));
  const after = mine()[1].data;
  assert.equal(after.history?.at(-1)?.status, "failed", "a schedule of a Trunk that is gone does not run");
  assert.doesNotMatch(JSON.stringify(after), /OWNERPRIV3391/);
});

test("a refused carry-on leaves a Trunk's workflow as it stopped, not stuck working", async (t) => {
  const { app } = await fixture(t, [({ last }) => {
    if (last?.role !== "user") return null;
    const text = String(last.content ?? "");
    if (text.startsWith("run ")) return call("workflows.run", { id: text.slice("run ".length) });
    if (text.startsWith("resume ")) return call("workflows.resume", { id: text.slice("resume ".length) });
    return null;
  }, ({ last }) => (last?.role === "tool" ? "Done." : null)]);
  on(app);
  const ada = app.trunks.create({ name: "Ada" }), bo = app.trunks.create({ name: "Bo" });
  for (const trunk of [ada, bo]) app.trunks.edit(trunk.id, { permissions: ["memory.read", "workflows.manage", "workflows.read"] });
  await app.trunks.introduced();
  const workflow = await madeBy(app, ada, { name: "wait", steps: [
    { name: "a while", kind: "wait", waitMinutes: 60 }, { name: "look", kind: "tool", tool: "memory.search", args: { query: "zebra" } }] });
  await app.trunks.say(ada.id, `run ${workflow.id}`);
  const status = () => app.workflows.view(app.runtime.owner, workflow.id).status;
  assert.equal(status(), "waiting_time");
  await app.trunks.say(bo.id, `resume ${workflow.id}`); // refused: Ada's work
  assert.equal(status(), "waiting_time", "Bo's refused resume leaves it waiting, not running");
  app.trunks.remove(ada.id);
  await assert.rejects(app.workflows.resume(app.runtime.owner, workflow.id), /no longer here/);
  assert.equal(status(), "waiting_time", "a refused carry-on for a Trunk that is gone leaves it waiting too");
});

test("a Trunk's flow run that was working when the app closed carries on as that Trunk at the next launch", async (t) => {
  const { withAccountCall } = await import("../dist/accounts/context.js");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { createBranch } = await import("../dist/index.js");
  const { brain } = await import("./trunks-helpers.mjs");
  const root = await mkdtemp(join(tmpdir(), "branch-trunk-flow-restart-"));
  // The second launch is closed before its folder goes: Windows will not delete a database that is still open.
  let second;
  t.after(async () => { await second?.close(); await rm(root, { recursive: true, force: true }); });
  const open = () => createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: brain([]) });
  const first = await open();
  first.store.save("settings", first.runtime.owner, "conversation-mode-settings", { newConversation: "follow" }); // Q013, as trunks-helpers
  on(first);
  const ada = first.trunks.create({ name: "Ada" });
  await first.trunks.introduced();
  await first.registry.execute("memory.put", { text: "zebra owner OWNERPRIV3391", source: "the owner" }, first.runtime.context());
  const graph = first.flows.saveGraph({ name: "Twice", input: {}, state: { first: "text", second: "text" }, entry: "a",
    nodes: [
      { id: "a", name: "First", kind: "tool", tool: "memory.search", args: { query: "zebra" }, output: { first: "text" } },
      { id: "b", name: "Second", kind: "tool", tool: "memory.search", args: { query: "zebra" }, output: { second: "text" } },
    ], edges: [{ from: "a", to: "b" }] });
  const { runId } = await withAccountCall({ owner: first.runtime.owner, sessionId: "", runId: "", trunk: { keys: ada.keys, id: ada.id } },
    async () => first.flows.startGraph(graph.id, {}));
  await first.flows.settled(runId);
  // As a close in the middle leaves it: still working, with the second box next.
  first.store.sqlite.prepare("UPDATE flow_graph_runs SET status='running', next_node='b' WHERE run_id=?").run(runId);
  await first.close();
  second = await open();
  const view = await second.flows.settled(runId);
  assert.equal(view.status, "completed", `carried on at launch: ${JSON.stringify(view).slice(0, 300)}`);
  assert.doesNotMatch(JSON.stringify(view), /OWNERPRIV3391/, "as Ada, not as the owner");
});

test("Q122: a flow run of a Trunk that is gone is never copied, and at launch it ends saying why, not left working", async (t) => {
  const { withAccountCall } = await import("../dist/accounts/context.js");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { createBranch } = await import("../dist/index.js");
  const { brain } = await import("./trunks-helpers.mjs");
  const root = await mkdtemp(join(tmpdir(), "branch-q122-"));
  // The second launch is closed before its folder goes: Windows will not delete a database that is still open.
  let second;
  t.after(async () => { await second?.close(); await rm(root, { recursive: true, force: true }); });
  const open = () => createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: brain([]) });
  const first = await open();
  first.store.save("settings", first.runtime.owner, "conversation-mode-settings", { newConversation: "follow" }); // Q013, as trunks-helpers
  on(first);
  const ada = first.trunks.create({ name: "Ada" });
  await first.trunks.introduced();
  const graph = first.flows.saveGraph({ name: "Twice", input: {}, state: { first: "text", second: "text" }, entry: "a",
    nodes: [
      { id: "a", name: "First", kind: "tool", tool: "memory.search", args: { query: "zebra" }, output: { first: "text" } },
      { id: "b", name: "Second", kind: "tool", tool: "memory.search", args: { query: "zebra" }, output: { second: "text" } },
    ], edges: [{ from: "a", to: "b" }] });
  first.flowsBoards.setMode("time-travel", { mode: "on" }); // so each run's steps are kept to fork from
  const asAda = (work) => withAccountCall({ owner: first.runtime.owner, sessionId: "", runId: "", trunk: { keys: ada.keys, id: ada.id } }, work);
  const { runId: done } = await asAda(async () => first.flows.startGraph(graph.id, {}));
  await first.flows.settled(done);
  const { runId: stopped } = await asAda(async () => first.flows.startGraph(graph.id, {}));
  await first.flows.settled(stopped);
  first.store.sqlite.prepare("UPDATE flow_graph_runs SET status='running', next_node='b' WHERE run_id=?").run(stopped); // as a close leaves it
  first.trunks.remove(ada.id);
  // The owner forks Ada's finished run: refused, and no copy is left behind looking as if it were working.
  const runs = () => Number(first.store.sqlite.prepare("SELECT COUNT(*) AS n FROM flow_graph_runs").get().n);
  const before = runs();
  assert.throws(() => first.flowsBoards.timeTravel.fork(done, { seq: 1 }), /no longer here/);
  assert.equal(runs(), before, "no copy was made");
  await first.close();
  // At the next launch the run Ada left working is ended, with the reason, and its task with it.
  second = await open();
  const view = await second.flows.settled(stopped);
  assert.equal(view.status, "failed", JSON.stringify(view).slice(0, 300));
  assert.match(String(view.error), /no longer here/);
  assert.equal(second.store.sqlite.prepare("SELECT status FROM tasks WHERE id=?").get(stopped).status, "failed");
});

test("Q126: a yes to a workflow whose Trunk is gone is refused before it is written down: the question stays, nothing is marked approved", async (t) => {
  const { app } = await fixture(t, []);
  on(app);
  const ada = app.trunks.create({ name: "Ada" });
  app.trunks.edit(ada.id, { permissions: ["memory.read", "workflows.manage", "workflows.read"] });
  await app.trunks.introduced();
  const workflow = await madeBy(app, ada, { name: "later", steps: [
    { name: "ok?", kind: "approval", question: "Carry on?" },
    { name: "look", kind: "tool", tool: "memory.search", args: { query: "zebra" } }] });
  const { withAccountCall } = await import("../dist/accounts/context.js");
  await withAccountCall({ owner: app.runtime.owner, sessionId: "", runId: "", trunk: { keys: ada.keys, id: ada.id } },
    () => app.workflows.run(app.runtime.owner, workflow.id));
  assert.equal(app.workflows.view(app.runtime.owner, workflow.id).status, "waiting_approval");
  app.trunks.remove(ada.id);
  for (const time of ["first", "second"]) {
    await assert.rejects(app.workflows.resume(app.runtime.owner, workflow.id), /no longer here/, `the ${time} yes`);
    const view = app.workflows.view(app.runtime.owner, workflow.id);
    assert.equal(view.status, "waiting_approval", `still waiting after the ${time} yes`);
    assert.equal(view.question, "Carry on?", "the question is still asked");
    assert.equal(view.cursor, 0);
    assert.equal(view.state.some((step) => step.status === "approved"), false, "no step recorded as approved");
  }
});

test("Q121: a Trunk's flow run carried on at launch reads and writes in that Trunk's own folder, not the owner's project", async (t) => {
  const { mkdtemp, rm, mkdir: makeFolder, writeFile: write } = await import("node:fs/promises");
  const { existsSync: exists } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { createBranch } = await import("../dist/index.js");
  const { brain } = await import("./trunks-helpers.mjs");
  const root = await mkdtemp(join(tmpdir(), "branch-q121-folder-"));
  // The second launch is closed before its folder goes: Windows will not delete a database that is still open.
  let second;
  t.after(async () => { await second?.close(); await rm(root, { recursive: true, force: true }); });
  const workspace = join(root, "workspace");
  // Ada sets the flow going in her own turn, through the tool the saved flow is published as.
  const rules = [({ last }) => {
    if (last?.role === "user" && String(last.content ?? "") === "run files") return call("flows.files", {});
    return last?.role === "tool" ? "Done." : null;
  }];
  const open = () => createBranch({ workspace, dataDir: join(root, "data"), provider: brain(rules) });
  const first = await open();
  first.store.save("settings", first.runtime.owner, "conversation-mode-settings", { newConversation: "follow" }); // Q013, as trunks-helpers
  on(first);
  const ada = first.trunks.create({ name: "Ada" });
  first.trunks.edit(ada.id, { permissions: ["files.read", "files.write", "memory.read", "workflows.manage", "workflows.read"] });
  await first.trunks.introduced();
  await write(join(workspace, "plan.txt"), "OWNERFILE4471");
  await makeFolder(join(workspace, ".branch-agents", ada.id), { recursive: true });
  await write(join(workspace, ".branch-agents", ada.id, "plan.txt"), "ADAFILE5582");
  const graph = first.flows.saveGraph({ name: "Files", input: {}, state: { first: "text", second: "text" }, entry: "a",
    nodes: [
      { id: "a", name: "First", kind: "tool", tool: "memory.search", args: { query: "zebra" }, output: { first: "text" } },
      { id: "b", name: "Read", kind: "tool", tool: "files.read", args: { path: "plan.txt" }, output: { second: "text" } },
      { id: "c", name: "Write", kind: "tool", tool: "files.write", args: { path: "from-ada.txt", content: "x" }, output: {} },
    ], edges: [{ from: "a", to: "b" }, { from: "b", to: "c" }] });
  await first.trunks.say(ada.id, "run files");
  const runId = String(first.store.sqlite.prepare("SELECT run_id FROM flow_graph_runs WHERE flow_id=?").get(graph.id).run_id);
  const within = await first.flows.settled(runId);
  assert.match(JSON.stringify(within.state), /ADAFILE5582/, `within the session, Ada's own file: ${JSON.stringify(within).slice(0, 300)}`);
  await rm(join(workspace, ".branch-agents", ada.id, "from-ada.txt"), { force: true });
  // As a close in the middle leaves it: still working, with the read next.
  first.store.sqlite.prepare("UPDATE flow_graph_runs SET status='running', next_node='b', state=? WHERE run_id=?")
    .run(JSON.stringify({ first: "[]", second: "" }), runId);
  await first.close();
  second = await open();
  const view = await second.flows.settled(runId);
  assert.equal(view.status, "completed", JSON.stringify(view).slice(0, 300));
  assert.match(String(view.state.second), /ADAFILE5582/, "the read at launch is Ada's own file");
  assert.doesNotMatch(JSON.stringify(view), /OWNERFILE4471/, "never the owner's");
  assert.ok(exists(join(workspace, ".branch-agents", ada.id, "from-ada.txt")), "the write lands in Ada's folder");
  assert.equal(exists(join(workspace, "from-ada.txt")), false, "not in the owner's project");
});

test("Q121: a Trunk removed while its workflow works stops it before the next step", async (t) => {
  const held = {};
  const { app } = await fixture(t, [({ last }) => {
    if (last?.role === "user" && String(last.content ?? "") === "the step that removes Ada") { held.app.trunks.remove(held.ada.id); return "Done."; }
    return null;
  }]);
  held.app = app;
  on(app);
  const ada = app.trunks.create({ name: "Ada" });
  held.ada = ada;
  app.trunks.edit(ada.id, { permissions: ["memory.read", "memory.write", "workflows.manage", "workflows.read"] });
  await app.trunks.introduced();
  const { withAccountCall } = await import("../dist/accounts/context.js");
  const asAda = (work) => withAccountCall({ owner: app.runtime.owner, sessionId: "", runId: "", trunk: { keys: ada.keys, id: ada.id } }, work);
  const workflow = await asAda(async () => app.registry.execute("workflows.create", { name: "midway", steps: [
    { name: "ok?", kind: "approval", question: "Carry on?" },
    { name: "remove", kind: "prompt", prompt: "the step that removes Ada" },
    { name: "keep", kind: "tool", tool: "memory.put", args: { text: "kept after Ada went KEPT9031", source: "a step" } }] }, app.runtime.context()));
  await asAda(() => app.workflows.run(app.runtime.owner, workflow.id));
  const done = await app.workflows.resume(app.runtime.owner, workflow.id); // the owner's yes; Ada goes during the next step
  assert.equal(done.status, "failed", JSON.stringify(done).slice(0, 300));
  assert.match(String(done.error), /no longer here/);
  assert.equal(app.store.list("memory", app.runtime.owner).some((record) => String(record.data.text).includes("KEPT9031")), false,
    "the step after Ada was removed never ran");
});

test("Q121: a Trunk removed while its flow run works stops it before the next box", async (t) => {
  const held = {};
  const { app } = await fixture(t, [({ last }) => {
    const text = String(last?.content ?? "");
    if (last?.role === "user" && text === "run midway") return call("flows.midway", {});
    if (last?.role === "user" && text === "the box that removes Ada") { held.app.trunks.remove(held.ada.id); return "Done."; }
    return last?.role === "tool" ? "Done." : null;
  }]);
  held.app = app;
  on(app);
  const ada = app.trunks.create({ name: "Ada" });
  held.ada = ada;
  app.trunks.edit(ada.id, { permissions: ["memory.read", "memory.write", "workflows.manage", "workflows.read"] });
  await app.trunks.introduced();
  const graph = app.flows.saveGraph({ name: "Midway", input: {}, state: { said: "text" }, entry: "a",
    nodes: [
      { id: "a", name: "Remove", kind: "prompt", prompt: "the box that removes Ada", output: { said: "text" } },
      { id: "b", name: "Keep", kind: "tool", tool: "memory.put", args: { text: "kept after Ada went KEPT9032", source: "a box" }, output: {} },
    ], edges: [{ from: "a", to: "b" }] });
  await app.trunks.say(ada.id, "run midway");
  const runId = String(app.store.sqlite.prepare("SELECT run_id FROM flow_graph_runs WHERE flow_id=?").get(graph.id).run_id);
  const view = await app.flows.settled(runId);
  assert.equal(view.status, "failed", JSON.stringify(view).slice(0, 300));
  assert.match(String(view.error), /no longer here/);
  assert.equal(app.store.list("memory", app.runtime.owner).some((record) => String(record.data.text).includes("KEPT9032")), false,
    "the box after Ada was removed never ran");
});

test("Q121: flows left working still carry on at launch when the window was left on another person's profile", async (t) => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { createBranch } = await import("../dist/index.js");
  const { brain } = await import("./trunks-helpers.mjs");
  const root = await mkdtemp(join(tmpdir(), "branch-q121-profile-"));
  // The second launch is closed before its folder goes: Windows will not delete a database that is still open.
  let second;
  t.after(async () => { await second?.close(); await rm(root, { recursive: true, force: true }); });
  const open = () => createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: brain([]) });
  const first = await open();
  const graph = first.flows.saveGraph({ name: "Twice", input: {}, state: { first: "text", second: "text" }, entry: "a",
    nodes: [
      { id: "a", name: "First", kind: "tool", tool: "memory.search", args: { query: "zebra" }, output: { first: "text" } },
      { id: "b", name: "Second", kind: "tool", tool: "memory.search", args: { query: "zebra" }, output: { second: "text" } },
    ], edges: [{ from: "a", to: "b" }] });
  const { runId } = first.flows.startGraph(graph.id, {});
  await first.flows.settled(runId);
  first.store.sqlite.prepare("UPDATE flow_graph_runs SET status='running', next_node='b' WHERE run_id=?").run(runId); // as a close leaves it
  // The owner's PIN is set and the window was left on Kid's profile, so it comes back on Kid's.
  first.store.profiles.setOwnerPin({ pin: "1234" });
  const kid = first.store.profiles.create({ name: "Kid", pin: "2468" });
  first.store.profiles.switch({ profileId: kid.id, pin: "2468" });
  await first.close();
  second = await open();
  assert.equal(second.store.profiles.active()?.id, kid.id, "the window is back on Kid's profile");
  const view = await second.flows.settled(runId);
  assert.equal(view.status, "completed", `the owner's flow carried on all the same: ${JSON.stringify(view).slice(0, 200)}`);
});

test("Q126: a yes to a guarded step of a workflow whose Trunk is gone grants nothing: the step's question stays pending", async (t) => {
  const { app } = await fixture(t, []);
  on(app);
  const ada = app.trunks.create({ name: "Ada" });
  app.trunks.edit(ada.id, { permissions: ["memory.read", "files.read", "files.write", "workflows.manage", "workflows.read"] });
  await app.trunks.introduced();
  const workflow = await madeBy(app, ada, { name: "write", steps: [
    { name: "write", kind: "tool", tool: "files.write", args: { path: "q126.md", content: "x" } },
    { name: "look", kind: "tool", tool: "memory.search", args: { query: "zebra" } }] });
  const { withAccountCall } = await import("../dist/accounts/context.js");
  await withAccountCall({ owner: app.runtime.owner, sessionId: "", runId: "", trunk: { keys: ada.keys, id: ada.id } },
    () => app.workflows.run(app.runtime.owner, workflow.id, "schedule"));
  const pending = () => app.store.get("workflows", app.runtime.owner, workflow.id)?.data?.pendingApproval ?? null;
  const asked = pending(), question = app.workflows.view(app.runtime.owner, workflow.id).question;
  assert.equal(app.workflows.view(app.runtime.owner, workflow.id).status, "waiting_approval");
  assert.equal(asked?.tool, "files.write", "the write stopped to ask");
  app.trunks.remove(ada.id);
  for (const time of ["first", "second"]) {
    await assert.rejects(app.workflows.resume(app.runtime.owner, workflow.id), /no longer here/, `the ${time} yes`);
    const view = app.workflows.view(app.runtime.owner, workflow.id);
    assert.equal(view.status, "waiting_approval", `still waiting after the ${time} yes`);
    assert.deepEqual(pending(), asked, "the write's question is still pending, so no yes was granted");
    assert.equal(view.question, question);
    assert.equal(view.state.some((step) => step.status === "approved" || step.status === "done"), false, "nothing approved or run");
  }
});

test("a Trunk's mark that outlives the Trunk carries none of its work on, and another Trunk's mark is refused it", async (t) => {
  // NAS e1e9dd2: work already marked as a Trunk was carried on without asking whether that Trunk is still here,
  // and the "another Trunk" refusal had no test of its own.
  const { withAccountCall } = await import("../dist/accounts/context.js");
  const { app } = await fixture(t, []);
  on(app);
  const ada = app.trunks.create({ name: "Ada" }), bo = app.trunks.create({ name: "Bo" });
  await app.trunks.introduced();
  const asTrunk = (trunk, work) => withAccountCall({ owner: app.runtime.owner, sessionId: "", runId: "", trunk: { keys: trunk.keys, id: trunk.id } }, work);
  const graph = app.flows.saveGraph({ name: "Later", input: {}, state: {}, entry: "write",
    nodes: [
      { id: "write", name: "Write", kind: "tool", tool: "files.write", args: { path: "graph.md", content: "g" }, output: {} },
      { id: "after", name: "After", kind: "tool", tool: "files.write", args: { path: "after.md", content: "a" }, output: {} },
    ], edges: [{ from: "write", to: "after" }] });
  const definition = app.flows.get(graph.id).definition ?? app.store.get("flow_graphs", app.runtime.owner, graph.id).data;
  const started = async () => {
    const { runId } = await asTrunk(ada, async () => app.flows.startGraph(graph.id, {}, undefined, "schedule")); // the write asks
    assert.ok((await app.flows.settled(runId)).question, "it stopped to ask");
    return runId;
  };
  const boxes = (runId) => Number(app.store.sqlite.prepare("SELECT COUNT(*) AS n FROM flow_graph_nodes WHERE run_id=?").get(runId).n);
  // Bo's own mark asking to carry Ada's live run on is refused, and her run is left exactly as it stopped.
  const live = await started();
  const before = { boxes: boxes(live), view: JSON.stringify(app.flows.runState(live)) };
  await assert.rejects(asTrunk(bo, () => app.flows.graphs.resume(live, definition, { approve: true })), /Another Trunk started this/);
  assert.equal(boxes(live), before.boxes);
  assert.equal(JSON.stringify(app.flows.runState(live)), before.view, "nothing approved, nothing marked running");
  // Ada removed, then a mark of hers that is still about carries her run on: refused, and the run ends saying why.
  const stale = await started();
  app.trunks.remove(ada.id);
  await assert.rejects(asTrunk(ada, () => app.flows.graphs.resume(stale, definition, { approve: true })), /no longer here/);
  const view = app.flows.runState(stale);
  assert.equal(view.status, "failed");
  assert.equal(boxes(stale), before.boxes, "no box after the question ran");
  assert.match(String(app.store.run(stale).output ?? ""), /no longer here/, "and its task says why");
});

test("a Trunk's mark that outlives the Trunk starts none of its workflows either: asTrunkWork asks before its own-mark shortcut", async (t) => {
  // NAS p55: the test above reaches the refusal through the graph's whyNot, asked first. Workflows.run carries
  // on through asTrunkWork with nothing asked before it, so this is the one that holds asTrunkWork's own order.
  const { withAccountCall } = await import("../dist/accounts/context.js");
  const { app } = await fixture(t, []);
  on(app);
  const ada = app.trunks.create({ name: "Ada" });
  app.trunks.edit(ada.id, { permissions: ["memory.read", "memory.write", "workflows.manage", "workflows.read"] });
  await app.trunks.introduced();
  const owner = app.runtime.owner;
  const workflow = await madeBy(app, ada, { name: "Note", steps: [
    { name: "note", kind: "tool", tool: "memory.put", args: { text: "STALEMARK5521", source: "workflow" } }] });
  // Ada removed while her mark is still about, then that mark runs her own workflow.
  const run = withAccountCall({ owner, sessionId: "", runId: "", trunk: { keys: ada.keys, id: ada.id } }, async () => {
    app.trunks.remove(ada.id);
    return app.workflows.run(owner, workflow.id);
  });
  await assert.rejects(run, /no longer here/);
  const view = app.workflows.view(owner, workflow.id);
  assert.equal(view.status, "idle", "nothing marked running or done");
  assert.equal(JSON.stringify(view.state).includes("STALEMARK5521"), false, "its step never ran as the gone Trunk");
});

test("a flow set going from a mark that outlived its Trunk ends at once, saying why, not left running", async (t) => {
  // NAS d2cd104 (STALE-START): the start was refused before any box, but the run and its task stayed `running`.
  const { withAccountCall } = await import("../dist/accounts/context.js");
  const { app } = await fixture(t, []);
  on(app);
  const ada = app.trunks.create({ name: "Ada" });
  await app.trunks.introduced();
  const graph = app.flows.saveGraph({ name: "Once", input: {}, state: { found: "text" }, entry: "look",
    nodes: [{ id: "look", name: "Look", kind: "tool", tool: "memory.search", args: { query: "zebra" }, output: { found: "text" } }], edges: [] });
  app.trunks.remove(ada.id);
  const { runId } = await withAccountCall({ owner: app.runtime.owner, sessionId: "", runId: "", trunk: { keys: ada.keys, id: ada.id } },
    async () => app.flows.startGraph(graph.id, {}));
  const view = await app.flows.settled(runId);
  assert.equal(view.status, "failed", JSON.stringify(view).slice(0, 200));
  assert.match(String(view.error), /no longer here/);
  assert.equal(app.store.run(runId).status, "failed", "its task ended too");
  assert.match(String(app.store.run(runId).output ?? ""), /no longer here/, "and says why");
  assert.equal(Number(app.store.sqlite.prepare("SELECT COUNT(*) AS n FROM flow_graph_nodes WHERE run_id=?").get(runId).n), 0, "no box ran");
});

/** Q144: a paired computer called Tower, and `trunk` set to start there (Q44), so it cannot work on this one. */
function startsOnTower(app, trunk) {
  const tower = "a1b2c3d4e5f60718";
  app.store.save("settings", app.runtime.owner, "devices-book", { mode: "on", requests: [], devices: [{ id: tower, name: "Tower", platform: "linux",
    publicKey: "k".repeat(44), pairedAt: "2026-09-23T00:00:00.000Z", lastSeen: null, offers: [], enabled: [], folder: null, sharedWith: [] }] });
  app.trunks.edit(trunk.id, { startsIn: tower });
}
const onTower = /starts on Tower/;

test("Q144: a yes to the workflow of a Trunk set to start on another computer is refused before it is written down", async (t) => {
  const { app } = await fixture(t, []);
  on(app);
  const ada = app.trunks.create({ name: "Ada" });
  app.trunks.edit(ada.id, { permissions: ["memory.read", "workflows.manage", "workflows.read"] });
  await app.trunks.introduced();
  const workflow = await madeBy(app, ada, { name: "later", steps: [
    { name: "ok?", kind: "approval", question: "Carry on?" },
    { name: "look", kind: "tool", tool: "memory.search", args: { query: "zebra" } }] });
  const { withAccountCall } = await import("../dist/accounts/context.js");
  await withAccountCall({ owner: app.runtime.owner, sessionId: "", runId: "", trunk: { keys: ada.keys, id: ada.id } },
    () => app.workflows.run(app.runtime.owner, workflow.id));
  startsOnTower(app, ada);
  for (const time of ["first", "second"]) {
    await assert.rejects(app.workflows.resume(app.runtime.owner, workflow.id), onTower, `the ${time} yes`);
    const view = app.workflows.view(app.runtime.owner, workflow.id);
    assert.equal(view.status, "waiting_approval", `still waiting after the ${time} yes`);
    assert.equal(view.question, "Carry on?", "the question is still asked");
    assert.equal(view.cursor, 0);
    assert.equal(view.state.some((step) => step.status === "approved"), false, "no step recorded as approved");
  }
  // Back on this computer, the yes carries it on, and the tool step really runs.
  app.trunks.edit(ada.id, { startsIn: null });
  await app.workflows.resume(app.runtime.owner, workflow.id);
  const done = app.workflows.view(app.runtime.owner, workflow.id);
  assert.equal(done.status, "completed", JSON.stringify(done).slice(0, 300));
  assert.notEqual(done.state[1]?.status, "approved", "the tool step ran rather than being written off as approved");
});

test("Q144: carrying on the flow run of a Trunk set to start on another computer leaves it as it stopped, not working", async (t) => {
  const { withAccountCall } = await import("../dist/accounts/context.js");
  const { app } = await fixture(t, []);
  on(app);
  const ada = app.trunks.create({ name: "Ada" });
  await app.trunks.introduced();
  const graph = app.flows.saveGraph({ name: "Twice", input: {}, state: { first: "text", second: "text" }, entry: "a",
    nodes: [
      { id: "a", name: "First", kind: "tool", tool: "memory.search", args: { query: "zebra" }, output: { first: "text" } },
      { id: "b", name: "Second", kind: "tool", tool: "memory.search", args: { query: "zebra" }, output: { second: "text" } },
    ], edges: [{ from: "a", to: "b" }] });
  const { runId } = await withAccountCall({ owner: app.runtime.owner, sessionId: "", runId: "", trunk: { keys: ada.keys, id: ada.id } },
    async () => app.flows.startGraph(graph.id, {}));
  await app.flows.settled(runId);
  // As a failure at the second box leaves it, for the owner to press Carry on.
  app.store.sqlite.prepare("UPDATE flow_graph_runs SET status='failed', next_node='b', error='stopped' WHERE run_id=?").run(runId);
  app.store.sqlite.prepare("UPDATE tasks SET status='failed' WHERE id=?").run(runId);
  startsOnTower(app, ada);
  // NAS ebeccfa: the owner is told why, in Q44's words and its 409, not answered "running" while nothing runs.
  assert.throws(() => app.flows.resumeGraph(graph.id, { runId }), (error) => onTower.test(error.message) && error.status === 409);
  const refused = await app.flows.settled(runId);
  assert.equal(refused.status, "failed", `left as it stopped, not working: ${JSON.stringify(refused).slice(0, 300)}`);
  assert.notEqual(app.store.sqlite.prepare("SELECT status FROM tasks WHERE id=?").get(runId).status, "running", "nor its task");
  app.trunks.edit(ada.id, { startsIn: null });
  app.flows.resumeGraph(graph.id, { runId });
  assert.equal((await app.flows.settled(runId)).status, "completed", "back on this computer, it carries on");
});

test("Q144: an 'always' yes to the workflow of a Trunk set to start on another computer writes no standing rule", async (t) => {
  // Legion 109b9bc (NAS's probe-startsin-guarded): before the up-front check, the refused yes still added an allow rule.
  const { readPolicy, savePolicy } = await import("../dist/policy.js");
  const { app } = await fixture(t, []);
  on(app);
  savePolicy(app.store, app.runtime.owner, { preset: "custom", rules: [
    { tool: "files.write", decision: "ask", remember: "session" }, { tool: "*", decision: "allow", remember: "always" }] });
  const ada = app.trunks.create({ name: "Ada" });
  app.trunks.edit(ada.id, { permissions: ["memory.read", "files.read", "files.write", "workflows.manage", "workflows.read"] });
  await app.trunks.introduced();
  const workflow = await madeBy(app, ada, { name: "write", steps: [
    { name: "write", kind: "tool", tool: "files.write", args: { path: "q144.md", content: "x" } }] });
  const { withAccountCall } = await import("../dist/accounts/context.js");
  await withAccountCall({ owner: app.runtime.owner, sessionId: "", runId: "", trunk: { keys: ada.keys, id: ada.id } },
    () => app.workflows.run(app.runtime.owner, workflow.id, "owner"));
  const pending = () => app.store.get("workflows", app.runtime.owner, workflow.id)?.data?.pendingApproval ?? null;
  assert.equal(pending()?.tool, "files.write", "the write stopped to ask");
  const rules = () => JSON.stringify(readPolicy(app.store, app.runtime.owner).rules);
  const before = rules();
  startsOnTower(app, ada);
  for (const time of ["first", "second"]) {
    await assert.rejects(app.workflows.resume(app.runtime.owner, workflow.id, { remember: "always" }), onTower, `the ${time} yes`);
    assert.equal(rules(), before, `no standing rule was written by the ${time} yes`);
    assert.equal(pending()?.tool, "files.write", "the question is still pending");
  }
  // The control: back on this computer, the same "always" yes is kept as a rule and the write goes on.
  app.trunks.edit(ada.id, { startsIn: null });
  await app.workflows.resume(app.runtime.owner, workflow.id, { remember: "always" });
  assert.notEqual(rules(), before, "an 'always' that is carried on is written down");
  assert.equal(app.workflows.view(app.runtime.owner, workflow.id).status, "completed");
});

test("Q144: over HTTP, carrying on a Trunk's workflow or flow run while it is set to start elsewhere is a 409 that says why", async (t) => {
  // NAS ebeccfa: the flow's Carry on answered 200 {status:"running"}, and the workflow's yes a 400.
  const { withAccountCall } = await import("../dist/accounts/context.js");
  const { startServer } = await import("../dist/server.js");
  const { app, root } = await fixture(t, []);
  on(app);
  const ada = app.trunks.create({ name: "Ada" });
  app.trunks.edit(ada.id, { permissions: ["memory.read", "workflows.manage", "workflows.read"] });
  await app.trunks.introduced();
  const asAda = (work) => withAccountCall({ owner: app.runtime.owner, sessionId: "", runId: "", trunk: { keys: ada.keys, id: ada.id } }, work);
  const workflow = await madeBy(app, ada, { name: "later", steps: [
    { name: "ok?", kind: "approval", question: "Carry on?" },
    { name: "look", kind: "tool", tool: "memory.search", args: { query: "zebra" } }] });
  await asAda(() => app.workflows.run(app.runtime.owner, workflow.id));
  const graph = app.flows.saveGraph({ name: "Once", input: {}, state: { first: "text" }, entry: "a",
    nodes: [{ id: "a", name: "First", kind: "tool", tool: "memory.search", args: { query: "zebra" }, output: { first: "text" } }], edges: [] });
  const { runId } = await asAda(async () => app.flows.startGraph(graph.id, {}));
  await app.flows.settled(runId);
  app.store.sqlite.prepare("UPDATE flow_graph_runs SET status='failed', next_node='a', error='stopped' WHERE run_id=?").run(runId);
  startsOnTower(app, ada);
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  t.after(() => server.close());
  const post = (path, body) => fetch(new URL(path, server.url), { method: "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify(body) })
    .then(async (response) => ({ status: response.status, body: await response.json() }));
  for (const [what, path] of [["the workflow's yes", `/api/workflows/${workflow.id}/resume`], ["the flow's Carry on", `/api/flows/${graph.id}/resume`]]) {
    const answer = await post(path, {});
    assert.equal(answer.status, 409, `${what}: ${JSON.stringify(answer.body)}`);
    assert.match(String(answer.body.error), onTower, what);
  }
  assert.equal(app.workflows.view(app.runtime.owner, workflow.id).status, "waiting_approval");
  assert.equal((await app.flows.settled(runId)).status, "failed", "the flow run is left as it stopped");
});

test("Q144: carrying on the flow run of a Trunk that is gone still ends it saying why before the owner is told", async (t) => {
  // NAS review of Q148: the refusal is thrown only after the resume has ended the gone Trunk's run (Q122), not instead of it.
  const { withAccountCall } = await import("../dist/accounts/context.js");
  const { app } = await fixture(t, []);
  on(app);
  const ada = app.trunks.create({ name: "Ada" });
  await app.trunks.introduced();
  const graph = app.flows.saveGraph({ name: "Twice", input: {}, state: { first: "text", second: "text" }, entry: "a",
    nodes: [
      { id: "a", name: "First", kind: "tool", tool: "memory.search", args: { query: "zebra" }, output: { first: "text" } },
      { id: "b", name: "Second", kind: "tool", tool: "memory.search", args: { query: "zebra" }, output: { second: "text" } },
    ], edges: [{ from: "a", to: "b" }] });
  const { runId } = await withAccountCall({ owner: app.runtime.owner, sessionId: "", runId: "", trunk: { keys: ada.keys, id: ada.id } },
    async () => app.flows.startGraph(graph.id, {}));
  await app.flows.settled(runId);
  // As a failure at the second box leaves it, for the owner to press Carry on; then Ada is removed.
  app.store.sqlite.prepare("UPDATE flow_graph_runs SET status='failed', next_node='b', error='stopped' WHERE run_id=?").run(runId);
  app.store.sqlite.prepare("UPDATE tasks SET status='failed' WHERE id=?").run(runId);
  app.trunks.remove(ada.id);
  assert.throws(() => app.flows.resumeGraph(graph.id, { runId }), /no longer here/, "the owner is told why");
  const ended = await app.flows.settled(runId);
  assert.equal(ended.status, "failed", JSON.stringify(ended).slice(0, 300));
  assert.match(String(ended.error), /no longer here/, "the run itself says why, not the old 'stopped'");
  assert.equal(app.store.run(runId).status, "failed", "its task ended too");
  assert.match(String(app.store.run(runId).output ?? ""), /no longer here/, "and says why");
});

test("Q149 (NAS 839e64b): forking the flow run of a Trunk set to start elsewhere is refused as Q44's 409, and no copy is made", async (t) => {
  const { withAccountCall } = await import("../dist/accounts/context.js");
  const { startServer } = await import("../dist/server.js");
  const { app, root } = await fixture(t, []);
  on(app);
  const ada = app.trunks.create({ name: "Ada" });
  await app.trunks.introduced();
  app.flowsBoards.setMode("time-travel", { mode: "on" }); // so each run's steps are kept to fork from
  const graph = app.flows.saveGraph({ name: "Twice", input: {}, state: { first: "text", second: "text" }, entry: "a",
    nodes: [
      { id: "a", name: "First", kind: "tool", tool: "memory.search", args: { query: "zebra" }, output: { first: "text" } },
      { id: "b", name: "Second", kind: "tool", tool: "memory.search", args: { query: "zebra" }, output: { second: "text" } },
    ], edges: [{ from: "a", to: "b" }] });
  const { runId } = await withAccountCall({ owner: app.runtime.owner, sessionId: "", runId: "", trunk: { keys: ada.keys, id: ada.id } },
    async () => app.flows.startGraph(graph.id, {}));
  await app.flows.settled(runId);
  startsOnTower(app, ada);
  const runs = () => Number(app.store.sqlite.prepare("SELECT COUNT(*) AS n FROM flow_graph_runs").get().n);
  const before = runs();
  assert.throws(() => app.flowsBoards.timeTravel.fork(runId, { seq: 1 }), (error) => onTower.test(error.message) && error.status === 409);
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  t.after(() => server.close());
  const answer = await fetch(new URL(`/api/flows-boards/flows/${runId}/fork`, server.url), { method: "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify({ seq: 1 }) });
  const body = await answer.json();
  assert.equal(answer.status, 409, JSON.stringify(body));
  assert.match(String(body.error), onTower);
  assert.equal(runs(), before, "no copy was made");
});
