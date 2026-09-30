import { randomUUID } from "node:crypto";
import { z } from "zod";
import { errorText } from "../contracts.js";
import { McpTransportSchema } from "../integrations/mcp-config.js";
import { malwareAdvisories, osvEndpoint, type Advisory } from "../security-audit/malware-check.js";
import { downloadsWhatItRuns, packageOfLaunch, type PackageRef } from "../security-audit/package-launch.js";
import type { Store } from "../store.js";
import { oneLine, partRecord, requirePart } from "./settings.js";

/**
 * R17-075: Branch asks for a new package or a new tool server (MCP), and the owner answers (NanoClaw's
 * self-modification requests, `src/modules/self-mod/*`, MIT; written for Branch).
 *
 * - The assistant, or somebody writing in a chat app, can only ask. A request is written down with who
 *   asked, and the public list of harmful packages (OSV, the same lookup as the malware check in
 *   src/security-audit/malware-check.ts) is asked about it straight away. One named there as malware is
 *   refused on the spot and never reaches the owner as a question.
 * - Only the owner answers, in the app window or the owner's own terminal — never from a chat app,
 *   never with a short-lived key, never as a household person. A request the list could not be asked
 *   about is only approved when the owner says so in as many words.
 * - Nothing installs itself. A yes is written down and comes back with the exact command, or the exact
 *   server settings, for the owner (or a later task, under the ordinary approval rules) to use.
 */
const npmName = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]{0,213}$/;
const pypiName = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?$/;
const version = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9.+_-]{0,63}$/, "A version is letters, digits, dots and dashes");

const PackageRequestSchema = z.object({
  kind: z.literal("package"),
  ecosystem: z.enum(["npm", "PyPI"]),
  name: z.string().trim().min(1).max(214),
  version: version.optional(),
  why: z.string().trim().min(1).max(300),
}).strict().refine((value) => (value.ecosystem === "npm" ? npmName : pypiName).test(value.name), { message: "That is not a package name", path: ["name"] });
const ServerRequestSchema = z.object({
  kind: z.literal("mcp"),
  name: z.string().regex(/^[a-z][a-z0-9-]{0,29}$/, "A server's name is lower-case letters, digits and dashes"),
  server: McpTransportSchema,
  why: z.string().trim().min(1).max(300),
}).strict();
/**
 * Owner report (2026-09-30): a plain union answered every slip with only "The request is not valid.", so the model sent
 * the same call again. Told apart by `kind`, a wrong field is named. A few spellings models use are read as meant: no
 * `kind` when `ecosystem` or `server` says which, "pypi" or "NPM", and a server with only a command or an address.
 */
function readAsMeant(input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const value = { ...(input as Record<string, unknown>) };
  if (value.kind === undefined) value.kind = value.server !== undefined ? "mcp" : value.ecosystem !== undefined ? "package" : undefined;
  if (typeof value.ecosystem === "string") value.ecosystem = { npm: "npm", pypi: "PyPI" }[value.ecosystem.trim().toLowerCase()] ?? value.ecosystem;
  const server = value.server;
  if (server && typeof server === "object" && !Array.isArray(server) && (server as { transport?: unknown }).transport === undefined) {
    const shape = server as Record<string, unknown>;
    value.server = typeof shape.command === "string" ? { transport: "stdio", ...shape } : typeof shape.url === "string" ? { transport: "http", ...shape } : shape;
  }
  return value;
}
export const InstallRequestSchema = z.preprocess(readAsMeant, z.discriminatedUnion("kind", [PackageRequestSchema, ServerRequestSchema]));
export type InstallAsk = z.infer<typeof InstallRequestSchema>;

export type Requester = "assistant" | "chat" | "owner" | "other";
export type CheckState = "clean" | "harmful" | "unchecked" | "nothing-to-check";
export interface InstallRequest {
  id: string; ask: InstallAsk; by: Requester; from: string;
  status: "waiting" | "approved" | "declined" | "refused";
  check: { state: CheckState; advisories: string[]; note: string };
  nextStep: string | null; at: string; answeredAt: string | null;
}

const Saved = z.object({ items: z.array(z.custom<InstallRequest>()).max(120).default([]) }).strict();
/** Not "flowboards-install-requests": that record is the part's switch. */
const listKey = "flowboards-install-list";
const maxWaiting = 20;

export interface InstallDeps {
  store: Store; owner: string;
  /** A fetch that already follows the owner's network rules. */
  fetch: () => typeof fetch;
  endpoint?: string;
}

export class InstallRequests {
  constructor(private readonly deps: InstallDeps) {}
  private get store() { return this.deps.store; }
  private get owner() { return this.deps.owner; }

  list(): InstallRequest[] { return partRecord(this.store, this.owner, listKey, Saved).items; }
  waiting(): InstallRequest[] { return this.list().filter((item) => item.status === "waiting"); }
  private save(items: InstallRequest[]): void {
    const kept = [...items];
    while (kept.length > 100) {
      const oldest = kept.findIndex((item) => item.status !== "waiting");
      if (oldest < 0) break;
      kept.splice(oldest, 1);
    }
    this.store.save("settings", this.owner, listKey, { items: kept });
  }

  /** Somebody asks. `from` names them in a few words (the chat, or "the assistant"). */
  async request(input: unknown, by: Requester, from: string): Promise<InstallRequest> {
    requirePart(this.store, this.owner, "install-requests");
    const ask = InstallRequestSchema.parse(input);
    const items = this.list();
    // A request already waiting, or already answered no, is not asked again.
    const same = items.find((item) => item.status !== "approved" && sameAsk(item.ask, ask));
    if (same) return same;
    if (items.filter((item) => item.status === "waiting").length >= maxWaiting)
      throw new Error("There are already twenty requests waiting for the owner; wait for an answer first.");
    const check = await this.look(ask);
    const request: InstallRequest = {
      id: randomUUID(), ask: { ...ask, why: oneLine(ask.why, 300) }, by, from: oneLine(from, 80),
      status: check.state === "harmful" ? "refused" : "waiting", check, nextStep: null,
      at: new Date().toISOString(), answeredAt: check.state === "harmful" ? new Date().toISOString() : null,
    };
    this.save([...this.list(), request]);
    return request;
  }

  /**
   * The owner's answer. The caller has already made sure it is the owner, in the window or the owner's
   * terminal. `despiteUnchecked` is the owner saying yes although the list could not be asked.
   */
  async answer(id: string, yes: boolean, options: { despiteUnchecked?: boolean } = {}): Promise<InstallRequest> {
    requirePart(this.store, this.owner, "install-requests");
    const found = this.list().find((entry) => entry.id === id);
    if (!found || found.status !== "waiting") throw new Error("That request is not waiting for an answer.");
    let item = found;
    // Integration review: a yes asks the list again, so a package named as malware since it was asked about is refused.
    if (yes) item = { ...item, check: await this.look(item.ask) };
    if (yes && item.check.state === "harmful") return this.settle({ ...item, status: "refused" });
    if (yes && item.check.state === "unchecked" && !options.despiteUnchecked)
      throw new Error(`The list of harmful packages could not be asked, or did not give a full answer (${item.check.note}). Try again, or approve it anyway on purpose.`);
    return this.settle({ ...item, status: yes ? "approved" : "declined", nextStep: yes ? nextStep(item.ask) : null });
  }

  private settle(item: InstallRequest): InstallRequest {
    const done = { ...item, answeredAt: new Date().toISOString() };
    this.save(this.list().map((entry) => (entry.id === item.id ? done : entry)));
    return done;
  }

  /** The malware lookup. Only a positive listing refuses; a lookup that fails is said plainly. */
  private async look(ask: InstallAsk): Promise<InstallRequest["check"]> {
    const pkg = packageOf(ask);
    if (!pkg) {
      const fetched = ask.kind === "mcp" && ask.server.transport === "stdio" && downloadsWhatItRuns(ask.server.command, ask.server.args);
      return fetched
        ? { state: "unchecked", advisories: [], note: "it downloads a package whose name could not be read" }
        : { state: "nothing-to-check", advisories: [], note: "nothing is downloaded from a package list" };
    }
    try {
      const found: Advisory[] = await malwareAdvisories(pkg, this.deps.fetch(), this.deps.endpoint ?? osvEndpoint);
      return found.length
        ? { state: "harmful", advisories: found.map((a) => a.id).slice(0, 5), note: `named as malware: ${found.map((a) => a.id).slice(0, 3).join(", ")}` }
        : { state: "clean", advisories: [], note: `${pkg.name} is not on the list of harmful packages` };
    } catch (error) {
      return { state: "unchecked", advisories: [], note: oneLine(errorText(error), 160) };
    }
  }
}

function packageOf(ask: InstallAsk): PackageRef | null {
  if (ask.kind === "package") return { ecosystem: ask.ecosystem, name: ask.name, version: ask.version ?? null };
  return ask.server.transport === "stdio" ? packageOfLaunch(ask.server.command, ask.server.args) : null;
}

function sameAsk(a: InstallAsk, b: InstallAsk): boolean {
  const { why: _a, ...left } = a, { why: _b, ...right } = b;
  return JSON.stringify(left) === JSON.stringify(right);
}

/** What the owner does next, written out exactly. Nothing here is run. */
export function nextStep(ask: InstallAsk): string {
  if (ask.kind === "package") {
    return ask.ecosystem === "npm"
      ? `npm install ${ask.name}${ask.version ? `@${ask.version}` : ""}`
      : `python3 -m pip install "${ask.name}${ask.version ? `==${ask.version}` : ""}"`;
  }
  return `Add this server under Customize › Connections, and switch it on there when you want it: ${JSON.stringify({ id: ask.name, ...ask.server })}`;
}
