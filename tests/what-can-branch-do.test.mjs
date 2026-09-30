/* "What can Branch do" (public/app/flows/whatcan.js): the gallery reads the engine's real lists, writes no capability
   of its own, escapes every engine string, is reached from Overview, the Guide menu and an empty conversation, and the
   engine gives the plain lines and prompt words it shows. The window itself is proved by
   design/redesign/tools/verify-what-can-branch-do.cjs against a running engine. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const read = (p) => readFileSync(p, "utf8");
const MODULE = read("public/app/flows/whatcan.js");
const code = MODULE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const walk = (d, out = []) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p, out); else if (p.endsWith(".js")) out.push(p); } return out; };

test("the gallery reads the engine's own lists", () => {
  for (const route of ["tools", "channel-setup", "prompts", "flows"]) assert.match(code, new RegExp(`api\\("${route}"\\)`), route);
  assert.match(code, /\(E\.state\?\.skills \?\? \[\]\)\.filter\(\(s\) => s\.activeVersion !== null/, "only the owner's skills that are switched on (GET /api/state)");
  assert.match(code, /api\(`skills\/\$\{encodeURIComponent\(s\.id\)\}`\)[\s\S]*x\.version === s\.activeVersion/, "in the words of the version that is on");
  assert.doesNotMatch(code, /skills\/browser/, "the skills that ship with Branch are not listed until installed and switched on");
  assert.match(code, /E\.state\?\.approvalCategories/, "the engine's approval groups for the tools");
});

test("no capability is written into the window", () => {
  const recipes = JSON.parse(read("data/channel-setup.json")).recipes;
  const names = [...recipes.flatMap((r) => [r.id, r.name, r.what].filter(Boolean)),
    "files.read", "web.search", "search-and-summarise", "fill-a-form-from-a-document", "Summarise a page", "Weekly review"];
  const literals = [...code.matchAll(/"([^"\n]*)"|'([^'\n]*)'/g)].map((m) => m[1] ?? m[2]);
  for (const name of names) {
    assert.ok(!literals.includes(name), `whatcan.js names ${name}`);
    if (name.length >= 8) assert.ok(!code.includes(name), `whatcan.js writes ${name}`);
  }
  assert.doesNotMatch(code, /\bname:\s*["'`]/, "no hand-written entries");
  assert.doesNotMatch(code, /\b(description|what|body):\s*["']/, "no hand-written descriptions or requests");
  assert.doesNotMatch(code, /style="|\son(click|submit)=/, "CSP: no inline style or handler");
});

test("every engine string is escaped, ids in data-* too", () => {
  for (const field of ["e.name", "e.line", "e.kind"]) {
    const uses = [...code.matchAll(new RegExp(`\\$\\{([^}]*\\b${field.replace(".", "\\.")}\\b[^}]*)\\}`, "g"))].map((m) => m[1]);
    assert.ok(uses.length, `${field} is drawn`);
    for (const use of uses) assert.match(use, /^(esc\(|logo\(|t\(|ic\(ICON\[e\.kind\])/, `${field} drawn as \${${use}}`);
  }
  assert.match(code, /data-v="\$\{esc\(e\.name\)\}"/);
  assert.match(code, /data-k="\$\{esc\(e\.kind\)\}"/);
  assert.match(code, /<h3 class="wc-h">\$\{esc\(g\.label\)\}<\/h3>/, "an approval group's label");
});

test("its actions are registered once and marked live; Try it uses the new conversation's draft", () => {
  const all = walk("public/app").map(read).join("\n");
  for (const act of ["whatcan", "whatcan-tab", "whatcan-try"]) {
    assert.equal(all.split(`on("${act}"`).length - 1, 1, `on("${act}") once`);
    assert.match(code, new RegExp(`markLive\\(\\[[^\\]]*"${act}"`), `${act} marked live`);
  }
  assert.match(code, /S\.drafts\.new = text;\s*startConversation\(\);/, "the B003 way: prepared words in the box, not sent");
  assert.doesNotMatch(code, /\bsend\(|startWith\(/, "Try it never sends");
});

test("reached from Overview, the Guide menu and an empty conversation, in the window's words", () => {
  assert.match(read("public/app/places/overview.js"), /data-act="whatcan">\$\{t\("window\.what\.title"\)\}/);
  assert.match(read("public/app/shell/shell.js"), /mi\("whatcan", "spark", t\("window\.what\.title"\)\)/);
  assert.match(read("public/app/chat/chat.js"), /class="empty-chat"[\s\S]*data-act="whatcan">\$\{t\("window\.what\.title"\)\}/);
  const en = JSON.parse(read("public/locales/en.json")), fr = JSON.parse(read("public/locales/fr.json"));
  const used = [...new Set([...code.matchAll(/"(window\.what\.[\w-]+)"/g)].map((m) => m[1]))];
  assert.ok(used.length >= 6);
  for (const key of [...used, "window.what.title"]) { assert.ok(en[key], `en ${key}`); assert.ok(fr[key], `fr ${key}`); }
  assert.match(read("public/app.css"), /\/\* area: what can Branch do \*\/[\s\S]*\.wc-card\{/);
});

test("an answer read after another open, or once another dialog is showing, is not drawn over it; no mascot", () => {
  assert.match(code, /const opening = \+\+W\.opening;[\s\S]*if \(opening !== W\.opening \|\| \(dialog\(\) && !dialog\(\)\.querySelector\("\[data-wc\]"\)\)\) return;/);
  assert.doesNotMatch(code, /look17|figureFace|\bav\(/, "the mascot is only the logo, never in the gallery");
});

test("the engine: a plain line per listed chat app, and each starter prompt's own words", async () => {
  const { setupList } = await import("../dist/channel-setup/service.js");
  const { recipes } = await import("../dist/channel-setup/recipes.js");
  const list = setupList({ get: () => undefined }, "local");
  const listed = list.channels.filter((c) => c.what);
  assert.ok(listed.length >= 9);
  for (const c of listed) {
    assert.equal(c.what, recipes().find((r) => r.id === c.id).what);
    assert.doesNotMatch(c.what, /\n/, "one line");
  }
  const { EXAMPLES } = await import("../dist/prompt-examples.js");
  const api = read("src/prompt-library-api.ts");
  assert.match(api, /examples: EXAMPLES\.map\(\(\{ title, description, command, body \}\) => \(\{ title, description, command, body \}\)\)/);
  for (const e of EXAMPLES) assert.ok(e.body.trim(), `${e.title} has its words`);
});

test("oneLine keeps the first line up to its first sentence (the module's own function)", () => {
  const src = /export function oneLine\(text\) \{[\s\S]*?\n\}/.exec(MODULE)[0].replace("export ", "");
  const line = new Function(`${src}\nreturn oneLine;`)();
  assert.equal(line("Read a UTF-8 workspace file, maximum 32 KiB."), "Read a UTF-8 workspace file, maximum 32 KiB.");
  assert.equal(line("Search the web. Use when someone asks."), "Search the web.");
  assert.equal(line("First line\nsecond line"), "First line");
  assert.equal(line("v1.2 is out"), "v1.2 is out");
  assert.equal(line(undefined), "");
});
