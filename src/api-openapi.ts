import { z } from "zod";
import { GoalStartSchema } from "./goal-mode.js";
import { RewindSchema } from "./rewind.js";
import { RunInputSchema } from "./contracts.js";
import { PolicyInputSchema } from "./policy.js";
import { WorkflowSchema } from "./workflows.js";
import { ProjectSchema } from "./projects.js";
import { CommandRunSchema, CommandSettingsSchema } from "./commands/settings.js";
import { FlowYamlImportSchema } from "./flow-yaml.js";

/**
 * Branch's own web API, described the way every other program expects to be told: an OpenAPI 3
 * document. Nothing here is written twice — each route points at the zod schema the app already
 * checks that request with, so the description cannot drift from what the app will really accept.
 * Served at `GET /api/openapi.json`; `node scripts/write-api-docs.mjs` turns the same document into
 * docs/api.md so a person can read it without a tool.
 */
export interface ApiRoute {
  method: "get" | "post" | "put" | "delete";
  path: string;
  /** One line, in plain language, saying what the route is for. */
  summary: string;
  /** The heading it is listed under. */
  tag: string;
  /** The schema the request body is checked against, when it takes one. */
  body?: z.ZodType;
  /** Named for the reader when the body has no schema of its own. */
  bodyNote?: string;
}

/**
 * Every route worth calling from outside. Routes that only the app's own screens use, and the ones
 * that write their own answer (a backup file, a spreadsheet), are left out on purpose: this is the
 * list another program can rely on, not a dump of the router.
 */
export const apiRoutes: readonly ApiRoute[] = [
  { method: "post", path: "/api/run", summary: "Carry out one task and wait for the answer.", tag: "runs", body: RunInputSchema },
  { method: "get", path: "/api/runs/{runId}", summary: "One task: what happened, what it said, and what it cost.", tag: "runs" },
  { method: "get", path: "/api/runs/{runId}/inspect", summary: "Look inside a task: rounds, tool calls, plan and verdicts.", tag: "runs" },
  { method: "get", path: "/api/activity", summary: "Tasks working now and the conversations they belong to.", tag: "runs" },
  { method: "get", path: "/api/sessions/{sessionId}", summary: "One conversation with its messages.", tag: "sessions" },
  { method: "get", path: "/api/sessions/{sessionId}/tree", summary: "This conversation and everything branched from it.", tag: "sessions" },
  { method: "post", path: "/api/sessions/{sessionId}/merge-note", summary: "Carry this branch's last answer back into the conversation it came off.", tag: "sessions" },
  // Wave mac2 (goal-undo): working toward a goal in rounds, and going back to an earlier message.
  { method: "post", path: "/api/goals", summary: "Keep working in rounds until a goal is judged met (goal mode must be switched on).", tag: "sessions", body: GoalStartSchema },
  { method: "get", path: "/api/goal-undo/settings", summary: "The off, on and when-needed switches for goal mode and rewind snapshots.", tag: "sessions" },
  { method: "post", path: "/api/goal-undo/settings", summary: "Change either switch; the one not sent keeps its value.", tag: "sessions", bodyNote: "{ goal?: \"off\" | \"on\" | \"when-needed\", snapshots?: same }" },
  { method: "get", path: "/api/sessions/{sessionId}/goal", summary: "The goal in this conversation: round, score, what is missing, time.", tag: "sessions" },
  { method: "post", path: "/api/sessions/{sessionId}/goal", summary: "Pause, resume or stop this conversation's goal.", tag: "sessions", bodyNote: "{ action: \"pause\" | \"resume\" | \"stop\" }" },
  { method: "get", path: "/api/sessions/{sessionId}/rewind", summary: "Whether files can be taken back here, and the rewind that can be undone.", tag: "sessions" },
  { method: "post", path: "/api/sessions/{sessionId}/rewind", summary: "Take the conversation, the files, or both back to just before one message.", tag: "sessions", body: RewindSchema },
  { method: "post", path: "/api/sessions/{sessionId}/unrevert", summary: "Undo the newest rewind in this conversation.", tag: "sessions", bodyNote: "{}" },
  { method: "get", path: "/api/memory/export", summary: "Everything the assistant has been asked to remember.", tag: "memory" },
  { method: "post", path: "/api/memory/search", summary: "Search the saved facts.", tag: "memory", bodyNote: "A search: { query, limit }." },
  { method: "get", path: "/api/state", summary: "One snapshot of everything the app's own screen shows.", tag: "app" },
  { method: "get", path: "/api/health", summary: "Whether the app, its database and its model connection are well.", tag: "app" },
  { method: "get", path: "/api/tools", summary: "Every tool the assistant has, with what each one needs.", tag: "tools" },
  { method: "get", path: "/api/openapi.json", summary: "This description.", tag: "app" },
  { method: "get", path: "/api/projects", summary: "The projects work is grouped under.", tag: "projects" },
  { method: "post", path: "/api/projects", summary: "Save a project.", tag: "projects", body: ProjectSchema },
  { method: "post", path: "/api/projects/new", summary: "Make a project; an id already in use is refused.", tag: "projects", body: ProjectSchema },
  { method: "get", path: "/api/flows", summary: "Saved flows as boxes and arrows.", tag: "flows" },
  { method: "post", path: "/api/flows", summary: "Save a flow.", tag: "flows", body: WorkflowSchema },
  { method: "post", path: "/api/flows/{flowId}/run", summary: "Start a saved flow.", tag: "flows" },
  // Bucket 21: flows written out and read back as YAML, and the switch for building on Branch.
  { method: "get", path: "/api/flows/{flowId}/yaml", summary: "One saved flow written as YAML (building on Branch must be switched on).", tag: "flows" },
  { method: "post", path: "/api/flows/yaml", summary: "Save a flow written as YAML, always as a new flow (building on Branch must be switched on).", tag: "flows", body: FlowYamlImportSchema },
  { method: "get", path: "/api/sdk-kit", summary: "The switch for building on Branch, the clients for each language, and the tools to share.", tag: "developer" },
  { method: "post", path: "/api/sdk-kit", summary: "Change that switch (the owner only).", tag: "developer", bodyNote: "{ mode: \"off\" | \"on\" | \"when-needed\" }" },
  { method: "get", path: "/api/policy", summary: "The approval settings.", tag: "settings" },
  { method: "post", path: "/api/policy", summary: "Change the approval settings.", tag: "settings",
    body: PolicyInputSchema.extend({ confirmLoosening: z.boolean().optional() }) },
  { method: "get", path: "/api/lockdown", summary: "Whether Lockdown is on.", tag: "settings" },
  { method: "post", path: "/api/lockdown", summary: "Turn Lockdown on or off.", tag: "settings", bodyNote: "{ on: true } or { on: false }." },
  // Wave mac3 (commands, integration review): the one table of typed commands, and the dashboard.
  { method: "get", path: "/api/commands", summary: "The typed commands one page offers; add ?surface=window, phone or dashboard.", tag: "commands" },
  { method: "get", path: "/api/commands/table", summary: "Every typed command on every surface, and how each compares with other assistants.", tag: "commands" },
  { method: "post", path: "/api/commands/run", summary: "Carry out one typed command; a key that may only look may send only commands that look.", tag: "commands", body: CommandRunSchema },
  { method: "get", path: "/api/commands/settings", summary: "The off, on and when-needed switch for the commands the table added.", tag: "commands" },
  { method: "post", path: "/api/commands/settings", summary: "Change that switch (the key of this computer only).", tag: "commands", body: CommandSettingsSchema },
  { method: "get", path: "/api/dashboard", summary: "The browser dashboard in one answer: what is happening now, health, spending and recent activity (the dashboard must be switched on).", tag: "dashboard" },
  { method: "get", path: "/api/dashboard/settings", summary: "The dashboard's switch, and what this key may do there.", tag: "dashboard" },
  { method: "post", path: "/api/dashboard/settings", summary: "Switch the dashboard (the key of this computer only).", tag: "dashboard", bodyNote: "{ mode: \"off\" | \"on\" | \"when-needed\" }" },
  { method: "get", path: "/api/dashboard/automations", summary: "What Pause all paused, or null (the key of this computer only; answered whether or not the dashboard is switched on).", tag: "dashboard" },
  { method: "post", path: "/api/dashboard/automations", summary: "Pause every schedule and trigger, or resume the ones that were paused (the key of this computer only).", tag: "dashboard", bodyNote: "{ paused: true } or { paused: false }" },
  { method: "post", path: "/api/dashboard/restart", summary: "Restart Branch, where the computer's own service will start it again (the key of this computer only).", tag: "dashboard", bodyNote: "{}" },
  { method: "post", path: "/v1/chat/completions", summary: "The OpenAI-shaped way in, for tools that already speak it.", tag: "compatibility" },
  { method: "get", path: "/v1/models", summary: "The model connections, in the OpenAI shape.", tag: "compatibility" },
];

const placeholders = /\{([a-zA-Z]+)\}/g;
/** The path parameters written into a route's address, as OpenAPI describes them. */
function parametersFor(path: string): Record<string, unknown>[] {
  return [...path.matchAll(placeholders)].map(([, name]) => ({
    name, in: "path", required: true, schema: { type: "string" },
    description: `The ${String(name).replace(/Id$/, "")}'s id.`,
  }));
}

/** zod's own JSON Schema, with the parts OpenAPI does not want taken off. */
function schemaOf(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
  delete json.$schema;
  return json;
}

const okResponse = { description: "The answer, as JSON.", content: { "application/json": { schema: { type: "object" } } } };
const errorResponse = { description: "Something was wrong with the request.", content: { "application/json": { schema: { type: "object", properties: { error: { type: "string" } } } } } };

/** The request body of one route, however that route says what it takes. */
function bodyFor(route: ApiRoute): Record<string, unknown> {
  if (route.body)
    return { requestBody: { required: true, content: { "application/json": { schema: schemaOf(route.body) } } } };
  if (route.bodyNote)
    return { requestBody: { required: true, description: route.bodyNote, content: { "application/json": { schema: { type: "object" } } } } };
  return {};
}

/** A name another program can use as a function name, made from the method and the address. */
function operationId(route: ApiRoute): string {
  const words = route.path.split(/[^a-zA-Z0-9]+/).filter(Boolean);
  return route.method + words.map((word) => word[0]!.toUpperCase() + word.slice(1)).join("");
}

/** One route as an OpenAPI operation. */
function operationFor(route: ApiRoute): Record<string, unknown> {
  const parameters = parametersFor(route.path);
  return {
    summary: route.summary,
    tags: [route.tag],
    operationId: operationId(route),
    ...(parameters.length ? { parameters } : {}),
    ...bodyFor(route),
    responses: { "200": okResponse, "400": errorResponse, "401": { description: "The session key was missing or wrong." } },
    security: [{ sessionKey: [] }],
  };
}

/**
 * The whole document. `version` is the app's own version, so a client can see which build it is
 * talking to, and the one server is this computer's loopback address and nothing else.
 */
export function openApiDocument(version: string, baseUrl = "http://127.0.0.1:3210"): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const route of apiRoutes) {
    paths[route.path] ??= {};
    paths[route.path]![route.method] = operationFor(route);
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "Branch Agent",
      version,
      description: "Branch Agent's own web API. It runs on this computer only, and every request carries the session key the app printed when it started.",
    },
    servers: [{ url: baseUrl, description: "This computer" }],
    tags: [...new Set(apiRoutes.map((route) => route.tag))].map((name) => ({ name })),
    components: {
      securitySchemes: {
        sessionKey: { type: "http", scheme: "bearer", description: "The session key, sent as `Authorization: Bearer <key>`." },
      },
    },
    security: [{ sessionKey: [] }],
    paths,
  };
}

/** The same document as something a person can read: one heading per group, one line per route. */
export function apiMarkdown(document: Record<string, unknown>): string {
  const info = document.info as { title: string; version: string; description: string };
  const paths = document.paths as Record<string, Record<string, { summary: string; tags: string[] }>>;
  const byTag = new Map<string, string[]>();
  for (const [path, methods] of Object.entries(paths))
    for (const [method, operation] of Object.entries(methods)) {
      const tag = operation.tags[0] ?? "other";
      if (!byTag.has(tag)) byTag.set(tag, []);
      byTag.get(tag)!.push(`| \`${method.toUpperCase()}\` | \`${path}\` | ${operation.summary} |`);
    }
  const sections = [...byTag].map(([tag, rows]) =>
    `## ${tag}\n\n| Method | Address | What it is for |\n| --- | --- | --- |\n${rows.join("\n")}`);
  return [
    `# ${info.title} — the web API`,
    "",
    "Written by `node scripts/write-api-docs.mjs` from the app's own input checks. Do not edit by hand.",
    "",
    info.description,
    "",
    `Version ${info.version}. The machine-readable description is at \`GET /api/openapi.json\`.`,
    "",
    ...sections,
    "",
  ].join("\n");
}
