import { ChatGPTAuth, type ChatGPTTokens, type TokenVault } from "../chatgpt-auth.js";
import type { Locker } from "../locker.js";
import { tokenProject } from "./settings.js";

/**
 * Each extra ChatGPT account keeps its tokens in a locker project of its own (encrypted at rest,
 * never returned by the API, never in a backup). The first account is the sign-in Branch already
 * had, which stays where it always was. The sign-in itself is the same device-code route as
 * `src/chatgpt-auth.ts`, labelled unofficial in the same words.
 */
/** The longest value the locker keeps (src/locker.ts). */
export const lockerValueLimit = 8192;
const parts = { accessToken: "ACCESS_TOKEN", refreshToken: "REFRESH_TOKEN", idToken: "ID_TOKEN", expiresAt: "EXPIRES_AT" } as const;

export class LockerTokenVault implements TokenVault {
  constructor(private readonly locker: Locker, private readonly owner: string, private readonly account: string) {}
  private get project(): string { return tokenProject(this.account); }
  async read(): Promise<ChatGPTTokens | null> {
    const names = this.locker.names(this.owner, this.project).map((row) => row.name);
    if (!names.includes(parts.accessToken) || !names.includes(parts.refreshToken)) return null;
    const wanted = Object.values(parts).filter((name) => names.includes(name));
    const values = await this.locker.resolve(this.owner, this.project, wanted);
    return {
      accessToken: values[parts.accessToken]!, refreshToken: values[parts.refreshToken]!,
      ...(values[parts.idToken] ? { idToken: values[parts.idToken] } : {}),
      expiresAt: values[parts.expiresAt] ?? new Date(0).toISOString(),
    };
  }
  async write(tokens: ChatGPTTokens): Promise<void> {
    // All or nothing: a part the locker cannot hold is refused before anything is written, never cut short.
    const values = [tokens.accessToken, tokens.refreshToken, tokens.expiresAt, tokens.idToken ?? ""];
    if (values.some((value) => value.length > lockerValueLimit))
      throw new Error(`This ChatGPT sign-in is longer than the locker can hold (${lockerValueLimit} characters per part), so it was not kept. The first ChatGPT account can still sign in.`);
    // provider-audit: one transaction, so a failure part way never pairs a new access token with an old refresh token.
    await this.locker.setAll(this.owner, this.project, {
      [parts.accessToken]: tokens.accessToken, [parts.refreshToken]: tokens.refreshToken, [parts.expiresAt]: tokens.expiresAt,
      ...(tokens.idToken ? { [parts.idToken]: tokens.idToken } : {}),
    }, tokens.idToken ? [] : [parts.idToken]);
  }
  async clear(): Promise<void> {
    this.locker.removeProject(this.owner, this.project);
  }
}

export interface ChatGPTAccountDeps {
  locker: Locker;
  owner: string;
  userAgent: string;
  fetch?: typeof fetch | undefined;
}

/** One sign-in per account, made once and kept for the life of the program. */
export class ChatGPTAccounts {
  private readonly auths = new Map<string, ChatGPTAuth>();
  constructor(private readonly deps: ChatGPTAccountDeps) {}
  auth(account: string): ChatGPTAuth {
    let found = this.auths.get(account);
    if (!found) {
      found = new ChatGPTAuth(new LockerTokenVault(this.deps.locker, this.deps.owner, account), {
        userAgent: this.deps.userAgent, ...(this.deps.fetch ? { fetch: this.deps.fetch } : {}),
      });
      this.auths.set(account, found);
    }
    return found;
  }
  /** Signs the account out and takes its tokens out of the locker. */
  async forget(account: string): Promise<void> {
    await this.auth(account).signOut();
    this.auths.delete(account);
  }
}

/**
 * The plan window the ChatGPT service reports on each answer, as a share left (0 to 100), or null.
 * Codex reads the same headers (`x-codex-primary-used-percent`).
 */
export function remainingFrom(headers: Headers): number | null {
  const used = Number(headers.get("x-codex-primary-used-percent"));
  if (!headers.has("x-codex-primary-used-percent") || !Number.isFinite(used)) return null;
  return Math.max(0, Math.min(100, 100 - used));
}
/** When that plan window refills (`x-codex-primary-reset-at`, Unix seconds), as an ISO instant, or null. */
export function resetFrom(headers: Headers): string | null {
  const seconds = Number(headers.get("x-codex-primary-reset-at"));
  if (!headers.has("x-codex-primary-reset-at") || !Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date(seconds * 1000).toISOString();
}
