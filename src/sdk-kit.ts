import { z } from "zod";
import { apiRoutes } from "./api-openapi.js";
import { FeatureModeSchema, sdkKitToolNames, type FeatureMode } from "./feature-switches.js";
import type { Flows } from "./flows.js";
import { flowFromYaml, flowToYaml, FlowYamlError, FlowYamlImportSchema } from "./flow-yaml.js";
import type { ToolRegistry } from "./registry.js";
import { findRoutes, routeSnippets, sdkLanguages, SdkLanguageSchema, sdkPackages, starterProgram } from "./sdk-starters.js";
import type { Store } from "./store.js";
import { byCard, recordedWrite } from "./settings-kit/recorded-write.js"; // Q48

/**
 * Bucket 21: tools for people building on Branch, behind one three-way switch that ships off.
 *
 *   off          the sdk.* tools are not advertised and refuse; flows cannot be written out or read
 *                back as YAML
 *   when-needed  the tools stay a line in the index until a task asks for them
 *   on           the tools are loaded from the first round
 *
 * The sdk.* tools are what makes Branch's own MCP server (src/mcp-server.ts) an app-builder's
 * server: share them under Customize → Connections and an editor such as Claude Code or Cursor can
 * ask which routes exist, what each one takes, and get working code for each client.
 */
export const sdkKitSettingsKey = "sdk-kit"; // the same record src/sdk-kit-switch.ts reads
import { sdkKitMode } from "./sdk-kit-switch.js";
export const sdkKitTools = sdkKitToolNames;
export const SdkKitSettingsSchema = z.object({ mode: FeatureModeSchema }).strict();
export const sdkKitOffMessage =
  "Tools for people building on Branch are switched off. Switch them on under Settings → Advanced.";

type Reader = Pick<Store, "get">;

export { sdkKitMode, sdkKitShipsAs } from "./sdk-kit-switch.js"; // defaults audit: the switch on its own

export function saveSdkKitSettings(store: Store, owner: string, input: unknown): { mode: FeatureMode } {
  const settings = SdkKitSettingsSchema.parse(input);
  store.save("settings", owner, sdkKitSettingsKey, settings);
  return settings;
}

export class SdkKitError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

const requireOn = (store: Reader, owner: string): void => {
  if (sdkKitMode(store, owner) === "off") throw new SdkKitError(409, sdkKitOffMessage);
};

const RoutesInput = z.object({
  tag: z.string().trim().max(40).optional(),
  search: z.string().trim().max(200).optional(),
}).strict();
const RouteInput = z.object({
  // No transform here: a tool's input is also handed to the model as JSON Schema.
  method: z.enum(["GET", "POST", "PUT", "DELETE", "get", "post", "put", "delete"]),
  path: z.string().trim().min(1).max(200),
}).strict();
const StarterInput = z.object({ language: SdkLanguageSchema }).strict();

/** One route in full: what it takes, and the call in each language. */
function routeDetail(method: string, path: string): Record<string, unknown> {
  const route = apiRoutes.find((entry) => entry.method === method && entry.path === path);
  if (!route) throw new SdkKitError(404, `Branch does not describe ${method.toUpperCase()} ${path}. Ask sdk.routes for the list.`);
  const body = route.body ? z.toJSONSchema(route.body, { io: "input", unrepresentable: "any" }) : undefined;
  return {
    method: route.method.toUpperCase(), path: route.path, summary: route.summary, group: route.tag,
    ...(body ? { body } : route.bodyNote ? { bodyNote: route.bodyNote } : {}),
    examples: routeSnippets(route), packages: sdkPackages,
  };
}

/** The three tools. Each says plainly when the switch is off rather than pretending to work. */
export function registerSdkKit(registry: ToolRegistry, store: Reader): void {
  registry.register({
    name: "sdk.routes", permission: "skills.read",
    description: "For writing a program that uses Branch: the web routes it offers, by group or by words, with what each is for.",
    parameters: RoutesInput,
    execute: async (input, context) => {
      requireOn(store, context.owner);
      const routes = findRoutes(input).map((route) => ({ method: route.method.toUpperCase(), path: route.path, summary: route.summary, group: route.tag }));
      return { routes, groups: [...new Set(apiRoutes.map((route) => route.tag))], languages: sdkLanguages };
    },
  });
  registry.register({
    name: "sdk.route", permission: "skills.read",
    description: "For writing a program that uses Branch: one web route in full, what it takes, and the call in Python, TypeScript, Go and React.",
    parameters: RouteInput,
    execute: async (input, context) => { requireOn(store, context.owner); return routeDetail(input.method.toLowerCase(), input.path); },
  });
  registry.register({
    name: "sdk.starter", permission: "skills.read",
    description: "For writing a program that uses Branch: a small working program in one language that starts a task and watches it.",
    parameters: StarterInput,
    execute: async (input, context) => { requireOn(store, context.owner); return starterProgram(input.language); },
  });
}

/* ---------- the routes ---------- */

const yamlExport = /^\/api\/flows\/([a-f0-9-]{36})\/yaml$/;
export const handlesSdkKitPath = (path: string): boolean =>
  path === "/api/sdk-kit" || path === "/api/flows/yaml" || yamlExport.test(path);

export interface SdkKitDeps {
  store: Store;
  owner: string;
  flows: Flows;
  /** Throws when the person asking is not the owner of this copy. */
  requireOwner: (what: string) => void;
}

/**
 *   GET  /api/sdk-kit                 the switch, the clients in this repository, and the tools to share
 *   POST /api/sdk-kit                 change the switch (the owner only)
 *   GET  /api/flows/{flowId}/yaml     one saved flow written as YAML
 *   POST /api/flows/yaml              a flow written as YAML, saved as a new flow
 */
/** A saved flow, or a plain 404 when there is none by that id. */
function savedFlow(flows: Flows, id: string): ReturnType<Flows["get"]> {
  try { return flows.get(id); } catch { throw new SdkKitError(404, "There is no saved flow with that id."); }
}

export async function sdkKitApi(deps: SdkKitDeps, method: string, path: string, body: () => Promise<unknown>): Promise<unknown> {
  if (path === "/api/sdk-kit") {
    if (method === "POST") {
      deps.requireOwner("Tools for people building on Branch");
      const input = await body();
      recordedWrite(deps.store, deps.owner, byCard("sdk-kit"), ["sdk-kit"], () => saveSdkKitSettings(deps.store, deps.owner, input));
    } else if (method !== "GET") throw new SdkKitError(405, "Read the switch with GET or change it with POST.");
    return { settings: { mode: sdkKitMode(deps.store, deps.owner) }, packages: sdkPackages, tools: sdkKitTools };
  }
  requireOn(deps.store, deps.owner);
  const exporting = yamlExport.exec(path);
  if (exporting && method === "GET") {
    const flow = savedFlow(deps.flows, exporting[1]!);
    return { id: flow.id, name: flow.name, yaml: flowToYaml(flow) };
  }
  if (path === "/api/flows/yaml" && method === "POST") {
    const { yaml } = FlowYamlImportSchema.parse(await body());
    try { return deps.flows.save(flowFromYaml(yaml)); } catch (error) {
      if (error instanceof FlowYamlError) throw new SdkKitError(400, error.message);
      throw error;
    }
  }
  throw new SdkKitError(405, "Flows are written out with GET and read back with POST.");
}
