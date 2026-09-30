// A sign-in whose key has run out is renewed once, however many calls find it expired at the same moment: a service
// that rotates refresh keys accepts each one only once.
import test from "node:test";
import assert from "node:assert/strict";
import { OAuthConnections, oauthSecretName } from "../dist/oauth.js";

function lockerWith(tokens) {
  const kept = new Map([[oauthSecretName("svc"), JSON.stringify(tokens)]]);
  return {
    scrubber: { remember() {} },
    async put(_owner, _project, name, value) { kept.set(name, value); },
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
