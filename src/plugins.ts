import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import type { Store } from "./store.js";
import type { ToolRegistry } from "./registry.js";
import type { ToolContext } from "./contracts.js";
import { schemaFor } from "./skill-http-tools.js";
import { grantAll, narrowedSentence, narrowTools, type ManifestGrant } from "./manifest-permissions.js";
import { ParametersSchema, type InputValue } from "./recipes.js";
import type { BranchPluginProvider } from "./provider-plugins.js";
import type { BranchPluginChannel } from "./channels/connectors.js";
// ── bucket-15: the add-on interface version (src/add-ons/sdk.ts). ──
import { checkApiVersion } from "./add-ons/sdk.js";
import { PluginWindowSchema, type BranchPluginWindow } from "./plugin-window.js";

/**
 * Plugins are single files a developer drops into the `plugins` folder beside the private data.
 * A plugin may add tools, react to events and contribute bounded window data. Nothing a
 * plugin brings is loaded until the owner switches it on, and every tool it adds still needs the
 * permission the plugin declared, checked the same way every built-in tool is checked. That
 * permission check is the only thing keeping a plugin in bounds: a plugin runs as part of the
 * assistant, with the same reach over this computer, so only install files you trust.
 */
export const pluginId = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/);
export const PluginManifestSchema = z.object({
  id: pluginId,
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500).default(""),
  permissions: z.array(z.string().regex(/^[a-z][a-z0-9_.]{0,63}$/)).max(20).default([]),
}).strict();
export interface BranchPluginTool {
  /** Must be plugin.<id>.<name>, so a plugin cannot claim a name that looks built in. */
  name: string;
  description: string;
  /** One of the permissions the plugin declares; the owner's task must hold it for the tool to run. */
  permission: string;
  /** Declared inputs, the same shape a recipe uses: name to { type, required, description }. */
  input?: Record<string, { type: "string" | "number" | "boolean"; required?: boolean; description?: string; default?: InputValue }>;
  run(args: Record<string, InputValue>, context: ToolContext): Promise<unknown>;
  /** bucket-15: this tool is a search source, offered through `addon.search` under this label. */
  search?: { label: string };
}
export interface BranchPluginHook { event: string; run(payload: { event: string; runId: string; data: Record<string, unknown> }): Promise<void> }
export interface BranchPlugin {
  id: string; name: string; description?: string; permissions?: string[];
  /** bucket-15: the add-on interface version this plugin was written for (src/add-ons/sdk.ts). */
  apiVersion?: number;
  /** bucket-15: what the loader left out, in plain words (a walled plugin has no model connections). */
  notes?: string[];
  tools?: BranchPluginTool[]; hooks?: BranchPluginHook[];
  /** Ways of talking to a model this plugin brings; see src/provider-plugins.ts. */
  providers?: BranchPluginProvider[];
  /** Chat services this plugin brings; see src/channels/connectors.ts. */
  channels?: BranchPluginChannel[];
  /** Plain text scoped to an existing owner conversation; requires ui.contribute in its grant. */
  window?: BranchPluginWindow[];
}
/** Where a plugin's model connections go. Kept structural so the loader needs no extra import. */
export interface PluginProviderHost {
  register(pluginId: string, entry: BranchPluginProvider): unknown;
  forget(pluginId: string): unknown;
}
/** Where a plugin's chat services go. Kept structural so the loader needs no extra import. */
export interface PluginChannelHost {
  register(pluginId: string, entry: BranchPluginChannel): unknown;
  forget(pluginId: string): unknown;
}
export interface PluginSummary {
  id: string; name: string; description: string; permissions: string[];
  tools: { name: string; description: string; permission: string; search?: string }[]; hooks: string[];
  /** Batch 26 (wave 8): the tools the owner's grant left out, each with the reason, in plain words. */
  leftOut?: string[];
  /** From inspect: false when the plugin has no manifest to read, so nothing about it is known until it is switched on. */
  manifest?: boolean;
}
/**
 * What a plugin says about itself without running: the plugin catalog's record from when it was installed (a folder
 * or zip with branch-plugin.json, or an add-on), else a `<id>.plugin.json` placed beside a hand-placed file.
 */
const PluginSidecarSchema = z.object({
  id: pluginId,
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500).default(""),
  permissions: z.array(z.string().max(100)).max(20).default([]),
  tools: z.array(z.object({ name: z.string().max(80), description: z.string().max(300).default(""),
    permission: z.string().max(64), search: z.string().max(60).optional() })).max(50).default([]),
  hooks: z.array(z.string().max(64)).max(20).default([]),
  sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
});
interface Declared { summary: PluginSummary; sha256: string | null }
const noManifest = (id: string): string =>
  `${id}.mjs has no manifest (the plugin catalog's record, or ${id}.plugin.json beside it), so what it adds is shown only once you switch it on. Switching it on runs its code.`;
interface Loaded { summary: PluginSummary; toolNames: string[]; stopHooks: (() => void)[]; window: BranchPluginWindow[] }
/**
 * bucket-15: where a plugin that must not run inside Branch is loaded instead — its own walled
 * program (src/add-ons/walled-plugin.ts). `load` hands back a plugin whose tools and hooks call
 * into that program; nothing from the file is imported here.
 */
export interface PluginIsolation {
  holds(id: string): boolean;
  load(id: string, file: string): Promise<BranchPlugin>;
}

export class Plugins {
  private readonly loaded = new Map<string, Loaded>();
  /** Set by the launch when this copy can hold model connections; left unset, plugins bring none. */
  providers?: PluginProviderHost | undefined;
  /** Set by the launch when this copy can host chat services; left unset, plugins bring none. */
  channels?: PluginChannelHost | undefined;
  /** bucket-15: set by the launch; plugins it holds never run inside this process. */
  isolation?: PluginIsolation | undefined;
  constructor(private readonly store: Store, private readonly owner: string, private readonly registry: ToolRegistry, private readonly folder: string) {}
  private key(id: string): string { return `plugin:${id}`; }
  private saved(id: string): { enabled: boolean; summary?: PluginSummary; grant?: ManifestGrant } | undefined {
    return this.store.get("settings", this.owner, this.key(id))?.data as { enabled: boolean; summary?: PluginSummary; grant?: ManifestGrant } | undefined;
  }
  /**
   * What the owner allowed: the permissions they named, or — for a plugin switched on before wave 8
   * and for a plain "switch this on" — everything its own manifest declared. A plugin can never
   * widen this: `allow` is filtered against what the manifest declared, so naming a permission the
   * plugin never asked for grants nothing.
   */
  private grantFor(summary: PluginSummary, allow: readonly string[] | undefined): ManifestGrant {
    const asked = grantAll({ permissions: summary.permissions.map((permission) => ({ permission, why: "" })), hosts: [] });
    if (!allow) return asked;
    return { ...asked, permissions: asked.permissions.filter((permission) => allow.includes(permission)) };
  }
  /** The plugin files present, with what the owner already decided. Listing does not load any file. */
  async list() {
    const names = await readdir(this.folder).catch(() => [] as string[]);
    return names.filter((name) => name.endsWith(".mjs")).map((name) => {
      const id = name.slice(0, -4), saved = this.saved(id);
      return { id, file: name, enabled: saved?.enabled === true, loaded: this.loaded.has(id), summary: saved?.summary ?? null };
    });
  }
  /**
   * What one plugin would add, read from its manifest only. Nothing in the plugin file is imported or run, walled or
   * not: its code runs for the first time when the owner switches it on (`enable`).
   */
  async inspect(id: string): Promise<PluginSummary> {
    await this.file(id);
    const declared = await this.declared(id);
    if (!declared) return { id, name: id, description: "", permissions: [], tools: [], hooks: [], leftOut: [noManifest(id)], manifest: false };
    return { ...declared.summary, manifest: true };
  }
  /** The plugin's manifest, or null when it has none. Reading it never runs the plugin. */
  private async declared(id: string): Promise<Declared | null> {
    const recorded = this.store.get("settings", this.owner, `plugin-catalog:${id}`)?.data;
    const sidecar = recorded ? null : await readFile(join(this.folder, `${id}.plugin.json`), "utf8").catch(() => null);
    if (!recorded && sidecar === null) return null;
    const raw = PluginSidecarSchema.parse(recorded ?? JSON.parse(sidecar!));
    if (raw.id !== id) throw new Error(`The manifest for ${id}.mjs names the plugin "${raw.id}"`);
    const tools = raw.tools.map((tool) => ({ name: tool.name, description: tool.description, permission: tool.permission, ...(tool.search ? { search: tool.search } : {}) }));
    return { summary: { id, name: raw.name, description: raw.description, permissions: raw.permissions, tools, hooks: raw.hooks }, sha256: raw.sha256 ?? null };
  }
  /** What the loaded code itself declares; only ever asked once the owner has switched the plugin on. */
  private summarize(id: string, plugin: BranchPlugin): PluginSummary {
    const manifest = PluginManifestSchema.parse({ id: plugin.id, name: plugin.name, description: plugin.description ?? "", permissions: plugin.permissions ?? [] });
    if (manifest.id !== id) throw new Error(`The plugin file is called ${id}.mjs but declares the id "${manifest.id}"`);
    const tools = (plugin.tools ?? []).map((tool) => this.checkTool(manifest, tool));
    const hooks = (plugin.hooks ?? []).map((hook) => String(hook.event));
    return { ...manifest, tools, hooks, ...(plugin.notes?.length ? { leftOut: plugin.notes.map(String).slice(0, 10) } : {}) };
  }
  private checkTool(manifest: z.infer<typeof PluginManifestSchema>, tool: BranchPluginTool) {
    const shape = new RegExp(`^plugin\\.${manifest.id}\\.[a-z][a-z0-9_]{0,30}$`);
    if (!shape.test(String(tool.name))) throw new Error(`Plugin tools are named plugin.${manifest.id}.<name>; "${tool.name}" is not`);
    if (!manifest.permissions.includes(tool.permission))
      throw new Error(`The tool ${tool.name} asks for the permission "${tool.permission}", which this plugin does not declare`);
    if (typeof tool.run !== "function") throw new Error(`The tool ${tool.name} has no run function`);
    return { name: tool.name, description: String(tool.description ?? "").slice(0, 300), permission: tool.permission,
      ...(tool.search?.label ? { search: String(tool.search.label).slice(0, 60) } : {}) };
  }
  private async file(id: string): Promise<{ file: string; info: { mtimeMs: number } }> {
    pluginId.parse(id);
    const file = join(this.folder, `${id}.mjs`);
    const info = await stat(file).catch(() => null);
    if (!info?.isFile()) throw new Error(`There is no plugin file called ${id}.mjs`);
    return { file, info };
  }
  private async read(id: string): Promise<BranchPlugin> {
    const { file, info } = await this.file(id);
    // bucket-15: a plugin held elsewhere is never imported into this process.
    if (this.isolation?.holds(id)) return this.isolation.load(id, file);
    const module = await import(`${pathToFileURL(file).href}?loaded=${info.mtimeMs}`) as { default?: BranchPlugin };
    if (!module.default || typeof module.default !== "object") throw new Error(`${id}.mjs does not export a plugin as its default export`);
    checkApiVersion(module.default.apiVersion, `The plugin ${id}`); // bucket-15
    return module.default;
  }
  /**
   * Switches a plugin on: its tools join the catalog and its hooks start listening.
   *
   * Batch 26 (wave 8): `allow` is what the owner actually agreed to after reading the plugin's own
   * list of permissions. A tool asking for anything outside it is not registered at all — it never
   * reaches the catalog, so nothing can call it — and the owner is told which ones were left out.
   */
  async enable(id: string, allow?: readonly string[]): Promise<PluginSummary> {
    if (this.loaded.has(id)) return this.loaded.get(id)!.summary;
    // The manifest the owner read binds what runs: code changed since it was installed is not run, and a permission the
    // code asks for that the manifest did not list is never granted (its tools are left out, and said so).
    const declared = await this.declared(id);
    if (declared?.sha256) {
      const code = await readFile(join(this.folder, `${id}.mjs`), "utf8");
      if (createHash("sha256").update(code, "utf8").digest("hex") !== declared.sha256)
        throw new Error(`${id}.mjs is not what it was when it was installed, so it was not switched on. Install it again to use it.`);
    }
    const plugin = await this.read(id), summary = this.summarize(id, plugin);
    const listed = allow ?? this.saved(id)?.grant?.permissions;
    const grant = this.grantFor(summary, declared
      ? (listed ?? declared.summary.permissions).filter((permission) => declared.summary.permissions.includes(permission)) : listed);
    const window = PluginWindowSchema.parse(plugin.window ?? []);
    const windowAllowed = grant.permissions.includes("ui.contribute");
    const { kept, left } = narrowTools(summary.tools, grant);
    const leftOut = [...(summary.leftOut ?? []), ...left.map((tool) => narrowedSentence(tool.name, tool.permission)),
      ...(!windowAllowed && window.length ? ["Window contributions left out: ui.contribute was not granted."] : [])];
    const wanted = new Set(kept.map((tool) => tool.name));
    const toolNames: string[] = [], stopHooks: (() => void)[] = [];
    try {
      for (const tool of (plugin.tools ?? []).filter((tool) => wanted.has(String(tool.name)))) {
        this.registry.register({
          name: tool.name, description: tool.description, permission: tool.permission, external: true, source: `plugin:${id}`,
          parameters: schemaFor(ParametersSchema.parse(tool.input ?? {})),
          execute: async (args, context) => tool.run(args, context),
        });
        toolNames.push(tool.name);
      }
      // A way of talking to a model is only made available to choose; no model is switched over.
      for (const provider of plugin.providers ?? []) this.providers?.register(id, provider);
      // A chat service is only made available to connect; no chat starts answering by itself.
      for (const channel of plugin.channels ?? []) this.channels?.register(id, channel);
    } catch (error) {
      for (const name of toolNames) this.registry.unregister(name);
      this.providers?.forget(id);
      this.channels?.forget(id);
      throw error;
    }
    for (const hook of plugin.hooks ?? [])
      stopHooks.push(this.store.onEvent((runId, kind, data) => { if (kind === hook.event) void hook.run({ event: kind, runId, data }).catch(() => undefined); }));
    const narrowed: PluginSummary = { ...summary, tools: kept, leftOut };
    this.loaded.set(id, { summary: narrowed, toolNames, stopHooks, window: windowAllowed ? window : [] });
    this.store.save("settings", this.owner, this.key(id), { enabled: true, summary: narrowed, grant });
    return narrowed;
  }
  /** Reads only enabled, permission-granted data for this owner's existing conversation. */
  windowContributions(sessionId: string) {
    this.store.profiles.requireOwner("Plugin window contributions");
    if (!this.store.ownsSession(this.owner, sessionId)) throw new Error("Conversation not found");
    return [...this.loaded.entries()].flatMap(([plugin, entry]) => entry.window
      .filter(contribution => contribution.sessionId === sessionId)
      .map(contribution => ({ ...contribution, id: `${plugin}:${contribution.id}`, plugin, pluginName: entry.summary.name }))).slice(0, 100);
  }
  /** Takes a plugin out of this running copy without changing the owner's choice. */
  private unload(id: string): void {
    const entry = this.loaded.get(id);
    for (const name of entry?.toolNames ?? []) this.registry.unregister(name);
    for (const stop of entry?.stopHooks ?? []) stop();
    // Its model connections go with it, along with every preset made from them.
    if (entry) { this.providers?.forget(id); this.channels?.forget(id); }
    this.loaded.delete(id);
  }
  /** Switches a plugin off: its tools leave the catalog, its hooks stop, and it stays off next time. */
  disable(id: string): { id: string; enabled: false } {
    this.unload(id);
    const saved = this.saved(id);
    this.store.save("settings", this.owner, this.key(id), { enabled: false, ...(saved?.summary ? { summary: saved.summary } : {}) });
    return { id, enabled: false };
  }
  /** Loads the plugins the owner switched on before, at start-up. A broken one is reported, not fatal. */
  async restore(): Promise<{ id: string; error: string }[]> {
    const problems: { id: string; error: string }[] = [];
    for (const entry of await this.list())
      if (entry.enabled) await this.enable(entry.id).catch((error: unknown) => problems.push({ id: entry.id, error: error instanceof Error ? error.message : String(error) }));
    return problems;
  }
  /** Shutdown: unload everything without turning the owner's choices off. */
  stop(): void { for (const id of [...this.loaded.keys()]) this.unload(id); }
}
