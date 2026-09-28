import { chatOwnerOnly, startedFromChat } from "./key-context.js";
import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { Budget, errorText, type ToolContext } from "./contracts.js";
import { RateLimiter } from "./approvals.js";
import type { NetworkPolicy } from "./network-policy.js";
import type { ToolRegistry } from "./registry.js";
import type { Store } from "./store.js";

/**
 * The other side of A2A: assistants elsewhere that this one may hand a piece of work to. The owner
 * adds one by its card address, which is read through the same address rules as everything else on
 * the network. Only the words of the task are sent — never a file, a secret, or anything the
 * assistant has read — and the answer comes back as plain text, recorded with a receipt like any
 * other step. A remote assistant is a stranger: it gets a small allowance and a hard time limit.
 */
const CardSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(2000).default(""),
  url: z.string().url().max(2000),
  version: z.string().max(60).default(""),
  skills: z.array(z.object({ id: z.string().max(200), name: z.string().max(200).optional() }).passthrough()).max(100).default([]),
  provider: z.object({ organization: z.string().max(200).optional() }).passthrough().optional(),
}).passthrough();
export const RemoteAgentSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(120),
  description: z.string().max(2000),
  cardUrl: z.string().max(2000),
  url: z.string().max(2000),
  skills: z.array(z.string().max(200)).max(100),
  /** The key that install handed out, when it needs one. Kept beside the other settings. */
  key: z.string().max(400).optional(),
  /** a2a-rooms: who the card says runs it (`provider.organization`), for the badge a room draws. */
  provider: z.string().max(60).optional(),
  addedAt: z.string(),
}).strict();
export type RemoteAgent = z.infer<typeof RemoteAgentSchema>;

const recordId = (id: string) => `remote-agent:${id}`;

const originOf = (address: string): string | null => { try { return new URL(address).origin; } catch { return null; } };
/**
 * The key header for a request to the address an assistant takes work at. A card names that address itself, and it
 * may be another site than the one the owner connected, so the saved key goes only to the site the owner connected; a
 * card that names another is refused, in `who`'s words, until the owner connects it again at that address.
 */
export function keyHeader(agent: RemoteAgent, who: string): Record<string, string> {
  if (!agent.key) return {};
  const at = originOf(agent.url);
  if (at === null || at !== originOf(agent.cardUrl))
    throw new Error(`${who} takes work at ${at ?? "an address that cannot be read"}, another site than the one you connected, `
      + "so its key is not sent there. Connect it again at that address to use it.");
  return { authorization: `Bearer ${agent.key}` };
}
const cardPath = "/.well-known/agent.json";
export const defaultAskTimeoutMs = 60000;
export const maximumAskTimeoutMs = 120000;
/** How many tasks may be sent to one outside assistant in a minute. */
export const askesPerMinute = 10;

export const RemoteActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("list") }).strict(),
  z.object({
    action: z.literal("add"),
    cardUrl: z.string().trim().min(1).max(2000),
    key: z.string().trim().max(400).optional(),
  }).strict(),
  z.object({ action: z.literal("remove"), agent: z.string().trim().min(1).max(200) }).strict(),
]);
export const AskSchema = z.object({
  agent: z.string().trim().min(1).max(200),
  task: z.string().trim().min(1).max(8000),
  timeoutMs: z.number().int().min(1000).max(maximumAskTimeoutMs).optional(),
}).strict();

export class RemoteAgents {
  private readonly rates = new RateLimiter();
  constructor(
    readonly store: Store,
    private readonly owner: string,
    private readonly policy: NetworkPolicy,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
  ) {}

  private guarded(): typeof fetch { return this.policy.guard(this.fetchImpl); }

  list(): RemoteAgent[] {
    return this.store.list("settings", this.owner)
      .filter((record) => record.id.startsWith("remote-agent:"))
      .flatMap((record) => { const parsed = RemoteAgentSchema.safeParse(record.data); return parsed.success ? [parsed.data] : []; })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Finds an assistant by its id or by its name, so a person can say "ask Ada". */
  find(reference: string): RemoteAgent {
    const wanted = reference.trim().toLowerCase();
    const match = this.list().find((agent) => agent.id === reference || agent.name.toLowerCase() === wanted);
    if (!match) throw new Error(`No outside assistant called "${reference}" has been added`);
    return match;
  }

  /** Reads another assistant's card and saves it, so the owner can see what they are adding. */
  async add(input: unknown): Promise<RemoteAgent> {
    const parsed = RemoteActionSchema.parse({ action: "add", ...(input as object) });
    if (parsed.action !== "add") throw new Error("Not an add");
    const cardUrl = new URL(parsed.cardUrl.includes("/.well-known/") ? parsed.cardUrl : new URL(cardPath, parsed.cardUrl).href);
    const card = await this.readCard(cardUrl.href, parsed.key);
    const agent: RemoteAgent = {
      id: randomUUID(), name: card.name, description: card.description, cardUrl: cardUrl.href,
      url: card.url, skills: card.skills.map((skill) => String(skill.name ?? skill.id)).slice(0, 100),
      ...(parsed.key ? { key: parsed.key } : {}), ...(plainLine(card.provider?.organization) ? { provider: plainLine(card.provider?.organization) } : {}),
      addedAt: new Date().toISOString(),
    };
    this.store.save("settings", this.owner, recordId(agent.id), { ...agent });
    return agent;
  }

  /** Fetches and checks one card. Every hop goes through the owner's address rules. */
  private async readCard(cardUrl: string, key?: string): Promise<z.infer<typeof CardSchema>> {
    const response = await this.guarded()(cardUrl, {
      headers: { accept: "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) { await response.body?.cancel().catch(() => undefined); throw new Error(`${cardUrl} answered ${response.status}; that assistant may not be sharing itself`); }
    return CardSchema.parse(parseJson(await readCapped(response, maxCardBytes)));
  }

  remove(reference: string): { removed: boolean; name: string } {
    const agent = this.find(reference);
    return { removed: this.store.delete("settings", this.owner, recordId(agent.id)), name: agent.name };
  }

  /**
   * Hands one piece of work to an outside assistant and waits for its answer. Only the words of the
   * task are sent. The wait is bounded, and so is how often one assistant can be asked.
   */
  /**
   * The `traceparent` of the task doing the asking, so the work the other assistant does shows up
   * inside the same trace. `createBranch` connects this; on its own it sends no such header.
   */
  traceparentFor: (runId: string) => string | null = () => null;
  async ask(input: unknown, signal?: AbortSignal, runId?: string): Promise<{ agent: string; state: string; answer: string; taskId: string }> {
    const { agent: reference, task, timeoutMs } = AskSchema.parse(input);
    const agent = this.find(reference);
    const key = keyHeader(agent, agent.name);
    const wait = this.rates.waitMs(agent.id, askesPerMinute);
    if (wait > 0) throw new Error(`${agent.name} has already been asked ${askesPerMinute} times this minute; wait a moment.`);
    this.rates.record(agent.id);
    const taskId = randomUUID();
    const body = { jsonrpc: "2.0", id: taskId, method: "tasks/send",
      params: { id: taskId, message: { role: "user", parts: [{ type: "text", text: task }] } } };
    const limit = AbortSignal.timeout(timeoutMs ?? defaultAskTimeoutMs);
    const traceparent = runId ? this.traceparentFor(runId) : null;
    const response = await this.guarded()(agent.url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json",
        ...(traceparent ? { traceparent } : {}), ...key },
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, limit]) : limit,
    });
    return { agent: agent.name, taskId, ...readAnswer(await response.json()) };
  }

  /** a2a-rooms: one assistant by its exact id; a room never picks one by a name another card could copy. */
  byId(id: string): RemoteAgent | undefined {
    return this.list().find((agent) => agent.id === id);
  }

  /** a2a-rooms: how long a room waits for an assistant's answer, and how much of it is read. */
  readonly roomLimits = { timeoutMs: roomTimeoutMs, maxBytes: roomAnswerBytes };
  /** a2a-rooms: when each assistant's card last answered, kept in memory only. */
  private readonly cardSeen = new Map<string, { at: number; askedAt: number }>();
  /** True when the assistant's card answered within the last five minutes. */
  online(id: string, now = Date.now()): boolean {
    const seen = this.cardSeen.get(id)?.at ?? 0;
    return seen > 0 && now - seen < onlineMs;
  }
  /**
   * Reads the assistant's card again, at most once a minute and never waited on, so a room can show
   * whether it is there. Same address rules as every other request; a failure only leaves it offline.
   */
  probe(id: string, now = Date.now()): void {
    const agent = this.byId(id), mark = this.cardSeen.get(id) ?? { at: 0, askedAt: 0 };
    if (!agent || now - mark.askedAt < probeEveryMs) return;
    mark.askedAt = now;
    this.cardSeen.set(id, mark);
    this.readCard(agent.cardUrl, agent.key).then(() => { mark.at = Date.now(); }, () => { mark.at = 0; });
  }

  /**
   * a2a-rooms: one turn in a room. The words the room would give a Trunk go out as an A2A
   * `message/send` (or `tasks/send` to an assistant that only knows the older method, as Branch
   * does), through the owner's address rules with every connection held to the checked addresses,
   * no redirect followed, a time limit and a cap on how much is read back. Only text comes back.
   */
  async converse(id: string, text: string, options: ConverseOptions = {}): Promise<{ answer: string; state: string; contextId?: string }> {
    const agent = this.byId(id);
    if (!agent) throw new Error("it is no longer among your outside agents");
    if (this.rates.waitMs(agent.id, askesPerMinute) > 0) throw new Error(`it has already been asked ${askesPerMinute} times this minute`);
    this.rates.record(agent.id);
    const timeoutMs = options.timeoutMs ?? this.roomLimits.timeoutMs, maxBytes = options.maxBytes ?? this.roomLimits.maxBytes, limit = AbortSignal.timeout(timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, limit]) : limit;
    const context = options.contextId ? { contextId: options.contextId } : {};
    try {
      let payload = await this.rpc(agent, "message/send",
        { message: { kind: "message", role: "user", messageId: randomUUID(), parts: [{ kind: "text", text }], ...context } }, signal, maxBytes);
      if ((payload as { error?: { code?: unknown } }).error?.code === -32601)
        payload = await this.rpc(agent, "tasks/send", { id: randomUUID(), ...(options.contextId ? { sessionId: options.contextId } : {}),
          message: { role: "user", parts: [{ type: "text", text }] } }, signal, maxBytes);
      const read = readAnswer(payload), contextId = contextOf(payload);
      return { ...read, ...(contextId ? { contextId } : {}) };
    } catch (error) {
      if (limit.aborted && !options.signal?.aborted) throw new Error(`it did not answer within ${Number((timeoutMs / 1000).toFixed(1))} seconds`);
      throw error;
    }
  }

  private async rpc(agent: RemoteAgent, method: string, params: unknown, signal: AbortSignal, maxBytes: number): Promise<unknown> {
    const response = await this.guarded()(agent.url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", ...keyHeader(agent, "it") },
      body: JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), method, params }),
      signal,
    });
    if (!response.ok) { await response.body?.cancel().catch(() => undefined); throw new Error(`it answered ${response.status}`); }
    return parseJson(await readCapped(response, maxBytes));
  }

  /**
   * Looks for other assistants on addresses the owner types in, one by one. Nothing is scanned or
   * broadcast: only the exact addresses given are asked for their card.
   */
  async discover(targets: string[]): Promise<{ found: unknown[]; refused: { target: string; reason: string }[] }> {
    const found: unknown[] = [], refused: { target: string; reason: string }[] = [];
    for (const target of targets.slice(0, 20)) {
      try {
        const base = /^https?:\/\//.test(target) ? target : `http://${target}`;
        const cardUrl = new URL(cardPath, base).href;
        const card = await this.readCard(cardUrl);
        found.push({ target, cardUrl, name: card.name, description: card.description, url: card.url });
      } catch (error) {
        refused.push({ target, reason: errorText(error) });
      }
    }
    return { found, refused };
  }

  /**
   * A link the owner can hand to another Branch install so the two can add each other. It carries
   * this install's card address and a pairing key (SessionTokens.createPairingKey) that reaches only the
   * A2A door and runs out; it is still a secret, so share it like one.
   */
  pairing(base: string, key: string): { code: string; cardUrl: string; shareUrl: string } {
    const saved = this.store.get("settings", this.owner, "remote-agent-pairing")?.data as { code?: string } | undefined;
    const code = typeof saved?.code === "string" && /^[0-9a-f]{12}$/.test(saved.code) ? saved.code : randomBytes(6).toString("hex");
    this.store.save("settings", this.owner, "remote-agent-pairing", { code, createdAt: new Date().toISOString() });
    const cardUrl = `${base}${cardPath}`;
    return { code, cardUrl, shareUrl: `branch://add-agent?card=${encodeURIComponent(cardUrl)}&key=${encodeURIComponent(key)}&code=${code}` };
  }

  /** Adds an assistant from a link another install shared, rather than typing the parts out. */
  async pair(link: string): Promise<RemoteAgent> {
    const url = new URL(z.string().trim().min(1).max(4000).parse(link));
    if (url.protocol !== "branch:") throw new Error("That is not a Branch pairing link");
    const cardUrl = url.searchParams.get("card"), key = url.searchParams.get("key") ?? undefined;
    if (!cardUrl) throw new Error("That pairing link does not say where the other assistant is");
    return this.add({ cardUrl, ...(key ? { key } : {}) });
  }
}

type Part = { type?: string; kind?: string; text?: string };
/**
 * Pulls the plain answer out of the other assistant's reply, whatever shape it sent back: a task
 * (its artifacts, else its status message) or, from `message/send`, a message of its own. Only
 * text parts are read, whether they name their kind as `type` (older A2A) or `kind`.
 */
export function readAnswer(payload: unknown): { state: string; answer: string } {
  const body = payload as { error?: { message?: string }; result?: { kind?: string; parts?: Part[]; status?: { state?: string; message?: { parts?: Part[] } }; artifacts?: { parts?: Part[] }[] } };
  if (body?.error) throw new Error(typeof body.error.message === "string" ? body.error.message : "The other assistant refused the task");
  const result = body?.result;
  if (!result || typeof result !== "object") throw new Error("The other assistant sent an answer Branch could not read");
  const message = result.kind === "message" || (Array.isArray(result.parts) && !result.status);
  const fromArtifacts = Array.isArray(result.artifacts) ? result.artifacts.flatMap((artifact) => (Array.isArray(artifact?.parts) ? artifact.parts : [])) : [];
  const parts = message ? result.parts ?? [] : fromArtifacts.length ? fromArtifacts : result.status?.message?.parts ?? [];
  const answer = (Array.isArray(parts) ? parts : []).filter((part) => (part?.type ?? part?.kind) === "text" && typeof part.text === "string")
    .map((part) => part.text!).join("\n").trim();
  return { state: message ? "completed" : typeof result.status?.state === "string" ? result.status.state : "unknown", answer };
}

/** a2a-rooms: the conversation the other assistant keeps for this room, when it names one. */
function contextOf(payload: unknown): string | undefined {
  const result = (payload as { result?: { contextId?: unknown; sessionId?: unknown } })?.result;
  const id = result?.contextId ?? result?.sessionId;
  return typeof id === "string" && /^[\w.:-]{1,200}$/.test(id) ? id : undefined;
}

export interface ConverseOptions { signal?: AbortSignal; timeoutMs?: number; maxBytes?: number; contextId?: string }
/** a2a-rooms: how long a room waits for an outside agent, and how much of its answer is read. */
export const roomTimeoutMs = 45000;
export const roomAnswerBytes = 256 * 1024;
const maxCardBytes = 64 * 1024;
const onlineMs = 5 * 60000, probeEveryMs = 60000;

/** A card's words on one line: no control characters, at most 60 characters. */
export function plainLine(value: unknown): string {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 60) : "";
}

/** Reads at most `maxBytes` of an answer; past that the connection is closed and nothing is kept. */
export async function readCapped(response: Response, maxBytes: number): Promise<string> {
  const tooLong = () => new Error(`its answer was longer than ${Math.round(maxBytes / 1024)} KB`);
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) { await response.body?.cancel().catch(() => undefined); throw tooLong(); }
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) { await reader.cancel().catch(() => undefined); throw tooLong(); }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseJson(text: string): unknown {
  try { return JSON.parse(text) as unknown; } catch { throw new Error("it sent an answer Branch could not read"); }
}

/** The two tools: keeping the list of outside assistants, and handing one of them a piece of work. */
export function registerRemoteAgents(registry: ToolRegistry, agents: RemoteAgents): void {
  registry.register<z.infer<typeof RemoteActionSchema>>({
    name: "agents.remote", permission: "agents.manage",
    description: "Add, list or remove an assistant elsewhere that this one may hand work to. Adding one reads its card at the address given.",
    parameters: RemoteActionSchema,
    execute: async (args, context) => {
      if (args.action === "list") return { agents: agents.list().map(({ key: _key, ...rest }) => rest) };
      if (startedFromChat(context, agents.store)) throw chatOwnerOnly("Changing the list of other assistants");
      if (args.action === "remove") return agents.remove(args.agent);
      const { key: _key, ...added } = await agents.add(args);
      return added;
    },
  });
  registry.register<z.infer<typeof AskSchema>>({
    name: "agents.ask", permission: "agents.ask",
    description: "Hand one piece of work to an assistant elsewhere and wait for its answer. Only the words of the task are sent: no files, no secrets, nothing this assistant has read.",
    parameters: AskSchema,
    execute: async (args, context) => askWithBudget(agents, args, context),
    target: (args) => args.agent,
  });
}

/** The answer counts against the task's own allowance, so a remote assistant cannot run it dry. */
async function askWithBudget(agents: RemoteAgents, args: z.infer<typeof AskSchema>, context: ToolContext): Promise<unknown> {
  const result = await agents.ask(args, context.signal, context.runId);
  chargeAnswer(context.budget, result.answer);
  return result;
}
const chargeAnswer = (budget: Budget, answer: string): void => budget.charge(Math.ceil(answer.length / 4));
