import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import ts from "typescript";
import { readFile } from "node:fs/promises";
import { PassThrough } from "node:stream";
import { OAuthConnections } from "../dist/oauth.js";
import { EventEmitter } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBranch } from "../dist/index.js";
import { HealthCheck, withHealthCheck, currentHealthCheck } from "../dist/health-check.js";
import { HomeControl } from "../dist/personal/home-control.js";
import { SignIn } from "../dist/personal/signin.js";
import { personalApi } from "../dist/personal/api.js";
import { connectorsApi } from "../dist/connectors-api.js";
import { GitHubAccess } from "../dist/integrations/github.js";
import { IssueAccess } from "../dist/integrations/issue-tools.js";
import { NetworkPolicy } from "../dist/network-policy.js";
import { discardTemp } from "./temp-dir.mjs";

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-health-authority-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"),
    provider: { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } } });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const owner = app.runtime.owner, guest = app.store.profiles.create({ name: "Guest", pin: "2468" });
  app.store.save("settings", owner, "personal-home-control", { mode: "when-needed" });
  app.store.save("settings", owner, "personal-google", { mode: "when-needed" });
  app.store.projects.save(owner, { id: "other", name: "Other" });
  await app.store.locker.set(owner, "default", "HEALTH_TEST_TOKEN", "fixture-old-token");
  return { app, owner, guest, check: (request, refreshCredential) => new HealthCheck(app.store, owner, app.sessionLock, request, refreshCredential) };
}
const changes = {
  person: async f => { f.app.store.profiles.switch({ profileId: f.guest.id, pin: "2468" }); f.app.store.profiles.switch({ profileId: null }); },
  lock: async f => { f.app.sessionLock.lock(); f.app.sessionLock.unlock(); },
  project: async f => { f.app.store.projects.setActive(f.owner, { active: "other" }); f.app.store.projects.setActive(f.owner, { active: "default" }); },
  settings: async f => { f.app.store.save("settings", f.owner, "personal-home-control", { mode: "off" }); f.app.store.save("settings", f.owner, "personal-home-control", { mode: "when-needed" }); },
  token: async f => {
    const before = f.app.store.sqlite.prepare("SELECT created_at FROM locker WHERE owner=? AND name=?").get(f.owner, "HEALTH_TEST_TOKEN").created_at;
    await f.app.store.locker.set(f.owner, "default", "HEALTH_TEST_TOKEN", "fixture-new-token");
    f.app.store.sqlite.prepare("UPDATE locker SET created_at=? WHERE owner=? AND name=?").run(before, f.owner, "HEALTH_TEST_TOKEN");
  },
};
for (const [name, change] of Object.entries(changes)) {
  test(`actual HomeControl refuses original health check after ${name} replacement during secret lookup`, async t => {
    const f = await fixture(t), secret = deferred(), entered = deferred(); let sends = 0;
    const home = new HomeControl(f.app.store, f.owner, async () => { sends++; return new Response('{"message":"API running."}'); },
      () => { entered.resolve(); return secret.promise; });
    home.save({ url: "https://93.184.216.34" });
    const check = f.check();
    const running = withHealthCheck(check, () => home.test());
    const refusal = assert.rejects(running, /no longer authorized/);
    await entered.promise; await change(f); secret.resolve("fixture-token"); await refusal;
    assert.equal(check.signal.aborted, true); assert.equal(sends, 0);
  });
}
test("actual personalApi captures authority before awaiting the request body", async t => {
  const f = await fixture(t), body = deferred(), entered = deferred(); let calls = 0;
  const home = { test: async () => { calls++; currentHealthCheck().assertCurrent(); return {}; } };
  const pending = personalApi({ runtime: f.app.runtime, personal: { home }, method: "POST", sessionLock: f.app.sessionLock,
    readBody: () => { entered.resolve(); return body.promise; } }, "/api/personal/home/test");
  const refusal = assert.rejects(pending, /no longer authorized/);
  await entered.promise; await changes.person(f); body.resolve({}); await refusal;
  assert.equal(calls, 1, "the actual health call refuses before any provider send");
});
test("HealthCheck request abort reaches an actual HomeControl pending response", async t => {
  const f = await fixture(t), request = new EventEmitter(), entered = deferred(); let signal;
  const home = new HomeControl(f.app.store, f.owner, async (_url, init) => {
    signal = init.signal; entered.resolve();
    return new Promise((_yes, no) => signal.addEventListener("abort", () => no(signal.reason), { once: true }));
  }, async () => "fixture-token");
  home.save({ url: "https://93.184.216.34" });
  const running = withHealthCheck(f.check(request), () => home.test());
  const refusal = assert.rejects(running, /no longer authorized/);
  await entered.promise; request.emit("aborted"); await refusal; assert.equal(signal.aborted, true);
});
test("actual SignIn refuses changed authority after deferred OAuth access token", async t => {
  const f = await fixture(t), token = deferred(), entered = deferred(); let sends = 0;
  const signIn = new SignIn({ store: f.app.store, owner: f.owner, secret: async () => "fixture-secret",
    fetch: async () => { sends++; return new Response('{}'); },
    oauth: { accessToken: () => { entered.resolve(); return token.promise; }, saved: async () => null } }, "google", "google");
  signIn.save({ clientId: "fixture-client" });
  const running = withHealthCheck(f.check(), () => signIn.test()), refusal = assert.rejects(running, /no longer authorized/);
  await entered.promise; await changes.lock(f); token.resolve("fixture-token"); await refusal;
  assert.equal(sends, 0); assert.equal(f.app.store.get("settings", f.owner, "personal-connection-health:google"), undefined);
});
test("actual SignIn refuses a provider assembled from a stale deferred client secret", async t => {
  const f = await fixture(t), secret = deferred(), entered = deferred(); let tokenCalls = 0;
  const signIn = new SignIn({ store: f.app.store, owner: f.owner,
    secret: () => { entered.resolve(); return secret.promise; }, fetch: async () => new Response('{}'),
    oauth: { accessToken: async () => { tokenCalls++; return "fixture-token"; } } }, "google", "google");
  signIn.save({ clientId: "fixture-client", clientSecretName: "HEALTH_TEST_TOKEN" });
  const running = withHealthCheck(f.check(), () => signIn.test()), refusal = assert.rejects(running, /no longer authorized/);
  await entered.promise; await changes.token(f); secret.resolve("fixture-old-token"); await refusal; assert.equal(tokenCalls, 0);
});
test("NetworkPolicy last-DNS boundary refuses before fake sender after sticky revocation", async t => {
  const f = await fixture(t), dns = deferred(), entered = deferred(); let sends = 0;
  const policy = new NetworkPolicy({}, () => { entered.resolve(); return dns.promise; });
  const guarded = policy.guard(async () => { sends++; return new Response('{}'); });
  const running = withHealthCheck(f.check(), () => guarded("https://fixture.example/check"));
  const refusal = assert.rejects(running, /no longer authorized/);
  await entered.promise; await changes.person(f); dns.resolve(["93.184.216.34"]); await refusal; assert.equal(sends, 0);
});
test("actual tracker account read rejects changed scope after pending DNS", async t => {
  const f = await fixture(t), dns = deferred(), entered = deferred(); let sends = 0;
  const policy = new NetworkPolicy({}, () => { entered.resolve(); return dns.promise; });
  const github = new GitHubAccess({}, policy, async () => "fixture-token", async () => { sends++; return new Response('{"id":7}'); });
  const issues = new IssueAccess({ github });
  const running = withHealthCheck(f.check(), () => issues.checkAccount("github"));
  const refusal = assert.rejects(running, /no longer authorized/);
  await entered.promise; await changes.project(f); dns.resolve(["93.184.216.34"]); await refusal; assert.equal(sends, 0);
});
test("ordinary tracker failure is scrubbed health metadata, never a new permission grant", async t => {
  const f = await fixture(t), policy = new NetworkPolicy({}, async () => ["93.184.216.34"]);
  const github = new GitHubAccess({}, policy, async () => "fixture-secret-token",
    async () => new Response('provider private contents fixture-secret-token', { status: 401 }));
  const before = f.app.store.list("governance", f.owner);
  const health = await withHealthCheck(f.check(), () => new IssueAccess({ github }).checkAccount("github"));
  assert.equal(health.ok, false); assert.equal(health.checks.length, 1);
  assert.doesNotMatch(JSON.stringify(health), /fixture-secret-token|provider private contents/);
  assert.deepEqual(f.app.store.list("governance", f.owner), before);
});
test("valid SignIn check persists only metadata and keeps original service grants", async t => {
  const f = await fixture(t); let reads = 0;
  const signIn = new SignIn({ store: f.app.store, owner: f.owner, secret: async () => "fixture-secret",
    oauth: { accessToken: async () => "fixture-token", saved: async () => ({ accessToken: "fixture-token", scope: "original-read-only" }) },
    fetch: async () => { reads++; return new Response('provider secret private body fixture-token', { status: 403 }); } }, "google", "google");
  signIn.save({ clientId: "fixture-client", drafts: false });
  const check = f.check(), health = await withHealthCheck(check, () => signIn.test());
  assert.equal(health.ok, false); assert.equal(reads, 3); assert.equal(check.signal.aborted, false);
  const saved = f.app.store.get("settings", f.owner, "personal-connection-health:google").data;
  assert.deepEqual(saved, health); assert.doesNotMatch(JSON.stringify(saved), /fixture-token|private body/);
  assert.equal(signIn.settings().drafts, false); assert.equal((await signIn.status()).scope, "original-read-only");
});
test("health context refuses arbitrary credential writes while allowing its exact authorized OAuth refresh", async t => {
  const f = await fixture(t);
  await withHealthCheck(f.check(undefined, "OAUTH_PERSONAL_GOOGLE"), async () => {
    const check = currentHealthCheck();
    await assert.rejects(check.writeOwnCredential(f.owner, "default", "OAUTH_PERSONAL_MICROSOFT", async () => {}), /cannot change/);
    await assert.rejects(check.writeOwnCredential(f.owner, "default", "HEALTH_TEST_TOKEN", async () => {}), /cannot change/);
    await check.writeOwnCredential(f.owner, "default", "OAUTH_PERSONAL_GOOGLE",
      () => f.app.store.locker.set(f.owner, "default", "OAUTH_PERSONAL_GOOGLE", "fixture-new-oauth"));
    check.assertCurrent();
  });
});

test("actual connectorsApi refuses scope replaced while its body is pending before tracker send", async t => {
  const f = await fixture(t); let sends = 0;
  const github = new GitHubAccess({}, new NetworkPolicy({}, async () => ["93.184.216.34"]), async () => "fixture-token",
    async () => { sends++; return new Response('{"id":7,"login":"fixture"}'); });
  const request = new PassThrough(); request.method = "POST"; request.headers = { "content-type": "application/json" };
  const host = { store: f.app.store, sessionLock: f.app.sessionLock, issues: new IssueAccess({ github }) };
  const running = connectorsApi(host, request, "/api/connectors/accounts/github/test");
  const refusal = assert.rejects(running, /no longer authorized/);
  await changes.lock(f); request.end("{}"); await refusal; assert.equal(sends, 0);
});
test("actual OAuth refresh refuses stale response before saving any refreshed credential", async t => {
  const f = await fixture(t), answer = deferred(), entered = deferred();
  const oauth = new OAuthConnections(f.owner, f.app.store.secrets, new NetworkPolicy({}, async () => ["93.184.216.34"]),
    async () => { entered.resolve(); return answer.promise; });
  const provider = { id: "personal-google", label: "Google", clientId: "fixture-client", tokenUrl: "https://oauth2.googleapis.com/token" };
  const running = withHealthCheck(f.check(), () => oauth.refresh(provider, { accessToken: "old", refreshToken: "fixture-refresh" }));
  const refusal = assert.rejects(running, /no longer authorized/);
  await entered.promise; await changes.person(f);
  answer.resolve(new Response('{"access_token":"fixture-new-oauth","token_type":"Bearer","expires_in":3600}'));
  await refusal; assert.equal(f.app.store.locker.exists(f.owner, "default", "OAUTH_PERSONAL_GOOGLE"), false);
});

// Extract exact production functions by AST node, retaining guards while replacing only the actual sender.
async function pinnedBoundary(name, bindings) {
  const source = await readFile(new URL("../src/pinned-fetch.ts", import.meta.url), "utf8");
  const ast = ts.createSourceFile("pinned-fetch.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const node = ast.statements.find(item => ts.isFunctionDeclaration(item) && item.name?.text === name);
  assert.ok(node, `production ${name} boundary exists`);
  const compiled = ts.transpileModule(node.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  return vm.runInNewContext(`${compiled}; ${name}`, bindings);
}
test("actual pinned sender refuses after deferred request body before its exchange", async t => {
  const f = await fixture(t), body = deferred(), entered = deferred(), check = f.check(); let exchanges = 0;
  const send = await pinnedBoundary("sendPinned", { taken: new WeakSet(), URL, Buffer,
    Request: class { constructor() { this.url = "https://fixture.example/check"; this.signal = check.signal; this.body = true; }
      arrayBuffer() { entered.resolve(); return body.promise; } },
    assertHealthCurrent: () => currentHealthCheck()?.assertCurrent(),
    exchange: async () => { exchanges++; return {}; }, responseFrom: () => new Response('{}') });
  const pending = withHealthCheck(check, () => send("https://fixture.example/check", {}, { host: "fixture.example" }));
  const refusal = assert.rejects(pending, /no longer authorized/);
  await entered.promise; await changes.lock(f); body.resolve(new ArrayBuffer(0)); await refusal; assert.equal(exchanges, 0);
});
test("actual pinned exchange cancels its pending fake outgoing request on scope revocation", async t => {
  const f = await fixture(t), check = f.check(), entered = deferred(); let destroyed = null, sends = 0;
  const outgoing = new EventEmitter();
  outgoing.setTimeout = () => {};
  outgoing.end = () => entered.resolve();
  outgoing.destroy = reason => { destroyed = reason; outgoing.emit("error", reason); outgoing.emit("close"); };
  const exchange = await pinnedBoundary("exchange", {
    assertHealthCurrent: () => currentHealthCheck()?.assertCurrent(),
    httpRequest: () => { sends++; return outgoing; }, httpsRequest: () => { sends++; return outgoing; },
    outgoingHeaders: () => ({}), judgedOnly: () => () => {}, connectMs: 10000, idleMs: 300000,
    setTimeout, clearTimeout, fetchFailed: cause => new Error("fetch failed", { cause }) });
  const pending = withHealthCheck(check, () => exchange(new URL("https://fixture.example/check"),
    { signal: check.signal, method: "GET" }, undefined, { host: "fixture.example" }));
  const refusal = assert.rejects(pending, /no longer authorized/);
  await entered.promise; await changes.person(f); await refusal;
  assert.equal(sends, 1); assert.equal(destroyed, check.signal.reason);
});

for (const transition of ["person", "lock"]) {
  test(`actual HomeControl cancels a stalled metadata response body after ${transition} revocation`, async t => {
    const f = await fixture(t), reading = deferred(), cancelled = deferred(); let cancels = 0;
    const home = new HomeControl(f.app.store, f.owner, async () => new Response(new ReadableStream({
      pull() { reading.resolve(); return new Promise(() => {}); },
      cancel(reason) { cancels++; cancelled.resolve(reason); return new Promise(() => {}); },
    })), async () => "fixture-token");
    home.save({ url: "https://93.184.216.34" });
    const check = f.check();
    const pending = withHealthCheck(check, () => home.test());
    const refusal = assert.rejects(pending, /no longer authorized/);
    await reading.promise; await changes[transition](f);
    await refusal; await cancelled.promise;
    assert.equal(check.signal.aborted, true); assert.equal(cancels, 1);
    assert.equal(await cancelled.promise, check.signal.reason, "reader cancellation retains the original authority refusal");
    assert.equal(f.app.store.get("settings", f.owner, "personal-connection-health:home-control"), undefined,
      "a cancelled metadata read never records a successful health check");
  });
}

test("actual authorized Google OAuth refresh persists its exact read-only token and revokes a separate pending gate", async t => {
  const f = await fixture(t), response = deferred(), entered = deferred();
  const signIn = new SignIn({ store: f.app.store, owner: f.owner, secret: async () => "fixture-secret",
    oauth: { saved: async () => null }, fetch: async () => new Response('{}') }, "google", "google");
  signIn.save({ clientId: "fixture-client", drafts: false });
  const governance = f.app.store.list("governance", f.owner), settings = signIn.settings();
  const other = f.check(); t.after(() => other.close());
  const oauth = new OAuthConnections(f.owner, f.app.store.secrets, new NetworkPolicy({}, async () => ["93.184.216.34"]),
    async () => { entered.resolve(); return response.promise; });
  const provider = { id: "personal-google", label: "Google", clientId: "fixture-client", tokenUrl: "https://oauth2.googleapis.com/token" };
  const original = { accessToken: "fixture-old", refreshToken: "fixture-refresh", scope: "original-read-only" };
  const check = f.check(undefined, "OAUTH_PERSONAL_GOOGLE");
  const pending = withHealthCheck(check, () => oauth.refresh(provider, original));
  await entered.promise;
  response.resolve(new Response('{"access_token":"fixture-refreshed","token_type":"Bearer","expires_in":3600,"scope":"original-read-only"}'));
  const tokens = await pending;
  assert.equal(tokens.accessToken, "fixture-refreshed"); assert.equal(tokens.scope, original.scope);
  assert.equal(tokens.refreshToken, original.refreshToken); assert.equal(check.signal.aborted, false);
  const saved = await oauth.saved("personal-google");
  assert.equal(saved.accessToken, tokens.accessToken); assert.equal(saved.scope, original.scope);
  assert.equal(other.signal.aborted, true, "a different check never adopts another operation's token replacement");
  assert.throws(() => other.assertCurrent(), /no longer authorized/);
  assert.deepEqual(f.app.store.list("governance", f.owner), governance);
  assert.deepEqual(signIn.settings(), settings); assert.equal(signIn.settings().drafts, false);
});
test("actual personalApi GET sign-in status refuses owner-return and unlock after deferred saved-token lookup", async t => {
  const f = await fixture(t);
  for (const transition of ["person", "lock"]) {
    const saved = deferred(), entered = deferred(), request = new EventEmitter();
    const signIn = new SignIn({ store: f.app.store, owner: f.owner, secret: async () => "fixture-secret",
      oauth: { saved: () => { entered.resolve(); return saved.promise; } }, fetch: async () => new Response('{}') }, "google", "google");
    signIn.save({ clientId: "fixture-client", drafts: false });
    const pending = personalApi({ runtime: f.app.runtime, personal: { signIns: { google: signIn } },
      method: "GET", readBody: async () => { throw new Error("GET must not read a body"); }, sessionLock: f.app.sessionLock, request },
      "/api/personal/signin/google");
    const refusal = assert.rejects(pending, /no longer authorized/);
    await entered.promise; await changes[transition](f);
    saved.resolve({ accessToken: "fixture-token", scope: "original-read-only", expiresAt: null });
    await refusal;
  }
});
