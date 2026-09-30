/* The owner's stress test, B001–B008: every switched-off message comes with its real switch, and a Trunk's model picker
   knows which connections a Trunk can use. The engine half runs a real engine; the window half reads the window's own
   files for the pieces that make each fix (design/redesign/tools/verify-stress-fixes.cjs drives them in a browser).
   design/redesign/tools/mutate-stress-fixes.mjs undoes each fix in turn and expects this file to go red. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

const read = (file) => readFile(new URL(`../${file}`, import.meta.url), "utf8");

async function engine(t) {
  const root = await mkdtemp(join(tmpdir(), "stress-fixes-"));
  const quiet = { name: "scripted", async complete() { return { content: "", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: quiet });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const call = async (method, path, body, key = server.token) => {
    const response = await fetch(new URL(path, server.url), { method, headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  };
  return { app, call };
}

test("B008 engine: the owner's Trunk may use a sign-in; a household person's is told why (trunkUse, for the caller)", async (t) => {
  const { app, call } = await engine(t);
  assert.equal((await call("POST", "/api/providers/cli-agents", { id: "claude-code" })).status, 200);
  const cli = async () => (await call("GET", "/api/state")).body.models.presets.find((p) => p.id === "cli-claude-code");
  const owners = await cli();
  assert.equal(owners.signIn, undefined, "no bare sign-in mark for the window to key on");
  if (owners.trunkUse === undefined) { t.skip("the engine gives no trunkUse yet (claude/trunks-use-subscriptions): nothing is greyed ahead"); return; }
  assert.deepEqual(owners.trunkUse, { ok: true }, "the owner's own Trunk may use the sign-in");
  assert.equal((await call("POST", "/api/people/settings", { mode: "on" })).status, 200);
  const sam = app.store.profiles.create({ name: "Sam", pin: "2468" });
  t.after(() => app.store.profiles.switch({ profileId: null }));
  app.store.profiles.switch({ profileId: sam.id, pin: "2468" });
  const sams = await cli();
  assert.equal(sams.trunkUse.ok, false, "a household person's Trunk may not");
  assert.ok(sams.trunkUse.reason.length > 0, "and the engine says why");
});

test("B001 B005 B006 B007 engine: each switch the window draws is the engine's route, read back by GET", async (t) => {
  const { app, call } = await engine(t);
  const run = app.store.createRun(app.runtime.owner, "Summarise the notes from Monday");
  app.store.finish(run.id, "completed", "Three points.");
  // The owner's rule (ships on, 2026-09-26): recordings and prompts start on; procedures stay off. The board is Orchard
  // now, and the owner's rule of 2026-09-27 ships it "when needed" (src/flows-boards/settings.ts boardShipsOn).
  const shipped = { recordings: "when-needed", "prompts/settings": "on", "autonomy/switch": "off", "flows-boards/switch": "when-needed" };
  const window = await read("public/app/places/switch-on.js");
  const routes = [
    ["recordings", "/api/recordings", { mode: "when-needed" }, async () => (await call("GET", "/api/recordings")).body.settings.mode],
    ["prompts/settings", "/api/prompts/settings", { mode: "when-needed" }, async () => (await call("GET", "/api/prompts")).body.settings.mode],
    ["autonomy/switch", "/api/autonomy/switch", { part: "procedures", mode: "when-needed" }, async () => (await call("GET", "/api/autonomy")).body.modes.procedures],
    ["flows-boards/switch", "/api/flows-boards/switch", { part: "kanban", mode: "when-needed" }, async () => (await call("GET", "/api/flows-boards")).body.modes.kanban],
  ];
  for (let [name, path, body, mode] of routes) {
    const literal = `{ ${Object.entries(body).filter(([k]) => k !== "confirmLoosening").map(([k, v]) => `${k}: "${v}"`).join(", ")} }`;
    assert.ok(window.includes(`post: ["${name}", ${literal}]`), `the window switches ${name} with ${literal}`);
    assert.equal(await mode(), shipped[name], `${name} ships ${shipped[name]}`);
    if (shipped[name] !== "off") {
      // The ship-on rule turns this part on; this test is about the window's switch turning it on from off.
      assert.equal((await call("POST", path, { ...body, mode: "off" })).status, 200);
      assert.equal(await mode(), "off", `${name} switched off through its own route`);
    }
    if (name === "recordings") assert.equal((await call("GET", `/api/runs/${run.id}/recording`)).status, 403, "switched off, a recording is refused");
    if (name === "autonomy/switch") {
      assert.equal((await call("POST", path, body)).status, 409, "procedures loosen approvals, so the owner's yes is asked first");
      assert.equal(await mode(), "off");
      body = { ...body, confirmLoosening: true };
    }
    assert.equal((await call("POST", path, body)).status, 200);
    assert.equal(await mode(), "when-needed", `${name} is on after the window's call`);
  }
  const played = await call("GET", `/api/runs/${run.id}/recording`);
  assert.equal(played.status, 200, "a task that ran while recordings were off plays once they are on");
  assert.ok(played.body.frames.length > 0);
});

test("the switch is drawn for the owner only; anyone else reads who can switch it on", async () => {
  const src = await read("public/app/places/switch-on.js");
  assert.match(src, /const act = ownerHere\(\)\s*\? `<button class="btn pri sm" type="button" data-act="switch-on"/);
  assert.match(src, /if \(mode === "off"\) throw new Error/, "a switch the engine kept off is not believed");
});

test("B001 History and Watch again: the sentence comes with the switch", async () => {
  const src = await read("public/app/places/inbox.js");
  assert.match(src, /if \(recMode === "off" && \(E\.state\.runs \?\? \[\]\)\.length\) return/, "History's tile while off");
  assert.match(src, /openDlg\(\{ title: t\("recordings\.title"\), body: recordingsOff\(error\.message\) \}\)/, "Watch again while off");
  assert.match(src, /if \(id && dialog\(\)\?\.querySelector\('\[data-off="recordings"\]'\)\) openReplay\(id\)/, "switched on, it plays");
});

test("B002 Add waits for words; B005 prompts: switch before the form, Save validated", async () => {
  const auto = await read("public/app/places/automations.js");
  assert.match(auto, /data-act="nl-add"\$\{boxEmpty\(\)\}/);
  assert.match(auto, /data-act="trig-add"\$\{boxEmpty\(\)\}/);
  assert.match(auto, /if \(add\) add\.disabled = !e\.target\.value\.trim\(\)/);
  assert.match(auto, /\$\{promptsOff\(\) \? offTile\("prompts"/);
  assert.match(auto, /data-act="prompt-new"\$\{promptsOff\(\) \? ` disabled data-tip=/);
  const prompts = await read("public/app/flows/prompts.js");
  assert.match(prompts, /data-act="prompt-save" disabled>/);
  assert.match(prompts, /if \(!filled\(\)\) \{/);
});

test("B006 triggers and B007 board: the switch where the words are", async () => {
  const auto = await read("public/app/places/automations.js");
  assert.match(auto, /\$\{proceduresMode === "off" \? offTile\("procedures"/);
  // The board's tab is drawn by Orchard (places/orchard.js), which keeps the same switch where the words are.
  assert.match(await read("public/app/places/orchard.js"), /O\.problem \? offTile\("board", O\.problem\)/);
});

test("B003 and B004: greyed controls say why, steps in plain words", async () => {
  const orders = await read("public/app/places/automations17.js");
  assert.match(orders, /"orderaddb17", "sw:order-in-b17"/, "Add it and its box are live");
  assert.match(orders, /S\.drafts\.new = t\("window\.switch-on\.order-ask"/);
  const flow = await read("public/app/flows/flow-editor.js");
  assert.match(flow, /text: toolWords\.get\(s\.tool\) \|\| s\.tool/, "a step reads as its tool's description");
  assert.doesNotMatch(flow, /window\.flows\.coming-soon/, "nothing in the editor greys as Coming soon");
  assert.match(flow, /WHY\(t\("window\.switch-on\.recipe-run-why"\)\)/);
});

test("B008 window: a Trunk's picker greys sign-in connections, and a message is held back with its words kept", async () => {
  const trunk = await read("public/app/flows/trunk.js");
  assert.match(trunk, /\[p\.id, p\.name, !trunkCanUse\(p\)\]/);
  assert.match(trunk, /gsel\(\{ id: "tm-model-sel"/, "the window's own dropdown (core/gsel.js), not a floating grid");
  const chips = await read("public/app/chat/chips.js");
  assert.match(chips, /\$\{trunk && !trunkCanUse\(x\) \? " disabled" : ""\}/);
  const chat = await read("public/app/chat/chat.js");
  assert.match(chat, /if \(trunkModelRefused\(\)\) \{ S\.drafts\[C\.sessionId \?\? "new"\] = prompt; showModelMenu\(\); return; \}/);
  const note = await read("public/app/places/switch-on.js");
  assert.match(note, /export const trunkCanUse = \(preset\) => !preset\?\.trunkUse \|\| preset\.trunkUse\.ok === true;/,
    "greyed only when the engine says this caller may not (trunkUse ok:false); with no answer, nothing greyed");
  assert.doesNotMatch(note, /\.signIn\b/, "never keyed on being a sign-in");
  assert.match(note, /\.filter\(\(p\) => !trunkCanUse\(p\)\)\.map\(\(p\) => p\.trunkUse\.reason\)/, "the note gives the engine's reason");
});

/* Review of #442: "Procedures that start themselves" run their steps without a yes each time, so switching them on is held
   to the rule every loosening setting follows (src/policy-change-guard.ts looseningRefusal), as #416 and #429 did.
   Mutations: drop the check in src/autonomy/api.ts (switchLooser answers null) → red here; move the confirm above
   Lockdown → red at "under Lockdown"; the window resending without confirmLoosening → red at the window test. */
const tick = 'Tick "Yes, make it less careful" to go ahead.';
const procWords = "This makes Branch less careful: procedures would start by themselves and run their steps without asking you first. " + tick;
const lockdownWords = "Lockdown is on, so settings cannot be changed from here. Turn it off first.";

test("B006 procedures: switching on asks for the owner's yes, Lockdown refuses it even then, off always goes through", async (t) => {
  const { call } = await engine(t);
  const procs = async () => (await call("GET", "/api/autonomy")).body.modes.procedures;
  for (const mode of ["when-needed", "on"]) {
    const refused = await call("POST", "/api/autonomy/switch", { part: "procedures", mode });
    assert.equal(refused.status, 409, mode);
    assert.equal(refused.body.error, procWords, "the engine's own words");
  }
  assert.equal(await procs(), "off", "nothing saved without the yes");
  assert.notEqual((await call("POST", "/api/autonomy/switch", { part: "procedures", mode: "on", confirmLoosening: "yes" })).status, 200);
  assert.equal((await call("POST", "/api/lockdown", { on: true })).status, 200);
  const locked = await call("POST", "/api/autonomy/switch", { part: "procedures", mode: "when-needed", confirmLoosening: true });
  assert.equal(locked.status, 409);
  assert.equal(locked.body.error, lockdownWords);
  assert.equal((await call("POST", "/api/autonomy/switch", { part: "procedures", mode: "off" })).status, 200, "off under Lockdown");
  assert.equal((await call("POST", "/api/lockdown", { on: false })).status, 200);
  assert.equal(await procs(), "off", "Lockdown kept it off");
  assert.equal((await call("POST", "/api/autonomy/switch", { part: "procedures", mode: "when-needed", confirmLoosening: true })).status, 200);
  assert.equal(await procs(), "when-needed", "read back: the owner's yes switched it on");
  assert.equal((await call("POST", "/api/autonomy/switch", { part: "procedures", mode: "on" })).status, 200, "between its on modes is not held");
  assert.equal((await call("POST", "/api/autonomy/switch", { part: "procedures", mode: "off" })).status, 200, "off needs no yes");
  assert.equal(await procs(), "off");
  assert.equal((await call("POST", "/api/autonomy/switch", { part: "orders", mode: "on" })).status, 200, "a part that only asks is not held");
});

test("B006 procedures: a household person, the owner's short-lived key and a person's own key are refused, even with the yes", async (t) => {
  const { app, call } = await engine(t);
  t.after(() => app.store.profiles.switch({ profileId: null }));
  assert.equal((await call("POST", "/api/people/settings", { mode: "on" })).status, 200);
  const sam = app.store.profiles.create({ name: "Sam", pin: "2468" });
  const ownersKey = app.sessionTokens.create(app.runtime.owner, { name: "script", scope: "run", minutes: 5 }).token;
  const samsKey = app.people.keys.issue(sam.id, 60, "pin", "test").key;
  const loosen = { part: "procedures", mode: "when-needed", confirmLoosening: true };
  for (const [who, key] of [["the owner's short-lived key", ownersKey], ["Sam's own key", samsKey]]) {
    const answer = await call("POST", "/api/autonomy/switch", loosen, key);
    assert.ok(answer.status >= 400 && answer.status < 500, `${who}: ${answer.status}`);
  }
  app.store.profiles.switch({ profileId: sam.id, pin: "2468" });
  const atWindow = await call("POST", "/api/autonomy/switch", loosen);
  assert.ok(atWindow.status >= 400 && atWindow.status < 500, `Sam at the window: ${atWindow.status}`);
  app.store.profiles.switch({ profileId: null });
  assert.equal((await call("GET", "/api/autonomy")).body.modes.procedures, "off", "none of them switched it on");
});

test("B006 window: the procedures switch shows the engine's words and sends the yes only from its confirm", async () => {
  const src = await read("public/app/places/switch-on.js");
  assert.match(src, /await api\(path, confirmLoosening \? \{ \.\.\.body, confirmLoosening: true \} : body\)/);
  assert.match(src, /if \(!confirmLoosening && \/less careful\/\.test\(error\.message\)\) \{ askLoosening\(key, error\.message\); return; \}/);
  assert.match(src, /on\("switch-on-yes", \(el\) => \{ closeDlg\(\); switchOn\(el, true\); \}\)/);
  assert.match(src, /<p>\$\{esc\(words\)\}<\/p>/, "the engine's words, escaped");
});
