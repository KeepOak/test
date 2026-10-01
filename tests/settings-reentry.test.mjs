/* Returning through the gear must refresh the previously opened page, without registering its actions twice or
   fetching on every redraw. Run the real Settings navigation with isolated page/window stand-ins. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { discardTemp } from "./temp-dir.mjs";

async function settings(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-settings-reentry-"));
  const source = await readFile(new URL("../public/app/settings/settings.js", import.meta.url), "utf8");
  const state = { S: { view: "settings", setPage: "chatapps" }, E: { loaded: true }, calls: [], acts: {}, after: [], channels: [], cached: [] };
  globalThis.__settingsEntry = state;
  globalThis.document = { addEventListener() {} };
  t.after(async () => { delete globalThis.__settingsEntry; delete globalThis.document; await discardTemp(root); });
  const put = async (path, code) => { const file = join(root, path); await mkdir(dirname(file), { recursive: true }); await writeFile(file, code); };
  await put("package.json", '{"type":"module"}');
  await put("app/settings/settings.js", source);
  const modules = {
    "../core/dom.js": 'export const $ = () => null; export const esc = String; export const renderNow = () => {}; export const paint = () => {}; export const afterDraw = fn => globalThis.__settingsEntry.after.push(fn);',
    "../core/state.js": 'export const { S, E } = globalThis.__settingsEntry; export const level = () => 0; export const save = () => {}; export const ownerHere = () => true;',
    "../core/actions.js": 'export const has = () => false; export const on = (id, fn) => globalThis.__settingsEntry.acts[id] = fn;',
    "../core/ui.js": 'export const ic = () => ""; export const closePop = () => {};',
    "../core/art17.js": 'export const calm17 = () => true;',
    "./find.js": 'export const ROWS = ""; export const rowKey = () => ""; export const buildIndex = () => []; export const search = () => [];',
    "../core/features.js": 'export const markLive = () => {};',
    "../chat/dockinfo.js": 'export const lockBanner = () => "";',
    "../../i18n.js": 'export const t = key => key;',
    "../core/words.js": 'export const say = word => word;',
    "../shell/simple.js": 'export const levelChosen = () => {};',
    "../shell/scene.js": 'export const noticed = () => {};',
    "./kit17.js": 'export const initKit = () => {};',
    "./demos-b5.js": 'export const initDemosB5 = () => {};',
  };
  for (const match of source.matchAll(/import \* as (\w+) from "(\.\/pages\/[^\"]+)"/g)) {
    const [, id, path] = match;
    modules[path] = `const s = globalThis.__settingsEntry; export const init = () => { s.calls.push("init:${id}"); s.cached = [...s.channels]; return s.pending?.["${id}"]; }; export const load = () => { s.calls.push("load:${id}"); s.cached = [...s.channels]; return s.pending?.["${id}"]; }; export const waitFirst = ${id === "gateway"}; export const draw = () => s.cached.join(",") || "No chat app is connected yet.";`;
  }
  for (const [path, code] of Object.entries(modules)) await put(join("app/settings", path), code);
  const page = await import(pathToFileURL(join(root, "app/settings/settings.js")).href);
  page.init();
  return { page, state, outside() { state.S.view = "customize"; for (const fn of state.after) fn(); }, inside() { state.S.view = "settings"; return page.draw(); } };
}

test("the Settings gear refreshes a previously empty Chat apps page after a connection is added", async (t) => {
  const w = await settings(t);
  assert.match(w.page.draw(), /No chat app is connected yet/);
  w.outside();
  w.state.channels = ["Telegram"];
  assert.match(w.inside(), /Telegram/);
  assert.doesNotMatch(w.inside(), /No chat app is connected yet/);
  assert.deepEqual(w.state.calls, ["init:chatapps", "load:chatapps"], "redraws do not refetch or register actions twice");
  w.outside();
  w.state.channels = [];
  assert.match(w.inside(), /No chat app is connected yet/);
  assert.deepEqual(w.state.calls, ["init:chatapps", "load:chatapps", "load:chatapps"]);
});

test("explicit Settings navigation reads once, including selection from another view", async (t) => {
  const w = await settings(t);
  w.page.draw();
  w.outside();
  w.state.acts.setgo({ dataset: { v: "chatapps" } });
  w.page.draw();
  w.state.acts.setpage({ dataset: { v: "general" } });
  w.page.draw();
  assert.deepEqual(w.state.calls, ["init:chatapps", "load:chatapps", "init:general"]);
});

test("the update menu reads its page once when entering from outside Settings", async (t) => {
  const w = await settings(t);
  w.page.draw();
  w.outside();
  w.state.acts["updmenu-go"]();
  w.page.draw();
  w.page.draw();
  assert.deepEqual(w.state.calls, ["init:chatapps", "init:updates"]);
});

test("redraws while a wait-first page loads do not reload either the old or new page", async (t) => {
  const w = await settings(t);
  w.page.draw();
  let finish;
  w.state.pending = { gateway: new Promise((resolve) => { finish = resolve; }) };
  w.state.acts.setpage({ dataset: { v: "gateway" } });
  w.page.draw();
  assert.equal(w.state.S.setPage, "chatapps");
  assert.deepEqual(w.state.calls, ["init:chatapps", "init:gateway"]);
  finish();
  await Promise.resolve();
  w.page.draw();
  assert.equal(w.state.S.setPage, "gateway");
  assert.deepEqual(w.state.calls, ["init:chatapps", "init:gateway"]);
});
