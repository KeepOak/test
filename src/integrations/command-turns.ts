import { realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

/**
 * SELF-302: the most host commands the engine runs at once, whatever folders they are in. Each one holds its own memory
 * and processor limits, so the engine as a whole stays bounded. Codex bounds its own the same way
 * (openai/codex, codex-rs/core/src/unified_exec/mod.rs, MAX_UNIFIED_EXEC_PROCESSES = 64, Apache-2.0); Branch's
 * commands are builds and tests, so far fewer.
 */
export const maxParallelCommands = 8;
/** How much longer than the longest one command may run a command waits for its turn before giving up. */
export const queueGraceMs = 10_000;

/**
 * The folder a command takes its turn in: the nearest folder at or above where it runs, within the workspace, that
 * holds a Git repository or worktree (`.git`), else the workspace itself. Two helpers in their own copies of the
 * project run side by side; two commands in one copy take turns.
 */
export async function projectRoot(cwd: string, workspace: string): Promise<string> {
  const top = resolve(workspace);
  let found = top;
  for (let here = resolve(cwd); ; here = dirname(here)) {
    const rest = relative(top, here);
    if (rest.startsWith('..') || isAbsolute(rest)) break;
    if (await stat(resolve(here, '.git')).then(() => true, () => false)) { found = here; break; }
    if (here === top || dirname(here) === here) break;
  }
  // As the folder a command held to one folder is named (its real path), so both take turns in the same place.
  return realpath(found).catch(() => found);
}

interface Waiter { key: string; start: () => void }

/** Whose turn it is: one command per folder at a time, first come first served, and at most `max` at once overall. */
export class CommandTurns {
  private readonly busy = new Set<string>();
  private readonly waiting: Waiter[] = [];
  constructor(private readonly max: number) {}
  /** Waits for this folder's turn; the answer lets the turn go. Refused once `waitMs` pass, or when `signal` stops it. */
  take(folder: string, signal: AbortSignal, waitMs: number): Promise<() => void> {
    const key = process.platform === 'win32' ? folder.toLowerCase() : folder;
    return new Promise((resolveTurn, reject) => {
      let timer: NodeJS.Timeout | undefined;
      const leave = (error: unknown): void => {
        const at = this.waiting.indexOf(waiter);
        if (at >= 0) this.waiting.splice(at, 1);
        clearTimeout(timer);
        signal.removeEventListener('abort', stopped);
        reject(error);
      };
      const stopped = (): void => leave(signal.reason ?? new Error('The command was stopped while it waited for its turn'));
      const waiter: Waiter = { key, start: () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', stopped);
        this.busy.add(key);
        let released = false;
        resolveTurn(() => { if (released) return; released = true; this.busy.delete(key); this.next(); });
      } };
      if (signal.aborted) { stopped(); return; }
      this.waiting.push(waiter);
      timer = setTimeout(() => leave(new Error(this.busy.has(key)
        ? `Another command was still running in ${folder} after ${Math.round(waitMs / 1000)} seconds, so this one did not start. Run it again once that one has finished.`
        : `${this.max} commands were still running after ${Math.round(waitMs / 1000)} seconds, so this one did not start. Run it again once one has finished.`)), waitMs);
      timer.unref?.();
      signal.addEventListener('abort', stopped, { once: true });
      this.next();
    });
  }
  /** Starts every waiting command whose folder is free, in the order they came, while there is room. */
  private next(): void {
    for (let at = 0; at < this.waiting.length && this.busy.size < this.max;) {
      const waiter = this.waiting[at]!;
      if (this.busy.has(waiter.key)) { at++; continue; }
      this.waiting.splice(at, 1);
      waiter.start();
    }
  }
}
