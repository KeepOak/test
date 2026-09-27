/**
 * phase2/delight: the pet, achievements and your own background — their switches (all off), and the
 * 505 achievements: exactly 100 in each of five tiers and five near-impossible ones, every one earned
 * from something that really happened, owner-only, and never shown to anybody else.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { auditActions } from "../dist/audit.js";
import { inferToolGroup } from "../dist/catalog.js";
import {
  achievementCatalogue, achievementTiers, backgroundKinds, bestStreak, measure, noticedFlags, petKinds, seasons, themeNames,
} from "../dist/achievements.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-delight-"));
  const provider = { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const call = async (method, path, body, key = server.token) => {
    const response = await fetch(new URL(path, server.url), {
      method, headers: { authorization: `Bearer ${key}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  };
  return { app, server, call };
}

/* ---------- the catalogue ---------- */

test("505 achievements: 100 in each of Bronze, Silver, Gold, Diamond and Godly, and 5 SSS+, with unique ids", () => {
  const all = achievementCatalogue();
  assert.equal(all.length, 505);
  for (const tier of achievementTiers.slice(0, 5)) assert.equal(all.filter((a) => a.tier === tier).length, 100, tier);
  assert.equal(all.filter((a) => a.tier === "SSS+").length, 5);
  assert.equal(new Set(all.map((a) => a.id)).size, 505, "ids are unique");
  for (const a of all) assert.ok(a.name && a.desc && a.goal >= 1, `${a.id} has a name, a sentence and a goal`);
  assert.equal(themeNames().length, 44, "the window's 44 themes were read");
  assert.ok(all.some((a) => a.name === "It's lonely over here"), "the achievement the owner asked for by name");
  assert.ok(all.some((a) => a.metric === "streak" && a.goal === 100), "a 100-day streak");
});

/** Everything at its most: if an achievement cannot be reached even here, nothing real could reach it. */
function everything() {
  const big = 10_000_000, days = [];
  for (let i = 0; i < 4000; i++) days.push(new Date(Date.UTC(2020, 0, 1 + i)).toISOString().slice(0, 10));
  const counts = (keys) => Object.fromEntries(keys.map((k) => [k, big]));
  const events = new Set(achievementCatalogue().filter((a) => a.metric.startsWith("event:")).map((a) => a.metric.slice(6)));
  const themes = themeNames().flatMap(([id]) => [`light:${id}`, `dark:${id}`]);
  return {
    tallies: {
      tasks: big, stopped: big, conversations: big, days, solstice: 1,
      bySource: counts(["web", "schedule", "channel", "trigger"]),
      hours: counts(Array.from({ length: 24 }, (_, h) => String(h).padStart(2, "0"))), weekdays: counts(["0", "1", "2", "3", "4", "5", "6"]),
      tools: counts(["files.write", "web.search", "browser.click", "code.run", "memory.put", "documents.add"]), events: counts([...events]),
    },
    audit: counts(auditActions), records: counts(["schedules", "procedures", "specialists", "triggers", "webhooks", "workflows", "memory"]),
    noticed: {
      themes, leaves: themes.flatMap((t) => seasons.map((s) => `${t}:${s}`)), seasons: [...seasons], pages: Array.from({ length: 12 }, (_, i) => `p${i}`),
      pets: [...petKinds], pats: big, backgrounds: [...backgroundKinds], flags: Object.keys(noticedFlags),
    },
    earned: 500,
  };
}
test("every achievement can be reached from real facts, and none from no facts at all", () => {
  const most = everything();
  const unreachable = achievementCatalogue().filter((a) => measure(a.metric, most) < a.goal).map((a) => a.id);
  assert.deepEqual(unreachable, []);
  const none = { tallies: { tasks: 0, stopped: 0, conversations: 0, days: [], solstice: 0, bySource: {}, hours: {}, weekdays: {}, tools: {}, events: {} },
    audit: {}, records: {}, noticed: { themes: [], leaves: [], seasons: [], pages: [], pets: [], pats: 0, backgrounds: [], flags: [] }, earned: 0 };
  assert.deepEqual(achievementCatalogue().filter((a) => measure(a.metric, none) >= a.goal).map((a) => a.id), [], "nothing is given for nothing");
});

test("what is measured is something Branch really writes down", async () => {
  const source = [];
  const walk = async (dir) => { for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.isDirectory()) await walk(join(dir, e.name)); else if (e.name.endsWith(".ts") && !e.name.startsWith("achievement")) source.push(await readFile(join(dir, e.name), "utf8"));
  } };
  await walk(join(import.meta.dirname, "..", "src"));
  const text = source.join("\n");
  const all = achievementCatalogue();
  for (const kind of new Set(all.filter((a) => a.metric.startsWith("event:")).map((a) => a.metric.slice(6))))
    assert.ok(text.includes(`"${kind}"`), `a task really writes the event ${kind}`);
  for (const action of new Set(all.filter((a) => a.metric.startsWith("audit:")).map((a) => a.metric.slice(6))))
    assert.ok(auditActions.includes(action), `${action} is an audit action`);
  for (const group of new Set(all.filter((a) => a.metric.startsWith("tool:") && a.metric !== "tool:all").map((a) => a.metric.slice(5))))
    assert.ok(["files.write", "web.search", "browser.click", "code.run", "memory.put", "documents.add"].some((n) => inferToolGroup(n) === group), `${group} is a toolbox`);
  for (const source of new Set(all.filter((a) => a.metric.startsWith("src:")).map((a) => a.metric.slice(4))))
    assert.ok(text.includes(`"${source}"`), `tasks really start from ${source}`);
});

test("a streak is the best run of days in a row, so it only ever pauses", () => {
  assert.equal(bestStreak([]), 0);
  assert.equal(bestStreak(["2026-01-01", "2026-01-02", "2026-01-03", "2026-01-05"]), 3);
  assert.equal(bestStreak(["2026-02-27", "2026-02-28", "2026-03-01", "2026-03-10", "2026-03-11"]), 3, "across a month's end");
});

/* ---------- the switches and the owner's record ---------- */

// The owner's rule (Q251, 2026-09-26): nothing here reaches outside, spends, sends data out or weakens a guard, so all
// three ship on; switched off, achievements write nothing down, as before.
test("all three switches ship on, and nothing is written down once achievements are switched off", async (t) => {
  const { call } = await fixture(t);
  const summary = (await call("GET", "/api/delight")).body;
  assert.equal(summary.available, true);
  assert.equal(summary.settings.pets.on, true);
  assert.equal(summary.settings.achievements.on, true);
  assert.equal(summary.settings.background.on, true);
  await call("POST", "/api/delight/settings", { achievements: { on: false } });
  assert.deepEqual((await call("GET", "/api/delight/achievements")).body, { on: false });
  assert.deepEqual((await call("POST", "/api/delight/noticed", { what: "pat" })).body, { kept: false });
});

test("switching achievements on finds the past without a party; what happens next is celebrated once", async (t) => {
  const { app, call } = await fixture(t);
  await call("POST", "/api/delight/settings", { achievements: { on: false } }); // they ship on (Q251); this starts from off
  await app.runtime.run({ prompt: "one" });
  await call("POST", "/api/delight/settings", { achievements: { on: true } });
  let view = (await call("GET", "/api/delight/achievements")).body;
  assert.equal(view.on, true);
  assert.equal(view.total, 505);
  assert.ok(view.list.find((a) => a.id === "tasks:1").got, "the task done before switching on counts");
  assert.deepEqual(view.fresh, [], "the past arrives quietly");
  const next = view.list.filter((a) => a.id.startsWith("tasks:") && !a.got).map((a) => Number(a.id.slice(6))).sort((x, y) => x - y)[0];
  for (let i = 1; i < next; i++) await app.runtime.run({ prompt: `task ${i}` });
  view = (await call("GET", "/api/delight/achievements")).body;
  assert.ok(view.fresh.some((a) => a.id === `tasks:${next}`), `finishing the ${next}th task is new`);
  assert.equal((await call("POST", "/api/delight/told", { ids: view.fresh.map((a) => a.id) })).body.fresh, 0);
  assert.deepEqual((await call("GET", "/api/delight/achievements")).body.fresh, [], "told once, never again");
  assert.equal(view.rank, "Bronze");
});

test("Q251: an install updated with a past finds it quietly at its first look, with achievements on as shipped", async (t) => {
  const { app, call } = await fixture(t);
  for (let i = 0; i < 3; i++) await app.runtime.run({ prompt: `before the update ${i}` });
  // The owner never touches the switch: it is on as shipped.
  let view = (await call("GET", "/api/delight/achievements")).body;
  assert.equal(view.on, true);
  assert.ok(view.list.find((a) => a.id === "tasks:1").got, "the past counts");
  assert.deepEqual(view.fresh, [], "and arrives without a party");
  const next = view.list.filter((a) => a.id.startsWith("tasks:") && !a.got).map((a) => Number(a.id.slice(6))).sort((x, y) => x - y)[0];
  for (let i = 3; i < next; i++) await app.runtime.run({ prompt: `after the update ${i}` });
  view = (await call("GET", "/api/delight/achievements")).body;
  assert.ok(view.fresh.some((a) => a.id === `tasks:${next}`), "what happens after the first look is celebrated");
});

test("quiet earns without any pop-up, and is itself noticed", async (t) => {
  const { app, call } = await fixture(t);
  await call("POST", "/api/delight/settings", { achievements: { on: true, quiet: true } });
  await app.runtime.run({ prompt: "one" });
  const view = (await call("GET", "/api/delight/achievements")).body;
  assert.deepEqual(view.fresh, []);
  assert.ok(view.list.find((a) => a.id === "tasks:1").got);
  assert.ok(view.list.find((a) => a.id === "noticed:flag:quiet:1").got, "Quiet please");
});

test("what the window saw: only a closed list, only real theme names, and pats that add up", async (t) => {
  const { call } = await fixture(t);
  await call("POST", "/api/delight/settings", { achievements: { on: true } });
  assert.equal((await call("POST", "/api/delight/noticed", { what: "theme", mode: "dark", theme: "no-such-theme" })).status, 400);
  assert.equal((await call("POST", "/api/delight/noticed", { what: "flag", flag: "quiet" })).status, 400, "the server notices quiet itself");
  assert.equal((await call("POST", "/api/delight/noticed", { what: "tasks", count: 1000 })).status, 400, "a count cannot be claimed");
  assert.equal((await call("POST", "/api/delight/noticed", { what: "theme", mode: "dark", theme: "forest", season: "winter" })).status, 200);
  for (let i = 0; i < 10; i++) await call("POST", "/api/delight/noticed", { what: "pat" });
  await call("POST", "/api/delight/noticed", { what: "flag", flag: "lonely" });
  const view = (await call("GET", "/api/delight/achievements")).body;
  const got = new Set(view.list.filter((a) => a.got).map((a) => a.id));
  for (const id of ["noticed:theme:dark:forest:1", "noticed:pats:1", "noticed:pats:10", "noticed:flag:lonely:1"]) assert.ok(got.has(id), id);
  assert.ok(!got.has("noticed:pats:25"));
  assert.deepEqual(view.fresh.map((a) => a.id).sort(), [...got].filter((id) => !id.startsWith("sss")).sort().filter((id) => view.fresh.some((a) => a.id === id)));
});

test("a locked achievement gives less away the higher it is", async (t) => {
  const { call } = await fixture(t);
  await call("POST", "/api/delight/settings", { achievements: { on: true } });
  const list = (await call("GET", "/api/delight/achievements")).body.list;
  const locked = (tier) => list.find((a) => a.tier === tier && !a.got);
  assert.notEqual(locked("Silver").desc, "???");
  assert.equal(locked("Gold").desc, "???");
  assert.equal(locked("Diamond").name, "???");
  assert.equal(locked("Godly").name, "");
  assert.equal(locked("SSS+").desc, "");
  assert.equal(JSON.stringify(list).includes("Ten-year streak"), false, "a secret is not in the answer at all");
});

test("the switches are checked: unknown fields, a long name and a scrim out of range are refused", async (t) => {
  const { call } = await fixture(t);
  assert.equal((await call("POST", "/api/delight/settings", { pets: { on: true, wings: true } })).status, 400);
  assert.equal((await call("POST", "/api/delight/settings", { pets: { name: "x".repeat(21) } })).status, 400);
  assert.equal((await call("POST", "/api/delight/settings", { background: { scrim: 5 } })).status, 400);
  assert.equal((await call("POST", "/api/delight/settings", { sparkles: {} })).status, 400);
  const saved = (await call("POST", "/api/delight/settings", { pets: { on: true, kind: "owl", name: "Moss" } })).body.settings;
  assert.deepEqual(saved.pets, { on: true, kind: "owl", name: "Moss", talks: true, tips: true });
  assert.equal(saved.achievements.on, true, "the other switches are untouched (achievements ship on, Q251)");
  assert.equal(saved.look.style, "pixel", "pixel is the default look");
  assert.equal((await call("POST", "/api/delight/settings", { look: { style: "clay" } })).status, 400);
  assert.equal((await call("POST", "/api/delight/settings", { look: { style: "3d" } })).body.settings.look.style, "3d");
});

/* ---------- nobody but the owner ---------- */

test("a household profile and a short-lived key see nothing and change nothing", async (t) => {
  const { app, call } = await fixture(t);
  await call("POST", "/api/delight/settings", { achievements: { on: true }, pets: { on: true } });
  const key = app.sessionTokens.create(app.runtime.owner, { name: "script", scope: "run", minutes: 5 }).token;
  assert.deepEqual((await call("GET", "/api/delight", undefined, key)).body, { available: false });
  assert.equal((await call("GET", "/api/delight/achievements", undefined, key)).status, 401);
  assert.equal((await call("POST", "/api/delight/settings", { pets: { on: false } }, key)).status, 401);
  assert.equal((await call("POST", "/api/delight/noticed", { what: "pat" }, key)).status, 401);
  const sam = (await call("POST", "/api/profiles", { name: "Sam", pin: "2468" })).body;
  assert.equal((await call("POST", "/api/profiles/switch", { profileId: sam.id, pin: "2468" })).status, 200);
  assert.deepEqual((await call("GET", "/api/delight")).body, { available: false });
  assert.equal((await call("GET", "/api/delight/achievements")).status, 400);
  assert.equal((await call("POST", "/api/delight/settings", { pets: { on: false } })).status, 400);
  assert.equal((await call("POST", "/api/delight/told", { ids: [] })).status, 400);
  assert.equal((await call("POST", "/api/profiles/switch", { profileId: null })).status, 200);
  assert.equal((await call("GET", "/api/delight")).body.settings.pets.on, true, "the owner's switch was never changed");
});

/* ---------- integration review: a big history, and writes only when something changed ---------- */

test("a long history is counted a batch at a time, never all at once, and the past arrives quietly", async (t) => {
  const { app, call } = await fixture(t);
  const { eventBatch } = await import("../dist/achievement-tallies.js");
  await app.runtime.run({ prompt: "one" });
  const owner = app.runtime.owner, db = app.store.sqlite;
  const runId = db.prepare("SELECT id FROM tasks WHERE owner=? LIMIT 1").get(owner).id;
  const add = db.prepare("INSERT INTO events(run_id, kind, data, created_at) VALUES (?,?,?,?)");
  const many = eventBatch * 2 + 10;
  db.exec("BEGIN");
  for (let i = 0; i < many; i++) add.run(runId, "tool.completed", JSON.stringify({ name: "web.search" }), "2026-01-01T00:00:00Z");
  db.exec("COMMIT");
  await call("POST", "/api/delight/settings", { achievements: { on: true } });
  const scanned = () => app.store.get("settings", owner, "delight-achievements").data.scan;
  assert.ok(scanned().through <= eventBatch + 1000, "switching on read one batch, not the whole history");
  const views = [];
  for (let i = 0; i < 6; i++) {
    const view = (await call("GET", "/api/delight/achievements")).body;
    views.push(view);
    if (!view.behind) break;
  }
  assert.equal(views[0].behind, true, "the window is told the past is still being counted");
  assert.equal(views.at(-1).behind, false, "caught up in a few looks");
  assert.equal(scanned().tools["web.search"], many, "every event counted exactly once");
  const web = views.at(-1).list.filter((a) => a.id.startsWith("tool:web:"));
  assert.ok(web.some((a) => a.got), "the web lookups really earned something");
  assert.deepEqual(views.flatMap((v) => v.fresh).filter((a) => a.id.startsWith("tool:")), [], "the past arrived without a party");
  add.run(runId, "tool.completed", JSON.stringify({ name: "web.search" }), "2026-01-02T00:00:00Z");
  await call("GET", "/api/delight/achievements");
  assert.equal(scanned().tools["web.search"], many + 1, "a new event is added on the next look");
});

test("a report the record already holds is not written again", async (t) => {
  const { app, call } = await fixture(t);
  await call("POST", "/api/delight/settings", { achievements: { on: true } });
  const save = app.store.save.bind(app.store);
  let writes = 0;
  app.store.save = (table, owner, id, data) => { if (id === "delight-achievements") writes++; return save(table, owner, id, data); };
  t.after(() => { app.store.save = save; });
  await call("POST", "/api/delight/noticed", { what: "flag", flag: "still" });
  assert.equal(writes, 1);
  for (let i = 0; i < 5; i++) await call("POST", "/api/delight/noticed", { what: "flag", flag: "still" });
  assert.equal(writes, 1, "the same flag again changes nothing, so nothing is written");
  await call("GET", "/api/delight/achievements");
  const before = writes;
  await call("GET", "/api/delight/achievements");
  assert.equal(writes, before, "a look that finds nothing new writes nothing");
});

test("the tasks are counted by this computer's own clock, and counted again only when one finishes", async (t) => {
  const { app } = await fixture(t);
  const { achievementTallies } = await import("../dist/achievement-tallies.js");
  const owner = app.runtime.owner, db = app.store.sqlite;
  db.prepare("INSERT INTO sessions(id, owner, created_at) VALUES ('s-tally', ?, '2025-01-01T00:00:00Z')").run(owner);
  const add = db.prepare("INSERT INTO tasks(id, session_id, owner, prompt, status, output, created_at, updated_at, source) VALUES (?, 's-tally', ?, 'p', ?, '', ?, ?, ?)");
  const local = (...parts) => new Date(...parts).toISOString();
  add.run("t1", owner, "completed", local(2025, 11, 21, 0, 30), local(2025, 11, 21, 0, 31), "web");
  add.run("t2", owner, "completed", local(2025, 11, 20, 23, 50), local(2025, 11, 20, 23, 51), "schedule");
  add.run("t3", owner, "completed", local(2025, 11, 20, 12, 10), local(2025, 11, 20, 12, 11), "web");
  add.run("t4", owner, "cancelled", local(2025, 11, 22, 9, 0), local(2025, 11, 22, 9, 1), "web");
  const scan = { through: 0, tools: {}, events: {} };
  const first = achievementTallies(db, owner, scan).tallies;
  assert.equal(first.tasks, 3);
  assert.equal(first.stopped, 1);
  assert.deepEqual(first.days, ["2025-12-20", "2025-12-21"]);
  assert.deepEqual(first.hours, { "12": 1, "23": 1, "00": 1 });
  assert.deepEqual(first.weekdays, { "6": 2, "0": 1 }, "20 December 2025 is a Saturday, the 21st a Sunday");
  assert.deepEqual(first.bySource, { schedule: 1, web: 2 });
  assert.equal(first.solstice, 1, "the first hour of 21 December, by this computer's clock");
  add.run("t5", owner, "completed", local(2025, 11, 23, 5, 0), local(2025, 11, 23, 5, 1), "channel");
  const next = achievementTallies(db, owner, scan).tallies;
  assert.equal(next.tasks, 4, "a newly finished task is counted on the next look");
  assert.equal(next.bySource.channel, 1);
});

test("blob: is allowed for pictures and sound only, never for scripts, workers, frames, objects or connections", async (t) => {
  const { server } = await fixture(t);
  const policy = (await fetch(server.url)).headers.get("content-security-policy");
  const rules = Object.fromEntries(policy.split(";").map((rule) => rule.trim().split(/\s+/)).map(([name, ...values]) => [name, values]));
  assert.ok(rules["img-src"].includes("blob:"), "your own picture");
  assert.ok(rules["media-src"].includes("blob:"), "your own video, and answers read aloud");
  for (const name of ["default-src", "script-src", "worker-src", "connect-src", "frame-src", "child-src", "object-src", "manifest-src"])
    assert.ok(!(rules[name] ?? []).includes("blob:"), `${name} takes no blob:`);
  assert.equal(rules["frame-src"] ?? rules["child-src"], undefined, "frames fall back to default-src 'self'");
  assert.deepEqual(rules["default-src"], ["'self'"]);
});
