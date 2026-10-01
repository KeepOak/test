import { z } from "zod";
import { offers, searchHuggingFace, lookUpOllama, searchQuery } from "./local-catalogue.js";
import { savedLocalConnections } from "./local-connections.js";
import { assertLocalModelsOn, localModelsMode, saveLocalModelsMode } from "./local-jobs.js";
import { oneButtonMode, saveOneButtonMode, type PressContext } from "./local-one-button.js";
import { vllmHereOnly } from "./local-oneclick.js";
import { currentCaller } from "./caller.js";
import { throughPairedDoor } from "./people/context.js";
import type { LocalKit } from "./local-kit.js";
import { runtimeIds, runtimeInfo, type RuntimeId } from "./local-launch.js";
import { RuntimeSchema } from "./local-manage.js";
import { localModelName } from "./local-models.js";
import { classifyTask, routeForTask, routingSettings, saveRoutingSettings } from "./local-routing.js";
import type { LocalRuntimes } from "./local-runtimes.js";
import type { ModelRouter } from "./models.js";
import type { Store } from "./store.js";
import { byCard, recordedWrite } from "./settings-kit/recorded-write.js"; // Q48

/**
 * The `/api/local-models/*` family: what is on this computer, what this computer could run,
 * the one-click setup (wave mac5), managing what is loaded and downloaded, and the per-task
 * routing rules. Kept out of src/server.ts so the route table there stays one short block.
 * Everything that changes something refuses while the switch is off.
 */
const modelBody = z.object({ model: localModelName }).strict();
const previewBody = z.object({
  prompt: z.string().trim().min(1).max(8000),
  toolCount: z.number().int().min(0).max(500).default(0),
  localUp: z.boolean().default(true),
}).strict();
const runtimeEnum = z.enum(runtimeIds as [RuntimeId, ...RuntimeId[]]);
const searchBody = z.object({ runtime: runtimeEnum, query: searchQuery }).strict();
const idBody = z.object({ id: z.string().uuid() }).strict();
const offersBody = z.object({ runtime: runtimeEnum }).strict();

export interface LocalModelsDeps {
  runtimes: LocalRuntimes;
  store: Store;
  models: ModelRouter;
  owner: string;
  /** The one-click pieces; absent in a launch that did not set them up. */
  kit?: LocalKit | undefined;
  /**
   * Who is asking: the owner, a household profile, a short-lived key, a chat app or a Trunk. The
   * one button's guard decides from this itself, so it holds whatever is in front of this route.
   */
  caller: PressContext;
}

export async function localModelsApi(
  deps: LocalModelsDeps, method: string, path: string, body: () => Promise<unknown>,
): Promise<unknown> {
  const { runtimes, store, models, owner } = deps;
  if (method === "GET" && path === "/api/local-models") return overview(deps);
  if (method === "GET" && path === "/api/local-models/downloads") return { downloads: runtimes.progress() };
  if (method === "GET" && path === "/api/local-models/routing") return routingSettings(store, owner);
  if (method === "POST" && path === "/api/local-models/routing") return saveRoutingSettings(store, owner, await body());
  if (method === "POST" && path === "/api/local-models/routing/preview") {
    const input = previewBody.parse(await body());
    const shape = classifyTask(input.prompt, input.toolCount);
    return { shape, choice: routeForTask(store, models, owner, input) };
  }
  if (method === "POST" && path === "/api/local-models/switch") {
    const input = await body();
    return recordedWrite(store, owner, byCard("local-models"), ["local-models"], () => saveLocalModelsMode(store, owner, input));
  }
  // mac7/one-click: installing the program is its own switch, because it is the one thing here that
  // changes the owner's computer. It ships off, and Lockdown holds it off whatever is saved.
  if (method === "POST" && path === "/api/local-models/install/switch") {
    const input = await body();
    return recordedWrite(store, owner, byCard("local-runner-install"), ["local-runner-install"], () => saveOneButtonMode(store, owner, input));
  }
  if (method === "POST" && path === "/api/local-models/details")
    return runtimes.details(modelBody.parse(await body()).model);
  if (method === "POST" && path.startsWith("/api/local-models/")) return changes(deps, path, await body());
  throw new Error("That is not something Branch can do with models on this computer");
}

/** Every route that changes something: checked, then refused while the switch is off. */
async function changes(deps: LocalModelsDeps, path: string, input: unknown): Promise<unknown> {
  const { runtimes, store, owner } = deps;
  const simple: Record<string, (model: string) => unknown> = {
    "/api/local-models/pull": (model) => runtimes.start(model),
    "/api/local-models/stop": (model) => runtimes.stop(model),
    "/api/local-models/remove": (model) => runtimes.remove(model),
    "/api/local-models/load": (model) => runtimes.lmStudio.load(model),
  };
  // Integration review: these four are the card's older Ollama and LM Studio routes. The switch
  // ships off and off means the old behaviour, so they work whatever the switch says.
  const direct = simple[path];
  if (direct) return direct(modelBody.parse(input).model);
  const kit = deps.kit;
  if (!kit) throw new Error("One-click models are not set up in this launch of Branch");
  if (path === "/api/local-models/offers") return { offers: offers(await kit.room(), offersBody.parse(input).runtime) };
  assertLocalModelsOn(store, owner);
  if (path === "/api/local-models/setup" && (input as { runtime?: unknown } | null)?.runtime === "vllm") {
    store.profiles.requireOwner("Starting vLLM with a local model");
    if (deps.caller.source !== "owner" || deps.caller.person || deps.caller.shortLivedKey || deps.caller.trunkKeys
      || currentCaller().throughDoor || throughPairedDoor()) throw new Error(vllmHereOnly);
  }
  if (path === "/api/local-models/search") return search(kit, input);
  switch (path) {
    case "/api/local-models/setup": return kit.oneClick.begin(input);
    // mac7/one-click (issue #107): what the button would do, and the button itself.
    case "/api/local-models/one-button/plan": return kit.oneClick.buttonPlan(input, deps.caller);
    case "/api/local-models/one-button": return kit.oneClick.buttonGo(input, deps.caller);
    case "/api/local-models/setup/stop": return kit.oneClick.stop(idBody.parse(input).id);
    case "/api/local-models/unload": return kit.manager.unload(input);
    case "/api/local-models/delete": return kit.manager.remove(input);
    case "/api/local-models/runtime/stop": return kit.manager.stop(input);
    case "/api/local-models/runtime/start": return kit.launcher.start(RuntimeSchema.parse(input).runtime);
  }
  throw new Error("That is not something Branch can do with models on this computer");
}

async function search(kit: LocalKit, input: unknown): Promise<unknown> {
  const { runtime, query } = searchBody.parse(input);
  if (runtime === "ollama") return { hits: await lookUpOllama(query.replace(/\s+/g, ""), kit.library), exactOnly: true };
  return { hits: await searchHuggingFace(query, runtime, kit.library), exactOnly: false };
}

/** Everything the "Models on this computer" card shows in one request. */
async function overview(deps: LocalModelsDeps) {
  const [inventory, advice] = await Promise.all([deps.runtimes.inventory(), deps.runtimes.recommendations()]);
  return {
    ...inventory,
    hardware: advice.hardware,
    recommendations: advice.models,
    suggested: advice.suggested,
    downloads: deps.runtimes.progress(),
    routing: routingSettings(deps.store, deps.owner),
    lastError: deps.runtimes.lastError,
    mode: localModelsMode(deps.store, deps.owner),
    installMode: oneButtonMode(deps.store, deps.owner), // mac7/one-click

    oneClick: deps.kit ? await oneClickView(deps, deps.kit) : null,
  };
}

async function oneClickView(deps: LocalModelsDeps, kit: LocalKit) {
  const room = await kit.room();
  const installed = await kit.launcher.installed();
  const on = localModelsMode(deps.store, deps.owner) !== "off";
  const runtimes = runtimeIds
    .filter((id) => (id !== "mlx" || (kit.launcher.at.platform === "darwin" && kit.launcher.at.arch === "arm64")) && (id !== "vllm" || kit.launcher.at.platform === "linux"))
    .map((id) => ({ ...runtimeInfo[id], installed: Boolean(installed[id]), startedByBranch: kit.launcher.owns(id) }));
  const chosen = runtimes.find((one) => one.installed)?.id ?? "ollama";
  return {
    room: { freeMemoryBytes: room.freeMemoryBytes, totalMemoryBytes: room.totalMemoryBytes, graphicsLimitBytes: room.graphicsLimitBytes },
    runtimes, chosen,
    offers: offers(room, chosen),
    setups: kit.oneClick.jobs.all().slice(0, 10),
    loaded: on ? await kit.manager.loaded() : [],
    onDisk: on ? (await kit.manager.onDisk()).filter((model) => !/-branch\d+k$/.test(model.name)) : [],
    connections: savedLocalConnections(deps.store, deps.owner),
  };
}
