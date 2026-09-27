import { lstat, mkdir, open, readdir, readFile, rename, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve, relative, isAbsolute, dirname, join } from "node:path";
import { constants } from "node:fs";
import { z } from "zod";
import type { ToolRegistry } from "./registry.js";
import type { ToolContext } from "./contracts.js";
import { ignoreMatcher, type IgnoreMatcher } from "./ignore.js";
import type { ReadFirstGuard } from "./coding/read-first.js";
import { allowAll, WalkRules, type PathCheck } from "./walk-rules.js"; // mac7/walk-rules
import type { RunSource } from "./policy.js";
import {
  listAndMoveOnly, listOwnerFolder, moveInOwnerFolder, outsideReach, ownerFolderNames, ownerPathOf, requireOwnerFolder,
  type OwnerFolderHost, type OwnerPath,
} from "./owner-folders.js";

const pathSchema = z.string().min(1).max(500);
const secret =
  /(^\.env($|\.)|^\.ssh$|^\.aws$|^\.git$|^\.branch$|credentials|secrets?|^id_rsa|^id_ed25519|\.(pem|key|p12|pfx)$)/i;
/**
 * More places keys and passwords live, refused the same way (after IronClaw's list of sensitive
 * paths): sign-in files for package registries and servers, container and cluster settings, other
 * key folders, and the history files a shell keeps of every command typed, which often hold a
 * password typed on the command line. Each name is matched whole, so `docker-compose.yml` and
 * `history.ts` stay readable.
 */
const moreSecret =
  /^(?:[._]netrc|\.npmrc|\.pypirc|\.pgpass|\.docker|\.kube|\.gnupg|\.azure|\.gcloud|\.vault-token|\.terraformrc|id_ecdsa|id_dsa|\.[\w-]*_history|\.histfile|fish_history|consolehost_history\.txt|[^/]*\.(?:jks|keystore))$/i;
/** Credentials that are only recognisable by their folder: the GitHub command line's sign-in file and gcloud's settings. */
const secretPath = /(?:^|\/)(?:gh\/hosts\.ya?ml|\.config\/gcloud)(?:\/|$)/i;
const secretName = (name: string): boolean => secret.test(name) || moreSecret.test(name);
/** True for a workspace path (forward slashes) whose last name or folder marks it as holding keys. */
export const isSecretEntry = (path: string): boolean =>
  secretName(path.slice(path.lastIndexOf("/") + 1)) || secretPath.test(path);
export class WorkspaceFiles {
  /** A subfolder of the workspace that all paths resolve inside (the active project's folder), or "" for the whole workspace. */
  scope: () => string = () => "";
  /**
   * Folders the assistant may read but never change, with the sentence to refuse with. Set once at
   * start-up. This exists for folders the assistant itself writes from something else — the mirror
   * of what it remembers — where a change made here would be silently undone the next time that
   * folder is written, and a change nobody can keep is worse than a plain refusal.
   */
  readOnly: (path: string) => string = () => "";
  /** mac7/coding-next: the read-before-edit guard, when the app set one up (src/coding/read-first.ts). */
  readFirst: ReadFirstGuard | undefined;
  /**
   * mac7/walk-rules: the rules one folder walk is held to, for every file and folder it lists or reads
   * (src/walk-rules.ts). Set once at start-up: a task's walk gets its task's rules; a walk for work from
   * outside names where it came from; anything else (the owner's own window) is not held.
   */
  walkRules: (outside?: { source: RunSource }) => PathCheck = () => allowAll;
  /** The owner's Downloads, Desktop and Documents, once the app has connected its questions (src/owner-folders.ts). */
  ownerFolders: OwnerFolderHost | undefined;
  /** The home folder those three are in: the person's own, read each time. */
  home: () => string = () => homedir();
  constructor(readonly root: string) {}
  /**
   * The owner folder a path names (`~/Downloads/a.pdf`, a full path into one, or `Downloads/a.pdf` when the workspace
   * has nothing called Downloads), or null for a workspace path. A place outside both is an error in plain words.
   */
  async ownerPlace(raw: string): Promise<OwnerPath | null> {
    const first = String(raw ?? "").trim().replace(/\\/g, "/").split("/")[0] ?? "";
    const named = ownerFolderNames.some((name) => name.toLowerCase() === first.toLowerCase());
    const bare = named && !(await lstat(resolve(this.base, first)).then(() => true, () => false));
    const place = ownerPathOf(raw, this.home(), bare);
    if (place === "outside") throw new Error(outsideReach(raw));
    if (place && !this.ownerFolders) throw new Error(outsideReach(raw));
    return place;
  }
  /** Asks about, or refuses, working in the folder a place is in; see src/owner-folders.ts. */
  requireOwnerFolder(context: ToolContext, place: OwnerPath): void {
    if (!this.ownerFolders) throw new Error(outsideReach(place.folder.path));
    requireOwnerFolder(this.ownerFolders, context, place.folder);
  }
  /** The full address a workspace path stands for, as the read-before-edit guard keys it. */
  addressOf(path: string): string {
    return resolve(this.base, path);
  }
  /** The same checks as `checked`, and then a refusal for a folder the assistant may only read. */
  async checkedForWrite(path: string): Promise<string> {
    const refusal = this.readOnly(path.replace(/^\.\//, "").replace(/\\/g, "/"));
    if (refusal) throw new Error(refusal);
    return this.checked(path);
  }
  /** The folder paths currently resolve against: the workspace or the active project's folder inside it. */
  get base(): string {
    const folder = this.scope();
    return folder ? resolve(this.root, folder) : this.root;
  }
  async checked(path: string, allowRoot = false): Promise<string> {
    // QA (first task): a wildcard or a place outside the workspace is said plainly, with what to do instead, never
    // turned into an empty answer the model takes for "nothing there".
    if (/[*?]/.test(path))
      throw new Error(`Path denied: "${path}" has a wildcard in it, and a wildcard is not a path. Use files.list to see the files, then files.move or files.edit one file at a time.`);
    if (isAbsolute(path) || /^[a-z]:/i.test(path) || path.startsWith("~") || path.startsWith("\\")) {
      let place: ReturnType<typeof ownerPathOf> = "outside";
      try { place = ownerPathOf(path, this.home()); } catch { place = "outside"; } // a refused part: outside all the same
      throw new Error(`Path denied: ${place && place !== "outside" ? listAndMoveOnly(path, place.folder) : outsideReach(path)}`);
    }
    if (
      path.includes("\\") ||
      path.includes(":") ||
      isAbsolute(path) ||
      path
        .split("/")
        .some(
          (p) =>
            p === ".." ||
            p === "" ||
            (p !== "." && p.endsWith(".")) ||
            p.endsWith(" ") ||
            secretName(p),
        ) ||
      secretPath.test(path)
    )
      throw new Error("Path denied: traversal or secret filename");
    if (path === "." && !allowRoot) throw new Error("File path required");
    const base = this.base, target = resolve(base, path),
      rel = relative(base, target);
    if (rel.startsWith("..") || isAbsolute(rel))
      throw new Error("Path outside workspace");
    if (
      rel &&
      (await this.hidden(relative(this.root, target), allowRoot))
    )
      throw new Error("Path hidden by .branchignore");
    await checkWorkspaceAncestors(this.root);
    if (base !== this.root) await mkdir(base, { recursive: true });
    let current = base;
    for (const part of rel.split(/[\\/]/).filter(Boolean)) {
      current = join(current, part);
      try {
        if ((await lstat(current)).isSymbolicLink())
          throw new Error("Symbolic link or junction path denied");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") break;
        throw e;
      }
    }
    return target;
  }
  /**
   * The owner's `.branchignore` in the workspace root, re-read whenever the file changes. The
   * fixed secret patterns above are applied first, so a `!` line in this file cannot bring an
   * `.env` or a key back into view; it only ever hides more.
   */
  private ignore: { at: number; matcher: IgnoreMatcher } | undefined;
  private async matcher(): Promise<IgnoreMatcher | undefined> {
    try {
      const file = resolve(this.root, ".branchignore");
      const info = await stat(file);
      if (!info.isFile() || info.size > 65536) return undefined;
      if (this.ignore?.at !== info.mtimeMs)
        this.ignore = { at: info.mtimeMs, matcher: ignoreMatcher(await readFile(file, "utf8")) };
      return this.ignore.matcher;
    } catch {
      return undefined;
    }
  }
  /** True when `.branchignore` hides this path, written relative to the workspace root. */
  async hidden(path: string, isDirectory = false): Promise<boolean> {
    const matcher = await this.matcher();
    const relative = path.replace(/\\/g, "/").replace(/^\/+/, "");
    return !!relative && !!matcher && matcher.ignores(relative, isDirectory);
  }
  async read(path: string): Promise<{ path: string; content: string }> {
    const target = await this.checked(path);
    const handle = await open(
      target,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    try {
      const stat = await handle.stat();
      if (stat.nlink > 1) throw new Error("Hardlink path denied");
      if (!stat.isFile() || stat.size > 32768)
        throw new Error("File exceeds 32 KiB or is not regular");
      return { path, content: await handle.readFile("utf8") };
    } finally {
      await handle.close();
    }
  }
  async write(
    path: string,
    content: string,
    signal: AbortSignal,
  ): Promise<{ path: string; bytes: number }> {
    if (Buffer.byteLength(content) > 32768)
      throw new Error("File exceeds 32 KiB");
    const target = await this.checkedForWrite(path);
    await mkdir(dirname(target), { recursive: true });
    await this.checked(path);
    signal.throwIfAborted();
    const handle = await open(
      target,
      constants.O_WRONLY | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    try {
      const stat = await handle.stat();
      if (stat.nlink > 1) throw new Error("Hardlink path denied");
      if (!stat.isFile()) throw new Error("Not a regular file");
      await handle.truncate(0);
      await handle.writeFile(content);
    } finally {
      await handle.close();
    }
    return { path, bytes: Buffer.byteLength(content) };
  }
  /**
   * The entries of one folder. mac7/walk-rules: held to the rules one walk is under (`rules`, shared
   * by a walk over many folders; a single listing makes its own and says what it left out).
   */
  async list(
    path = ".", rules?: WalkRules, outside?: { source: RunSource },
  ): Promise<{ entries: { name: string; type: string }[]; leftOut?: string }> {
    const walk = rules ?? new WalkRules(this.walkRules(outside));
    walk.start(path);
    const target = await this.checked(path, true);
    const here = relative(this.root, target).replace(/\\/g, "/");
    const from = relative(this.base, target).replace(/\\/g, "/");
    const entries: { name: string; type: string }[] = [];
    for (const e of (await readdir(target, { withFileTypes: true })).slice(0, 400)) {
      if (entries.length >= 200) break;
      if (e.isSymbolicLink() || isSecretEntry(here ? `${here}/${e.name}` : e.name)) continue;
      if (await this.hidden(here ? `${here}/${e.name}` : e.name, e.isDirectory()))
        continue;
      const child = from ? `${from}/${e.name}` : e.name;
      if (!(e.isDirectory() ? walk.folder(child) : walk.file(child, "list"))) continue;
      entries.push({ name: e.name, type: e.isDirectory() ? "directory" : "file" });
    }
    return rules ? { entries } : walk.noted({ entries });
  }
  /** Moves one workspace file to a new workspace path; the folder it goes into is made. Never replaces a file. */
  async move(from: string, to: string, signal: AbortSignal): Promise<{ from: string; to: string }> {
    const source = await this.checkedForWrite(from), target = await this.checkedForWrite(to);
    const info = await lstat(source).catch(() => null);
    if (!info) throw new Error(`${from} does not exist. Use files.list to see the files.`);
    if (!info.isFile()) throw new Error(`${from} is not a file. Move files one at a time.`);
    if (info.nlink > 1) throw new Error("Hardlink path denied");
    if (await lstat(target).then(() => true, () => false)) throw new Error(`${to} already exists, so nothing was moved.`);
    await mkdir(dirname(target), { recursive: true });
    await this.checked(to); // the folders just made are checked again
    signal.throwIfAborted();
    await rename(source, target);
    return { from, to };
  }
  async search(
    query: string,
    path = ".",
  ): Promise<{ matches: { path: string; line: number; text: string }[]; leftOut?: string }> {
    const matches: { path: string; line: number; text: string }[] = [];
    const rules = new WalkRules(this.walkRules()); // mac7/walk-rules: one walk, one set of rules
    const queue = [path];
    let scanned = 0;
    while (queue.length && scanned < 200 && matches.length < 50) {
      const directory = queue.shift()!;
      for (const entry of (await this.list(directory, rules)).entries) {
        if (++scanned > 200 || matches.length >= 50) break;
        const child =
          directory === "." ? entry.name : `${directory}/${entry.name}`;
        if (entry.type === "directory") {
          if (child.split("/").length < 6) queue.push(child);
          continue;
        }
        if (!rules.file(child)) continue;
        try {
          const file = await this.read(child);
          file.content.split("\n").forEach((text, i) => {
            if (matches.length < 50 && text.includes(query))
              matches.push({
                path: child,
                line: i + 1,
                text: text.slice(0, 500),
              });
          });
        } catch {
          /* Unreadable files are excluded. */
        }
      }
    }
    return rules.noted({ matches });
  }
}
/**
 * macOS and Linux ship root-owned links in ordinary paths (`/var` → `/private/var`, `/tmp`), and
 * nobody but root can make one, so those are layout rather than a planted escape. Windows reports
 * uid 0 for every file, so there every link is still refused.
 */
function isSystemLink(info: { uid: number }): boolean {
  return process.platform !== "win32" && info.uid === 0;
}
async function checkWorkspaceAncestors(root: string): Promise<void> {
  let current = resolve(root);
  while (true) {
    const info = await lstat(current);
    if (info.isSymbolicLink() && !isSystemLink(info))
      throw new Error("Workspace or ancestors contain a link");
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}
/** Lets workspace history keep a file's bytes before a write and record the change afterwards. */
export interface WriteObserver {
  before(path: string, context: ToolContext): Promise<unknown>;
  after(path: string, context: ToolContext, token: unknown): Promise<void>;
}
export function registerFiles(
  registry: ToolRegistry,
  files: WorkspaceFiles,
  observer?: WriteObserver,
): void {
  registry.register({
    name: "files.read",
    description: "Read a UTF-8 workspace file, maximum 32 KiB.",
    permission: "files.read",
    parameters: z.object({ path: pathSchema }).strict(),
    execute: async (a, c: ToolContext) => {
      const file = await files.read(a.path);
      files.readFirst?.noteRead(c.runId, files.addressOf(a.path), file.content); // mac7/coding-next
      return file;
    },
  });
  registry.register({
    name: "files.list",
    description: "List up to 200 entries of a folder: a workspace folder, or the person's own ~/Downloads, ~/Desktop or ~/Documents (they are asked once per folder).",
    permission: "files.read",
    parameters: z.object({ path: pathSchema.default(".") }).strict(),
    execute: async (a, c: ToolContext) => {
      const place = await files.ownerPlace(a.path);
      if (!place) return files.list(a.path);
      files.requireOwnerFolder(c, place);
      return listOwnerFolder(place);
    },
  });
  const moveSchema = z.object({ from: pathSchema, to: pathSchema }).strict();
  registry.register({
    name: "files.move",
    description: "Move or rename files: {from, to} for one file, or {moves: [{from, to}, ...]} for several at once (with moves, from and to may name the folder the names are in). Both paths in the workspace, or both in the same one of ~/Downloads, ~/Desktop and ~/Documents (for example from ~/Downloads/a.pdf to ~/Downloads/Documents/a.pdf). The folders they go into are made; an existing file is never replaced.",
    permission: "files.write",
    parameters: z.object({ from: pathSchema.optional(), to: pathSchema.optional(), moves: z.array(moveSchema).min(1).max(50).optional() }).strict()
      .refine((a) => Boolean(a.moves || (a.from && a.to)), "Give from and to for one file, or moves for several."),
    target: (a) => a.moves?.[0]?.from ?? a.from ?? null,
    execute: async (a, c: ToolContext) => {
      const moves = a.moves ? batchMoves(a.moves, a.from, a.to) : [{ from: a.from!, to: a.to! }];
      const places = await Promise.all(moves.map(async (move) => ({ ...move, fromPlace: await files.ownerPlace(move.from), toPlace: await files.ownerPlace(move.to) })));
      if (places.every((one) => !one.fromPlace && !one.toPlace)) {
        const moved = [];
        for (const one of places) moved.push(await files.move(one.from, one.to, c.signal));
        return moved.length === 1 ? moved[0] : { moved };
      }
      const folder = places[0]!.fromPlace?.folder.path;
      if (places.some((one) => !one.fromPlace || !one.toPlace || one.fromPlace.folder.path !== folder || one.toPlace.folder.path !== folder))
        throw new Error("Files can only be moved within one folder: every path in the workspace, or every path in the same one of ~/Downloads, ~/Desktop and ~/Documents.");
      files.requireOwnerFolder(c, places[0]!.fromPlace!);
      return moveInOwnerFolder(places.map((one) => ({ from: one.fromPlace!, to: one.toPlace! })));
    },
  });
  registry.register({
    name: "files.search",
    description:
      "Literal content search, bounded to 200 entries and 50 matches.",
    permission: "files.read",
    parameters: z
      .object({
        query: z.string().min(1).max(200),
        path: pathSchema.default("."),
      })
      .strict(),
    execute: async (a) => files.search(a.query, a.path),
  });
  registry.register({
    name: "files.write",
    description: "Write a UTF-8 workspace file, maximum 32 KiB.",
    permission: "files.write",
    parameters: z
      .object({ path: pathSchema, content: z.string().max(32768) })
      .strict(),
    execute: async (a, c: ToolContext) => {
      // mac7/coding-next: an existing file is replaced only once this task has read it as it is now.
      if (!c.readFirstExempt && files.readFirst?.holds(c.runId)) await files.readFirst.require(c.runId, await files.checked(a.path), a.path);
      const token = observer ? await observer.before(a.path, c) : undefined;
      const result = await files.write(a.path, a.content, c.signal);
      files.readFirst?.noteWritten(c.runId, files.addressOf(a.path));
      if (observer) await observer.after(a.path, c, token);
      return result;
    },
  });
  registerVerification(registry, files);
}
/**
 * A batch of moves as a small model writes it: `from` and `to` beside `moves` name the folders its names are in, and a
 * bare name in a batch that works in one of the person's folders is in that folder.
 */
function batchMoves(moves: readonly { from: string; to: string }[], fromBase?: string, toBase?: string): { from: string; to: string }[] {
  const rooted = (path: string): boolean => /^(~|\/|\\|[a-z]:)/i.test(path);
  const under = (base: string | undefined, path: string): string => (base && !rooted(path) ? `${base.replace(/[\\/]+$/, "")}/${path}` : path);
  const joined = moves.map((move) => ({ from: under(fromBase, move.from), to: under(toBase ?? fromBase, move.to) }));
  const owner = joined.flatMap((move) => [move.from, move.to]).map((path) => /^~[\\/](downloads|desktop|documents)\b/i.exec(path)?.[0]).find(Boolean);
  return owner ? joined.map((move) => ({ from: rooted(move.from) ? move.from : `${owner}/${move.from}`, to: rooted(move.to) ? move.to : `${owner}/${move.to}` })) : joined;
}
function registerVerification(
  registry: ToolRegistry,
  files: WorkspaceFiles,
): void {
  registry.register({
    name: "files.verify",
    description: "Compare actual file content to an exact expected string.",
    permission: "files.read",
    parameters: z
      .object({ path: pathSchema, expected: z.string().max(32768) })
      .strict(),
    execute: async (a) => ({
      path: a.path,
      verified: (await files.read(a.path)).content === a.expected,
    }),
  });
}
