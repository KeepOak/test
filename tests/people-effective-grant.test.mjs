/* What a person's own card is drawn from: GET /api/profiles gives each person the grant Branch
   really holds them to (their role's cap, narrowed by any group), a person's own /api/trunks names
   the Trunks in their rooms, and POST /api/profiles adds somebody with their role in one step.
   Headless, 127.0.0.1, port 0. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { grantedCategories } from "../dist/profile-roles.js";

const scripted = { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } };

async function served(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-people-effective-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: scripted });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const call = async (path, body) => {
    const response = await fetch(new URL(path, server.url), {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  };
  const ok = async (path, body) => {
    const answer = await call(path, body);
    assert.equal(answer.status, 200, `${path}: ${JSON.stringify(answer.body)}`);
    return answer.body;
  };
  return { app, call, ok };
}
const enforced = (app, id) => grantedCategories(app.runtime.roles.effective(id));
const entryOf = (profiles, id) => profiles.roles.find((entry) => entry.profileId === id);

test("GET /api/profiles gives each person the kinds Branch enforces, for the owner and for the person", async (t) => {
  const f = await served(t);
  const kim = await f.ok("/api/profiles", { name: "Kim", pin: "1234" });
  const sam = await f.ok("/api/profiles", { name: "Sam", pin: "5678" });
  // Kim: an Adult put in a group that only lets its members look things up.
  await f.ok("/api/people/settings", { mode: "on" });
  await f.ok("/api/people/groups", { name: "Family", members: [kim.id], categories: ["read"] });
  // Sam: narrowed to read + files as an Adult, then made a Child.
  await f.ok(`/api/profiles/${sam.id}/role`, { role: "adult", categories: ["read", "files"] });
  await f.ok(`/api/profiles/${sam.id}/role`, { role: "child" });
  assert.deepEqual(enforced(f.app, kim.id), ["read"]);
  assert.deepEqual(enforced(f.app, sam.id), ["read"]);

  const asOwner = await f.ok("/api/profiles");
  for (const person of [kim, sam]) {
    const entry = entryOf(asOwner, person.id);
    assert.deepEqual(entry.categories, enforced(f.app, person.id), `${person.name}'s kinds are the enforced ones`);
    assert.deepEqual(grantedCategories(entry.effective), enforced(f.app, person.id));
  }
  assert.equal(entryOf(asOwner, sam.id).grant.role, "child", "the saved grant is still there for the role buttons");
  assert.deepEqual(entryOf(asOwner, sam.id).grant.categories, ["read", "files"]);

  for (const person of [kim, sam]) {
    await f.ok("/api/profiles/switch", { profileId: person.id, pin: person.name === "Kim" ? "1234" : "5678" });
    const own = entryOf(await f.ok("/api/profiles"), person.id);
    assert.deepEqual(own.categories, ["read"], `${person.name} sees only what Branch enforces`);
    assert.ok(!own.categories.includes("files"));
    await f.ok("/api/profiles/switch", { profileId: null });
  }
});

test("a person's own /api/trunks names the Trunks in their rooms, and only those", async (t) => {
  const f = await served(t);
  await f.ok("/api/trunks/switch", { part: "trunks", mode: "on" });
  await f.ok("/api/trunks/switch", { part: "rooms", mode: "on" });
  const scout = (await f.ok("/api/trunks", { name: "Scout" })).trunk;
  const ledger = (await f.ok("/api/trunks", { name: "Ledger" })).trunk;
  const quill = (await f.ok("/api/trunks", { name: "Quill" })).trunk;
  const pip = (await f.ok("/api/trunks", { name: "Pip" })).trunk;
  const sam = await f.ok("/api/profiles", { name: "Sam", pin: "5678" });
  await f.ok("/api/trunks/rooms", { name: "Homework", members: [scout.id, quill.id], people: [sam.id] });
  await f.ok("/api/trunks/rooms", { name: "Sums", members: [scout.id, quill.id], people: [sam.id] });
  await f.ok("/api/trunks/rooms", { name: "Owner only", members: [ledger.id, pip.id], people: [] });
  await f.ok("/api/profiles/switch", { profileId: sam.id, pin: "5678" });
  const mine = await f.ok("/api/trunks");
  const ownDefault = f.app.trunks.personDefault();
  assert.equal(ownDefault.scope, `profile:${sam.id}`);
  assert.deepEqual(mine.trunks.map((trunk) => trunk.id), [ownDefault.trunk.id], "only Sam's own default is listed");
  assert.ok(f.app.store.ownsSession(ownDefault.scope, mine.trunks[0].chatSessionId));
  assert.ok(mine.trunks.every((trunk) => ![scout.id, ledger.id, quill.id, pip.id].includes(trunk.id)), "no owner Trunk becomes Sam's own");
  assert.deepEqual(mine.rooms.map((room) => room.name).sort(), ["Homework", "Sums"]);
  const names = [...new Set(mine.rooms.flatMap((room) => room.roster.map((trunk) => trunk.name)))].sort();
  assert.deepEqual(names, ["Quill", "Scout"], "not Ledger or Pip, whose room is not theirs");
});

test("POST /api/profiles adds somebody with their role in one step, and a bad role adds nobody", async (t) => {
  const f = await served(t);
  const jo = await f.ok("/api/profiles", { name: "Jo", pin: "4321", role: "child" });
  assert.equal(f.app.runtime.roles.get(jo.id).role, "child");
  const al = await f.ok("/api/profiles", { name: "Al", pin: "4321" });
  assert.equal(f.app.runtime.roles.get(al.id).role, "adult", "adult when left out");
  for (const role of ["owner", "boss"]) {
    const refused = await f.call("/api/profiles", { name: "Mo", pin: "4321", role });
    assert.equal(refused.status, 400, JSON.stringify(refused.body));
  }
  assert.deepEqual((await f.ok("/api/profiles")).profiles.map((person) => person.name), ["Al", "Jo"], "no half-made person");
});

test("somebody switched in sees only their own enforced grant; another person's stays out of their answer", async (t) => {
  const { app, ok } = await served(t);
  const kim = app.store.profiles.create({ name: "Kim", pin: "1234" });
  const sam = app.store.profiles.create({ name: "Sam", pin: "5678" });
  app.runtime.roles.save(sam.id, { role: "child" });
  await ok("/api/people/groups", { name: "Weekdays", members: [kim.id], projects: ["homework"], dailySpendLimit: 10 });
  // The owner sees both, each narrowed its own way, so a leak would show a real difference.
  const owner = await ok("/api/profiles");
  assert.deepEqual(entryOf(owner, kim.id).effective.projects, ["homework"]);
  assert.ok("effective" in entryOf(owner, sam.id) && "categories" in entryOf(owner, sam.id));
  assert.notDeepEqual(entryOf(owner, sam.id).categories, entryOf(owner, kim.id).categories);
  await ok("/api/profiles/switch", { profileId: kim.id, pin: "1234" });
  const asKim = await ok("/api/profiles");
  assert.equal("effective" in entryOf(asKim, sam.id), false, "Kim does not see what Sam is held to");
  assert.equal("categories" in entryOf(asKim, sam.id), false);
  assert.deepEqual(entryOf(asKim, kim.id).effective.projects, ["homework"], "Kim sees her own");
  assert.equal(entryOf(asKim, kim.id).effective.dailySpendLimit, 10);
});
