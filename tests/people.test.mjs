/**
 * Bucket 19: more than one person, safely. People sign in from their own device with the checks the
 * owner chose; each sees only their own conversations and what was shared with them; roles and
 * groups only ever narrow; keys handed to another device reach one conversation; and a short-lived
 * key answers only the questions of tasks it started. Everything ships off.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, createSign, generateKeyPairSync, sign as signData } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { asPerson } from "../dist/people/context.js";
import { onlyTighter, RoleGrantSchema } from "../dist/profile-roles.js";
import { keyAnswerRefusal, underShortLivedKey } from "../dist/key-context.js";
import { verifyAssertion, verifyRegistration, decodeCbor } from "../dist/people/webauthn.js";
import { verifyIdToken, linkedTo, emailSuggests, authorizationUrl } from "../dist/people/oidc.js";
import { SignIns } from "../dist/people/sign-in.js";
import { boundDoorRefusal, personDoorRefusal } from "../dist/people/access.js";

async function served(t, { on = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-people-"));
  const provider = { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const call = async (method, path, { key, body, headers = {} } = {}) => {
    const response = await fetch(server.url + path, {
      method, redirect: "manual",
      headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json().catch(() => ({})), headers: response.headers };
  };
  const owner = (method, path, body) => call(method, path, { key: server.token, body });
  if (on) assert.equal((await owner("POST", "/api/people/settings", { mode: "on" })).status, 200);
  const ada = app.store.profiles.create({ name: "Ada", pin: "1234" });
  const bo = app.store.profiles.create({ name: "Bo", pin: "5678" });
  const signIn = async (name, pin) => {
    const started = await call("POST", "/api/people/sign-in/start", { body: { name } });
    const stepped = await call("POST", "/api/people/sign-in/step", { body: { ticket: started.body.ticket, method: "pin", stage: "finish", pin } });
    assert.equal(stepped.status, 200, JSON.stringify(stepped.body));
    const done = await call("POST", "/api/people/sign-in/finish", { body: { ticket: started.body.ticket } });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    return done.body.key;
  };
  return { app, server, call, owner, ada, bo, signIn };
}

test("B19-1 it ships off: no sign-in page answers and a person's key does nothing", async (t) => {
  const f = await served(t, { on: false });
  assert.equal((await f.owner("GET", "/api/people/settings")).body.settings.mode, "off");
  assert.equal((await f.call("GET", "/api/people/sign-in")).status, 404);
  assert.equal((await f.call("POST", "/api/people/sign-in/start", { body: { name: "Ada" } })).status, 404);
  // The owner's rule (ships on, 2026-09-26): the page also serves a conversation handed on, which ships "when
  // needed" (interop), so that switch is put off here to see what people-off alone does.
  f.app.store.save("settings", f.app.runtime.owner, "interop-handoff", { mode: "off" });
  assert.equal((await fetch(`${f.server.url}/people`)).status, 404, "the page itself is not served either");
  const { key } = f.app.people.keys.issue(f.ada.id, 60, "pin", "test");
  const refused = await f.call("GET", "/api/people/me", { key });
  assert.equal(refused.status, 401);
  assert.match(refused.body.error, /switched off/);
});

test("B19-2 a person signs in with their PIN and reaches only their own page", async (t) => {
  const f = await served(t);
  const key = await f.signIn("ada", "1234");
  assert.match(key, /^branch_person_/);
  const me = await f.call("GET", "/api/people/me", { key });
  assert.equal(me.body.name, "Ada");
  // Everything that is the owner's is refused before any route runs, reads included.
  for (const [method, path] of [["GET", "/api/sessions"], ["GET", "/api/policy"], ["GET", "/api/audit"], ["GET", "/api/profiles"],
    ["POST", "/api/run"], ["POST", "/api/profiles/switch"], ["GET", "/api/people/settings"], ["POST", "/api/people/settings"],
    ["GET", "/api/memory/facts"], ["POST", "/api/policy/approve"], ["GET", "/api/backup"]]) {
    const answer = await f.call(method, path, { key, body: method === "POST" ? {} : undefined });
    assert.equal(answer.status, 401, `${method} ${path}`);
    assert.match(answer.body.error, /only their own page/, `${method} ${path}`);
  }
  // The person's key never stands for the owner, whatever the window is switched to.
  assert.equal(f.app.store.profiles.isOwner(), true);
});

test("B19-3 wrong answers: an unknown name fails like a wrong PIN, and a ticket closes after five", async (t) => {
  const f = await served(t);
  const nobody = await f.call("POST", "/api/people/sign-in/start", { body: { name: "Zed" } });
  assert.deepEqual(nobody.body.steps, ["pin"], "an unknown name is asked the same checks");
  const wrongName = await f.call("POST", "/api/people/sign-in/step", { body: { ticket: nobody.body.ticket, method: "pin", stage: "finish", pin: "1234" } });
  const started = await f.call("POST", "/api/people/sign-in/start", { body: { name: "Ada" } });
  const wrongPin = await f.call("POST", "/api/people/sign-in/step", { body: { ticket: started.body.ticket, method: "pin", stage: "finish", pin: "0000" } });
  assert.equal(wrongName.body.error, wrongPin.body.error);
  const early = await f.call("POST", "/api/people/sign-in/finish", { body: { ticket: started.body.ticket } });
  assert.match(early.body.error, /Not every check/);
  // Five wrong tries from one place and the page makes that place wait.
  for (let i = 0; i < 4; i++)
    await f.call("POST", "/api/people/sign-in/step", { body: { ticket: started.body.ticket, method: "pin", stage: "finish", pin: "0000" } });
  const waiting = await f.call("POST", "/api/people/sign-in/start", { body: { name: "Ada" } });
  assert.equal(waiting.status, 429);
  // The owner's own window is not held up by it.
  assert.equal((await f.owner("GET", "/api/people/settings")).status, 200);
});

test("B19-4 the owner can ask for more than one check; the chain is all of them", async (t) => {
  const f = await served(t);
  await f.owner("POST", "/api/people/settings", { chain: ["pin", "passkey"] });
  const started = await f.call("POST", "/api/people/sign-in/start", { body: { name: "Ada" } });
  assert.deepEqual(started.body.steps, ["pin", "passkey"]);
  const pin = await f.call("POST", "/api/people/sign-in/step", { body: { ticket: started.body.ticket, method: "pin", stage: "finish", pin: "1234" } });
  assert.deepEqual(pin.body.left, ["passkey"]);
  const early = await f.call("POST", "/api/people/sign-in/finish", { body: { ticket: started.body.ticket } });
  assert.equal(early.status, 400);
  // A check the chain does not name cannot stand in for one it does.
  const other = await f.call("POST", "/api/people/sign-in/step", { body: { ticket: started.body.ticket, method: "oidc", stage: "begin", provider: "x" } });
  assert.match(other.body.error, /not part of signing in/);
  // Extra checks for one person add to the chain, never take away — but they are asked for once a
  // first check has passed, not handed to anybody who types a name. The sign-in page answers before
  // any key, so steps that differ per person would say which names belong to somebody here
  // (mac7/channel-leaks).
  await f.owner("POST", "/api/people/settings", { chain: ["pin"], extra: { [f.bo.id]: ["passkey"] } });
  const bo = await f.call("POST", "/api/people/sign-in/start", { body: { name: "Bo" } });
  assert.deepEqual(bo.body.steps, ["pin"], "who is on this computer is not readable from the steps offered");
  const boPin = await f.call("POST", "/api/people/sign-in/step",
    { body: { ticket: bo.body.ticket, method: "pin", stage: "finish", pin: "5678" } });
  assert.deepEqual(boPin.body.left, ["passkey"], "Bo's extra check is asked for once the PIN has passed");
  assert.equal((await f.call("POST", "/api/people/sign-in/finish", { body: { ticket: bo.body.ticket } })).status, 400,
    "and it really has to be passed");
  assert.equal((await f.owner("POST", "/api/people/settings", { chain: [] })).status, 400, "the chain is never empty");
});

test("B19-5 people cannot read each other's conversations, and the owner's only when shared", async (t) => {
  const f = await served(t);
  const ada = await f.signIn("Ada", "1234"), bo = await f.signIn("Bo", "5678");
  const made = await f.call("POST", "/api/people/conversations", { key: ada, body: { prompt: "my secret plan" } });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  // The task writes down whose it was, so carrying it on after a restart is still Ada's.
  const started = f.app.store.events(made.body.runId).find((event) => event.kind === "run.started");
  assert.equal(started.data.personProfileId, f.ada.id);
  const { runOrigin } = await import("../dist/key-context.js");
  assert.equal(runOrigin(f.app.store, made.body.runId).personProfileId, f.ada.id);
  const mine = await f.call("GET", `/api/people/conversations/${made.body.sessionId}`, { key: ada });
  assert.equal(mine.body.access, "own");
  assert.ok(mine.body.messages.some((m) => m.content === "my secret plan"));
  assert.equal((await f.call("GET", `/api/people/conversations/${made.body.sessionId}`, { key: bo })).status, 404);
  assert.equal((await f.call("POST", `/api/people/conversations/${made.body.sessionId}/message`, { key: bo, body: { prompt: "hi" } })).status, 404);
  assert.deepEqual((await f.call("GET", "/api/people/conversations", { key: bo })).body.own.sessions, []);
  assert.equal((await f.call("GET", "/api/people/conversations", { key: ada })).body.own.sessions.length, 1);
  // While her task runs, her conversation is lent to the assistant and she can still read it.
  f.app.store.reassignSession(made.body.sessionId, f.app.runtime.owner);
  assert.equal((await f.call("GET", `/api/people/conversations/${made.body.sessionId}`, { key: ada })).status, 200);
  assert.equal((await f.call("GET", `/api/people/conversations/${made.body.sessionId}`, { key: bo })).status, 404);
  f.app.store.reassignSession(made.body.sessionId, `profile:${f.ada.id}`);
  // Ada carries on her own conversation; it stays hers.
  assert.equal((await f.call("POST", `/api/people/conversations/${made.body.sessionId}/message`, { key: ada, body: { prompt: "more" } })).status, 200);
  assert.ok(f.app.store.ownsSession(`profile:${f.ada.id}`, made.body.sessionId));
  // The owner's conversation is not found until shared.
  const owners = await f.app.runtime.run({ prompt: "owner only" });
  assert.equal((await f.call("GET", `/api/people/conversations/${owners.sessionId}`, { key: bo })).status, 404);
  const tuple = { object: `conversation:${owners.sessionId}`, relation: "viewer", subject: `profile:${f.bo.id}` };
  assert.equal((await f.owner("POST", "/api/people/shares", tuple)).status, 200);
  const read = await f.call("GET", `/api/people/conversations/${owners.sessionId}`, { key: bo });
  assert.equal(read.body.access, "viewer");
  const write = await f.call("POST", `/api/people/conversations/${owners.sessionId}/message`, { key: bo, body: { prompt: "hello" } });
  assert.equal(write.status, 403);
  assert.equal((await f.call("GET", `/api/people/conversations/${owners.sessionId}`, { key: ada })).status, 404, "shared with Bo, not Ada");
  // Nobody but the owner may share, and only the owner's own conversations.
  assert.equal((await f.call("POST", "/api/people/shares", { key: bo, body: tuple })).status, 401);
  const notOwners = await f.owner("POST", "/api/people/shares", { ...tuple, object: `conversation:${made.body.sessionId}` });
  assert.match(notOwners.body.error, /Only your own conversations/);
  await f.owner("POST", "/api/people/shares/remove", tuple);
  assert.equal((await f.call("GET", `/api/people/conversations/${owners.sessionId}`, { key: bo })).status, 404);
});

test("B19-6 a shared conversation can be joined: the person's words carry their name and their role still holds", async (t) => {
  const f = await served(t);
  const bo = await f.signIn("Bo", "5678");
  const owners = await f.app.runtime.run({ prompt: "plan the trip" });
  const group = await f.owner("POST", "/api/people/groups", { name: "Family", members: [f.bo.id], categories: ["read"] });
  const family = group.body.groups[0];
  await f.owner("POST", "/api/people/shares", { object: `conversation:${owners.sessionId}`, relation: "driver", subject: `group:${family.id}#member` });
  const joined = await f.call("POST", `/api/people/conversations/${owners.sessionId}/message`, { key: bo, body: { prompt: "add a museum" } });
  assert.equal(joined.status, 200, JSON.stringify(joined.body));
  assert.equal(joined.body.sessionId, owners.sessionId);
  assert.ok(f.app.store.messages(owners.sessionId).some((m) => m.role === "user" && m.content === "Bo: add a museum"));
  assert.ok(f.app.store.ownsSession(f.app.runtime.owner, owners.sessionId), "a shared conversation stays the owner's");
  // Being in the group narrowed what Bo's tasks may do, whatever the role says.
  const refusal = asPerson({ profileId: f.bo.id, keyId: "k" }, () => f.app.runtime.roleRefusal("files.write", "files.write"));
  assert.match(refusal ?? "", /does not cover/);
  assert.equal(asPerson({ profileId: f.bo.id, keyId: "k" }, () => f.app.runtime.roleRefusal("files.read", "files.read")), null);
  const listed = await f.call("GET", "/api/people/conversations", { key: bo });
  assert.deepEqual(listed.body.shared, [{ sessionId: owners.sessionId, relation: "driver" }]);
  // Removing the group takes the share with it.
  await f.owner("POST", `/api/people/groups/${family.id}/remove`, {});
  assert.equal((await f.call("GET", `/api/people/conversations/${owners.sessionId}`, { key: bo })).status, 404);
});

test("B19-7 roles only tighten: a group or any narrower can never give more than the person had", () => {
  const child = RoleGrantSchema.parse({ role: "child", projects: ["school"], dailySpendLimit: 2 });
  const widened = onlyTighter(child, { role: "owner", categories: ["read", "files", "settings"], projects: [], dailySpendLimit: 0 });
  assert.equal(widened.role, "child");
  assert.deepEqual(widened.categories, ["read"]);
  assert.deepEqual(widened.projects, ["school"]);
  assert.equal(widened.dailySpendLimit, 2);
  const elsewhere = onlyTighter(child, { ...child, projects: ["work"] });
  assert.deepEqual(elsewhere.categories, [], "no project in common allows nothing");
  const adult = RoleGrantSchema.parse({ role: "adult", dailySpendLimit: 0 });
  assert.equal(onlyTighter(adult, { ...adult, dailySpendLimit: 5 }).dailySpendLimit, 5);
});

test("B19-8 the owner's one-time code: a short set-up sign-in that can only set a PIN or a passkey", async (t) => {
  const f = await served(t);
  const old = await f.signIn("Ada", "1234");
  const code = await f.owner("POST", `/api/people/${f.ada.id}/reset-code`, {});
  assert.match(code.body.code, /^[A-Z0-9]{8}$/);
  assert.equal((await f.call("POST", "/api/people/sign-in/code", { body: { name: "Ada", code: "WRONG123" } })).status, 400);
  const setup = await f.call("POST", "/api/people/sign-in/code", { body: { name: "Ada", code: code.body.code } });
  assert.equal(setup.body.setupOnly, true);
  assert.equal((await f.call("GET", "/api/people/me", { key: old })).status, 401, "every earlier sign-in ended");
  assert.equal((await f.call("GET", "/api/people/conversations", { key: setup.body.key })).status, 401);
  assert.equal((await f.call("POST", "/api/people/me/pin", { key: setup.body.key, body: { pin: "4321" } })).status, 200);
  assert.equal((await f.call("POST", "/api/people/sign-in/code", { body: { name: "Ada", code: code.body.code } })).status, 400, "the code works once");
  await f.signIn("Ada", "4321");
  // An ordinary sign-in must say the old PIN to change it.
  const ordinary = await f.signIn("Ada", "4321");
  assert.equal((await f.call("POST", "/api/people/me/pin", { key: ordinary, body: { pin: "1111" } })).status, 400);
  assert.equal((await f.call("POST", "/api/people/me/pin", { key: ordinary, body: { current: "4321", pin: "1111" } })).status, 200);
});

test("B19-9 signing out, the owner signing somebody out, and removing a profile all end the key", async (t) => {
  const f = await served(t);
  const one = await f.signIn("Ada", "1234"), two = await f.signIn("Ada", "1234");
  assert.equal((await f.call("POST", "/api/people/me/sign-out", { key: one, body: {} })).status, 200);
  assert.equal((await f.call("GET", "/api/people/me", { key: one })).status, 401);
  assert.equal((await f.call("GET", "/api/people/me", { key: two })).status, 200);
  await f.owner("POST", `/api/people/${f.ada.id}/sign-out`, {});
  assert.equal((await f.call("GET", "/api/people/me", { key: two })).status, 401);
  const three = await f.signIn("Bo", "5678");
  assert.equal((await f.owner("POST", `/api/profiles/${f.bo.id}/remove`, {})).status, 200);
  assert.equal((await f.call("GET", "/api/people/me", { key: three })).status, 401);
  // A short-lived script key and a switched-over window cannot manage people either.
  const script = f.app.sessionTokens.create(f.app.runtime.owner, { scope: "run", minutes: 5 }).token;
  assert.equal((await f.call("GET", "/api/people/settings", { key: script })).status, 401);
  assert.equal((await f.call("POST", `/api/people/${f.ada.id}/reset-code`, { key: script, body: {} })).status, 401);
  f.app.store.profiles.switch({ profileId: f.ada.id, pin: "1234" });
  assert.equal((await f.owner("GET", "/api/people/settings")).status, 400);
  f.app.store.profiles.switch({ profileId: null });
});

test("B19-10 while a request is a person's, the profile switch answers for them and never for the owner", async (t) => {
  const f = await served(t, { on: false });
  const mark = { profileId: f.ada.id, keyId: "k" };
  assert.equal(asPerson(mark, () => f.app.store.profiles.scope()), `profile:${f.ada.id}`);
  assert.equal(asPerson(mark, () => f.app.store.profiles.isOwner()), false);
  assert.throws(() => asPerson(mark, () => f.app.store.profiles.requireOwner("Secrets")), /belongs to the owner/);
  assert.throws(() => asPerson(mark, () => f.app.store.profiles.switch({ profileId: null })), /done at the computer/);
  f.app.store.profiles.remove(f.ada.id);
  assert.throws(() => asPerson(mark, () => f.app.store.profiles.active()), /no longer on this computer/);
  assert.equal(f.app.store.profiles.isOwner(), true);
});

test("B19-11 a key handed to another device reaches that one conversation and nothing else", async (t) => {
  const f = await served(t, { on: false });
  const mine = await f.app.runtime.run({ prompt: "carry this on" });
  const other = await f.app.runtime.run({ prompt: "private" });
  const key = f.app.sessionTokens.create(f.app.runtime.owner, { scope: "run", minutes: 5, sessionId: mine.sessionId }).token;
  assert.equal((await f.call("GET", `/api/sessions/${mine.sessionId}`, { key })).status, 200);
  assert.equal((await f.call("GET", `/api/runs/${mine.id}`, { key })).status, 200);
  for (const path of [`/api/sessions/${other.sessionId}`, `/api/runs/${other.id}`, "/api/sessions", "/api/audit", "/api/memory/facts"])
    assert.equal((await f.call("GET", path, { key })).status, 401, path);
  const view = await f.call("GET", "/api/people/handoff", { key });
  assert.equal(view.body.sessionId, mine.sessionId);
  assert.ok(view.body.messages.some((m) => m.content === "carry this on"));
  assert.equal((await f.call("POST", "/api/run", { key, body: { prompt: "sneak", sessionId: other.sessionId } })).status, 400);
  assert.equal((await f.call("POST", "/api/run", { key, body: { prompt: "sneak" } })).status, 400, "a new conversation is somewhere else too");
  assert.equal((await f.call("POST", "/api/run", { key, body: { prompt: "go on", sessionId: mine.sessionId } })).status, 200);
  assert.equal((await f.call("POST", `/api/sessions/${other.sessionId}/followups`, { key, body: { prompt: "x" } })).status, 401);
  // An ordinary run key is not held, and cannot read the handover view.
  // The owner's rule (ships on, 2026-09-26): handing on ships off; it is switched off explicitly for "both off".
  f.app.store.save("settings", f.app.runtime.owner, "interop-handoff", { mode: "off" });
  assert.equal((await fetch(`${f.server.url}/people`)).status, 404, "with both switches off");
  f.app.store.save("settings", f.app.runtime.owner, "interop-handoff", { mode: "on" });
  assert.equal((await fetch(`${f.server.url}/people`)).status, 200, "handing a conversation over serves the page");
  const free = f.app.sessionTokens.create(f.app.runtime.owner, { scope: "run", minutes: 5 }).token;
  assert.equal((await f.call("GET", `/api/sessions/${other.sessionId}`, { key: free })).status, 200);
  assert.equal((await f.call("GET", "/api/people/handoff", { key: free })).status, 404);
});

test("B19-12 a short-lived key answers only the questions of tasks it started itself", () => {
  const events = {
    ownerTask: [{ kind: "run.started", data: { source: "owner" } }],
    keyTask: [{ kind: "run.started", data: { source: "owner", shortLivedKey: true, shortLivedKeyId: "key-a" } }],
    child: [{ kind: "run.started", data: { source: "owner", parentRunId: "keyTask" } }],
    oldKeyTask: [{ kind: "run.started", data: { source: "owner", shortLivedKey: true } }],
  };
  const store = { events: (id) => events[id] ?? [] };
  assert.equal(keyAnswerRefusal(store, "ownerTask"), null, "the owner's window is not asked");
  assert.equal(underShortLivedKey(() => keyAnswerRefusal(store, "keyTask"), { keyId: "key-a" }), null);
  assert.equal(underShortLivedKey(() => keyAnswerRefusal(store, "child"), { keyId: "key-a" }), null, "its specialist's question too");
  assert.match(underShortLivedKey(() => keyAnswerRefusal(store, "keyTask"), { keyId: "key-b" }), /tasks it started itself/);
  assert.match(underShortLivedKey(() => keyAnswerRefusal(store, "ownerTask"), { keyId: "key-a" }), /tasks it started itself/);
  assert.match(underShortLivedKey(() => keyAnswerRefusal(store, "oldKeyTask"), { keyId: "key-a" }), /tasks it started itself/);
});

test("B19-13 a task started with a short-lived key writes down which key it was", async (t) => {
  const f = await served(t, { on: false });
  const key = f.app.sessionTokens.create(f.app.runtime.owner, { scope: "run", minutes: 5 });
  const run = await f.call("POST", "/api/run", { key: key.token, body: { prompt: "hello" } });
  const started = f.app.store.events(run.body.id).find((event) => event.kind === "run.started");
  assert.equal(started.data.shortLivedKeyId, key.entry.id);
  // Somebody switched in at the window cannot queue a message onto the owner's conversation.
  f.app.store.profiles.switch({ profileId: f.ada.id, pin: "1234" });
  assert.equal((await f.owner("POST", `/api/sessions/${run.body.sessionId}/followups`, { prompt: "x" })).status, 404);
  f.app.store.profiles.switch({ profileId: null });
});

test("B19-14 the address lists fail closed", () => {
  assert.equal(personDoorRefusal("GET", "/api/people/me", false), null);
  assert.ok(personDoorRefusal("GET", "/api/people/settings", false));
  assert.ok(personDoorRefusal("GET", "/api/people/conversations", true), "a set-up key has no conversations");
  assert.equal(personDoorRefusal("POST", "/api/people/me/passkeys/begin", true), null);
  assert.ok(personDoorRefusal("POST", "/api/some-new-route", false));
  const sid = "0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f";
  assert.ok(boundDoorRefusal(sid, "GET", "/api/some-new-view", () => null));
  assert.ok(boundDoorRefusal(sid, "GET", `/api/sessions/${sid}/tree`, () => null), "only the listed parts of the conversation");
  assert.equal(boundDoorRefusal(sid, "GET", `/api/sessions/${sid}`, () => null), null);
});

/* ---------- passkeys ---------- */

function cbor(value) {
  const head = (major, n) => n < 24 ? Buffer.from([(major << 5) | n])
    : n < 256 ? Buffer.from([(major << 5) | 24, n]) : Buffer.from([(major << 5) | 25, n >> 8, n & 255]);
  if (typeof value === "number") return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (typeof value === "string") return Buffer.concat([head(3, Buffer.byteLength(value)), Buffer.from(value)]);
  if (Buffer.isBuffer(value)) return Buffer.concat([head(2, value.length), value]);
  if (value instanceof Map) return Buffer.concat([head(5, value.size), ...[...value].flatMap(([k, v]) => [cbor(k), cbor(v)])]);
  throw new Error("unsupported");
}
const b64 = (buffer) => Buffer.from(buffer).toString("base64url");
const sha = (data) => createHash("sha256").update(data).digest();

function authenticator(rpId, origin) {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const id = Buffer.from("credential-id-0001-abcdef");
  let count = 0;
  const authData = (flags, extra = Buffer.alloc(0)) => {
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(count);
    return Buffer.concat([sha(rpId), Buffer.from([flags]), counter, extra]);
  };
  return {
    id: b64(id),
    create(challenge, from = origin, flags) {
      const cose = new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, "base64url")], [-3, Buffer.from(jwk.y, "base64url")]]);
      const idLength = Buffer.alloc(2);
      idLength.writeUInt16BE(id.length);
      const attested = Buffer.concat([Buffer.alloc(16), idLength, id, cbor(cose)]);
      const attestationObject = cbor(new Map([["fmt", "none"], ["attStmt", new Map()], ["authData", authData(flags ?? 0x45, attested)]]));
      const clientDataJSON = Buffer.from(JSON.stringify({ type: "webauthn.create", challenge, origin: from }));
      return { id: b64(id), clientDataJSON: b64(clientDataJSON), attestationObject: b64(attestationObject) };
    },
    get(challenge, { from = origin, bump = 1, flags = 0x05 } = {}) {
      count += bump;
      const data = authData(flags);
      const clientDataJSON = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge, origin: from }));
      const signature = signData("sha256", Buffer.concat([data, sha(clientDataJSON)]), privateKey);
      return { id: b64(id), clientDataJSON: b64(clientDataJSON), authenticatorData: b64(data), signature: b64(signature) };
    },
  };
}

test("B19-15 passkeys: a registration and a signature are checked, and a copied passkey is caught", () => {
  const where = { origin: "http://localhost:3210", rpId: "localhost" };
  const device = authenticator("localhost", where.origin);
  const challenge = b64(Buffer.from("registration-challenge-0123456789"));
  const stored = verifyRegistration(device.create(challenge), { ...where, challenge });
  assert.equal(stored.alg, -7);
  assert.throws(() => verifyRegistration(device.create(challenge, "http://evil.example"), { ...where, challenge }), /different page/);
  assert.throws(() => verifyRegistration(device.create(challenge), { ...where, challenge: b64(Buffer.from("other")) }), /different sign-in/);
  assert.throws(() => verifyRegistration(device.create(challenge), { ...where, rpId: "example.com", challenge }), /different address/);
  const signIn = b64(Buffer.from("sign-in-challenge-0123456789abcd"));
  const count = verifyAssertion(device.get(signIn), stored, { ...where, challenge: signIn });
  assert.equal(count, 1);
  assert.throws(() => verifyAssertion(device.get(signIn, { bump: 0 }), { ...stored, signCount: count }, { ...where, challenge: signIn }), /copied/);
  const forged = { ...device.get(signIn), signature: b64(Buffer.alloc(70, 1)) };
  assert.throws(() => verifyAssertion(forged, { ...stored, signCount: 5 }, { ...where, challenge: signIn }));
  assert.throws(() => decodeCbor(Buffer.from([0x5f])), /CBOR form/);
});

test("B19-16 passkeys over the page: register while signed in, then sign in with it alone", async (t) => {
  const f = await served(t);
  const host = new URL(f.server.url).host;
  const origin = `http://${host}`, rpId = new URL(origin).hostname;
  const device = authenticator(rpId, origin);
  const key = await f.signIn("Ada", "1234");
  const begun = await f.call("POST", "/api/people/me/passkeys/begin", { key, body: {} });
  assert.equal(begun.body.rp.id, rpId);
  const added = await f.call("POST", "/api/people/me/passkeys/finish", { key, body: { name: "My phone", credential: device.create(begun.body.challenge) } });
  assert.equal(added.status, 200, JSON.stringify(added.body));
  assert.equal(added.body.passkeys[0].name, "My phone");
  await f.owner("POST", "/api/people/settings", { chain: ["passkey"] });
  const started = await f.call("POST", "/api/people/sign-in/start", { body: { name: "Ada" } });
  const options = await f.call("POST", "/api/people/sign-in/step", { body: { ticket: started.body.ticket, method: "passkey", stage: "begin" } });
  assert.deepEqual(options.body.result.allowCredentials, [device.id]);
  const done = await f.call("POST", "/api/people/sign-in/step", { body: { ticket: started.body.ticket, method: "passkey", stage: "finish",
    credential: device.get(options.body.result.challenge) } });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  const signedIn = await f.call("POST", "/api/people/sign-in/finish", { body: { ticket: started.body.ticket } });
  assert.match(signedIn.body.key, /^branch_person_/);
  // Bo cannot sign in as Ada with Ada's passkey, and cannot use it for himself.
  const bo = await f.call("POST", "/api/people/sign-in/start", { body: { name: "Bo" } });
  const boOptions = await f.call("POST", "/api/people/sign-in/step", { body: { ticket: bo.body.ticket, method: "passkey", stage: "begin" } });
  assert.equal(boOptions.body.result.allowCredentials.length, 1, "somebody with no passkey looks like somebody with one");
  const nobody = await f.call("POST", "/api/people/sign-in/start", { body: { name: "Zed" } });
  const nobodyOptions = await f.call("POST", "/api/people/sign-in/step", { body: { ticket: nobody.body.ticket, method: "passkey", stage: "begin" } });
  assert.equal(nobodyOptions.body.result.allowCredentials.length, 1, "and so does a name nobody here has");
  const stolen = await f.call("POST", "/api/people/sign-in/step", { body: { ticket: bo.body.ticket, method: "passkey", stage: "finish",
    credential: device.get(boOptions.body.result.challenge) } });
  assert.equal(stolen.status, 400);
});

/* ---------- identity services ---------- */

function issuerKit(issuer = "https://id.example.com", clientId = "branch-app") {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" };
  const token = (claims, header = { alg: "RS256", kid: "k1" }) => {
    const body = `${b64(JSON.stringify(header))}.${b64(JSON.stringify(claims))}`;
    const signer = createSign("RSA-SHA256");
    signer.update(body);
    return `${body}.${b64(signer.sign(privateKey))}`;
  };
  const now = Math.floor(Date.now() / 1000);
  const claims = (extra = {}) => ({ iss: issuer, aud: clientId, sub: "user-42", exp: now + 300, iat: now, nonce: "n1",
    email: "ada@example.com", email_verified: true, ...extra });
  return { issuer, clientId, jwk, token, claims };
}

test("B19-17 an identity service's answer is checked: signature, issuer, audience, expiry and nonce", () => {
  const kit = issuerKit();
  const expected = { issuer: kit.issuer, clientId: kit.clientId, nonce: "n1" };
  assert.equal(verifyIdToken(kit.token(kit.claims()), [kit.jwk], expected).subject, "user-42");
  assert.throws(() => verifyIdToken(kit.token(kit.claims({ aud: "someone-else" })), [kit.jwk], expected), /different app/);
  assert.throws(() => verifyIdToken(kit.token(kit.claims({ nonce: "n2" })), [kit.jwk], expected), /different sign-in/);
  assert.throws(() => verifyIdToken(kit.token(kit.claims({ exp: 1000 })), [kit.jwk], expected), /run out/);
  assert.throws(() => verifyIdToken(kit.token(kit.claims({ iss: "https://evil.example" })), [kit.jwk], expected), /different identity service/);
  const unsigned = `${b64(JSON.stringify({ alg: "none" }))}.${b64(JSON.stringify(kit.claims()))}.`;
  assert.throws(() => verifyIdToken(unsigned, [kit.jwk], expected));
  const other = issuerKit();
  assert.throws(() => verifyIdToken(other.token(other.claims()), [kit.jwk], expected), /not signed by it/);
  const identity = verifyIdToken(kit.token(kit.claims()), [kit.jwk], expected);
  const link = { provider: "family", profileId: "0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f", email: "ada@example.com" };
  // Integration review: only the subject id signs somebody in; a verified email only suggests the account.
  assert.equal(linkedTo([link], "family", link.profileId, identity), false, "an email alone never signs anybody in");
  assert.equal(emailSuggests([link], "family", link.profileId, identity), true);
  assert.equal(emailSuggests([link], "family", link.profileId, { ...identity, emailVerified: false }), false, "an unverified email is not even a suggestion");
  assert.equal(linkedTo([{ ...link, subject: "user-42" }], "family", link.profileId, identity), true);
  assert.equal(linkedTo([{ ...link, subject: "user-42" }], "other", link.profileId, identity), false);
  assert.equal(linkedTo([{ ...link, subject: "user-7" }], "family", link.profileId, identity), false, "a linked subject wins over the email");
});

test("B19-18 signing in through an identity service, end to end with a stand-in service", async () => {
  const kit = issuerKit();
  const provider = { id: "family", label: "Family", issuer: kit.issuer, clientId: kit.clientId, scopes: ["openid", "email"] };
  const profileId = "0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f";
  let settings = { mode: "on", chain: ["oidc"], extra: {}, sessionMinutes: 60, providers: [provider],
    links: [{ provider: "family", profileId, subject: "user-42" }] };
  let nonce = "", sentVerifier = "";
  const fetcher = async (url, init) => {
    const at = String(url);
    const json = (value) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
    if (at.endsWith("/.well-known/openid-configuration"))
      return json({ issuer: kit.issuer, authorization_endpoint: `${kit.issuer}/authorize`, token_endpoint: `${kit.issuer}/token`, jwks_uri: `${kit.issuer}/jwks` });
    if (at.endsWith("/jwks")) return json({ keys: [kit.jwk] });
    if (at.endsWith("/token")) {
      const form = new URLSearchParams(String(init.body));
      sentVerifier = form.get("code_verifier");
      assert.equal(form.get("code"), "the-code");
      return json({ id_token: kit.token(kit.claims({ nonce })) });
    }
    return new Response("no", { status: 404 });
  };
  const profiles = { byName: (name) => (name === "Ada" ? { id: profileId, name: "Ada" } : null), verifyPin: () => { throw new Error("no"); } };
  const signIns = new SignIns({ profiles, passkeys: { of: () => [] }, settings: () => settings, fetch: fetcher, secret: async () => undefined });
  const where = { origin: "http://localhost:3210", rpId: "localhost", redirectUri: "http://localhost:3210/api/people/oidc/callback" };
  const { ticket } = signIns.start("Ada", "test");
  const begun = await signIns.step(ticket, "oidc", "begin", { provider: "family" }, where);
  const address = new URL(begun.result.url);
  assert.equal(address.searchParams.get("code_challenge_method"), "S256");
  assert.equal(address.searchParams.get("redirect_uri"), where.redirectUri);
  nonce = address.searchParams.get("nonce");
  const state = address.searchParams.get("state");
  await signIns.step(ticket, "oidc", "finish", { code: "the-code", state }, where);
  assert.equal(createHash("sha256").update(sentVerifier).digest("base64url"), address.searchParams.get("code_challenge"));
  assert.equal(signIns.complete(ticket).profileId, profileId);
  // Somebody whose account is not linked to Ada does not get in as Ada.
  settings = { ...settings, links: [{ provider: "family", profileId, subject: "someone-else" }] };
  const second = signIns.start("Ada", "test");
  const again = await signIns.step(second.ticket, "oidc", "begin", { provider: "family" }, where);
  nonce = new URL(again.result.url).searchParams.get("nonce");
  await assert.rejects(signIns.step(second.ticket, "oidc", "finish", { code: "the-code", state: new URL(again.result.url).searchParams.get("state") }, where), /not linked/);
  // A discovery document naming another issuer is refused.
  const liar = async (url) => String(url).includes("openid-configuration")
    ? new Response(JSON.stringify({ issuer: "https://evil.example", authorization_endpoint: "https://evil.example/a", token_endpoint: "https://evil.example/t", jwks_uri: "https://evil.example/j" }))
    : new Response("{}");
  const fooled = new SignIns({ profiles, passkeys: { of: () => [] }, settings: () => settings, fetch: liar, secret: async () => undefined });
  const third = fooled.start("Ada", "test");
  await assert.rejects(fooled.step(third.ticket, "oidc", "begin", { provider: "family" }, where), /different issuer/);
  assert.ok(authorizationUrl(provider, { authorization_endpoint: `${kit.issuer}/authorize` }, where.redirectUri).url.includes("scope=openid+email"));
});

test("B19-19 the sign-in page refuses a request from another site", async (t) => {
  const f = await served(t);
  const cross = await f.call("POST", "/api/people/sign-in/start", { body: { name: "Ada" }, headers: { origin: "http://evil.example" } });
  assert.equal(cross.status, 403);
  const page = await fetch(`${f.server.url}/people`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Sign in to Branch/);
  const callback = await f.call("GET", "/api/people/oidc/callback?state=nothing");
  assert.equal(callback.status, 302);
  assert.equal(callback.headers.get("location"), "/people#error=signin");
  const passed = await f.call("GET", "/api/people/oidc/callback?state=s1&code=c%261");
  assert.equal(passed.headers.get("location"), "/people#oidc=c%261&state=s1", "the answer is only passed on to the page");
});

/* ---------- integration review (adversarial pass) ---------- */

import { request as httpRequest, createServer as createHttpServer } from "node:http";
import { coseToJwk } from "../dist/people/webauthn.js";
import { runOrigin } from "../dist/key-context.js";
import { recoverAfterRestart } from "../dist/never-break/resume.js";
import { journalHook } from "../dist/never-break/journal.js";
import { saveGatewayConfig, GatewayConfigSchema } from "../dist/never-break/gateway-config.js";
import { collectSnapshot, securityChecks } from "../dist/security-audit/index.js";
import { readFile } from "node:fs/promises";

/** A stand-in identity service on the served app, reached instead of the network. */
function standInService(f, kit, provider) {
  const seen = { nonce: "" };
  f.app.people.signIns.host.fetch = async (url, init) => {
    const at = String(url);
    const json = (value) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
    if (at.endsWith("/.well-known/openid-configuration"))
      return json({ issuer: kit.issuer, authorization_endpoint: `${kit.issuer}/authorize`, token_endpoint: `${kit.issuer}/token`, jwks_uri: `${kit.issuer}/jwks` });
    if (at.endsWith("/jwks")) return json({ keys: [kit.jwk] });
    if (at.endsWith("/token")) return json({ id_token: kit.token(kit.claims({ nonce: seen.nonce, ...(seen.claims ?? {}) })) });
    return new Response("no", { status: 404 });
  };
  const begin = async () => {
    const started = await f.call("POST", "/api/people/sign-in/start", { body: { name: "Ada" } });
    const begun = await f.call("POST", "/api/people/sign-in/step", { body: { ticket: started.body.ticket, method: "oidc", stage: "begin", provider: provider.id } });
    assert.equal(begun.status, 200, JSON.stringify(begun.body));
    const address = new URL(begun.body.result.url);
    seen.nonce = address.searchParams.get("nonce");
    return { ticket: started.body.ticket, state: address.searchParams.get("state"), address };
  };
  return { seen, begin };
}
const familyProvider = (kit) => ({ id: "family", label: "Family", issuer: kit.issuer, clientId: kit.clientId, scopes: ["openid", "email"] });

test("B19-20 an identity service's answer landing in somebody else's browser finishes nobody's sign-in", async (t) => {
  const f = await served(t);
  const kit = issuerKit(), provider = familyProvider(kit);
  await f.owner("POST", "/api/people/settings", { chain: ["oidc"], providers: [provider], links: [{ provider: "family", profileId: f.ada.id, subject: "user-42" }] });
  const service = standInService(f, kit, provider);
  // An attacker starts Ada's sign-in and sends Ada the service's address; Ada signs in there.
  const held = await service.begin();
  assert.equal(held.address.searchParams.get("redirect_uri"), `${f.server.url}/api/people/oidc/callback`);
  const back = await f.call("GET", `/api/people/oidc/callback?state=${held.state}&code=the-code`);
  assert.equal(back.status, 302);
  assert.doesNotMatch(back.headers.get("location"), /ticket/, "the way back names no sign-in");
  const stolen = await f.call("POST", "/api/people/sign-in/finish", { body: { ticket: held.ticket } });
  assert.equal(stolen.status, 400, "the attacker's ticket did not pass the check");
  assert.equal(stolen.body.key, undefined);
  // The page that started a sign-in finishes it with the answer and that sign-in's own state.
  const mine = await service.begin();
  const wrongState = await f.call("POST", "/api/people/sign-in/step", { body: { ticket: mine.ticket, method: "oidc", stage: "finish", code: "the-code", state: held.state } });
  assert.equal(wrongState.status, 400, "another sign-in's state is refused");
  const again = await service.begin();
  const passed = await f.call("POST", "/api/people/sign-in/step", { body: { ticket: again.ticket, method: "oidc", stage: "finish", code: "the-code", state: again.state } });
  assert.equal(passed.status, 200, JSON.stringify(passed.body));
  const done = await f.call("POST", "/api/people/sign-in/finish", { body: { ticket: again.ticket } });
  assert.match(done.body.key, /^branch_person_/);
});

test("B19-21 an email address only suggests an account; the owner confirms it once by its id", async (t) => {
  const f = await served(t);
  const kit = issuerKit(), provider = familyProvider(kit);
  await f.owner("POST", "/api/people/settings", { chain: ["oidc"], providers: [provider], links: [{ provider: "family", profileId: f.ada.id, email: "ada@example.com" }] });
  const service = standInService(f, kit, provider);
  const first = await service.begin();
  const refused = await f.call("POST", "/api/people/sign-in/step", { body: { ticket: first.ticket, method: "oidc", stage: "finish", code: "c", state: first.state } });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /owner has to confirm/);
  const card = await f.owner("GET", "/api/people/settings");
  assert.deepEqual(card.body.waiting.map((w) => [w.profileId, w.subject, w.email]), [[f.ada.id, "user-42", "ada@example.com"]]);
  // Nobody else can confirm it, and a subject that did not sign in cannot be slipped in.
  const script = f.app.sessionTokens.create(f.app.runtime.owner, { scope: "run", minutes: 5 }).token;
  assert.equal((await f.call("POST", "/api/people/links/confirm", { key: script, body: { provider: "family", profileId: f.ada.id, subject: "user-42" } })).status, 401);
  assert.equal((await f.owner("POST", "/api/people/links/confirm", { provider: "family", profileId: f.ada.id, subject: "attacker" })).status, 400);
  assert.equal((await f.owner("POST", "/api/people/links/confirm", { provider: "family", profileId: f.ada.id, subject: "user-42" })).status, 200);
  const next = await service.begin();
  const passed = await f.call("POST", "/api/people/sign-in/step", { body: { ticket: next.ticket, method: "oidc", stage: "finish", code: "c", state: next.state } });
  assert.equal(passed.status, 200, JSON.stringify(passed.body));
  // An account with the same verified email but another id is still not Ada.
  service.seen.claims = { sub: "someone-else" };
  const other = await service.begin();
  assert.equal((await f.call("POST", "/api/people/sign-in/step", { body: { ticket: other.ticket, method: "oidc", stage: "finish", code: "c", state: other.state } })).status, 400);
  // Discovery and the exchange go through the owner's network rules: a private address is refused.
  await assert.rejects(f.app.people.parts.fetch("https://127.0.0.1/.well-known/openid-configuration"));
});

test("B19-22 the ID token: a different authorised party, or no issue time, is refused", () => {
  const kit = issuerKit();
  const expected = { issuer: kit.issuer, clientId: kit.clientId, nonce: "n1" };
  assert.throws(() => verifyIdToken(kit.token(kit.claims({ azp: "another-app" })), [kit.jwk], expected), /different app/);
  assert.equal(verifyIdToken(kit.token(kit.claims({ azp: kit.clientId })), [kit.jwk], expected).subject, "user-42");
  assert.throws(() => verifyIdToken(kit.token(kit.claims({ iat: undefined })), [kit.jwk], expected));
  assert.throws(() => verifyIdToken(kit.token(kit.claims(), { alg: "HS256", kid: "k1" }), [kit.jwk], expected), "only RS256 and ES256");
  assert.throws(() => verifyIdToken(kit.token(kit.claims(), { alg: "RS256", kid: "other" }), [kit.jwk], expected), /did not publish/);
});

test("B19-23 passkeys: the device must check who holds it, a challenge lasts two minutes, and a short RSA key is refused", async (t) => {
  const f = await served(t);
  const host = new URL(f.server.url).host;
  const origin = `http://${host}`, rpId = new URL(origin).hostname;
  const device = authenticator(rpId, origin);
  const key = await f.signIn("Ada", "1234");
  const begun = await f.call("POST", "/api/people/me/passkeys/begin", { key, body: {} });
  assert.equal(begun.body.authenticatorSelection.userVerification, "required");
  const unverified = await f.call("POST", "/api/people/me/passkeys/finish", { key, body: { credential: device.create(begun.body.challenge, origin, 0x41) } });
  assert.equal(unverified.status, 400, "registered without the device checking who you are");
  assert.match(unverified.body.error, /checking who you are/);
  const again = await f.call("POST", "/api/people/me/passkeys/begin", { key, body: {} });
  assert.equal((await f.call("POST", "/api/people/me/passkeys/finish", { key, body: { credential: device.create(again.body.challenge) } })).status, 200);
  await f.owner("POST", "/api/people/settings", { chain: ["passkey"] });
  const started = await f.call("POST", "/api/people/sign-in/start", { body: { name: "Ada" } });
  const options = await f.call("POST", "/api/people/sign-in/step", { body: { ticket: started.body.ticket, method: "passkey", stage: "begin" } });
  assert.equal(options.body.result.userVerification, "required");
  const presenceOnly = await f.call("POST", "/api/people/sign-in/step", { body: { ticket: started.body.ticket, method: "passkey", stage: "finish",
    credential: device.get(options.body.result.challenge, { flags: 0x01 }) } });
  assert.equal(presenceOnly.status, 400, "touching the key is not enough");
  // A challenge is good once, and for two minutes only.
  const late = await f.call("POST", "/api/people/sign-in/step", { body: { ticket: started.body.ticket, method: "passkey", stage: "begin" } });
  const realNow = Date.now;
  Date.now = () => realNow() + 121_000;
  try {
    const expired = await f.call("POST", "/api/people/sign-in/step", { body: { ticket: started.body.ticket, method: "passkey", stage: "finish",
      credential: device.get(late.body.result.challenge) } });
    assert.equal(expired.status, 400);
  } finally { Date.now = realNow; }
  const fresh = await f.call("POST", "/api/people/sign-in/step", { body: { ticket: started.body.ticket, method: "passkey", stage: "begin" } });
  const answer = device.get(fresh.body.result.challenge);
  assert.equal((await f.call("POST", "/api/people/sign-in/step", { body: { ticket: started.body.ticket, method: "passkey", stage: "finish", credential: answer } })).status, 200);
  const replayed = await f.call("POST", "/api/people/sign-in/step", { body: { ticket: started.body.ticket, method: "passkey", stage: "finish", credential: answer } });
  assert.equal(replayed.status, 400, "the same answer twice");
  // Keys: nothing but ES256 on P-256 and RS256 of 2048 bits or more.
  const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 1024 });
  const short = publicKey.export({ format: "jwk" });
  assert.throws(() => coseToJwk(new Map([[1, 3], [3, -257], [-1, Buffer.from(short.n, "base64url")], [-2, Buffer.from(short.e, "base64url")]])), /too short/);
  assert.throws(() => coseToJwk(new Map([[1, 2], [3, -8], [-1, 6]])), /Only ES256 and RS256/);
  assert.throws(() => coseToJwk(new Map([[1, 2], [3, -7], [-1, 2], [-2, Buffer.alloc(48)], [-3, Buffer.alloc(48)]])), /Only ES256 and RS256/, "P-384 under ES256's number");
});

test("B19-24 a PIN is scrypt-hashed, and its lockout is per person: a new ticket or another place does not reset it", async (t) => {
  const f = await served(t);
  const row = f.app.store.sqlite.prepare("SELECT pin_hash FROM household_profiles WHERE id=?").get(f.ada.id);
  assert.notDeepEqual(Buffer.from(row.pin_hash), createHash("sha256").update("1234").digest(), "not a plain hash");
  assert.equal(Buffer.from(row.pin_hash).length, 32);
  // Straight at the sign-in chain, as if each try came from a different address with a fresh ticket.
  const signIns = f.app.people.signIns;
  const where = { origin: "http://localhost", rpId: "localhost", redirectUri: "http://localhost/cb" };
  for (let i = 0; i < 5; i++) {
    const { ticket } = signIns.start("Ada", `place ${i}`);
    await assert.rejects(signIns.step(ticket, "pin", "finish", { pin: "0000" }, where));
  }
  const { ticket } = signIns.start("Ada", "another place");
  await assert.rejects(signIns.step(ticket, "pin", "finish", { pin: "1234" }, where), /Too many wrong PINs/, "the right PIN waits too");
  // Bo signing in correctly from the same place does not clear Ada's count.
  await f.signIn("Bo", "5678");
  const later = signIns.start("Ada", "x");
  await assert.rejects(signIns.step(later.ticket, "pin", "finish", { pin: "1234" }, where), /Too many wrong PINs/);
});

test("B19-25 a one-time code lasts fifteen minutes, works once, and is kept only as a hash", async (t) => {
  const f = await served(t);
  const codes = f.app.people.resetCodes;
  const issued = codes.issue(f.ada.id);
  assert.ok(Math.abs(Date.parse(issued.expiresAt) - Date.now() - 15 * 60_000) < 5000);
  assert.ok(!JSON.stringify([...codes.pending.values()].map((p) => ({ ...p, hash: p.hash.toString("hex") }))).includes(issued.code));
  const realNow = codes.now;
  codes.now = () => realNow() + 15 * 60_000 + 1000;
  assert.throws(() => codes.redeem(f.ada.id, issued.code), /run out/);
  codes.now = realNow;
  const fresh = codes.issue(f.ada.id);
  codes.redeem(f.ada.id, fresh.code);
  assert.throws(() => codes.redeem(f.ada.id, fresh.code), /run out/);
  // Five wrong codes close it.
  const third = codes.issue(f.ada.id);
  for (let i = 0; i < 5; i++) assert.throws(() => codes.redeem(f.ada.id, "WRONG000"));
  assert.throws(() => codes.redeem(f.ada.id, third.code));
});

test("B19-26 a person's own conversation lent to the assistant is never the owner's to share, nor another person's to read", async (t) => {
  const f = await served(t);
  const ada = await f.signIn("Ada", "1234"), bo = await f.signIn("Bo", "5678");
  const made = await f.call("POST", "/api/people/conversations", { key: ada, body: { prompt: "my diary" } });
  assert.equal(runOrigin(f.app.store, made.body.runId).lentTo, `profile:${f.ada.id}`);
  // As while her next task is running:
  f.app.store.reassignSession(made.body.sessionId, f.app.runtime.owner);
  const tuple = { object: `conversation:${made.body.sessionId}`, relation: "driver", subject: `profile:${f.bo.id}` };
  const shared = await f.owner("POST", "/api/people/shares", tuple);
  assert.equal(shared.status, 400, "the owner cannot share it in that moment");
  assert.equal((await f.owner("POST", "/api/people/shares/import", { tuples: [{ user: tuple.subject, relation: "driver", object: tuple.object }] })).status, 400);
  // Even a share written some other way does not open it.
  f.app.store.save("settings", f.app.runtime.owner, "people-shares", { tuples: [tuple] });
  assert.equal((await f.call("GET", `/api/people/conversations/${made.body.sessionId}`, { key: bo })).status, 404);
  assert.equal((await f.call("POST", `/api/people/conversations/${made.body.sessionId}/message`, { key: bo, body: { prompt: "hi" } })).status, 404);
  assert.equal((await f.call("GET", `/api/people/conversations/${made.body.sessionId}`, { key: ada })).body.access, "own");
  assert.equal((await f.call("POST", `/api/people/conversations/${made.body.sessionId}/message`, { key: ada, body: { prompt: "again" } })).status, 409, "one message at a time");
  // A restart caught it lent: it goes back to her when Branch starts.
  const { returnLentSessions } = await import("../dist/people/lending.js");
  assert.equal(returnLentSessions(f.app.store, f.app.runtime.owner), 1);
  assert.ok(f.app.store.ownsSession(`profile:${f.ada.id}`, made.body.sessionId));
});

test("B19-27 switching signing in off ends every person's key, and a person's key reaches no other door", async (t) => {
  const f = await served(t);
  const key = await f.signIn("Ada", "1234");
  const run = await f.app.runtime.run({ prompt: "owner's" });
  for (const [method, path] of [["POST", "/mcp"], ["POST", "/a2a"], ["GET", "/ap/v1/agent/tasks"], ["POST", "/v1/chat/completions"], ["GET", "/v1/models"],
    ["POST", "/api/commands/run"], ["GET", "/api/commands"], ["POST", "/api/tools/try"], ["POST", "/api/action"], ["GET", "/api/dashboard/overview"],
    ["GET", `/api/runs/${run.id}`], ["GET", `/api/runs/${run.id}/stream`], ["GET", `/api/runs/${run.id}/recording`], ["GET", `/api/runs/${run.id}/timeline`],
    ["GET", "/api/usage"], ["GET", "/api/memory/facts"], ["GET", "/api/artifacts"], ["GET", `/api/sessions/${run.sessionId}`], ["POST", "/api/profiles/switch"],
    ["GET", "/api/people/handoff"], ["GET", "/api/people/me/../settings"], ["GET", "/api/people/me/"], ["GET", "/api/people/me%2f..%2fsettings"],
    ["GET", "/API/people/settings"], ["POST", "/api/interop/handoff"], ["GET", "/api/security-check"]]) {
    const answer = await f.call(method, path, { key, body: method === "POST" ? {} : undefined });
    assert.ok([401, 404].includes(answer.status), `${method} ${path} → ${answer.status}`);
  }
  // No socket takes a person's key.
  const socket = await new Promise((resolve) => {
    const req = httpRequest(`${f.server.url}/api/runs/${run.id}/ws`, { headers: { connection: "Upgrade", upgrade: "websocket",
      "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", "sec-websocket-version": "13", "sec-websocket-protocol": `bearer, ${key}` } });
    req.on("upgrade", (response, s) => { s.destroy(); resolve(response.statusCode); });
    req.on("response", (response) => resolve(response.statusCode));
    req.on("error", () => resolve("closed"));
    req.on("close", () => resolve("closed"));
    req.end();
  });
  assert.notEqual(socket, 101);
  assert.equal((await f.owner("POST", "/api/people/settings", { mode: "off" })).status, 200);
  assert.equal((await f.owner("POST", "/api/people/settings", { mode: "on" })).status, 200);
  assert.equal((await f.call("GET", "/api/people/me", { key })).status, 401, "switching back on does not bring old sign-ins back");
});

test("B19-28 on the paired door, the identity service's way back passes the door's own checks", async (t) => {
  const f = await served(t);
  const host = new URL(f.server.url).host;
  const door = createHttpServer((request, response) => { request.headers.host = host; f.server.remoteHandler(request, response); });
  await new Promise((done) => door.listen(0, "127.0.0.1", done));
  t.after(() => new Promise((done) => { door.closeAllConnections?.(); door.close(done); }));
  const base = `http://127.0.0.1:${door.address().port}`;
  const back = await fetch(`${base}/api/people/oidc/callback?state=s&code=c`, { redirect: "manual" });
  assert.equal(back.status, 401, "an unpaired device gets nothing back");
  const start = await fetch(`${base}/api/people/sign-in/start`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Ada" }) });
  assert.equal(start.status, 401);
});

test("B19-29 a person's task cut off by a restart carries on as that person, and their conversation stays theirs", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-people-restart-"));
  const dataDir = join(root, "data"), workspace = join(root, "workspace");
  await saveGatewayConfig(dataDir, GatewayConfigSchema.parse({ mode: "on" }));
  const quiet = { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } };
  const first = await createBranch({ workspace, dataDir, provider: quiet });
  const ada = first.store.profiles.create({ name: "Ada", pin: "1234" });
  first.runtime.roles.save(ada.id, { role: "child" });
  // Ada's task, lent to the assistant, when Branch stopped.
  const run = first.store.createRun(first.runtime.owner, "plan my week");
  first.store.event(run.id, "run.started", { source: "owner", personProfileId: ada.id, lentTo: `profile:${ada.id}` });
  first.store.message(run.sessionId, { role: "user", content: "plan my week" });
  first.store.finish(run.id, "interrupted", "cut off");
  await first.close();

  let second = null;
  const seen = [];
  const provider = { name: "scripted", async complete() {
    seen.push({ scope: second.store.profiles.scope(), refusal: second.runtime.roleRefusal("files.write", "files.write") });
    return { content: "Carried on.", toolCalls: [] };
  } };
  second = await createBranch({ workspace, dataDir, provider });
  // One hook, app first: Windows will not delete a folder whose database is still open.
  t.after(async () => { await second.close(); await discardTemp(root); });
  assert.ok(second.store.ownsSession(`profile:${ada.id}`, run.sessionId), "handed back to her at start");
  assert.equal(second.store.profiles.isOwner(), true);
  const [report] = await second.neverBreak.recoverOnStart(dataDir);
  assert.equal(report.outcome, "resumed");
  const resumed = await report.resumed;
  assert.ok(resumed, "the task carried on");
  assert.equal(resumed.status, "completed");
  assert.ok(seen.length > 0);
  assert.ok(seen.every((s) => s.scope === `profile:${ada.id}`), "it ran as Ada");
  assert.ok(seen.every((s) => /does not cover/.test(s.refusal ?? "")), "held to her role");
  assert.equal(runOrigin(second.store, resumed.id).personProfileId, ada.id);
  assert.ok(second.store.ownsSession(`profile:${ada.id}`, run.sessionId), "and her conversation is hers again after");
  assert.equal(second.store.profiles.isOwner(), true, "the window was never switched");
});

test("B19-30 a step redone after a restart is held to the person's role, not the owner's", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-people-redo-"));
  const app = await createBranch({ workspace: join(root, "w"), dataDir: join(root, "d"), provider: { name: "s", async complete() { return { content: "ok", toolCalls: [] }; } } });
  // One hook, app first: Windows will not delete a folder whose database is still open.
  t.after(async () => { await app.close(); await discardTemp(root); });
  const ada = app.store.profiles.create({ name: "Ada", pin: "1234" });
  app.runtime.roles.save(ada.id, { role: "child" });
  const run = app.store.createRun(app.runtime.owner, "write it");
  app.store.event(run.id, "run.started", { source: "owner", personProfileId: ada.id, lentTo: `profile:${ada.id}` });
  app.neverBreak.journal.turn(run.id, run.sessionId, 1);
  const call = { id: "w1", name: "files.write", arguments: JSON.stringify({ path: "child.txt", content: "not allowed" }) };
  const hook = journalHook(app.neverBreak.journal);
  hook.intend({ runId: run.id, sessionId: run.sessionId, calls: [{ call, permission: app.registry.permissionOf(call.name) }] });
  app.store.message(run.sessionId, { role: "assistant", content: "", toolCalls: [call] });
  await hook.around({ runId: run.id, sessionId: run.sessionId, call, permission: app.registry.permissionOf(call.name),
    workspace: app.runtime.workspace, signal: AbortSignal.abort() }, async () => { throw new Error("cut off"); }).catch(() => undefined);
  app.store.finish(run.id, "interrupted", "cut off");
  const [report] = await recoverAfterRestart({ store: app.store, runtime: app.runtime, journal: app.neverBreak.journal, mode: "on" });
  await report.resumed;
  await assert.rejects(readFile(join(app.runtime.workspace, "child.txt")), "a child's write was not done as the owner");
});

test("B19-31 the security self-check knows the sign-in door and its switch", async (t) => {
  const f = await served(t);
  const facts = await collectSnapshot(f.app, { dataDir: join(f.app.runtime.workspace, ".."), integrationsPath: null, remoteEnabled: true, home: tmpdir() });
  assert.deepEqual({ ...facts.people, signedIn: 0 }, { mode: "on", chain: ["pin"], sessionMinutes: 720, signedIn: 0, waiting: 0 });
  const pinAlone = securityChecks.find((c) => c.id === "people.pin-alone-from-afar");
  assert.ok(pinAlone.decide(facts), "a PIN alone through the phone door is flagged");
  assert.equal(pinAlone.decide({ ...facts, remoteEnabled: false }), null);
  assert.equal(pinAlone.decide({ ...facts, people: { ...facts.people, chain: ["pin", "passkey"] } }), null);
  assert.equal(pinAlone.decide({ ...facts, people: { ...facts.people, mode: "off" } }), null, "nothing to say while it is off");
});
