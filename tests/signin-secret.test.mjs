/**
 * #484 (the lead's call): the window saves the client secret of the owner's own Google (or Microsoft) app write-only,
 * through the engine's secrets locker: POST /api/personal/signin/<service>/secret. It is the owner's alone, the value
 * goes in and is never shown back (not in the answer, a settings record or a later read), and the sign-in then reads
 * it from the locker. Temp folders and a scripted model; nothing is dialled.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

const value = "gocspx-owner-typed-client-secret-7f3a";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-signin-secret-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"),
    provider: { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } } });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const call = async (path, body, key = server.token) => {
    const response = await fetch(server.url + path, { method: body === undefined ? "GET" : "POST",
      headers: { authorization: "Bearer " + key, origin: server.url, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text();
    return { status: response.status, text, body: JSON.parse(text) };
  };
  return { app, call };
}

const locker = (app, name) => app.store.secrets.resolve(app.runtime.owner, app.store.projects.active(app.runtime.owner).id, [name], { purpose: "test" })
  .then((found) => found[name], () => undefined);

test("the client secret goes into the locker, is named in the settings, and is never shown back", async (t) => {
  const { app, call } = await fixture(t);
  await call("/api/personal/signin/google", { clientId: "123.apps.googleusercontent.com" });
  const saved = await call("/api/personal/signin/google/secret", { value });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.settings.clientSecretName, "GOOGLE_SIGNIN_CLIENT_SECRET");
  assert.equal(saved.body.settings.clientId, "123.apps.googleusercontent.com", "the client id stays");
  assert.equal(saved.text.includes(value), false, "the answer never holds the value");
  assert.equal((await call("/api/personal/signin/google")).text.includes(value), false, "nor does a later read");
  assert.equal(JSON.stringify(app.store.list("settings", app.runtime.owner)).includes(value), false, "nor a settings record");
  assert.equal(await locker(app, "GOOGLE_SIGNIN_CLIENT_SECRET"), value, "the locker holds it");
  assert.equal((await app.personal.signIns.google.provider()).clientSecret, value, "and the sign-in reads it from there");
  // A new one replaces it; Microsoft's is its own.
  await call("/api/personal/signin/google/secret", { value: "second" });
  assert.equal(await locker(app, "GOOGLE_SIGNIN_CLIENT_SECRET"), "second");
  assert.equal((await call("/api/personal/signin/microsoft/secret", { value: "ms" })).body.settings.clientSecretName, "MICROSOFT_SIGNIN_CLIENT_SECRET");
});

test("an empty value, another field or a read is refused, and nothing is written", async (t) => {
  const { app, call } = await fixture(t);
  for (const body of [{ value: "" }, { value: "   " }, { value, name: "OTHER" }, { value, project: "default" }, {}])
    assert.equal((await call("/api/personal/signin/google/secret", body)).status, 400, JSON.stringify(body));
  assert.equal((await call("/api/personal/signin/google/secret")).status, 404, "there is nothing to read");
  assert.equal(await locker(app, "GOOGLE_SIGNIN_CLIENT_SECRET"), undefined);
  assert.equal(app.personal.signIns.google.settings().clientSecretName, "");
});

test("only the owner can save it: a household profile and a short-lived key are refused", async (t) => {
  const { app, call } = await fixture(t);
  for (const scope of ["read", "run"]) {
    const key = app.sessionTokens.create(app.runtime.owner, { name: "script", scope, minutes: 5 }).token;
    assert.equal((await call("/api/personal/signin/google/secret", { value }, key)).status, 401, `${scope} key`);
  }
  const sam = (await call("/api/profiles", { name: "Sam", pin: "2468" })).body;
  assert.equal((await call("/api/profiles/switch", { profileId: sam.id, pin: "2468" })).status, 200);
  const refused = await call("/api/personal/signin/google/secret", { value });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /belongs to the owner/);
  assert.equal(await locker(app, "GOOGLE_SIGNIN_CLIENT_SECRET"), undefined);
  assert.equal(app.personal.signIns.google.settings().clientSecretName, "");
});
