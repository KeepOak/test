import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createBranch } from "../dist/index.js";
import { accountsServiceFor } from "../dist/accounts/service.js";
import { registerCliAgent } from "../dist/providers/cli-agent.js";
import { saveAccountsSettings, saveSessionChoice } from "../dist/accounts/settings.js";
import { setMode, viewAll } from "../dist/accounts/manage.js";
import { withAccountCall } from "../dist/accounts/context.js";
import { underShortLivedKey } from "../dist/key-context.js";
import { discardTemp } from "./temp-dir.mjs";
import { nativeToolName, nativeToolPrefix } from "../dist/providers/claude-subscription-history.js";
const pool = "cli-claude-code", second = "aaaaaaaa", third = "bbbbbbbb";
const request = () => ({ messages: [{ role: "user", content: "Say ok" }], tools: [], signal: new AbortController().signal, maxTokens: 64 });
function stream(block) {
  const events = [ { type: "message_start", message: { role: "assistant", content: [], usage: { input_tokens: 2, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: block }, { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: block.type === "tool_use" ? "tool_use" : "end_turn" }, usage: { output_tokens: 3 } }, { type: "message_stop" } ];
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
}
async function fixture(t, { mode = "off", runtime = false } = {}) {
  const parent = join(tmpdir(), "Codex-session-files"); await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "claude-factory-")), saved = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = join(root, "primary-native-account");
  let app;
  try { app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") }); }
  finally { if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = saved; }
  t.after(async () => { await app.close(); await discardTemp(root); });
  const service = accountsServiceFor(app.runtime.models), seen = [], launches = [];
  saveAccountsSettings(app.store, app.runtime.owner, { mode, poolingRule: 2, pools: [{ pool, kind: "cli", strategy: "priority", autoSwitch: true, defaultAccount: "primary",
    accounts: ["primary", second, third].map((id) => ({ id, label: id, disabled: false, pinned: false, shared: false, monthlyCapUsd: null, createdAt: new Date().toISOString() })) }] });
  for (const id of ["primary", second, third]) service.noteSignIn(pool, id, { installed: true, signedIn: true, identity: { email: id + "@fixture.invalid", authMethod: "claude.ai" }, message: "Signed in" });
  service.deps.claudeSubscription = {
    spawn: (_command, args, invocation) => { launches.push({ args, env: invocation.env }); return spawn(process.execPath, [resolve("tests/fixtures/claude-subscription-native.mjs"), ...args], invocation); },
    connect: async (_headers, payload) => {
      const body = JSON.parse(payload); seen.push(body);
      const result = body.messages.flatMap((message) => message.content).find((part) => part.type === "tool_result");
      if (runtime && !result) return stream({ type: "tool_use", id: "file-proof", name: body.tools.find((one) => one.description.startsWith("Branch tool files.read.")).name, input: { path: "proof.txt" } });
      return stream({ type: "text", text: result ? result.content : "ok" });
    },
  };
  registerCliAgent(app.runtime.models, { id: "claude-code" });
  setMode(service, { mode });
  app.runtime.models.configure(app.runtime.owner, { activePreset: pool });
  const call = (work, context = {}) => withAccountCall({ owner: app.runtime.owner, sessionId: "fixture", runId: "fixture", ...context }, work);
  return { app, service, seen, launches, call, root, preset: () => app.runtime.models.presets.get(pool) };
}
test("production registration routes the saved/default Claude account through Branch tools even with pooling off", async (t) => {
  const f = await fixture(t, { runtime: true });
  await writeFile(join(f.root, "workspace", "proof.txt"), "actual factory tool loop\n");
  assert.equal(f.preset().model, "claude-opus-5-5"); assert.equal(f.preset().provider.name, "claude-subscription");
  const run = await f.app.runtime.run({ prompt: "Read proof.txt with files.read", permissions: ["files.read"] });
  assert.equal(run.status, "completed"); assert.match(run.output, /actual factory tool loop/);
  assert.equal(f.app.store.events(run.id).filter((one) => one.kind === "tool.completed" && one.data.name === "files.read").length, 1);
  assert.equal(f.seen.length, 2); assert.ok(f.seen.every((body) => body.model === "claude-opus-5-5"));
  assert.ok(f.launches.every((one) => one.env.CLAUDE_CONFIG_DIR === f.service.primaryClaudeHome));
});
test("supported Claude subscription choices route the requested model through Branch tools and share one account pool", async (t) => {
  const f = await fixture(t, { runtime: true });
  await writeFile(join(f.root, "workspace", "proof.txt"), "selected subscription model proof\n");
  const choices = [[pool, "claude-opus-5-5"], [`${pool}-sonnet`, "sonnet"], [`${pool}-opus`, "opus"], [`${pool}-haiku`, "haiku"],
    [`${pool}-sonnet-5`, "claude-sonnet-5"], [`${pool}-haiku-4-5`, "claude-haiku-4-5"]];
  for (const [id, model] of choices) {
    const preset = f.app.runtime.models.presets.get(id);
    assert.ok(preset, `${id} is selectable`);
    assert.equal(preset.model, model);
    assert.deepEqual(f.service.poolFor(preset), { pool, kind: "cli" });
    const offset = f.launches.length, requests = f.seen.length;
    const run = await f.app.runtime.run({ prompt: "Read proof.txt", model: id, permissions: ["files.read"] });
    assert.equal(run.status, "completed"); assert.match(run.output, /selected subscription model proof/);
    assert.equal(f.seen.length - requests, 2);
    assert.ok(f.seen.slice(requests).every((body) => body.model === model));
    assert.ok(f.launches.slice(offset).every((one) => one.args[one.args.indexOf("--model") + 1] === model));
    assert.ok(f.launches.slice(offset).every((one) => one.env.CLAUDE_CONFIG_DIR === f.service.primaryClaudeHome));
  }
  f.service.notePlanWindows(pool, "primary", [{ id: "five-hour", usedPercent: 35, minutes: 300, resetAt: null, measuredAt: new Date().toISOString() }]);
  const listed = (await viewAll(f.service)).pools.filter((one) => one.pool.startsWith(pool));
  assert.equal(listed.length, 1, "model variants never duplicate the signed-in account or its shared allowance");
  assert.equal(f.service.planWindows.get(pool, "primary")[0].usedPercent, 35);
  assert.equal(f.app.runtime.models.settings(f.app.runtime.owner).activePreset, pool);
  assert.equal(f.app.runtime.models.presets.has(`${pool}-fable`), false, "a model that can spend extra usage is not added");
});
test("Claude model variants use canonical account switching and helper account references", async (t) => {
  const f = await fixture(t, { mode: "on", runtime: true }), owner = f.app.runtime.owner;
  await writeFile(join(f.root, "workspace", "proof.txt"), "variant helper proof\n");
  const session = f.app.store.createSession(owner);
  saveSessionChoice(f.app.store, owner, session, pool, second);
  const run = await f.app.runtime.run({ prompt: "Read proof.txt", sessionId: session, model: `${pool}-sonnet-5`, permissions: ["files.read"] });
  assert.equal(run.status, "completed"); assert.match(run.output, /variant helper proof/);
  assert.ok(f.seen.every((body) => body.model === "claude-sonnet-5"));
  assert.ok(f.launches.every((one) => one.env.CLAUDE_CONFIG_DIR === f.service.homeOf(pool, second)));
  // A native transport now serves every round of one conversation, so launches and requests are counted apart.
  const before = f.launches.length, beforeSeen = f.seen.length;
  const helper = await f.app.runtime.delegate("Read proof.txt", f.app.runtime.context({ runId: run.id }), ["files.read"], "", {
    model: `${pool}-haiku-4-5`, accountRef: { pool, account: third },
  });
  assert.equal(helper.status, "completed"); assert.match(helper.output, /variant helper proof/);
  assert.ok(f.seen.slice(beforeSeen).every((body) => body.model === "claude-haiku-4-5"));
  assert.ok(f.launches.slice(before).every((one) => one.env.CLAUDE_CONFIG_DIR === f.service.homeOf(pool, third)));
  assert.equal(f.service.pool(pool).defaultAccount, "primary");
});
test("parallel helpers use distinct saved Claude accounts through Branch's tool loop", async (t) => {
  const f = await fixture(t, { runtime: true });
  await writeFile(join(f.root, "workspace", "proof.txt"), "helper account proof\n");
  const parent = await f.app.runtime.run({ prompt: "Read proof.txt", permissions: ["files.read"] });
  assert.equal(parent.status, "completed");
  const offset = f.launches.length;
  const context = f.app.runtime.context({ runId: parent.id });
  const prompts = [second, third].map((account) => f.app.runtime.delegate("Read proof.txt", context, ["files.read"], "", {
    model: pool, accountRef: { pool, account },
  }));
  const children = await Promise.all(prompts);
  assert.ok(children.every((run) => run.status === "completed" && run.output.includes("helper account proof")));
  assert.equal(new Set(children.map((run) => run.sessionId)).size, 2);
  assert.deepEqual([...new Set(f.launches.slice(offset).map((call) => call.env.CLAUDE_CONFIG_DIR))].sort(),
    [f.service.homeOf(pool, second), f.service.homeOf(pool, third)].sort());
  for (const child of children)
    assert.equal(f.app.store.events(child.id).filter((event) => event.kind === "tool.completed" && event.data.name === "files.read").length, 1);
  assert.equal(f.service.pool(pool).defaultAccount, "primary", "helpers never change the owner's account order");
});
test("concurrent account/model providers preserve independent native homes and canonical requests", async (t) => {
  const f = await fixture(t), defaulted = f.preset(), opus = { ...defaulted, model: "opus", id: pool };
  const a = await f.service.providerFor(pool, "cli", defaulted, second), b = await f.service.providerFor(pool, "cli", opus, third);
  await f.call(() => Promise.all([a.complete(request()), b.complete(request())]));
  assert.deepEqual(f.seen.map((body) => body.model).sort(), ["claude-opus-5-5", "opus"]);
  assert.deepEqual(f.launches.map((one) => one.env.CLAUDE_CONFIG_DIR).sort(), [f.service.homeOf(pool, second), f.service.homeOf(pool, third)].sort());
  assert.notEqual(a, b);
});
test("signed-out, unknown/API authentication, duplicate and owner/Trunk refusals occur before native generation", async (t) => {
  const f = await fixture(t), native = f.preset().provider;
  for (const status of [{ signedIn: false }, { signedIn: null }, { signedIn: true, identity: { authMethod: "api-key" } }, { signedIn: true, identity: { authMethod: "unknown" } }]) {
    f.service.noteSignIn(pool, "primary", { installed: true, message: "fixture", ...status });
    await assert.rejects(f.call(() => native.complete(request())), /not ready/);
  }
  f.service.noteSignIn(pool, "primary", { installed: true, signedIn: true, identity: { email: "duplicate@fixture.invalid", authMethod: "claude.ai" }, message: "fixture" });
  f.service.noteSignIn(pool, second, { installed: true, signedIn: true, identity: { email: "duplicate@fixture.invalid", authMethod: "claude.ai" }, message: "fixture" });
  const duplicate = await f.service.providerFor(pool, "cli", f.preset(), second);
  await assert.rejects(f.call(() => duplicate.complete(request())), /not ready/);
  await assert.rejects(f.call(() => native.complete(request()), { owner: "profile:other" }), /owner/);
  await assert.rejects(f.call(() => native.complete(request()), { trunk: { keys: { copyFromOwner: false, accounts: {} }, signIns: false } }), /sign-in accounts/);
  await assert.rejects(f.call(() => underShortLivedKey(() => native.complete(request()))), /owner/);
  assert.equal(f.seen.length, 0); assert.equal(f.launches.length, 0);
});
test("measure creates a scoped owner diagnostic and keeps existing Trunk and household refusals", async (t) => {
  const f = await fixture(t);
  await f.service.measure(pool, second, new AbortController().signal);
  assert.equal(f.seen.length, 1); assert.equal(f.launches[0].env.CLAUDE_CONFIG_DIR, f.service.homeOf(pool, second));
  await assert.rejects(f.call(() => f.service.measure(pool, second, new AbortController().signal), { trunk: { keys: { copyFromOwner: true, accounts: {} }, signIns: false } }), /sign-in accounts/);
  await assert.rejects(underShortLivedKey(() => f.service.measure(pool, second, new AbortController().signal)), /owner/);
  assert.equal(f.seen.length, 1);
});
test("late status completion cannot launch for a changed household profile and checks the captured primary home", async (t) => {
  const f = await fixture(t), savedPath = process.env.PATH, savedHome = process.env.CLAUDE_CONFIG_DIR;
  const bin = join(f.root, "bin"); await mkdir(bin);
  await writeFile(join(bin, "claude"), "", { mode: 0o755 }); await writeFile(join(bin, "claude.cmd"), "");
  process.env.PATH = bin; process.env.CLAUDE_CONFIG_DIR = join(f.root, "changed-home");
  t.after(() => { process.env.PATH = savedPath; if (savedHome === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = savedHome; });
  f.service.signIns.clear(); let release, began;
  const waiting = new Promise((go) => { began = go; });
  f.service.deps.statusRun = async (_row, _args, env) => {
    began(); assert.equal(env.CLAUDE_CONFIG_DIR, f.service.primaryClaudeHome);
    await new Promise((go) => { release = go; });
    return { code: 0, missing: false, stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai", email: "fixture@fixture.invalid" }) };
  };
  const failed = assert.rejects(f.call(() => f.preset().provider.complete(request())), /owner/);
  await waiting; const person = f.app.store.profiles.create({ name: "Fixture", pin: "1234" });
  f.app.store.profiles.switch({ profileId: person.id, pin: "1234" }); release(); await failed;
  assert.equal(f.launches.length, 0); assert.equal(f.seen.length, 0);
  f.app.store.profiles.switch({ profileId: null });
});
test("helper resolution pins the parent pick once without global registration, default mutation or account fallback", async (t) => {
  const f = await fixture(t, { mode: "on" }), owner = f.app.runtime.owner;
  const parent = f.app.store.createSession(owner), child = f.app.store.createSession(owner);
  saveSessionChoice(f.app.store, owner, parent, pool, second);
  const before = JSON.stringify(f.service.settings()), registered = f.preset();
  const bound = await f.call(() => f.service.resolveHelper(registered, undefined, parent));
  assert.deepEqual(bound.accountRef, { pool, account: second });
  assert.equal(JSON.stringify(f.service.settings()), before); assert.equal(f.preset(), registered);
  assert.ok(Object.isFrozen(bound.preset) && Object.isFrozen(bound.accountRef));
  saveSessionChoice(f.app.store, owner, parent, pool, third);
  await f.call(() => bound.preset.provider.complete(request()), { sessionId: child });
  assert.equal(f.launches[0].env.CLAUDE_CONFIG_DIR, f.service.homeOf(pool, second));
  const settings = f.service.settings(); settings.pools[0].accounts.find((one) => one.id === second).disabled = true;
  saveAccountsSettings(f.app.store, owner, settings);
  await assert.rejects(f.call(() => bound.preset.provider.complete(request()), { sessionId: child }), /switched off/);
  assert.equal(f.seen.length, 1, "another account did not answer the explicitly pinned child");
});
test("helper resolution refuses unknown/mismatched/duplicate accounts and retains inherited authority", async (t) => {
  const f = await fixture(t), parent = f.app.store.createSession(f.app.runtime.owner);
  const resolveHelper = (ref, context = {}) => f.call(() => f.service.resolveHelper(f.preset(), ref, parent), context);
  await assert.rejects(resolveHelper({ pool: "another", account: second }), /another model/);
  await assert.rejects(resolveHelper({ pool, account: "dddddddd" }), /missing/);
  await assert.rejects(resolveHelper({ pool, account: second }, { owner: "profile:other" }), /owner/);
  await assert.rejects(resolveHelper({ pool, account: second }, { trunk: { keys: { copyFromOwner: false, accounts: {} }, signIns: false } }), /sign-in accounts/);
  await assert.rejects(f.call(() => underShortLivedKey(() => f.service.resolveHelper(f.preset(), { pool, account: second }, parent))), /owner/);
  f.service.noteSignIn(pool, second, { installed: true, signedIn: false, message: "signed out" });
  await assert.rejects(resolveHelper({ pool, account: second }), /not ready/);
  f.service.noteSignIn(pool, second, { installed: true, signedIn: true, identity: { authMethod: "claude.ai" }, message: "ready" });
  f.service.providerFor = async () => null;
  await assert.rejects(resolveHelper({ pool, account: second }), /exact account/);
  assert.equal(f.launches.length, 0); assert.equal(f.seen.length, 0);
});
test("household and short-key helpers keep authorized local models while owned account refs remain private", async (t) => {
  const f = await fixture(t), person = f.app.store.profiles.create({ name: "Fixture", pin: "1234" });
  f.app.store.profiles.switch({ profileId: person.id, pin: "1234" });
  const owner = f.app.store.profiles.scope(), parent = f.app.store.createSession(owner);
  const provider = { name: "scripted", complete: async () => ({ content: "local", toolCalls: [] }) };
  f.app.runtime.models.register({ id: "helper-local", name: "Local fixture", model: "local", provider });
  const preset = f.app.runtime.models.presets.get("helper-local");
  const bound = await f.call(() => underShortLivedKey(() => f.service.resolveHelper(preset, undefined, parent)), { owner });
  assert.equal(bound.accountRef, undefined); assert.equal((await bound.preset.provider.complete(request())).content, "local");
  await assert.rejects(f.call(() => f.service.resolveHelper(preset, { pool, account: second }, parent), { owner }), /no account pool/);
  f.app.store.profiles.switch({ profileId: null });
});
test("revoking a Trunk sign-in or registered model during completion withholds the helper response and account step", async (t) => {
  for (const revoke of ["trunk", "model"]) {
    const f = await fixture(t), owner = f.app.runtime.owner, parent = f.app.store.createSession(owner);
    let release, began; const waiting = new Promise((go) => { began = go; });
    f.service.deps.spawnAgent = async () => {
      began(); await new Promise((go) => { release = go; });
      return { code: 0, stdout: JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "withheld" } }), stderr: "" };
    };
    registerCliAgent(f.app.runtime.models, { id: "codex" });
    f.service.noteSignIn("cli-codex", "primary", { installed: true, signedIn: true, message: "Fixture saved sign-in" });
    const trunk = { keys: { copyFromOwner: true, accounts: {} }, signIns: true }, notes = [];
    const context = { trunk, note: (kind, data) => notes.push({ kind, data }) };
    const bound = await f.call(() => f.service.resolveHelper(f.app.runtime.models.presets.get("cli-codex"), undefined, parent), context);
    const rejected = assert.rejects(f.call(() => bound.preset.provider.complete(request()), context), revoke === "trunk" ? /sign-in accounts/ : /model connection changed/);
    await waiting;
    if (revoke === "trunk") trunk.signIns = false; else f.app.runtime.models.presets.delete("cli-codex");
    release(); await rejected;
    assert.deepEqual(notes, [], "no account label or usage step is published for the revoked result");
  }
});
test("a Trunk on its picked Claude account runs a Branch tool within its own permissions, and one outside them is refused", async (t) => {
  const f = await fixture(t, { mode: "on" }), bodies = [];
  let ask = "files.read";
  f.service.deps.claudeSubscription.connect = async (_headers, payload) => {
    const body = JSON.parse(payload); bodies.push(body);
    const result = body.messages.at(-1).content.find((part) => part.type === "tool_result");
    if (result) return stream({ type: "text", text: `second round: ${typeof result.content === "string" ? result.content : JSON.stringify(result.content)}` });
    const input = ask === "files.read" ? { path: "proof.txt" } : { path: "outside.txt", content: "not allowed" };
    return stream({ type: "tool_use", id: `call-${bodies.length}`, name: nativeToolPrefix + nativeToolName(ask), input });
  };
  f.app.trunks.setMode("trunks", { mode: "on" });
  const ed = f.app.trunks.create({ name: "Ed" });
  f.app.trunks.edit(ed.id, { permissions: ["files.read"], keys: { copyFromOwner: false, accounts: { [pool]: second } } });
  await f.app.trunks.introduced();
  const own = join(f.root, "workspace", ".branch-agents", ed.id); // a Trunk reads and writes in its own folder
  await mkdir(own, { recursive: true }); await writeFile(join(own, "proof.txt"), "trunk account proof\n");
  bodies.length = 0; f.launches.length = 0;
  const run = await f.app.runtime.run({ prompt: "Read proof.txt with files.read", sessionId: ed.chatSessionId });
  assert.equal(run.status, "completed", run.output);
  assert.match(run.output, /^second round: .*trunk account proof/, "the second round answers from the tool's result");
  const events = f.app.store.events(run.id);
  assert.deepEqual(events.filter((one) => one.kind === "tool.completed").map((one) => one.data.name), ["files.read"]);
  assert.deepEqual(events.filter((one) => one.kind === "model.account").map((one) => one.data.account), [second, second], "both rounds on the Trunk's pick");
  assert.equal(bodies.length, 2, "two rounds through the Claude subscription transport");
  assert.ok(f.launches.length && f.launches.every((one) => one.env.CLAUDE_CONFIG_DIR === f.service.homeOf(pool, second)), "the picked account's own home");
  const offered = bodies[0].tools.map((tool) => tool.description.split(". ")[0]);
  assert.ok(offered.includes("Branch tool files.read") && !offered.includes("Branch tool files.write"), "only the Trunk's own tools are offered");
  // A tool outside the Trunk's permissions is never offered, so a call naming it is refused before anything runs.
  ask = "files.write"; bodies.length = 0;
  const refused = await f.app.runtime.run({ prompt: "Write outside.txt", sessionId: ed.chatSessionId });
  assert.equal(refused.status, "failed", refused.output);
  assert.ok(!f.app.store.events(refused.id).some((one) => one.kind.startsWith("tool.")), "no tool started");
  await assert.rejects(stat(join(own, "outside.txt")), { code: "ENOENT" });
  await assert.rejects(stat(join(f.root, "workspace", "outside.txt")), { code: "ENOENT" });
  assert.equal(f.service.pool(pool).defaultAccount, "primary", "the Trunk's pick never changes the owner's default");
});
/* models-ui (owner, DOGFOOD C2): Claude answers with Opus 5.5 at medium effort unless something else was chosen. */
const effortOf = (launch) => { const at = launch.args.indexOf("--effort"); return at < 0 ? null : launch.args[at + 1]; };
const modelOf = (launch) => launch.args[launch.args.indexOf("--model") + 1];
test("Claude's default is Opus 5.5 at medium effort, for a new and a legacy registration alike", async (t) => {
  const f = await fixture(t);
  assert.equal(f.preset().model, "claude-opus-5-5"); assert.equal(f.preset().reasoning, "medium");
  assert.equal(f.app.runtime.models.summary(f.app.runtime.owner).presets.find((p) => p.id === pool).startsAt, "medium");
  let run = await f.app.runtime.run({ prompt: "Say ok" });
  assert.equal(run.status, "completed", run.output);
  assert.equal(modelOf(f.launches.at(-1)), "claude-opus-5-5"); assert.equal(effortOf(f.launches.at(-1)), "medium");
  // A connection saved before Claude had a default of its own names the command as its model.
  f.app.runtime.models.register({ ...f.preset(), model: "claude", reasoning: undefined });
  assert.equal(f.preset().model, "claude-opus-5-5"); assert.equal(f.preset().reasoning, "medium");
  run = await f.app.runtime.run({ prompt: "Say ok" });
  assert.equal(run.status, "completed", run.output);
  assert.equal(modelOf(f.launches.at(-1)), "claude-opus-5-5"); assert.equal(effortOf(f.launches.at(-1)), "medium");
});
test("an explicit Claude model and the owner's own effort are kept over the default", async (t) => {
  const f = await fixture(t);
  f.app.runtime.models.register({ ...f.preset(), model: "sonnet", reasoning: "high" });
  assert.equal(f.preset().model, "sonnet"); assert.equal(f.preset().reasoning, "high");
  let run = await f.app.runtime.run({ prompt: "Say ok" });
  assert.equal(run.status, "completed", run.output);
  assert.equal(modelOf(f.launches.at(-1)), "sonnet"); assert.equal(effortOf(f.launches.at(-1)), "high");
  f.app.runtime.models.configure(f.app.runtime.owner, { reasoning: "low" }); // the owner's Branch-wide pick
  run = await f.app.runtime.run({ prompt: "Say ok" });
  assert.equal(run.status, "completed", run.output);
  assert.equal(effortOf(f.launches.at(-1)), "low");
});
test("models-ui: a specialist's saved Claude account answers its helpers through Branch's tool loop", async (t) => {
  const { saveHelperDefault, helperDefaultsView } = await import("../dist/helper-defaults-api.js");
  const f = await fixture(t, { runtime: true });
  await writeFile(join(f.root, "workspace", "proof.txt"), "specialist account proof\n");
  const { id } = await f.app.registry.execute("specialists.propose", { name: "Reader", instructions: "You read.", permissions: ["files.read"],
    evaluation: { prompt: "say ready", checks: [{ path: "reader.txt", expected: "ready" }] } }, f.app.runtime.context());
  const choice = helperDefaultsView(f.app.store, f.app.runtime.owner, f.app.runtime.models).choices.find((c) => c.model === pool);
  assert.deepEqual(choice.accounts.map((a) => a.id), ["primary", second, third]);
  assert.equal(choice.accounts.find((a) => a.id === third).label, `${third}@fixture.invalid`, "named by its verified email");
  saveHelperDefault(f.app.store, f.app.runtime.owner, f.app.runtime.models, { specialist: id, model: pool, accountRef: { pool, account: third } });
  const parent = await f.app.runtime.run({ prompt: "Read proof.txt", permissions: ["files.read"] });
  assert.equal(parent.status, "completed");
  const before = f.launches.length;
  const child = await f.app.runtime.delegate("Read proof.txt", f.app.runtime.context({ runId: parent.id }), ["files.read"], "", { agent: id });
  assert.equal(child.status, "completed", child.output); assert.match(child.output, /specialist account proof/);
  assert.ok(f.launches.slice(before).every((one) => one.env.CLAUDE_CONFIG_DIR === f.service.homeOf(pool, third)), "the saved account's own Claude folder");
  assert.equal(f.service.pool(pool).defaultAccount, "primary", "the owner's account order is untouched");
});
test("the window's model list names the account pool of every Claude variant, as the accounts service does (MODEL-135)", async (t) => {
  const f = await fixture(t);
  const listed = f.app.runtime.models.summary(f.app.runtime.owner).presets;
  for (const id of [pool, `${pool}-sonnet`, `${pool}-haiku-4-5`]) {
    const one = listed.find((preset) => preset.id === id);
    assert.ok(one, `${id} is listed`);
    assert.equal(one.accountPool, f.service.poolFor(f.app.runtime.models.presets.get(id)).pool, `${id} uses the Claude account pool`);
  }
});
