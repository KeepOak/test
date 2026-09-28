// Which test files a change can reach, read from the code itself: the static imports between src/, public/,
// scripts/ and the tests (`../dist/x.js` read as src/x.ts), every quoted mention of a file (a test that runs
// `join(root, "dist", "cli.js")`, reads "holidays.json" or fetches "/app.js"), and every folder a file lists with
// readdir or glob (a file that lists folders and quotes a folder's path, or the end of it, whole: "docs/handbook"). A changed file reaches the files that use it, and theirs, up to the tests. It over-selects on
// purpose and must never under-select; the whole suite still runs on every push to redesign/window.
import { readFileSync } from "node:fs";
import { posix } from "node:path";

const CODE = /^(?:src\/.*\.c?ts|public\/.*\.(?:m?js|html|css)|scripts\/.*\.m?js|tests\/.*\.m?js|packages\/sdk\/(?:src|test)\/.*\.m?[jt]s)$/;
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*|<script[^>]*\bsrc=|<link[^>]*\bhref=|@import\s+(?:url\()?)["'`]([^"'`\n]+)["'`]/g;
const QUOTED_NAME = /([\w@+-][\w.@+-]*\.[A-Za-z0-9]+)(?=["'`?#])/g;
const QUOTED_STRING = /["'`]((?:\.\/)?[\w.@-]+(?:\/[\w.@-]+)*\/?)["'`]/g;
// A path built into a folder: `locales/${lang}.json`, or join(dir, "locales", `${lang}.json`).
const DYNAMIC_PATH = /[`/]((?:[\w.@-]+\/)*[\w.@-]+)\/\$\{|["']([\w.@-]+)["']\s*,\s*`\$\{/g;
const LISTS_FOLDER = /\breaddir(?:Sync)?\b|\bglob(?:Sync)?\b|\bopendir\b|\bwalk\w*\(/;
const TESTS = /^(?:tests|packages\/sdk\/test)\//;

export const isCode = (file) => CODE.test(file) && !/\.d\.c?ts$/.test(file);
export const isTest = (file) => /^(?:tests|packages\/sdk\/test)\/[^/]+\.test\.mjs$/.test(file);

/** A file's path as the program uses it: src/a/b.ts runs as dist/a/b.js, src/a.cts as dist/a.cjs. */
function builtPath(file) {
  if (!file.startsWith("src/")) return file;
  return `dist/${file.slice(4)}`.replace(/\.cts$/, ".cjs").replace(/\.ts$/, ".js");
}

const paths = (file) => [...new Set([builtPath(file), file])];
const nameOf = (path) => path.split("/").at(-1);
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The repository file an import specifier in `from` names, or null (a package, or nothing that exists). */
export function resolveSpecifier(from, specifier, files) {
  if (!/^\.{1,2}\//.test(specifier) && !specifier.startsWith("/")) return null;
  const clean = specifier.replace(/[?#].*$/, "");
  const target = clean.startsWith("/") ? posix.join("public", clean) : posix.normalize(posix.join(posix.dirname(from), clean));
  const candidates = [target];
  const inDist = target.startsWith("dist/") ? `src/${target.slice(5)}` : null;
  for (const base of [target, inDist].filter(Boolean)) {
    candidates.push(base.replace(/\.js$/, ".ts"), base.replace(/\.cjs$/, ".cts"), `${base}.ts`, `${base}.js`,
      `${base}/index.ts`, `${base}/index.js`);
  }
  return candidates.find((candidate) => files.has(candidate)) ?? null;
}

/**
 * Every quoted way to name a file: the last two or more parts of its path, as built and as written, and its bare
 * name only when no other file in the repository has that name (so "index.js" alone names nothing).
 */
function mentions(file, uniqueName) {
  const names = new Set();
  for (const path of paths(file)) {
    const parts = path.split("/");
    for (let count = uniqueName ? 1 : 2; count <= parts.length; count += 1) names.add(parts.slice(-count).join("/"));
  }
  return [...names];
}

/** Whether `text` names `file` in quotes, as a path ending in it, or as the last two parts of a join(…, "a", "b"). */
export function mentionsFile(text, file, uniqueName = false) {
  const quoted = new RegExp(`["'\`/](?:${mentions(file, uniqueName).map(escape).join("|")})["'\`?#]`);
  if (quoted.test(text)) return true;
  return paths(file).some((path) => {
    const [parent, name] = path.split("/").slice(-2);
    return Boolean(name) && new RegExp(`["']${escape(parent)}["']\\s*,\\s*["']${escape(name)}["']`).test(text);
  });
}

function add(map, key, value) {
  if (!map.has(key)) map.set(key, new Set());
  map.get(key).add(value);
}

/** Who imports each file. */
function importersOf(text, all) {
  const importers = new Map();
  for (const [file, source] of text) {
    for (const match of source.matchAll(SPECIFIER)) {
      const target = resolveSpecifier(file, match[1], all);
      if (target && target !== file) add(importers, target, file);
    }
  }
  return importers;
}

/** The graph, with the indexes the mention search reads: who quotes each file name, who lists each folder name. */
export function buildGraph(files, read = (file) => readFileSync(file, "utf8")) {
  const all = new Set(files);
  const text = new Map(files.filter(isCode).map((file) => [file, read(file)]));
  const named = new Map();
  for (const [file, source] of text) for (const match of source.matchAll(QUOTED_NAME)) add(named, match[1], file);
  const listers = new Map(), dynamic = new Map();
  for (const [file, source] of text) {
    for (const match of source.matchAll(DYNAMIC_PATH)) add(dynamic, (match[1] ?? match[2]).replace(/^\.?\//, ""), file);
    if (!LISTS_FOLDER.test(source)) continue;
    for (const match of source.matchAll(QUOTED_STRING)) add(listers, match[1].replace(/^\.\//, "").replace(/\/$/, ""), file);
  }
  // A folder is named by its whole path ("docs", "docs/handbook"; a join(root, "docs", "handbook") quotes "docs"), or
  // by its last two or more parts when no other folder ends the same way. A bare nested name ("tools") names none.
  const folders = new Set(files.flatMap((file) => file.split("/").slice(0, -1).map((_, index, parts) => parts.slice(0, index + 1).join("/"))));
  const tailCount = new Map();
  for (const folder of folders) for (const tail of folderTails(`${folder}/x`)) tailCount.set(tail, (tailCount.get(tail) ?? 0) + 1);
  for (const tail of listers.keys()) if (tailCount.get(tail) !== 1 || !(folders.has(tail) || tail.includes("/"))) listers.delete(tail);
  for (const tail of dynamic.keys()) if (tailCount.get(tail) !== 1) dynamic.delete(tail);
  for (const [tail, users] of dynamic) for (const user of users) add(listers, tail, user);
  const nameCount = new Map();
  for (const file of files) for (const name of new Set(paths(file).map(nameOf))) nameCount.set(name, (nameCount.get(name) ?? 0) + 1);
  return { files: all, text, importers: importersOf(text, all), named, listers, nameCount };
}

/**
 * Whether a change to `file` can change what `user` does. The product (src/, public/) never runs the test files or
 * the repository's scripts, so a product file that names one (a benchmark adapter that lists "tests") is not reached
 * by it; only tests and scripts are.
 */
function canUse(user, file) {
  if (TESTS.test(file)) return TESTS.test(user);
  if (file.startsWith("scripts/")) return user.startsWith("scripts/") || TESTS.test(user);
  // src/server.ts serves every page file, so it would reach every test that starts the server; the planner selects
  // every browser test for a public/ change instead. Other src/ files that read a page file (the terminal's words
  // from public/locales) use it.
  if (file.startsWith("public/")) return user !== "src/server.ts";
  return true;
}

/** Every way to name a folder `file` is in: "docs/handbook" and "handbook" for docs/handbook/a.md, "docs" for docs. */
function folderTails(file) {
  const parts = file.split("/").slice(0, -1);
  const tails = [];
  for (let end = 1; end <= parts.length; end += 1) for (let start = 0; start < end; start += 1) tails.push(parts.slice(start, end).join("/"));
  return [...new Set(tails)];
}

/** The code files that use `file`: its importers, the files that name it, and the files that list a folder it is in. */
export function usersOf(graph, file) {
  const users = new Set(graph.importers.get(file) ?? []);
  const names = new Set(paths(file).map(nameOf));
  const unique = [...names].every((name) => graph.nameCount.get(name) === 1);
  for (const name of names) for (const other of graph.named.get(name) ?? []) {
    if (other !== file && !users.has(other) && mentionsFile(graph.text.get(other), file, unique)) users.add(other);
  }
  for (const folder of folderTails(file)) {
    for (const other of graph.listers.get(folder) ?? []) if (other !== file) users.add(other);
  }
  return new Set([...users].filter((user) => canUse(user, file)));
}

/**
 * The test files the changed files reach, and the changed files nothing uses (no code imports, names or lists
 * them), which the caller must treat as unknown. A changed test file selects itself.
 */
export function reachedTests(graph, changed) {
  const seen = new Set(changed), tests = new Set(), unreached = [], queue = [];
  for (const file of changed) {
    if (isTest(file)) tests.add(file);
    const users = usersOf(graph, file);
    if (!users.size && !isTest(file)) unreached.push(file);
    queue.push(...users);
  }
  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    if (isTest(file)) tests.add(file);
    for (const user of usersOf(graph, file)) if (!seen.has(user)) queue.push(user);
  }
  return { tests: [...tests].sort(), unreached };
}
