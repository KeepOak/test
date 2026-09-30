import { createHash, randomBytes } from "node:crypto";
import type { Completion, CompletionRequest, Message } from "../contracts.js";
import { currentAccountCall } from "../accounts/context.js";
import { nativeHistory, nativeGeneration, boundedNativeJson, type NativeInventory, type NativeFrame } from "./claude-subscription-history.js";

const digest = (value: unknown): string => createHash("sha256").update(boundedNativeJson(value)).digest("hex");
const normalized = (message: Message) => ({ role: message.role, content: message.content,
  toolCalls: message.toolCalls ?? [], toolCallId: message.toolCallId ?? null, images: message.images ?? [] });
export const nativeTurnMarker = (): string => `BRANCH_TRANSPORT_TURN_${randomBytes(32).toString("hex")}`;

/** Native's inert outcomes and transport trigger are never authoritative conversation history. */
export function canonicalNativePayload(payload: Buffer, request: CompletionRequest, inventory: NativeInventory, marker: string): Buffer {
  let body: Record<string, unknown>;
  try { body = JSON.parse(payload.toString("utf8")); } catch { throw new Error("Claude subscription native payload is unreadable"); }
  if (!body || typeof body !== "object" || Array.isArray(body) || !Array.isArray(body.messages) || body.stream !== true)
    throw new Error("Claude subscription native payload has no streaming conversation");
  const newest = [...body.messages].reverse().find((row: Record<string, unknown>) => row?.role === "user");
  const blocks = Array.isArray(newest?.content) ? newest.content : [{ type: "text", text: newest?.content }];
  if (!marker || !blocks.some((block: Record<string, unknown>) => block?.type === "text" && typeof block.text === "string" && block.text.includes(marker)))
    throw new Error("Claude subscription native request belongs to another turn");
  const generation = nativeGeneration(request, inventory);
  body.messages = nativeHistory(request).frames.map((frame) => frame.message);
  body.tools = generation.tools; body.max_tokens = generation.max_tokens;
  if (generation.output_config) body.output_config = generation.output_config; else delete body.output_config;
  return Buffer.from(boundedNativeJson(body), "utf8");
}

export function nativeTrigger(marker: string): NativeFrame {
  return { type: "user", message: { role: "user", content: [{ type: "text", text: marker }] } };
}
type Identity = { key: string; signature: string; messages: string[] };
function identity(request: CompletionRequest): Identity | null {
  const call = currentAccountCall();
  if (!call?.owner || !call.sessionId) return null;
  return { key: digest([call.owner, call.sessionId]),
    signature: digest([request.messages.filter((message) => message.role === "system"), request.tools,
      request.maxTokens, request.reasoning ?? null, request.responseFormat ?? null, call.trunk ?? null]),
    messages: request.messages.map((message) => digest(normalized(message))) };
}
type Entry<T> = { value: T; signature: string; messages: string[]; busy: boolean; at: number; born: number; turns: number };
/** `released` settles once a replaced transport of the same conversation is gone, so its private folder is free again. */
export type NativeLease<T> = { entry: Entry<T> | null; value: T | null; identity: Identity | null; continued: boolean; epoch: number; released: Promise<void> };
const none = Promise.resolve();
const caches = new Set<{ close(): void }>();
/** Owned native transports are closed by the same app lifecycle as other spare agent processes. */
export function closeNativeSubscriptions(): void { for (const cache of caches) cache.close(); }

/** Exact-prefix continuations only; provider instances already bind one owner/account/model. */
export class NativeContinuations<T> {
  private readonly entries = new Map<string, Entry<T>>();
  private epoch = 0;
  constructor(private readonly alive: (value: T) => boolean, private readonly dispose: (value: T) => Promise<void>) {}
  lease(request: CompletionRequest): NativeLease<T> {
    this.prune(); const scope = identity(request);
    caches.add(this);
    if (!scope) return { entry: null, value: null, identity: null, continued: false, epoch: this.epoch, released: none };
    const existing = this.entries.get(scope.key);
    if (existing?.busy) return { entry: null, value: null, identity: null, continued: false, epoch: this.epoch, released: none };
    if (existing && existing.signature === scope.signature && scope.messages.length > existing.messages.length
        && existing.messages.every((message, at) => message === scope.messages[at])) {
      existing.busy = true;
      return { entry: existing, value: existing.value, identity: scope, continued: true, epoch: this.epoch, released: none };
    }
    const released = existing ? this.drop(scope.key, existing) : none;
    if (this.entries.size >= 8) return { entry: null, value: null, identity: null, continued: false, epoch: this.epoch, released };
    return { entry: null, value: null, identity: scope, continued: false, epoch: this.epoch, released };
  }
  finish(lease: NativeLease<T>, value: T, completion: Completion): boolean {
    const scope = lease.identity;
    if (!scope || !this.alive(value) || lease.epoch !== this.epoch
        || (!lease.entry && this.entries.size >= 8) || (this.entries.has(scope.key) && this.entries.get(scope.key) !== lease.entry)) return false;
    const entry = lease.entry ?? { value, signature: scope.signature, messages: [], busy: true, at: Date.now(), born: Date.now(), turns: 0 };
    entry.messages = [...scope.messages, digest(normalized({ role: "assistant", content: completion.content, toolCalls: completion.toolCalls }))];
    entry.busy = false; entry.at = Date.now(); entry.turns += 1;
    this.entries.set(scope.key, entry); caches.add(this);
    setTimeout(() => this.prune(), 120001).unref();
    return true;
  }
  fail(lease: NativeLease<T>): void {
    if (lease.entry && lease.identity) void this.drop(lease.identity.key, lease.entry);
    if (!this.entries.size) caches.delete(this);
  }
  private prune(): void {
    for (const [key, entry] of this.entries)
      if (!entry.busy && (!this.alive(entry.value) || Date.now() - entry.at >= 120000 || Date.now() - entry.born >= 600000 || entry.turns >= 64)) void this.drop(key, entry);
    if (!this.entries.size) caches.delete(this);
  }
  private drop(key: string, entry: Entry<T>): Promise<void> {
    if (this.entries.get(key) !== entry) return none;
    this.entries.delete(key);
    return this.dispose(entry.value).catch(() => undefined);
  }
  close(): void {
    this.epoch += 1;
    for (const [key, entry] of this.entries) void this.drop(key, entry);
    caches.delete(this);
  }
}
