import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";

/**
 * Wave 8: the rows the 2026-09-17 ledger verification re-opened. Each test names the audit id it
 * stands for, and asserts the behaviour the row promised rather than that a symbol exists.
 */
export const say = (content) => ({ content, toolCalls: [] });
export const call = (name, args) =>
  ({ content: "", toolCalls: [{ id: `c${Math.random().toString(36).slice(2, 9)}`, name, arguments: JSON.stringify(args) }] });

/** A provider whose answer is chosen from the request, so a test can make the model ask for a tool. */
function scripted(reply) {
  const provider = { name: "scripted", requests: [], async complete(request) {
    provider.requests.push(request);
    const user = [...request.messages].reverse().find((m) => m.role === "user")?.content ?? "";
    return reply({ user, last: request.messages.at(-1), request });
  } };
  return provider;
}
async function fixture(t, reply = () => say("done")) {
  const root = await mkdtemp(join(tmpdir(), "branch-reopened-"));
  const provider = scripted(reply);
  const app = await createBranch({
    workspace: join(root, "workspace"), dataDir: join(root, "data"),
    presets: [{ id: "alpha", name: "Alpha", provider, model: "a" }],
  });
  t.after(async () => { await app.close(); await discardTemp(root); });
  return { app, root, provider, alpha: provider };
}

/** A password manager's command line that never leaves this process. */
function fakeCli(answers) {
  const calls = [];
  return {
    calls,
    runner: async (executable, args, timeoutMs) => {
      calls.push({ executable, args, timeoutMs });
      const answer = answers[executable];
      if (!answer) return { code: null, stdout: "", stderr: "", missing: true };
      return typeof answer === "function" ? answer(args) : answer;
    },
  };
}

// ---------------------------------------------------------------- A1519 / A1841

test("A1519/A1841 a bitwarden and a 1password reference are resolved through the owner's own command line, only at the call", async (t) => {
  const { app } = await fixture(t);
  const { CredentialResolver, saveCredentialSettings, parseCredentialReference, commandFor } =
    await import("../dist/credential-cli.js");
  const cli = fakeCli({
    bw: { code: 0, stdout: "bw-password-8f7e6d\n", stderr: "" },
    op: { code: 0, stdout: "op-password-1a2b3c", stderr: "" },
  });
  const resolver = new CredentialResolver(app.store, "local", app.store.secrets.scrubber, cli.runner);

  // Off until the owner turns it on, and then only for the services they ticked.
  await assert.rejects(resolver.read({ service: "bitwarden", item: "GitHub" }, { purpose: "test" }),
    /not set up to read passwords/);
  saveCredentialSettings(app.store, "local", { enabled: true, services: ["bitwarden"] });
  await assert.rejects(resolver.read({ service: "1password", item: "Private/GitHub/password" }, { purpose: "test" }),
    /not allowed to read from 1Password/);
  saveCredentialSettings(app.store, "local", { enabled: true, services: ["bitwarden", "1password"] });

  assert.deepEqual(parseCredentialReference("secret://bitwarden/GitHub Deploy"), { service: "bitwarden", item: "GitHub Deploy" });
  assert.equal(parseCredentialReference("secret://default/DEPLOY_TOKEN"), null, "a locker reference is not a vault reference");
  assert.deepEqual(commandFor({ service: "bitwarden", item: "GitHub" }, { bitwardenCommand: "bw", onePasswordCommand: "op" }).args,
    ["--nointeraction", "--raw", "get", "password", "GitHub"]);

  const filled = await resolver.fill(
    { header: "Bearer secret://bitwarden/GitHub", other: "secret://1password/Private/Deploy/password", untouched: 7 },
    { purpose: "a test" });
  assert.equal(filled.header, "Bearer bw-password-8f7e6d", "the trailing newline is taken off");
  assert.equal(filled.other, "op-password-1a2b3c");
  assert.equal(filled.untouched, 7);
  assert.deepEqual(cli.calls.map((c) => c.executable), ["bw", "op"]);
  assert.ok(cli.calls[1].args.includes("op://Private/Deploy/password"), "1Password is read by its own path");

  // The value never reaches the record, and is taken back out of anything written afterwards.
  const written = app.store.audit.list("local").filter((row) => row.action === "secret.used");
  assert.ok(written.some((row) => row.subject === "secret://bitwarden/GitHub"), "the item name is recorded");
  assert.ok(!JSON.stringify(written).includes("bw-password-8f7e6d"), "the password is not");
  assert.match(app.store.secrets.scrubber.text("the key is bw-password-8f7e6d ok"), /\[secret bitwarden:GitHub\]/);
});

test("A1519 a missing or locked command line is a plain refusal, never a guess", async (t) => {
  const { app } = await fixture(t);
  const { CredentialResolver, saveCredentialSettings, refusalFrom } = await import("../dist/credential-cli.js");
  saveCredentialSettings(app.store, "local", { enabled: true, services: ["bitwarden", "1password"] });
  const absent = new CredentialResolver(app.store, "local", app.store.secrets.scrubber, fakeCli({}).runner);
  await assert.rejects(absent.read({ service: "bitwarden", item: "GitHub" }, { purpose: "t" }),
    /Bitwarden's command line \(bw\) is not on this computer/);
  const shut = new CredentialResolver(app.store, "local", app.store.secrets.scrubber,
    fakeCli({ bw: { code: 1, stdout: "", stderr: "You are not logged in." } }).runner);
  await assert.rejects(shut.read({ service: "bitwarden", item: "GitHub" }, { purpose: "t" }), /vault is locked/);
  assert.match(refusalFrom({ service: "1password", item: "x" }, { code: 1, stdout: "", stderr: "could not find item" }, "op"),
    /There is nothing called "x" in your 1Password vault\./);
  assert.equal(refusalFrom({ service: "bitwarden", item: "x" }, { code: 0, stdout: "value", stderr: "" }, "bw"), null);
});

test("A1841 the locker still resolves its own references while a vault reference goes to the vault", async (t) => {
  const { app } = await fixture(t);
  const { CredentialResolver, saveCredentialSettings } = await import("../dist/credential-cli.js");
  await app.store.locker.set("local", "default", "DEPLOY_TOKEN", "tok-local-4d5e6f");
  saveCredentialSettings(app.store, "local", { enabled: true, services: ["bitwarden"] });
  app.store.secrets.credentials = new CredentialResolver(app.store, "local", app.store.secrets.scrubber,
    fakeCli({ bw: { code: 0, stdout: "bw-value-7a8b", stderr: "" } }).runner);
  const filled = await app.store.secrets.fill("local", "default",
    { a: "secret://default/DEPLOY_TOKEN", b: "secret://bitwarden/GitHub" }, { purpose: "both at once" });
  assert.deepEqual(filled, { a: "tok-local-4d5e6f", b: "bw-value-7a8b" });
});

// ---------------------------------------------------------------- A0245 / A2277

function taskContext(app, prompt = "a task") {
  const run = app.store.createRun(app.runtime.owner, prompt);
  return { run, context: app.runtime.context({ runId: run.id }) };
}
const allowScripts = (app, network = true) => app.store.save("settings", app.runtime.owner, "code-run",
  { enabled: true, python: "", network, timeoutMs: 8000, maxMemoryMb: 256, maxCpuSeconds: 10, maxOutputBytes: 2048 });
/** A script that prints where its way out to the internet points, or says it is open. */
const proxyProbe = 'console.log(process.env.HTTPS_PROXY || "reachable")';

test("A0245/A2277 an approval rule picks how tightly a program is held, and code.run honours it", async (t) => {
  const { app } = await fixture(t);
  const { savePolicy } = await import("../dist/policy.js");
  const { sandboxShape, shapeChoice, ruleSentence } = await import("../dist/index.js");
  allowScripts(app);
  const { context } = taskContext(app);

  // Without a rule the script settings decide, exactly as before rules could say anything.
  const plain = await app.registry.execute("code.run", { language: "javascript", source: proxyProbe }, context);
  assert.match(plain.output, /reachable/, "network: true in the script settings still means reachable");
  assert.equal(plain.sandbox, "limits-only");

  // A rule that says "no way out to the internet" reaches the program that is started.
  savePolicy(app.store, app.runtime.owner,
    { rules: [{ tool: "code.run", match: "*", applies: "any", decision: "allow", remember: "session", sandbox: "no-internet" }] });
  const check = app.runtime.checkPolicy("code.run", { language: "javascript", source: proxyProbe }, context);
  assert.equal(check.sandbox, "no-internet", "the rule's choice comes back with the decision");
  const held = await app.registry.execute("code.run", { language: "javascript", source: proxyProbe },
    { ...context, sandbox: check.sandbox });
  assert.match(held.output, /127\.0\.0\.1:9/, "the script is pointed at a dead address");
  assert.equal(held.sandbox, "no-internet");
  assert.equal(held.network, false);

  // "none" adds no box of its own, but it cannot take away the limits the script settings hold:
  // a rule only ever tightens, so the script still runs held, and says so.
  const loose = await app.registry.execute("code.run", { language: "javascript", source: proxyProbe },
    { ...context, sandbox: "none" });
  assert.match(loose.output, /reachable/);
  assert.equal(loose.sandbox, "limits-only");
  assert.deepEqual(sandboxShape("none", { job: false, netless: false }), { job: false, netless: false },
    "where the settings hold nothing, none still means no box");

  assert.deepEqual(sandboxShape(undefined, { job: true, netless: false }), { job: true, netless: false });
  assert.equal(shapeChoice({ job: true, netless: true }), "no-internet");
  assert.match(ruleSentence({ tool: "code.run", match: "*", applies: "any", decision: "ask", sandbox: "no-internet" }),
    /Run it in a box .* no way out to the internet\./);
});

test("A2277 a rule holds a program more tightly than the settings, never more loosely", async (t) => {
  const { app } = await fixture(t);
  const { sandboxShape } = await import("../dist/index.js");
  allowScripts(app, false); // The owner has switched the internet off for scripts, in Settings.
  const { context } = taskContext(app);

  for (const choice of ["limits-only", "none"]) {
    const run = await app.registry.execute("code.run", { language: "javascript", source: proxyProbe },
      { ...context, sandbox: choice });
    assert.match(run.output, /127\.0\.0\.1:9/, `a "${choice}" rule must not re-open the internet the settings closed`);
    assert.equal(run.network, false);
  }

  // "none" cannot loosen either field: the limits the settings hold stay, as does the closed internet.
  const loose = await app.registry.execute("code.run", { language: "javascript", source: proxyProbe },
    { ...context, sandbox: "none" });
  assert.equal(loose.sandbox, "no-internet");
  assert.deepEqual(sandboxShape("none", { job: true, netless: false }), { job: true, netless: false });

  // And the rule can still tighten a tool the settings leave open.
  assert.deepEqual(sandboxShape("no-internet", { job: true, netless: false }), { job: true, netless: true });
  assert.deepEqual(sandboxShape("limits-only", { job: true, netless: true }), { job: true, netless: true });
});

test("A0245 the choice reaches the question the model's turn stops on, and an older rule list still reads back", async (t) => {
  const { app } = await fixture(t);
  const { savePolicy, readPolicy, PolicySchema } = await import("../dist/policy.js");
  allowScripts(app);
  savePolicy(app.store, app.runtime.owner,
    { rules: [{ tool: "code.run", match: "*", applies: "any", decision: "ask", remember: "session", sandbox: "limits-only" }] });
  const run = await app.runtime.run({ prompt: "run a script", toolCalls: undefined }).catch(() => null);
  assert.ok(run, "the fixture model answers without tools");

  // The gate hands the rule's choice to the card through the same record the socket reads.
  const { run: task } = taskContext(app);
  app.runtime.approvals.ask({ runId: task.id, sessionId: task.sessionId, tool: "code.run", target: "",
    label: "run a small script", question: "Before I go ahead?", source: "owner", remember: "session",
    sandbox: "limits-only", askedAt: new Date().toISOString() });
  assert.equal(app.runtime.approvals.waiting(task.sessionId).at(-1).sandbox, "limits-only");

  // A rule list saved before this field existed still reads back whole, rather than being wiped.
  app.store.save("settings", app.runtime.owner, "policy", { preset: "custom",
    rules: [{ tool: "shell.execute", match: "*", applies: "any", decision: "ask", remember: "session" }],
    limits: { toolCallsPerMinute: 0, modelRoundsPerMinute: 0 } });
  assert.equal(readPolicy(app.store, app.runtime.owner).rules.length, 1, "an old saved policy is not wiped");
  assert.equal(PolicySchema.parse({ rules: [{ decision: "allow" }] }).rules[0].sandbox, undefined);
});

// ---------------------------------------------------------------- A0824 / A1126

/** A hook that answers with whatever verdict the test hands it, and counts how often it was asked. */
function scriptedHook(verdict, { slow = false } = {}) {
  const seen = [];
  return {
    seen,
    runner: async (hook, payload) => {
      seen.push({ hook: hook.id, payload });
      if (slow) await new Promise((resolve) => setTimeout(resolve, hook.timeoutMs + 800).unref?.() ?? setTimeout(resolve, 5));
      return verdict === "fail" ? { ok: false, error: "the check fell over" } : { ok: true, verdict };
    },
  };
}

test("A0824/A1126 a check turns an allow into a question that really stops the task, and into a refusal", async (t) => {
  // The model asks to write a file once, then answers; nothing in the policy holds it back.
  const { app } = await fixture(t, ({ last }) =>
    last?.role === "tool" ? say("written") : call("files.write", { path: "note.txt", content: "hello" }));
  const { context } = taskContext(app, "write a file");

  // Nothing registered: the call goes as the policy said, which is exactly how it behaved before.
  assert.equal(await app.hooks.decide(context.runId, { tool: "files.write" }), null);
  const plain = await app.runtime.run({ prompt: "write the note" });
  assert.equal(plain.status, "completed", "with no check, the write goes ahead");

  const ask = scriptedHook({ decision: "ask", reason: "Finance files are checked with you first." });
  app.hooks.configure([{ id: "finance", event: "tool.before", executable: "checker" }], ask.runner);
  const stopped = await app.runtime.run({ prompt: "write the note again" });
  assert.equal(stopped.status, "needs_input", "the check turned an allow into a question");
  assert.match(stopped.output, /Finance files are checked with you first/);
  assert.equal(ask.seen[0].payload.event, "tool.before", "the hook is told which moment this is");
  assert.equal(ask.seen[0].payload.decision, "allow", "and what the policy had already decided");
  assert.equal(app.store.audit.list(app.runtime.owner).filter((r) => r.action === "hook.blocked")[0].outcome, "held for a yes");
  assert.ok(app.runtime.approvals.waiting(stopped.sessionId).length, "the task is waiting on a real question");

  // A refusal comes back to the model as the check's own words, and is written down.
  const deny = scriptedHook({ decision: "deny", reason: "That folder is off limits." });
  app.hooks.configure([{ id: "guard", event: "tool.before", executable: "checker" }], deny.runner);
  const refused = await app.runtime.run({ prompt: "write it anyway" });
  assert.equal(refused.status, "completed");
  assert.ok(app.store.events(refused.id).some((event) => event.kind === "hook.blocked"), "the refusal is on the task");
  const denied = app.store.events(refused.id).find((event) => event.kind === "policy.denied");
  assert.equal(denied.data.hook, "guard");
  assert.equal(app.store.audit.list(app.runtime.owner).filter((r) => r.action === "hook.blocked")[0].outcome, "refused");
});

test("A0824 a check that says nothing, or falls over, cannot let something through by accident", async (t) => {
  const { app } = await fixture(t);
  const { context } = taskContext(app);
  // A verdict that is not one leaves the decision alone.
  app.hooks.configure([{ id: "quiet", event: "tool.before", executable: "checker" }], scriptedHook({ nonsense: true }).runner);
  assert.equal(await app.hooks.decide(context.runId, { tool: "files.write" }), null);
  // A check that falls over holds the call for a yes, which is what onTimeout says by default.
  app.hooks.configure([{ id: "broken", event: "tool.before", executable: "checker" }], scriptedHook("fail").runner);
  const fallback = await app.hooks.decide(context.runId, { tool: "files.write" });
  assert.equal(fallback.decision, "ask");
  assert.match(fallback.reason, /did not answer in time|being put to you/);
  // Unless the owner said to let it through instead.
  app.hooks.configure([{ id: "broken", event: "tool.before", executable: "checker", onTimeout: "allow" }], scriptedHook("fail").runner);
  assert.equal(await app.hooks.decide(context.runId, { tool: "files.write" }), null);
  // A check that never answers at all cannot hold the task open: it is given its time and no more.
  app.hooks.configure([{ id: "hung", event: "tool.before", executable: "checker", timeoutMs: 100 }],
    () => new Promise(() => {}));
  const started = Date.now();
  const hung = await app.hooks.decide(context.runId, { tool: "files.write" });
  assert.equal(hung.decision, "ask", "a check that never answers holds the call for a yes");
  assert.ok(Date.now() - started < 5000, "and the task carries on rather than waiting for it");
  // The strictest of several answers wins.
  app.hooks.configure([
    { id: "soft", event: "tool.before", executable: "checker" },
    { id: "hard", event: "tool.before", executable: "checker" },
  ], async (hook) => ({ ok: true, verdict: { decision: hook.id === "hard" ? "deny" : "ask", reason: hook.id } }));
  assert.equal((await app.hooks.decide(context.runId, { tool: "files.write" })).hook, "hard");
});

// ---------------------------------------------------------------- A0638

test("A0638 the terminal says what the conversation has cost and what this one answer cost", async (t) => {
  const { app } = await fixture(t);
  const { statusLine, sessionTotals, runTotals, answerLine, activeModel } = await import("../dist/terminal-commands.js");
  const run = await app.runtime.run({ prompt: "hello" });

  // The running totals were already there: the verification report looked in terminal-tui.ts,
  // where the line is drawn, rather than terminal-commands.ts, where it is worked out.
  const line = statusLine(app.runtime, run.sessionId, "alpha", 120);
  assert.match(line, /[\d.]+k? in \/ [\d.]+k? out/, "tokens are on the status line");
  const totals = sessionTotals(app.runtime, run.sessionId, "a");
  assert.ok(totals.input > 0 || totals.output > 0);

  // What is new: the same reckoning for one answer, printed under it.
  const one = runTotals(app.runtime, run.id, activeModel(app.runtime, "alpha"));
  assert.equal(one.input, totals.input, "one answer in a one-answer conversation is the whole of it");
  assert.match(answerLine(one), /^\[this answer: .* in \/ .* out · .*\]$/);
  assert.equal(answerLine({ input: 0, output: 0, cost: "$0.00" }), "", "nothing counted, nothing said");
  assert.equal(activeModel(app.runtime, "alpha"), "a");
});

// ---------------------------------------------------------------- A1465

test("A1465 Windows is asked before the screen and the microphone, and the answer is a plain sentence", async (t) => {
  const { OsPermissions, capabilityCheck, probeReader } = await import("../dist/os-permissions.js");

  // The decision logic on its own: only an outright refusal stops anything.
  assert.equal(capabilityCheck("microphone", "allowed", "win32").allowed, true);
  assert.equal(capabilityCheck("microphone", "unknown", "win32").allowed, true, "a computer that cannot say never blocks");
  const refused = capabilityCheck("microphone", "refused", "win32");
  assert.equal(refused.allowed, false);
  assert.match(refused.message, /Windows is not letting Branch use the microphone/);
  assert.equal(refused.settingsLink, "ms-settings:privacy-microphone");
  assert.equal(capabilityCheck("camera", "refused", "win32").settingsLink, "ms-settings:privacy-webcam");
  assert.equal(capabilityCheck("screen", "refused", "win32").settingsLink, "ms-settings:privacy-graphicscaptureprogrammatic");

  // Read through a fake Windows, and kept for a short while rather than asked over and over.
  const asked = [];
  const permissions = new OsPermissions(async (capability) => { asked.push(capability); return capability === "microphone" ? "refused" : "allowed"; }, 1000, "win32");
  permissions.now = () => 1_000_000;
  assert.equal((await permissions.check("microphone")).allowed, false);
  assert.equal((await permissions.check("microphone")).allowed, false);
  assert.deepEqual(asked, ["microphone"], "the same question is not put to Windows twice");
  assert.deepEqual((await permissions.all()).map((entry) => entry.allowed), [false, true, true]);
  permissions.forget();
  await permissions.check("microphone");
  assert.equal(asked.length, 4, "after a change of mind it is asked again");

  // The screen has no switch to read, so it is probed; a probe that throws means refused.
  const good = probeReader(async () => 7, async () => "unknown", "win32");
  assert.equal(await good("screen"), "allowed");
  const bad = probeReader(async () => { throw new Error("Access is denied."); }, async () => "unknown", "win32");
  assert.equal(await bad("screen"), "refused");
  assert.equal(await bad("camera"), "unknown", "the other two are left to the registry");
  // A probe that merely fell over is not a refusal: a cold computer must not lose its screen.
  const slow = probeReader(async () => { throw new Error("The operation was aborted due to timeout"); }, async () => "unknown", "win32");
  assert.equal(await slow("screen"), "unknown");
  assert.equal(capabilityCheck("screen", await slow("screen"), "win32").allowed, true);
});

test("A1465 screen control stops with the Windows sentence before it touches anything", async (t) => {
  const { app } = await fixture(t);
  const { OsPermissions } = await import("../dist/os-permissions.js");
  const { context } = taskContext(app);
  app.store.save("settings", app.runtime.owner, "desktop-control", { enabled: true, maxActionsPerRun: 40 });
  app.desktop.permissions = new OsPermissions(async () => "refused", 30_000, "win32");
  await assert.rejects(() => app.desktop.windows({ action: "list" }, context),
    /Windows is not letting Branch take hold of other programs' windows/);
  // Nothing was attempted: the refusal happens before the notice goes up or an action is counted.
  assert.ok(!app.store.events(context.runId).some((event) => event.kind === "desktop.started"));
});

// ---------------------------------------------------------------- A1629

test("A1629 a command nobody has ruled on is asked about, and saying yes settles it for good", async (t) => {
  const { app } = await fixture(t);
  const { evaluatePolicy, readPolicy, savePolicy } = await import("../dist/policy.js");
  const { resourceOf } = await import("../dist/policy-resources.js");
  const command = (target) => ({ tool: "shell.execute", target, readOnly: false, resource: resourceOf("shell.execute", "shell.execute", target, {}) });

  // Out of the box, with no rules at all, a command is a question rather than a guess.
  const fresh = readPolicy(app.store, app.runtime.owner);
  assert.equal(fresh.unmatchedCommands, "ask", "asking is what a fresh install does");
  const asked = evaluatePolicy(fresh, command("rm -rf notes"));
  assert.equal(asked.decision, "ask");
  assert.equal(asked.rule.remember, "always", "so answering it once settles that command for good");

  // Everything else that nothing matches is still simply allowed; only commands changed.
  assert.equal(evaluatePolicy(fresh, { tool: "files.write", target: "a.txt", readOnly: false, resource: { kind: "path", value: "a.txt" } }).decision, "allow");
  assert.equal(evaluatePolicy(fresh, { tool: "web.fetch", target: "example.org", readOnly: true, resource: { kind: "host", value: "example.org" } }).decision, "allow");

  // A rule that does match still decides, whichever way it goes.
  const ruled = savePolicy(app.store, app.runtime.owner,
    { rules: [{ tool: "shell.execute", match: "*", applies: "any", decision: "allow", remember: "session", resource: { kind: "command", pattern: "git" } }] });
  assert.equal(evaluatePolicy(ruled, command("git status")).decision, "allow");
  assert.equal(evaluatePolicy(ruled, command("rm -rf notes")).decision, "ask", "a rule about git says nothing about rm");

  // An owner who would rather have the old behaviour back can say so, and it comes back.
  const back = savePolicy(app.store, app.runtime.owner, { unmatchedCommands: "allow" });
  assert.equal(evaluatePolicy(back, command("rm -rf notes")).decision, "allow");
  assert.equal(back.rules.length, 1, "and the rules they already had are untouched");
});

// ---------------------------------------------------------------- A2006

test("A2006 a child's profile is refused a purchase-class tool and a project outside its grant", async (t) => {
  const { app } = await fixture(t);
  const { grantedCategories, grantRefusal, roleLabels } = await import("../dist/profile-roles.js");
  const roles = app.runtime.roles;

  // The three roles say plainly what each may have Branch do.
  assert.deepEqual(grantedCategories({ role: "child", projects: [], dailySpendLimit: 0 }), ["read"]);
  assert.ok(!grantedCategories({ role: "adult", projects: [], dailySpendLimit: 0 }).includes("spend"));
  assert.ok(grantedCategories({ role: "owner", projects: [], dailySpendLimit: 0 }).includes("settings"));
  assert.match(roleLabels.child.description, /look things up/);

  const child = app.store.profiles.create({ name: "Sam", pin: "1234" });
  roles.save(child.id, { role: "child", projects: [], dailySpendLimit: 2 });
  assert.deepEqual(roles.all([child.id])[0].categories, ["read"]);

  // The owner is never held to any of this.
  assert.equal(app.runtime.checkPolicy("files.write", { path: "a.txt" }, app.runtime.context({ runId: taskContext(app).run.id })).decision, "allow");

  // Switched to the child's profile, a tool that spends money is refused, in their own words.
  app.store.profiles.switch({ profileId: child.id, pin: "1234" });
  t.after(() => app.store.profiles.switch({ profileId: null }));
  const { context } = taskContext(app);
  const { categoryOf } = await import("../dist/tool-categories.js");
  assert.equal(categoryOf("payments.charge", "payments.spend"), "spend");
  assert.match(grantRefusal({ role: "child", projects: [], dailySpendLimit: 0 }, "Sam",
    { category: "spend", project: "default", spentToday: 0 }),
    /Sam is set up as "Child" here, which does not cover spend money/);
  const write = app.runtime.checkPolicy("files.write", { path: "a.txt" }, context);
  assert.equal(write.decision, "deny", "a child may not change files either");
  assert.equal(app.runtime.checkPolicy("files.read", { path: "a.txt" }, context).decision, "allow", "but may still look things up");

  // A project outside the grant is refused, whatever the role allows.
  roles.save(child.id, { role: "adult", projects: ["homework"] });
  assert.equal(app.runtime.checkPolicy("files.write", { path: "a.txt" }, context).decision, "deny");
  assert.match(app.runtime.checkPolicy("files.write", { path: "a.txt" }, context).reason,
    /not set up to work in the project "default"/);
  roles.save(child.id, { role: "adult", projects: [] });
  assert.equal(app.runtime.checkPolicy("files.write", { path: "a.txt" }, context).decision, "allow");

  // And a day's allowance that has been used up refuses everything that is not looking.
  assert.match(grantRefusal({ role: "adult", projects: [], dailySpendLimit: 1 }, "Sam",
    { category: "files", project: "default", spentToday: 1.5 }), /used up today's allowance of 1\.00/);
  assert.equal(grantRefusal({ role: "adult", projects: [], dailySpendLimit: 1 }, "Sam",
    { category: "files", project: "default", spentToday: 0.2 }), null);

  // What they have spent today is read off their own finished tasks, not off a figure handed in.
  const { runForCurrentPerson } = await import("../dist/collab-server.js");
  app.store.save("settings", app.runtime.owner, "pricing", { overrides: { a: { input: 1000, output: 2000 } } });
  await runForCurrentPerson(app, { prompt: "an expensive question" });
  const spent = roles.spentToday(app.store.profiles.scope(), "a");
  assert.ok(spent > 0, "the profile's own task is counted against their allowance");
  roles.save(child.id, { role: "adult", projects: [], dailySpendLimit: 0.000001 });
  const capped = app.runtime.checkPolicy("files.write", { path: "a.txt" }, app.runtime.context({ runId: taskContext(app).run.id }));
  assert.equal(capped.decision, "deny");
  assert.match(capped.reason, /used up today's allowance/);
});

test("A2006 a child cannot get round their role by going in another way", async (t) => {
  const { app } = await fixture(t);
  const { tryTool } = await import("../dist/playground.js");
  const child = app.store.profiles.create({ name: "Sam", pin: "1234" });
  app.runtime.roles.save(child.id, { role: "child", projects: [], dailySpendLimit: 0 });
  app.store.profiles.switch({ profileId: child.id, pin: "1234" });
  t.after(() => app.store.profiles.switch({ profileId: null }));

  // Running a tool by hand from the developer screen goes through the same role check.
  const byHand = await tryTool(app.registry, app.store, app.runtime.owner, app.runtime.context({}),
    { name: "files.write", arguments: { path: "a.txt", content: "hi" }, confirm: true },
    (tool, permission) => app.runtime.roleRefusal(tool, permission));
  assert.equal(byHand.status, "refused");
  assert.match(byHand.reason, /Sam is set up as "Child" here/);
  // And so does another AI tool's server, which starts a tool without a conversation of its own.
  assert.equal(app.runtime.roleRefusal("files.write", "files.write") === null, false);
  assert.equal(app.runtime.roleRefusal("files.read", "files.read"), null, "looking things up is still theirs");
});

// ---------------------------------------------------------------- A1481

test("A1481 a finished task can be run again with the same words, tools and model, and the two compared", async (t) => {
  const { app, provider } = await fixture(t, ({ last }) =>
    last?.role === "tool" ? say("counted") : call("files.write", { path: "n.txt", content: "one" }));
  const { replayPlan, replayRun } = await import("../dist/replay.js");
  const { inspectRun } = await import("../dist/inspect.js");
  app.store.save("settings", app.runtime.owner, "policy", { preset: "custom", rules: [], limits: {}, unmatchedCommands: "allow" });

  const first = await app.runtime.run({ prompt: "write the note", permissions: ["files.write", "files.read"] });
  assert.equal(first.status, "completed");

  // What the task was is read back off its own record, not guessed at.
  const plan = replayPlan(app.store, first.id);
  assert.equal(plan.prompt, "write the note");
  assert.deepEqual(plan.permissions, ["files.read", "files.write"], "the very same tools it had");
  assert.equal(plan.model, "alpha");

  const before = provider.requests.length;
  const again = await replayRun(app.runtime, app.store, first.id);
  assert.equal(again.original, first.id);
  assert.notEqual(again.replay, first.id);
  assert.ok(provider.requests.length > before, "the model really was asked again");
  assert.notEqual(app.store.run(again.replay).sessionId, first.sessionId, "in a conversation of its own");
  assert.equal(app.store.run(again.replay).prompt, "write the note");
  assert.ok(app.store.events(again.replay).some((event) => event.kind === "run.replayed"));
  const permissionsUsed = app.store.events(again.replay).find((event) => event.kind === "run.started").data.permissions;
  assert.deepEqual(permissionsUsed, ["files.read", "files.write"]);

  // Both tasks answer the same "Look inside" question, which is what the side-by-side screen reads.
  for (const runId of [again.original, again.replay]) {
    const view = inspectRun(app.store, runId, { receipts: { items: [], counts: {} }, timeline: null, cost: null, version: "test" });
    assert.equal(view.run.prompt, "write the note");
    assert.ok(view.rounds.length >= 1);
  }
  await assert.rejects(async () => replayPlan(app.store, "00000000-0000-4000-8000-000000000000"), /no task with that number/);
});

// ------------------------------------------------- A0317 / A0372 / A1093 / A1278

/** Makes a specialist the ordinary way: propose, pass its own trial, promote. */
async function specialist(app, name, permissions = ["files.read"]) {
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

test("A0372 splitting a goal between named workers is its own piece, and refuses a stranger", async () => {
  const { parseAssignments, decomposeGoal } = await import("../dist/orchestration-modes.js");
  const workers = ["writer", "checker"];
  const good = '{"tasks":[{"specialist":"writer","prompt":"draft it"},{"specialist":"checker","prompt":"check it"}]}';
  assert.deepEqual(parseAssignments(good, workers), [
    { specialist: "writer", prompt: "draft it" }, { specialist: "checker", prompt: "check it" }]);
  assert.deepEqual(parseAssignments(`Here you go:\n${good}\nthanks`, workers).length, 2, "words either side are ignored");
  // Somebody who is not on the team is dropped, not guessed at.
  assert.deepEqual(parseAssignments('{"tasks":[{"specialist":"writer","prompt":"a"},{"specialist":"nobody","prompt":"b"}]}', workers),
    [{ specialist: "writer", prompt: "a" }]);
  assert.throws(() => parseAssignments('{"tasks":[{"specialist":"nobody","prompt":"b"}]}', workers), /gave work to nobody on the team/);
  assert.throws(() => parseAssignments("no json here", workers), /did not answer with a list/);
  assert.throws(() => parseAssignments('{"tasks":[]}', workers), /not in the expected shape/);
  const asked = [];
  const split = await decomposeGoal(async (prompt) => { asked.push(prompt); return good; }, "write a note", workers);
  assert.equal(split.length, 2);
  assert.match(asked[0], /writer, checker/, "the workers are named to whoever is splitting the job");
});

test("A1278 a supervisor gives work to named workers and writes the one answer that comes back", async (t) => {
  // The specialists are known by the numbers they are given, so the supervisor's answer is built
  // from those numbers once they exist.
  const team = {};
  const { app } = await fixture(t, ({ user }) => {
    if (/splitting one job/.test(user))
      return say(JSON.stringify({ tasks: [
        { specialist: team.writer, prompt: "draft the note" }, { specialist: team.checker, prompt: "check the note" }] }));
    if (/come back/.test(user)) return say("Here is the finished note.");
    if (/draft/.test(user)) return say("a draft");
    return say("checked");
  });
  const boss = await specialist(app, "boss"), writer = await specialist(app, "writer"), checker = await specialist(app, "checker");
  Object.assign(team, { writer, checker });
  const { runSupervised } = await import("../dist/orchestration-modes.js");
  const { run, context } = taskContext(app, "a supervised job");
  const outcome = await runSupervised(app.runtime, app.knowledge, context,
    { supervisor: boss, workers: [writer, checker], goal: "write a note and check it" });
  assert.equal(outcome.output, "Here is the finished note.");
  assert.equal(outcome.answers.length, 2, "both workers really ran");
  assert.deepEqual(outcome.answers.map((answer) => answer.specialist), [writer, checker]);
  assert.ok(outcome.answers.every((answer) => answer.runId), "each worker has a task of its own on the record");
  const recorded = app.store.events(run.id).find((event) => event.kind === "orchestration.supervised");
  assert.equal(recorded.data.supervisor, boss);
  assert.deepEqual(recorded.data.assignments.map((entry) => entry.specialist), [writer, checker]);
});

// RES-721: "Teams", small groups each with its own lead. The head splits the job between the owner's saved teams, each
// team's lead (the member whose role says "lead") shares its part among its members, and the head writes the answer.
// Mutation: in src/team-groups.ts shapeOf take the first member as lead whatever the roles say, and the wrong member
// splits the design team's part: red.
test("RES-721 teams: a head splits the job between saved teams, and each team's own lead shares its part", async (t) => {
  const who = {};
  const { app } = await fixture(t, ({ user }) => {
    if (/splitting one job/.test(user)) {
      if (/Design, Build/.test(user)) return say(JSON.stringify({ tasks: [{ specialist: "Design", prompt: "sketch the page" }, { specialist: "Build", prompt: "build the page" }] }));
      if (/sketch/.test(user)) return say(JSON.stringify({ tasks: [{ specialist: who.painter, prompt: "paint the sketch" }] }));
      return say(JSON.stringify({ tasks: [{ specialist: who.coder, prompt: "code it" }] }));
    }
    if (/split this job between teams/.test(user)) return say("The page is designed and built.");
    if (/come back/.test(user)) return say(/sketch/.test(user) ? "design part done" : "build part done");
    return say("done");
  });
  for (const name of ["head", "designlead", "painter", "buildlead", "coder"]) who[name] = await specialist(app, name);
  app.teams.save({ name: "Design", members: [{ specialistId: who.painter, role: "painter" }, { specialistId: who.designlead, role: "Team lead" }] });
  app.teams.save({ name: "Build", members: [{ specialistId: who.buildlead, role: "lead" }, { specialistId: who.coder, role: "coder" }] });
  const { runTeams, shapeOf } = await import("../dist/team-groups.js");
  assert.deepEqual(shapeOf(app.teams.list().find((team) => team.name === "Design")), { name: "Design", lead: who.designlead, helpers: [who.painter] }, "the lead is the member whose role says so");
  const { run, context } = taskContext(app, "a job for two teams");
  const outcome = await runTeams(app.runtime, app.knowledge, app.teams, context, { teams: ["Design", "Build"], goal: "make the page", head: who.head });
  assert.equal(outcome.output, "The page is designed and built.");
  assert.deepEqual(outcome.teams.map((team) => [team.team, team.lead, team.status, team.output]),
    [["Design", who.designlead, "completed", "design part done"], ["Build", who.buildlead, "completed", "build part done"]]);
  const recorded = app.store.events(run.id).find((event) => event.kind === "orchestration.teams");
  assert.equal(recorded.data.head, who.head);
  await assert.rejects(runTeams(app.runtime, app.knowledge, app.teams, context, { teams: ["Design", "Nobody"], goal: "x" }), /no saved team called Nobody/);
  assert.equal(app.registry.permissionOf("delegate.teams"), "specialists.use");
});

test("A0317 a swarm works down one shared list, and an item nobody finished goes back on it", async (t) => {
  const { SharedWorkList, runSwarm } = await import("../dist/orchestration-modes.js");

  // The list itself: one item is only ever held by one worker, and letting go frees it again.
  const list = new SharedWorkList(["a", "b"]);
  const first = list.claim("one"), second = list.claim("two");
  assert.deepEqual([first.item, second.item], ["a", "b"], "two workers never take the same item");
  assert.equal(list.claim("three"), null, "and there is nothing left to take");
  list.release(first.index);
  assert.deepEqual(list.claim("three"), { index: 0, item: "a" }, "what one let go of, another picks up");
  list.done(0); list.done(1);
  assert.deepEqual(list.state, { total: 2, done: 2, held: 0 });

  const { app } = await fixture(t, ({ user }) => say(`did ${user}`));
  const one = await specialist(app, "one"), two = await specialist(app, "two");
  const { run, context } = taskContext(app, "a swarm");
  const outcome = await runSwarm(app.runtime, app.knowledge, context, { specialists: [one, two], items: ["first", "second", "third"] });
  assert.equal(outcome.done, 3, "every item was finished exactly once");
  assert.deepEqual(outcome.results.map((entry) => entry.item), ["first", "second", "third"]);
  assert.equal(new Set(outcome.results.map((entry) => entry.index)).size, 3, "no item was done twice");
  const claims = app.store.events(run.id).filter((event) => event.kind === "swarm.claimed");
  assert.equal(claims.length, 3);
  assert.ok(new Set(claims.map((event) => event.data.specialist)).size >= 1, "the claims say who took what");
});

test("A1093 a specialist hands work on with a reason, only to the people it is set up to hand to", async (t) => {
  const { app } = await fixture(t, () => say("done"));
  const { handOff } = await import("../dist/orchestration-tools.js");
  const writer = await specialist(app, "writer"), checker = await specialist(app, "checker"), stranger = await specialist(app, "stranger");
  const { run, context } = taskContext(app, "a handover");

  // With nothing written down, anybody may hand to anybody, exactly as before.
  assert.equal(app.runtime.handoffs.refusal(writer, stranger), null);
  const first = await handOff(app.runtime, app.knowledge, { ...context, agent: writer },
    { specialist: checker, brief: "check this", reason: "this needs checking, which is your job" });
  assert.equal(first.specialist, checker);
  // The handover, and why, is in the conversation a person reads afterwards.
  const messages = app.store.messages(run.sessionId);
  assert.ok(messages.some((message) => message.content.includes(`Handed over from ${writer} to ${checker}: this needs checking`)));
  assert.equal(app.store.events(run.id).find((event) => event.kind === "delegation.handoff").data.reason, "this needs checking, which is your job");

  // Once the owner writes down who may hand to whom, anybody else is refused in plain words.
  app.runtime.handoffs.save(writer, [checker]);
  assert.deepEqual(app.runtime.handoffs.allowed(writer), [checker]);
  await assert.rejects(() => handOff(app.runtime, app.knowledge, { ...context, agent: writer },
    { specialist: stranger, brief: "do this" }), /is only set up to hand work on to/);
  assert.equal(app.runtime.handoffs.refusal(undefined, stranger), null, "the main task is not a specialist and is not held to a list");
});
