import { join } from "node:path";
import type { NetworkPolicy } from "../network-policy.js";
import type { Plugins } from "../plugins.js";
import type { ToolRegistry } from "../registry.js";
import type { Runtime } from "../runtime.js";
import { wallSettings } from "../sandbox.js";
import type { Store } from "../store.js";
import { AddOnDrafts, registerDraftTool, draftToolName } from "./drafts.js";
import { PluginExports, stdioLaunch } from "./export.js";
import { FilterBook } from "./filters.js";
import { AddOnLists } from "./lists.js";
import { AddOnShelf } from "./package-shelf.js";
import { PipelinesReader } from "./pipelines.js";
import { registerSearchTool, searchToolName } from "./search.js";
import { addOnLooser, addOnMode, addOnSettings, addOnTools, saveAddOnSettings, type AddOnPart, type AddOnSettings } from "./settings.js";
import { AddOnsApiError } from "./api.js";
import { lockdownActive } from "../lockdown.js";
import { looseningRefusal, withoutConfirm } from "../policy-change-guard.js";
import { WalledPlugins, type WalledPolicy } from "./walled-plugin.js";

/**
 * Bucket 15: add-ons other people wrote, in one place. See docs/configuration.md, "Add-ons other
 * people wrote". Every part ships off; the only thing this does on a fresh install is make sure a
 * plugin installed from a package would run walled, and that the owner's filters (none yet) are
 * asked about each message.
 */
export interface AddOnDeps {
  store: Store;
  runtime: Runtime;
  registry: ToolRegistry;
  plugins: Plugins;
  dataDir: string;
  policy: NetworkPolicy;
  /**
   * The malware check (src/security-audit/malware-check.ts), asked lazily: the security service is
   * made later in createBranch, so this must never be called while add-ons are being set up.
   */
  vet: (command: string, args: readonly string[]) => Promise<void>;
  secret: (name: string) => Promise<string | null>;
  fetchImpl?: typeof fetch;
  bundledDir?: string;
}

export class AddOns {
  readonly filters: FilterBook;
  readonly shelf: AddOnShelf;
  readonly lists: AddOnLists;
  readonly pipelines: PipelinesReader;
  readonly exports: PluginExports;
  readonly drafts: AddOnDrafts;
  readonly walled: WalledPlugins;

  constructor(private readonly deps: AddOnDeps) {
    const { store, runtime, plugins, dataDir } = deps;
    const owner = runtime.owner;
    this.filters = new FilterBook(store, owner);
    this.shelf = new AddOnShelf({ store, owner, dataDir, plugins, filters: this.filters, vet: deps.vet,
      ...(deps.bundledDir ? { bundledDir: deps.bundledDir } : {}) });
    this.lists = new AddOnLists(store, owner, this.shelf, deps.policy, deps.fetchImpl);
    this.pipelines = new PipelinesReader({ store, owner, policy: deps.policy, secret: deps.secret, ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) });
    this.exports = new PluginExports(store, owner, () => stdioLaunch(dataDir, runtime.workspace));
    this.drafts = new AddOnDrafts(join(dataDir, "add-on-drafts"));
    this.walled = new WalledPlugins({
      policy: (id) => this.pluginPolicy(id),
      unreadable: () => [...wallSettings(store, owner).unreadable, dataDir],
      siteCheck: (target) => deps.policy.assertAllowed(target, "a walled plugin"),
      fakeIpProxy: () => deps.policy.settings().fakeIpProxy === true,
      weakWallAllowed: () => addOnSettings(store, owner).windowsWithoutWall,
    });
    plugins.isolation = this.walled;
    runtime.filterText = (stage, text, models) => this.filters.run(stage, text, models);
    runtime.holdsPreview = (models) => this.filters.holdsPreview(models);
    this.sync();
  }

  /** A plugin from a package always runs walled; a hand-placed one only when the owner asked. */
  private pluginPolicy(id: string): WalledPolicy | null {
    const installed = this.shelf.record(id)?.plugin;
    if (installed) return { walled: true, hosts: installed.hosts, sha256: installed.sha256, permissions: installed.permissions };
    if (!addOnSettings(this.deps.store, this.deps.runtime.owner).wallEveryPlugin) return null;
    const catalog = this.deps.store.get("settings", this.deps.runtime.owner, `plugin-catalog:${id}`)?.data as { sha256?: string } | undefined;
    return { walled: true, hosts: [], sha256: catalog?.sha256, handPlaced: true };
  }

  get storeReader(): Pick<Store, "get"> { return this.deps.store; }
  get owner(): string { return this.deps.runtime.owner; }
  settings(): AddOnSettings { return addOnSettings(this.deps.store, this.deps.runtime.owner); }
  save(input: unknown): AddOnSettings {
    // RES-251: running plugins inside Branch, or add-on code on Windows without a wall, is less careful: it needs the
    // owner's yes and is refused under Lockdown (src/policy-change-guard.ts).
    const { confirmLoosening, input: change } = withoutConfirm(input);
    const refusal = looseningRefusal(addOnLooser(this.settings(), change), confirmLoosening, lockdownActive(this.deps.store, this.deps.runtime.owner));
    if (refusal) throw new AddOnsApiError(409, refusal);
    const saved = saveAddOnSettings(this.deps.store, this.deps.runtime.owner, change);
    this.sync();
    return saved;
  }
  mode(part: AddOnPart) { return addOnMode(this.deps.store, this.deps.runtime.owner, part); }

  /** Puts each part's tools in the catalog while it is not off, and takes them out when it is. */
  sync(): void {
    const { registry } = this.deps;
    for (const [part, tools] of Object.entries(addOnTools) as [AddOnPart, readonly string[]][]) {
      const on = this.mode(part) !== "off";
      for (const name of tools) {
        const present = registry.names().includes(name);
        if (!on && present) registry.unregister(name);
        if (on && !present) this.register(name);
      }
    }
  }
  private register(name: string): void {
    if (name === draftToolName) registerDraftTool(this.deps.registry, this.drafts);
    if (name === searchToolName)
      registerSearchTool(this.deps.registry, this.deps.plugins, (tool, args, options) => this.deps.runtime.executeTool(tool, args, options));
  }
}

export { addOnParts, addOnLabels } from "./settings.js";
export { applyFilters, FilterRuleSchema } from "./filters.js";
export { readOffer, readPackageFolder } from "./formats.js";
export { signListEntry, verifyListEntry } from "./lists.js";
export { branchPluginFiles, stdioLaunch } from "./export.js";
export { addOnApiVersion, definePlugin } from "./sdk.js";
export { pluginWall } from "./walled-plugin.js";
