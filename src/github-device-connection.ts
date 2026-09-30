import { randomUUID } from "node:crypto";
import { z } from "zod";
import { currentCaller } from "./caller.js";
import { startedWithShortLivedKey } from "./key-context.js";
import { currentTaskRun } from "./task-scope.js";
import { lockdownActive } from "./lockdown.js";
import type { NetworkPolicy } from "./network-policy.js";
import type { Store } from "./store.js";
import { GitHubDeviceError, requestGitHubDevice, pollGitHubDevice, githubDeviceIdentity, type DeviceGrant } from "./integrations/github-device-auth.js";

const configKey = "github.device.config", accountKey = "github.device.account";
const ConfigSchema = z.object({ clientId: z.string().trim().max(200).regex(/^[A-Za-z0-9._-]*$/).default("") }).strict();
const AccountSchema = z.object({ clientId: z.string(), secret: z.string(), createdAt: z.string(), scopes: z.string(), who: z.string(), expiresAt: z.number().nullable() }).strict();
const FlowSchema = z.object({ flowId: z.string().uuid() }).strict();
type Account = z.infer<typeof AccountSchema>;
type Pending = { id: string; clientId: string; snapshot: string; controller: AbortController; timer: ReturnType<typeof setTimeout> | null; grant: DeviceGrant | null; nextAt: number; busy: boolean };
type Deps = { store: Store; owner: string; policy: NetworkPolicy; locked: () => boolean; fetchImpl?: typeof fetch };

/** The owner supplies a Branch OAuth app client ID with device flow enabled. Tokens remain in the locker. */
export class GitHubDeviceConnection {
  private pending: Pending | null = null;
  constructor(private readonly deps: Deps) {}

  private config() { return ConfigSchema.parse(this.deps.store.get("settings", this.deps.owner, configKey)?.data ?? {}); }
  private account(): Account | null {
    const value = AccountSchema.safeParse(this.deps.store.get("settings", this.deps.owner, accountKey)?.data);
    return value.success ? value.data : null;
  }
  private stamp(name: string): string | null {
    return this.deps.store.secrets.list(this.deps.owner, "default").find((entry) => entry.name === name)?.createdAt ?? null;
  }
  private snapshot(): string {
    const account = this.account();
    return JSON.stringify([this.config(), account, account ? this.stamp(account.secret) : null]);
  }
  private credentialGuard(): void {
    const { store, owner, locked } = this.deps;
    store.profiles.requireOwner("The GitHub connection");
    if (store.profiles.scope() !== owner || locked() || lockdownActive(store, owner))
      throw new GitHubDeviceError(403, "Use the unlocked owner's profile to connect GitHub.");
  }
  private ownerGuard(): void {
    try {
      this.credentialGuard();
      if (currentCaller().kind !== "owner-here" || startedWithShortLivedKey() || currentTaskRun())
        throw new GitHubDeviceError(403, "Connect GitHub in the owner's app window on this computer.");
    } catch (error) { this.cancel(); throw error; }
  }
  cancel(): void {
    if (this.pending?.timer) clearTimeout(this.pending.timer);
    this.pending?.controller.abort(); this.pending = null;
  }
  private assertFlow(flow: Pending): void {
    this.ownerGuard();
    if (this.pending !== flow || flow.controller.signal.aborted || flow.snapshot !== this.snapshot()
        || (flow.grant && Date.now() >= flow.grant.expiresAt)) {
      if (this.pending === flow) this.cancel();
      throw new GitHubDeviceError(410, "This GitHub sign-in is no longer current. Start again.");
    }
  }
  private request(flow: Pending) {
    return { policy: this.deps.policy, signal: flow.controller.signal, assertCurrent: () => this.assertFlow(flow),
      ...(this.deps.fetchImpl ? { fetchImpl: this.deps.fetchImpl } : {}) };
  }
  view() {
    this.ownerGuard();
    const account = this.account(), config = this.config();
    if (this.pending && (this.pending.snapshot !== this.snapshot() || (this.pending.grant && Date.now() >= this.pending.grant.expiresAt))) this.cancel();
    const flow = this.pending, grant = flow?.grant;
    return { clientId: config.clientId, connected: !!account && account.clientId === config.clientId && this.stamp(account.secret) === account.createdAt
        && (account.expiresAt === null || account.expiresAt > Date.now()),
      who: account?.who ?? "", scopes: account?.scopes ?? "", flow: flow && grant ? { flowId: flow.id, userCode: grant.userCode, verificationUri: grant.verificationUri,
        expiresAt: grant.expiresAt, nextAt: flow.nextAt } : null };
  }
  configure(input: unknown) {
    this.ownerGuard(); const config = ConfigSchema.parse(input);
    this.cancel(); this.removeAccount();
    this.deps.store.save("settings", this.deps.owner, configKey, config);
    return this.view();
  }
  async begin() {
    this.ownerGuard(); const { clientId } = this.config();
    if (!clientId) throw new GitHubDeviceError(400, "Supply your Branch OAuth app client ID first.");
    this.cancel();
    const flow: Pending = { id: randomUUID(), clientId, snapshot: this.snapshot(), controller: new AbortController(), timer: null, grant: null, nextAt: 0, busy: true };
    this.pending = flow;
    try {
      const grant = await requestGitHubDevice(clientId, this.request(flow)); this.assertFlow(flow);
      flow.grant = grant; flow.nextAt = Date.now() + grant.intervalMs; flow.busy = false;
      flow.timer = setTimeout(() => { if (this.pending === flow) this.cancel(); }, Math.max(1, grant.expiresAt - Date.now()));
      flow.timer.unref();
      return this.view();
    } catch (error) { if (this.pending === flow) this.cancel(); throw this.safeError(error); }
  }
  async poll(input: unknown) {
    this.ownerGuard(); const { flowId } = FlowSchema.parse(input), flow = this.pending;
    if (!flow || flow.id !== flowId || !flow.grant) throw new GitHubDeviceError(410, "This GitHub sign-in is no longer current.");
    this.assertFlow(flow);
    if (flow.busy || Date.now() < flow.nextAt) return this.view();
    flow.busy = true;
    try {
      const reply = await pollGitHubDevice(flow.clientId, flow.grant, this.request(flow)); this.assertFlow(flow);
      if ("waitMs" in reply) { flow.grant.intervalMs = reply.waitMs; flow.nextAt = Date.now() + reply.waitMs; return this.view(); }
      this.deps.store.secrets.scrubber.remember("GitHub device token", reply.token);
      const who = await githubDeviceIdentity(reply.token, this.request(flow)); this.assertFlow(flow);
      return await this.keepToken(flow, reply.token, reply.scopes, who, reply.expiresAt);
    } catch (error) { if (this.pending === flow) this.cancel(); throw this.safeError(error); }
    finally { flow.busy = false; }
  }
  private async keepToken(flow: Pending, token: string, scopes: string, who: string, expiresAt: number | null) {
    this.assertFlow(flow);
    const { store, owner } = this.deps, secret = `BRANCH_GITHUB_${flow.id.replaceAll("-", "").toUpperCase()}`;
    store.secrets.scrubber.remember(secret, token);
    const previous = this.account();
    try {
      const saved = await store.secrets.put(owner, "default", secret, token);
      this.assertFlow(flow);
      store.save("settings", owner, accountKey, { clientId: flow.clientId, secret, createdAt: saved.createdAt, scopes, who, expiresAt });
      this.ownerGuard();
    } catch (error) {
      store.secrets.remove(owner, "default", secret);
      if (this.account()?.secret === secret) {
        if (previous) store.save("settings", owner, accountKey, previous); else store.delete("settings", owner, accountKey);
      }
      throw error;
    }
    this.cancel();
    if (previous) store.secrets.remove(owner, "default", previous.secret);
    return this.view();
  }
  private removeAccount(): void {
    const account = this.account(), { store, owner } = this.deps;
    store.delete("settings", owner, accountKey);
    if (account) store.secrets.remove(owner, "default", account.secret);
  }
  disconnect() { this.ownerGuard(); this.cancel(); this.removeAccount(); return this.view(); }
  cancelFlow(input: unknown) {
    this.ownerGuard(); const { flowId } = FlowSchema.parse(input);
    if (this.pending?.id === flowId) this.cancel();
    return this.view();
  }
  /** Only a fallback for public GitHub; an enterprise URL never receives this token. */
  async token(apiBase: string): Promise<string | null> {
    const url = new URL(apiBase);
    if (url.origin !== "https://api.github.com" || url.pathname !== "/" || url.username || url.password || url.search || url.hash) return null;
    this.credentialGuard();
    const account = this.account();
    if (!account || account.clientId !== this.config().clientId || this.stamp(account.secret) !== account.createdAt
        || (account.expiresAt !== null && account.expiresAt <= Date.now())) return null;
    const snapshot = this.snapshot();
    const values = await this.deps.store.secrets.resolve(this.deps.owner, "default", [account.secret], { purpose: "GitHub device connection" });
    this.credentialGuard();
    if (this.snapshot() !== snapshot || (account.expiresAt !== null && account.expiresAt <= Date.now()))
      throw new GitHubDeviceError(403, "The GitHub connection changed or expired during this request.");
    return values[account.secret] ?? null;
  }
  private safeError(error: unknown): GitHubDeviceError {
    return error instanceof GitHubDeviceError ? error : new GitHubDeviceError(502, "GitHub sign-in could not finish. Start again.");
  }
}

export const handlesGitHubDevicePath = (path: string): boolean => /^\/api\/github-device(?:\/(?:begin|poll|cancel|disconnect))?$/.test(path);
export async function githubDeviceApi(connection: GitHubDeviceConnection, method: string, path: string, body: () => Promise<unknown>) {
  if (method === "GET" && path === "/api/github-device") return connection.view();
  if (method !== "POST") throw new GitHubDeviceError(405, "Read the connection with GET or change it with POST.");
  const input = await body();
  if (path === "/api/github-device/poll") return connection.poll(input);
  if (path === "/api/github-device/cancel") return connection.cancelFlow(input);
  if (path === "/api/github-device") return connection.configure(input);
  z.object({}).strict().parse(input);
  if (path === "/api/github-device/begin") return connection.begin();
  return connection.disconnect();
}
