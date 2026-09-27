// Fails on what must never reach the window: inline style="" (the engine's CSP refuses it), the prototype's asset paths,
// design-note attributes, the prototype's example people, Trunks, places and models, and a status written into markup
// rather than computed from the engine. Prints each hit as file:line.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const files = [];
const walk = (d) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (p.endsWith(".js")) files.push(p); } };
walk("public/app");

const RULES = [
  [/ style="/, "inline style (use data-css)"],
  [/src="assets\//, "prototype asset path (art lives in /art/)"],
  [/data-note=/, "design-note attribute"],
  [/\b(Taofik|Hartwell|Okafor|Marcus Lee|Priya Shah|Fieldnotes|Lisbon|keepoak\.com\/t\/|Legion|Dana)\b/i, "prototype example name"],
  [/(?:[>"]|·\s)(Scout|Ledger|Ada|Ember|Tock|Kite|Morel)/, "prototype example Trunk"],
  [/\b(Qwen3\.6|GPT-6 Sol)\b/, "prototype example model"],
  [/>\s*(Connected|Loaded|Online|Up to date|is up to date|Last night, 2:00 AM|0\.20\.0 ready)\s*</, "status written into markup"],
  [/\b\d+(\.\d+)?\s?(GB|MB)\b(?![^`]*\$\{)/, "size written into markup"],
  [/version\s*(\|\||\?\?)\s*["'`]\d/, "version written in as a fallback"],
  [/catch\s*\(\w+\)\s*\{\s*(\/\*[^*]*\*\/)?\s*\}|catch\s*\{\s*\}/, "error swallowed (show error.message)"],
  [/real implementation|placeholder screen|For now, show/i, "stub left in"],
  [/\son(submit|click|input|change)=/, "inline event handler (the CSP refuses it)"],
  [/aria-(pressed|checked)=\\?"true\\?"|<input[^>]*\schecked[\s>]|<option[^>]*\sselected[\s>]/, "state written into markup (compute it)"],
  [/\|\|\s*["']\$\d/, "amount written in as a fallback"],
  // bugfix-9 ("no nonsense demo language"): what the demo-language sweep took out must not come back.
  [/["'`\/@][\w-]+(\.[\w-]+)*\.example(?![\w-]|s\b)(?!\.[a-z])/, "example address written in (leave the field empty)"],
  [/\.length\s*\?\s*\w+\s*:\s*\[\s*\[\s*["']/, "made-up rows drawn when the engine has none (show nothing)"],
  [/\b\d+ of them\b/, "count written into words (use the engine's count or none)"],
  [/data-act=\\?["'](ckpt-demo|proto-reset|notes-toggle|note)\\?["']/, "prototype-only control (it has no feature behind it)"],
  [/read out at \d|\bFive places\b/, "a time or count written in that the engine or window decides"],
];
// A toast's own words must be the prototype's: any literal toast text has to appear in prototype.html.
const PROTO = readFileSync("design/redesign/prototype.html", "utf8").replaceAll("’", "'");
const toastWords = (line) => [...line.matchAll(/toast\((["'`])((?:(?!\1).)*)\1/g)].map((m) => m[2]).filter((t) => !t.includes("${"));
// Setup's textarea keeps the prototype's placeholder hint.
const EXEMPT = { "public/app/flows/setup.js": ["prototype example name"] };

// The owner's decision: Branch has no demo or practice model; setup is how a model is chosen. Checked on every line,
// comments included, so not even a note about one comes back.
const NO_DEMO = /Offline demonstration|Practice mode|offline-demo-fixture/;

let bad = 0;
for (const f of files) {
  const rel = f.replaceAll("\\", "/");
  readFileSync(f, "utf8").split("\n").forEach((line, i) => {
    if (NO_DEMO.test(line)) { console.log(`${rel}:${i + 1}: demo model in the window: ${line.match(NO_DEMO)[0]}`); bad++; }
    for (const [re, why] of RULES) {
      if (EXEMPT[rel]?.includes(why) || /^\s*(\/\/|\/\*|\*)/.test(line)) continue;
      // A state the line explains as true ("// state: <why>") is allowed; the reason is read in review.
      if (why.startsWith("state written") && /\/\/ state: \S/.test(line)) continue;
      if (re.test(line)) { console.log(`${rel}:${i + 1}: ${why}: ${line.match(re)[0].trim()}`); bad++; }
    }
    if (/^\s*(\/\/|\/\*|\*)/.test(line)) return;
    for (const words of toastWords(line)) {
      if (!PROTO.includes(words.replaceAll("’", "'"))) { console.log(`${rel}:${i + 1}: toast words not in the prototype: ${words}`); bad++; }
    }
  });
}
// bugfix-9: the window's words now live in the locale files too (t()), so the words-only rules read every English
// value there. Setup's describe-yourself hint keeps the prototype's placeholder, as setup.js did.
const WORDS_ONLY = new Set(["prototype example name", "prototype example Trunk", "prototype example model",
  "count written into words (use the engine's count or none)", "a time or count written in that the engine or window decides"]);
const LOCALE_EXEMPT = { "window.flows.setup.describe-hint": ["prototype example name"] };
for (const [key, value] of Object.entries(JSON.parse(readFileSync("public/locales/en.json", "utf8")))) {
  for (const [re, why] of RULES) {
    if (!WORDS_ONLY.has(why) || LOCALE_EXEMPT[key]?.includes(why)) continue;
    if (re.test(`"${value}`)) { console.log(`public/locales/en.json ${key}: ${why}: ${`"${value}`.match(re)[0].trim()}`); bad++; }
  }
}
// An affordance drawn with nothing behind it: a resize edge that shows the col-resize cursor but no code drags, or a
// draggable card no dragstart listener picks up. Each kind drawn must be handled by a listener in some window module.
const sources = files.map((f) => [f.replaceAll("\\", "/"), readFileSync(f, "utf8")]);
const AFFORDANCES = [
  [/data-resize=\\?["']([\w-]+)/g, [/addEventListener\(\s*["']pointerdown["']/, /closest\??\.?\(\s*["']\[data-resize\]["']\s*\)/], "resize edge with no drag handler"],
  [/draggable=\\?["'](true)/g, [/addEventListener\(\s*["']dragstart["']/], "draggable with no dragstart handler"],
];
for (const [drawn, listener, why] of AFFORDANCES) {
  const handlers = sources.filter(([, text]) => listener.every((re) => re.test(text)));
  for (const [rel, text] of sources) {
    text.split("\n").forEach((line, i) => {
      if (/^\s*(\/\/|\/\*|\*)/.test(line)) return;
      for (const [, kind] of line.matchAll(drawn)) {
        // A resize kind must be named in the handler's own file (its widths and limits), not merely drawn.
        const handled = handlers.some(([, h]) => kind === "true" || new RegExp(`["']${kind}["']|\\b${kind}\\s*:`).test(h));
        if (!handled) { console.log(`${rel}:${i + 1}: ${why}: ${kind}`); bad++; }
      }
    });
  }
}
console.log(bad ? `${bad} fake or forbidden thing(s)` : "fakes ok");
process.exit(bad ? 1 : 0);
