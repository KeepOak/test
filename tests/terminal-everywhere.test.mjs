// phase2/everywhere: the terminal view in the window's design language (redesign "Branch, grown up", #44):
// the rail of this computer, paired devices and Trunks; the usage line; a question as a card; the key line;
// the conversation's title and the assistant's own name. What each shows is read only for the owner.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { renderScreen } from "../dist/terminal-screen.js";
import { loadThemeCatalogue, paletteFor } from "../dist/terminal-theme.js";
import { loadWords } from "../dist/terminal-words.js";
import { glyphsFor, stripAnsi } from "../dist/terminal-style.js";
import { railItems, resetText, usageBar } from "../dist/terminal-everywhere.js";
import { Tui } from "../dist/terminal-tui.js";

const words = loadWords("en");
const RAIL = [
  { kind: "computer", name: "Legion", detail: "This computer", on: true },
  { kind: "phone", name: "Pixel", detail: "Paired", on: false },
  { kind: "trunk", name: "Scout", detail: "Research", on: false },
];
const ASK = [
  { kind: "you", text: "compare the quotes" },
  { kind: "ask", text: "Branch needs your yes before it goes on" },
  { kind: "askline", text: "Tool: code.run" },
  { kind: "askline", text: "Exactly: python3 compare.py" },
];
function model(route, extra = {}) {
  return {
    words, glyphs: glyphsFor(extra.unicode ?? true), assistant: "Branch Agent", model: "Offline demonstration", lockdown: false,
    needs: 0, working: false, frame: 0, route, behind: { place: "inbox", tab: "needs" },
    focus: "place" in route && route.place === "chat" ? "composer" : "list", transcript: [], scroll: 0,
    composer: { text: "", cursor: 0, chips: ["Offline demonstration"] }, status: "0 in / 0 out", pane: { open: false, tab: "activity", rows: [] },
    oak: { show: false, season: "autumn" }, rows: [], selected: 0, loading: false, ask: "", ...extra,
  };
}
const CHAT = { place: "chat", tab: "" };
async function draw(view, size, depth = "none") {
  const palette = paletteFor(await loadThemeCatalogue(), "slate", "dark");
  return renderScreen(view, size, palette, depth);
}
async function fixture(t, extra = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-term-everywhere-"));
  const provider = { name: "scripted", async complete() { return { content: "Here it is.", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "ws"), dataDir: join(root, "data"), provider, ...extra });
  t.after(async () => { await app.close(); await discardTemp(root); });
  return app;
}
function reportLeft(app, remaining) {
  const preset = [...app.runtime.models.presets.keys()][0];
  app.runtime.models.health.recordSuccess(preset, 50, new Headers({
    "x-ratelimit-limit-requests": "100", "x-ratelimit-remaining-requests": String(remaining), "x-ratelimit-reset-requests": "2h0m0s",
  }));
}

/* ---------- the drawing ---------- */
test("the rail runs down the left of a wide terminal, one mark each, and stays out of narrow ones and Settings", async () => {
  const wide = await draw(model(CHAT, { rail: RAIL }), { columns: 120, rows: 30 });
  const marks = wide.plain.slice(2, 9).map((line) => line.slice(0, 4));
  assert.deepEqual(marks.filter((cell) => cell.trim() !== "│"), [" ▣ │", " ▯ │", " ◆ │"], "this computer, the phone, the Trunk, in order");
  assert.deepEqual(wide.hits.filter((hit) => hit.action.startsWith("rail:")).map((hit) => hit.action), ["rail:0", "rail:1", "rail:2"]);
  const narrow = await draw(model(CHAT, { rail: RAIL }), { columns: 80, rows: 24 });
  assert.ok(!narrow.plain.some((line) => line.includes("▯")), "an 80-column terminal keeps its width for the conversation");
  const settings = await draw(model({ settings: "general", sub: "" }, { rail: RAIL }), { columns: 120, rows: 30 });
  assert.ok(!settings.plain.some((line) => line.includes("▯")), "Settings is a window of its own, with no rail");
  const place = await draw(model({ place: "inbox", tab: "needs" }, { rail: RAIL }), { columns: 120, rows: 30 });
  assert.ok(place.plain.some((line) => line.startsWith(" ▯ │")), "each place keeps the rail too");
  const ascii = await draw(model(CHAT, { rail: RAIL, unicode: false }), { columns: 120, rows: 30 });
  assert.deepEqual(ascii.plain.slice(2, 9).map((line) => line.slice(0, 4)).filter((cell) => cell.trim() !== "|"), [" C |", " P |", " @ |"]);
  for (const line of ascii.plain.slice(2)) assert.ok(/^[\x20-\x7e]*$/.test(line.slice(0, 4)), `the rail is ASCII: ${line}`);
});

test("the usage line shows what the tightest connection has left as a bar, and nothing when nothing was reported", async () => {
  const usage = { name: "ChatGPT plan", percentLeft: 12, note: "resets at 18:00" };
  const frame = await draw(model(CHAT, { usage }), { columns: 100, rows: 24 });
  const line = frame.plain.find((row) => row.includes("ChatGPT plan"));
  assert.ok(line, "the usage line is drawn");
  assert.match(line, /ChatGPT plan +█{18}░{2} +12% left · resets at 18:00/, "18 of 20 cells used, 12% left");
  assert.equal(frame.plain.indexOf(line), 22, "it sits right above the foot");
  const ascii = await draw(model(CHAT, { usage, unicode: false }), { columns: 100, rows: 24 });
  assert.ok(ascii.plain.some((row) => /#{18}\.{2} +12% left/.test(row)), "ASCII draws the bar with # and .");
  const none = await draw(model(CHAT), { columns: 100, rows: 24 });
  assert.ok(!none.plain.some((row) => row.includes("% left")), "no report, no line and no guess");
  const tiny = await draw(model(CHAT, { usage }), { columns: 60, rows: 12 });
  assert.ok(!tiny.plain.some((row) => row.includes("% left")), "a very short terminal keeps its rows for the conversation");
  for (const depth of ["truecolor", "ansi16"]) {
    const coloured = await draw(model(CHAT, { usage: { ...usage, percentLeft: 3 } }), { columns: 100, rows: 24 }, depth);
    assert.equal(stripAnsi(coloured.lines[22]).length, 100, "every row is exactly the window's width");
  }
});

test("a question the task stopped on is drawn as one card with a warning edge", async () => {
  const frame = await draw(model(CHAT, { transcript: ASK }), { columns: 100, rows: 24 });
  const rows = frame.plain.filter((line) => /Branch needs your yes|Tool: code\.run|Exactly: python3/.test(line));
  assert.equal(rows.length, 3);
  for (const row of rows) assert.match(row, /^\s*│ (Branch needs|Tool|Exactly)/, `edge on: ${row}`);
  const ascii = await draw(model(CHAT, { transcript: ASK, unicode: false }), { columns: 100, rows: 24 });
  assert.ok(ascii.plain.some((line) => /^\s*\| Branch needs your yes/.test(line)));
});

test("a tall terminal shows the window's two key lines under the hints; the head names the conversation", async () => {
  const tall = await draw(model(CHAT, { title: "Compare the three quotes" }), { columns: 120, rows: 40 });
  // DG-155: the sample's terminal has two key lines, the message box's keys and then the places' keys.
  assert.match(tall.plain[39], /Esc, then 1-6 \(or Alt\+1 to Alt\+6\): Conversation, Inbox, Automations, Library, Customize, Team · Ctrl\+K or \/: find any/);
  assert.match(tall.plain[38], /Enter sends · Alt\+Enter adds a line · Up recalls · Ctrl\+E shows step details · Ctrl\+C stops the task · Ctrl\+D leaves/);
  assert.match(tall.plain[37], /Ctrl\+P Side pane/);
  assert.match(tall.plain[0], /Conversation › Compare the three quotes/);
  const short = await draw(model(CHAT), { columns: 120, rows: 24 });
  assert.doesNotMatch(short.plain[23], /Enter sends/, "24 rows keep one line of hints");
  const place = await draw(model({ place: "inbox", tab: "needs" }), { columns: 120, rows: 40 });
  assert.doesNotMatch(place.plain.join("\n"), /Alt\+Enter adds a line ·/, "the key line belongs to the conversation");
});

/* ---------- what is read, and for whom ---------- */
test("the rail lists this computer, the owner's devices and shown Trunks, and only this computer for anyone else", async (t) => {
  const app = await fixture(t);
  const devices = { book: { devices: () => [
    { name: "Pixel 9", platform: "android", lastSeen: "2026-09-19T08:30:00Z" },
    { name: "Mac mini", platform: "darwin", lastSeen: null },
  ] } };
  const everything = { store: app.store, runtime: app.runtime, devices };
  const off = railItems(everything, words, undefined, "legion");
  assert.deepEqual(off.map((item) => [item.kind, item.name, item.on]),
    [["computer", "legion", true], ["phone", "Pixel 9", false], ["computer", "Mac mini", false]], "Trunks switched off are not shown");
  assert.equal(off[1].detail, "Seen 2026-09-19 08:30");
  app.trunks.setMode("trunks", { mode: "on" });
  const scout = app.trunks.create({ name: "Scout", title: "Research" });
  const hidden = app.trunks.create({ name: "Quiet" });
  app.trunks.edit(hidden.id, { hidden: true });
  const on = railItems(everything, words, scout.chatSessionId, "legion");
  const trunks = on.filter((item) => item.kind === "trunk");
  assert.deepEqual(trunks.map((item) => item.name), ["Scout"], "a hidden Trunk stays off the rail");
  assert.ok(trunks[0].detail === "Research" && trunks[0].on, "Scout's own conversation marks Scout");
  assert.equal(on[0].on, false, "and not this computer");
  const person = app.store.profiles.create({ name: "Sam", pin: "1234" });
  app.store.profiles.switch({ profileId: person.id, pin: "1234" });
  try {
    assert.deepEqual(railItems(everything, words, undefined, "legion").map((item) => item.kind), ["computer"],
      "a household profile sees no devices and no Trunks");
    reportLeft(app, 12);
    assert.equal(usageBar(everything, words), undefined, "and no usage");
  } finally {
    app.store.profiles.switch({ profileId: null });
  }
});

test("the usage line follows the window's ring: the tightest share, hidden when the ring is hidden", async (t) => {
  const app = await fixture(t);
  assert.equal(usageBar(app, words), undefined, "nothing reported yet");
  reportLeft(app, 12);
  const bar = usageBar(app, words);
  assert.equal(bar.percentLeft, 12);
  assert.match(bar.note, /^resets (at \d\d:\d\d|on \d{4}-\d\d-\d\d)$/);
  app.store.save("settings", app.runtime.owner, "usage-glance", { ring: "hidden", saveProgress: "ask" });
  assert.equal(usageBar(app, words), undefined, "the owner hid the ring, so the terminal hides the line too");
  const now = Date.parse("2026-09-19T10:00:00");
  assert.equal(resetText(new Date(now + 3_600_000).toISOString(), words, now), "resets at 11:00");
  assert.equal(resetText(null, words, now), "");
  assert.equal(resetText("2026-09-21T10:00:00Z", loadWords("fr"), now), "se renouvelle le 2026-09-21");
});

test("in the running view a question shows as a card, Activity says it waits, and the answer is headed with the assistant's name", async (t) => {
  let asked = 0;
  const provider = { name: "scripted", async complete(request) {
    const last = request.messages[request.messages.length - 1];
    if (last.role === "tool") return { content: "Written.", toolCalls: [] };
    asked += 1;
    return { content: "", toolCalls: [{ id: `c${asked}`, name: "files.write", arguments: JSON.stringify({ path: "note.txt", content: "hi" }) }] };
  } };
  const app = await fixture(t, { provider });
  const input = new PassThrough(), output = new PassThrough(), signals = new EventEmitter();
  output.resume();
  const tui = new Tui(app.runtime, { input, output, signals, app, pollIntervalMs: 5,
    env: { TERM: "xterm-256color", COLUMNS: "120", LINES: "40", LANG: "en_GB.UTF-8" } });
  const done = tui.start();
  t.after(async () => { input.write("\x04"); await done; });
  for (let i = 0; i < 50 && !tui.palette; i++) await delay(10);
  await tui.command("/preset ask-before-changes");
  input.write("write a note for me\r");
  const frame = () => renderScreen(tui.model(), tui.size(), tui.palette, "none").plain.join("\n");
  for (let i = 0; i < 400 && !tui.conversation.awaiting; i++) await delay(10);
  assert.ok(tui.conversation.awaiting, "the task stopped on a question");
  assert.match(frame(), /│ Branch needs your yes before it goes on/);
  assert.match(frame(), /Conversation › write a note for me/);
  assert.ok(tui.conversation.paneRows("activity", words).some((row) => row.title === "Waiting for your yes" && row.tone === "warn"));
  assert.ok(frame().split("\n").some((line) => line.startsWith(" ▣ │")), "the rail shows this computer");
  input.write("y\r");
  for (let i = 0; i < 400 && !tui.conversation.transcript.some((line) => line.text === "Branch Agent:"); i++) await delay(10);
  assert.ok(tui.conversation.transcript.some((line) => line.kind === "ok" && line.text === "Branch Agent:"), "the answer is headed with the assistant's own name");
  assert.ok(!tui.conversation.paneRows("activity", words).some((row) => row.title === "Waiting for your yes"), "and Activity stops saying it waits");
});

test("a terminal that cannot be drawn on heads each answer with the assistant's name too", async (t) => {
  const app = await fixture(t);
  const input = new PassThrough(), output = new PassThrough(), signals = new EventEmitter();
  let printed = "";
  output.on("data", (chunk) => { printed += chunk.toString(); });
  const tui = new Tui(app.runtime, { input, output, signals, app, pollIntervalMs: 5, env: { TERM: "dumb", NO_COLOR: "1", COLUMNS: "80", LINES: "24" } });
  const done = tui.start();
  t.after(async () => { input.write("\x04"); await done; });
  await delay(50);
  input.write("hello\r");
  for (let i = 0; i < 400 && !printed.includes("Here it is."); i++) await delay(10);
  assert.match(printed, /Branch Agent:\r?\nHere it is\./);
  assert.doesNotMatch(printed, /Assistant:/);
});
