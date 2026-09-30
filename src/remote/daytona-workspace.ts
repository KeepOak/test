import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Store } from "../store.js";
import type { NetworkPolicy } from "../network-policy.js";
import type { ToolRegistry } from "../registry.js";
import { lockdownActive } from "../lockdown.js";

const key = "daytona-workspace";
const Id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,100}$/);
export const DaytonaSettings = z.object({
  secret: z.string().regex(/^[A-Z][A-Z0-9_]{0,79}$/),
  snapshot: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/),
  target: z.enum(["us", "eu"]).default("us"),
  ttlMinutes: z.number().int().min(5).max(60).default(30),
}).strict();
const Saved = z.object({ settings: DaytonaSettings, name: Id, id: Id.optional(),
  expiresAt: z.number(), phase: z.enum(["creating", "bound", "stopping", "deleting", "deleted"]),
}).strict();
const Sandbox = z.object({ id: Id, name: Id, state: z.string().max(80),
  labels: z.record(z.string(), z.string()), public: z.boolean(), networkBlockAll: z.boolean(),
  autoStopInterval: z.number(), autoDeleteInterval: z.number(), autoDestroyAt: z.string(),
}).loose();
export const DaytonaRun = z.object({ workspace: Id, command: z.string().trim().min(1).max(4000),
  timeout: z.number().int().min(1).max(60).default(30),
}).strict();
type Config = z.infer<typeof DaytonaSettings>;
type Binding = z.infer<typeof Saved>;
type Proposal = { token: string; settings: Config; expiresAt: number };

/** Independent implementation of the official control-plane and toolbox OpenAPI contracts.
 * No SDK background sockets, host mounts, environment inheritance, or arbitrary service origins.
 */
export class DaytonaWorkspace {
  private busy = false;
  private proposal: Proposal | null = null;
  constructor(private readonly store: Store, private readonly owner: string, private readonly policy: NetworkPolicy,
    private readonly unlocked: () => boolean) {}
  private guard(): void {
    this.store.profiles.requireOwner("Daytona cloud workspace");
    if (!this.unlocked()) throw new Error("Unlock Branch before using Daytona.");
    if (lockdownActive(this.store, this.owner)) throw new Error("Daytona is unavailable in Lockdown.");
  }
  private saved(): Binding | null {
    const value = Saved.safeParse(this.store.get("settings", this.owner, key)?.data);
    return value.success ? value.data : null;
  }
  state() {
    this.guard();
    const saved = this.saved();
    return { workspace: saved, credentialNames: this.store.secrets.list(this.owner, "default").map((item) => item.name) };
  }
  async check(input: unknown) {
    const settings = DaytonaSettings.parse(input);
    return this.exclusive(async () => {
      await this.request(settings, "https://app.daytona.io/api/api-keys/current", "GET");
      return { checked: true, settings, createsResources: false };
    });
  }
  prepare(input: unknown) {
    this.guard();
    if (this.busy) throw new Error("A Daytona request is still finishing.");
    const saved = this.saved();
    if (saved && saved.phase !== "deleted") throw new Error("Reconcile or delete the previous workspace first.");
    const settings = DaytonaSettings.parse(input);
    this.proposal = { token: randomUUID(), settings, expiresAt: Date.now() + 120_000 };
    return { token: this.proposal.token, settings,
      question: `Create a paid private Daytona sandbox from ${settings.snapshot} in ${settings.target}? It has no host files or credentials, blocks outbound network, stops after 5 idle minutes, and is destroyed within ${settings.ttlMinutes} minutes. All work there is disposable. Provider billing applies; Branch cannot guarantee a dollar ceiling.` };
  }
  async create(token: string) {
    return this.exclusive(async () => {
      const proposal = this.proposal; this.proposal = null;
      if (!proposal || proposal.token !== token || proposal.expiresAt < Date.now()) throw new Error("Creation approval expired. Review again.");
      if (this.saved()?.phase !== "deleted" && this.saved()) throw new Error("A previous workspace still needs reconciliation.");
      const binding: Binding = { settings: proposal.settings, name: `branch-${randomUUID()}`,
        expiresAt: Date.now() + proposal.settings.ttlMinutes * 60_000, phase: "creating" };
      // Persist BEFORE POST: an ambiguous timeout must be looked up by this name, never recreated.
      this.store.save("settings", this.owner, key, binding);
      const raw = await this.request(binding.settings, "https://app.daytona.io/api/sandbox", "POST", {
        name: binding.name, snapshot: binding.settings.snapshot, target: binding.settings.target,
        labels: { "branch.workspace": binding.name }, public: false, networkBlockAll: true,
        autoStopInterval: 5, autoPauseInterval: 0, autoDeleteInterval: 0, ttlMinutes: binding.settings.ttlMinutes,
      });
      return this.bind(binding, raw);
    });
  }
  async inspect() {
    return this.exclusive(async () => {
      const saved = this.required();
      const raw = await this.request(saved.settings, this.address(saved), "GET");
      if (raw === null) {
        if (!["stopping", "deleting"].includes(saved.phase)) throw new Error("Creation remains uncertain. Inspect the saved name in Daytona; Branch will not create another.");
        const deleted: Binding = { ...saved, phase: "deleted" };
        this.store.save("settings", this.owner, key, deleted);
        return { ...deleted, state: "deleted" };
      }
      if (saved.phase === "deleting") return { ...saved, state: "deletion-pending" };
      return this.bind(saved, raw);
    });
  }
  private address(saved: Binding): string { return `https://app.daytona.io/api/sandbox/${encodeURIComponent(saved.id ?? saved.name)}`; }
  private required(): Binding {
    this.guard();
    const saved = this.saved();
    if (!saved || saved.phase === "deleted") throw new Error("Create a Daytona workspace first.");
    return saved;
  }
  private bind(saved: Binding, raw: unknown) {
    this.guard();
    const data = Sandbox.parse(raw);
    if (data.name !== saved.name || data.labels["branch.workspace"] !== saved.name || (saved.id && saved.id !== data.id))
      throw new Error("Daytona workspace identity does not match the creation record.");
    if (data.public || !data.networkBlockAll || data.autoStopInterval !== 5 || data.autoDeleteInterval !== 0)
      throw new Error("Daytona isolation settings changed. Commands are refused; stop or delete it.");
    const destroyAt = Date.parse(data.autoDestroyAt);
    if (!Number.isFinite(destroyAt) || destroyAt > saved.expiresAt + 60_000)
      throw new Error("Daytona did not confirm the bounded destruction deadline. Commands are refused.");
    const binding: Binding = { ...saved, id: data.id, phase: "bound" };
    this.store.save("settings", this.owner, key, binding);
    return { ...binding, state: data.state };
  }
  async run(input: unknown, signal: AbortSignal) {
    const command = DaytonaRun.parse(input);
    return this.exclusive(async () => {
      const saved = this.required();
      if (command.workspace !== saved.name) throw new Error("Workspace changed. Review the exact command again.");
      if (saved.phase !== "bound" || !saved.id || saved.expiresAt <= Date.now()) throw new Error("Reconcile a live workspace before running a command.");
      const view = this.bind(saved, await this.request(saved.settings, this.address(saved), "GET", undefined, signal));
      if (view.state !== "started") throw new Error("The sandbox is not started. It is never automatically restarted or recreated.");
      const raw = await this.request(saved.settings, `https://proxy.app.daytona.io/toolbox/${saved.id}/process/execute`, "POST",
        { command: command.command, timeout: command.timeout, cwd: "/home/daytona" }, signal);
      const result = z.object({ exitCode: z.number().int(), result: z.string().max(131072) }).loose().parse(raw);
      return { workspace: saved.id, ...result, result: this.store.secrets.scrubber.text(result.result) };
    });
  }
  async lifecycle(action: "stop" | "delete", name: string) {
    return this.exclusive(async () => {
      const saved = this.required();
      if (saved.name !== name) throw new Error("Workspace changed. Review its exact name again.");
      // Recovery remains possible when isolation metadata changed or creation lost its reply.
      const raw = await this.request(saved.settings, this.address(saved), "GET");
      const identity = z.object({ id: Id, name: Id, labels: z.record(z.string(), z.string()) }).loose().parse(raw);
      if (identity.name !== name || identity.labels["branch.workspace"] !== name || (saved.id && saved.id !== identity.id))
        throw new Error("Workspace ownership record does not match.");
      this.store.save("settings", this.owner, key, { ...saved, id: identity.id, phase: action === "stop" ? "stopping" : "deleting" });
      await this.request(saved.settings, `https://app.daytona.io/api/sandbox/${identity.id}${action === "stop" ? "/stop" : ""}`,
        action === "stop" ? "POST" : "DELETE");
      return { requested: action, name, note: "Provider accepted the request; refresh to verify completion." };
    });
  }
  private async exclusive<T>(work: () => Promise<T>): Promise<T> {
    this.guard();
    if (this.busy) throw new Error("A Daytona request is still finishing. Do not repeat creation.");
    this.busy = true;
    try { return await work(); } finally { this.busy = false; }
  }
  private async request(settings: Config, address: string, method: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
    this.guard();
    const values = await this.store.secrets.resolve(this.owner, "default", [settings.secret], { purpose: "Daytona cloud workspace" });
    this.guard();
    const token = values[settings.secret];
    if (!token || /[\r\n]/.test(token)) throw new Error("Select a usable Daytona API key in the owner's locker.");
    this.store.secrets.scrubber.remember(settings.secret, token);
    const guarded = this.policy.guard((input, init) => { this.guard(); return fetch(input, init); });
    const response = await guarded(address, { method, redirect: "error", headers: { authorization: `Bearer ${token}`,
      accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.any([AbortSignal.timeout(70_000), ...(signal ? [signal] : [])]) });
    this.guard();
    if (response.status === 404 && method === "GET" && address.startsWith("https://app.daytona.io/api/sandbox/")) {
      await response.body?.cancel(); return null;
    }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Daytona request returned ${response.status}. Do not repeat an uncertain creation; reconcile its saved name.`); }
    if (response.status === 204) { await response.body?.cancel(); return null; }
    return readReply(response, () => this.guard());
  }
}

async function readReply(response: Response, guard: () => void): Promise<unknown> {
  if (!response.body) return null;
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); guard();
      if (done) break;
      size += value.byteLength;
      if (size > 262144) throw new Error("Daytona reply too large; inspect the saved workspace in its dashboard.");
      chunks.push(value);
    }
    const text = Buffer.concat(chunks).toString("utf8");
    return text ? JSON.parse(text) as unknown : null;
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export function registerDaytonaWorkspace(registry: ToolRegistry, workspace: DaytonaWorkspace): void {
  registry.register({ name: "daytona.run", group: "remote", reach: "outbound", permission: "remote.execute",
    description: "Run a command in the owner's explicitly created disposable Daytona workspace. No host files or keys are mounted. No automatic start or paid creation.",
    parameters: DaytonaRun, target: (args) => `${args.workspace}: ${args.command}`,
    execute: (args, context) => {
      if (context.source && context.source !== "owner") throw new Error("Daytona commands require an owner task.");
      return workspace.run(args, context.signal);
    },
  });
}
