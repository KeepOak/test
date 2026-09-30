import type { Asks } from "../asks/index.js";
import type { Flows } from "../flows.js";
import type { Knowledge } from "../knowledge.js";
import type { ToolRegistry } from "../registry.js";
import type { RunQueue } from "../run-queue.js";
import type { Runtime } from "../runtime.js";
import { InstallRequests } from "./install-requests.js";
import { Orchard, type OrchardTrunk } from "../orchard/index.js";
import { lockdownActive } from "../lockdown.js";
import { RecipeChecker } from "./recipe-checks.js";
import { boardMode, boardParts, boardTools, followBoardSwitches, saveBoardMode, type BoardMode, type BoardPart } from "./settings.js";
import { FlowTimeTravel } from "./time-travel.js";
import { registrars } from "./tools.js";
import { WaitingLine } from "./waiting-line.js";
import { Widgets } from "./widgets.js";

/**
 * Bucket R17-H: flows and boards — going back in a flow, checked procedures, the shared board, live
 * widgets the assistant builds, the waiting line you can change, focus view, and requests for new
 * packages and tool servers. `createBranch` makes one of these and the server hands it
 * /api/flows-boards/ (Orchard's routes are /api/orchard/, src/orchard/api.ts). What each part ships as is in
 * src/flows-boards/settings.ts. See docs/configuration.md, "Flows and boards".
 */
export interface FlowsBoardsDeps {
  runtime: Runtime; registry: ToolRegistry; flows: Flows; knowledge: Knowledge; queue: RunQueue; asks: Asks;
  /** A fetch that follows the owner's network rules, for the list of harmful packages. */
  fetch: () => typeof fetch;
  /** The address of that list; only a test changes it. */
  osvEndpoint?: string;
  /** The owner's Trunks now, for Orchard (src/trunks). */
  trunks: () => OrchardTrunk[];
  requireInstallOwner?: () => void;
}

const byRuntime = new WeakMap<object, FlowsBoards>();
/** The part of Branch the typed commands reach, for this runtime (src/flows-boards/commands.ts). */
export const flowsBoardsFor = (runtime: object): FlowsBoards | undefined => byRuntime.get(runtime);

export class FlowsBoards {
  readonly timeTravel: FlowTimeTravel;
  readonly recipes: RecipeChecker;
  /** Orchard, under the switch the shared board had (src/orchard). */
  readonly orchard: Orchard;
  readonly widgets: Widgets;
  readonly waiting: WaitingLine;
  readonly installs: InstallRequests;

  constructor(private readonly deps: FlowsBoardsDeps) {
    const { runtime, flows } = deps, store = runtime.store, owner = runtime.owner;
    this.timeTravel = new FlowTimeTravel({ store, owner, graphs: flows.graphs,
      definition: (flowId) => {
        const record = store.get("flow_graphs", owner, flowId);
        if (!record) throw new Error("That flow is no longer saved, so a copy of its run cannot be made.");
        return record.data;
      } });
    this.recipes = new RecipeChecker({ runtime, knowledge: deps.knowledge });
    this.orchard = new Orchard({ store, owner, runtime, trunks: deps.trunks, on: () => this.mode("kanban") !== "off",
      lockdown: () => lockdownActive(store, owner) });
    this.widgets = new Widgets(store, owner, deps.registry, deps.asks.surfaces);
    this.waiting = new WaitingLine(runtime, deps.queue);
    this.installs = new InstallRequests({ store, owner, fetch: deps.fetch, ...(deps.osvEndpoint ? { endpoint: deps.osvEndpoint } : {}),
      ...(deps.requireInstallOwner ? { requireOwner: deps.requireInstallOwner } : {}) });
    for (const part of boardParts) this.sync(part);
    byRuntime.set(runtime, this);
    followBoardSwitches(store, (part, input) => this.setMode(part, input));
  }

  get store() { return this.deps.runtime.store; }
  get owner() { return this.deps.runtime.owner; }
  mode(part: BoardPart): BoardMode { return boardMode(this.store, this.owner, part); }
  modes(): Record<BoardPart, BoardMode> {
    return Object.fromEntries(boardParts.map((part) => [part, this.mode(part)])) as Record<BoardPart, BoardMode>;
  }

  /** A part's tools are in the catalog exactly while its switch is not off. */
  private sync(part: BoardPart): void {
    for (const name of boardTools[part]) this.deps.registry.unregister(name);
    if (this.mode(part) !== "off") registrars[part]?.(this.deps.registry, this);
  }

  setMode(part: BoardPart, input: unknown): BoardMode {
    const mode = saveBoardMode(this.store, this.owner, part, input);
    this.sync(part);
    if (part === "kanban") this.orchard.grow();
    return mode;
  }

  /** Everything waiting for the owner's answer, for Inbox › Needs you. */
  waitingForOwner(): { widgets: number; installs: number } {
    return {
      widgets: this.mode("widgets") === "off" ? 0 : this.widgets.waiting().length,
      installs: this.mode("install-requests") === "off" ? 0 : this.installs.waiting().length,
    };
  }

  /** The owner pressed Run on a checked procedure: it is recorded as a task of its own. */
  async runChecked(procedureId: string, inputs: Record<string, string | number | boolean>) {
    const run = this.store.createRun(this.owner, `Procedure with checks: ${procedureId}`, undefined, false, "owner");
    try {
      const outcome = await this.recipes.run(procedureId, inputs, { mode: "owner", source: "owner", runId: run.id });
      this.store.finish(run.id, outcome.status === "passed" ? "completed" : "failed",
        outcome.status === "passed" ? `Passed after ${outcome.attempts} try(s).` : outcome.reasons.join(" "));
      return { runId: run.id, ...outcome };
    } catch (error) {
      this.store.finish(run.id, "failed", error instanceof Error ? error.message : String(error));
      throw error;
    }
  }
}
