import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { InputValue } from "../recipes.js";
import type { BranchPlugin, PluginIsolation } from "../plugins.js";
import { defaultSandboxSpawn, openWall, type SandboxSpawn, type WallDeps } from "../sandbox-backends.js";
import type { WallContext } from "../sandbox.js";
import { hostSource, resultMarker } from "./walled-host.js";
import { scriptWslStart } from "../safety-extras/script-wsl.js";
import { pluginScratchWall } from "../plugin-scratch-wall.js";

/**
 * Bucket 15: a plugin somebody else wrote runs in its own program, behind the same wall as any
 * program Branch starts (src/sandbox-backends.ts) — never inside Branch.
 *
 * Each question is one short run: "what are you" when the owner looks at it, one run per tool call,
 * and one per event a hook listens for. The plugin's file is copied into a fresh scratch folder
 * (Branch's own data folder is unreadable from behind the wall), a small host program loads it,
 * answers, and the folder is thrown away.
 *
 * Behind the wall the program may read the disk except where keys, passwords and Branch's data
 * live, may write only in its scratch folder, and reaches no network at all — unless its package
 * named web addresses and the owner installed it after reading them; then those addresses and no
 * others. It gets no keys, no environment of Branch's, and a hard limit on time, memory and output.
 * On Windows the wall is Windows' own job object; the program still runs apart from Branch.
 */
export interface WalledPluginOptions {
  /** Evaluation always uses the strong, zero-network wall, including the held WSL runner. */
  evaluation?: boolean;
  /** Whether this plugin must run walled, and what its package was allowed to reach. */
  policy(id: string): WalledPolicy | null;
  /** More places the program may not read (the owner's wall settings, Branch's data folder). */
  unreadable(): readonly string[];
  siteCheck?: (target: URL) => Promise<void>;
  /** The owner's fake-IP proxy setting, read by the door for every site, as for any program behind the wall. */
  fakeIpProxy?: () => boolean;
  spawn?: SandboxSpawn;
  wallDeps?: WallDeps;
  timeoutMs?: number;
  /**
   * Windows has no file and network wall, only a job object. Add-on code is refused there unless
   * the owner chose to run it anyway (bucket-15 integration review).
   */
  weakWallAllowed?: () => boolean;
}

export interface WalledPolicy {
  walled: boolean;
  hosts: readonly string[];
  /** The fingerprint the code had when the owner installed it; other code is refused. */
  sha256?: string | undefined;
  /** What the owner saw the package ask for; a plugin that describes more is cut back to this. */
  permissions?: readonly string[] | undefined;
  /**
   * RES-251: a file the owner placed in the plugins folder themselves. Before, it ran inside Branch; on Windows, where
   * the wall is only a job object, running it as its own program with limits is still far tighter than that, so it is
   * not refused there the way code somebody else wrote is.
   */
  handPlaced?: boolean;
}

/** How large one question to a plugin may be, and how many may run at once. */
export const maxRequestBytes = 1_000_000;
export const maxRunsAtOnce = 4;
export const weakWallRefusal = "On Windows Branch cannot wall add-on code off from your files and the internet, so it was not run. "
  + "Tick \"Run add-on code on Windows without the wall\" in Customize, Plugins, to run it anyway as its own program with limits.";

const ToolShape = z.object({
  name: z.string().max(80), description: z.string().max(2000).default(""), permission: z.string().max(64),
  input: z.record(z.string(), z.unknown()).optional(), search: z.object({ label: z.string().max(60) }).optional(),
}).strip();
const DescribeShape = z.object({
  id: z.string().max(40), name: z.string().max(80), description: z.string().max(500).default(""),
  permissions: z.array(z.string().max(64)).max(20).default([]), apiVersion: z.number().optional(),
  tools: z.array(ToolShape).max(32).default([]), hooks: z.array(z.string().max(64)).max(16).default([]),
  providers: z.boolean().default(false), channels: z.boolean().default(false),
}).strip();
const Answer = z.object({ ok: z.boolean(), error: z.string().max(1000).optional(), result: z.unknown().optional(), plugin: z.unknown().optional() }).strip();

/** What the app knows about the network: the owner's rules and the owner's fake-IP proxy setting. */
export interface PluginWallEdge { siteCheck?: ((target: URL) => Promise<void>) | undefined; fakeIpProxy?: (() => boolean) | undefined }

/** The wall one plugin run goes behind: its scratch folder, and only the addresses it was allowed. */
export function pluginWall(hosts: readonly string[], unreadable: readonly string[], edge: PluginWallEdge = {}): WallContext {
  const { siteCheck, fakeIpProxy } = edge;
  const allowed = new Set(hosts.map((host) => host.toLowerCase()));
  return {
    network: allowed.size ? "per-site" : "none",
    keySites: {},
    unreadable: [...unreadable],
    answer: (kind, target) => (kind === "network.site" && allowed.has(target.toLowerCase()) ? "allow" : "deny"),
    granted: () => [],
    spend: () => undefined,
    ...(siteCheck ? { siteCheck } : {}),
    ...(fakeIpProxy ? { fakeIpProxy } : {}),
  };
}

/** The one line the host prints after everything the plugin itself printed. */
export function readAnswer(stdout: string): z.infer<typeof Answer> {
  const at = stdout.lastIndexOf(resultMarker);
  if (at < 0) throw new Error("The plugin's program stopped without answering.");
  const line = stdout.slice(at + resultMarker.length).split("\n")[0] ?? "";
  return Answer.parse(JSON.parse(line));
}

export class WalledPlugins implements PluginIsolation {
  private hooksRunning = 0;
  private runsGoing = 0;
  /** The fingerprint a plugin had when it was loaded, for one whose install gave none. */
  private readonly pinned = new Map<string, string>();
  constructor(private readonly options: WalledPluginOptions) {}

  holds(id: string): boolean { return this.options.policy(id)?.walled === true; }

  /** The wall a run that may reach these addresses goes behind, with the app's network rules and settings. */
  wallFor(hosts: readonly string[]): WallContext {
    return pluginWall(hosts, this.options.unreadable(), { siteCheck: this.options.siteCheck, fakeIpProxy: this.options.fakeIpProxy });
  }

  /** Asks the program once what it brings, and hands back a plugin whose every part calls it again. */
  async load(id: string, file: string): Promise<BranchPlugin> {
    this.pinned.delete(id);
    const { code, policy } = await this.code(id, file);
    if (!policy.sha256) this.pinned.set(id, fingerprint(code));
    const answer = await this.ask(code, policy.hosts, { kind: "describe" }, policy.handPlaced === true);
    const described = DescribeShape.parse(answer.plugin);
    // A plugin may describe more permissions than its package listed; only the listed ones count.
    const notes: string[] = [];
    if (policy.permissions) {
      const listed = new Set(policy.permissions);
      described.permissions = described.permissions.filter((name) => listed.has(name));
      const beyond = described.tools.filter((tool) => !listed.has(tool.permission));
      if (beyond.length) notes.push(`${beyond.map((tool) => tool.name).join(", ")} ${beyond.length === 1 ? "was" : "were"} left out: ${beyond.length === 1 ? "it needs" : "they need"} a permission the package did not list.`);
      described.tools = described.tools.filter((tool) => listed.has(tool.permission));
    }
    if (described.providers) notes.push("Its model connections were left out: they need Branch's own process, and this plugin runs walled.");
    if (described.channels) notes.push("Its chat services were left out: they need Branch's own process, and this plugin runs walled.");
    if (this.platform() === "win32") notes.push("On Windows it runs as its own program with limits, but without the wall around your files and the internet.");
    else notes.push(policy.hosts.length ? `It runs walled and may reach only ${policy.hosts.join(", ")}.` : "It runs walled, with no internet.");
    return {
      id: described.id, name: described.name, description: described.description, permissions: described.permissions,
      ...(described.apiVersion !== undefined ? { apiVersion: described.apiVersion } : {}), notes,
      tools: described.tools.map((tool) => ({
        name: tool.name, description: tool.description, permission: tool.permission,
        ...(tool.input ? { input: tool.input as never } : {}), ...(tool.search ? { search: tool.search } : {}),
        run: (args: Record<string, InputValue>, context: { runId?: string }) => this.call(id, file, { kind: "call", tool: tool.name, args, runId: context.runId ?? "" }),
      })),
      hooks: described.hooks.map((event) => ({ event, run: (payload: unknown) => this.hook(id, file, event, payload) })),
    };
  }

  /** The plugin's code, read fresh each time and refused when it is not what the owner installed. */
  private async code(id: string, file: string): Promise<{ code: string; policy: WalledPolicy }> {
    const policy = this.options.policy(id);
    if (!policy?.walled) throw new Error(`${id} is no longer set up to run walled.`);
    const code = await readFile(file, "utf8");
    const expected = policy.sha256 ?? this.pinned.get(id);
    if (expected && fingerprint(code) !== expected)
      throw new Error(`The code of ${id} is not what it was when you installed it, so it was not run. Remove it and install it again.`);
    return { code, policy };
  }

  private async call(id: string, file: string, request: Record<string, unknown>): Promise<unknown> {
    const { code, policy } = await this.code(id, file);
    const answer = await this.ask(code, policy.hosts, request, policy.handPlaced === true);
    return answer.result ?? null;
  }

  /** A hook is told about its event; at most two run at once, and one more is simply not sent. */
  private async hook(id: string, file: string, event: string, payload: unknown): Promise<void> {
    if (this.hooksRunning >= 2) return;
    this.hooksRunning += 1;
    try { await this.call(id, file, { kind: "hook", event, payload: JSON.parse(JSON.stringify(payload ?? {})) }); }
    finally { this.hooksRunning -= 1; }
  }

  private platform(): NodeJS.Platform { return this.options.wallDeps?.platform ?? process.platform; }

  /** One run of the plugin's program behind the wall, refused when it is too large, too many, or unwalled. */
  async ask(code: string, hosts: readonly string[], request: Record<string, unknown>, handPlaced = false): Promise<z.infer<typeof Answer>> {
    const body = JSON.stringify(request);
    if (Buffer.byteLength(body) > maxRequestBytes) throw new Error("That is more than Branch hands a plugin in one go, so it was not sent.");
    if (this.options.evaluation && hosts.length) throw new Error("Plugin evaluations cannot use the network.");
    if (this.platform() === "win32" && !this.options.evaluation && !handPlaced && !this.options.weakWallAllowed?.()) throw new Error(weakWallRefusal);
    if (this.runsGoing >= maxRunsAtOnce) throw new Error(`${maxRunsAtOnce} plugin runs are already going. Try again when one has finished.`);
    this.runsGoing += 1;
    try { return await this.run(code, hosts, body); }
    finally { this.runsGoing -= 1; }
  }

  private async run(code: string, hosts: readonly string[], body: string): Promise<z.infer<typeof Answer>> {
    const staging = await mkdtemp(join(tmpdir(), "branch-addon-"));
    try {
      await writeFile(join(staging, "plugin.mjs"), code, { mode: 0o600 });
      await writeFile(join(staging, "host.mjs"), hostSource, { mode: 0o600 });
      await writeFile(join(staging, "request.json"), body, { mode: 0o600 });
      const wall = this.wallFor(hosts);
      const env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin", HOME: staging, TMPDIR: staging, NODE_USE_ENV_PROXY: "1",
        ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}) };
      const host = { executable: process.execPath, args: ["--no-warnings", join(staging, "host.mjs")], cwd: staging, env };
      const timeoutMs = this.options.timeoutMs ?? 30_000;
      const held = this.platform() === "win32" && this.options.evaluation;
      const opened = held ? { start: await scriptWslStart(staging, timeoutMs, this.options.unreadable(), this.options.wallDeps ?? {}, false, true),
        finish: async (_run: unknown) => null, close: async () => undefined }
        : await openWall(wall, host, { workspace: staging }, this.options.wallDeps ?? {});
      try {
        const limits = { timeoutMs, maxMemoryMb: 512, maxCpuSeconds: Math.ceil(timeoutMs / 1000), maxOutputBytes: 1_000_000, network: hosts.length > 0, job: true };
        const start = this.options.evaluation && !held
          ? await pluginScratchWall(opened.start, process.execPath, staging, this.platform()) : opened.start;
        const run = await (this.options.spawn ?? defaultSandboxSpawn())(start, limits, AbortSignal.timeout(timeoutMs + 5000));
        const note = await opened.finish(run);
        if (run.exitCode !== 0 || run.truncated || run.status !== "completed")
          throw new Error(`Plugin execution failed (${run.status}): ${(note ?? run.stderr).slice(-300)}`);
        const answer = readAnswerOr(run.stdout, note ?? run.stderr);
        if (!answer.ok) throw new Error(`The plugin said: ${answer.error ?? "it could not do that"}`);
        return answer;
      } finally { await opened.close(); }
    } finally { await rm(staging, { recursive: true, force: true }).catch(() => undefined); }
  }
}

const fingerprint = (code: string): string => createHash("sha256").update(code, "utf8").digest("hex");

function readAnswerOr(stdout: string, why: string): z.infer<typeof Answer> {
  try { return readAnswer(stdout); }
  catch { throw new Error(`The plugin's program stopped without answering.${why ? ` ${why.trim().slice(-300)}` : ""}`); }
}
