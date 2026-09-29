// `npm run build`'s last compile step: every character past Latin-1 in the built JavaScript is written as its \u escape.
// V8 keeps each loaded module's source in memory, as one byte per character, unless the file holds a single character
// past U+00FF: then all of it takes two bytes. Half the built files held one (a dash, a quote mark, an arrow in a string),
// which cost the engine several megabytes for nothing. An escape means the same thing in a string, a template, a
// regular expression and a name, so nothing changes but the size. tests/idle-memory-footprint.test.mjs holds it to that.
// A file already written this way is left alone, and a rewritten one keeps its time, so tsc's incremental build still
// trusts dist/ (scripts/build-ts.mjs).
import { readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Without the u flag each UTF-16 unit is matched on its own, so a character past U+FFFF becomes its two surrogate
// escapes, which read back as that one character everywhere, a regular expression with the u flag included.
const wide = new RegExp("[^\\u0000-\\u00ff]", "g");
const escape = (unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`;

function asciiSource(source) {
  return source.replace(wide, escape);
}

function files(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files(path, out);
    else if (/\.c?js$/.test(entry.name)) out.push(path);
  }
  return out;
}

let changed = 0;
for (const path of files(process.argv[2] ?? "dist")) {
  const source = readFileSync(path, "utf8");
  if (!wide.test(source)) continue;
  wide.lastIndex = 0;
  const { atime, mtime } = statSync(path);
  writeFileSync(path, asciiSource(source));
  utimesSync(path, atime, mtime);
  changed++;
}
if (changed) console.log(`ascii-dist: ${changed} built files written with \\u escapes`);
