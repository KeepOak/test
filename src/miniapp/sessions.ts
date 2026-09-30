import { createHash, randomBytes, randomUUID } from "node:crypto";

/**
 * One phone's hold on one task's browser through the Telegram Mini App. A session is made only after Telegram's signed
 * launch data and the App lock PIN were both checked (src/miniapp/api.ts), and it reaches that task's browser and
 * nothing else: it is not a Branch key, and every other route refuses it. It lives in memory only, ends after
 * `idleMs` without use and after `mostMs` whatever happens, and all of them end at once on Lockdown or App lock.
 */
export interface MiniAppSession {
  /** Who holds the browser while this phone has it (browser-control.ts writer id). */
  clientId: string;
  userId: string;
  channel: string;
  runId: string;
  conversation: string;
  opened: number;
  used: number;
}
export const miniAppTiming = { idleMs: 5 * 60_000, mostMs: 30 * 60_000 };

const digest = (token: string): string => createHash("sha256").update(token).digest("hex");

export class MiniAppSessions {
  /** Kept by a digest of the token, so the token itself is never held and a lookup compares no secret. */
  private readonly sessions = new Map<string, MiniAppSession>();
  constructor(private readonly now: () => number = Date.now) {}

  /** A new session for this task; any earlier one for the same task ends, so one phone holds it at a time. */
  open(input: Pick<MiniAppSession, "userId" | "channel" | "runId" | "conversation">): { token: string; session: MiniAppSession } {
    for (const [key, session] of this.sessions) if (session.runId === input.runId) this.sessions.delete(key);
    const token = randomBytes(32).toString("base64url"), at = this.now();
    const session: MiniAppSession = { ...input, clientId: randomUUID(), opened: at, used: at };
    this.sessions.set(digest(token), session);
    return { token, session };
  }
  /** The live session this token opened, marked as used now, or null (unknown, idle too long, or too old). */
  find(token: string): MiniAppSession | null {
    if (!token) return null;
    const key = digest(token), session = this.sessions.get(key), at = this.now();
    if (!session) return null;
    if (at - session.used >= miniAppTiming.idleMs || at - session.opened >= miniAppTiming.mostMs) {
      this.sessions.delete(key);
      return null;
    }
    session.used = at;
    return session;
  }
  end(token: string): MiniAppSession | null {
    const key = digest(token), session = this.sessions.get(key) ?? null;
    this.sessions.delete(key);
    return session;
  }
  endAll(): void { this.sessions.clear(); }
  /** The browser holder id of the phone holding this task's browser, if one does. */
  clientFor(runId: string): string | null {
    for (const session of this.sessions.values()) if (session.runId === runId) return session.clientId;
    return null;
  }
}
