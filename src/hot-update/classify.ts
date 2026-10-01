import { readFile, readdir } from "node:fs/promises";
import { join, posix } from "node:path";

/**
 * Live updates (hot-update): which parts of Branch a change reaches, so each part is updated the lightest way it can be.
 *
 * - window: the window's own files (public/**). No build at all: the engine serves the new files once it has checked them,
 *   and the open window takes them in place.
 * - engine: the engine's code (src/** that the desktop's main process never loads, and data/**). Compiled only (tsc), never
 *   packaged; the new engine starts beside the old one and takes over from it.
 * - gateway: compatible Gateway methods replace the resident implementation while its listener and connections stay open.
 * - shell: anything the desktop's main process or preload loads, Electron itself, or the packages. Only these still need
 *   today's packaged swap.
 *
 * A file is placed by what really loads it, not by its folder alone: main.ts imports parts of the engine (providers,
 * never-break, install), and a change there must reach main too, or the two sides would disagree. The folders are the
 * floor: src/desktop/** is always shell, whatever imports it.
 */
export type Part = "window" | "engine" | "gateway" | "shell";
export interface Classified {
  parts: Set<Part>;
  /** The heaviest way this change needs: shell > gateway > engine > window; null when nothing that runs changed. */
  tier: Part | null;
  /** Each changed file and the part it was placed in (null: nothing that runs, such as docs and tests). */
  files: { path: string; part: Part | null }[];
  /** The window's changed files, for the window's own plan (only stylesheets: swapped in place). */
  windowFiles: string[];
}

/** The entry points of each process, as source files. */
export const shellEntries = ["src/desktop/main.ts", "src/desktop/preload.cts"] as const;
/** The gateway runs from `branch start` (src/cli.ts) with the switch on; what it runs itself is worker-link.ts and gateway.ts. */
export const gatewayEntries = ["src/never-break/worker-link.ts", "src/never-break/gateway.ts"] as const;
/** The engine's own entries: the desktop's engine process and `branch start`. */
export const engineEntries = ["src/desktop/engine-process.ts", "src/cli.ts"] as const;
/** Files main reads at run time without importing them (the window and tray icons). */
export const shellAssets = new Set(["public/assets/branch-mascot.png", "public/assets/branch-face.png", "public/assets/branch.ico"]);
/** What packaging reads: a change here is only seen in a packaged app. */
const shellFiles = /^(package-lock\.json|scripts\/(package-desktop|package-macos|package-linux|make-icons|dependency-notices)\.mjs|phone\/)/;
/** Files that never run: a change only here needs nothing but the record of the new change. */
const inert = /^(docs|tests|design|evals|\.github|\.claude|handbook-src)\/|^[^/]+\.md$|^(LICENSE|\.gitignore|\.gitattributes|\.editorconfig)$/;

const order: Part[] = ["window", "engine", "gateway", "shell"];
const heavier = (a: Part | null, b: Part): Part => (a === null || order.indexOf(b) > order.indexOf(a) ? b : a);

/** Relative module names a source file loads (static imports, re-exports, import(), require()). */
export function importsOf(text: string): string[] {
  const found = new Set<string>();
  const patterns = [
    /\b(?:import|export)\s[^'"`;]*?\bfrom\s*["'](\.{1,2}\/[^"']+)["']/g,
    /\bimport\s*["'](\.{1,2}\/[^"']+)["']/g,
    /\bimport\s*\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g,
    // new URL("./engine-process.js", import.meta.url): a module main starts as a process of its own is not main's.
  ];
  for (const pattern of patterns) for (const match of text.matchAll(pattern)) found.add(match[1]!);
  return [...found];
}

/** A compiled name (x.js, x.cjs) as the source file it comes from, among the files that exist. */
function sourceOf(from: string, spec: string, exists: (path: string) => boolean): string | null {
  const joined = posix.normalize(posix.join(posix.dirname(from), spec));
  const candidates = /\.cjs$/.test(joined) ? [joined.replace(/\.cjs$/, ".cts")]
    : /\.js$/.test(joined) ? [joined.replace(/\.js$/, ".ts"), joined.replace(/\.js$/, ".tsx")]
    : [joined, `${joined}.ts`, `${joined}/index.ts`];
  return candidates.find(exists) ?? null;
}

/** Every source file reachable from `entries` by imports, given each file's text. */
export function closure(entries: readonly string[], read: (path: string) => string | null): Set<string> {
  const seen = new Set<string>();
  const queue = entries.filter((entry) => read(entry) !== null);
  const exists = (path: string) => read(path) !== null;
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const spec of importsOf(read(file) ?? "")) {
      const source = sourceOf(file, spec, exists);
      if (source && !seen.has(source)) queue.push(source);
    }
  }
  return seen;
}

/** Whether a package.json change touches what is installed or how the app starts (not just its version). */
export function manifestChanged(before: string | null, after: string | null): boolean {
  if (before === null || after === null) return before !== after;
  try {
    const a = JSON.parse(before) as Record<string, unknown>, b = JSON.parse(after) as Record<string, unknown>;
    const keys = ["dependencies", "devDependencies", "optionalDependencies", "engines", "main", "type", "overrides"];
    return keys.some((key) => JSON.stringify(a[key] ?? null) !== JSON.stringify(b[key] ?? null));
  } catch { return true; }
}

export interface ClassifyInput {
  changed: string[];
  /** The new change's modules, compiled, named as their source files (`readCompiled`), for the import closures. */
  read: (path: string) => string | null;
  /** package.json as it was and as it is (null when missing). */
  manifest?: { before: string | null; after: string | null };
}

/** Places each changed file; unknown files that may run count as shell, the safe side. */
export function classify(input: ClassifyInput): Classified {
  const shell = closure(shellEntries, input.read), gateway = closure(gatewayEntries, input.read);
  const engine = closure(engineEntries, input.read);
  const files: Classified["files"] = [];
  const windowFiles: string[] = [];
  let tier: Part | null = null;
  const parts = new Set<Part>();
  const place = (path: string): Part | null => {
    if (path === "package.json") return input.manifest && !manifestChanged(input.manifest.before, input.manifest.after) ? null : "shell";
    if (shellFiles.test(path) || shellAssets.has(path)) return "shell";
    // src/desktop/** is main's, except what only the engine's own process loads (engine-process.ts and what it alone imports).
    if (path.startsWith("src/desktop/") && (shell.has(path) || !engine.has(path))) return "shell";
    if (path.startsWith("src/")) {
      // Only this module has a resident-state replacement contract. Shared imports keep their main-process classification.
      if (path === "src/never-break/gateway.ts") return "gateway";
      // A removed file is judged by the folders alone (it is in no closure of the new change).
      if (shell.has(path)) return "shell";
      if (gateway.has(path)) return "gateway";
      return "engine";
    }
    // The engine's data, and the handbook it serves, are copied into its build (scripts/copy-data.mjs).
    if (path.startsWith("data/") || path.startsWith("docs/handbook/")) return "engine";
    if (path.startsWith("public/")) return "window";
    if (inert.test(path)) return null;
    // tsconfig, scripts the build runs, anything else: rebuilt and started fresh, never guessed lighter.
    if (/^(tsconfig[^/]*\.json|scripts\/(build-ts|copy-[a-z-]+)\.mjs)$/.test(path)) return "engine";
    return "shell";
  };
  for (const path of input.changed) {
    const part = place(path);
    files.push({ path, part });
    if (!part) continue;
    parts.add(part);
    tier = heavier(tier, part);
    if (part === "window") windowFiles.push(path);
  }
  return { parts, tier, files, windowFiles };
}

/**
 * The compiled build's modules (`root`/dist), named as the source files they come from (dist/x.js as src/x.ts), for
 * `classify`'s closures. Compiled, because that is what really loads: an `import type` is gone from it, and with it the
 * hundreds of engine files main names only for their types.
 */
export async function readCompiled(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const copied = /^(data|handbook|bundled-add-ons)$/;
  const walk = async (dir: string, rel: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const path = join(dir, entry.name), name = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { if (!(rel === "" && copied.test(entry.name))) await walk(path, name); }
      else if (/\.c?js$/.test(entry.name)) out.set(`src/${name.replace(/\.js$/, ".ts").replace(/\.cjs$/, ".cts")}`, await readFile(path, "utf8"));
    }
  };
  await walk(join(root, "dist"), "");
  return out;
}

/** Only the window's stylesheets changed: the open window swaps them in place, without reloading anything. */
export const stylesOnly = (windowFiles: string[]): boolean => windowFiles.length > 0 && windowFiles.every((path) => /\.css$/.test(path));
