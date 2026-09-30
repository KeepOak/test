/**
 * Dogfood: the weekday 8 AM automation made in the owner's app was meant to be "read-only, public web", but it was
 * stored with everything the owner holds: the screen, sending to chats, running programs, other computers. A schedule
 * now gets the least its words need; the screen, sending and running go in only when the owner names them; the confirm
 * card shows what is included; and one saved before this runs without those kinds.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { heldBack, leastPermissions, reachWords, saysReadOnly } from "../dist/schedule-reach.js";

const dogfoodWords = "Every weekday at 8am, read the merged pull requests of stabrea/Branch-Agent and summarise them. Read-only, public web.";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-schedule-least-"));
  const provider = { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close().catch(() => undefined); await app.close().catch(() => undefined); await discardTemp(root); });
  const call = async (path, body) => {
    const response = await fetch(`${server.url}/api/${path}`, { method: "POST",
      headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const held = app.registry.permissions();
  return { app, call, held };
}
const dangerous = (list) => list.filter((p) => p.startsWith("desktop.") || ["channels.send", "code.execute", "shell.execute", "remote.execute", "process.manage"].includes(p));
const dueAt = () => new Date(Date.now() + 86400000).toISOString();

test("the least a schedule's words need: read-only words read, others also write in the workspace, never send, run or see the screen", async (t) => {
  const { held } = await fixture(t);
  assert.ok(dangerous(held).length >= 3, "control: the owner holds the screen, sending and running");
  assert.equal(saysReadOnly(dogfoodWords), true);
  const reads = leastPermissions(dogfoodWords, held);
  assert.ok(reads.includes("web.read") && reads.includes("files.read"), "it can read the web and files");
  assert.ok(!reads.includes("files.write"), "read-only words write nothing");
  assert.deepEqual(reads.filter(heldBack), []);
  const writes = leastPermissions("Every morning, write a summary of the news into notes.md", held);
  assert.ok(writes.includes("files.write"), "writing words may write in the workspace");
  assert.deepEqual(writes.filter(heldBack), [], "never the screen, sending or running");
  assert.ok(!writes.some((p) => p.startsWith("schedules.") || p.endsWith(".manage")), "never schedules or settings");
  assert.match(reachWords(reads), /only reads.*cannot use your screen, send anything or run programs/);
  assert.match(reachWords(["files.read", "desktop.view"]), /You also let it: desktop\.view/);
});

test("the Automations box's proposal carries the least its words need and the card's words for it; confirming saves exactly that", async (t) => {
  const { app, call } = await fixture(t);
  const proposed = await call("schedules/propose", { text: dogfoodWords, timezone: "America/New_York" });
  assert.equal(proposed.status, 200, JSON.stringify(proposed.body));
  const { schedule, reach } = proposed.body.proposal;
  assert.deepEqual(dangerous(schedule.permissions), []);
  assert.ok(!schedule.permissions.includes("files.write"));
  assert.match(reach, /only reads/);
  const saved = await call("schedules", schedule);
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const record = app.store.get("schedules", app.runtime.owner, saved.body.id);
  assert.deepEqual(record.data.permissions, schedule.permissions, "what the card showed is what was saved");
});

test("a schedule that names no permissions gets the least, not everything the owner holds", async (t) => {
  const { app, call } = await fixture(t);
  const saved = await call("schedules", { prompt: dogfoodWords, kind: "task", dueAt: dueAt() });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const record = app.store.get("schedules", app.runtime.owner, saved.body.id);
  assert.deepEqual(dangerous(record.data.permissions), []);
  assert.notEqual(record.data.permissionsChosen, true);
});

test("the owner naming the screen or sending for a schedule keeps it; the list is theirs", async (t) => {
  const { app, call } = await fixture(t);
  const saved = await call("schedules", { prompt: "take a screenshot every hour", kind: "task", dueAt: dueAt(), permissions: ["desktop.view", "files.read"] });
  const record = app.store.get("schedules", app.runtime.owner, saved.body.id);
  assert.deepEqual(record.data.permissions, ["desktop.view", "files.read"]);
  assert.equal(record.data.permissionsChosen, true);
});

test("a schedule saved before this with everything runs without the screen, sending or running", async (t) => {
  const { app, held } = await fixture(t);
  const id = "0b1e5ab5-0000-4000-8000-000000000001";
  app.store.save("schedules", app.runtime.owner, id, { prompt: dogfoodWords, kind: "task", dueAt: dueAt(), permissions: held.filter((p) => !p.startsWith("schedules.")),
    status: "pending", history: [] });
  const run = await app.scheduler.trigger(app.runtime.owner, id, undefined, "local");
  const started = app.store.events(run.id).find((event) => event.kind === "run.started");
  assert.ok(started.data.permissions.includes("web.read"), "it still reads");
  assert.deepEqual(dangerous(started.data.permissions), [], "and no longer holds the screen, sending or running");
});

test("a Trunk's routine is made with the least its words need", async (t) => {
  const { app } = await fixture(t);
  const { on: trunksOn } = await import("./trunks-helpers.mjs");
  trunksOn(app);
  const trunk = app.trunks.create({ name: "Reviewer" });
  const made = app.trunks.routines.create(trunk.id, { name: "PRs", prompt: dogfoodWords, dailyAt: "08:00", timezone: "UTC" });
  const record = app.store.get("schedules", app.runtime.owner, made.id);
  assert.deepEqual(dangerous(record.data.permissions), []);
  assert.ok(!record.data.permissions.includes("files.write"));
});

test("a list the assistant names in the owner's own task keeps what Hermes Agent's cron jobs keep; anybody else's gets no screen, sending or running", async (t) => {
  const { app } = await fixture(t);
  const run = await app.runtime.run({ prompt: "hello" });
  const context = app.runtime.context({ runId: run.id });
  const named = ["web.read", "desktop.view", "channels.send", "code.execute"];
  const made = app.scheduler.create(context, { prompt: "check the page every hour", kind: "task", dueAt: dueAt(), permissions: named });
  const record = app.store.get("schedules", app.runtime.owner, made.id);
  // Owner ruling 2026-09-30: as `_resolve_cron_disabled_toolsets` in Hermes Agent, only sending, asking and scheduling are left out.
  assert.deepEqual(record.data.permissions, ["web.read", "desktop.view", "code.execute"], "the owner's own schedule keeps its tools");
  assert.equal(record.data.ownerMade, true);
  assert.notEqual(record.data.permissionsChosen, true, "and the list is not taken for one the owner picked by hand");
  const { underShortLivedKey } = await import("../dist/key-context.js");
  const keyed = await underShortLivedKey(() => app.runtime.run({ prompt: "hello" }));
  const theirs = underShortLivedKey(() => app.scheduler.create(app.runtime.context({ runId: keyed.id }),
    { prompt: "check the page every hour", kind: "task", dueAt: dueAt(), permissions: named }));
  const kept = app.store.get("schedules", app.runtime.owner, theirs.id);
  assert.deepEqual(kept.data.permissions, ["web.read"], "a short-lived key's schedule gets nothing held back");
  assert.notEqual(kept.data.ownerMade, true);
});

test("the owner's own mail and calendar are read only when the words are about them", async (t) => {
  const { held } = await fixture(t);
  if (!held.includes("personal.read")) return;
  assert.ok(!leastPermissions(dogfoodWords, held).includes("personal.read"), "public web work never reads the owner's mail");
  assert.ok(leastPermissions("every weekday at 8, check my inbox for invoices", held).includes("personal.read"));
});
