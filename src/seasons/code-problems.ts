import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { SourceChangeRequest } from "../self-development-requests.js";
import type { Store } from "../store.js";
import { typedBy } from "./evidence.js";

/**
 * Code-level problems. A tool that keeps failing with an error only a bug in Branch itself makes (a TypeError, a
 * value read from nothing) across several of the owner's tasks is not something a skill can fix, so Rings files it
 * as a request to change Branch itself (#456/#557). Filing starts nothing: the owner answers it in the app, and only
 * a yes there prepares a change, which the owner reviews as a pull request. Each problem is filed once.
 */
export const programErrors = /\b(TypeError|ReferenceError|RangeError|is not a function|is not defined|Cannot read propert(y|ies) of (undefined|null)|Maximum call stack)\b/;
/** The same error in at least this many tasks, in at least two conversations, before it is filed. */
export const problemAtLeast = 3;
export interface Filer { file(input: { text: string; from: { channel: string; chatId: string; senderId: string; senderName: string; messageId: string } }): SourceChangeRequest }
interface Problem { fingerprint: string; tool: string; error: string; runs: Set<string>; sessions: Set<string> }

const normalise = (error: string): string => error.replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, "<id>").replace(/\d+/g, "<n>").replace(/\s+/g, " ").trim().slice(0, 300);

/** The recurring program errors in the owner's own recent tasks. */
export function recurringProblems(store: Store, owner: string): Problem[] {
  const found = new Map<string, Problem>();
  for (const run of store.runs(owner).filter((entry) => typedBy(store, entry, null))) {
    for (const event of store.events(run.id).filter((entry) => entry.kind === "tool.failed")) {
      const tool = String(event.data.name ?? ""), error = String(event.data.error ?? "");
      if (!programErrors.test(error)) continue;
      const fingerprint = createHash("sha256").update(`${tool}\n${normalise(error)}`).digest("hex").slice(0, 32);
      const problem = found.get(fingerprint) ?? { fingerprint, tool, error: normalise(error), runs: new Set<string>(), sessions: new Set<string>() };
      problem.runs.add(run.id); problem.sessions.add(run.sessionId);
      found.set(fingerprint, problem);
    }
  }
  return [...found.values()].filter((problem) => problem.runs.size >= problemAtLeast && problem.sessions.size >= 2);
}

/** Files each new recurring problem once. Returns how many were filed. */
export function fileProblems(store: Store, owner: string, filer: Filer | undefined): number {
  if (!filer) return 0;
  const db: DatabaseSync = store.sqlite;
  db.exec("CREATE TABLE IF NOT EXISTS seasons_problems(owner TEXT NOT NULL, fingerprint TEXT NOT NULL, request_id TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY(owner, fingerprint))");
  let filed = 0;
  for (const problem of recurringProblems(store, owner)) {
    if (db.prepare("SELECT 1 AS here FROM seasons_problems WHERE owner=? AND fingerprint=?").get(owner, problem.fingerprint)) continue;
    const text = `Rings found a recurring problem in Branch itself. The tool ${problem.tool} failed in ${problem.runs.size} tasks, `
      + `in ${problem.sessions.size} conversations, with: ${problem.error}`;
    try {
      const request = filer.file({ text, from: { channel: "seasons", chatId: "rings", senderId: "branch", senderName: "Rings", messageId: problem.fingerprint } });
      db.prepare("INSERT INTO seasons_problems VALUES(?,?,?,?)").run(owner, problem.fingerprint, request.id, new Date().toISOString());
      filed++;
    } catch { break; /* the owner already has as many requests waiting as are allowed: the rest wait for a later night */ }
  }
  return filed;
}
