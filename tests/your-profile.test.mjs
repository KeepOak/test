/**
 * your-profile: each person's own name, picture and (the owner's) time zone (src/person-about.ts).
 * Only you change your own: a household person is refused the owner's and anybody else's, the owner is refused a
 * person's, and a short-lived key is refused all of them. A picture is a PNG, JPEG, WebP or GIF, checked by its bytes.
 * A scripted model; no provider.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { householdRefusal } from "../dist/household-routes.js";
import { ownerRoleWords } from "../dist/person-about.js";
import { roleLabels } from "../dist/profile-roles.js";

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const provider = { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } };

async function open(root) {
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const call = (method, path, body, key = server.token) => fetch(server.url + path, {
    method, headers: { authorization: `Bearer ${key}`, ...(method === "GET" ? {} : { "content-type": "application/json" }) },
    ...(method === "GET" ? {} : { body: JSON.stringify(body ?? {}) }),
  }).then(async (response) => ({ status: response.status, body: await response.json().catch(() => ({})) }));
  // The paired door (the phone's), on a spare loopback port carrying a host the server accepts (tests/mobile-contract.test.mjs).
  const host = new URL(server.url).host;
  const door = createServer((request, response) => { request.headers.host = host; server.remoteHandler(request, response); });
  await new Promise((done) => door.listen(0, "127.0.0.1", done));
  const doorUrl = `http://127.0.0.1:${door.address().port}`;
  return { app, server, call, doorUrl, close: async () => {
    door.closeAllConnections?.(); await new Promise((done) => door.close(done)); await server.close(); await app.close();
  } };
}

async function served(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-your-profile-"));
  let now = await open(root);
  t.after(async () => { await now.close(); await discardTemp(root); });
  const sam = (await now.call("POST", "/api/profiles", { name: "Sam", pin: "2468" })).body;
  const kim = (await now.call("POST", "/api/profiles", { name: "Kim", pin: "1357" })).body;
  return {
    get call() { return now.call; }, get app() { return now.app; }, get server() { return now.server; },
    get doorUrl() { return now.doorUrl; }, sam, kim,
    toSam: async () => assert.equal((await now.call("POST", "/api/profiles/switch", { profileId: sam.id, pin: "2468" })).status, 200),
    back: async () => assert.equal((await now.call("POST", "/api/profiles/switch", { profileId: null })).status, 200),
    restart: async () => { await now.close(); now = await open(root); },
  };
}

test("the owner names themselves, picks a face and a time zone, and every tile reads them, after a restart too", async (t) => {
  const f = await served(t);
  const before = (await f.call("GET", "/api/profiles")).body;
  assert.equal(before.owner.name, null, "nobody has asked the owner's name yet");
  assert.deepEqual(before.owner.avatar, { face: "initial", color: null, emoji: null, picture: null });
  const saved = await f.call("POST", "/api/profiles/owner/about", { name: "Robin", face: "emoji", emoji: "🦊", color: "#2f8c86", timezone: "Europe/Paris" });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.name, "Robin");
  await f.restart();
  const after = (await f.call("GET", "/api/profiles")).body;
  assert.equal(after.owner.name, "Robin");
  assert.deepEqual(after.owner.avatar, { face: "emoji", color: "#2f8c86", emoji: "🦊", picture: null });
  assert.equal((await f.call("GET", "/api/profiles/owner/about")).body.timezone, "Europe/Paris");
  assert.equal(after.owner.timezone, "Europe/Paris", "the owner's own window is told the zone it proposes schedules in");
  // Nobody here shares a name: not somebody new, and not the owner taking a person's.
  assert.match((await f.call("POST", "/api/profiles", { name: "robin", pin: "1111" })).body.error, /already uses that name/);
  assert.match((await f.call("POST", "/api/profiles/owner/about", { name: "SAM" })).body.error, /already uses that name/);
  // Schedules proposed without a time zone are proposed in the owner's.
  const proposed = await f.call("POST", "/api/schedules/propose", { edit: { prompt: "Water the plants", dailyAt: "08:00" } });
  assert.equal(proposed.status, 200, JSON.stringify(proposed.body));
  assert.equal(proposed.body.proposal.schedule.timezone, "Europe/Paris");
  // A name can be forgotten again, and a wrong zone or face is refused.
  assert.equal((await f.call("POST", "/api/profiles/owner/about", { name: null })).body.name, null);
  assert.equal((await f.call("POST", "/api/profiles/owner/about", { timezone: "Mars/Olympus" })).status, 400);
  assert.equal((await f.call("POST", "/api/profiles/owner/about", { face: "photo" })).status, 400, "no photo to show yet");
  assert.equal((await f.call("POST", "/api/profiles/owner/about", { emoji: "hi" })).status, 400);
});

test("a picture goes through the engine: only real PNG, JPEG, WebP or GIF bytes, a quarter of a megabyte at most", async (t) => {
  const f = await served(t);
  const put = await f.call("POST", "/api/profiles/owner/picture", { picture: PNG });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.equal(put.body.face, "photo");
  assert.ok(put.body.picture, "the stamp says a picture is there");
  assert.equal((await f.call("GET", "/api/profiles/owner/picture")).body.picture, PNG);
  assert.equal((await f.call("GET", "/api/profiles")).body.owner.avatar.face, "photo");
  const svg = `data:image/svg+xml;base64,${Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>").toString("base64")}`;
  assert.equal((await f.call("POST", "/api/profiles/owner/picture", { picture: svg })).status, 400);
  const lying = `data:image/jpeg;base64,${PNG.split(",")[1]}`;
  assert.equal((await f.call("POST", "/api/profiles/owner/picture", { picture: lying })).status, 400, "the bytes decide, not the label");
  const text = `data:image/png;base64,${Buffer.from("not a picture at all").toString("base64")}`;
  assert.equal((await f.call("POST", "/api/profiles/owner/picture", { picture: text })).status, 400);
  const big = Buffer.concat([Buffer.from(PNG.split(",")[1], "base64"), Buffer.alloc(300 * 1024)]);
  assert.notEqual((await f.call("POST", "/api/profiles/owner/picture", { picture: `data:image/png;base64,${big.toString("base64")}` })).status, 200);
  const removed = await f.call("POST", "/api/profiles/owner/picture/remove");
  assert.equal(removed.body.face, "initial");
  assert.equal((await f.call("GET", "/api/profiles/owner/picture")).body.picture, null);
});

test("a household person edits only their own profile, never the owner's or anybody else's", async (t) => {
  const f = await served(t);
  assert.equal((await f.call("POST", "/api/profiles/owner/about", { name: "Robin", timezone: "Europe/Paris" })).status, 200);
  await f.toSam();
  assert.equal((await f.call("GET", "/api/profiles")).body.owner.timezone, undefined, "a household window is not told the owner's time zone");
  assert.match((await f.call("POST", `/api/profiles/${f.sam.id}/about`, { name: "ROBIN" })).body.error, /already uses that name/, "not the owner's name either");
  // Reading: their own profile and everybody's picture for the tiles; never the owner's profile with its time zone.
  assert.equal((await f.call("GET", `/api/profiles/${f.sam.id}/about`)).body.name, "Sam");
  assert.equal((await f.call("GET", "/api/profiles/owner/picture")).status, 200);
  assert.equal((await f.call("GET", `/api/profiles/${f.kim.id}/picture`)).status, 200);
  assert.equal((await f.call("GET", "/api/profiles/owner/about")).body.error, householdRefusal);
  // The owner's: the household sentence, at the one place src/server.ts answers it.
  for (const path of ["/api/profiles/owner/about", "/api/profiles/owner/picture", "/api/profiles/owner/picture/remove"]) {
    const answer = await f.call("POST", path, { name: "Mallory", picture: PNG });
    assert.equal(answer.status, 400, path);
    assert.equal(answer.body.error, householdRefusal, path);
  }
  // Somebody else's.
  for (const part of ["about", "picture", "picture/remove"]) {
    const answer = await f.call("POST", `/api/profiles/${f.kim.id}/${part}`, part === "about" ? { name: "Mallory" } : { picture: PNG });
    assert.equal(answer.status, 400, part);
    assert.match(answer.body.error, /Only that person can change their own profile/);
  }
  // Their own: a new name (never one somebody here has), a face and a picture.
  assert.match((await f.call("POST", `/api/profiles/${f.sam.id}/about`, { name: "kim" })).body.error, /already uses that name/);
  assert.equal((await f.call("POST", `/api/profiles/${f.sam.id}/about`, { name: null })).status, 400, "a person always has a name");
  assert.equal((await f.call("POST", `/api/profiles/${f.sam.id}/about`, { timezone: "Europe/Paris" })).status, 400, "the time zone is the owner's");
  const mine = await f.call("POST", `/api/profiles/${f.sam.id}/about`, { name: "Samira", face: "initial", color: "#d8612a" });
  assert.equal(mine.status, 200, JSON.stringify(mine.body));
  assert.equal((await f.call("POST", `/api/profiles/${f.sam.id}/picture`, { picture: PNG })).status, 200);
  const list = (await f.call("GET", "/api/profiles")).body;
  const me = list.profiles.find((p) => p.id === f.sam.id);
  assert.equal(me.name, "Samira");
  assert.equal(me.avatar.face, "photo");
  assert.equal(list.active.name, "Samira");
  assert.equal(list.owner.name, "Robin", "the owner's profile is untouched");
  assert.equal(list.profiles.find((p) => p.id === f.kim.id).name, "Kim");
  // The owner, switched back, may not change Samira's either.
  await f.back();
  const theirs = await f.call("POST", `/api/profiles/${f.sam.id}/about`, { name: "Sam" });
  assert.match(theirs.body.error, /Only that person can change their own profile/);
  assert.equal((await f.call("POST", `/api/profiles/${f.sam.id}/picture/remove`)).status, 400);
  // Removing somebody takes their face and picture with them.
  assert.equal((await f.call("POST", `/api/profiles/${f.sam.id}/remove`)).body.removed, true);
  assert.equal((await f.call("GET", `/api/profiles/${f.sam.id}/picture`)).body.picture, null);
});

test("a short-lived key may read a profile but never change one", async (t) => {
  const f = await served(t);
  for (const scope of ["read", "run"]) {
    const made = await f.call("POST", "/api/tokens", { name: `script-${scope}`, scope, minutes: 5 });
    assert.equal(made.status, 200, JSON.stringify(made.body));
    const key = made.body.token ?? made.body.key;
    assert.equal((await f.call("GET", "/api/profiles/owner/about", undefined, key)).status, 200);
    for (const path of ["/api/profiles/owner/about", "/api/profiles/owner/picture", `/api/profiles/${f.sam.id}/about`, `/api/profiles/${f.sam.id}/picture/remove`])
      assert.equal((await f.call("POST", path, { name: "Mallory" }, key)).status, 401, `${scope} ${path}`);
  }
});

const renames = (app) => app.store.audit.list(app.runtime.owner, { limit: 500 }).filter((e) => e.subject === "their own name").length;

test("a refused change changes nothing: every part is checked before the name is, and a real rename is written down", async (t) => {
  const f = await served(t);
  await f.toSam();
  const audits = renames(f.app);
  const refused = await f.call("POST", `/api/profiles/${f.sam.id}/about`, { name: "Samira", face: "photo" });
  assert.equal(refused.status, 400, JSON.stringify(refused.body));
  assert.match(refused.body.error, /Add a photo first/);
  assert.equal(f.app.store.profiles.list().find((p) => p.id === f.sam.id).name, "Sam", "the name is untouched");
  assert.equal(renames(f.app), audits, "nothing to write down");
  const renamed = await f.call("POST", `/api/profiles/${f.sam.id}/about`, { name: "Samira" });
  assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
  assert.equal(renames(f.app), audits + 1, "the rename is written down once");
  // The owner's time zone, which decides when schedules run, is written down too.
  await f.back();
  const zoneAudits = () => f.app.store.audit.list(f.app.runtime.owner, { limit: 500 }).filter((e) => /time zone/.test(e.subject)).length;
  const zones = zoneAudits();
  assert.equal((await f.call("POST", "/api/profiles/owner/about", { timezone: "Asia/Tokyo" })).status, 200);
  assert.equal(zoneAudits(), zones + 1);
});

test("nobody but the owner goes by the owner's role word, and names match however they are written", async (t) => {
  const f = await served(t);
  await f.toSam();
  for (const name of ["Owner", "OWNER", " owner ", "Ｏｗｎｅｒ", "Own​er", "Propriétaire", "EIGENTÜMER", "propietario", "ＫＩＭ", "K​im"]) {
    const answer = await f.call("POST", `/api/profiles/${f.sam.id}/about`, { name });
    assert.equal(answer.status, 400, `${JSON.stringify(name)}: ${JSON.stringify(answer.body)}`);
    assert.match(answer.body.error, /already uses that name/, name);
  }
  assert.equal(f.app.store.profiles.list().find((p) => p.id === f.sam.id).name, "Sam");
  await f.back();
  for (const name of ["Owner", "ｏｗｎｅｒ", "Eigentümer", "sam‍"])
    assert.match((await f.call("POST", "/api/profiles", { name, pin: "1111" })).body.error ?? "", /already uses that name/, name);
  // The owner may go by their own role word; forgetting their name is refused while somebody else already goes by it.
  assert.equal((await f.call("POST", "/api/profiles/owner/about", { name: "owner" })).status, 200);
  assert.equal((await f.call("POST", "/api/profiles/owner/about", { name: "Robin" })).status, 200);
  f.app.store.profiles.rename(f.kim.id, "Owner"); // a name given before this rule
  assert.match((await f.call("POST", "/api/profiles/owner/about", { name: null })).body.error ?? "", /already uses that name/);
  assert.equal((await f.call("GET", "/api/profiles")).body.owner.name, "Robin");
});

test("the owner's role word list is the one every language shows", async () => {
  const words = new Set([roleLabels.owner.label]);
  for (const file of await readdir(new URL("../public/locales/", import.meta.url)))
    if (file.endsWith(".json")) words.add(JSON.parse(await readFile(new URL(`../public/locales/${file}`, import.meta.url), "utf8"))["household.role.owner"]);
  assert.deepEqual([...ownerRoleWords].sort(), [...words].sort());
});

test("the owner's phone, through the paired door, never changes a household person's profile", async (t) => {
  const f = await served(t);
  const offer = f.server.remote.pairing.create();
  const paired = await fetch(`${f.doorUrl}/api/pair`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: offer.id, code: offer.code, name: "Pixel" }) }).then((r) => r.json());
  const phone = { authorization: `Bearer ${paired.token}`, "x-branch-device": paired.deviceId, "x-branch-device-key": paired.deviceKey,
    "content-type": "application/json" };
  const viaPhone = (path, body) => fetch(f.doorUrl + path, { method: "POST", headers: phone, body: JSON.stringify(body) })
    .then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
  assert.equal((await viaPhone("/api/profiles/owner/about", { name: "Robin" })).status, 200, "the owner's own, from the owner's phone");
  // While the window here is switched to Sam, the phone is still not Sam.
  await f.toSam();
  for (const part of ["about", "picture", "picture/remove"]) {
    const answer = await viaPhone(`/api/profiles/${f.sam.id}/${part}`, part === "about" ? { name: "Mallory" } : part === "picture" ? { picture: PNG } : {});
    assert.equal(answer.status, 400, `${part}: ${JSON.stringify(answer.body)}`);
    assert.match(answer.body.error, /Only that person can change their own profile/);
  }
  assert.equal(f.app.store.profiles.list().find((p) => p.id === f.sam.id).name, "Sam");
  assert.equal((await f.call("POST", `/api/profiles/${f.sam.id}/about`, { name: "Samira" })).status, 200, "Sam, at the window, still can");
  // A device's own key is not a key to anything else.
  for (const key of [paired.deviceKey, paired.deviceId])
    assert.equal((await f.call("POST", "/api/profiles/owner/about", { name: "Mallory" }, key)).status, 401);
});

test("racing to one name: one gets it, the others are refused", async (t) => {
  const f = await served(t);
  const results = await Promise.all([
    f.call("POST", "/api/profiles/owner/about", { name: "Alex" }),
    f.call("POST", "/api/profiles", { name: "alex", pin: "1111" }),
    f.call("POST", "/api/profiles", { name: "ALEX", pin: "2222" }),
  ]);
  assert.equal(results.filter((r) => r.status === 200).length, 1, JSON.stringify(results));
  const list = (await f.call("GET", "/api/profiles")).body;
  assert.equal([list.owner.name, ...list.profiles.map((p) => p.name)].filter((n) => n?.toLowerCase() === "alex").length, 1);
});
