import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { z } from "zod";
import { createBranch, SessionLock, SecretScrubber, WindowsJobObjects, applyPiiGuard, detectPii, collectReferences, classifyToolEvent } from "../dist/index.js";
import { BranchShell, registerShell } from "../dist/integrations/shell.js";
import { ShellProcess } from "../dist/integrations/shell-process.js";
import { startServer } from "../dist/server.js";

/** Nothing else in a log could look like this, so finding it anywhere is a real leak. */
const sentinel = "sentinel-SECRET-7f3a91b2c4d5";
const say = (content) => ({ content, toolCalls: [] });
const scripted = () => ({ name: "scripted", requests: [], async complete(request) { this.requests.push(request); return say("ok"); } });

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-guard4-"));
  const provider = scripted();
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider, ...options });
  t.after(async () => { await app.close(); await discardTemp(root); });
  return { app, root, provider };
}
async function withShell(t, app, config = {}) {
  const shell = new BranchShell({ executables: { node: { path: process.execPath } }, ...config },
    { ...process.env, SYSTEMROOT: process.env.SystemRoot ?? "", TEMP: process.env.TEMP ?? "" }, app.secretsFor);
  await shell.ready();
  registerShell(app.registry, shell);
  t.after(() => shell.close());
  return shell;
}
/** A command run straight through `executeTool` stands in for the owner pressing it in the app window. */
const owner = { mode: "owner" };
/** Every stored event of every task, as one string, for an honest search. */
const wholeEventLog = (app) => JSON.stringify(app.store.recentEvents(app.runtime.owner, 2000));

test("a secret reference is filled in only at the call and its value appears in no result, event, receipt or error", async (t) => {
  const { app } = await fixture(t);
  await app.store.secrets.put("local", "default", "DEPLOY_TOKEN", sentinel);
  await withShell(t, app);
  app.registry.register({
    name: "test.echo", permission: "files.read", description: "echoes a filled reference",
    parameters: z.object({ header: z.string() }).strict(),
    execute: async (input, context) => {
      const filled = await app.store.secrets.fill(context.owner, "default", input, { runId: context.runId, purpose: "test call" });
      assert.equal(filled.header, `Bearer ${sentinel}`, "the value exists only inside the call");
      return { sent: filled.header, nested: { copies: [filled.header] } };
    },
  });
  app.registry.register({
    name: "test.fail", permission: "files.read", description: "fails with the value in the message",
    parameters: z.object({}).strict(),
    execute: async (_input, context) => {
      const values = await app.store.secrets.resolve(context.owner, "default", ["DEPLOY_TOKEN"], { runId: context.runId, purpose: "test failure" });
      throw new Error(`upstream rejected the token ${values.DEPLOY_TOKEN}`);
    },
  });
  // The model never sees the value: not in a good answer, not in a bad one, not in a command's output.
  const echoed = await app.runtime.executeTool("test.echo", { header: "Bearer secret://default/DEPLOY_TOKEN" });
  assert.equal(echoed.sent, "Bearer [secret DEPLOY_TOKEN]");
  assert.deepEqual(echoed.nested.copies, ["Bearer [secret DEPLOY_TOKEN]"]);
  await assert.rejects(app.runtime.executeTool("test.fail", {}));
  const run = await app.runtime.executeTool("shell.execute", { executable: "node", args: ["-e", "console.log(process.env.DEPLOY_TOKEN)"], secrets: ["DEPLOY_TOKEN"] }, owner);
  assert.match(run.stdout, /\[secret DEPLOY_TOKEN\]/);
  assert.equal(wholeEventLog(app).includes(sentinel), false, "no stored event repeats the value");
  assert.equal(collectReferences({ a: ["secret://default/DEPLOY_TOKEN"] }).length, 1);
  // A reference belonging to another project is refused rather than quietly filled from this one.
  app.store.projects.save("local", { id: "other", name: "Other" });
  await assert.rejects(app.store.secrets.fill("local", "default", "secret://other/DEPLOY_TOKEN", { purpose: "wrong project" }), /not in the active project/);
});

test("scrubbing happens before the receipt is signed, so a scrubbed result still verifies", async (t) => {
  const { app } = await fixture(t);
  await app.store.secrets.put("local", "default", "API_KEY", sentinel);
  app.registry.register({
    name: "test.receipt", permission: "files.read", description: "returns the value",
    parameters: z.object({}).strict(),
    execute: async (_input, context) => ({ leaked: (await app.store.secrets.resolve(context.owner, "default", ["API_KEY"], { runId: context.runId, purpose: "receipt test" })).API_KEY }),
  });
  await app.runtime.executeTool("test.receipt", {});
  const scrubber = new SecretScrubber();
  scrubber.remember("API_KEY", sentinel);
  assert.equal(scrubber.deep({ a: [{ b: sentinel }] }).a[0].b, "[secret API_KEY]");
  assert.equal(scrubber.text(`x ${sentinel} y`), "x [secret API_KEY] y");
});

test("a run's tool receipts still verify after the result has been scrubbed", async (t) => {
  const { app, provider } = await fixture(t);
  await app.store.secrets.put("local", "default", "API_KEY", sentinel);
  app.registry.register({
    name: "test.leaky", permission: "files.read", description: "returns the value",
    parameters: z.object({}).strict(),
    execute: async (_input, context) => ({ leaked: (await app.store.secrets.resolve(context.owner, "default", ["API_KEY"], { runId: context.runId, purpose: "receipt" })).API_KEY }),
  });
  provider.complete = async (request) => {
    provider.requests.push(request);
    return request.messages.some((m) => m.role === "tool") ? say("done")
      : { content: "", toolCalls: [{ id: "call-1", name: "test.leaky", arguments: "{}" }] };
  };
  const run = await app.runtime.run({ prompt: "use the key" });
  const completed = app.store.events(run.id).find((event) => event.kind === "tool.completed");
  assert.equal(completed.data.result.leaked, "[secret API_KEY]");
  assert.equal(await classifyToolEvent(app.store.receipts, run.id, "tool.completed", completed.data), "success");
  assert.equal(JSON.stringify(app.store.events(run.id)).includes(sentinel), false);
});

test("a secret is replaced with a date recorded, and the audit shows which task used which secret", async (t) => {
  const { app } = await fixture(t);
  const server = await startServer(app, { port: 0, dataDir: join(app.runtime.workspace, "..", "data") });
  t.after(() => server.close());
  const call = (path, body, method = "POST") => fetch(`${server.url}${path}`, {
    method, headers: { "content-type": "application/json", authorization: `Bearer ${server.token}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const created = await (await call("/api/secrets", { project: "default", name: "DEPLOY_TOKEN", value: "first-value-01", expiresInDays: 30 })).json();
  assert.equal(created.rotatedAt, null);
  assert.equal(created.daysLeft, 30);
  const rotated = await (await call("/api/secrets/default/DEPLOY_TOKEN/rotate", { value: "second-value-02" })).json();
  assert.ok(rotated.rotatedAt, "the day the secret was replaced is recorded");
  assert.equal(rotated.daysLeft, 30, "the reminder rhythm is kept");
  assert.deepEqual(await app.store.secrets.resolve("local", "default", ["DEPLOY_TOKEN"], { runId: undefined, purpose: "check" }), { DEPLOY_TOKEN: "second-value-02" });
  const audit = await (await call("/api/secrets/audit", undefined, "GET")).json();
  assert.equal(audit.uses[0].name, "DEPLOY_TOKEN");
  assert.equal(audit.uses[0].purpose, "check");
  // A reminder that is still a month away is not nagged about.
  assert.deepEqual(audit.reminders, []);
  await app.store.secrets.put("local", "default", "OLD_TOKEN", "about-to-expire", { expiresInDays: 1 });
  const soon = await (await call("/api/secrets/audit", undefined, "GET")).json();
  assert.equal(soon.reminders[0].name, "OLD_TOKEN");
  assert.equal(await (await call("/api/secrets/default/NOPE/rotate", { value: "x" })).status, 400);
});

test("signing in to an outside service uses the standard code flow with PKCE and can renew itself", async (t) => {
  const { app } = await fixture(t);
  app.web.policy.configure({ allowPrivateAddresses: true });
  const seen = { authorize: null, exchanges: [] };
  const authServer = createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.pathname === "/authorize") { seen.authorize = url; response.writeHead(200).end("ok"); return; }
    let raw = ""; for await (const part of request) raw += part;
    const form = new URLSearchParams(raw);
    seen.exchanges.push(form);
    const grant = form.get("grant_type");
    const verifier = form.get("code_verifier");
    if (grant === "authorization_code") {
      const expected = (await import("node:crypto")).createHash("sha256").update(verifier ?? "").digest("base64url");
      if (expected !== seen.authorize.searchParams.get("code_challenge")) { response.writeHead(400).end("{}"); return; }
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ access_token: grant === "refresh_token" ? "fresh-token" : sentinel,
      refresh_token: "renew-me", token_type: "Bearer", expires_in: grant === "refresh_token" ? 3600 : 0, scope: "read" }));
  });
  await new Promise((resolve) => authServer.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => authServer.close(resolve)));
  const base = `http://127.0.0.1:${authServer.address().port}`;
  const provider = { id: "testly", label: "Testly", authorizeUrl: `${base}/authorize`, tokenUrl: `${base}/token`, clientId: "client-42", scopes: ["read"] };
  const started = await app.oauth.start(provider);
  const waiting = app.oauth.waitFor("testly");
  const url = new URL(started.url);
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("redirect_uri"), started.redirectUri);
  assert.match(started.redirectUri, /^http:\/\/127\.0\.0\.1:\d+\/oauth\/callback$/);
  seen.authorize = url;
  // An answer with the wrong state is refused: that is what stops someone else finishing the sign-in.
  const wrong = await fetch(`${started.redirectUri}?code=abc&state=not-the-one`);
  assert.equal(wrong.status, 400);
  await assert.rejects(waiting, /did not match/);
  const second = await app.oauth.start(provider);
  const settled = app.oauth.waitFor("testly");
  seen.authorize = new URL(second.url);
  const good = await fetch(`${second.redirectUri}?code=the-code&state=${encodeURIComponent(seen.authorize.searchParams.get("state"))}`);
  assert.equal(good.status, 200);
  const tokens = await settled;
  assert.equal(tokens.accessToken, sentinel);
  assert.equal(tokens.refreshToken, "renew-me");
  assert.equal(seen.exchanges[0].get("grant_type"), "authorization_code");
  assert.ok(seen.exchanges[0].get("code_verifier"), "the one-time proof travels with the exchange");
  // The saved sign-in has already run out, so asking for a key renews it first.
  assert.equal(await app.oauth.accessToken(provider), "fresh-token");
  assert.equal(seen.exchanges.at(-1).get("grant_type"), "refresh_token");
  assert.equal(wholeEventLog(app).includes(sentinel), false);
});

test("a command runs with a narrow environment, inside a Windows job where one is available", async (t) => {
  const { app } = await fixture(t);
  await app.store.secrets.put("local", "default", "DEPLOY_TOKEN", "injected-value-9x");
  const asked = [];
  const fakeJobs = { create: async (limits) => { asked.push(limits); return { kind: "job-object", assign: async (pid) => { asked.push(pid); return true; }, close: async () => undefined }; } };
  const hostOnly = { SECRET_FROM_HOST: "must-not-appear", AWS_ACCESS_KEY_ID: "must-not-appear", NODE_OPTIONS: "--invalid", GH_TOKEN: "must-not-appear" };
  const shell = new BranchShell({ executables: { node: { path: process.execPath } }, maxMemoryMb: 256, maxCpuSeconds: 5 },
    { ...process.env, ...hostOnly, SYSTEMROOT: process.env.SystemRoot ?? "" }, app.secretsFor, fakeJobs);
  await shell.ready();
  registerShell(app.registry, shell);
  t.after(() => shell.close());
  const result = await app.runtime.executeTool("shell.execute",
    { executable: "node", args: ["-e", "console.log(JSON.stringify(process.env))"], secrets: ["DEPLOY_TOKEN"] }, owner);
  const env = JSON.parse(result.stdout);
  for (const name of Object.keys(hostOnly)) assert.equal(env[name], undefined, `${name} from the host environment must not reach the command`);
  assert.equal(JSON.stringify(env).includes("must-not-appear"), false, "nothing the host set is passed through");
  assert.equal(env.DEPLOY_TOKEN, "[secret DEPLOY_TOKEN]", "the named secret reached the program, and its value is taken back out of the output");
  assert.ok(Object.keys(env).length < 20, `the environment stays small: ${Object.keys(env)}`);
  assert.deepEqual(asked[0], { maxMemoryMb: 256, maxCpuSeconds: 5 }, "the configured limits are what the job is created with");
  assert.equal(typeof asked[1], "number", "the running command is put into the job");
  assert.equal(result.target.isolation, "job-object");
  assert.equal(result.isolation, "job-object");
});

test("a Windows job stops a runaway command through the system, not through sampling", { timeout: 90000, skip: process.platform !== "win32" }, async (t) => {
  const job = await new WindowsJobObjects().create({ maxMemoryMb: 256, maxCpuSeconds: 1 });
  if (!job) { t.diagnostic("job objects are not available on this computer"); return; }
  const root = await mkdtemp(join(tmpdir(), "branch-job-"));
  t.after(() => discardTemp(root));
  // Sampling is pushed a minute out, so anything that stops this spinner is the job object itself.
  const spinner = new ShellProcess({ executable: process.execPath, args: ["-e", "const end = Date.now() + 40000; while (Date.now() < end) {}"],
    cwd: root, env: { SystemRoot: process.env.SystemRoot ?? "", PATH: "" }, signal: new AbortController().signal,
    timeoutMs: 60000, maxOutputBytes: 4096, usageIntervalMs: 60000, job });
  const result = await spinner.run();
  assert.equal(result.isolation, "job-object");
  assert.notEqual(result.status, "completed");
  assert.ok(result.durationMs < 35000, `the spinner was stopped after ${result.durationMs}ms, well before it would finish`);
});

test("a command told to stay offline is pointed at a dead address and fails at once", async (t) => {
  const { app } = await fixture(t);
  await withShell(t, app, { netless: true, timeoutMs: 20000 });
  const script = "const t = Date.now();" +
    "fetch(process.env.HTTPS_PROXY).then(() => console.log('reached')).catch(() => console.log('failed ' + (Date.now() - t < 5000)))";
  const result = await app.runtime.executeTool("shell.execute", { executable: "node", args: ["-e", script] }, owner);
  assert.match(result.stdout, /failed true/, `expected a fast failure, got ${result.stdout}`);
  assert.equal(result.target.netless, true);
  const allowed = await app.runtime.executeTool("shell.execute",
    { executable: "node", args: ["-e", "console.log(process.env.HTTPS_PROXY ?? 'none')"], netless: false }, owner);
  assert.match(allowed.stdout, /none/, "the setting can be turned off for one command");
});

test("personal details are hidden in a message going out and left alone in something read", async (t) => {
  const { app } = await fixture(t);
  const sent = [];
  const adapter = { id: "test-chat", kind: "test", maxTextLength: 4000, botName: () => "Branch",
    start: async () => undefined, send: async (chatId, text) => { sent.push({ chatId, text }); return "m1"; }, stop: async () => undefined };
  await app.channels.attach(adapter, { activation: "always", pairing: false });
  const message = "Write to ada@example.com or call 415-555-0134; the card 4111 1111 1111 1111 is on file.";
  await app.channels.deliver("test-chat", "c1", message);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].text.includes("ada@example.com"), false);
  assert.equal(sent[0].text.includes("4111 1111 1111 1111"), false);
  assert.match(sent[0].text, /\[email address hidden\]/);
  assert.match(sent[0].text, /\[card number hidden\]/);
  assert.match(sent[0].text, /\[phone number hidden\]/);
  // Reading the person's own workspace is not rewritten: the default for what comes in is "off".
  app.registry.register({ name: "test.read", permission: "files.read", description: "reads",
    parameters: z.object({}).strict(), execute: async () => ({ text: message }) });
  const read = await app.runtime.executeTool("test.read", {});
  assert.equal(read.text, message, "a workspace read is handed over word for word");
  // The owner can ask for it on the way in as well, and then it applies there too.
  app.privacy.configure({ pii: { inbound: "mask", outbound: "mask", kinds: ["email", "phone", "card", "iban", "national-id"] }, moderation: { enabled: false } });
  const masked = await app.runtime.executeTool("test.read", {});
  assert.equal(masked.text.includes("ada@example.com"), false);
});

test("the personal-details detector knows a real card and account number from a lookalike", () => {
  assert.deepEqual(detectPii("4111 1111 1111 1111").map((f) => f.kind), ["card"]);
  assert.deepEqual(detectPii("4111 1111 1111 1112"), [], "a number that fails the checksum is not a card");
  assert.deepEqual(detectPii("GB82WEST12345698765432").map((f) => f.kind), ["iban"]);
  assert.deepEqual(detectPii("GB82WEST12345698765433"), [], "a bank number that fails its check is left alone");
  assert.deepEqual(detectPii("123-45-6789").map((f) => f.kind), ["national-id"]);
  assert.equal(detectPii("ada@example.com")[0].hint, "email address ending om", "a finding never repeats the detail");
  assert.equal(applyPiiGuard("call 415-555-0134", "block").blocked, true);
  assert.equal(applyPiiGuard("call 415-555-0134", "warn").text, "call 415-555-0134");
  assert.equal(applyPiiGuard("nothing here", "mask").findings.length, 0);
});

test("the optional content check can hold a message back, and is off until it is switched on", async (t) => {
  const { app } = await fixture(t);
  app.web.policy.configure({ allowPrivateAddresses: true });
  const asked = [];
  const checker = createServer(async (request, response) => {
    let raw = ""; for await (const part of request) raw += part;
    asked.push(JSON.parse(raw));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ results: [{ flagged: true, categories: { harassment: true, violence: false } }] }));
  });
  await new Promise((resolve) => checker.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => checker.close(resolve)));
  const sent = [];
  const adapter = { id: "test-chat", kind: "test", maxTextLength: 4000, botName: () => "Branch",
    start: async () => undefined, send: async (chatId, text) => { sent.push(text); return "m1"; }, stop: async () => undefined };
  await app.channels.attach(adapter, { activation: "always", pairing: false });
  await app.channels.deliver("test-chat", "c1", "a plain message");
  assert.equal(asked.length, 0, "nothing is sent to a checker until the owner switches it on");
  const checking = { pii: { inbound: "off", outbound: "mask", kinds: ["email"] },
    moderation: { enabled: true, endpoint: `http://127.0.0.1:${checker.address().port}/v1/moderations`, action: "block", model: "test-model", timeoutMs: 5000 } };
  // 08ad59f0: fewer kinds looked for, and messages sent out to be checked, make Branch less careful: that needs the owner's yes.
  assert.throws(() => app.privacy.configure(checking), /less careful/);
  await app.channels.deliver("test-chat", "c1", "still plain");
  assert.equal(asked.length, 0, "a refused change sends nothing to the checker");
  app.privacy.configure(checking, true);
  await assert.rejects(app.channels.deliver("test-chat", "c2", "something unpleasant"), /held back by the content check/);
  assert.equal(asked[0].model, "test-model");
  assert.equal(asked[0].input, "something unpleasant");
  assert.equal(sent.length, 2, "only the two plain messages went out");
});

test("the app locks itself after a quiet spell and will not open the locker until it is unlocked", async (t) => {
  const { app } = await fixture(t);
  let clock = Date.parse("2026-01-01T09:00:00.000Z");
  const lock = new SessionLock(app.store, "local", () => clock);
  lock.configure({ idleMinutes: 15, secretsWhileLocked: false });
  assert.equal(lock.state().locked, false);
  clock += 14 * 60_000;
  assert.equal(lock.locked(), false, "it is still awake inside the quiet period");
  lock.touch();
  clock += 14 * 60_000;
  assert.equal(lock.locked(), false, "doing something starts the quiet period again");
  clock += 60_000 * 2;
  assert.equal(lock.locked(), true);
  assert.ok(lock.state().lockedSince);
  assert.throws(() => lock.require(), /Unlock it before/);
  // A locked app will not hand a secret to a new task.
  await app.store.secrets.put("local", "default", "DEPLOY_TOKEN", sentinel);
  app.store.secrets.gate = () => lock.require();
  await assert.rejects(app.store.secrets.resolve("local", "default", ["DEPLOY_TOKEN"], { purpose: "while locked" }), /locked/);
  lock.unlock();
  assert.equal(lock.state().locked, false);
  assert.deepEqual(await app.store.secrets.resolve("local", "default", ["DEPLOY_TOKEN"], { purpose: "after unlock" }), { DEPLOY_TOKEN: sentinel });
  // Never locking itself is still allowed, for someone who would rather not be interrupted.
  lock.configure({ idleMinutes: 0, secretsWhileLocked: false });
  clock += 60 * 60_000;
  assert.equal(lock.locked(), false);
});
