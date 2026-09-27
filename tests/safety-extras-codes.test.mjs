/**
 * mac7/r17-g (R17-063): authenticator codes (RFC 6238) for chosen yeses, and the emergency stop by
 * level. Codes are computed here from the key the setup hands back; no phone is involved.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { base32Decode, base32Encode, hotp, matchTotp, totp, otpauthUri } from "../dist/safety-extras/totp.js";
import { stopRefusal } from "../dist/safety-extras/emergency-stop.js";
import { taskRouteFor } from "../dist/short-lived-keys.js";

const rfcKey = base32Encode(Buffer.from("12345678901234567890"));

test("the codes are RFC 6238's: the published SHA-1 values, six digits, one step of drift, nothing else", () => {
  assert.equal(base32Decode(rfcKey).toString(), "12345678901234567890");
  const secret = base32Decode(rfcKey);
  for (const [time, value] of [[59, "94287082"], [1111111109, "07081804"], [1111111111, "14050471"], [1234567890, "89005924"], [2000000000, "69279037"], [20000000000, "65353130"]])
    assert.equal(hotp(secret, Math.floor(time / 30), 8), value, String(time));
  assert.equal(totp(rfcKey, 59), "287082");
  assert.equal(matchTotp(rfcKey, "287082", 59), 1);
  assert.equal(matchTotp(rfcKey, "287082", 59 + 30), 1, "one step late still counts");
  assert.equal(matchTotp(rfcKey, "287082", 59 + 60), null, "two steps late does not");
  assert.equal(matchTotp(rfcKey, "28708", 59), null);
  assert.equal(matchTotp(rfcKey, "abcdef", 59), null);
  assert.match(otpauthUri(rfcKey, "local"), /^otpauth:\/\/totp\/Branch%20Agent%3Alocal\?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=Branch%20Agent&algorithm=SHA1&digits=6&period=30$/);
});

const say = (content) => () => ({ content, toolCalls: [] });
const shell = (id) => () => ({ content: "", toolCalls: [{ id, name: "shell.execute", arguments: JSON.stringify({ executable: "git", args: ["status"] }) }] });

async function served(t, steps) {
  const root = await mkdtemp(join(tmpdir(), "branch-safety-codes-"));
  let turn = 0;
  const provider = { name: "scripted", async complete(request) { return steps[Math.min(turn++, steps.length - 1)](request); } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const ran = [];
  if (!app.registry.names().includes("shell.execute"))
    app.registry.register({ name: "shell.execute", permission: "shell.execute", description: "run",
      parameters: z.object({ executable: z.string(), args: z.array(z.string()).default([]) }).strict(),
      execute: async (args) => { ran.push(args.executable); return { ok: true, exitCode: 0 }; } });
  const api = async (method, path, body) => {
    const response = await fetch(server.url + path, { method,
      headers: { authorization: `Bearer ${server.token}`, ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  await api("POST", "/api/policy", { preset: "off", unmatchedCommands: "allow", confirmLoosening: true }); // Q257: a loosening needs the owner's yes
  return { app, api, ran };
}
/** Sets up the app's codes and answers with the key, as a phone would hold it. */
async function enrol(api) {
  const begun = await api("POST", "/api/safety-extras/codes/begin", {});
  assert.equal(begun.status, 200, JSON.stringify(begun.body));
  const key = begun.body.key;
  assert.match(begun.body.uri, new RegExp(`secret=${key}&`));
  const view = (await api("GET", "/api/safety-extras")).body;
  assert.equal(JSON.stringify(view).includes(key), false, "the key is never read back");
  assert.equal(view.codes.pending, true);
  assert.equal((await api("POST", "/api/safety-extras/codes/finish", { code: "000000" })).status, 400);
  const used = totp(key);
  assert.equal((await api("POST", "/api/safety-extras/codes/finish", { code: used })).status, 200);
  assert.equal((await api("GET", "/api/safety-extras")).body.codes.enrolled, true);
  return { key, used };
}

test("a listed tool asks even where the rules allow it, and its yes needs a fresh code", async (t) => {
  const { app, api, ran } = await served(t, [shell("c1"), shell("c2"), say("done")]);
  const context = app.runtime.context({ runId: "" });
  assert.equal(app.runtime.checkPolicy("shell.execute", { executable: "git", args: ["status"] }, context).decision, "allow");
  await api("POST", "/api/safety-extras/switch", { part: "code-approvals", mode: "on" });
  assert.equal(app.runtime.checkPolicy("shell.execute", { executable: "git", args: ["status"] }, context).decision, "allow",
    "nothing is held until an app is set up");
  const { key, used } = await enrol(api);
  const held = app.runtime.checkPolicy("shell.execute", { executable: "git", args: ["status"] }, context);
  assert.equal(held.decision, "ask");
  assert.match(held.label, /authenticator app/);

  const paused = (await api("POST", "/api/run", { prompt: "check" })).body;
  assert.equal(paused.status, "needs_input", paused.output);
  const waiting = (await api("GET", "/api/policy")).body.waiting[0];
  const bare = await api("POST", "/api/policy/approve", { sessionId: paused.sessionId, decision: "allow", fingerprint: waiting.fingerprint });
  assert.ok(bare.status >= 400);
  assert.match(bare.body.error, /six-digit code/);
  const reused = await api("POST", "/api/policy/approve", { sessionId: paused.sessionId, decision: "allow", fingerprint: waiting.fingerprint, code: used });
  assert.equal(reused.status, 401, "the code used to finish the setup cannot be used again");
  const next = totp(key, Date.now() / 1000 + 30);
  const answered = await api("POST", "/api/policy/approve", { sessionId: paused.sessionId, decision: "allow", remember: "always", fingerprint: waiting.fingerprint, code: next });
  assert.equal(answered.status, 200, JSON.stringify(answered.body));
  assert.equal(answered.body.remembered, "session", "a coded yes never becomes a standing rule");
  assert.equal((await api("GET", "/api/policy")).body.policy.rules.length, 0);
  const resumed = (await api("POST", "/api/run", { prompt: "go on", sessionId: paused.sessionId })).body;
  assert.equal(resumed.status, "completed", resumed.output);
  assert.deepEqual(ran, ["git"]);
});

test("when needed holds only work the owner did not start", async (t) => {
  const { app, api } = await served(t, [say("done")]);
  await api("POST", "/api/safety-extras/switch", { part: "code-approvals", mode: "when-needed" });
  await enrol(api);
  const args = { executable: "git", args: ["status"] };
  assert.equal(app.runtime.checkPolicy("shell.execute", args, app.runtime.context({ runId: "", source: "owner" })).decision, "allow");
  assert.equal(app.runtime.checkPolicy("shell.execute", args, app.runtime.context({ runId: "", source: "schedule" })).decision, "ask");
  assert.equal(app.runtime.checkPolicy("files.read", { path: "a" }, app.runtime.context({ runId: "", source: "schedule" })).decision, "allow",
    "a tool not on the list is not held");
});

test("the emergency stop refuses by level, and letting it go needs a code when chosen", async (t) => {
  const { app, api } = await served(t, [say("done")]);
  const context = app.runtime.context({ runId: "" });
  const args = { executable: "git", args: ["status"] };
  const pressed = await api("POST", "/api/safety-extras/stop", { tools: ["shell.*"] });
  assert.equal(pressed.body.stop.engaged, true);
  const refused = app.runtime.checkPolicy("shell.execute", args, context);
  assert.equal(refused.decision, "deny");
  assert.match(refused.reason, /emergency stop is on/);
  await assert.rejects(app.runtime.executeTool("shell.execute", args, { mode: "owner" }), /emergency stop/);
  assert.equal(app.runtime.checkPolicy("files.read", { path: "a" }, context).decision, "allow");
  await api("POST", "/api/safety-extras/stop", { sites: ["example.com"] });
  await assert.rejects(app.web.policy.assertAllowed(new URL("https://docs.example.com/x")), /emergency stop is on for docs.example.com/);
  await api("POST", "/api/safety-extras/stop", { network: true });
  await assert.rejects(app.web.policy.assertAllowed(new URL("https://other.example.org/")), /nothing is reached over the network/);
  const audit = app.store.audit.list(app.runtime.owner, { action: "lockdown.changed" });
  assert.ok(audit.some((entry) => entry.subject === "Emergency stop pressed"));

  await api("POST", "/api/safety-extras/switch", { part: "code-approvals", mode: "on" });
  const { key } = await enrol(api);
  // Letting it go needs the owner's yes first (tests/loosening-caps.test.mjs), then the code.
  assert.equal((await api("POST", "/api/safety-extras/stop/release", {})).status, 409);
  assert.equal((await api("POST", "/api/safety-extras/stop/release", { confirmLoosening: true })).status, 401);
  const released = await api("POST", "/api/safety-extras/stop/release", { code: totp(key, Date.now() / 1000 + 30), confirmLoosening: true });
  assert.equal(released.status, 200, JSON.stringify(released.body));
  assert.equal(released.body.stop.engaged, false);
  assert.equal(app.runtime.checkPolicy("shell.execute", args, context).decision, "ask", "back to the code rule, not to a refusal");
});

test("stop levels: everything, and everything that reaches out", () => {
  const store = (data) => ({ get: (_t, _o, key) => (key === "safety-emergency-stop" ? { data } : undefined) });
  assert.match(stopRefusal(store({ everything: true }), "local", "files.read", "files.read", null), /No tool runs/);
  const network = store({ network: true });
  for (const tool of ["web.fetch", "browser.click", "channels.send", "shell.execute", "code.run", "tools.script"])
    assert.match(stopRefusal(network, "local", tool, "x.y", null), /reaches past this computer/, tool);
  assert.equal(stopRefusal(network, "local", "files.write", "files.write", { kind: "path", value: "a" }), null);
  assert.equal(stopRefusal(store({}), "local", "shell.execute", "shell.execute", null), null);
});

test("a short-lived key may press the stop and type a code, never let the stop go or change a switch", () => {
  for (const path of ["/api/safety-extras/stop", "/api/safety-extras/codes/confirm", "/api/safety-extras/activity/verify", "/api/safety-extras/scan"])
    assert.ok(taskRouteFor("POST", path), path);
  for (const path of ["/api/safety-extras/stop/release", "/api/safety-extras/switch", "/api/safety-extras/codes/begin",
    "/api/safety-extras/codes/finish", "/api/safety-extras/codes/remove", "/api/safety-extras/codes", "/api/safety-extras/wasm", "/api/safety-extras/wasm/run"])
    assert.equal(taskRouteFor("POST", path), null, path);
});
