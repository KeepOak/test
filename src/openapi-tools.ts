import { chatOwnerOnly, startedFromChat } from "./key-context.js";
import { z } from "zod";
import type { ToolContext } from "./contracts.js";
import type { ToolRegistry } from "./registry.js";
import type { Store } from "./store.js";
import type { WorkspaceFiles } from "./files.js";
import type { NetworkPolicy } from "./network-policy.js";
import { scrubSecrets } from "./locker.js";
import {
  operationSchema, parseOpenApiText, readOpenApi, toolNameFor, OperationArgsSchema,
  type OpenApiOperation,
} from "./openapi.js";

/**
 * Turning an OpenAPI description into tools the assistant can call. The owner says which
 * operations may be used — nothing is registered that they did not name — and where the key comes
 * from: a secret already in their locker, fetched at the moment of the call, sent in a header, and
 * scrubbed out of the answer. Every address goes through the same network rules as everything else,
 * and each tool is filed under its own group in the catalog so it never crowds the built-in ones.
 */
export const openApiPermission = "api.call";
const groupName = z.string().regex(/^[a-z][a-z0-9_]{0,29}$/, "Use a short lowercase name such as notion");
const maxAnswerBytes = 64 * 1024;
/** The most of a description sent as text (it comes through POST /api/tools/try, whose body limit leaves room for it). */
export const openApiDocumentChars = 900 * 1024;

export const FromOpenApiSchema = z.object({
  /** A short name for this service; every tool it brings is called api.<name>.<operation>. */
  name: groupName,
  /** Where the description is: an address, a file in the workspace, or the description itself (a file the owner chose
      in the window, Settings › Developer). Give one of them. */
  url: z.string().url().max(2000).optional(),
  file: z.string().min(1).max(500).optional(),
  document: z.string().min(2).max(openApiDocumentChars).optional(),
  /** The name of the file the description came from, for the question and the card. */
  label: z.string().min(1).max(200).optional(),
  /** The operations that may be used, by their operationId. Nothing else is registered. A dry run may leave it out: it
      then lists every operation the description has, so the owner can choose. */
  allowlist: z.array(z.string().min(1).max(120)).min(1).max(50).optional(),
  /** The address to call, when the document's own is wrong or missing. */
  baseUrl: z.string().url().max(500).optional(),
  /** The name of a secret in the active project, sent as the key. */
  secret: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/).optional(),
  /** How the key is sent: "Authorization: Bearer <key>", or a header of your own. */
  auth: z.enum(["bearer", "header", "none"]).default("none"),
  header: z.string().regex(/^[A-Za-z][A-Za-z0-9-]{0,39}$/).default("Authorization"),
  /** Say what the tools would be without registering any of them. */
  dryRun: z.boolean().default(false),
}).strict()
  .refine((input) => [input.url, input.file, input.document].filter(Boolean).length === 1, "Give one of an address, a file or the description itself")
  .refine((input) => input.dryRun || !!input.allowlist, "Name the operations that may be used (allowlist); a dry run lists them");
export type FromOpenApiInput = z.infer<typeof FromOpenApiSchema>;

export interface OpenApiHost {
  store: Store;
  policy: NetworkPolicy;
  files: WorkspaceFiles;
  fetchImpl?: typeof fetch;
}

/** One service the owner turned into tools, so it can be listed and taken away again. */
export interface RegisteredService { name: string; base: string; tools: string[]; title: string }

/**
 * What is written down about a service so its tools come back after a restart. The description
 * itself is kept beside the rest, because a service whose address is unreachable — the owner is
 * offline, the service is down, the file has moved — must still give back its tools rather than
 * quietly go missing. **No key is here**: the key stays in the locker and is fetched at the moment
 * of each call, exactly as it was before.
 */
const SavedServiceSchema = z.object({
  name: groupName,
  allowlist: z.array(z.string().min(1).max(120)).min(1).max(50),
  baseUrl: z.string().url().max(500).optional(),
  secret: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/).optional(),
  auth: z.enum(["bearer", "header", "none"]).default("none"),
  header: z.string().regex(/^[A-Za-z][A-Za-z0-9-]{0,39}$/).default("Authorization"),
  /** Where it came from, for the card; never fetched again on the way back. */
  from: z.string().max(2000).default(""),
  /** The description as it was read, so the tools are rebuilt without reaching anywhere. */
  document: z.string().min(2).max(4 * 1024 * 1024),
}).strict();
type SavedService = z.infer<typeof SavedServiceSchema>;
const savedKey = (name: string): string => `openapi-service:${name}`;

export class OpenApiTools {
  private readonly services = new Map<string, RegisteredService>();
  constructor(private readonly registry: ToolRegistry, readonly host: OpenApiHost) {}
  list(): RegisteredService[] { return [...this.services.values()]; }
  /** Takes one service's tools back out of the catalog, and forgets it for the next start too. */
  remove(name: string, owner?: string): boolean {
    if (owner) this.host.store.delete("settings", owner, savedKey(name));
    const service = this.services.get(name);
    if (!service) return false;
    for (const tool of service.tools) this.registry.unregister(tool);
    this.services.delete(name);
    return true;
  }

  /**
   * Builds every service the owner added back into tools when the app starts. Nothing is fetched:
   * each description was written down as it was read, so this works with no network at all, and a
   * service that has become unreadable is skipped rather than allowed to stop the app starting.
   */
  restore(owner: string): string[] {
    const back: string[] = [];
    for (const record of this.host.store.list("settings", owner)) {
      if (!record.id.startsWith("openapi-service:")) continue;
      const parsed = SavedServiceSchema.safeParse(record.data);
      if (!parsed.success) continue;
      try { back.push(this.rebuild(parsed.data)); } catch { /* one bad service never stops the rest */ }
    }
    return back;
  }
  private rebuild(saved: SavedService): string {
    const source = parseOpenApiText(saved.document);
    const document = readOpenApi(source);
    const wanted = new Set(saved.allowlist);
    const chosen = document.operations.filter((operation) => wanted.has(operation.id));
    const input: FromOpenApiInput = { name: saved.name, allowlist: saved.allowlist, auth: saved.auth,
      header: saved.header, dryRun: false, ...(saved.baseUrl ? { baseUrl: saved.baseUrl } : {}),
      ...(saved.secret ? { secret: saved.secret } : {}) };
    const base = this.baseFor(input, document.servers);
    this.remove(saved.name);
    const names = chosen.map((operation) => this.registerOne(input, source, operation, base));
    this.services.set(saved.name, { name: saved.name, base, tools: names, title: document.title });
    return saved.name;
  }

  /** Reads the description and registers a tool for each allowed operation. */
  async add(input: FromOpenApiInput, context: ToolContext): Promise<unknown> {
    const text = await this.fetchDocument(input);
    const source = parseOpenApiText(text);
    const document = readOpenApi(source);
    const wanted = new Set(input.allowlist ?? []);
    const chosen = document.operations.filter((operation) => wanted.has(operation.id));
    const missing = [...wanted].filter((id) => !chosen.some((operation) => operation.id === id));
    const base = this.baseFor(input, document.servers);
    await this.host.policy.assertAllowed(new URL(base), "service address");
    const preview = chosen.map((operation) => ({
      tool: toolNameFor(input.name, operation.id), operation: operation.id,
      method: operation.method, path: operation.path, description: operation.summary,
    }));
    if (input.dryRun) return { dryRun: true, service: document.title, base, tools: preview, missing,
      // Every operation the description has, so a choice can be made; nothing of it is registered.
      available: document.operations.slice(0, 500).map((operation) => ({ operation: operation.id, method: operation.method, path: operation.path, description: operation.summary })) };
    const allowlist = input.allowlist ?? [];
    this.remove(input.name);
    const names = chosen.map((operation) => this.registerOne(input, source, operation, base));
    this.services.set(input.name, { name: input.name, base, tools: names, title: document.title });
    // Written down so the tools are there again after a restart. The key is not part of this: it
    // stays in the locker and is fetched at the moment of each call, exactly as before.
    this.host.store.save("settings", context.owner, savedKey(input.name), SavedServiceSchema.parse({
      name: input.name, allowlist, auth: input.auth, header: input.header,
      from: input.url ?? input.file ?? input.label ?? "", document: text,
      ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}), ...(input.secret ? { secret: input.secret } : {}),
    }));
    if (context.runId) this.host.store.event(context.runId, "tools.from_openapi", { service: input.name, base, tools: names.length });
    return { service: document.title, base, registered: names, tools: preview, missing };
  }

  private baseFor(input: FromOpenApiInput, servers: string[]): string {
    const base = input.baseUrl ?? servers[0];
    if (!base) throw new Error("That description does not say what address to call; give one as baseUrl.");
    return base.replace(/\/+$/, "");
  }

  /** The document itself, from the web through the network rules, or from the workspace. */
  private async fetchDocument(input: FromOpenApiInput): Promise<string> {
    if (input.document) return input.document;
    if (input.file) return (await this.host.files.read(input.file)).content;
    const url = new URL(input.url!);
    await this.host.policy.assertAllowed(url, "OpenAPI description address");
    const response = await (this.host.fetchImpl ?? globalThis.fetch)(url, {
      redirect: "error", signal: AbortSignal.timeout(20000), headers: { accept: "application/json, application/yaml, text/yaml" },
    });
    if (!response.ok) throw new Error(`${url.host} answered with HTTP ${response.status} for that description.`);
    const text = await response.text();
    if (text.length > 4 * 1024 * 1024) throw new Error("That description is larger than this can read.");
    return text;
  }

  private registerOne(input: FromOpenApiInput, source: Record<string, unknown>, operation: OpenApiOperation, base: string): string {
    const name = toolNameFor(input.name, operation.id);
    this.registry.register({
      name, permission: openApiPermission, group: "services",
      description: operation.summary,
      parameters: OperationArgsSchema,
      inputSchema: operationSchema(source, operation),
      target: () => new URL(base).host,
      execute: (args, context) => this.call(input, operation, base, args as Record<string, unknown>, context),
    });
    return name;
  }

  /** One call: the address built from the arguments, the key added, the answer trimmed and cleaned. */
  private async call(
    input: FromOpenApiInput, operation: OpenApiOperation, base: string,
    args: Record<string, unknown>, context: ToolContext,
  ): Promise<unknown> {
    const { url, headers, body } = buildRequest(operation, base, args);
    await this.host.policy.assertAllowed(url, "service address");
    const secrets = await this.secretValue(input, context);
    if (input.auth === "bearer" && secrets.key) headers.authorization = `Bearer ${secrets.key}`;
    if (input.auth === "header" && secrets.key) headers[input.header.toLowerCase()] = secrets.key;
    const started = Date.now();
    const response = await (this.host.fetchImpl ?? globalThis.fetch)(url, {
      method: operation.method.toUpperCase(), headers, ...(body === undefined ? {} : { body }),
      redirect: "error", signal: AbortSignal.timeout(30000),
    });
    const text = (await response.text()).slice(0, maxAnswerBytes);
    if (context.runId)
      this.host.store.event(context.runId, "api.called", { tool: toolNameFor(input.name, operation.id), host: url.host, path: url.pathname, status: response.status, ms: Date.now() - started });
    if (!response.ok) throw new Error(`${url.host} answered with HTTP ${response.status}.`);
    return cleanAnswer(text, response.status, secrets);
  }

  private async secretValue(input: FromOpenApiInput, context: ToolContext): Promise<Record<string, string>> {
    if (input.auth === "none" || !input.secret) return {};
    const project = this.host.store.projects.active(context.owner).id;
    const values = await this.host.store.locker.resolve(context.owner, project, [input.secret]);
    const key = values[input.secret];
    // Without this the call would simply go out with no key at all and come back "not allowed",
    // which says nothing about what is actually wrong. Say what is missing and where to put it.
    if (!key) throw new Error(`Save a secret called ${input.secret} in the active project first; that is where this service's key is read from.`);
    return { key };
  }
}

/** Fills the path, gathers the query and the headers, and writes the body. */
export function buildRequest(operation: OpenApiOperation, base: string, args: Record<string, unknown>): { url: URL; headers: Record<string, string>; body: string | undefined } {
  let path = operation.path;
  const query = new URLSearchParams();
  const headers: Record<string, string> = { accept: "application/json" };
  for (const parameter of operation.parameters) {
    const value = args[parameter.name];
    if (value === undefined || value === null) {
      if (parameter.required) throw new Error(`This call needs a value for "${parameter.name}".`);
      continue;
    }
    if (parameter.where === "path") path = path.split(`{${parameter.name}}`).join(encodeURIComponent(String(value)));
    else if (parameter.where === "query") query.set(parameter.name, String(value));
    else headers[parameter.name.toLowerCase()] = String(value).slice(0, 500);
  }
  const remaining = /\{([^}]+)\}/.exec(path);
  if (remaining) throw new Error(`This call needs a value for "${remaining[1]}".`);
  const url = new URL(`${base}${path.startsWith("/") ? path : `/${path}`}`);
  for (const [key, value] of query) url.searchParams.set(key, value);
  const body = operation.body && args.body !== undefined ? JSON.stringify(args.body) : undefined;
  if (body) headers["content-type"] = "application/json";
  return { url, headers, body };
}

/** The answer as data, with the key we sent scrubbed back out of it. */
export function cleanAnswer(text: string, status: number, secrets: Record<string, string>): unknown {
  const scrubbed = scrubSecrets(text, secrets);
  const trimmed = scrubbed.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return { status, data: scrubbed.slice(0, 8000) };
  try { return { status, data: JSON.parse(trimmed) as unknown }; } catch { return { status, data: scrubbed.slice(0, 8000) }; }
}

export function registerOpenApiTools(registry: ToolRegistry, tools: OpenApiTools): void {
  registry.register({
    name: "tools.from_openapi", reach: "outbound", permission: "skills.write", group: "skills",
    description: "Turn a service's own OpenAPI description into tools, one for each operation you allow. Say where the description is, which operations may be used, and which saved secret holds the key. Use dryRun first to see what you would get; a dry run with no allowlist lists every operation it has.",
    parameters: FromOpenApiSchema,
    target: (args) => `tools from ${args.url ?? args.file ?? args.label ?? "a chosen file"} as api.${args.name}`,
    execute: async (args, context) => {
      if (startedFromChat(context, tools.host.store)) throw chatOwnerOnly("Adding a service's tools");
      return tools.add(args, context);
    },
  });
  registry.register({
    name: "tools.services", permission: "skills.read", group: "skills",
    description: "The services whose operations are registered as tools right now, and the tools each one brought.",
    parameters: z.object({}).strict(),
    execute: async () => ({ services: tools.list() }),
  });
  registry.register({
    name: "tools.forget_service", permission: "skills.write", group: "skills",
    description: "Take one service's tools back out, leaving everything else alone.",
    parameters: z.object({ name: groupName }).strict(),
    target: (args) => `forget api.${args.name}`,
    execute: async (args, context) => {
      if (startedFromChat(context, tools.host.store)) throw chatOwnerOnly("Taking a service's tools out");
      return { name: args.name, removed: tools.remove(args.name, context.owner) };
    },
  });
}
