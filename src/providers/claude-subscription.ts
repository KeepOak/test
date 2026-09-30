import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join, isAbsolute, resolve, dirname, basename } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { runAsNode } from "../child-env.js";
import type { Completion, CompletionRequest, Provider } from "../contracts.js";
import { currentAccountCall, refuseSignInForTrunk } from "../accounts/context.js";
import { strippedEnvironment, ProgramLimitError, claudeDefaultModel, type AccountHome } from "./cli-agent.js";
import { NativeAdmission, type NativeConnector } from "./claude-subscription-admission.js";
import { ProviderHttpError } from "../provider-retry.js";
import { isOutOfRoomThinking } from "../provider-stream.js";
import { NativeProcess, type NativeInvocation, type NativeSpawn, type NativeEvent } from "./claude-subscription-process.js";
import { boundedNativeJson, nativeGeneration, nativeHistory, nativeInventory, type NativeFrame } from "./claude-subscription-history.js";

export interface ClaudeSubscriptionOptions { owner: string; model?: string; accountHome?: AccountHome; command?: string; timeoutMs?: number }
/** Injection is confined to explicit in-process protocol fixtures, never persisted account or model settings. */
export interface ClaudeSubscriptionDependencies { spawn?: NativeSpawn; connect?: NativeConnector }
function authorized(owner: string): void {
  refuseSignInForTrunk();
  if (currentAccountCall()?.owner !== owner) throw new Error("Claude subscription requires this account owner's model-call context");
}
function nativeEnvironment(home: AccountHome | undefined, relay: string, maxTokens: number): NodeJS.ProcessEnv {
  return { ...strippedEnvironment(), ...(home ? { [home.name]: home.path } : {}), ANTHROPIC_BASE_URL: relay,
    ENABLE_TOOL_SEARCH: "false", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", CLAUDE_CODE_MAX_RETRIES: "0",
    DISABLE_AUTO_COMPACT: "1", DISABLE_COMPACT: "1", CLAUDE_CODE_TOTAL_TOKENS_REMINDER: "off",
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(maxTokens) };
}
async function invocation(root: string, options: Readonly<ClaudeSubscriptionOptions>, request: CompletionRequest,
  relay: NativeAdmission): Promise<{ invocation: NativeInvocation; frames: NativeFrame[] }> {
  const inventory = nativeInventory(request.tools), history = nativeHistory(request), body = nativeGeneration(request, inventory);
  await Promise.all([
    writeFile(join(root, "tools.json"), boundedNativeJson(inventory.manifest), { mode: 0o600 }),
    writeFile(join(root, "system.md"), history.system, { mode: 0o600 }),
    writeFile(join(root, "settings.json"), boundedNativeJson({ disableAllHooks: true, env: { CLAUDE_CODE_EXTRA_BODY: boundedNativeJson(body) } }), { mode: 0o600 }),
  ]);
  const mcp = { mcpServers: { branch: { command: process.execPath,
    args: [fileURLToPath(new URL("./claude-subscription-inert.cjs", import.meta.url)), join(root, "tools.json")],
    env: runAsNode(process.execPath) } } };
  const args = ["-p", "--model", options.model ?? claudeDefaultModel, "--input-format", "stream-json", "--output-format", "stream-json",
    "--verbose", "--include-partial-messages", "--tools", "", "--system-prompt-file", join(root, "system.md"), "--settings", join(root, "settings.json"),
    "--setting-sources", "", "--strict-mcp-config", "--disable-slash-commands", "--max-turns", "1", "--permission-mode", "dontAsk",
    "--no-session-persistence", "--mcp-config", JSON.stringify(mcp), ...(request.reasoning ? ["--effort", request.reasoning] : [])];
  return { invocation: { command: options.command ?? "claude", args,
    env: nativeEnvironment(options.accountHome, relay.url, request.maxTokens), cwd: root }, frames: history.frames };
}
async function replay(native: NativeProcess, frames: NativeFrame[], signal: AbortSignal, authorize: () => void): Promise<void> {
  for (const frame of frames) {
    authorize(); await native.send(frame, signal);
    if (frame.shouldQuery !== false) continue;
    let ack: NativeEvent | null;
    do {
      ack = await native.receive(signal);
      if (!ack) throw new Error("Claude subscription exited before acknowledging historical replay");
    } while (ack.type !== "result");
    if (ack.num_turns !== 0 || ack.is_error) throw new Error("Claude Code does not support safe zero-turn history replay");
  }
  native.child.stdin.end();
}
async function nativeResult(native: NativeProcess, signal: AbortSignal): Promise<{ event: NativeEvent; code: number | null; authenticationFailed: boolean }> {
  const results: NativeEvent[] = [];
  let authenticationFailed = false;
  let event: NativeEvent | null;
  while ((event = await native.receive(signal))) {
    if (event.type === "result") results.push(event);
    if (event.error === "authentication_failed") authenticationFailed = true;
  }
  const code = await native.closed; signal.throwIfAborted();
  if (results.length !== 1) throw new Error("Claude subscription native response is incomplete");
  return { event: results[0]!, code, authenticationFailed };
}
function completed(relay: NativeAdmission, result: { event: NativeEvent; code: number | null; authenticationFailed: boolean }): Completion {
  if (relay.status === 429) {
    const until = relay.resetsAt ? ` until about ${relay.resetsAt.toISOString().slice(0, 16).replace("T", " ")} UTC` : "";
    throw new ProgramLimitError(`Claude subscription has reached its plan limit${until}; wait or choose another account`);
  }
  if (relay.status === 401 || relay.status === 403 || result.authenticationFailed) throw new Error("Claude subscription could not use its saved sign-in; open Settings → Accounts and sign in again");
  // selfdev: a busy or failing service (5xx, 529 overloaded) is tried again like any other provider's; the status is named.
  if (relay.status !== null && relay.status >= 500) throw new ProviderHttpError(relay.status);
  // A reply cut off at its ceiling (a long edit, say) is asked again with more room by the runtime.
  if (isOutOfRoomThinking(relay.error)) throw relay.error;
  if (relay.status !== 200 || !relay.completion || relay.failure)
    throw new Error(`Claude subscription did not receive a complete response from its official service${relay.status !== null && relay.status !== 200 ? ` (HTTP ${relay.status})` : ""}`);
  const boundary = result.code === 1 && result.event.subtype === "error_max_turns" && relay.completion.toolCalls.length > 0;
  if (!boundary && !relay.denied && (result.code !== 0 || result.event.is_error || result.event.subtype !== "success"))
    throw new Error("Claude subscription native request failed; check the official Claude Code sign-in and try again");
  return relay.completion;
}
async function removePrivateRequest(root: string): Promise<void> {
  const target = resolve(root), parent = resolve(tmpdir(), "Codex-session-files");
  if (dirname(target) !== parent || !basename(target).startsWith("branch-claude-subscription-"))
    throw new Error("Claude subscription refused to remove a directory outside its private request folder");
  // On Windows the native process can hold its folder open for a moment after it exits (EBUSY). A finished reply
  // is not failed for that: removal is tried again a few times now, then again in the background until it goes.
  try { await rm(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
  catch { removeLater(target, 1); }
}
function removeLater(target: string, attempt: number): void {
  setTimeout(() => {
    // The same conversation's next request may be using this folder again by now: it removes the folder itself.
    if (inUse.has(target)) return;
    void rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
      .catch(() => { if (attempt < 30) removeLater(target, attempt + 1); });
  }, 2000).unref();
}
/** Request folders being used right now, so two requests never share one and a late removal never takes a live one. */
const inUse = new Set<string>();
/**
 * selfdev: the native process's working folder appears in the environment note Claude Code puts near the start of
 * every request, so a fresh random folder each round changed the prompt's front and no round after the first could
 * be read from Anthropic's prompt cache (each round of a long task was paid in full). The folder is now named from
 * what stays the same for one conversation (its standing instructions and its first message, with the owner, the
 * account and the model), so every round of it starts with the same bytes. It is still private, still emptied after
 * each request, and a second request of the same conversation at the same moment gets a random one instead.
 */
async function requestFolder(parent: string, options: Readonly<ClaudeSubscriptionOptions>, request: CompletionRequest): Promise<string> {
  const first = request.messages.find((message) => message.role !== "system");
  const stable = createHash("sha256").update(JSON.stringify([options.owner, options.accountHome?.path ?? "", options.model ?? "",
    request.messages.filter((message) => message.role === "system").map((message) => message.content).join("\n").slice(0, 20000),
    first?.content.slice(0, 20000) ?? ""])).digest("hex").slice(0, 24);
  const path = join(parent, `branch-claude-subscription-${stable}`);
  if (inUse.has(path)) return mkdtemp(join(parent, "branch-claude-subscription-"));
  inUse.add(path);
  try {
    await rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); // left by a crash, never in use here
    await mkdir(path, { mode: 0o700 });
    return path;
  } catch (error) { inUse.delete(path); throw error; }
}
/** Claude is an inert model transport; Branch retains every tool, approval, outcome and agent loop. */
export class ClaudeSubscriptionProvider implements Provider {
  readonly name = "claude-subscription";
  readonly acceptsImages = true;
  readonly keepsOwnTime = true;
  readonly subscriptionSignIn = true;
  readonly branchTools = true;
  readonly model: string;
  detectLimits = true;
  onOutput: ((stdout: string) => void) | null = null;
  private readonly options: Readonly<ClaudeSubscriptionOptions>;
  constructor(options: ClaudeSubscriptionOptions, private readonly dependencies: ClaudeSubscriptionDependencies = {}) {
    if (!options.owner || options.accountHome && (options.accountHome.name !== "CLAUDE_CONFIG_DIR" || !isAbsolute(options.accountHome.path)))
      throw new Error("Claude subscription account home must be its owner's absolute CLAUDE_CONFIG_DIR");
    if (options.timeoutMs !== undefined && (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 100 || options.timeoutMs > 3600000))
      throw new Error("Claude subscription timeout must be between 100 milliseconds and one hour");
    this.model = options.model ?? claudeDefaultModel;
    this.options = Object.freeze({ ...options, ...(options.accountHome ? { accountHome: Object.freeze({ ...options.accountHome }) } : {}) });
  }
  async complete(request: CompletionRequest): Promise<Completion> {
    authorized(this.options.owner); request.signal.throwIfAborted();
    nativeHistory(request); nativeInventory(request.tools); nativeGeneration(request, nativeInventory(request.tools));
    const controller = new AbortController(), signal = AbortSignal.any([request.signal, controller.signal]);
    const timer = setTimeout(() => controller.abort(new Error("Claude subscription took too long and was stopped")), this.options.timeoutMs ?? 180000);
    timer.unref();
    const scope = { ...request, signal }, authorize = (): void => { signal.throwIfAborted(); authorized(this.options.owner); };
    let root: string | undefined, native: NativeProcess | undefined, relay: NativeAdmission | undefined;
    const stop = (): void => { void native?.stop().catch(() => {}); };
    signal.addEventListener("abort", stop, { once: true });
    try {
      const parent = join(tmpdir(), "Codex-session-files"); await mkdir(parent, { recursive: true, mode: 0o700 });
      root = await requestFolder(parent, this.options, request);
      relay = new NativeAdmission(scope, nativeInventory(request.tools), authorize, this.dependencies.connect);
      await relay.listen(); authorize();
      const input = await invocation(root, this.options, scope, relay); authorize();
      native = new NativeProcess(input.invocation, this.dependencies.spawn);
      await replay(native, input.frames, signal, authorize);
      const result = completed(relay, await nativeResult(native, signal)); authorize();
      const rateEvents = native.rateEvents(); if (rateEvents) this.onOutput?.(rateEvents);
      authorize(); return result;
    } finally {
      clearTimeout(timer); signal.removeEventListener("abort", stop); controller.abort();
      try { await native?.stop(); } finally {
        try { await relay?.close(); } finally { if (root) try { await removePrivateRequest(root); } finally { inUse.delete(root); } }
      }
    }
  }
}
