/* provider-audit: renewing a sign-in keeps what the service did not send again (Google), and a refusal that does not
   end the sign-in keeps the account (ChatGPT). Every service here is a fake in this file; nothing leaves the computer. */
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { OAuthConnections, oauthSecretName } from "../dist/oauth.js";
import { googleGeminiSignIn, registerSignedInGemini } from "../dist/gemini-signin.js";
import { ChatGPTAuth, refreshEnded } from "../dist/chatgpt-auth.js";
import { Locker } from "../dist/locker.js";
import { LockerTokenVault } from "../dist/accounts/chatgpt-accounts.js";

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** The locker as OAuthConnections uses it, in memory. */
function memorySecrets() {
  const values = new Map();
  return {
    values,
    scrubber: { remember() {} },
    put: async (_owner, _project, name, value) => { values.set(name, value); },
    resolve: async (_owner, _project, names) => Object.fromEntries(names.filter((name) => values.has(name)).map((name) => [name, values.get(name)])),
  };
}
const openPolicy = { assertAllowed: async () => undefined };

/** Google's token address as Google answers a renewal: a new access token, never a refresh token. */
function googleTokens() {
  const renewals = [];
  let issued = 0;
  const fetchImpl = async (_url, init) => {
    const form = new URLSearchParams(String(init.body));
    if (form.get("grant_type") !== "refresh_token") return json(400, { error: "unsupported_grant_type" });
    renewals.push(form.get("refresh_token"));
    return json(200, { access_token: `ya29.renewed-${++issued}`, token_type: "Bearer", expires_in: 0 });
  };
  return { fetchImpl, renewals };
}
const expiredSignIn = (refreshToken) => JSON.stringify({ accessToken: "ya29.first", refreshToken, tokenType: "Bearer",
  expiresAt: new Date(Date.now() - 60_000).toISOString(), scope: null, obtainedAt: new Date().toISOString() });

test("provider-audit: a Google sign-in keeps its refresh token across two renewals", async () => {
  const secrets = memorySecrets(), google = googleTokens(), signIn = googleGeminiSignIn("client-1.apps.googleusercontent.com");
  secrets.values.set(oauthSecretName(signIn.id), expiredSignIn("1//refresh-once"));
  const oauth = new OAuthConnections("owner", secrets, openPolicy, google.fetchImpl);
  assert.equal(await oauth.accessToken(signIn), "ya29.renewed-1");
  // The renewal is saved with the refresh token Google sent at sign-in, so the next renewal still has it.
  assert.equal(JSON.parse(secrets.values.get(oauthSecretName(signIn.id))).refreshToken, "1//refresh-once");
  assert.equal(await oauth.accessToken(signIn), "ya29.renewed-2");
  assert.deepEqual(google.renewals, ["1//refresh-once", "1//refresh-once"]);
  // A refresh token the service does send replaces the one held.
  const rotating = new OAuthConnections("owner", secrets, openPolicy, async () =>
    json(200, { access_token: "ya29.rotated", refresh_token: "1//second", expires_in: 3600 }));
  assert.equal(await rotating.accessToken(signIn), "ya29.rotated");
  assert.equal(JSON.parse(secrets.values.get(oauthSecretName(signIn.id))).refreshToken, "1//second");
});

test("provider-audit: a signed-in Gemini connection asks for its token on each call, not once when it was made", async (t) => {
  const secrets = memorySecrets(), google = googleTokens(), settings = { clientId: "client-1.apps.googleusercontent.com", model: "gemini-2.5-flash" };
  secrets.values.set(oauthSecretName("google-gemini"), expiredSignIn("1//refresh-once"));
  const oauth = new OAuthConnections("owner", secrets, openPolicy, google.fetchImpl);
  let registered = null;
  const preset = await registerSignedInGemini(oauth, settings, (made) => { registered = made; });
  assert.equal(registered, preset);
  // Gemini's own address is answered here, by a stand-in for the global fetch the connection uses.
  const sent = [], saved = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    assert.match(String(url), /^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/models\/gemini-2\.5-flash:generateContent$/);
    sent.push(init.headers.authorization);
    return json(200, { candidates: [{ content: { parts: [{ text: "hi" }] } }] });
  };
  t.after(() => { globalThis.fetch = saved; });
  const ask = () => preset.provider.complete({ messages: [{ role: "user", content: "hi" }], tools: [], signal: AbortSignal.timeout(5000), maxTokens: 16 });
  assert.equal((await ask()).content, "hi");
  assert.equal((await ask()).content, "hi");
  // Each token ran out at once (expires_in 0), so each call renewed it and sent the new one.
  assert.deepEqual(sent, ["Bearer ya29.renewed-2", "Bearer ya29.renewed-3"]);
  assert.equal(preset.provider.audio().apiKey, "ya29.renewed-3", "speech and pictures get the latest token seen");
});

/* ---------- ChatGPT ---------- */

const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const accessFor = (account, n) => `${b64({ alg: "none" })}.${b64({ "https://api.openai.com/auth": { chatgpt_account_id: account }, n })}.sig`;
function memoryVault(tokens) {
  const vault = { tokens, cleared: 0, read: async () => vault.tokens, write: async (next) => { vault.tokens = next; }, clear: async () => { vault.tokens = null; vault.cleared++; } };
  return vault;
}
const expiring = (n, refreshToken) => ({ accessToken: accessFor("acct_1", n), refreshToken, expiresAt: new Date(Date.now() - 1000).toISOString() });

test("provider-audit: a transient 400 on a ChatGPT refresh keeps the account; only a refusal that ends it signs out", async () => {
  const answers = [json(400, { error: "temporarily_unavailable" }), json(200, { access_token: accessFor("acct_1", 2), refresh_token: "refresh_2", expires_in: 3600 })];
  const vault = memoryVault(expiring(1, "refresh_1"));
  const auth = new ChatGPTAuth(vault, { fetch: async () => answers.shift(), sleep: async () => {} });
  await assert.rejects(auth.accessToken(), /could not renew its sign-in just now \(HTTP 400\).*kept/);
  assert.equal(vault.cleared, 0, "the saved sign-in is not cleared");
  assert.equal((await auth.status()).signedIn, true);
  assert.equal(await auth.accessToken(), accessFor("acct_1", 2), "the next try renews with the same refresh token");
  assert.equal(vault.tokens.refreshToken, "refresh_2");

  for (const [status, body] of [[401, {}], [400, { error: "invalid_grant" }], [400, { error: { code: "refresh_token_reused" } }], [403, { code: "refresh_token_expired" }]]) {
    const ended = memoryVault(expiring(1, "refresh_1"));
    const gone = new ChatGPTAuth(ended, { fetch: async () => json(status, body), sleep: async () => {} });
    await assert.rejects(gone.accessToken(), /no longer valid\. Sign in again/, `HTTP ${status} ${JSON.stringify(body)} ends the sign-in`);
    assert.equal(ended.cleared, 1);
  }
  assert.equal(refreshEnded(400, "not json"), false);
  assert.equal(refreshEnded(500, JSON.stringify({ error: "invalid_grant" })), false, "invalid_grant ends it only on a 400");
});

test("provider-audit: before renewing, ChatGPT reads the vault again and uses a renewal another holder already made", async () => {
  let refreshes = 0;
  const vault = memoryVault(expiring(1, "refresh_1"));
  const auth = new ChatGPTAuth(vault, { fetch: async () => { refreshes++; return json(500, {}); }, sleep: async () => {} });
  await auth.load();
  // Another holder of the same sign-in renewed it (and used refresh_1, which cannot be used twice).
  vault.tokens = { accessToken: accessFor("acct_1", 2), refreshToken: "refresh_2", expiresAt: new Date(Date.now() + 3_600_000).toISOString() };
  assert.equal(await auth.accessToken(), accessFor("acct_1", 2));
  assert.equal(refreshes, 0, "no second renewal with the used refresh token");
  // The service refused the access token (a 401): a newer one in the vault is used rather than renewing again.
  vault.tokens = { ...vault.tokens, accessToken: accessFor("acct_1", 3) };
  assert.equal(await auth.refreshNow(), accessFor("acct_1", 3));
  assert.equal(refreshes, 0);
});

test("provider-audit: an extra ChatGPT account's tokens are written in one transaction", async () => {
  const db = new DatabaseSync(":memory:"), locker = new Locker(db, { key: async () => Buffer.alloc(32, 7) });
  const vault = new LockerTokenVault(locker, "owner", "second");
  await vault.write({ accessToken: "access-1", refreshToken: "refresh-1", idToken: "id-1", expiresAt: "2030-01-01T00:00:00.000Z" });
  // The database fails part way through the next write (removing the id token, after the other parts were written).
  const prepare = db.prepare.bind(db);
  db.prepare = (sql) => { if (sql.startsWith("DELETE")) throw new Error("disk went away"); return prepare(sql); };
  await assert.rejects(vault.write({ accessToken: "access-2", refreshToken: "refresh-2", expiresAt: "2031-01-01T00:00:00.000Z" }), /disk went away/);
  db.prepare = prepare;
  assert.deepEqual(await vault.read(), { accessToken: "access-1", refreshToken: "refresh-1", idToken: "id-1", expiresAt: "2030-01-01T00:00:00.000Z" },
    "nothing of the failed write was kept");
  await vault.write({ accessToken: "access-3", refreshToken: "refresh-3", expiresAt: "2032-01-01T00:00:00.000Z" });
  assert.deepEqual(await vault.read(), { accessToken: "access-3", refreshToken: "refresh-3", expiresAt: "2032-01-01T00:00:00.000Z" });
});
