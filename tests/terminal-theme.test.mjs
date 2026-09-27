import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import {
  colourCode, detectDepth, detectUnicode, loadThemeCatalogue, lookApi, lookLanguage, lookMode, nearest16, nearest256,
  over, paletteFor, parseColour, readLook, saveLook, saveLookMode, saveTerminalSwitch, terminalMode, terminalSwitches,
} from "../dist/terminal-theme.js";
import { glyphsFor, resolveStyle } from "../dist/terminal-style.js";

/*
 * The terminal's colours and what it may draw, decided from the environment alone. Every platform
 * is tested on every machine: the platform is a parameter, never the machine the test runs on.
 */
const WINDOWS_TERMINAL = { WT_SESSION: "5b0c0a3e-0000-4000-8000-000000000000", PROMPT: "$P$G", ComSpec: "C:\\Windows\\system32\\cmd.exe" };
const POWERSHELL_CONSOLE = { PSModulePath: "C:\\Program Files\\WindowsPowerShell\\Modules" };

test("colour depth follows COLORTERM, TERM, NO_COLOR and FORCE_COLOR on every platform", () => {
  const cases = [
    [{ COLORTERM: "truecolor", TERM: "xterm-256color" }, "linux", "", "truecolor"],
    [{ TERM: "xterm-256color" }, "linux", "", "ansi256"],
    [{ TERM: "xterm" }, "linux", "", "ansi16"],
    [{ TERM: "linux" }, "linux", "", "ansi16"],
    [{ TERM: "dumb" }, "linux", "", "none"],
    [{}, "linux", "", "none"],
    [{ TERM_PROGRAM: "Apple_Terminal", TERM: "xterm-256color" }, "darwin", "", "ansi256"],
    [{ TERM_PROGRAM: "iTerm.app", TERM: "xterm-256color" }, "darwin", "", "truecolor"],
    [{ TERM: "xterm-256color", NO_COLOR: "1" }, "darwin", "", "none"],
    [{ TERM: "xterm", FORCE_COLOR: "3" }, "linux", "", "truecolor"],
    [{ TERM: "xterm-256color", FORCE_COLOR: "0" }, "linux", "", "none"],
    [{ TERM: "xterm", BRANCH_COLOR: "256" }, "linux", "", "ansi256"],
    [WINDOWS_TERMINAL, "win32", "10.0.22631", "truecolor"],
    [POWERSHELL_CONSOLE, "win32", "10.0.19045", "truecolor"],
    [{}, "win32", "10.0.10586", "ansi256"],
    [{}, "win32", "6.1.7601", "ansi16"],
    [{ TERM: "cygwin" }, "win32", "10.0.19045", "ansi16"],
  ];
  for (const [env, platform, release, expected] of cases)
    assert.equal(detectDepth(env, platform, release), expected, `${JSON.stringify(env)} on ${platform} ${release}`);
});

test("box lines and the ellipsis are used wherever the terminal can show them, ASCII elsewhere", () => {
  assert.equal(detectUnicode({}, "win32"), true, "Node writes the Windows console as UTF-16, whatever the code page");
  assert.equal(detectUnicode(WINDOWS_TERMINAL, "win32"), true);
  assert.equal(detectUnicode({ LANG: "en_GB.UTF-8" }, "linux"), true);
  assert.equal(detectUnicode({ LANG: "C" }, "linux"), false);
  assert.equal(detectUnicode({ TERM: "linux", LANG: "en_US.UTF-8" }, "linux"), false, "the Linux console has no box font");
  assert.equal(detectUnicode({}, "darwin"), true);
  assert.equal(detectUnicode({ BRANCH_ASCII: "1" }, "darwin"), false);
  for (const [name, value] of Object.entries(glyphsFor(false)))
    for (const text of [value].flat()) assert.ok(/^[\x20-\x7e]*$/.test(text), `ASCII glyph ${name} has ${JSON.stringify(text)}`);
});

test("the style carries the depth, and a plain terminal gets no colour and no cursor movement", () => {
  const windows = resolveStyle(WINDOWS_TERMINAL, { columns: 120, rows: 30 }, "win32", "10.0.22631");
  assert.deepEqual([windows.depth, windows.unicode, windows.cursor, windows.columns, windows.rows], ["truecolor", true, true, 120, 30]);
  const conhost = resolveStyle(POWERSHELL_CONSOLE, {}, "win32", "10.0.19045");
  assert.equal(conhost.depth, "truecolor");
  const plain = resolveStyle({ NO_COLOR: "1" }, {}, "linux", "");
  assert.deepEqual([plain.depth, plain.cursor, plain.color], ["none", false, false]);
  const forced = resolveStyle({ TERM: "dumb", FORCE_TTY: "1", COLORTERM: "truecolor" }, {}, "linux", "");
  assert.deepEqual([forced.depth, forced.cursor, forced.decorations, forced.color], ["truecolor", true, true, true],
    "an explicit full terminal view overrides an inherited TERM=dumb without hiding its colour capability");
  for (const choice of [{ FORCE_COLOR: "0" }, { BRANCH_COLOR: "none" }]) {
    const colourless = resolveStyle({ TERM: "dumb", FORCE_TTY: "1", ...choice }, {}, "linux", "");
    assert.deepEqual([colourless.depth, colourless.cursor, colourless.decorations, colourless.color], ["none", true, true, false],
      `${JSON.stringify(choice)} keeps the forced terminal interactive without adding colour`);
  }
  const unknown = resolveStyle({}, {}, "linux", "");
  assert.equal(unknown.depth, "ansi16", "a terminal that asked for the view gets at least sixteen colours");
});

test("every one of the 44 themes gives a full terminal palette in light and dark, at both contrasts", async () => {
  const table = await loadThemeCatalogue();
  assert.equal(table.THEMES.length, 44);
  const roles = ["ground", "panel", "raised", "text", "muted", "faint", "line", "accent", "accentText", "onAccent", "accentTint", "ok", "warn", "bad"];
  for (const theme of table.THEMES)
    for (const mode of ["dark", "light"])
      for (const contrast of ["standard", "more"]) {
        const palette = paletteFor(table, theme[0], mode, contrast);
        assert.equal(palette.theme, theme[0]);
        for (const role of roles) {
          const value = palette[role];
          assert.ok(Array.isArray(value) && value.length === 3 && value.every((v) => Number.isInteger(v) && v >= 0 && v <= 255), `${theme[0]} ${mode} ${role}`);
        }
      }
  const forest = paletteFor(table, "forest", "dark");
  assert.deepEqual(forest.ground, [3, 20, 11], "Forest's ground is the window's #03140B");
  assert.deepEqual(forest.accent, [224, 112, 51], "copper is the window's #E07033");
  assert.equal(paletteFor(table, "no-such-theme", "dark").theme, "slate", "an unknown theme falls back to the default, Slate (redesign phase 1)");
});

test("colours are written for each depth, and see-through colours are laid over the ground", () => {
  assert.deepEqual(parseColour("#E07033"), { rgb: [224, 112, 51], alpha: 1 });
  assert.deepEqual(parseColour("rgba(237,241,234,.5)"), { rgb: [237, 241, 234], alpha: 0.5 });
  assert.equal(parseColour("color-mix(in srgb, red, blue)"), null);
  assert.deepEqual(over("rgba(255,255,255,.5)", [0, 0, 0]), [128, 128, 128]);
  assert.equal(colourCode("truecolor", [1, 2, 3], "fg"), "38;2;1;2;3");
  assert.equal(colourCode("truecolor", [1, 2, 3], "bg"), "48;2;1;2;3");
  assert.equal(colourCode("ansi256", [255, 0, 0], "fg"), "38;5;196");
  assert.equal(colourCode("ansi256", [128, 128, 128], "bg"), "48;5;244");
  assert.equal(colourCode("ansi16", [230, 0, 0], "fg"), "91");
  assert.equal(colourCode("ansi16", [0, 0, 0], "bg"), "40");
  assert.equal(colourCode("none", [0, 0, 0], "fg"), "");
  assert.ok(nearest256([3, 20, 11]) >= 16, "256-colour choices keep off the sixteen the terminal may have re-themed");
  assert.equal(nearest16([237, 241, 234]), 7, "Forest's text is the light grey every terminal has");
});

async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-term-theme-"));
  const app = await createBranch({ workspace: join(root, "ws"), dataDir: join(root, "data") });
  t.after(async () => { await app.close(); await discardTemp(root); });
  return app;
}

test("the terminal and the window share one theme record, and each change says who made it", async (t) => {
  const app = await workspace(t);
  const { store } = app, owner = app.runtime.owner;
  // Redesign phase 1 (owner decision): Slate is the default; Forest stays one of the 44.
  assert.deepEqual(readLook(store, owner), { theme: "slate", contrast: "standard", language: "auto", changedAt: "", changedBy: "" });
  const saved = await saveLook(store, owner, { theme: "nord" }, new Date("2026-09-17T10:00:00Z"));
  assert.deepEqual([saved.theme, saved.changedBy, saved.changedAt], ["nord", "terminal", "2026-09-17T10:00:00.000Z"]);
  await assert.rejects(saveLook(store, owner, { theme: "neon-nonsense" }), /no theme called neon-nonsense/);
  await assert.rejects(saveLook(store, owner, { theme: "../../etc" }));
  const fromWindow = await lookApi(store, owner, "POST", async () => ({ contrast: "more", changedBy: "terminal" }));
  assert.deepEqual([fromWindow.theme, fromWindow.contrast, fromWindow.changedBy], ["nord", "more", "window"], "the route always records the window");
  assert.equal((await lookApi(store, owner, "GET", async () => ({}))).contrast, "more");
});

test("the shared look takes every language the window lists, Spanish included, and refuses one it does not have", async (t) => {
  const app = await workspace(t);
  const { store } = app, owner = app.runtime.owner;
  const { LANGUAGES } = await import("../public/i18n.js");
  for (const { id } of LANGUAGES) {
    const saved = await lookApi(store, owner, "POST", async () => ({ language: id }));
    assert.equal(saved.language, id, `/api/look keeps ${id}`);
    assert.equal((await lookApi(store, owner, "GET", async () => ({}))).language, id);
  }
  assert.ok(LANGUAGES.some((l) => l.id === "es" && l.label === "Español"), "Spanish is listed as Español");
  await assert.rejects(lookApi(store, owner, "POST", async () => ({ language: "xx" })));
  assert.equal(readLook(store, owner).language, LANGUAGES.at(-1).id, "a refused language changes nothing");
  assert.equal(lookLanguage({ language: "es" }, {}), "es");
  assert.equal(lookLanguage({ language: "auto" }, { LANG: "es_MX.UTF-8" }), "es");
  assert.equal(lookLanguage({ language: "auto" }, { LC_ALL: "es_ES.UTF-8", LANG: "en_US.UTF-8" }), "es");
});

test("light or dark is the window's own record, and following the computer reads the terminal", async (t) => {
  const app = await workspace(t);
  const { store } = app, owner = app.runtime.owner;
  store.save("settings", owner, "preferences", { appearance: "forest", textSize: "large" });
  assert.equal(lookMode(store, owner, {}), "dark");
  saveLookMode(store, owner, "light");
  assert.equal(lookMode(store, owner, {}), "light");
  assert.equal(store.get("settings", owner, "preferences").data.textSize, "large", "the rest of the record is kept");
  saveLookMode(store, owner, "follow");
  assert.equal(lookMode(store, owner, { COLORFGBG: "0;15" }), "light");
  assert.equal(lookMode(store, owner, { COLORFGBG: "15;0" }), "dark");
  assert.equal(lookMode(store, owner, {}), "dark");
  assert.equal(terminalMode({}), undefined);
  assert.equal(lookLanguage({ language: "auto" }, { LANG: "fr_FR.UTF-8" }), "fr");
  assert.equal(lookLanguage({ language: "auto" }, { LANG: "en_GB.UTF-8" }), "en");
  assert.equal(lookLanguage({ language: "fr" }, {}), "fr");
  assert.equal(lookLanguage({ language: "auto" }, { LANG: "de_DE.UTF-8" }), "de");
  assert.equal(lookLanguage({ language: "de" }, {}), "de");
  assert.equal(lookLanguage({ language: "auto" }, { LANG: "xx_XX.UTF-8" }), "en", "a language with no words on file falls back to English");
});

test("the language setting takes German, from the terminal and from the window", async (t) => {
  const app = await workspace(t);
  const { store } = app, owner = app.runtime.owner;
  assert.equal((await saveLook(store, owner, { language: "de" })).language, "de");
  assert.equal(readLook(store, owner).language, "de");
  const fromWindow = await lookApi(store, owner, "POST", async () => ({ language: "de" }));
  assert.equal(fromWindow.language, "de");
  await assert.rejects(saveLook(store, owner, { language: "xx" }));
});

test("the terminal's three switches all start off and take only on, off or when needed", async (t) => {
  const app = await workspace(t);
  const { store } = app, owner = app.runtime.owner;
  assert.deepEqual(terminalSwitches(store, owner), { mouse: "off", sidePane: "off", oak: "off" });
  assert.deepEqual(saveTerminalSwitch(store, owner, "oak", "when-needed"), { mouse: "off", sidePane: "off", oak: "when-needed" });
  assert.throws(() => saveTerminalSwitch(store, owner, "oak", "sometimes"));
  assert.throws(() => saveTerminalSwitch(store, owner, "everything", "on"));
});
