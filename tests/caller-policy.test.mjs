/**
 * One place decides who may call what (src/caller.ts, src/caller-policy.ts). This asks a running engine, for every route
 * written in src/ and every kind of caller that can reach it, in every state the engine can be in (Lockdown off and on,
 * the window on the owner or a household person, the App lock locked), and holds the answers to
 * tests/caller-policy.golden.txt. A route nobody classified fails; a changed answer fails until the golden file is
 * written again (design/redesign/tools/write-caller-policy-golden.mjs) and that diff is reviewed.
 * design/redesign/tools/mutate-caller-policy.mjs flips the table's entries one at a time and shows each one turns this red.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROUTES } from "./short-lived-key-routes.mjs";
import { STATES, goldenText, matrix, probedRoutes, world, writtenRoutes } from "./caller-policy-world.mjs";
import { asCaller, currentCaller, httpCallerKinds, resolveCaller } from "../dist/caller.js";
import { callerRefusal, lockdownRoutes } from "../dist/caller-policy.js";

const golden = (file = join(import.meta.dirname, "caller-policy.golden.txt")) =>
  readFile(file, "utf8").then((text) => text.replace(/\r\n/g, "\n"));

test("the golden reader accepts Windows line endings without changing any policy text", async (t) => {
  const scratch = join(tmpdir(), "Codex-session-files");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "caller-golden-lines-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const expected = "# sample refusal\nowner POST /api/decisions/urgency | here=ok read=401/55661c\n";
  const file = join(root, "golden.txt");
  await writeFile(file, expected.replace(/\n/g, "\r\n"));
  assert.equal(await golden(file), expected);
  await writeFile(file, expected.replace("read=401/55661c", "read=ok").replace(/\n/g, "\r\n"));
  assert.notEqual(await golden(file), expected, "line ending handling must retain an authorization change");
});

test("guard: every route written in src/ is in the table, and every route the table asks about is in the golden file", async () => {
  const written = await writtenRoutes();
  const missing = [...written].filter(([path]) => !(path in ROUTES)).map(([path, where]) => `${path}  (${where})`);
  assert.deepEqual(missing, [], "Classify these in tests/short-lived-key-routes.mjs, then write the golden file again");
  const lines = new Set((await golden()).split("\n").filter((line) => line && !line.startsWith("#")).map((line) => line.split(" | ")[0]));
  const unasked = [];
  for (const state of STATES) for (const { method, path } of probedRoutes())
    if (!lines.has(`${state.name} ${method} ${path}`)) unasked.push(`${state.name} ${method} ${path}`);
  assert.deepEqual(unasked, [], "Write the golden file again: node design/redesign/tools/write-caller-policy-golden.mjs");
  assert.ok(probedRoutes().length > 1500, `every route and method: ${probedRoutes().length}`);
});

test("generated: every route × every caller × Lockdown off and on × the window's profile × the App lock, as the golden file says", async (t) => {
  const w = await world();
  t.after(() => w.close());
  const rows = await matrix(w);
  const now = goldenText(rows).split("\n"), then = (await golden()).split("\n");
  const was = new Set(then), is = new Set(now);
  const changed = [...now.filter((line) => !was.has(line)).map((line) => `+ ${line}`),
    ...then.filter((line) => !is.has(line)).map((line) => `- ${line}`)];
  assert.deepEqual(changed.slice(0, 40), [], `${changed.length} answers differ from tests/caller-policy.golden.txt`);
});

test("a caller over HTTP is only ever one of the HTTP kinds; a chat app and the engine's own work never arrive that way", () => {
  const seen = new Set();
  for (const key of ["window", "phone", "person", "read", "run"])
    for (const pairedDoor of [false, true]) for (const fromThisComputer of [false, true]) for (const windowHousehold of [false, true])
      seen.add(resolveCaller({ key, pairedDoor, fromThisComputer, windowHousehold, lockdown: false, appLocked: false }).kind);
  assert.deepEqual([...seen].filter((kind) => !httpCallerKinds.includes(kind)), []);
  for (const kind of ["chat-app", "system", "paired-computer", "outside-agent"]) assert.equal(seen.has(kind), false, kind);
  assert.equal(currentCaller().kind, "system", "no request behind it");
  const phone = resolveCaller({ key: "phone", pairedDoor: false, fromThisComputer: true, windowHousehold: false, lockdown: false, appLocked: false });
  assert.equal(phone.throughDoor, true, "a phone's own key is a door wherever it arrives");
  assert.equal(asCaller(phone, () => currentCaller().kind), "phone-with-own-key", "carried into what the request starts");
});

test("Lockdown's rows refuse every caller, and only while Lockdown is on", () => {
  for (const row of lockdownRoutes) {
    const owner = resolveCaller({ key: "window", pairedDoor: false, fromThisComputer: true, windowHousehold: false, lockdown: true, appLocked: false });
    assert.deepEqual(callerRefusal(owner, row.method, row.path), { status: row.status, message: row.message });
    assert.equal(callerRefusal({ ...owner, lockdown: false }, row.method, row.path), null);
  }
});

test("a phone's own key on this computer's own listener is a door for the routes kept to this computer's window", async (t) => {
  const w = await world();
  t.after(() => w.close());
  const phone = w.callers.phone;
  // The data-folder copies taken before updates may be put back only in the app on this computer.
  const refused = await w.call("GET", "/api/updates/data-copies", undefined, phone.key, w.server.url, phone.headers);
  assert.equal(refused.status, 403, refused.text);
  const owner = await w.call("GET", "/api/updates/data-copies", undefined, w.server.token);
  assert.equal(owner.status, 200, owner.text);
  // The update channel is chosen only in the app window on this computer.
  const channel = { card: "notify", values: { releaseChannel: "beta" } };
  const phoneChannel = await w.call("POST", "/api/comfort", channel, phone.key, w.server.url, phone.headers);
  assert.equal(phoneChannel.status, 403, phoneChannel.text);
  const ownerChannel = await w.call("POST", "/api/comfort", channel, w.server.token);
  assert.equal(ownerChannel.status, 200, ownerChannel.text);
});
