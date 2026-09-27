/* A pattern once held a literal backspace byte where "\b" (a word boundary) was meant, so check-fakes' "prototype
   example Trunk" rule never matched anything and the probe that measures sleeping animations never saw the window doze.
   Code and tools never need a control byte other than tab, newline and carriage return; this finds one if it comes back.
   Tests may write terminal keys (Ctrl-C, Escape) into strings on purpose, so under tests/ only the backspace is refused. */
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const root = join(import.meta.dirname, "..");
const FOLDERS = ["public/app", "public/dashboard", "design/redesign/tools", "evals", "scripts", "src", "tests"];
const CODE = /\.(m?js|cjs|ts|cmd|css|json)$/;
const BACKSPACE = /\x08/;
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;

function* files(folder) {
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const path = join(folder, entry.name);
    if (entry.isDirectory()) yield* files(path);
    else if (CODE.test(entry.name)) yield path;
  }
}

test("no source file holds a control byte (a backspace where \\b was meant)", () => {
  const found = [];
  for (const folder of FOLDERS) {
    for (const file of files(join(root, folder))) {
      readFileSync(file, "utf8").split("\n").forEach((line, i) => {
        const at = line.search(folder === "tests" ? BACKSPACE : CONTROL);
        if (at !== -1) found.push(`${relative(root, file).replaceAll("\\", "/")}:${i + 1} byte 0x${line.charCodeAt(at).toString(16).padStart(2, "0")}`);
      });
    }
  }
  assert.deepEqual(found, []);
});
