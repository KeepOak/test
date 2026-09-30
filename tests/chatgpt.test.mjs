import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import {
  createBranch, ChatGPTAuth, FileTokenVault, ChatGPTProvider, ResponsesStream, responsesBody,
  finishChatGPTSignIn, syncChatGPTPresets, chatgptAccountId, chatgptPresetId,
} from "../dist/index.js";
import { startServer } from "../dist/server.js";

const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const jwt = (claims) => `${b64({ alg: "none" })}.${b64(claims)}.sig`;
const accessToken = (n) => jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_123" }, n });
const idToken = jwt({ email: "person@example.com" });

/** Fake OpenAI: device sign-in endpoints plus a Responses endpoint that records what Branch sends. */
async function fakeOpenAI(t, behaviour = {}) {
  const seen = { requests: [], polls: 0, refreshes: 0 };
  const server = createServer(async (req, res) => {
    let raw = ""; for await (const part of req) raw += part;
    const entry = { url: req.url, headers: req.headers, body: raw };
    seen.requests.push(entry);
    const json = (status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (req.url === "/api/accounts/deviceauth/usercode")
      return json(200, { user_code: "ABCD-EFGH", device_auth_id: "dev_1", interval: "5", expires_in: 900 });
    if (req.url === "/api/accounts/deviceauth/token")
      return ++seen.polls < 3 ? json(404, {}) : json(200, { authorization_code: "code_1", code_verifier: "ver_1" });
    if (req.url === "/oauth/token") {
      const form = new URLSearchParams(raw);
      if (form.get("grant_type") === "refresh_token") {
        seen.refreshes += 1;
        if (behaviour.refreshFails) return json(401, { error: "invalid_grant" });
        assert.equal(form.get("refresh_token"), "refresh_1");
        return json(200, { access_token: accessToken(2), refresh_token: "refresh_2", expires_in: 3600 });
      }
      assert.equal(form.get("code_verifier"), "ver_1");
      assert.equal(form.get("redirect_uri"), `http://127.0.0.1:${server.address().port}/deviceauth/callback`);
      return json(200, { access_token: accessToken(1), refresh_token: "refresh_1", id_token: idToken, expires_in: 3600 });
    }
    if (req.url === "/codex/responses") {
      if (behaviour.responsesStatus) return json(behaviour.responsesStatus, { detail: "Unsupported parameter: max_output_tokens" });
      res.writeHead(200, behaviour.noContentType ? {} : { "content-type": "text/event-stream" });
      const body = JSON.parse(raw);
      const events = body.input.some((item) => item.type === "function_call_output")
        ? [{ type: "response.output_text.delta", delta: "Done: " }, { type: "response.output_text.delta", delta: "greeting saved" },
           { type: "response.completed", response: { usage: { input_tokens: 12, output_tokens: 4 } } }]
        : [{ type: "response.created", response: { status: "in_progress", usage: null, error: null, incomplete_details: null } },
           { type: "response.output_item.done", item: { type: "function_call", call_id: "call_1", name: body.tools[0].name,
             arguments: JSON.stringify({ path: "hello.txt", content: "hello" }) } },
           { type: "response.completed", response: { usage: { input_tokens: 10, output_tokens: 2 } } }];
      for (const event of events) res.write(`data: ${JSON.stringify(event)}\n\n`);
      return res.end("data: [DONE]\n\n");
    }
    json(404, {});
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, seen };
}
async function fixture(t, behaviour) {
  const { base, seen } = await fakeOpenAI(t, behaviour);
  const root = await mkdtemp(join(tmpdir(), "branch-chatgpt-"));
  const vaultPath = join(root, "chatgpt-auth.json");
  const auth = new ChatGPTAuth(new FileTokenVault(vaultPath), {
    issuer: base, verificationUrl: `${base}/codex/device`, sleep: async () => {}, userAgent: "BranchAgent/test",
  });
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), chatgpt: auth });
  t.after(async () => { await app.close(); await discardTemp(root); });
  return { app, auth, base, seen, root, vaultPath };
}
/** Point the registered ChatGPT presets at the fake backend. */
function useFakeBackend(app, auth, base) {
  for (const preset of app.runtime.models.presets.values())
    if (preset.id.startsWith("chatgpt-"))
      app.runtime.models.register({ ...preset, provider: new ChatGPTProvider(auth, { model: preset.model, apiBase: `${base}/codex`, userAgent: "BranchAgent/test" }) });
}

test("device sign-in stores tokens, registers ChatGPT presets and completes a tool-using task", async (t) => {
  const { app, auth, base, seen, vaultPath } = await fixture(t);
  assert.equal((await auth.status()).signedIn, false);
  assert.equal(app.runtime.models.presets.size, 1, "demo only before sign-in");
  const prompt = await auth.startDeviceLogin();
  assert.equal(prompt.userCode, "ABCD-EFGH");
  assert.equal((await auth.status()).pending.userCode, "ABCD-EFGH");
  const status = await finishChatGPTSignIn(app.runtime.models, auth, "local", "BranchAgent/test");
  assert.equal(status.signedIn, true);
  assert.equal(status.email, "person@example.com");
  assert.equal(status.accountId, "acct_123");
  assert.equal(seen.polls, 3);
  const stored = JSON.parse(await readFile(vaultPath, "utf8"));
  assert.equal(stored.protected, false);
  assert.equal(stored.sealed, true, "without the device's key storage it is sealed, not encoded");
  assert.ok(!Buffer.from(stored.value, "base64").toString("utf8").includes("refresh_1"), "tokens cannot be read back from the file alone");
  const ids = [...app.runtime.models.presets.keys()].filter((id) => id.startsWith("chatgpt-"));
  assert.deepEqual(ids, ["chatgpt-gpt-6-sol", "chatgpt-gpt-6-luna", "chatgpt-gpt-5.6-sol", "chatgpt-gpt-5.6-terra", "chatgpt-gpt-5.6-luna", "chatgpt-gpt-5.5", "chatgpt-gpt-6-astra"]);
  const settings = app.runtime.models.settings("local");
  assert.equal(settings.activePreset, "chatgpt-gpt-6-sol", "ChatGPT replaces the demonstration as default, with GPT-6 Sol");
  assert.deepEqual(settings.fallbackOrder, ["chatgpt-gpt-6-luna", "chatgpt-gpt-5.6-sol", "chatgpt-gpt-5.6-terra", "chatgpt-gpt-5.6-luna", "chatgpt-gpt-5.5"]);
  assert.ok(app.runtime.models.presets.has("chatgpt-gpt-6-astra"), "Astra is available for an explicit choice");
  assert.ok(!settings.fallbackOrder.includes("chatgpt-gpt-6-astra"), "Astra is never an automatic fallback");
  useFakeBackend(app, auth, base);
  const run = await app.runtime.run({ prompt: "save a greeting" });
  assert.equal(run.status, "completed");
  assert.equal(run.output, "Done: greeting saved");
  const calls = seen.requests.filter((entry) => entry.url === "/codex/responses");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].headers.authorization, `Bearer ${accessToken(1)}`);
  assert.equal(calls[0].headers["chatgpt-account-id"], "acct_123");
  assert.equal(calls[0].headers.originator, "branch-agent");
  assert.match(calls[0].headers["user-agent"], /^BranchAgent\//);
  const body = JSON.parse(calls[0].body);
  assert.equal(body.model, "gpt-6-sol");
  assert.equal(body.stream, true);
  assert.equal(body.store, false);
  assert.deepEqual(body.reasoning, { effort: "medium", summary: "auto" }, "GPT-6 Sol thinks at medium, and its thinking is summed up (B1)");
  assert.match(body.instructions, /Branch Agent/);
  assert.equal(body.input[0].role, "user");
  const second = JSON.parse(calls[1].body);
  assert.equal(second.input.at(-2).type, "function_call");
  assert.equal(second.input.at(-1).type, "function_call_output");
  assert.equal(second.input.at(-1).call_id, "call_1");
  assert.equal(app.store.usage(run.id).reportedInput, 22);
});

test("GPT-6 Astra is an explicit subscription choice and runs Branch tools without replacing the Sol default", async (t) => {
  const { app, auth, base, seen } = await fixture(t);
  await auth.startDeviceLogin();
  await finishChatGPTSignIn(app.runtime.models, auth, "local", "BranchAgent/test");
  assert.ok(app.runtime.models.presets.has("chatgpt-gpt-6-astra"));
  useFakeBackend(app, auth, base);
  const run = await app.runtime.run({ prompt: "save a greeting", model: "chatgpt-gpt-6-astra" });
  assert.equal(run.status, "completed");
  assert.equal(run.output, "Done: greeting saved");
  const calls = seen.requests.filter((entry) => entry.url === "/codex/responses");
  assert.equal(calls.length, 2, "Branch executed the returned tool and sent its result back");
  assert.ok(calls.every((entry) => JSON.parse(entry.body).model === "gpt-6-astra"));
  assert.equal(app.runtime.models.settings("local").activePreset, "chatgpt-gpt-6-sol");
  assert.ok(!app.runtime.models.settings("local").fallbackOrder.includes("chatgpt-gpt-6-astra"));
});

test("expiring access tokens refresh once for concurrent callers; a rejected refresh signs out", async (t) => {
  const { base, seen, vaultPath } = await fixture(t);
  await new FileTokenVault(vaultPath).write({ accessToken: accessToken(1), refreshToken: "refresh_1", expiresAt: new Date(Date.now() + 30_000).toISOString() });
  const fresh = new ChatGPTAuth(new FileTokenVault(vaultPath), { issuer: base, sleep: async () => {} });
  const [a, b] = await Promise.all([fresh.accessToken(), fresh.accessToken()]);
  assert.equal(a, accessToken(2));
  assert.equal(b, accessToken(2));
  assert.equal(seen.refreshes, 1);
  const reread = await new FileTokenVault(vaultPath).read();
  assert.equal(reread.refreshToken, "refresh_2", "rotated refresh token is saved immediately");
});

test("a rejected refresh clears the sign-in and reports a plain message", async (t) => {
  const { base, vaultPath } = await fixture(t, { refreshFails: true });
  await new FileTokenVault(vaultPath).write({ accessToken: accessToken(1), refreshToken: "refresh_1", expiresAt: new Date(Date.now() - 1000).toISOString() });
  const fresh = new ChatGPTAuth(new FileTokenVault(vaultPath), { issuer: base, sleep: async () => {} });
  await assert.rejects(fresh.accessToken(), /Sign in again/);
  assert.equal((await fresh.status()).signedIn, false);
  assert.equal(await new FileTokenVault(vaultPath).read(), null);
});

test("HTTP API exposes sign-in status, starts the device flow and signs out", async (t) => {
  const { app, root } = await fixture(t);
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(() => server.close());
  const call = async (path, body) => {
    const response = await fetch(server.url + "/api/" + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: "Bearer " + server.token, origin: server.url, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, data: await response.json() };
  };
  assert.equal((await call("state")).data.chatgpt.configured, true);
  assert.equal((await call("state")).data.version, app.version);
  const started = await call("chatgpt/login", {});
  assert.equal(started.status, 200);
  assert.equal(started.data.userCode, "ABCD-EFGH");
  assert.ok(!("deviceAuthId" in started.data));
  for (let attempt = 0; attempt < 50 && !(await call("chatgpt/status")).data.signedIn; attempt++) await new Promise((r) => setTimeout(r, 20));
  const status = (await call("chatgpt/status")).data;
  assert.equal(status.signedIn, true);
  assert.equal(status.email, "person@example.com");
  assert.ok(!JSON.stringify(status).includes("refresh_1"));
  assert.equal((await call("state")).data.models.presets.length, 8, "the demonstration and the seven ChatGPT models");
  const out = await call("chatgpt/logout", {});
  assert.equal(out.data.signedIn, false);
  assert.equal((await call("state")).data.models.presets.length, 1);
  assert.equal(app.runtime.models.settings("local").activePreset, null, "removed preset no longer selected");
});

test("replies without a content-type header still parse; a 400 stays a plain provider failure", async (t) => {
  const plain = await fixture(t, { noContentType: true });
  await plain.auth.startDeviceLogin();
  await finishChatGPTSignIn(plain.app.runtime.models, plain.auth, "local", "BranchAgent/test");
  useFakeBackend(plain.app, plain.auth, plain.base);
  const run = await plain.app.runtime.run({ prompt: "save a greeting" });
  assert.equal(run.status, "completed");
  assert.equal(run.output, "Done: greeting saved");
  const bad = await fixture(t, { responsesStatus: 400 });
  await bad.auth.startDeviceLogin();
  await finishChatGPTSignIn(bad.app.runtime.models, bad.auth, "local", "BranchAgent/test");
  useFakeBackend(bad.app, bad.auth, bad.base);
  const failed = await bad.app.runtime.run({ prompt: "hi" });
  assert.equal(failed.status, "failed");
  // mac7/speed: the person is told what happened in plain words; the status line stays in the record.
  assert.match(failed.output, /The model service refused this request \(400\)/);
  assert.match(JSON.stringify(bad.app.store.events(failed.id)), /Provider HTTP 400/, "and the technical text is still kept");
  assert.ok(!JSON.stringify([failed.output, bad.app.store.events(failed.id)]).includes("Unsupported parameter"), "raw provider text is never persisted");
});

test("protected vault round-trips through device key protection", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-vault-"));
  t.after(() => discardTemp(root));
  const protection = { available: () => true, encrypt: (v) => Buffer.from("x" + v), decrypt: (b) => b.toString().slice(1) };
  const vault = new FileTokenVault(join(root, "auth.json"), protection);
  const tokens = { accessToken: accessToken(1), refreshToken: "r", expiresAt: new Date().toISOString() };
  await vault.write(tokens);
  assert.equal(JSON.parse(await readFile(join(root, "auth.json"), "utf8")).protected, true);
  assert.deepEqual(await vault.read(), tokens);
  await vault.clear();
  assert.equal(await vault.read(), null);
  assert.equal(chatgptAccountId("not-a-jwt"), null);
  assert.equal(chatgptPresetId("gpt-5.5"), "chatgpt-gpt-5.5");
});

test("Responses stream parsing rejects failed and incomplete responses", () => {
  const ok = new ResponsesStream(() => {});
  ok.consume(JSON.stringify({ type: "response.output_text.delta", delta: "hi" }));
  assert.throws(() => ok.result(), /without a complete response/);
  ok.consume(JSON.stringify({ type: "response.completed", response: {} }));
  assert.deepEqual(ok.result(), { content: "hi", toolCalls: [] });
  const failed = new ResponsesStream(() => {});
  assert.throws(() => failed.consume(JSON.stringify({ type: "response.failed", response: { error: { message: "quota" } } })), /quota/);
  const incomplete = new ResponsesStream(() => {});
  assert.throws(() => incomplete.consume(JSON.stringify({ type: "response.incomplete", response: { incomplete_details: { reason: "max_output_tokens" } } })), /stopped early/);
  const body = responsesBody({ messages: [{ role: "system", content: "S" }, { role: "user", content: "U" }], tools: [], maxTokens: 100, signal: new AbortController().signal }, "gpt-5.5");
  assert.equal(body.instructions, "S");
  assert.equal("max_output_tokens" in body, false, "the ChatGPT route rejects max_output_tokens");
  assert.equal("tools" in body, false);
});


test("the thinking's summary is passed on as it is written, and never becomes the answer (dogfood B1)", async () => {
  const { ResponsesStream } = await import("../dist/chatgpt-provider.js");
  const said = [], thought = [];
  const stream = new ResponsesStream((text) => said.push(text), (text) => thought.push(text));
  for (const event of [
    { type: "response.reasoning_summary_text.delta", delta: "Checking the settings first" },
    { type: "response.output_text.delta", delta: "Done." },
    { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } },
  ]) stream.consume(JSON.stringify(event));
  assert.deepEqual(thought, ["Checking the settings first"]);
  assert.equal(stream.result().content, "Done.");
});

/* RES-250: without the device's key storage the sign-in was kept as base64 anyone could read back. It is now sealed with
   the locker's key; an older plain file is still read and sealed at once, and a changed file is refused.
   Mutation: write the plain envelope again in FileTokenVault.write (src/chatgpt-auth.ts) and this goes red. */
test("the ChatGPT sign-in file is sealed at rest, an older plain one is sealed on first read, and a changed one is refused", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-chatgpt-seal-"));
  t.after(() => discardTemp(root));
  const path = join(root, "chatgpt-auth.json");
  const tokens = { accessToken: "access-seal-1", refreshToken: "refresh-seal-1", expiresAt: new Date(Date.now() + 3600e3).toISOString() };
  const vault = new FileTokenVault(path);
  await vault.write(tokens);
  const sealed = JSON.parse(await readFile(path, "utf8"));
  assert.deepEqual([sealed.protected, sealed.sealed], [false, true]);
  assert.equal(Buffer.from(sealed.value, "base64").toString("latin1").includes("refresh-seal-1"), false, "not reversible from the file");
  assert.deepEqual(await new FileTokenVault(path).read(), tokens, "read back with the locker key beside it");

  await writeFile(path, JSON.stringify({ protected: false, value: Buffer.from(JSON.stringify(tokens)).toString("base64") }));
  assert.deepEqual(await new FileTokenVault(path).read(), tokens, "an older plain file still signs in");
  assert.equal(JSON.parse(await readFile(path, "utf8")).sealed, true, "and is sealed straight away");

  const bytes = Buffer.from(JSON.parse(await readFile(path, "utf8")).value, "base64");
  bytes[bytes.length - 1] ^= 1;
  await writeFile(path, JSON.stringify({ protected: false, sealed: true, value: bytes.toString("base64") }));
  await assert.rejects(new FileTokenVault(path).read(), /./, "a changed file is refused, not trusted");
});
