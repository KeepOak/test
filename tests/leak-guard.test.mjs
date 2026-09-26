import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { argumentFingerprint } from "../dist/runtime.js";
import { WorkspaceFiles } from "../dist/files.js";
import { WorkspaceSearch } from "../dist/code-search.js";
import {
  LeakGuard, credentialInUrl, findLeaks, isJsonWebToken, redactLeaks, redactLeaksIn, redactMessages,
} from "../dist/leak-guard.js";

// Every key below is obviously fake: built from repeated letters and digits at run time, so no
// file in this repository holds anything that looks like a real credential.
const run = (text, n) => text.repeat(Math.ceil(n / text.length)).slice(0, n);
const b64url = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const fake = {
  anthropic: "sk-" + "ant-api03-" + run("FAKEfake0123", 95),
  openai: "sk-" + "proj-" + run("FAKE0fake1", 48),
  openaiLegacy: "sk-" + run("Fake0Key1", 48),
  aws: "AKIA" + run("FAKE0EXAMPLE", 16),
  awsSecret: run("fAKE0secret/EXAMPLE+", 40),
  github: "ghp_" + run("FAKE0fake1", 36),
  githubPat: "github_pat_" + run("FAKE0fake1", 22) + "_" + run("fake1FAKE0", 59),
  slack: "xoxb-" + "0000000000-" + run("FAKEfake", 24),
  google: "AIza" + run("FAKE0fake_", 35),
  jwt: [b64url({ alg: "HS256", typ: "JWT" }), b64url({ sub: "nobody", fake: true }), run("FAKEsignature0", 43)].join("."),
  password: "Fake-Pa55word!",
};
const keyBlock = ["-----BEGIN OPENSSH PRIVATE KEY-----", run("FAKEKEYMATERIAL0", 70), run("FAKEKEYMATERIAL1", 70), // not-a-real-secret
  "-----END OPENSSH PRIVATE KEY-----"].join("\n");

const leaked = (text) => Object.values(fake).filter((value) => text.includes(value));

test("every kind of key the brief names is found and hidden", () => {
  const samples = [
    `export ANTHROPIC_API_KEY=${fake.anthropic}`,
    `OPENAI_API_KEY="${fake.openai}"`,
    `old key ${fake.openaiLegacy} still works`,
    `[default]\naws_access_key_id = ${fake.aws}\naws_secret_access_key = ${fake.awsSecret}`,
    `remote: https://${fake.github}@github.com/example/repo.git`,
    `token ${fake.githubPat}`,
    `SLACK_BOT_TOKEN=${fake.slack}`,
    `maps key ${fake.google} here`,
    `cookie: session=${fake.jwt}`,
    `Authorization: Bearer ${fake.openaiLegacy}`,
    `curl -H "Authorization: Basic ${Buffer.from("user:" + fake.password).toString("base64")}" https://example.org`,
    `database:\n  password: ${fake.password}\n`,
    `{"password": "${fake.password}"}`,
    `DATABASE_URL=postgres://app:${fake.password}@db.example.org:5432/app`,
    `before\n${keyBlock}\nafter`,
  ];
  for (const sample of samples) {
    const { text, kinds } = redactLeaks(sample);
    assert.ok(kinds.length, `found something in: ${sample.slice(0, 40)}`);
    assert.deepEqual(leaked(text), [], `nothing survives in: ${text}`);
    assert.ok(!text.includes("FAKEKEYMATERIAL"), "a private key block goes entirely");
    assert.match(text, /\[hidden key-like value: /);
    assert.deepEqual(redactLeaks(text).kinds, [], "hiding twice changes nothing more");
  }
  // The labels stay, so the reader still knows what was there.
  assert.equal(redactLeaks(`password: ${fake.password}`).text, "password: [hidden key-like value: password]");
  assert.equal(redactLeaks(`before\n${keyBlock}\nafter`).text, "before\n[hidden key-like value: private key]\nafter");
  assert.match(redactLeaks(`postgres://app:${fake.password}@db.example.org/app`).text, /^postgres:\/\/app:\[hidden[^\]]*\]@db\.example\.org\/app$/);
});

test("a private key with no end line is hidden to the end of the text", () => {
  const cut = `log line\n-----BEGIN RSA PRIVATE KEY-----\n${run("FAKEKEYMATERIAL2", 400)}`; // not-a-real-secret
  assert.equal(redactLeaks(cut).text, "log line\n[hidden key-like value: private key]");
});

test("ordinary prose, code, hashes and addresses pass untouched", () => {
  const ordinary = [
    "The password must be at least 12 characters long. Authorization: required for every call.",
    "Use a Bearer token in the Authorization header; see the docs for how to get one.",
    "const password = z.string().min(8); const apiKey = process.env.OPENAI_API_KEY;",
    "password: input.password, secret: string, api_key: ${API_KEY}, token: <your token here>",
    "headers: { Authorization: `Bearer ${token}` }",
    "Authorization: Bearer <token>",
    "sha256 9f86d081884c7d659a2feaf0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
    "commit 3b18e512dba79e4c8300dd08aeb37f8e728b8dad (HEAD -> main)",
    "integrity sha512-z4PhNX7vuL3xVChQ1m2AB9Yg5AULVxXcg/SpIdNs6c5H0NE8XYXysP+DGNKHfuwvY7kxvUdBeoGlODJ6+SfaPg==",
    "id 123e4567-e89b-12d3-a456-426614174000 and uuid f47ac10b-58cc-4372-a567-0e02b2c3d479",
    "import sklearn; pip install scikit-learn; the sk-learn-compatible-estimators page", // not-a-real-secret
    "task-management-app-with-a-very-long-name and risk-assessment-framework-document",
    "Visit https://example.org:8080/path?page=2&sort=asc or git@github.com:org/repo.git",
    "postgres://user:password@localhost/db is the usual example; so is http://user:pass@host/",
    "com.example.application.MainActivity and module.exports.somethingQuiteLong.again",
    "version 1.2.3-beta.4+build.5678 released; see eyebrow.something.elsewhere for details",
    "The AKIA prefix marks an AWS access key; ghp_ marks a GitHub token; xoxb- a Slack bot token.",
    "Base64 picture: iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    "-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA\n-----END PUBLIC KEY-----",
    "-----BEGIN CERTIFICATE-----\nMIIDdzCCAl+gAwIBAgIEAgAAuTANBgkqhkiG9w0BAQUFADBa\n-----END CERTIFICATE-----",
  ];
  for (const text of ordinary) assert.deepEqual(findLeaks(text), [], text);
});

test("a three-part value is a token only when its header says so", () => {
  assert.equal(isJsonWebToken(fake.jwt), true);
  assert.equal(isJsonWebToken("eyebrow.something.elsewhere"), false);
  assert.equal(isJsonWebToken([b64url({ typ: "JWT" }), "payloadpart", "signaturepart"].join(".")), false, "no alg");
});

test("whole tool results are cleaned; numbers, pictures and nesting survive", () => {
  const result = { exitCode: 0, stdout: `KEY=${fake.openai}\nok`, files: [{ name: "a", note: `pw ${fake.anthropic}` }],
    size: 42, when: new Date(0), nested: { a: { b: { c: `token ${fake.github}` } } } };
  const { value, kinds } = redactLeaksIn(result);
  assert.deepEqual(leaked(JSON.stringify(value)), []);
  assert.deepEqual([...kinds].sort(), ["Anthropic key", "GitHub token", "OpenAI key"]);
  assert.equal(value.exitCode, 0);
  assert.equal(value.size, 42);
  assert.ok(value.when instanceof Date);
  let deep = { secret: `x ${fake.slack}` };
  for (let i = 0; i < 40; i += 1) deep = { deep };
  assert.deepEqual(leaked(JSON.stringify(redactLeaksIn(deep).value)), [], "nesting past the walk limit is still checked");
  const clean = { text: "nothing to see", list: [1, 2, 3] };
  assert.deepEqual(redactLeaksIn(clean).value, clean);
});

test("the request copy is cleaned and the conversation itself is left alone", () => {
  const picture = { mediaType: "image/png", data: "AKIA" + run("A", 16) };
  const messages = [
    { role: "user", content: `use ${fake.openai} please`, images: [picture] },
    { role: "assistant", content: "", toolCalls: [{ id: "1", name: "shell.execute", arguments: JSON.stringify({ env: fake.aws }) }] },
    { role: "tool", content: "done", toolCallId: "1" },
  ];
  const before = JSON.stringify(messages);
  const { messages: sent, kinds } = redactMessages(messages);
  assert.equal(JSON.stringify(messages), before, "nothing changed in place");
  assert.deepEqual(leaked(sent[0].content + sent[1].toolCalls[0].arguments), []);
  assert.equal(sent[0].images[0], picture, "pictures are sent as they are");
  assert.equal(sent[2].toolCallId, "1");
  assert.equal(JSON.parse(sent[1].toolCalls[0].arguments).env, "[hidden key-like value: AWS access key]",
    "tool call arguments are still valid JSON for the provider");
  assert.deepEqual([...kinds].sort(), ["AWS access key", "OpenAI key"]);
});

test("an address that carries a key is recognised", () => {
  for (const url of [
    "https://api.example.org/v1?api_key=abc123def", "https://example.org/x?token=abcdef123",
    "https://example.org/login?user=a&password=hunter22", "https://example.org/#access_token=abcdef123",
    `https://example.org/cb?code=1&state=${fake.github}`, "https://me:secret99@example.org/",
  ]) assert.ok(credentialInUrl(url), url);
  for (const url of [
    "https://example.org/", "https://example.org/search?q=api+key+rotation", "https://example.org/?page=2&token=",
    "https://example.org/docs/password-reset", "https://example.org/?keyboard=uk", "not an address",
  ]) assert.equal(credentialInUrl(url), null, url);
});

test("the guard only tightens a policy outcome", () => {
  const guard = new LeakGuard(() => undefined);
  const url = { url: "https://api.example.org/?api_key=abc123def" };
  const rule = { tool: "*", match: "*", applies: "any", decision: "allow", remember: "always" };
  assert.deepEqual(guard.tighten({ decision: "allow", rule }, url), { decision: "ask", rule: null, leak: '"api_key="' });
  assert.equal(guard.tighten({ decision: "deny", rule }, url).decision, "deny");
  assert.equal(guard.tighten({ decision: "ask", rule }, url).leak, undefined);
  assert.equal(guard.tighten({ decision: "allow", rule }, { url: "https://example.org/" }).decision, "allow");
  assert.equal(guard.tighten({ decision: "allow", rule }, null).decision, "allow");
});

// ---- Through the running app ----------------------------------------------------------------

function scripted(steps) {
  const provider = {
    name: "scripted", requests: [],
    async complete(request) {
      provider.requests.push(structuredClone({ messages: request.messages }));
      const script = provider.steps ?? steps;
      return script[Math.min(provider.requests.length - 1, script.length - 1)];
    },
    reset() { provider.requests.length = 0; },
  };
  return provider;
}
const say = (content) => ({ content, toolCalls: [] });
const call = (name, args, id = "c1") => ({ content: "", toolCalls: [{ id, name, arguments: JSON.stringify(args) }] });
async function fixture(t, steps) {
  const root = await mkdtemp(join(tmpdir(), "branch-leak-guard-"));
  const provider = scripted(steps);
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  t.after(async () => { await app.close(); await discardTemp(root); });
  return { app, provider, workspace: join(root, "workspace") };
}

test("a key in a tool result never reaches the model, the log or the receipt", async (t) => {
  const { app, provider } = await fixture(t, [call("test.env", {}), say("done")]);
  app.registry.register({
    name: "test.env", permission: "files.read", description: "prints settings",
    parameters: z.object({}).strict(), execute: async () => ({ stdout: `HOME=/home/me\nOPENAI_API_KEY=${fake.openai}\n` }),
  });
  const done = await app.runtime.run({ prompt: "show my settings" });
  assert.equal(done.status, "completed", done.output);
  const events = app.store.events(done.id);
  assert.deepEqual(leaked(JSON.stringify(events)), [], "no event carries the value");
  assert.deepEqual(leaked(JSON.stringify(provider.requests)), [], "no request carries the value");
  assert.deepEqual(leaked(JSON.stringify(app.store.messages(done.sessionId))), [], "the stored conversation does not either");
  const notice = events.find((event) => event.kind === "leak.hidden");
  assert.ok(notice, "the hiding is written down");
  assert.equal(notice.data.where, "tool result");
  assert.deepEqual(notice.data.kinds, ["OpenAI key"]);
  assert.match(JSON.stringify(notice), /A key-like value in what test\.env returned was hidden/);
  assert.match(JSON.stringify(provider.requests.at(-1)), /HOME=\/home\/me/, "the rest of the result is still read");
});

test("a key the owner pasted is hidden from the model service and noted once", async (t) => {
  const { app, provider } = await fixture(t, [call("test.noop", {}), call("test.noop", {}, "c2"), say("done")]);
  app.registry.register({ name: "test.noop", permission: "files.read", description: "nothing",
    parameters: z.object({}).strict(), execute: async () => ({ ok: true }) });
  const done = await app.runtime.run({ prompt: `my key is ${fake.anthropic}, keep it safe` });
  assert.equal(done.status, "completed", done.output);
  assert.equal(provider.requests.length, 3);
  assert.deepEqual(leaked(JSON.stringify(provider.requests)), []);
  assert.match(provider.requests[0].messages.at(-1).content, /my key is \[hidden key-like value: Anthropic key\], keep it safe/);
  const notices = app.store.events(done.id).filter((event) => event.kind === "leak.hidden");
  assert.equal(notices.length, 1, "three rounds, one line");
  assert.deepEqual(leaked(JSON.stringify(notices)), []);
});

test("a web fetch whose address carries a key waits for the owner's yes", async (t) => {
  const address = "https://api.example.org/data?api_key=abc123def456";
  const fetched = [];
  const other = "https://api.example.org/data?api_key=zzz999zzz999";
  const { app, provider } = await fixture(t, [call("web.fetch", { url: address }), say("done")]);
  app.registry.unregister("web.fetch");
  app.registry.register({ name: "web.fetch", permission: "web.read", description: "stand-in fetch",
    parameters: z.object({ url: z.string() }).strict(), execute: async ({ url }) => { fetched.push(url); return { text: "page" }; } });
  const paused = await app.runtime.run({ prompt: "get the data" });
  assert.equal(paused.status, "needs_input");
  assert.deepEqual(fetched, [], "nothing was fetched before the yes");
  const [question] = app.runtime.waitingApprovals(paused.sessionId);
  assert.match(question.label, /the address carries "api_key="/);
  assert.equal(question.remember, "session", "never offered as a standing yes");
  assert.ok(!JSON.stringify(app.store.events(paused.id)).includes("abc123def456"), "the key is not written into the question");
  app.runtime.approve(paused.sessionId, "allow", "session");
  provider.reset();
  const second = await app.runtime.run({ prompt: "get the data", sessionId: paused.sessionId });
  assert.equal(second.status, "completed", second.output);
  assert.deepEqual(fetched, [address], "the owner's yes lets that exact address through");
  // The website is the same, the key is not: that is a new question, not something the yes covers.
  provider.reset();
  provider.steps = [call("web.fetch", { url: other }, "c3"), say("done")];
  const third = await app.runtime.run({ prompt: "get the other data", sessionId: paused.sessionId });
  assert.equal(third.status, "needs_input");
  assert.deepEqual(fetched, [address]);
});

test("a web fetch with an ordinary address is not asked about", async (t) => {
  const { app } = await fixture(t, [call("web.fetch", { url: "https://example.org/?page=2" }), say("done")]);
  app.registry.unregister("web.fetch");
  app.registry.register({ name: "web.fetch", permission: "web.read", description: "stand-in fetch",
    parameters: z.object({ url: z.string() }).strict(), execute: async () => ({ text: "page" }) });
  const done = await app.runtime.run({ prompt: "read it" });
  assert.equal(done.status, "completed", done.output);
  assert.ok(!app.store.events(done.id).some((event) => event.kind === "policy.ask"));
});

test("the file tools refuse more places keys live, and still read look-alikes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-leak-files-"));
  t.after(() => discardTemp(root));
  const files = new WorkspaceFiles(root);
  const refused = [".netrc", "_netrc", ".npmrc", ".pypirc", ".pgpass", ".docker/config.json", ".kube/config",
    ".gnupg/pubring.kbx", ".bash_history", ".zsh_history", ".python_history", ".histfile", "fish_history",
    "ConsoleHost_history.txt", "gh/hosts.yml", ".config/gh/hosts.yml", ".config/gcloud/credentials.db",
    "id_ecdsa", "release.keystore", ".vault-token", ".terraformrc"];
  for (const path of refused) await assert.rejects(files.checked(path), /secret filename/, path);
  const allowed = ["docker-compose.yml", "src/history.ts", "docs/kube-notes.md", "npmrc-guide.md", "gh/README.md",
    "config/hosts.yml", "Dockerfile", ".dockerignore", "history_of_rome.txt"];
  for (const path of allowed) await assert.doesNotReject(files.checked(path), path);
  await mkdir(join(root, "gh"), { recursive: true });
  await writeFile(join(root, "gh", "hosts.yml"), "fake: true\n");
  await writeFile(join(root, "gh", "notes.md"), "fine\n");
  await writeFile(join(root, ".npmrc"), "fake=true\n");
  await writeFile(join(root, "notes.txt"), "fake=true\n");
  assert.deepEqual((await files.list("gh")).entries.map((entry) => entry.name), ["notes.md"]);
  assert.ok(!(await files.list(".")).entries.some((entry) => entry.name === ".npmrc"));
  const walked = (await new WorkspaceSearch(files).walk(".", 100)).entries.map((entry) => entry.path);
  assert.ok(walked.includes("notes.txt") && walked.includes("gh/notes.md"), walked.join(", "));
  assert.ok(!walked.includes(".npmrc") && !walked.includes("gh/hosts.yml"), walked.join(", "));
});

// ---- Integration review (integrate/mac2-leak-guard) ------------------------------------------

test("more ordinary text passes untouched: ids, hex logs, keys that are public, prose", async () => {
  const { randomBytes, randomUUID } = await import("node:crypto");
  const ordinary = [
    `commit ${randomBytes(20).toString("hex")} Merge branch 'main'`,
    `request ${randomUUID()} finished; trace ${randomUUID()}`,
    `digest: sha256:${randomBytes(32).toString("hex")}`,
    `2026-09-16T10:00:00Z DEBUG frame ${randomBytes(256).toString("hex")}`,
    "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl me@laptop",
    "Reset your password: https://example.org/account/reset",
    "Forgot your password? Open https://example.org/reset?token= and follow the steps.",
    "api_key: os.environ['OPENAI_API_KEY'] and password=os.getenv('DB_PASSWORD')",
    "access_token: str = Field(default=None); client_secret: ${{ secrets.CLIENT_SECRET }}",
    "The API key is kept in the keychain; token rotation happens every 90 days; Password: ********",
    "eyJmb28iOiJiYXIifQ.eyJmb28iOiJiYXIifQ.c2lnbmF0dXJlc2lnbmF0dXJl is base64 JSON without an alg",
    "redis://:@localhost:6379 and postgres://localhost:5432/app and https://example.org:8443/x",
  ];
  for (const text of ordinary) assert.deepEqual(findLeaks(text), [], text);
  // Pictures inside data addresses, many megabytes of them, stay whole -- even where the random
  // letters happen to spell a key's shape, which on a CI run once hid part of a picture.
  const unlucky = `data:image/png;base64,${randomBytes(3000).toString("base64")}/AIzaSyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q/AKIAABCDEFGHIJKLMNOP+${randomBytes(3000).toString("base64")}`; // not-a-real-secret
  assert.equal(redactLeaksIn({ unlucky }).value.unlucky, unlucky);
  // A real key written beside a picture is still found.
  assert.equal(findLeaks(`${unlucky} and AIzaSyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q`).length, 1); // not-a-real-secret
  for (let i = 0; i < 5; i += 1) {
    const picture = `data:image/png;base64,${randomBytes(750_000).toString("base64")}`;
    assert.equal(redactLeaksIn({ picture }).value.picture, picture);
  }
});

test("long hostile text is checked in linear time", () => {
  const size = 200_000;
  const hostile = [
    "a.".repeat(size / 2) + "://", "ey-".repeat(size / 3), "-----BEGIN PRIVATE KEY-----\n".repeat(size / 28), // not-a-real-secret
    "authorization: ".repeat(size / 15), "password=".repeat(size / 9), "?token=".repeat(size / 7),
    "sk-".repeat(size / 3), "-ghp_" + "a".repeat(size) + "_", "Bearer " + " ".repeat(size),
    "a://b:" + "c".repeat(size), "x://u:".repeat(size / 6), "-xoxb-".repeat(size / 6),
    ("eyAAAAAAAAA.BBBBBBBBB.").repeat(size / 22), "https://hooks.slack.com/services/".repeat(size / 33),
  ];
  for (const text of hostile) {
    const started = performance.now();
    findLeaks(text);
    // Wall clock on a shared machine: linear runs take milliseconds, the old quadratic ones 10-15 s.
    const took = performance.now() - started;
    assert.ok(took < 5000, `${text.slice(0, 12)}… took ${Math.round(took)} ms`);
  }
});

test("hidden tool-call arguments still parse, even around escaped quotes", () => {
  const commands = [
    { command: `curl -H "Authorization: Bearer ${fake.openaiLegacy}" https://example.org` },
    { command: `echo "password=${fake.password}" > settings` },
    { command: `curl "https://example.org/?token=abc123def456" -o page` },
    { text: `url "postgres://app:${fake.password}@db/app"` },
    { password: fake.password, nested: { note: `"${keyBlock}` } },
  ];
  for (const args of commands) {
    const bytes = JSON.stringify(args);
    const { messages } = redactMessages([{ role: "assistant", content: "", toolCalls: [{ id: "1", name: "t", arguments: bytes }] }]);
    const sent = messages[0].toolCalls[0].arguments;
    assert.doesNotThrow(() => JSON.parse(sent), sent);
    assert.deepEqual(leaked(sent), [], sent);
    assert.ok(!sent.includes("abc123def456") && !sent.includes("FAKEKEYMATERIAL"), sent);
  }
});

test("a structured result hides a value by the name beside it, and names that are keys", () => {
  const { value, kinds } = redactLeaksIn({ database: { password: fake.password, user: "app" },
    [fake.github]: "listed by token", schema: { password: "string" } });
  assert.deepEqual(leaked(JSON.stringify(value)), []);
  assert.equal(value.database.user, "app");
  assert.equal(value.schema.password, "string", "a type name is not a password");
  assert.deepEqual([...kinds].sort(), ["GitHub token", "password"]);
  const twice = redactLeaksIn(value);
  assert.deepEqual(twice.value, value, "hiding a second time changes nothing");
  assert.equal(twice.kinds.size, 0);
});

test("an address is recognised however the key's name is written", () => {
  for (const url of [
    "https://example.org/?API_KEY=abc", "https://example.org/?api%5Fkey=abc", "https://example.org/?Api-Key=abc",
    "https://example.org/?ToKeN=abc", "https://example.org/?to%6Ben=abc", "https://example.org/?api_key[]=abc",
    "https://example.org/?api%255Fkey=abc", "https://example.org/?token%00=abc", "HTTPS://ME:PW@EXAMPLE.ORG/",
    "https://example.org/?private_token=abc", "https://example.org/?refresh_token=abc", "https://example.org/?pwd=abc",
    "https://sometoken123456@example.org/",
  ]) assert.ok(credentialInUrl(url), url);
});

test("a yes for one address never covers another on the same website, on any path", async (t) => {
  const { app } = await fixture(t, [say("done")]);
  app.registry.unregister("web.fetch");
  app.registry.register({ name: "web.fetch", permission: "web.read", description: "stand-in fetch",
    parameters: z.object({ url: z.string() }).strict(), execute: async () => ({ text: "page" }) });
  const context = app.runtime.context({ runId: "leak-review", source: "owner", approvalKey: "conversation-1" });
  const args = { url: "https://api.example.org/?api_key=abc123def456" };
  const fingerprint = argumentFingerprint("web.fetch", JSON.stringify(args));
  // A yes kept without a fingerprint (as a recipe step's used to be) is a yes for the website, not the address.
  app.runtime.approvals.remember("conversation-1", "web.fetch", "api.example.org", "allow");
  assert.equal(app.runtime.checkPolicy("web.fetch", args, context, fingerprint).decision, "ask");
  assert.equal(app.runtime.checkPolicy("web.fetch", args, context).decision, "ask", "no fingerprint, no kept yes");
  app.runtime.approvals.remember("conversation-1", "web.fetch", "api.example.org", "allow", { fingerprint });
  assert.equal(app.runtime.checkPolicy("web.fetch", args, context, fingerprint).decision, "allow");
  const other = { url: "https://api.example.org/?API_KEY=abc123def456" };
  assert.equal(app.runtime.checkPolicy("web.fetch", other, context, argumentFingerprint("web.fetch", JSON.stringify(other))).decision, "ask");
  const elsewhere = app.runtime.context({ runId: "leak-review", source: "owner", approvalKey: "conversation-2" });
  assert.equal(app.runtime.checkPolicy("web.fetch", args, elsewhere, fingerprint).decision, "ask", "another conversation asks again");
});
