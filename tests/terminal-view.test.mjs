import test from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { renderScreen, wrapColumns, layoutInput } from "../dist/terminal-screen.js";
import { textWidth } from "../dist/terminal-canvas.js";
import { loadThemeCatalogue, paletteFor } from "../dist/terminal-theme.js";
import { loadWords } from "../dist/terminal-words.js";
import { glyphsFor, resolveStyle, stripAnsi } from "../dist/terminal-style.js";
import { MODEL_TABS, PANE_TABS, PLACES, SETTINGS_PAGES, STRIP_PLACES, allHomes, homeOf, parseRoute, placeById } from "../dist/terminal-places.js";
import { ESC, ScreenWriter } from "../dist/terminal-output.js";
import { LineEditor, takeMouse } from "../dist/terminal-input.js";
import { Tui } from "../dist/terminal-tui.js";
import { routeMouse } from "../dist/terminal-keys.js";
import { paletteItems } from "../dist/terminal-palette.js";
import { PLACE_ROWS } from "../dist/terminal-place-data.js";
import { offeredOn } from "../dist/devices/capabilities.js";
import { saveEmbedSettings } from "../dist/embeds.js";

const DOCS = new URL("../docs/places.md", import.meta.url);
const SNAPSHOTS = new URL("./fixtures/terminal-snapshots/", import.meta.url);
const UPDATE = process.env.BRANCH_UPDATE_SNAPSHOTS === "1";

/* ---------- the map is the window's map ---------- */
test("the terminal's homes are exactly the homes docs/places.md lists", async () => {
  const text = await readFile(DOCS, "utf8");
  const table = text.slice(text.indexOf("## The homes"), text.indexOf("## Features on their way"));
  const documented = [...table.matchAll(/^\| `([a-z:]+)` \|/gm)].map((match) => match[1]);
  assert.ok(documented.length >= 30, "the homes table was found");
  assert.deepEqual([...allHomes()].filter((home) => home !== "chat").sort(), [...documented].sort());
  for (const tab of ["Activity", "Plan", "Files", "Memory"]) assert.ok(PANE_TABS.some((entry) => entry.english === tab), `side pane tab ${tab}`);
  assert.match(text, /five places/, "the five places are still the rule");
  assert.deepEqual(PLACES.map((place) => place.english), ["Conversation", "Inbox", "Automations", "Library", "Customize"]);
});

/* Redesign: the window's lists now live in the new window (public/app/**): its places in shell/shell.js PLACES, its
   Settings pages in settings/settings.js NAV, the Models tabs in settings/pages/models.js TABS. The old window's
   public/layout.js, which the terminal's map was written against, is gone. This test holds the terminal to the new
   lists; while the terminal still shows the old map (src/terminal-places.ts, docs/places.md) it fails, on purpose. */
const SHELL = new URL("../public/app/shell/shell.js", import.meta.url);
const SETTINGS = new URL("../public/app/settings/settings.js", import.meta.url);
const MODELS = new URL("../public/app/settings/pages/models.js", import.meta.url);
test("the places, tabs, Settings pages and Models tabs match the window's own lists and words", async () => {
  const [shell, settings, models] = await Promise.all([SHELL, SETTINGS, MODELS].map((file) => readFile(file, "utf8")));
  const places = [...shell.slice(shell.indexOf("const PLACES = ")).split(";")[0].matchAll(/\["([a-z]+)", "[a-z]+", "([^"]+)"\]/g)]
    .map((match) => [match[1], match[2]]);
  assert.ok(places.length >= 5, "the window's places were read");
  assert.deepEqual([...PLACES.slice(1), ...STRIP_PLACES].map((place) => [place.id, place.english]).sort(), [...places].sort(),
    "the terminal's places are the window's, by id and name");
  const nav = settings.slice(settings.indexOf("export const NAV = "), settings.indexOf("];", settings.indexOf("export const NAV = ")));
  const pages = [...nav.matchAll(/\["([a-z0-9]+)", "([^"]+)"\]/g)].map((match) => [match[1], match[2]]);
  assert.ok(pages.length >= 15, "the window's Settings pages were read");
  assert.deepEqual(SETTINGS_PAGES.map((page) => [page.id, page.english]), pages, "Settings pages match the window's order");
  const tabs = [...models.slice(models.indexOf("const TABS = ")).split(";")[0].matchAll(/\["([a-z]+)", "([^"]+)"\]/g)].map((match) => [match[1], match[2]]);
  assert.deepEqual(MODEL_TABS.map((tab) => [tab.id, tab.english]), tabs, "the Models tabs are the window's");
  const english = JSON.parse(await readFile(new URL("../public/locales/en.json", import.meta.url), "utf8"));
  const french = JSON.parse(await readFile(new URL("../public/locales/fr.json", import.meta.url), "utf8"));
  const keys = [...PLACES, ...PLACES.flatMap((place) => place.tabs), ...SETTINGS_PAGES, ...MODEL_TABS, ...PANE_TABS].map((entry) => entry.key);
  for (const key of [...keys, ...SETTINGS_PAGES.map((page) => page.intro[0]), ...PLACES.map((place) => place.intro[0])]) {
    assert.ok(english[key], `English has ${key}`);
    assert.ok(french[key], `French has ${key}`);
  }
});

test("a place is found by its id, its English name or its French name", () => {
  const french = loadWords("fr");
  assert.deepEqual(parseRoute("inbox"), { place: "inbox", tab: "needs" });
  assert.deepEqual(parseRoute("inbox:finished"), { place: "inbox", tab: "finished" });
  assert.deepEqual(parseRoute("Made for you"), { place: "library", tab: "made" });
  assert.deepEqual(parseRoute("library made for you"), { place: "library", tab: "made" });
  assert.deepEqual(parseRoute("settings models defaults"), { settings: "models", sub: "defaults" });
  assert.deepEqual(parseRoute("settings:models:local"), { settings: "models", sub: "local" });
  assert.deepEqual(parseRoute("Computer & browser"), { settings: "computer", sub: "" });
  assert.deepEqual(parseRoute("settings"), { settings: "general", sub: "" });
  assert.deepEqual(parseRoute("Bibliothèque", french), { place: "library", tab: "memory" });
  assert.deepEqual(parseRoute("overview"), { place: "overview", tab: "here" });
  assert.deepEqual(parseRoute("household people"), { place: "household", tab: "people" });
  assert.deepEqual(parseRoute("parametres apparence", french), { settings: "appearance", sub: "" });
  assert.equal(parseRoute("nowhere at all"), null);
  for (const home of allHomes()) assert.equal(homeOf(parseRoute(home)), home, `${home} goes where it says`);
});

test("Ctrl+K includes the Overview and People strip homes", () => {
  const overview = paletteItems(loadWords("en"), [], "overview");
  const people = paletteItems(loadWords("en"), [], "people");
  assert.ok(overview.some((item) => item.run === "/go overview"), "Overview is directly discoverable");
  assert.ok(people.some((item) => item.run === "/go household"), "People is directly discoverable");
});

/* ---------- the drawing ---------- */
const FIXED_ROWS = [
  { title: "Write branch-demo.txt", detail: "files.write · branch-demo.txt", tone: "warn" },
  { title: "Tidy the garden notes", detail: "completed" },
  { title: "Weekly report", detail: "failed", tone: "bad" },
];
function model(route, extra = {}) {
  const words = extra.words ?? loadWords("en");
  return {
    words, glyphs: glyphsFor(extra.unicode ?? true), assistant: "Branch Agent", model: "Offline demonstration", lockdown: false,
    needs: 2, working: false, frame: 0, route, behind: { place: "inbox", tab: "needs" },
    focus: "place" in route && route.place === "chat" ? "composer" : "list",
    transcript: [], scroll: 0, composer: { text: "", cursor: 0, chips: ["Offline demonstration", "Ask before changes"] },
    status: "9.7k in / 168 out · no price on file", pane: { open: false, tab: "activity", rows: [] },
    oak: { show: false, season: "autumn" }, rows: FIXED_ROWS, selected: 0, loading: false, ask: "", overlay: undefined, ...extra,
  };
}
const TALK = [
  { kind: "you", text: "write the demo file" }, { kind: "step", text: "  · Writing branch-demo.txt" },
  { kind: "step", text: "  ok Writing branch-demo.txt" }, { kind: "ok", text: "Assistant:" },
  { kind: "assistant", text: "Demo fixture completed. The file is written, and nothing else was touched — 日本語 too." },
  { kind: "note", text: "[this answer: 9.7k in / 168 out · no price on file]" },
];
const VIEWS = {
  "chat-empty": () => model({ place: "chat", tab: "" }, { oak: { show: true, season: "autumn" } }),
  "chat-talk": () => model({ place: "chat", tab: "" }, { transcript: TALK, composer: { text: "and now the report", cursor: 18, chips: ["Offline demonstration", "Ask before changes", "+ notes.md"] },
    pane: { open: true, tab: "plan", rows: [{ title: "Writing branch-demo.txt", detail: "done", tone: "ok" }] } }),
  "chat-question": () => model({ place: "chat", tab: "" }, { transcript: [...TALK.slice(0, 2), { kind: "warn", text: "[Branch needs your yes before it goes on]" }],
    composer: { text: "", cursor: 0, chips: ["Offline demonstration"], question: "y/n/a/s?" }, lockdown: true }),
  "inbox-needs": () => model({ place: "inbox", tab: "needs" }),
  "automations-scheduled": () => model({ place: "automations", tab: "scheduled" }, { rows: [] }),
  "library-made": () => model({ place: "library", tab: "made" }, { focus: "ask", ask: "find last week's report" }),
  "customize-skills": () => model({ place: "customize", tab: "skills" }, { selected: 2 }),
  "settings-appearance": () => model({ settings: "appearance", sub: "" }, { rows: [{ title: "Theme: Forest", detail: "All 44 themes, shared with the window.", command: "/theme list" }, { title: "Light and dark: Dark" }], selected: 1 }),
  "settings-models-defaults": () => model({ settings: "models", sub: "defaults" }, { rows: [{ title: "● Offline demonstration", detail: "demo · demo", tone: "ok" }] }),
  palette: () => model({ place: "chat", tab: "" }, { overlay: { kind: "palette", query: "mod", items: paletteItems(loadWords("en"), [], "mod"), selected: 1 } }),
  help: () => model({ place: "inbox", tab: "history" }, { overlay: { kind: "help", offset: 0, lines: ["Esc, then 1-5: the places", "Ctrl+K: find anything"] } }),
  // phase2/everywhere: the rail, the question as a card, the conversation's title and the usage line.
  "chat-everywhere": () => model({ place: "chat", tab: "" }, {
    transcript: [TALK[0], TALK[1], { kind: "ask", text: "Branch needs your yes before it goes on" }, { kind: "askline", text: "Tool: files.write" },
      { kind: "askline", text: "Exactly: branch-demo.txt" }],
    composer: { text: "", cursor: 0, chips: ["Offline demonstration"], question: "y/n/a/s?" }, title: "write the demo file",
    rail: [{ kind: "computer", name: "Legion", detail: "This computer", on: true }, { kind: "phone", name: "Pixel", detail: "Paired", on: false },
      { kind: "trunk", name: "Scout", detail: "Research", on: false }],
    usage: { name: "ChatGPT plan", percentLeft: 12, note: "resets at 18:00" } }),
};
const SIZES = [[80, 24], [120, 40]];
const DEPTHS = ["truecolor", "ansi256", "ansi16", "none"];
const SGR_ALLOWED = {
  truecolor: /^(0|1|2|4|7|[34]8;2;\d+;\d+;\d+)$/,
  ansi256: /^(0|1|2|4|7|[34]8;5;\d+)$/,
  ansi16: /^(0|1|2|4|7|39|3[0-7]|9[0-7]|4[0-7]|10[0-7])$/,
};
function checkLine(line, depth, columns, where) {
  assert.equal(textWidth(stripAnsi(line)), columns, `${where}: every row is exactly the window's width, so nothing wraps`);
  if (depth === "none") return assert.ok(!line.includes("\x1b"), `${where}: no escape at all`);
  for (const [, params] of line.matchAll(/\x1b\[([0-9;]*)m/g))
    for (const token of params.match(/[34]8;5;\d+|[34]8;2;\d+;\d+;\d+|\d+/g) ?? [])
      assert.match(token, SGR_ALLOWED[depth], `${where}: ${token} is not a ${depth} colour`);
  assert.ok(!/\x1b\[(?![0-9;]*m)/.test(line), `${where}: a row carries colour only`);
}

test("every view draws at 80×24 and 120×40 in true colour, 256, 16 and no colour, and matches its snapshot", async () => {
  const table = await loadThemeCatalogue();
  const palette = paletteFor(table, "forest", "dark");
  await mkdir(SNAPSHOTS, { recursive: true });
  const hashesFile = new URL("colours.json", SNAPSHOTS);
  const saved = UPDATE ? {} : JSON.parse(await readFile(hashesFile, "utf8"));
  const hashes = {};
  for (const [name, build] of Object.entries(VIEWS))
    for (const [columns, rows] of SIZES) {
      const plainFile = new URL(`${name}-${columns}x${rows}.txt`, SNAPSHOTS);
      let plain;
      for (const depth of DEPTHS) {
        const frame = renderScreen(build(), { columns, rows }, palette, depth);
        assert.equal(frame.lines.length, rows);
        frame.lines.forEach((line, index) => checkLine(line, depth, columns, `${name} ${columns}x${rows} ${depth} row ${index}`));
        plain ??= frame.plain.join("\n") + "\n";
        assert.equal(frame.plain.join("\n") + "\n", plain, "the words are the same at every depth");
        hashes[`${name}-${columns}x${rows}-${depth}`] = createHash("sha256").update(frame.lines.join("\n")).digest("hex");
      }
      if (UPDATE) await writeFile(plainFile, plain);
      else assert.equal(plain, (await readFile(plainFile, "utf8")).replace(/\r\n/g, "\n"), `${name} at ${columns}x${rows} changed; rerun with BRANCH_UPDATE_SNAPSHOTS=1 if that was meant`);
    }
  if (UPDATE) await writeFile(hashesFile, JSON.stringify(hashes, null, 2) + "\n");
  else assert.deepEqual(hashes, saved, "the colours changed; rerun with BRANCH_UPDATE_SNAPSHOTS=1 if that was meant");
});

test("each view says where it is: the page in the head, the place on the tab row", async () => {
  const table = await loadThemeCatalogue();
  const palette = paletteFor(table, "nord", "light", "more");
  for (const home of allHomes()) {
    const route = parseRoute(home);
    const frame = renderScreen(model(route), { columns: 120, rows: 24 }, palette, "ansi16");
    const head = frame.plain[0];
    if ("settings" in route) {
      const page = SETTINGS_PAGES.find((entry) => entry.id === route.settings);
      assert.match(head, new RegExp(`Settings › ${page.english.replace(/&/g, "&")}`), home);
    } else {
      const place = placeById(route.place);
      assert.ok(head.includes(place.english), `${home}: ${head}`);
      const tab = place.tabs.find((entry) => entry.id === route.tab);
      if (tab) assert.ok(frame.plain.some((line) => line.includes(tab.english)), `${home} shows its tab`);
    }
    assert.match(frame.plain[1], /1 Conversation +2 Inbox 2 +3 Automations +4 Library +5 Customize/);
  }
});

test("every Settings page stays visible and clickable in a 120 by 24 terminal", async () => {
  const table = await loadThemeCatalogue();
  const palette = paletteFor(table, "forest", "dark");
  for (const page of SETTINGS_PAGES) {
    const frame = renderScreen(model({ settings: page.id, sub: page.id === "models" ? "connection" : "" }),
      { columns: 120, rows: 24 }, palette, "none");
    assert.ok(frame.plain.some((line) => line.includes(`› ${page.english}`)), `${page.english} has a visible current-page marker`);
    assert.ok(frame.hits.some((hit) => hit.action === `page:${page.id}`), `${page.english} can be selected with the mouse`);
  }
});

test("the mouse wheel over Settings navigation reaches pages outside the first window", () => {
  const steps = [];
  const tui = { route: { settings: "general", sub: "" }, overlay: undefined, rows: [], selected: 0,
    step: (by) => steps.push(by), requestDraw() {} };
  const hits = [{ x: 3, y: 2, width: 22, height: 1, action: "page:general" }];
  routeMouse(tui, { kind: "wheel-down", x: 4, y: 2, button: 65 }, hits);
  routeMouse(tui, { kind: "wheel-up", x: 4, y: 2, button: 64 }, hits);
  assert.deepEqual(steps, [1, -1], "wheel navigation moves through every Settings page instead of its body rows");
});

test("French is drawn in French, and ASCII is drawn when the terminal cannot show more", async () => {
  const table = await loadThemeCatalogue();
  const palette = paletteFor(table, "forest", "dark");
  const french = renderScreen(model({ place: "library", tab: "memory" }, { words: loadWords("fr"), rows: [] }), { columns: 100, rows: 24 }, palette, "truecolor");
  assert.match(french.plain[0], /Bibliothèque › Mémoire/);
  assert.match(french.plain.join("\n"), /Rien de retenu pour l'instant/);
  const ascii = renderScreen(model({ settings: "models", sub: "connection" }, { unicode: false, rows: [{ title: "Offline demonstration", detail: "demo" }] }), { columns: 80, rows: 24 }, palette, "ansi16");
  for (const line of ascii.plain) assert.ok(/^[\x20-\x7e]*$/.test(line), `not ASCII: ${line}`);
});

test("text wraps by columns, wide letters count twice, and the cursor lands where it was typed", () => {
  assert.deepEqual(wrapColumns("one two three", 7), ["one two", "three"]);
  assert.deepEqual(wrapColumns("abcdefghij", 4), ["abcd", "efgh", "ij"]);
  assert.equal(textWidth("日本"), 4);
  assert.deepEqual(layoutInput("hello\nworld", 8, 10), { lines: ["hello", "world"], cursor: { x: 2, y: 1 } });
  assert.deepEqual(layoutInput("abcdef", 6, 4), { lines: ["abcd", "ef"], cursor: { x: 2, y: 1 } });
});

/* ---------- the same bytes on Windows, macOS and Linux ---------- */
test("in a Windows-style environment the view writes only sequences Windows Terminal and the console understand", async () => {
  const table = await loadThemeCatalogue();
  const env = { WT_SESSION: "1", COLUMNS: "80", LINES: "24", PROMPT: "$P$G" };
  const style = resolveStyle(env, {}, "win32", "10.0.19045");
  assert.equal(style.depth, "truecolor");
  const output = new PassThrough();
  let written = "";
  output.on("data", (chunk) => { written += chunk.toString("utf8"); });
  const screen = new ScreenWriter(output);
  screen.enter("\x1b]0;Branch Agent\x07");
  screen.draw(renderScreen(model({ place: "chat", tab: "" }, { transcript: TALK }), { columns: 80, rows: 24 }, paletteFor(table, "forest", "dark"), style.depth));
  screen.setMouse(true);
  screen.leave();
  const kinds = new Set([...written.matchAll(/\x1b(\[[?0-9;]*[A-Za-z]|\][^\x07]*\x07)/g)].map((match) => match[1].replace(/[0-9;]+(?=[A-Za-z]$)/, "n").replace(/\][^\x07]*/, "]osc")));
  const understood = new Set(["[?nh", "[?nl", "[nH", "[nm", "[2J", "]osc\x07"]);
  for (const kind of kinds) assert.ok(understood.has(kind), `an escape Windows may not know: ${JSON.stringify(kind)}`);
  assert.ok(written.startsWith(ESC.enter), "the second screen, no wrapping, hidden cursor and bracketed paste come first");
  assert.ok(written.endsWith(ESC.leave), "and are all undone when leaving");
  assert.ok(!/\r?\n/.test(written.replace(/\x1b\][^\x07]*\x07/g, "")), "rows are placed by position, never by a line break Windows might turn into two");
  assert.ok(Buffer.from(written, "utf8").toString("utf8") === written, "everything is plain UTF-8");
});

test("the line editor lets the view take keys first, keeps a paste whole, and takes mouse reports out", async () => {
  const input = new PassThrough();
  const sent = [], seen = [], clicks = [];
  const handlers = {
    submit: (text) => sent.push(text), interrupt() {}, quit() {}, shortcut() {}, changed() {},
    key: (str, key) => { seen.push(key.name ?? str); return key.name === "escape" || key.name === "pageup"; },
  };
  const editor = new LineEditor(handlers);
  editor.attach(input, (event) => clicks.push(event));
  input.write("hi\x1b[5~");
  input.write("\x1b[200~one\rtwo\x1b[201~\r");
  input.write("\x1b[<0;12;3M\x1b[<65;1;1M");
  let quit = 0;
  handlers.quit = () => { quit += 1; };
  input.write("\x1b\x04");
  await delay(50);
  assert.equal(quit, 1, "Escape then Ctrl+D in quick succession still leaves");
  assert.deepEqual(sent, ["hione\ntwo"], "the paste's line break stayed in the line, the page key never reached it");
  assert.ok(seen.includes("pageup"));
  assert.deepEqual(clicks.map((event) => [event.kind, event.x, event.y]), [["press", 11, 2], ["wheel-down", 0, 0]]);
  assert.deepEqual(takeMouse("a\x1b[<64;5;5Mb").rest, "ab");
  editor.detach();
});

/* ---------- reaching every place from the running view ---------- */
async function running(t, env = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-term-view-"));
  const app = await createBranch({ workspace: join(root, "ws"), dataDir: join(root, "data") });
  const input = new PassThrough(), output = new PassThrough(), signals = new EventEmitter();
  let raw = "";
  output.on("data", (chunk) => { raw += chunk.toString(); });
  const tui = new Tui(app.runtime, { input, output, signals, app, pollIntervalMs: 5,
    env: { TERM: "xterm-256color", COLUMNS: "100", LINES: "30", LANG: "en_GB.UTF-8", ...env } });
  const done = tui.start();
  t.after(async () => {
    input.write("\x04");
    await done;
    await app.close();
    await discardTemp(root);
  });
  const settle = async () => { for (let i = 0; i < 20 && !tui.palette; i++) await delay(10); await delay(30); };
  await settle();
  return { app, tui, input, raw: () => raw, settle, text: () => stripAnsi(raw) };
}
const frameOf = (tui) => renderScreen(tui.model(), tui.size(), tui.palette, "none").plain.join("\n");

test("the terminal computer overview excludes Trunk conversations", async (t) => {
  const { app } = await running(t);
  app.trunks.setMode("trunks", { mode: "on" });
  const trunk = app.trunks.create({ name: "Ada" });
  const ownerRun = app.store.createRun(app.runtime.owner, "Owner task");
  app.store.finish(ownerRun.id, "completed", "done");
  const retiredRun = app.store.createRun(app.runtime.owner, "Retired Trunk task", trunk.chatSessionId);
  app.store.finish(retiredRun.id, "completed", "done");
  const current = app.trunks.retireChat(trunk.id);
  const trunkRun = app.store.createRun(app.runtime.owner, "Current Trunk task", current.chatSessionId);
  app.store.finish(trunkRun.id, "completed", "done");
  const rows = await PLACE_ROWS["overview:here"](app, loadWords("en"));
  assert.ok(rows.some((row) => row.title === "Owner task"), "this computer's work remains visible");
  assert.ok(rows.every((row) => !/Trunk task/.test(row.title)), "current and retired Trunk work stays in that Trunk");
});

test("the terminal overview reads only the active household profile's work", async (t) => {
  const { app } = await running(t);
  const ownerRun = app.store.createRun(app.runtime.owner, "Owner private task");
  app.store.finish(ownerRun.id, "completed", "done");
  const sam = app.store.profiles.create({ name: "Sam", pin: "2468" });
  app.store.profiles.switch({ profileId: sam.id, pin: "2468" });
  const samRun = app.store.createRun(app.store.profiles.scope(), "Sam task");
  app.store.finish(samRun.id, "completed", "done");
  const rows = await PLACE_ROWS["overview:here"](app, loadWords("en"));
  assert.deepEqual(rows.map((row) => row.title), ["Sam task"]);
  assert.deepEqual(rows.map((row) => row.sessionId), [samRun.sessionId]);
});

test("the terminal overview keeps authoritative active work ahead of more than 100 newer runs", async (t) => {
  const { app } = await running(t);
  const active = app.store.createRun(app.runtime.owner, "Still running");
  for (let index = 0; index < 101; index++) {
    const finished = app.store.createRun(app.runtime.owner, `Finished ${index}`);
    app.store.finish(finished.id, "completed", "done");
  }
  const rows = await PLACE_ROWS["overview:here"](app, loadWords("en"));
  assert.equal(rows.length, 12, "active work takes one of the recent-work slots");
  assert.equal(rows[0]?.sessionId, active.sessionId, "active work is never hidden behind newer finished tasks");
  assert.ok(rows.some((row) => row.title === "Still running"));

  const stale = app.store.createRun(app.runtime.owner, "Old question");
  app.store.finish(stale.id, "needs_input", "Answer me");
  const answered = app.store.createRun(app.runtime.owner, "Newer answer", stale.sessionId);
  app.store.finish(answered.id, "completed", "done");
  const tiedAt = new Date(Date.now() + 1000).toISOString();
  app.store.sqlite.prepare("UPDATE tasks SET created_at=? WHERE id IN (?,?)")
    .run(tiedAt, stale.id, answered.id);
  assert.deepEqual(app.store.runs(app.runtime.owner)
    .filter((run) => run.sessionId === stale.sessionId).map((run) => run.id), [answered.id, stale.id],
    "when timestamps tie, the later database row is still the newer run");
  const after = await PLACE_ROWS["overview:here"](app, loadWords("en"));
  assert.ok(after.every((row) => row.title !== "Old question"),
    "an older waiting run is not authoritative when its timestamp ties the newer completion");
});

test("the terminal People page shows a household profile only itself", async (t) => {
  const { app } = await running(t);
  const sam = app.store.profiles.create({ name: "Sam", pin: "2468" });
  app.store.profiles.create({ name: "Alex", pin: "1357" });
  app.store.profiles.switch({ profileId: sam.id, pin: "2468" });
  const rows = await PLACE_ROWS["household:people"](app, loadWords("en"));
  assert.deepEqual(rows.map((row) => row.title), ["Sam"]);
});

test("the Trunks Settings row opens the live Trunks roster, not specialist records", async (t) => {
  const { app, tui, settle } = await running(t);
  app.trunks.setMode("trunks", { mode: "on" });
  app.trunks.create({ name: "Ada", title: "Keeps the live roster" });
  app.store.save("specialists", app.runtime.owner, "specialist-only", { name: "Specialist only" });
  await tui.command("/go settings trunks");
  await settle();
  assert.equal(tui.rows[0]?.command, "/go customize specialists");
  await tui.command(tui.rows[0].command);
  await settle();
  assert.equal(homeOf(tui.route), "customize:specialists");
  assert.ok(tui.rows.some((row) => row.title === "Ada" && row.detail?.startsWith("Trunk ·")),
    "the real named Trunk appears from the live roster");
  assert.ok(tui.rows.some((row) => row.title === "Specialist only" && row.detail?.startsWith("Specialists ·")),
    "saved specialist templates remain visible but are not presented as Trunks");
});

test("the terminal hides owner Trunks from a household profile", async (t) => {
  const { app } = await running(t);
  app.trunks.setMode("trunks", { mode: "on" });
  const trunk = app.trunks.create({ name: "Ada" });
  const sam = app.store.profiles.create({ name: "Sam", pin: "2468" });
  app.store.profiles.switch({ profileId: sam.id, pin: "2468" });
  const rows = await PLACE_ROWS["customize:specialists"](app, loadWords("en"));
  assert.ok(rows.every((row) => row.title !== "Ada" && row.sessionId !== trunk.chatSessionId));
});

test("the terminal hides Trunk roster rows while Trunks are switched off", async (t) => {
  const { app } = await running(t);
  app.trunks.setMode("trunks", { mode: "on" });
  app.trunks.create({ name: "Ada" });
  app.store.save("specialists", app.runtime.owner, "specialist-only", { name: "Specialist only" });
  app.trunks.setMode("trunks", { mode: "off" });
  const rows = await PLACE_ROWS["customize:specialists"](app, loadWords("en"));
  assert.ok(rows.every((row) => row.title !== "Ada"), "a disabled Trunk is not exposed in the terminal");
  assert.ok(rows.some((row) => row.title === "Specialist only"), "ordinary specialist templates remain visible");
});

test("terminal Channels and Connections include devices, page bridges, and app accounts", async (t) => {
  const { app } = await running(t);
  app.devices.setMode({ mode: "on" });
  const pair = generateKeyPairSync("ed25519");
  const publicKey = pair.publicKey.export({ format: "der", type: "spki" }).toString("base64");
  const offer = app.devices.book.invite();
  const request = app.devices.book.redeem({ offer: offer.id, code: offer.code, name: "Kitchen Mac",
    platform: "darwin", publicKey, offers: offeredOn("darwin") });
  app.devices.book.decide(request.requestId, true);
  saveEmbedSettings(app.store, app.runtime.owner, { widget: true, extension: true,
    widgetSites: ["https://notes.example.com"] });
  await app.personal.setMode("google", { mode: "when-needed" });
  app.personal.signIns.google.save({ clientId: "branch-terminal-test" });

  const channels = await PLACE_ROWS["customize:channels"](app, loadWords("en"));
  assert.ok(channels.some((row) => row.title === "Kitchen Mac" && /Mac computer/.test(row.detail)),
    "the paired device is visible at the destination advertised by Settings");
  assert.ok(channels.some((row) => row.title === "Reaching Branch from other pages" && /notes\.example\.com/.test(row.detail)),
    "the configured widget and extension are visible there too");

  const connections = await PLACE_ROWS["customize:connections"](app, loadWords("en"));
  assert.ok(connections.some((row) => /^Google/.test(row.title) && /Not signed in yet/.test(row.detail)),
    "an app account does not disappear merely because no MCP server exists");
});

test("every place, tab and Settings page in docs/places.md opens from the terminal, by command and by key", async (t) => {
  const { tui, input, settle } = await running(t);
  for (const home of allHomes()) {
    await tui.command(`/go ${home}`);
    await settle();
    assert.equal(homeOf(tui.route), home, `/go ${home}`);
    const frame = frameOf(tui);
    const route = parseRoute(home);
    const name = "settings" in route ? SETTINGS_PAGES.find((page) => page.id === route.settings).english
      : placeById(route.place).english;
    assert.ok(frame.includes(name), `${home} shows ${name}`);
    if ("settings" in route && route.settings === "models") assert.ok(frame.includes(MODEL_TABS.find((tab) => tab.id === route.sub).english));
  }
  await tui.command("/go chat");
  tui.lastTab = { customize: "plugins" };
  input.write("\x1b");
  await delay(600);
  input.write("4");
  await settle();
  assert.equal(homeOf(tui.route), "library:memory", "Escape then 4 opens Library on its first tab");
  input.write("\x1b[C\x1b[C\x1b[C");
  await settle();
  assert.equal(homeOf(tui.route), "library:memory", "the right arrow walks the tabs, round from the last to the first");
  input.write("\x1b5");
  await settle();
  assert.equal(homeOf(tui.route), "customize:plugins", "Alt+5 opens Customize from anywhere, on the tab it was last left on");
  input.write("\x0b");
  await settle();
  input.write("appear");
  await settle();
  assert.equal(tui.overlay.kind, "palette");
  input.write("\r");
  await settle();
  assert.equal(homeOf(tui.route), "settings:appearance", "Ctrl+K finds a Settings page by name");
  input.write("\x1b[C");
  await settle();
  assert.equal(homeOf(tui.route), "settings:notifications", "the right arrow walks the Settings pages");
  input.write("\x1b");
  await delay(600);
  await settle();
  assert.equal(homeOf(tui.route), "customize:plugins", "Escape closes Settings onto the place it opened over");
});

test("Permissions explains the current Lockdown state", async (t) => {
  const { tui, settle } = await running(t);
  const lockdownRow = () => tui.rows.find((row) => row.command?.startsWith("/lockdown "));
  await tui.command("/go settings:permissions");
  await settle();
  assert.match(frameOf(tui), /Lockdown: off/);
  assert.equal(lockdownRow()?.detail, "Lockdown is off. Commands follow the permission rules above.");
  assert.doesNotMatch(frameOf(tui), /Lockdown is on\./);

  await tui.command("/lockdown on");
  await settle();
  assert.match(frameOf(tui), /Lockdown: on/);
  assert.equal(lockdownRow()?.detail, "Lockdown is on. Commands are refused; all else asks you.");
});

test("the theme changed in the terminal is the one saved for the window, and the side pane opens on demand", async (t) => {
  const { app, tui, input, settle, raw } = await running(t, { COLORTERM: "truecolor" });
  await tui.command("/theme nord");
  await settle();
  assert.equal((await import("../dist/terminal-theme.js")).readLook(app.store, app.runtime.owner).theme, "nord");
  assert.equal(tui.palette.theme, "nord");
  await tui.command("/theme light");
  await settle();
  assert.equal(tui.palette.mode, "light");
  assert.equal(app.store.get("settings", app.runtime.owner, "preferences").data.appearance, "daylight", "the window's light or dark is the same record");
  await tui.command("/theme list");
  assert.equal(tui.overlay.kind, "picker");
  input.write("\x1b[B");
  await settle();
  assert.notEqual(tui.palette.theme, "nord", "moving through the list shows each theme as it is passed");
  input.write("\x1b");
  await delay(600);
  await settle();
  assert.equal(tui.palette.theme, "nord", "Escape puts the saved theme back");
  input.write("\x10");
  await settle();
  assert.equal(tui.pane.open, true, "Ctrl+P opens the side pane");
  assert.match(frameOf(tui), /Activity +Plan +Files +Memory/);
  await tui.command("/switch mouse on");
  await settle();
  assert.ok(raw().includes(ESC.mouseOn), "clicks are asked for only once the owner switched them on");
  await tui.command("/lockdown on");
  await settle();
  assert.match(frameOf(tui), /Lockdown is on/);
  await tui.command("/lockdown off");
});
