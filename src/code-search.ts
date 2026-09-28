import { readdir, readFile, stat } from "node:fs/promises";
import { join, matchesGlob } from "node:path";
import { z } from "zod";
import { ignoreRulesFor, type IgnoreChoice } from "./comfort/ignore-files.js"; // R17-S20
import { isSecretEntry, type WorkspaceFiles } from "./files.js";
import type { ToolRegistry } from "./registry.js";
import { WalkRules } from "./walk-rules.js"; // mac7/walk-rules

/**
 * Looking around the workspace: listing files by pattern, searching inside them, a light map of
 * what each file holds, and a forgiving search by part of a file name. Everything stays inside the
 * workspace (or the active project's folder), skips secret-looking names, and is bounded so a
 * result always fits in one answer.
 */
const alwaysSkipped = new Set(["node_modules", ".git", ".branch", "dist", "release"]);
export const searchLimits = {
  entries: 4000,
  depth: 12,
  // selfdev: Branch's own handbook is a megabyte; a file up to 8 MiB may be searched when asked.
  fileBytes: 8 * 1024 * 1024,
  answerBytes: 48 * 1024,
};
export interface WalkEntry { path: string; bytes: number; mtimeMs: number }
/** mac7/walk-rules: `leftOut` says, once, what the owner's rules kept this walk out of. */
export interface Walk { entries: WalkEntry[]; truncated: boolean; leftOut?: string }

/** Adds items while the answer stays comfortably inside the 64 KiB tool-output limit. */
function bounded<T>(items: T[], value: T, used: { bytes: number }): boolean {
  const size = JSON.stringify(value).length + 2;
  if (used.bytes + size > searchLimits.answerBytes) return false;
  used.bytes += size;
  items.push(value);
  return true;
}

export class WorkspaceSearch {
  private readonly symbolCache = new Map<string, { key: string; symbols: string[] }>();
  /** How many files the last `map` answered from the cache instead of reading again. */
  cacheHits = 0;
  /** R17-S20: the owner's ignore-file choice, read fresh each walk; unset keeps the defaults. */
  ignoreChoice: (() => IgnoreChoice) | undefined;
  constructor(private readonly files: WorkspaceFiles) {}

  /** The ignore rules in effect: `.branchignore` if there is one, otherwise `.gitignore` (src/comfort/ignore-files.ts). */
  private ignoreRules(): Promise<(path: string, isDirectory?: boolean) => boolean> {
    return ignoreRulesFor(this.files.base, this.ignoreChoice?.());
  }

  /** Every readable file under `path`, as workspace-relative paths, bounded and ignore-aware. */
  async walk(path = ".", limit = searchLimits.entries): Promise<Walk> {
    // mac7/walk-rules: every folder and file is held to this task's rules; a start inside a refused folder is refused.
    const rules = new WalkRules(this.files.walkRules());
    rules.start(path);
    const root = await this.files.checked(path, true);
    const prefix = path === "." ? "" : `${path.replace(/\/+$/, "")}/`;
    const ignore = await this.ignoreRules();
    const entries: WalkEntry[] = [];
    const state = { scanned: 0, truncated: false, rules };
    await this.descend(root, prefix, ignore, entries, state, limit, 0);
    return rules.noted({ entries, truncated: state.truncated });
  }

  private async descend(
    directory: string, prefix: string,
    ignore: (path: string, isDirectory?: boolean) => boolean,
    out: WalkEntry[], state: { scanned: number; truncated: boolean; rules: WalkRules },
    limit: number, depth: number,
  ): Promise<void> {
    if (depth > searchLimits.depth) return;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (out.length >= limit || ++state.scanned > searchLimits.entries) { state.truncated = true; return; }
      const relative = `${prefix}${entry.name}`;
      // The same refused names as the file tools (src/files.ts), so a search never opens one either.
      if (entry.isSymbolicLink() || isSecretEntry(relative)) continue;
      if (entry.isDirectory()) {
        if (alwaysSkipped.has(entry.name) || ignore(relative, true) || !state.rules.folder(relative)) continue;
        await this.descend(join(directory, entry.name), `${relative}/`, ignore, out, state, limit, depth + 1);
        continue;
      }
      if (!entry.isFile() || ignore(relative, false) || !state.rules.file(relative)) continue;
      const info = await stat(join(directory, entry.name));
      out.push({ path: relative, bytes: info.size, mtimeMs: info.mtimeMs });
    }
  }

  /** Files whose path matches any of the given patterns (`src/**\/*.ts`, `*.json`, …). */
  async glob(patterns: string[], path = "."): Promise<{ files: WalkEntry[]; moreAvailable: boolean; leftOut?: string }> {
    const walk = await this.walk(path);
    const files: WalkEntry[] = [];
    const used = { bytes: 0 };
    let moreAvailable = walk.truncated;
    for (const entry of walk.entries) {
      if (!patterns.some((pattern) => safeMatch(entry.path, pattern))) continue;
      if (!bounded(files, entry, used)) { moreAvailable = true; break; }
    }
    return withNote({ files, moreAvailable }, walk);
  }

  /** Lines matching a word or a regular expression, with the lines around each match. */
  async grep(input: GrepInput): Promise<GrepResult> {
    const walk = await this.walkOrFile(input.path);
    const expression = buildExpression(input);
    const matches: GrepMatch[] = [];
    const used = { bytes: 0 };
    let filesSearched = 0, filesSkipped = 0, moreAvailable = walk.truncated;
    for (const entry of walk.entries) {
      if (input.glob?.length && !input.glob.some((p) => safeMatch(entry.path, p))) continue;
      if (entry.bytes > input.maxFileBytes) { filesSkipped++; continue; }
      const buffer = await readFile(join(this.files.base, entry.path));
      if (buffer.subarray(0, 8000).includes(0)) { filesSkipped++; continue; }
      filesSearched++;
      if (!collect(entry.path, buffer.toString("utf8"), expression, input, matches, used)) { moreAvailable = true; break; }
      if (matches.length >= input.maxResults) { moreAvailable = true; break; }
    }
    return withNote({ matches, filesSearched, filesSkipped, moreAvailable }, walk);
  }

  /**
   * selfdev: a search may name one file as well as a folder, as a coding assistant's search does. The file is
   * looked for in its folder's walk, so the same rules (hidden, ignored, refused) decide whether it is searched.
   */
  private async walkOrFile(path: string): Promise<Walk> {
    const target = await this.files.checked(path, true);
    if (!(await stat(target)).isFile()) return this.walk(path);
    const clean = path.replace(/\\/g, "/").replace(/^(\.\/)+/, "");
    const slash = clean.lastIndexOf("/");
    const folder = await this.walk(slash > 0 ? clean.slice(0, slash) : ".");
    return { ...folder, entries: folder.entries.filter((entry) => entry.path === clean), truncated: false };
  }
  /** Files whose path looks like what was typed, best first. */
  async find(query: string, limit = 20): Promise<{ files: { path: string; score: number }[]; leftOut?: string }> {
    const walk = await this.walk(".");
    const scored = walk.entries
      .map((entry) => ({ path: entry.path, score: scorePath(entry.path, query) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || a.path.length - b.path.length || a.path.localeCompare(b.path));
    return withNote({ files: scored.slice(0, limit) }, walk);
  }

  /** A bounded tree of the workspace with a language guess and the headings or names in each file. */
  async map(path = ".", limit = 200): Promise<MapResult> {
    const walk = await this.walk(path, limit);
    this.cacheHits = 0;
    const files: MapFile[] = [];
    const used = { bytes: 0 };
    let moreAvailable = walk.truncated;
    for (const entry of walk.entries) {
      const language = languageOf(entry.path);
      const symbols = await this.symbolsFor(entry, language);
      if (!bounded(files, { path: entry.path, bytes: entry.bytes, language, symbols }, used)) { moreAvailable = true; break; }
    }
    return withNote({ files, folders: foldersOf(files), cacheHits: this.cacheHits, moreAvailable }, walk);
  }

  private async symbolsFor(entry: WalkEntry, language: string): Promise<string[]> {
    if (!symbolReaders[language] || entry.bytes > 512 * 1024) return [];
    const key = `${entry.mtimeMs}:${entry.bytes}`;
    const cached = this.symbolCache.get(entry.path);
    if (cached?.key === key) { this.cacheHits++; return cached.symbols; }
    const text = await readFile(join(this.files.base, entry.path), "utf8");
    const symbols = symbolReaders[language]!(text).slice(0, 40);
    if (this.symbolCache.size > 2000) this.symbolCache.clear();
    this.symbolCache.set(entry.path, { key, symbols });
    return symbols;
  }
}

export interface GrepInput {
  query: string; path: string; regex: boolean; caseSensitive: boolean;
  glob?: string[] | undefined; context: number; maxResults: number; maxFileBytes: number;
}
export interface GrepMatch { path: string; line: number; text: string; before: string[]; after: string[] }
export interface GrepResult { matches: GrepMatch[]; filesSearched: number; filesSkipped: number; moreAvailable: boolean; leftOut?: string }
export interface MapFile { path: string; bytes: number; language: string; symbols: string[] }
export interface MapResult { files: MapFile[]; folders: string[]; cacheHits: number; moreAvailable: boolean; leftOut?: string }

/** mac7/walk-rules: an answer built from a walk carries the walk's note about what was left out. */
function withNote<T extends object>(result: T, walk: Walk): T & { leftOut?: string } {
  return walk.leftOut ? { ...result, leftOut: walk.leftOut } : result;
}
function safeMatch(path: string, pattern: string): boolean {
  try { return matchesGlob(path, pattern); } catch { return false; }
}
function buildExpression(input: GrepInput): RegExp {
  const source = input.regex ? input.query : input.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  try { return new RegExp(source, input.caseSensitive ? "" : "i"); } catch {
    throw new Error("That search pattern is not a valid regular expression");
  }
}
/** Collects this file's matching lines; false when the answer has no room left. */
function collect(
  path: string, text: string, expression: RegExp, input: GrepInput,
  matches: GrepMatch[], used: { bytes: number },
): boolean {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length && matches.length < input.maxResults; i++) {
    if (!expression.test(lines[i]!)) continue;
    const match: GrepMatch = {
      path, line: i + 1, text: lines[i]!.slice(0, 300),
      before: lines.slice(Math.max(0, i - input.context), i).map(clip),
      after: lines.slice(i + 1, i + 1 + input.context).map(clip),
    };
    if (!bounded(matches, match, used)) return false;
  }
  return true;
}
const clip = (line: string): string => line.slice(0, 300);

/** Subsequence score: every letter typed must appear in order, with a bonus at word boundaries. */
export function scorePath(path: string, query: string): number {
  const haystack = path.toLowerCase(), needle = query.toLowerCase().replace(/\s+/g, "");
  if (!needle) return 0;
  let score = 0, at = 0, previous = -2;
  for (const character of needle) {
    const index = haystack.indexOf(character, at);
    if (index < 0) return 0;
    score += index === previous + 1 ? 5 : 1;
    const before = index > 0 ? haystack[index - 1]! : "/";
    if (before === "/" || before === "-" || before === "_" || before === ".") score += 8;
    if (index > haystack.lastIndexOf("/")) score += 3;
    previous = index;
    at = index + 1;
  }
  return score + Math.max(0, 20 - path.length / 4);
}

const languages: Record<string, string> = {
  ".ts": "TypeScript", ".mts": "TypeScript", ".tsx": "TypeScript", ".js": "JavaScript",
  ".mjs": "JavaScript", ".cjs": "JavaScript", ".jsx": "JavaScript", ".py": "Python",
  ".md": "Markdown", ".json": "JSON", ".html": "HTML", ".css": "CSS", ".yml": "YAML",
  ".yaml": "YAML", ".sql": "SQL", ".sh": "Shell", ".txt": "Text",
};
export function languageOf(path: string): string {
  const dot = path.lastIndexOf(".");
  return (dot > 0 ? languages[path.slice(dot).toLowerCase()] : undefined) ?? "Other";
}
const scriptSymbols = (text: string): string[] =>
  [...text.matchAll(/^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?(?:function\*?|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm)]
    .map((match) => match[1]!);
const symbolReaders: Record<string, (text: string) => string[]> = {
  TypeScript: scriptSymbols,
  JavaScript: scriptSymbols,
  Python: (text) => [...text.matchAll(/^(?:class|def)\s+([A-Za-z_]\w*)/gm)].map((m) => m[1]!),
  Markdown: (text) => [...text.matchAll(/^(#{1,3})\s+(.+)$/gm)].map((m) => `${m[1]!} ${m[2]!.trim()}`.slice(0, 120)),
};
function foldersOf(files: MapFile[]): string[] {
  const folders = new Set<string>();
  for (const file of files) {
    const parts = file.path.split("/");
    for (let i = 1; i < parts.length; i++) folders.add(parts.slice(0, i).join("/"));
  }
  return [...folders].sort().slice(0, 200);
}

const pathSchema = z.string().min(1).max(500);
export function registerCodeSearch(registry: ToolRegistry, search: WorkspaceSearch): void {
  registry.register({
    name: "files.glob", permission: "files.read",
    description: "List workspace files whose path matches a pattern such as \"src/**/*.ts\". Skips ignored and secret-looking files; says when there are more.",
    parameters: z.object({
      patterns: z.array(z.string().min(1).max(200)).min(1).max(20),
      path: pathSchema.default("."),
    }).strict(),
    execute: async (a) => search.glob(a.patterns, a.path),
  });
  registry.register({
    name: "files.grep", permission: "files.read",
    description: "Search inside workspace files for a word or a regular expression and show the lines around each match. Skips files that are not text.",
    parameters: z.object({
      query: z.string().min(1).max(300),
      path: pathSchema.default("."),
      regex: z.boolean().default(false),
      caseSensitive: z.boolean().default(false),
      glob: z.array(z.string().min(1).max(200)).max(20).optional(),
      context: z.number().int().min(0).max(5).default(0),
      maxResults: z.number().int().min(1).max(200).default(60),
      maxFileBytes: z.number().int().min(1024).max(searchLimits.fileBytes).default(2 * 1024 * 1024),
    }).strict(),
    execute: async (a) => search.grep(a),
  });
  registry.register({
    name: "files.find", permission: "files.read",
    description: "Find workspace files when you only remember part of the name; the closest matches come first.",
    parameters: z.object({
      query: z.string().min(1).max(120),
      limit: z.number().int().min(1).max(50).default(20),
    }).strict(),
    execute: async (a) => search.find(a.query, a.limit),
  });
  registry.register({
    name: "workspace.map", permission: "files.read",
    description: "A short map of the workspace: each file's size, what kind of file it is, and the main names or headings inside it.",
    parameters: z.object({
      path: pathSchema.default("."),
      limit: z.number().int().min(1).max(400).default(200),
    }).strict(),
    execute: async (a) => search.map(a.path, a.limit),
  });
}
