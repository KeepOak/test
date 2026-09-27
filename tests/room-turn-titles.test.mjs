/**
 * DESIGN-DIRECTION PR 2: Overview › Recent activity showed a room turn by its internal framing ("[Room "Month-end"] You
 * are @ledger, talking with…"). A room member's task now carries a plain title, the room's name and the message the turn
 * answers, and every task in GET /api/state (and GET /api/runs/:id/steps) is listed by `title`: the one the engine gave
 * it, else its prompt's first line. The window's lists read `title`. A scripted model; no provider.
 *
 * Mutation notes (each turns this file red):
 * - src/trunks/rooms.ts turn: drop `title` from the run options and the room turn is titled by its framing.
 * - src/server.ts state: drop `title` from each run and the titles are missing.
 * - src/store.ts runTitles: ignore `run.titled` and the room turn is titled by its framing.
 * - public/app/places/overview.js recentTile: read firstLine(r.prompt) again and the window check fails.
 * - public/app/places/inbox.js historyTab: search `r.title ?? r.prompt` and a request's later lines are no longer found.
 * - src/trunks/routines.ts route: drop `title` from the options and a Trunk's routine is titled "[Trunk @handle] name".
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

/** Each Trunk answers in a word; the introductions are answered too. */
const scripted = { name: "scripted", async complete(request) {
  const last = String(request.messages.at(-1)?.content ?? "");
  if (/Introduce yourself/.test(last)) return { content: "Hello.", toolCalls: [] };
  const me = /You are @([a-z0-9-]+)/.exec(last)?.[1];
  return { content: me === "scout" ? "(pass)" : "Fourteen of sixteen receipts match.", toolCalls: [] };
} };

test("PR2: a room turn is listed by the room and the message it answers, never by its framing", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-room-titles-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: scripted });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const api = async (path, body) => {
    const response = await fetch(`${server.url}${path}`, { method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const got = await response.json();
    assert.ok(response.ok, `${path}: ${JSON.stringify(got)}`);
    return got;
  };
  for (const part of ["trunks", "rooms"]) app.trunks.setMode(part, { mode: "on" });
  const [ledger, scout] = ["Ledger", "Scout"].map((name) => app.trunks.create({ name }));
  await app.trunks.introduced();
  const { room } = await api("/api/trunks/rooms", { name: "Month-end", members: [ledger.id, scout.id] });
  await api(`/api/trunks/rooms/${room.id}/send`, { text: "can we close September today?\nthe bank file is attached" });
  await app.trunks.rooms.settled(room.id);
  const own = await app.runtime.run({ prompt: "what is left for October?\nsecond line" });
  const runs = (await api("/api/state")).runs;
  const turns = runs.filter((run) => run.prompt.startsWith('[Room "Month-end"]'));
  assert.equal(turns.length, 2, `control: both Trunks took a turn ${JSON.stringify(runs.map((r) => r.prompt.slice(0, 40)))}`);
  for (const turn of turns) {
    assert.equal(turn.title, "Month-end: can we close September today?", "the room's name and the message it answers");
    const steps = await api(`/api/runs/${turn.id}/steps`);
    assert.equal(steps.title, turn.title, "the task's own page says the same");
  }
  for (const run of runs) {
    assert.equal(typeof run.title, "string", "every task has a title");
    assert.doesNotMatch(run.title, /^\[Room |You are @/, `never the framing: ${run.title}`);
  }
  assert.equal(runs.find((run) => run.id === own.id).title, "what is left for October?", "a task of the owner's own: its first line");
});

test("PR2: a Trunk's routine is listed by its own name, never by the words its schedule starts with", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-routine-titles-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: scripted });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  for (const part of ["trunks", "routines"]) app.trunks.setMode(part, { mode: "on" });
  const ledger = app.trunks.create({ name: "Ledger" });
  await app.trunks.introduced();
  const due = new Date(Date.now() + 60000);
  const routine = app.trunks.routines.create(ledger.id, { name: "Morning receipts", prompt: "Match yesterday's receipts\nand list the rest", dueAt: due.toISOString() });
  const [ran] = await app.scheduler.tick(new Date(due.getTime() + 60000));
  assert.ok(ran, "control: the routine ran");
  assert.match(ran.prompt, /^\[Trunk @ledger\] Morning receipts/, "control: its schedule's words name the Trunk");
  const response = await fetch(`${server.url}/api/state`, { headers: { authorization: `Bearer ${server.token}` } });
  const listed = (await response.json()).runs.find((run) => run.id === ran.id);
  assert.equal(listed?.title, "Morning receipts", `the routine's own name: ${JSON.stringify(listed?.title)}`);
  assert.equal(app.store.get("schedules", app.runtime.owner, routine.id).data.runCount, 1);
});

test("PR2: the window lists tasks by the engine's title", async () => {
  const read = (file) => readFile(new URL(`../public/app/places/${file}`, import.meta.url), "utf8");
  const overview = await read("overview.js"), inbox = await read("inbox.js");
  const recent = /function recentTile\(\) \{[\s\S]*?\n\}/.exec(overview)?.[0] ?? "";
  assert.match(recent, /esc\(r\.title \?\? firstLine\(r\.prompt\)\)/, "Overview › Recent activity");
  assert.doesNotMatch(overview, /esc\(firstLine\(r\.prompt\)\)/, "Overview never lists a task by its raw prompt");
  assert.doesNotMatch(inbox, /esc\(firstLine\(r\.prompt\)\)/, "Activity never lists a task by its raw prompt");
  const search = /function historyTab\(\) \{[\s\S]*?const shown = .*/.exec(inbox)?.[0] ?? "";
  assert.match(search, /\[r\.title, r\.prompt\]/, "History search still reads every line of what was asked, not only the title");
});
