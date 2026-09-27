import { join } from "node:path";
import type { ToolRegistry } from "../registry.js";
import type { Runtime } from "../runtime.js";
import { wallSettings } from "../sandbox.js";
import { wallEdgeFor } from "../sandbox-wall.js";
import { ActivityChain, followActivity } from "./activity-chain.js";
import { registerToolScripts, ToolScripts } from "./tool-scripts.js";
import { registerWasmAddOns, WasmAddOns } from "./wasm-add-ons.js";
import { audit } from "../audit.js";
import { followSafetySwitches, safetyLabels, safetyMode, safetyParts, safetyTools, saveSafetyMode, type SafetyMode, type SafetyPart } from "./settings.js";

/**
 * mac7/r17-g: the safety extras (docs/configuration.md, "Safety extras"). `createBranch` makes one;
 * the server hands it /api/safety-extras/. Each part ships as `safetyShipsOn` says (settings.ts); a part's tools are in the catalog
 * only while its switch is not off.
 */
export interface SafetyExtrasDeps { runtime: Runtime; registry: ToolRegistry; dataDir: string }

export class SafetyExtras {
  readonly chain: ActivityChain;
  readonly scripts: ToolScripts;
  readonly wasm: WasmAddOns;
  private readonly stopFollowing: () => void;
  private readonly stopSwitching: () => void;
  private readonly registrars: Partial<Record<SafetyPart, () => void>>;

  constructor(private readonly deps: SafetyExtrasDeps) {
    const { runtime, registry } = deps;
    const store = runtime.store, owner = runtime.owner;
    this.chain = new ActivityChain(store.sqlite, join(deps.dataDir, "activity-chain.anchor"));
    this.stopFollowing = followActivity(store, owner, this.chain);
    this.scripts = new ToolScripts({ host: runtime, registry,
      unreadable: () => [...new Set([...wallSettings(store, owner).unreadable, wallEdgeFor(store).dataDir ?? deps.dataDir, deps.dataDir])] });
    this.wasm = new WasmAddOns(store, owner, join(deps.dataDir, "wasm-add-ons"));
    this.registrars = {
      "tool-scripts": () => registerToolScripts(registry, this.scripts),
      "wasm-add-ons": () => registerWasmAddOns(registry, this.wasm),
    };
    for (const part of safetyParts) this.sync(part);
    this.stopSwitching = followSafetySwitches(store, (part, mode) => { this.setMode(part, { mode }); });
  }

  close(): void { this.stopFollowing(); this.stopSwitching(); }

  private sync(part: SafetyPart): void {
    for (const name of safetyTools[part]) this.deps.registry.unregister(name);
    if (safetyMode(this.deps.runtime.store, this.deps.runtime.owner, part) !== "off") this.registrars[part]?.();
  }

  modes(): Record<SafetyPart, SafetyMode> {
    return Object.fromEntries(safetyParts.map((part) => [part, safetyMode(this.deps.runtime.store, this.deps.runtime.owner, part)])) as Record<SafetyPart, SafetyMode>;
  }

  /**
   * Saves a switch and puts the part's tools in or takes them out at once. The change is written in
   * the record while the chain can still see it: before a part is switched off, after it is switched on.
   */
  setMode(part: SafetyPart, input: unknown): SafetyMode {
    const { store, owner } = this.deps.runtime;
    const note = (mode: string) => audit(store, owner, { action: "policy.changed", actor: owner,
      subject: `${safetyLabels[part]}: ${mode}`, reason: "A safety extra was switched", outcome: "saved" });
    const asked = (input as { mode?: unknown } | null)?.mode;
    if (asked === "off") note("off");
    const mode = saveSafetyMode(store, owner, part, input);
    if (mode !== "off") note(mode);
    this.sync(part);
    return mode;
  }
}

export { safetyParts, safetyLabels, safetyTools } from "./settings.js";
