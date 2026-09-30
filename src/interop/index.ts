import type { RemoteAgents } from "../a2a-client.js";
import type { WorkspaceFiles } from "../files.js";
import type { Flows } from "../flows.js";
import type { Knowledge } from "../knowledge.js";
import type { NetworkPolicy } from "../network-policy.js";
import type { ToolRegistry } from "../registry.js";
import type { Runtime } from "../runtime.js";
import type { SessionTokens } from "../session-tokens.js";
import type { Teams } from "../teams.js";
import { AgentMarket, registerMarketTool } from "./agent-market.js";
import { AgentProtocol } from "./agent-protocol.js";
import { ClientToolHub } from "./client-tools.js";
import { registerFleetTools } from "./fleet.js";
import { RedisQueue, registerRedisQueueTools } from "./redis-queue.js";
import { registerFlowSearch } from "./flow-search.js";
import { registerHandoffTool, type HandoffParts } from "./handoff.js";
import { Modes, registerModeTools } from "./modes.js";
import { ProjectRouter, registerProjectRouting } from "./project-routing.js";
import { interopMode, interopParts, interopTools, saveInteropMode, type InteropMode, type InteropPart } from "./settings.js";

/**
 * Bucket 20 (wave mac4): the parts that let Branch be one piece of somebody else's setup, and
 * somebody else's tools be a piece of Branch's. `createBranch` makes one of these; the server hands
 * it the requests under /ap/ and /api/interop/. See docs/configuration.md, "Talking to other agents
 * and tools".
 */
export interface InteropDeps {
  runtime: Runtime; registry: ToolRegistry; knowledge: Knowledge; teams: Teams; flows: Flows;
  remoteAgents: RemoteAgents; tokens: SessionTokens; files: WorkspaceFiles; policy: NetworkPolicy; version: string;
  locked?: () => boolean;
}

export class Interop {
  readonly agentProtocol: AgentProtocol;
  readonly clients: ClientToolHub;
  readonly modes: Modes;
  readonly router: ProjectRouter;
  readonly market: AgentMarket;
  readonly redisQueue: RedisQueue;
  readonly handoffParts: HandoffParts;
  private readonly registrars: Record<InteropPart, () => void>;

  constructor(private readonly deps: InteropDeps) {
    const { runtime, registry } = deps;
    const store = runtime.store, owner = runtime.owner;
    this.agentProtocol = new AgentProtocol(store, runtime);
    this.clients = new ClientToolHub(registry, store, owner);
    this.modes = new Modes(store, owner, runtime.workspace);
    this.router = new ProjectRouter(store, owner);
    this.market = new AgentMarket(store, owner, deps.policy, deps.files, deps.version);
    this.redisQueue = new RedisQueue(runtime, deps.policy, deps.locked ?? (() => true));
    this.handoffParts = { store, owner, tokens: deps.tokens, remoteAgents: deps.remoteAgents,
      scrub: (text) => runtime.hideSecrets(text) };
    const fleet = { runtime, knowledge: deps.knowledge, teams: deps.teams, remoteAgents: deps.remoteAgents, clients: this.clients };
    this.registrars = {
      "agent-protocol": () => undefined,
      "client-tools": () => undefined,
      modes: () => registerModeTools(registry, runtime, this.modes),
      "project-routing": () => registerProjectRouting(registry, this.router),
      fleet: () => { registerFleetTools(registry, fleet); registerRedisQueueTools(registry, this.redisQueue); },
      handoff: () => registerHandoffTool(registry, this.handoffParts),
      "flow-search": () => registerFlowSearch(registry, runtime, deps.flows),
      "agent-market": () => registerMarketTool(registry, this.market),
    };
    for (const part of interopParts) this.sync(part);
  }

  /** A part's tools are in the catalog exactly while its switch is not off. */
  private sync(part: InteropPart): void {
    for (const name of interopTools[part]) this.deps.registry.unregister(name);
    if (interopMode(this.deps.runtime.store, this.deps.runtime.owner, part) !== "off") this.registrars[part]();
  }

  modesOf(): Record<InteropPart, InteropMode> {
    return Object.fromEntries(interopParts.map((part) => [part, interopMode(this.deps.runtime.store, this.deps.runtime.owner, part)])) as Record<InteropPart, InteropMode>;
  }

  /** Saves a switch and puts the part's tools in or takes them out at once. */
  setMode(part: InteropPart, input: unknown): InteropMode {
    const mode = saveInteropMode(this.deps.runtime.store, this.deps.runtime.owner, part, input);
    this.sync(part);
    if (part === "client-tools" && mode === "off") this.clients.disconnectAll();
    return mode;
  }
}

export { interopParts, interopTools } from "./settings.js";
