import { appendFileSync, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { optionalFields } from "./feature-switches.js"; // Q65
import { scrubText } from "./diagnostics.js";
import { redactLeaks } from "./leak-guard.js";
import type { Store } from "./store.js";

/**
 * mac7/diagnostics: the activity log — one file of plain JSON lines, on this computer only, that
 * every part of Branch can write to: the engine, the window, the chat apps, outside AI-tool
 * servers, the updater. Each line says when, how serious, which part, and which task or request it
 * belongs to, so a problem can be followed from start to end. Nothing here sends anything anywhere.
 *
 * Every value is cleaned as it is written, never later: keys, tokens, "Bearer" headers, email
 * addresses and the owner's home folder never reach the disk. The file is kept small (rotated at a
 * size cap) and short-lived (older files are removed after a number of days).
 *
 * Most of Branch ships off; this does not. The owner decided (2026-09-21) that the log and crash
 * capture are on from the start, because a person whose Branch breaks before they found the switch
 * has nothing to send otherwise. So the log ships at "when needed" — warnings and errors only, under
 * its size cap and day limit — and crash capture — a crash note in `crashes.jsonl` with the last few
 * things that happened before it, and Electron's own crash files in the desktop app — ships on. Both
 * stay switches: the owner can turn either off, or the log up to everything. Nothing is ever sent;
 * the owner decides whether to hand a file to anyone. Crashes still reach the task record as they
 * always did (src/tracing.ts).
 */
export const logModes = ["off", "when-needed", "on"] as const;
export type LogMode = (typeof logModes)[number];
export const logLevels = ["debug", "info", "warn", "error"] as const;
export type Level = (typeof logLevels)[number];

export const DiagnosticLogSettingsSchema = z.object({
  /** off: nothing written; when-needed: warnings and errors; on: everything from "info" up. */
  mode: z.enum(logModes).default("when-needed"),
  /** Older log files than this are removed. */
  keepDays: z.number().int().min(1).max(90).default(14),
  /** The most the log may take on disk, across all its files. */
  maxMegabytes: z.number().int().min(1).max(200).default(20),
  /**
   * mac7/coding-next: keep crash notes (`crashes.jsonl`) and, in the desktop app, Electron's crash
   * files. On by default (the owner's decision). The desktop app reads it when it starts, so there a change applies at the
   * next start; the engine's own crash notes follow it at once.
   */
  crashCapture: z.enum(["off", "on"]).default("on"),
}).strict();
export type DiagnosticLogSettings = z.infer<typeof DiagnosticLogSettingsSchema>;

const settingsKey = "diagnostic-log";
export function diagnosticLogSettings(store: Pick<Store, "get">, owner: string): DiagnosticLogSettings {
  const saved = DiagnosticLogSettingsSchema.safeParse(store.get("settings", owner, settingsKey)?.data ?? {});
  return saved.success ? saved.data : DiagnosticLogSettingsSchema.parse({});
}
export function saveDiagnosticLogSettings(store: Store, owner: string, input: unknown): DiagnosticLogSettings {
  // zod 4's .partial() still fills each missing field with its default, so only the fields that were
  // really sent are laid over what is saved; otherwise saving the log's mode would switch crash capture off.
  const changed = optionalFields(DiagnosticLogSettingsSchema).parse(input ?? {});
  const next = DiagnosticLogSettingsSchema.parse({ ...diagnosticLogSettings(store, owner), ...changed });
  store.save("settings", owner, settingsKey, next);
  return next;
}

// ---- cleaning ----

const emailPattern = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g;
const secretField = /(api[-_]?key|^key$|token|secret|password|passphrase|authorization|^auth$|bearer|credential|cookie|^session$|^sid$|private[-_]?key|pin$)/i;
const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Key shapes the shared leak guard does not know (it is tuned for tool results, where a false alarm
 * hides real work); in a log line a false alarm only costs a few characters, so these are wider.
 */
const providerKeys = [
  /\bAIza[0-9A-Za-z_-]{30,}/g, // Google
  /\b(?:gsk|hf|r8|pplx|glpat|npm|dop_v1|fw|nvapi|csk|tvly)[_-][A-Za-z0-9_-]{16,}/g, // Groq, Hugging Face, Replicate, Perplexity, GitLab, npm, …
  /\bxai-[A-Za-z0-9_-]{16,}/g, // xAI
  /\bsk[_-][A-Za-z0-9_-]{12,}/g, // OpenAI, Anthropic, Stripe and the many services that copied the prefix
  /(?<!\d)\d{6,12}:[A-Za-z0-9_-]{30,}/g, // Telegram bot tokens (also inside api.telegram.org/bot…/ addresses)
  /\b[MNO][A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{5,8}\.[A-Za-z0-9_-]{25,}/g, // Discord bot tokens
  /\beyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]*/g, // any JWT, however short its parts
  /\b(?:aws_secret_access_key|secret(?:[_ -]?access)?[_ -]?key)\s*[:=]?\s*["']?[A-Za-z0-9/+]{40}\b/gi, // AWS secret keys
  /\bsecret\s+[A-Za-z0-9/+]{40}\b/gi,
  /\b(?:Basic|Digest)\s+[A-Za-z0-9+/=]{6,}/g, // HTTP sign-in values outside a header line
];
/** Whole header lines whose value is a credential, to the end of the line (a Basic value, every cookie). */
const secretHeader = /\b(proxy-authorization|authorization|set-cookie|cookie|x-api-key|api-key|x-goog-api-key|x-auth-token|x-access-token|private-token)\s*[:=]\s*[^\n\r]*/gi;
/** The same header or field as a JSON pair: `"cookie": "sid=…"`. */
const secretJsonPair = /"([\w-]*(?:authorization|cookie|api[-_]?key|token|secret|password|passphrase|credential|session)[\w-]*)"\s*:\s*"(?:[^"\\]|\\.)*"/gi;
/** A labelled key in running text: `key: 3kX9…`, `token=abc…`. */
const labelledKey = /\b((?:api[-_ ]?)?key|token|secret|password|passphrase)(\s*[:=]\s*)["']?[A-Za-z0-9_./+-]{12,}/gi;
/** Web address parameters that carry a credential: ?key=, &access_token=, X-Amz-Signature=, … */
const secretParam = /([?&#;](?:[\w.-]*(?:key|token|sig|signature|secret|password|passwd|auth|session|sid|code|credential|ticket)[\w.-]*))=(?!\[)([^&\s#"'<>]+)/gi;
/** Other people's home folders, on any system, and in JSON's doubled backslashes too. */
const anyHome = /((?:\b[A-Za-z]:)?(?:\\\\|\\|\/)(?:Users|home|Documents and Settings)(?:\\\\|\\|\/))(?!Shared\b|Public\b|\[user\])[^\\/\s"'<>|:*?]+/gi;
/** A Windows network share, `\\server\share\…`: the machine and share names are the owner's own. */
const networkShare = /(?<=^|[\s"'(=,[])(?:\\\\){1,2}[A-Za-z0-9._$-]+(?:\\{1,2}[^\\\s"'<>|]+)*/g;
/** Email addresses written into a web address (`name%40example.com`). */
const encodedEmail = /\b[A-Za-z0-9._%+-]+%40[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g;

/** A cleaner bound to one home folder (the real one unless a test names another). */
export function makeRedactor(home = homedir()): (text: string) => string {
  const homes = [home, home.replace(/\\/g, "/"), home.replace(/\\/g, "\\\\")]
    .filter((each, index, all) => each.length > 3 && all.indexOf(each) === index);
  const homePattern = homes.length ? new RegExp(homes.map(escapeRegExp).join("|"), "gi") : null;
  return (text) => {
    let out = redactLeaks(text).text;
    out = scrubText(out);
    out = out.replace(secretHeader, "$1: [removed]");
    out = out.replace(secretJsonPair, '"$1":"[removed]"');
    for (const pattern of providerKeys) out = out.replace(pattern, "[removed]");
    out = out.replace(secretParam, "$1=[removed]");
    out = out.replace(labelledKey, "$1$2[removed]");
    out = out.replace(emailPattern, "[email removed]").replace(encodedEmail, "[email removed]");
    if (homePattern) out = out.replace(homePattern, "~");
    out = out.replace(anyHome, "$1[user]");
    out = out.replace(networkShare, "\\\\[network share]");
    return out;
  };
}
export const redactForLog = makeRedactor();

/** The same through fields: secret-named keys are removed whole; nested values are cleaned or dropped. */
export function redactFields(value: unknown, clean: (text: string) => string = redactForLog, depth = 0): unknown {
  if (typeof value === "string") return clean(value).slice(0, 2000);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (depth > 4 || typeof value !== "object") return undefined;
  if (Array.isArray(value)) return value.slice(0, 50).map((each) => redactFields(each, clean, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, each] of Object.entries(value as Record<string, unknown>).slice(0, 50))
    out[key] = secretField.test(key) ? "[removed]" : redactFields(each, clean, depth + 1);
  return out;
}

// ---- the log ----

export interface LogLine {
  at: string; level: Level; component: string; message: string;
  taskId?: string; requestId?: string; fields?: Record<string, unknown>; pid: number;
}
export interface LogWrite {
  level: Level; component: string; message: string;
  taskId?: string; requestId?: string; fields?: Record<string, unknown>;
}
export interface LogFilter { component?: string; level?: Level; task?: string; limit?: number }
const rank: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const fileCount = 5;
const breadcrumbCount = 30;

export class DiagnosticLog {
  readonly dir: string;
  private readonly settings: () => DiagnosticLogSettings;
  private readonly clean: (text: string) => string;
  private readonly now: () => Date;
  private readonly onLine: ((line: LogLine) => void) | undefined;
  private readonly crumbs: LogLine[] = [];

  constructor(options: {
    dir: string; settings: () => DiagnosticLogSettings; clean?: (text: string) => string;
    now?: () => Date; onLine?: (line: LogLine) => void;
  }) {
    this.dir = options.dir;
    this.settings = options.settings;
    this.clean = options.clean ?? redactForLog;
    this.now = options.now ?? (() => new Date());
    this.onLine = options.onLine;
  }

  get file(): string { return join(this.dir, "branch.jsonl"); }
  get crashFile(): string { return join(this.dir, "crashes.jsonl"); }

  /** Writes one line if the mode lets it through; it is always kept as a breadcrumb in memory. */
  write(entry: LogWrite): void {
    const line = this.shape(entry);
    this.crumbs.push(line);
    if (this.crumbs.length > breadcrumbCount) this.crumbs.shift();
    try { this.onLine?.(line); } catch { /* observing a problem must never become another problem */ }
    const { mode, maxMegabytes } = this.currentSettings();
    if (mode === "off") return;
    if (rank[line.level] < (mode === "on" ? rank.info : rank.warn)) return;
    try { this.append(this.file, JSON.stringify(line), (maxMegabytes * 1024 * 1024) / fileCount); } catch { /* a log line must never break Branch */ }
  }

  /** Last things that happened, newest last, already cleaned. Kept in memory only. */
  breadcrumbs(): LogLine[] { return [...this.crumbs]; }

  /**
   * A crash, written straight away (synchronously) with the breadcrumbs before it — only while the
   * owner has crash capture on. The one-line "Crashed:" entry is an ordinary log line and follows the
   * log's own switch, as every other line does.
   */
  crash(component: string, error: unknown, origin = "uncaught"): void {
    const message = withoutQuotedText(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
    if (this.capturesCrashes()) {
      const stack = withoutQuotedText(error instanceof Error ? error.stack ?? "" : "");
      const line = this.shape({ level: "error", component, message, fields: { origin, stack: stack.slice(0, 4000) } });
      const record = { ...line, kind: "crash", breadcrumbs: this.breadcrumbs() };
      try { this.append(this.crashFile, JSON.stringify(record), 512 * 1024); } catch { /* never a second crash */ }
    }
    try { this.write({ level: "error", component, message: `Crashed: ${message}`, fields: { origin } }); } catch { /* never a second crash */ }
  }

  /** Lines newest first, across the rotated files, with the owner's filters. */
  read(filter: LogFilter = {}): LogLine[] {
    const limit = Math.min(Math.max(filter.limit ?? 200, 1), 2000);
    const found: LogLine[] = [];
    for (const file of this.files(this.file)) {
      const lines = readLines(file).reverse();
      for (const line of lines) {
        if (!matches(line, filter)) continue;
        found.push(line);
        if (found.length >= limit) return found;
      }
    }
    return found;
  }

  crashes(limit = 20): (LogLine & { breadcrumbs?: LogLine[] })[] {
    return this.files(this.crashFile).flatMap((file) => readLines(file).reverse()).slice(0, limit);
  }

  /** Removes rotated files older than the owner's number of days. Returns how many went. */
  prune(): number {
    const cutoff = this.now().getTime() - this.currentSettings().keepDays * 86_400_000;
    let removed = 0;
    for (const file of [...this.files(this.file), ...this.files(this.crashFile)]) {
      try { if (statSync(file).mtimeMs < cutoff) { unlinkSync(file); removed += 1; } } catch { /* already gone */ }
    }
    return removed;
  }

  /** Removes every log file: the owner's "Clear the log". */
  clear(): void {
    for (const file of [...this.files(this.file), ...this.files(this.crashFile)]) try { unlinkSync(file); } catch { /* gone */ }
    this.crumbs.length = 0;
  }

  /**
   * The owner's settings, or the shipped ones when they cannot be read: a crash while
   * Branch is closing arrives after its database has shut, and reading it then threw inside the
   * crash handler, which ended the process with the wrong error.
   */
  private currentSettings(): DiagnosticLogSettings {
    try { return this.settings(); } catch { return DiagnosticLogSettingsSchema.parse({}); }
  }
  /**
   * mac7/coding-next: whether crash notes are kept. Once the database has closed the setting cannot be
   * read, so the switch file beside the log (the one the desktop app reads at start) answers instead.
   */
  private capturesCrashes(): boolean {
    try { return this.settings().crashCapture === "on"; } catch { return crashCaptureMarkedIn(this.dir); }
  }

  private shape(entry: LogWrite): LogLine {
    const fields = entry.fields ? redactFields(entry.fields, this.clean) as Record<string, unknown> : undefined;
    return {
      at: this.now().toISOString(), level: entry.level, component: this.clean(entry.component).slice(0, 40),
      message: this.clean(entry.message).slice(0, 1000),
      ...(entry.taskId ? { taskId: entry.taskId.slice(0, 80) } : {}),
      ...(entry.requestId ? { requestId: entry.requestId.slice(0, 80) } : {}),
      ...(fields && Object.keys(fields).length ? { fields } : {}), pid: process.pid,
    };
  }

  /**
   * One whole line, appended. Two processes write `branch.jsonl`: the engine, and the desktop app's main process
   * (src/desktop/main-log.ts). Each line is one append to the file opened for appending and closed again, so it
   * lands whole after the other writer's lines, never inside one, and a rotation that fails never loses the line.
   */
  private append(file: string, text: string, perFile: number): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const size = sizeOf(file);
    if (size > 0 && size + text.length + 1 > perFile) rotate(file);
    appendFileSync(file, text + "\n", { mode: 0o600 });
  }

  /** The live file and its rotated copies, newest first. */
  private files(base: string): string[] {
    const all = [base, ...Array.from({ length: fileCount - 1 }, (_, index) => rotated(base, index + 1))];
    return all.filter((file) => existsSync(file));
  }
}

/**
 * A failure's own words can quote the text it choked on: `JSON.parse` says `Unexpected token 'h',
 * "hello, my"... is not valid JSON`, and that text can be a message or a reply. Quoted text in a
 * crash note is replaced, so a crash can never carry what the owner wrote or was sent.
 */
export function withoutQuotedText(text: string): string {
  return text.replace(/"(?:[^"\\\n]|\\.){4,}"(?:\.\.\.)?/g, '"[text removed]"').replace(/'(?:[^'\\\n]|\\.){4,}'/g, "'[text removed]'");
}
const rotated = (base: string, index: number): string => base.replace(/\.jsonl$/, `.${index}.jsonl`);
const sizeOf = (file: string): number => { try { return statSync(file).size; } catch { return 0; } };
/**
 * Moves the full file aside and drops the oldest copy. Adapted from OpenClaw's file transport (MIT,
 * openclaw/openclaw src/logging/logger-file-transport.ts): rotation happens only between whole lines, each move
 * is tried on its own, and a rotation that fails still lets the line be written (the next write tries again). With
 * two writers a copy may already have been moved by the other one, or, on Windows, the file may be open for the
 * other's append at that moment; either only skips that move.
 */
function rotate(base: string): void {
  const step = (move: () => void): void => { try { move(); } catch { /* already moved by the other writer, or busy */ } };
  const oldest = rotated(base, fileCount - 1);
  if (existsSync(oldest)) step(() => unlinkSync(oldest));
  for (let index = fileCount - 2; index >= 1; index--)
    if (existsSync(rotated(base, index))) step(() => moveAside(rotated(base, index), rotated(base, index + 1)));
  step(() => moveAside(base, rotated(base, 1)));
}
/**
 * Moves a file to a name nothing has yet. A plain rename replaces what is there, and with two writers rotating at once
 * that was a copy the other had just moved aside, full of lines, lost (the engine lost two lines in three on Linux).
 * A hard link is never made over another file, so a move the other writer already made is skipped instead. A drive
 * without hard links falls back to the plain move, only when nothing is at the new name.
 */
function moveAside(from: string, to: string): void {
  try { linkSync(from, to); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST" || code === "ENOENT" || existsSync(to)) throw error;
    renameSync(from, to);
    return;
  }
  // Both names hold the same lines until the old one goes; if it cannot go, the new one is taken back, never both kept.
  try { unlinkSync(from); } catch (error) { try { unlinkSync(to); } catch { /* left as it is */ } throw error; }
}
function readLines(file: string): LogLine[] {
  try {
    return readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap((text) => {
      try { return [JSON.parse(text) as LogLine]; } catch { return []; }
    });
  } catch { return []; }
}
function matches(line: LogLine, filter: LogFilter): boolean {
  if (filter.component && line.component !== filter.component) return false;
  if (filter.level && rank[line.level] < rank[filter.level]) return false;
  if (filter.task && line.taskId !== filter.task) return false;
  return true;
}

/** The files that exist in a log folder, for the report's list (names only). */
export function logFolderListing(dir: string): string[] {
  try { return readdirSync(dir).filter((name) => name.endsWith(".jsonl")); } catch { return []; }
}

// ---- one log for the whole process ----

let current: DiagnosticLog | null = null;
export function setDiagnosticLog(log: DiagnosticLog | null): void { current = log; }
export function activeDiagnosticLog(): DiagnosticLog | null { return current; }
/** What any part of Branch calls to write a line. Does nothing before the log is set up. */
export function diagnose(component: string, level: Level, message: string, extra: Omit<LogWrite, "component" | "level" | "message"> = {}): void {
  current?.write({ component, level, message, ...extra });
}

/**
 * Crashes in this process: `uncaughtExceptionMonitor` watches without taking the failure over, so
 * Node still ends exactly as it would have. (A promise nobody caught reaches it too, because
 * src/tracing.ts hands those on as uncaught failures.)
 */
export function watchProcessCrashes(log: DiagnosticLog, component = "engine"): () => void {
  const listener = (error: Error, origin: string) => log.crash(component, error, origin);
  process.on("uncaughtExceptionMonitor", listener);
  return () => { process.off("uncaughtExceptionMonitor", listener); };
}

/** Which part of Branch a stored event belongs to, from its kind ("channel.message" → "channels"). */
export function componentOf(kind: string): string {
  const head = kind.split(".")[0] ?? "engine";
  const names: Record<string, string> = {
    run: "tasks", tool: "tools", model: "models", channel: "channels", mcp: "mcp", schedule: "schedules",
    approval: "approvals", update: "updater", gateway: "gateway", local: "local-models", browser: "browser",
  };
  return names[head] ?? head;
}

/**
 * mac7/coding-next: the crash-capture switch, copied to a small file beside the log so the desktop
 * app can read it before the engine (and its database) has started. The engine writes it whenever
 * the setting is saved and once at start, so the file follows the saved setting.
 */
export const crashCaptureMarkFile = "crash-capture.json";
const markPath = (dataDir: string): string => join(dataDir, "logs", crashCaptureMarkFile);
/** The same switch, read from the log folder itself (`<data folder>/logs`). */
function crashCaptureMarkedIn(logDir: string): boolean {
  try {
    const saved = JSON.parse(readFileSync(join(logDir, crashCaptureMarkFile), "utf8")) as { crashCapture?: unknown };
    return saved.crashCapture === "on";
    // No file yet (a fresh install whose engine has not started once) means the shipped setting, on.
  } catch (error) { return (error as NodeJS.ErrnoException)?.code === "ENOENT" && DiagnosticLogSettingsSchema.parse({}).crashCapture === "on"; }
}
/**
 * The owner's whole log settings go in the same file, so the desktop app's main process, which has no database,
 * writes its lines under the owner's switch and the same size cap as the engine (src/desktop/main-log.ts).
 */
export function writeLogSettingsMark(dataDir: string, settings: DiagnosticLogSettings): void {
  try {
    // Nothing to say while everything is as shipped and never was otherwise: the folder is not made for nothing.
    const shipped = JSON.stringify(DiagnosticLogSettingsSchema.parse({}));
    if (JSON.stringify(settings) === shipped && !existsSync(markPath(dataDir))) return;
    mkdirSync(join(dataDir, "logs"), { recursive: true, mode: 0o700 });
    const { crashCapture, mode, keepDays, maxMegabytes } = settings;
    writeFileSync(markPath(dataDir), JSON.stringify({ crashCapture, mode, keepDays, maxMegabytes }), { mode: 0o600 });
  } catch { /* the switch file must never stop a setting being saved */ }
}
/**
 * The owner's log settings as last written beside the log: the shipped ones before the file was ever written, and
 * when it cannot be read (then crash capture is off, as `crashCaptureMarked` says). A file from before it carried the
 * mode holds only the crash switch; the rest are the shipped settings.
 */
export function markedLogSettings(dataDir: string): DiagnosticLogSettings {
  const shipped = DiagnosticLogSettingsSchema.parse({});
  try {
    const saved = DiagnosticLogSettingsSchema.safeParse(JSON.parse(readFileSync(markPath(dataDir), "utf8")));
    return saved.success ? saved.data : { ...shipped, crashCapture: "off" };
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "ENOENT" ? shipped : { ...shipped, crashCapture: "off" };
  }
}
/** Whether the owner had crash capture on when the file was last written; the shipped setting before it was ever written, off when it cannot be read. */
export function crashCaptureMarked(dataDir: string): boolean {
  return crashCaptureMarkedIn(join(dataDir, "logs"));
}
/** What the desktop app starts Electron's crash reporter with at start, or null to leave it off. */
export function crashReporterPlan(dataDir: string): ReturnType<typeof crashReporterOptions> | null {
  return crashCaptureMarked(dataDir) ? crashReporterOptions() : null;
}

/**
 * How the desktop app starts Electron's crash reporter: minidumps are written to this computer's
 * crash folder and never uploaded. Kept here, outside Electron, so a test can hold it to that.
 */
export function crashReporterOptions(): { uploadToServer: false; submitURL: string; compress: boolean; productName: string } {
  return { uploadToServer: false, submitURL: "", compress: true, productName: "Branch Agent" };
}
