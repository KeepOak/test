import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { audit, auditSources, type AuditSource } from "./audit.js";
import type { CommandContext } from "./channels/chat-commands.js";
import { errorText } from "./contracts.js";
import { startedWithShortLivedKey } from "./key-context.js";
import { prepareToolName, type SelfDevelopmentContract } from "./self-development-contract.js";
import { PrepareSourceChangeSchema, prepareBranchSourceChange, type SelfDevelopmentDeps } from "./self-development.js";
import { boundedDiff, nothingPreparedYet, type BoundedDiff } from "./self-development-diff.js";
import { HttpError } from "./server-http.js";
import { currentTaskRun } from "./task-scope.js";

/**
 * A change to Branch itself, asked for from a chat app.
 *
 * A chat app cannot prove who is typing, so from a chat Branch's own source can only be asked about:
 * `/improve <what to change>` files a request that holds the words exactly as they were sent, and who
 * sent them, from which app and chat, read from the message itself. Filing never approves anything,
 * never writes or widens a contract, and never runs anything: no task, no Git.
 *
 * Only the owner answers, in the Branch app, through the owner-only routes below. A yes is the owner's
 * own contract creation: the terms the owner writes are prepared exactly as `branch.prepare_source_change`
 * prepares them (`prepareBranchSourceChange`, unchanged), which writes them through `ContractBook` before
 * anything is made and makes the worktree at the contract's commit. From there the contract, its
 * widening rule and the checked publish are the ones every self-development change has. A yes is refused
 * while that tool is not offered (sending Git work to a remote is off). A no closes the request.
 *
 * The requests live in a table of their own that no backup carries, so a restored file cannot plant one.
 */
export interface RequestSender { channel: string; chatId: string; senderId: string; senderName: string; messageId: string }
export type RequestStatus = "waiting" | "preparing" | "approved" | "declined";
export interface SourceChangeRequest {
  id: string;
  /** The words that followed the command, exactly as they were sent. */
  text: string;
  from: RequestSender;
  status: RequestStatus;
  at: string;
  answeredAt: string | null;
  /** After a yes: the worktree it was prepared in, and the contract revision and commit written for it. */
  worktree: string | null;
  revision: number | null;
  sourceSha: string | null;
  /** Why the owner's last yes did not go through; the request is then still waiting. */
  problem: string | null;
}
interface Answer { at?: string; worktree?: string; revision?: number; sourceSha?: string; problem?: string }

/** At most this many wait for the owner at once; a new one past it is refused, never queued. */
export const maxWaitingRequests = 20;
/** A longer request is refused, never cut, so what the owner reads is what was sent. */
export const maxRequestLength = 4000;
const prepareTimeoutMs = 420_000;
const answering = "Answering a request to change Branch itself";
const SenderSchema = z.object({
  channel: z.string().min(1).max(64), chatId: z.string().min(1).max(200), senderId: z.string().min(1).max(200),
  senderName: z.string().max(120), messageId: z.string().min(1).max(200),
}).strict();

function ensureRequestTable(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS self_development_requests(id TEXT PRIMARY KEY, owner TEXT NOT NULL,
    text TEXT NOT NULL, sender TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, answer TEXT)`);
}

function fromRow(row: Record<string, unknown>): SourceChangeRequest {
  const answer = (row.answer ? JSON.parse(String(row.answer)) : {}) as Answer;
  return {
    id: String(row.id), text: String(row.text), from: JSON.parse(String(row.sender)) as RequestSender,
    status: String(row.status) as RequestStatus, at: String(row.created_at), answeredAt: answer.at ?? null,
    worktree: answer.worktree ?? null, revision: answer.revision ?? null, sourceSha: answer.sourceSha ?? null, problem: answer.problem ?? null,
  };
}

/** Where the record says the request came from: the chat app by name where the record knows it. */
const sourceOf = (channel: string): AuditSource =>
  ((auditSources as readonly string[]).includes(channel) ? channel : "channel") as AuditSource;

export class SourceChangeRequests {
  private readonly db: DatabaseSync;

  constructor(private readonly deps: SelfDevelopmentDeps) {
    this.db = deps.store.sqlite;
    ensureRequestTable(this.db);
    // A yes Branch was still preparing when it stopped waits for the owner again.
    this.db.prepare("UPDATE self_development_requests SET status='waiting', answer=? WHERE status='preparing'")
      .run(JSON.stringify({ problem: "Branch stopped while preparing this; answer it again." } satisfies Answer));
  }

  /** A chat files a request. Nothing else happens: no contract, no Git, no task. */
  file(input: { text: string; from: RequestSender }): SourceChangeRequest {
    if (startedWithShortLivedKey() || currentTaskRun())
      throw new Error("A request to change Branch is filed from a chat message itself, never by a key or a task.");
    const from = SenderSchema.parse({ ...input.from, senderName: input.from.senderName.slice(0, 120) });
    if (!input.text.trim()) throw new Error("Say what you would like changed in Branch.");
    if (input.text.length > maxRequestLength)
      throw new Error(`That request is longer than ${maxRequestLength} characters, so nothing was filed. Send a shorter one.`);
    if (this.waitingCount() >= maxWaitingRequests)
      throw new Error(`There are already ${maxWaitingRequests} requests to change Branch waiting for the owner, so nothing was filed. Wait for an answer first.`);
    const id = randomUUID();
    this.db.prepare("INSERT INTO self_development_requests(id, owner, text, sender, status, created_at, answer) VALUES(?,?,?,?,?,?,NULL)")
      .run(id, this.deps.owner, input.text, JSON.stringify(from), "waiting", new Date().toISOString());
    // Named by the chat app's own id for the sender, never by the name they chose, which could read as anybody.
    audit(this.deps.store, this.deps.owner, { action: "self_development.request", actor: `sender ${from.senderId} on ${from.channel}`.slice(0, 120),
      subject: `request ${id}`, reason: "Asked from a chat for a change to Branch itself; only the owner answers, in the Branch app",
      source: sourceOf(from.channel), origin: "channel", outcome: "requested" });
    return this.get(id)!;
  }

  /** Every request, newest first. The owner's alone. */
  list(): SourceChangeRequest[] {
    this.ownerHere("Reading the requests to change Branch itself");
    return this.db.prepare("SELECT * FROM self_development_requests WHERE owner=? ORDER BY rowid DESC LIMIT 100")
      .all(this.deps.owner).map((row) => fromRow(row as Record<string, unknown>));
  }

  /**
   * The owner's yes, with the terms the owner wrote: checked with the tool's own parameters, then
   * prepared exactly as the tool prepares them. The request is taken before any Git runs, so two yeses
   * never prepare twice; a yes that fails puts it back to wait, with the reason.
   */
  async approve(id: string, input: unknown, signal: AbortSignal = AbortSignal.timeout(prepareTimeoutMs)): Promise<{ request: SourceChangeRequest; prepared: Record<string, unknown> }> {
    this.ownerHere(answering);
    const ask = PrepareSourceChangeSchema.parse(input);
    if (!this.deps.registry.names().includes(prepareToolName))
      throw new Error("Sending Git work to a remote is switched off, so Branch's own source cannot be prepared. The request is still waiting.");
    this.take(id);
    try {
      const prepared = await prepareBranchSourceChange(this.deps, ask, signal);
      const contract = prepared.contract as SelfDevelopmentContract;
      this.settle(id, "approved", { at: new Date().toISOString(), worktree: contract.worktreePath, revision: contract.revision, sourceSha: contract.sourceSha });
      this.record(id, `${contract.worktreePath} revision ${contract.revision}`, "approved");
      return { request: this.get(id)!, prepared };
    } catch (error) {
      this.settle(id, "waiting", { problem: errorText(error).slice(0, 500) });
      throw error;
    }
  }

  /**
   * What the change has done so far, as a bounded diff, for the owner to read before saying yes to it.
   * Before the owner's yes nothing has been prepared, so there is nothing to show, and it says so.
   */
  async diff(id: string, signal: AbortSignal = AbortSignal.timeout(60_000)): Promise<BoundedDiff> {
    this.ownerHere("Reading a change to Branch itself");
    const request = this.get(id);
    if (!request) throw new Error("There is no request to change Branch with that id.");
    const contract = request.worktree ? this.deps.contracts.current(this.deps.owner, request.worktree) : null;
    if (!contract) return { files: [], untracked: [], outside: [], truncated: false, allowedPaths: [], note: nothingPreparedYet, warning: null };
    return boundedDiff(this.deps, contract, signal);
  }

  /** The owner's no: the request is closed and can never be approved afterwards. */
  decline(id: string): SourceChangeRequest {
    this.ownerHere(answering);
    const changed = this.db.prepare("UPDATE self_development_requests SET status='declined', answer=? WHERE id=? AND owner=? AND status='waiting'")
      .run(JSON.stringify({ at: new Date().toISOString() } satisfies Answer), id, this.deps.owner).changes;
    if (Number(changed) !== 1) throw new Error("That request is not waiting for an answer.");
    this.record(id, "", "declined");
    return this.get(id)!;
  }

  /** Only the owner, in the Branch app: never a household person, a short-lived key, or anything inside a task. */
  private ownerHere(what: string): void {
    this.deps.store.profiles.requireOwner(what);
    if (startedWithShortLivedKey()) throw new Error(`${what} is the owner's own, in the Branch app; a short-lived key cannot do it.`);
    if (currentTaskRun()) throw new Error(`${what} is the owner's own, in the Branch app; a task cannot do it, whoever started it.`);
  }
  private get(id: string): SourceChangeRequest | undefined {
    const row = this.db.prepare("SELECT * FROM self_development_requests WHERE id=? AND owner=?").get(id, this.deps.owner);
    return row ? fromRow(row as Record<string, unknown>) : undefined;
  }
  private waitingCount(): number {
    const row = this.db.prepare("SELECT count(*) AS n FROM self_development_requests WHERE owner=? AND status IN ('waiting','preparing')")
      .get(this.deps.owner) as { n: number | bigint };
    return Number(row.n);
  }
  private take(id: string): void {
    const changed = this.db.prepare("UPDATE self_development_requests SET status='preparing' WHERE id=? AND owner=? AND status='waiting'")
      .run(id, this.deps.owner).changes;
    if (Number(changed) !== 1) throw new Error("That request is not waiting for an answer.");
  }
  private settle(id: string, status: RequestStatus, answer: Answer): void {
    this.db.prepare("UPDATE self_development_requests SET status=?, answer=? WHERE id=? AND owner=?")
      .run(status, JSON.stringify(answer), id, this.deps.owner);
  }
  private record(id: string, what: string, outcome: "approved" | "declined"): void {
    audit(this.deps.store, this.deps.owner, { action: "self_development.request", actor: this.deps.owner,
      subject: `request ${id}${what ? `: ${what}` : ""}`.slice(0, 300), reason: `You ${outcome} a chat's request to change Branch itself`,
      source: "owner", outcome });
  }
}

const byRuntime = new WeakMap<object, SourceChangeRequests>();
/** Lets the chat command reach this app's requests (as src/flows-boards/index.ts does for its commands). */
export function offerSourceRequests(runtime: object, requests: SourceChangeRequests): void {
  byRuntime.set(runtime, requests);
}

/** `/improve <what to change>` in a chat app: files a request, and says only the owner answers it. */
export function improveCommand(argument: string, context: CommandContext): string {
  const requests = byRuntime.get(context.runtime);
  if (!requests) return "Asking for a change to Branch itself is not part of this copy.";
  if (!argument) return "Say what you would like changed in Branch itself, for example: /improve remove the Export button. Only the owner answers, in the Branch app.";
  if (/^(approve|decline)(\s+\S+)?$/i.test(argument))
    return "Only the owner answers a request to change Branch, in the Branch app. From a chat you can only ask.";
  if (!context.from) return "A request to change Branch is filed from a chat message.";
  try {
    requests.file({ text: argument, from: { channel: context.channel, chatId: context.chatId, ...context.from } });
  } catch (error) {
    return errorText(error);
  }
  return "Asked. Only the owner can answer, in the Branch app, and nothing about Branch changes until they do.";
}

const answerRoute = /^\/api\/self-development\/requests\/([a-f0-9-]{36})\/(approve|decline)$/;
const diffRoute = /^\/api\/self-development\/requests\/([a-f0-9-]{36})\/diff$/;
export const handlesSourceRequestPath = (path: string): boolean =>
  path === "/api/self-development/requests" || answerRoute.test(path) || diffRoute.test(path);

/**
 * The owner's routes: the list, a yes with the terms, and a no. The server refuses short-lived keys and
 * household persons before these run (src/short-lived-keys.ts, src/household-routes.ts), and each
 * answer checks again.
 */
export async function sourceRequestsApi(requests: SourceChangeRequests, method: string, path: string, readBody: () => Promise<unknown>): Promise<unknown> {
  const diff = diffRoute.exec(path);
  if (diff) {
    if (method !== "GET") throw new HttpError(405, "Use GET here.");
    return requests.diff(diff[1]!);
  }
  const answer = answerRoute.exec(path);
  if (!answer) {
    if (method !== "GET") throw new HttpError(405, "Use GET here.");
    return { requests: requests.list() };
  }
  if (method !== "POST") throw new HttpError(405, "Use POST here.");
  if (answer[2] === "decline") return { request: requests.decline(answer[1]!) };
  return requests.approve(answer[1]!, await readBody());
}
