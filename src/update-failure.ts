import { mkdir, open, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DiagnosticLog, diagnosticLogSettings, redactForLog } from "./diagnostic-log.js";
import { gatherReport, reportZip, type ReportItem } from "./diagnostic-report.js";
import { reportSources, type DiagnosticContext } from "./diagnostic-api.js";

/**
 * Owner item 19: an update that did not go through says so in one plain sentence, with one file that
 * explains it for the owner to send us themselves (on Discord, say). Nothing here sends anything.
 *
 * The file is Report a problem's own zip (src/diagnostic-report.ts) of the items that explain an
 * update, plus the hand-over's own step-by-step log. Kept apart from the report files until the
 * selectable-item work there lands, when that log becomes one of its items.
 */
export const handlesUpdateFailurePath = (path: string): boolean => path === "/api/updates/failure" || path === "/api/updates/failure-report";

/** Where the hand-over writes each step (src/desktop/updater.ts, src/install/headless-update.ts). Read fresh. */
export const updateScratchDir = (): string => join(tmpdir(), "branch-agent-update");
const updateLogLines = 400;
/** Only the end of the log is read, however long it grew: it is only ever added to. */
const updateLogBytes = 256 * 1024;
const updateLogLineChars = 2000;

/** The last `updateLogBytes` of a file, read without loading the rest. */
export async function tailOf(path: string): Promise<string> {
  const file = await open(path, "r");
  try {
    const { size } = await file.stat();
    const length = Math.min(size, updateLogBytes);
    const buffer = Buffer.alloc(length);
    await file.read(buffer, 0, length, size - length);
    const text = buffer.toString("utf8");
    // A cut through the first line leaves half a line: it is dropped rather than shown.
    return size > length ? text.slice(text.indexOf("\n") + 1) : text;
  } finally { await file.close(); }
}
/** Report a problem's items that explain an update, and nothing else: only these are gathered. */
export const updateItemIds = ["about", "updates", "log", "crashes", "disk"] as const;

/**
 * Takes out the characters a terminal obeys rather than prints, keeping tabs and newlines.
 *
 * The log is written by the hand-over script echoing what the shell and the archive tools said, so a
 * name inside a downloaded archive can put escape sequences into it. This file is then the one thing
 * the owner is asked to open and send on, and everything else on those lines — keys, addresses, their
 * home folder — is already cleaned. Colour codes are the harmless end of that; a sequence that moves
 * the cursor and overwrites what is above it is the other end.
 */
export function withoutControlCharacters(text: string): string {
  const escape = 27, bell = 7, tab = 9, newline = 10, deleteChar = 127, highest = 159;
  let out = "";
  for (let at = 0; at < text.length; at += 1) {
    const code = text.charCodeAt(at);
    if (code === escape) {
      // The whole sequence goes, not only the escape that starts it: leaving `[31m` behind would be safe
      // but would litter the file with the rubbish it was hiding.
      at = endOfEscape(text, at);
      continue;
    }
    // A bare carriage return is not a newline: it moves the cursor back to the start of the line, so
    // whatever follows writes over what was already there. That is a way to hide a line in plain
    // sight, so it goes with the rest. Tabs and newlines stay, because they are what a person reads.
    if (code === tab || code === newline) { out += text[at]; continue; }
    if (code < 32 || (code >= deleteChar && code <= highest)) continue;
    out += text[at];
  }
  return out;

  /** The last position of the escape sequence starting at `at`, or `at` itself when it is a stray escape. */
  function endOfEscape(line: string, at: number): number {
    const next = line[at + 1];
    if (next === "[") {
      // A control sequence: parameters, then any number of spacers, then one letter or symbol ends it.
      let cursor = at + 2;
      while (cursor < line.length && /[0-?]/.test(line[cursor]!)) cursor += 1;
      while (cursor < line.length && /[ -/]/.test(line[cursor]!)) cursor += 1;
      return cursor < line.length ? cursor : line.length;
    }
    if (next === "]") {
      // An operating-system command: runs until a bell or another escape.
      let cursor = at + 2;
      while (cursor < line.length && line.charCodeAt(cursor) !== bell && line.charCodeAt(cursor) !== escape) cursor += 1;
      return cursor < line.length ? cursor : line.length;
    }
    return next === undefined ? at : at + 1;
  }
}

/**
 * The last line of a log that is longer than the room it has, kept from both ends.
 *
 * Its beginning says which step it was — `[step 599] …` — and its end is where the update actually
 * stopped. A log with no newlines in it at all is one enormous last line, so keeping only the beginning
 * would hand back the start of a piece cut out of the middle of a file and call it the ending.
 */
function bothEndsOf(line: string): string {
  const gap = " [...] ";
  const half = Math.floor((updateLogLineChars - gap.length) / 2);
  return `${line.slice(0, half)}${gap}${line.slice(-half)}`;
}

export function readableUpdateLog(log: string): string {
  // Control characters come out FIRST, and the order is the whole point. An escape sequence sitting in the
  // middle of a key breaks the shape the redactor is looking for, so the key goes through untouched — and
  // then taking the escape out afterwards leaves that key in plain sight, in the one file the owner is
  // told to send on. Clean text first, then look for secrets in it.
  const plain = withoutControlCharacters(log);
  // Then each whole line has its secrets taken out, and only after that is anything shortened.
  // The other way round, shortening decides what the redactor is allowed to read: a long line
  // keeps its two ends and drops the middle, so a key whose label sat in that middle arrives with
  // nothing beside it to recognise, and its tail goes into the one file the owner is told to send
  // on. Measured before this changed: 24 characters of a key, in plain sight, at the end of it.
  const lines = plain.split(/\r?\n/).slice(-updateLogLines).map((line) => redactForLog(line));
  const cut = lines.map((line, at) => line.length <= updateLogLineChars ? line
    : at === lines.length - 1 ? bothEndsOf(line) : line.slice(0, updateLogLineChars));
  // And once more over the whole thing, because splitting decides what the redactor may read
  // just as shortening does. A line on its own cannot show a label on one line and its value on
  // the next, which is exactly how an update server's refusal arrives: a pretty-printed 401 with
  // "cookie": above its session value. Cleaning each line stops a cut hiding a label; cleaning
  // the joined result stops a newline hiding one. Both, or one of the two gets through.
  return redactForLog(cut.join("\n"));
}

/**
 * The last update's own steps, the end only, cleaned like every report item.
 *
 * The folder is an argument so a test can drive this without writing into the machine's own temporary
 * folder and putting the owner's real log back afterwards. `createBranch` and the routes call it with
 * no argument and get the real one.
 */
export async function updateLogItem(scratchDir: string = updateScratchDir()): Promise<ReportItem> {
  const text = await tailOf(join(scratchDir, "apply-update.log")).then(
    readableUpdateLog,
    () => "No update has written its steps on this computer since it last started.");
  return { id: "update-log", title: "What the last update did", why: "Each step the update took, in order, up to where it stopped.", text };
}

/** The newest update, when it did not go through (the hand-over put the version before back). */
export function lastUpdateFailure(dataDir: string): { fromVersion: string; toVersion: string; at: string } | null {
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(join(dataDir, "activation.sqlite"), { readOnly: true });
    const row = db.prepare("SELECT from_version AS fromVersion, to_version AS toVersion, state, started_at AS startedAt, finished_at AS finishedAt FROM activations ORDER BY id DESC LIMIT 1").get() as
      { fromVersion: string; toVersion: string; state: string; startedAt: string; finishedAt: string | null } | undefined;
    if (!row || row.state !== "failed") return null;
    return { fromVersion: row.fromVersion, toVersion: row.toVersion, at: row.finishedAt ?? row.startedAt };
  } catch {
    return null; // no journal yet: nothing has been updated here
  } finally { db?.close(); }
}

/** The update's file, saved beside the owner's other reports and handed back for the download. */
async function failureReport(ctx: DiagnosticContext): Promise<{ name: string; path: string; base64: string }> {
  const { app, dataDir } = ctx;
  const scope = app.store.profiles.scope();
  const requireDelivery = (): void => {
    app.store.profiles.requireOwner("An update's problem report");
    if (app.store.profiles.scope() !== scope)
      throw new Error("The profile changed while the update report was being prepared.");
    if (app.sessionLock.locked()) throw new Error("Unlock Branch before downloading an update report.");
  };
  requireDelivery();
  const log = new DiagnosticLog({ dir: join(dataDir, "logs"), settings: () => diagnosticLogSettings(app.store, app.runtime.owner) });
  // Only the items that explain an update are gathered: settings, tasks, services and health are
  // never read, and no name is looked up on the network.
  const items = await gatherReport(reportSources(ctx, log), updateItemIds);
  requireDelivery();
  const updateLog = await updateLogItem();
  requireDelivery();
  const zip = reportZip([...items, updateLog]);
  const folder = join(dataDir, "diagnostics");
  await mkdir(folder, { recursive: true, mode: 0o700 });
  requireDelivery();
  const name = `branch-update-report-${new Date().toISOString().replace(/[:.]/g, "-")}.zip`;
  await writeFile(join(folder, name), zip, { mode: 0o600 });
  requireDelivery();
  return { name, path: redactForLog(join(folder, name)), base64: zip.toString("base64") };
}

export async function updateFailureApi(ctx: DiagnosticContext, method: string, path: string): Promise<unknown> {
  // The owner's alone, checked here so the guard moves with the route.
  ctx.app.store.profiles.requireOwner("An update's problem report");
  if (method === "GET" && path === "/api/updates/failure") return { failure: lastUpdateFailure(ctx.dataDir) };
  if (method === "POST" && path === "/api/updates/failure-report") return failureReport(ctx);
  throw new Error("Use GET for /api/updates/failure and POST for /api/updates/failure-report");
}
