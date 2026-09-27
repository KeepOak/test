/**
 * R17-C (re-audit 2026-09-17): files, voice, devices and personal connectors, through the real app
 * and its web routes. Every part ships off; the switches put tools in and take them out; the routes
 * are the owner's alone; a short-lived key can neither read nor change them; Lockdown stops the
 * tunnel. Temporary folders and fakes only — nothing is dialled, spawned or recorded.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, setLockdown } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { personalParts, personalTools } from "../dist/personal/settings.js";
import { switchedToolTiers } from "../dist/feature-switches.js";
import { isReadOnlyPermission } from "../dist/policy.js";
import { ownerOnlyRead, taskRouteFor } from "../dist/short-lived-keys.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-personal-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"),
    provider: { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } } });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const call = async (path, body, key = server.token) => {
    const response = await fetch(server.url + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: "Bearer " + key, origin: server.url, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  };
  return { app, root, server, call };
}

test("every personal part ships off: no tools in the catalog, and a plain refusal", async (t) => {
  const { app, call } = await fixture(t);
  // The owner's rule (ships on, 2026-09-26): the connectors ship "when needed" (ready once the owner signs in); the
  // rest stay off for the reasons in src/personal/settings.ts. What "off" does is tested by switching every part off.
  const shipsOn = ["spotify", "google", "microsoft", "mail-search"]; // chat-files and spoken-brief send, so they stay off
  assert.deepEqual((await call("/api/personal")).body.modes, Object.fromEntries(personalParts.map((part) => [part, shipsOn.includes(part) ? "when-needed" : "off"])));
  for (const part of personalParts) await call("/api/personal/switch", { part, mode: "off" });
  const { body } = await call("/api/personal");
  assert.deepEqual(Object.values(body.modes), personalParts.map(() => "off"));
  for (const part of personalParts) for (const tool of personalTools[part])
    assert.equal(app.registry.names().includes(tool), false, `${tool} is in the catalog while its part is off`);
  for (const [path, payload] of [["/api/personal/x/search", { query: "oak" }], ["/api/personal/home/states", {}],
    ["/api/personal/tunnel/start", {}], ["/api/personal/brief/play", {}], ["/api/personal/signin/google/start", {}],
    ["/api/personal/voice/offer", { sessionId: "00000000-0000-4000-8000-000000000000", fingerprint: "f" }]]) {
    const refused = await call(path, payload);
    assert.equal(refused.status, 409, path);
    assert.match(refused.body.error, /is switched off/);
  }
});

test("a switch puts a part's tools in and takes them out, and 'on' preloads them", async (t) => {
  const { app, call } = await fixture(t);
  assert.equal((await call("/api/personal/switch", { part: "google", mode: "when-needed" })).body.mode, "when-needed");
  for (const tool of personalTools.google) assert.ok(app.registry.names().includes(tool), tool);
  const available = app.registry.names();
  assert.deepEqual(switchedToolTiers(app.store, app.runtime.owner, available).preload, []);
  await call("/api/personal/switch", { part: "google", mode: "on" });
  const tiers = switchedToolTiers(app.store, app.runtime.owner, app.registry.names());
  assert.deepEqual(tiers.preload.map((p) => p.name).sort(), [...personalTools.google].sort());
  await call("/api/personal/switch", { part: "google", mode: "off" });
  for (const tool of personalTools.google) assert.equal(app.registry.names().includes(tool), false, tool);
  // Reading is a look; drafts, playback and switching the house are changes.
  assert.equal(isReadOnlyPermission("personal.read"), true);
  // Sending the briefing to a chat is a sending tool, which a chat-started task never gets.
  await call("/api/personal/switch", { part: "spoken-brief", mode: "when-needed" });
  assert.equal(app.registry.permissionOf("brief.send_voice"), "channels.send");
  assert.equal(app.registry.permissionOf("chat.send_file"), "");
  assert.equal(app.registry.permissionOf("brief.spoken"), "personal.read");
  // A task started from a chat gets none of the owner's personal connectors.
  await call("/api/personal/switch", { part: "home-control", mode: "on" });
  const chatAllowed = app.channels["chatPermissions"]();
  for (const permission of ["personal.read", "personal.write", "home.control", "channels.send"]) assert.equal(chatAllowed.includes(permission), false, permission);
  for (const permission of ["personal.write", "home.control", "channels.send"]) assert.equal(isReadOnlyPermission(permission), false);
});

test("a short-lived key can neither read nor change anything under /api/personal", async (t) => {
  const { app, call } = await fixture(t);
  await call("/api/personal/switch", { part: "tunnel", mode: "on" });
  for (const scope of ["read", "run"]) {
    const key = app.sessionTokens.create(app.runtime.owner, { name: "script", scope, minutes: 5 }).token;
    for (const path of ["/api/personal", "/api/personal/tunnel", "/api/personal/signin/google", "/api/personal/mail"])
      assert.equal((await call(path, undefined, key)).status, 401, `${scope} key read ${path}`);
    for (const [path, body] of [["/api/personal/switch", { part: "google", mode: "on" }], ["/api/personal/tunnel/start", {}],
      ["/api/personal/x", { keyName: "OTHER_KEY" }], ["/api/personal/voice/answer", { id: "00000000-0000-4000-8000-000000000000", transcript: "yes" }]])
      assert.equal((await call(path, body, key)).status, 401, `${scope} key sent ${path}`);
  }
  // The owner's rule (ships on, 2026-09-26): Google ships "when needed", and the refused "on" left it there.
  assert.equal(app.personal.modes().google, "when-needed");
  assert.equal(taskRouteFor("POST", "/api/personal/voice/answer"), null);
  assert.ok(ownerOnlyRead("/api/personal/tunnel"));
});

test("Lockdown refuses to start the webhook tunnel, and nothing is spawned", async (t) => {
  const { app, call } = await fixture(t);
  let spawned = 0;
  app.personal.tunnel["spawnProgram"] = () => { spawned += 1; throw new Error("must not run"); };
  await call("/api/personal/switch", { part: "tunnel", mode: "on" });
  setLockdown(app.store, app.runtime.owner, { on: true });
  const refused = await call("/api/personal/tunnel/start", {});
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /Lockdown is on/);
  assert.equal(spawned, 0);
  assert.equal(app.personal.tunnel.localAddress.startsWith("http://127.0.0.1:"), true);
});

test("settings are saved through the routes and a bad secret name is refused", async (t) => {
  const { app, call } = await fixture(t);
  const saved = await call("/api/personal/signin/microsoft", { clientId: "abc-123", clientSecretName: "", tenant: "contoso.onmicrosoft.com", drafts: true });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.settings.tenant, "contoso.onmicrosoft.com");
  assert.equal(saved.body.status.signedIn, false);
  const bad = await call("/api/personal/x", { keyName: "not a name" });
  assert.equal(bad.status, 400);
  const home = await call("/api/personal/home", { url: "https://home.example", domains: ["light"] });
  assert.deepEqual(home.body.settings.domains, ["light"]);
  assert.deepEqual(app.personal.home.settings().domains, ["light"]);
  // The locker keeps secrets; settings records only ever hold their names.
  assert.equal(JSON.stringify(app.store.list("settings", app.runtime.owner)).includes("client_secret"), false);
});

test("sign-in goes through the existing connection flow, with the client secret from the locker", async (t) => {
  const { app, call } = await fixture(t);
  await app.store.secrets.put(app.runtime.owner, "default", "GOOGLE_CLIENT_SECRET", "locker-held-client-secret");
  await call("/api/personal/switch", { part: "google", mode: "on" });
  await call("/api/personal/signin/google", { clientId: "123.apps.googleusercontent.com", clientSecretName: "GOOGLE_CLIENT_SECRET" });
  const started = await call("/api/personal/signin/google/start", {});
  assert.equal(started.status, 200);
  const url = new URL(started.body.url);
  assert.equal(url.host, "accounts.google.com");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("scope").includes("gmail.readonly"), true);
  assert.equal(url.searchParams.get("scope").includes("gmail.compose"), false, "drafts are off until allowed");
  assert.equal(started.body.url.includes("locker-held-client-secret"), false);
  assert.equal(JSON.stringify(started.body).includes("locker-held-client-secret"), false);
  await app.oauth.cancel("personal-google");
});

test("R17-026: a spoken yes answers the real waiting question once, and never as a standing rule", async (t) => {
  const { app, call } = await fixture(t);
  await call("/api/personal/switch", { part: "voice-approvals", mode: "on" });
  const run = app.store.createRun(app.runtime.owner, "tidy the reports");
  const ask = (fingerprint) => app.runtime.approvals.ask({ runId: run.id, sessionId: run.sessionId, tool: "files.write", target: "reports/old.txt",
    label: "Overwrite reports/old.txt", question: "Delete it?", source: "owner", remember: "always", askedAt: new Date().toISOString(), fingerprint });
  ask("fp-one");
  const stale = await call("/api/personal/voice/offer", { sessionId: run.sessionId, fingerprint: "fp-two" });
  assert.equal(stale.status, 400);
  const offer = await call("/api/personal/voice/offer", { sessionId: run.sessionId, fingerprint: "fp-one" });
  assert.equal(offer.status, 200);
  const unclear = await call("/api/personal/voice/answer", { id: offer.body.id, transcript: "yes, and also delete everything else" });
  assert.equal(unclear.body.decision, null);
  assert.ok(app.runtime.approvals.questionFor(run.sessionId, "fp-one"), "an unclear answer leaves the question waiting");
  const yes = await call("/api/personal/voice/answer", { id: offer.body.id, transcript: "Yes." });
  assert.equal(yes.body.decision, "allow");
  assert.equal(app.runtime.approvals.questionFor(run.sessionId, "fp-one"), undefined);
  const rules = JSON.stringify((await call("/api/policy")).body.policy?.rules ?? []);
  assert.equal(rules.includes("reports/old.txt"), false, "a spoken yes is never written down as a rule");
  const again = await call("/api/personal/voice/answer", { id: offer.body.id, transcript: "yes" });
  assert.equal(again.status, 400);
  // The question changed after the offer was made: the answer does not land on the new one.
  ask("fp-three");
  const offer3 = await call("/api/personal/voice/offer", { sessionId: run.sessionId, fingerprint: "fp-three" });
  app.runtime.approvals.resolve(run.sessionId, "fp-three");
  ask("fp-four");
  const moved = await call("/api/personal/voice/answer", { id: offer3.body.id, transcript: "yes" });
  assert.equal(moved.status, 400);
  assert.ok(app.runtime.approvals.questionFor(run.sessionId, "fp-four"));
});
