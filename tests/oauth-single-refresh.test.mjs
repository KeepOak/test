// A sign-in whose key has run out is renewed once, however many calls find it expired at the same moment: a service
// that rotates refresh keys accepts each one only once.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { OAuthConnections, oauthSecretName } from "../dist/oauth.js";
import { Locker, LockerConflict } from "../dist/locker.js";
import { Secrets } from "../dist/vault.js";

function lockerWith(tokens) {
  const kept = new Map([[oauthSecretName("svc"), JSON.stringify(tokens)]]);
  return {
    scrubber: { remember() {} },
    /* As the real locker: with `expect`, written only if it accepts the value held at that moment. */
    async put(_owner, _project, name, value, _options, expect) {
      if (expect && !expect(kept.get(name) ?? null)) throw new LockerConflict(`${name} changed`);
      kept.set(name, value);
    },
    async resolve(_owner, _project, names) { return Object.fromEntries(names.filter((n) => kept.has(n)).map((n) => [n, kept.get(n)])); },
    kept,
  };
}
const provider = { id: "svc", label: "the service", authorizeUrl: "https://svc.example/authorize", tokenUrl: "https://svc.example/token",
  clientId: "client", scopes: [], extra: {} };
const policy = { assertAllowed: async () => undefined };

test("calls that find the key expired at the same moment share one renewal", async () => {
  const locker = lockerWith({ accessToken: "old", refreshToken: "refresh-1", tokenType: "Bearer",
    expiresAt: new Date(Date.now() - 1000).toISOString(), scope: null, obtainedAt: new Date().toISOString() });
  const posts = [];
  const fetchImpl = async (_url, init) => {
    posts.push(String(init.body));
    await new Promise((resolve) => setTimeout(resolve, 50));
    return new Response(JSON.stringify({ access_token: `new-${posts.length}`, refresh_token: `refresh-${posts.length + 1}`, expires_in: 3600 }),
      { status: 200, headers: { "content-type": "application/json" } });
  };
  const connections = new OAuthConnections("owner", locker, policy, fetchImpl);
  const keys = await Promise.all([1, 2, 3, 4].map(() => connections.accessToken(provider)));
  assert.equal(posts.length, 1, "one renewal for four callers");
  assert.match(posts[0], /refresh_token=refresh-1/);
  assert.deepEqual(keys, ["new-1", "new-1", "new-1", "new-1"]);
  assert.equal(await connections.accessToken(provider), "new-1", "the renewed key is used afterwards without renewing again");
  assert.equal(posts.length, 1);
});

test("a renewal that fails is not kept: the next call tries again", async () => {
  const locker = lockerWith({ accessToken: "old", refreshToken: "refresh-1", tokenType: "Bearer",
    expiresAt: new Date(Date.now() - 1000).toISOString(), scope: null, obtainedAt: new Date().toISOString() });
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    if (calls === 1) return new Response("{}", { status: 500 });
    return new Response(JSON.stringify({ access_token: "fresh", expires_in: 3600 }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const connections = new OAuthConnections("owner", locker, policy, fetchImpl);
  await assert.rejects(connections.accessToken(provider), /answered 500/);
  assert.equal(await connections.accessToken(provider), "fresh");
  assert.equal(calls, 2);
});

/* The service answers each renewal only when the test says so; each POST is kept with its address and form. */
function heldService() {
  const posts = [];
  const fetchImpl = async (url, init) => {
    const form = new URLSearchParams(String(init.body));
    let answer;
    const answered = new Promise((done) => { answer = done; });
    const post = { url: String(url), clientId: form.get("client_id"), refresh: form.get("refresh_token"), answer };
    posts.push(post);
    const access = await answered;
    return new Response(JSON.stringify({ access_token: access, refresh_token: `${access}-refresh`, expires_in: 3600 }),
      { status: 200, headers: { "content-type": "application/json" } });
  };
  /* Waits up to two seconds for the count, so a call that joined instead of renewing fails its test, never hangs it. */
  const until = async (count) => {
    for (const end = Date.now() + 2000; posts.length < count && Date.now() < end;) await new Promise((resolve) => setTimeout(resolve, 5));
  };
  return { posts, fetchImpl, until };
}
const expired = (access, refresh) => ({ accessToken: access, refreshToken: refresh, tokenType: "Bearer",
  expiresAt: new Date(Date.now() - 1000).toISOString(), scope: null, obtainedAt: new Date().toISOString() });
const savedAccess = (locker) => JSON.parse(locker.kept.get(oauthSecretName("svc"))).accessToken;

/* A caller whose sign-in differs in one way never joins the renewal under way: it renews with its own client, tenant or
   address and gets that renewal's own answer. The older renewal, answering last, is not written over it, and its caller
   is refused rather than handed the sign-in the other settings got. */
const changes = {
  "client": { clientId: "client-2" },
  "tenant": { tokenUrl: "https://login.example/tenant-b/token", authorizeUrl: "https://login.example/tenant-b/authorize" },
  "token address": { tokenUrl: "https://other.example/token" },
};
for (const [what, change] of Object.entries(changes)) {
  test(`a call with a different ${what} never shares the renewal under way`, async () => {
    const first = { ...provider, tokenUrl: "https://login.example/tenant-a/token", authorizeUrl: "https://login.example/tenant-a/authorize" };
    const second = { ...first, ...change };
    const locker = lockerWith(expired("old", "refresh-1"));
    const service = heldService();
    const connections = new OAuthConnections("owner", locker, policy, service.fetchImpl);
    const older = connections.accessToken(first);
    await service.until(1);
    const newer = connections.accessToken(second);
    await service.until(2);
    assert.equal(service.posts.length, 2, "the changed sign-in renews on its own");
    assert.equal(service.posts[1].url, second.tokenUrl);
    assert.equal(service.posts[1].clientId, second.clientId);
    service.posts[1].answer("for-second");
    assert.equal(await newer, "for-second", "the changed caller gets its own renewal's key");
    service.posts[0].answer("for-first");
    await assert.rejects(older, /other settings; sign in again/, "the older caller never gets the other settings' key");
    assert.equal(savedAccess(locker), "for-second", "the older renewal is not written over the newer sign-in");
    await assert.rejects(connections.accessToken(first), /other settings; sign in again/);
    assert.equal(await connections.accessToken(second), "for-second");
  });
}

test("a replaced expired sign-in renews with its own refresh key, never the old one's", async () => {
  const locker = lockerWith(expired("old", "refresh-1"));
  const service = heldService();
  const connections = new OAuthConnections("owner", locker, policy, service.fetchImpl);
  const older = connections.accessToken(provider);
  await service.until(1);
  locker.kept.set(oauthSecretName("svc"), JSON.stringify(expired("replaced", "refresh-2")));
  const newer = connections.accessToken(provider);
  await service.until(2);
  assert.deepEqual(service.posts.map((p) => p.refresh), ["refresh-1", "refresh-2"]);
  service.posts[1].answer("for-replacement");
  assert.equal(await newer, "for-replacement");
  service.posts[0].answer("for-old");
  assert.equal(await older, "for-replacement", "the old renewal's key is dropped; its caller reads the sign-in now saved");
  assert.equal(savedAccess(locker), "for-replacement");
});

test("a sign-in replaced while its renewal runs keeps the new sign-in: the renewal's answer is neither saved nor handed out", async () => {
  const locker = lockerWith(expired("old", "refresh-1"));
  const service = heldService();
  const connections = new OAuthConnections("owner", locker, policy, service.fetchImpl);
  const older = connections.accessToken(provider);
  await service.until(1);
  const fresh = { ...expired("signed-in-again", "refresh-9"), expiresAt: new Date(Date.now() + 3_600_000).toISOString() };
  locker.kept.set(oauthSecretName("svc"), JSON.stringify(fresh));
  assert.equal(await connections.accessToken(provider), "signed-in-again", "a call after the replacement gets the new sign-in at once");
  service.posts[0].answer("from-old-renewal");
  assert.equal(await older, "signed-in-again", "the waiting caller gets the new sign-in, not the old renewal's key");
  assert.equal(savedAccess(locker), "signed-in-again", "the old renewal's answer is not written over the new sign-in");
  assert.equal(service.posts.length, 1);
});

/* The real locker and vault: the renewal's write waits for the locker key, and the sign-in is replaced in that wait. The
   write compares in the same step as it writes, after the key, so the replacement survives. */
test("a sign-in replaced while the renewal's write waits for the locker key survives that write", async () => {
  let holdWrite = false, letWrite;
  const keyBytes = Buffer.alloc(32, 7);
  const keys = { async key() {
    if (holdWrite && /Locker\.set/.test(new Error().stack ?? "")) { holdWrite = false; await new Promise((go) => { letWrite = go; }); }
    return keyBytes;
  } };
  const db = new DatabaseSync(":memory:"), locker = new Locker(db, keys), secrets = new Secrets(db, locker);
  const name = oauthSecretName("svc");
  await secrets.put("owner", "default", name, JSON.stringify(expired("old", "refresh-1")));
  const fetchImpl = async () => { holdWrite = true;
    return new Response(JSON.stringify({ access_token: "from-old-renewal", refresh_token: "refresh-2", expires_in: 3600 }),
      { status: 200, headers: { "content-type": "application/json" } }); };
  const connections = new OAuthConnections("owner", secrets, policy, fetchImpl);
  const waiting = connections.accessToken(provider);
  for (const end = Date.now() + 2000; !letWrite && Date.now() < end;) await new Promise((r) => setTimeout(r, 5));
  assert.ok(letWrite, "the renewal's write is waiting for the locker key");
  const replacement = { ...expired("signed-in-again", "refresh-9"), expiresAt: new Date(Date.now() + 3_600_000).toISOString() };
  await secrets.put("owner", "default", name, JSON.stringify(replacement));
  letWrite();
  assert.equal(await waiting, "signed-in-again", "the waiting caller gets the new sign-in");
  const kept = JSON.parse((await locker.resolve("owner", "default", [name]))[name]);
  assert.equal(kept.accessToken, "signed-in-again", "the old renewal's key is not written over the new sign-in");
  await assert.rejects(locker.set("owner", "default", name, "x", () => false), LockerConflict);
});
