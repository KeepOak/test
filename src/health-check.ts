import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Store } from "./store.js";
import type { SessionLock } from "./session-lock.js";
import { startedWithShortLivedKey } from "./key-context.js";
import { lockdownActive } from "./lockdown.js";
import { watchHealthChanges } from "./health-changes.js";

export class HealthAuthorityError extends Error { readonly status = 403; }
const contexts = new AsyncLocalStorage<HealthCheck>();
const relevantSetting = (id: string) => /^(?:personal-|lockdown$|network|integration|projects$|project:)/.test(id)
  && !id.startsWith("personal-connection-health:");
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Bound once before the body. Only explicit health routes enter this context. */
export class HealthCheck {
  readonly controller = new AbortController();
  get signal(): AbortSignal { return this.controller.signal; }
  private readonly scope: string;
  private readonly project: string;
  private readonly settings: string;
  private credentials: string;
  private readonly release: (() => void)[] = [];
  private ownWrite: { owner: string; project: string; name: string } | null = null;
  private readonly connections: (() => boolean)[] = [];
  constructor(private readonly store: Store, readonly owner: string,
    private readonly lock: Pick<SessionLock, "locked" | "onLocked">, request?: IncomingMessage,
    private readonly refreshCredential?: string) {
    this.scope = store.profiles.scope(); this.project = store.projects.active(owner).id;
    this.settings = this.settingsIdentity(); this.credentials = this.credentialIdentity();
    this.assertCurrent();
    const revoke = () => this.revoke();
    this.release.push(store.profiles.onSwitched(revoke), lock.onLocked(revoke),
      store.projects.onSwitched((changedOwner) => { if (changedOwner === owner) revoke(); }),
      watchHealthChanges(store.sqlite, change => {
        if (change.owner !== owner) return;
        if (change.kind === "setting") { if (relevantSetting(change.id)) revoke(); return; }
        const own = this.ownWrite;
        if (contexts.getStore() === this && own && own.owner === change.owner
          && own.project === change.project && own.name === change.id) {
          // Only this check's authorized refresh may adopt its own atomically written token row.
          this.assertNonCredentialAuthority(); this.credentials = this.credentialIdentity();
        } else revoke();
      }));
    if (request) { request.once("aborted", revoke); this.release.push(() => request.off("aborted", revoke)); if (request.aborted) revoke(); }
  }
  private settingsIdentity(): string {
    return digest(this.store.sqlite.prepare("SELECT id,data FROM settings WHERE owner=? ORDER BY id").all(this.owner)
      .filter(row => relevantSetting(String(row.id))));
  }
  private credentialIdentity(): string {
    // Ciphertext identity detects replacements even within one millisecond; values are never decrypted here.
    return digest(this.store.sqlite.prepare("SELECT project,name,hex(iv) AS iv,hex(tag) AS tag,hex(ciphertext) AS ciphertext FROM locker WHERE owner=? ORDER BY project,name").all(this.owner));
  }
  private revoke(): never | void {
    if (!this.signal.aborted) this.controller.abort(new HealthAuthorityError("The original account check is no longer authorized. Check it again."));
  }
  private assertNonCredentialAuthority(): void {
    this.signal.throwIfAborted();
    if (!this.store.profiles.isOwner() || startedWithShortLivedKey() || this.store.profiles.scope() !== this.scope
      || this.store.projects.active(this.owner).id !== this.project || this.lock.locked()
      || lockdownActive(this.store, this.owner) || this.settingsIdentity() !== this.settings
      || this.connections.some(current => !current())) this.revoke();
    this.signal.throwIfAborted();
  }
  assertCurrent(): void {
    this.assertNonCredentialAuthority();
    if (this.credentialIdentity() !== this.credentials) this.revoke();
    this.signal.throwIfAborted();
  }
  bindConnection(current: () => boolean): void { this.connections.push(current); this.assertCurrent(); }
  async writeOwnCredential<T>(owner: string, project: string, name: string, write: () => Promise<T>): Promise<T> {
    this.assertCurrent();
    if (owner !== this.owner || project !== "default" || name !== this.refreshCredential
      || !/^OAUTH_PERSONAL_(GOOGLE|MICROSOFT|SPOTIFY)$/.test(name))
      throw new HealthAuthorityError("This account check cannot change that credential.");
    this.ownWrite = { owner, project, name };
    try { const result = await write(); this.assertCurrent(); return result; }
    finally { this.ownWrite = null; }
  }
  close(): void { for (const release of this.release.splice(0)) release(); }
}
export function currentHealthCheck(): HealthCheck | undefined { return contexts.getStore(); }
export function assertHealthCurrent(): void { currentHealthCheck()?.assertCurrent(); }
export function healthSignal(signal?: AbortSignal | null): AbortSignal | undefined {
  const check = currentHealthCheck(); check?.assertCurrent();
  return check ? (signal ? AbortSignal.any([signal, check.signal]) : check.signal) : signal ?? undefined;
}
export async function withHealthCheck<T>(check: HealthCheck, work: () => Promise<T>): Promise<T> {
  try { return await contexts.run(check, async () => { check.assertCurrent(); const result = await work(); check.assertCurrent(); return result; }); }
  finally { check.close(); }
}
