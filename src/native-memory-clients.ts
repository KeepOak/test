import { z } from "zod";

export interface NativeMemoryClient {
  recall(namespace: string, session: string, question: string, signal: AbortSignal): Promise<string>;
  sync(namespace: string, session: string, prompt: string, output: string, run: string, signal: AbortSignal): Promise<void>;
  forget(namespace: string, signal: AbortSignal): Promise<void>;
}
export interface NativeMemoryTransport {
  url: string; fetch: typeof fetch; timeoutMs: number;
  key: () => Promise<string>; header: string;
  /** Checks current destination, profile, lock, task permission and network policy before key access. */
  check: (target: string) => void;
}

/** Bounded transport, injected by the owner-scoped lifecycle manager; no SDK initialization probes. */
abstract class NativeClient implements NativeMemoryClient {
  constructor(protected readonly transport: NativeMemoryTransport) {}
  protected async request(method: string, path: string, signal: AbortSignal, body?: unknown, missing = false): Promise<unknown> {
    const target = this.transport.url.replace(/\/+$/, "") + path;
    this.transport.check(target);
    signal.throwIfAborted();
    const key = await this.transport.key();
    this.transport.check(target);
    const response = await this.transport.fetch(target, { method, redirect: "error",
      headers: { "content-type": "application/json", ...(key ? { [this.transport.header]: key } : {}) },
      signal: AbortSignal.any([signal, AbortSignal.timeout(this.transport.timeoutMs)]),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    try { this.transport.check(target); } catch (error) { await response.body?.cancel(); throw error; }
    if (missing && response.status === 404) { await response.body?.cancel(); return undefined; }
    if (method === "DELETE" && response.status === 202) {
      await response.body?.cancel(); throw new Error("The service queued deletion; its cleanup stays pending until a retry confirms the namespace is gone");
    }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`The native memory service refused the request (${response.status})`); }
    if (!response.body) return undefined;
    const reader = response.body.getReader(), chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.length;
        if (bytes > 65_536) throw new Error("The native memory service returned too much data");
        chunks.push(next.value);
      }
    } finally { await reader.cancel().catch(() => {}); }
    this.transport.check(target);
    signal.throwIfAborted();
    const text = Buffer.concat(chunks).toString("utf8");
    return text.trim() ? JSON.parse(text) as unknown : undefined;
  }
  abstract recall(namespace: string, session: string, question: string, signal: AbortSignal): Promise<string>;
  abstract sync(namespace: string, session: string, prompt: string, output: string, run: string, signal: AbortSignal): Promise<void>;
  abstract forget(namespace: string, signal: AbortSignal): Promise<void>;
}
const mem0Record = z.object({ id: z.string().min(1), user_id: z.string(), memory: z.string().max(16000),
  metadata: z.object({ branch_namespace: z.string() }) });
const mem0Results = z.union([z.array(mem0Record).max(1000), z.object({ results: z.array(mem0Record).max(1000) })]);
const mem0Rows = (body: unknown) => { const parsed = mem0Results.parse(body); return Array.isArray(parsed) ? parsed : parsed.results; };
const branchNamespace = (value: string): string => z.string().regex(/^branch_[a-f0-9]{16}_[a-f0-9]{16}$/).parse(value);

/** Actual self-hosted Mem0 routes and X-API-Key/infer:false flow adapt Hermes's MIT SelfHostedBackend.
 * The current Mem0 server source (Apache-2.0) supplies scoped list/delete-all semantics. */
export class Mem0SyncClient extends NativeClient {
  async recall(namespace: string, _session: string, question: string, signal: AbortSignal): Promise<string> {
    branchNamespace(namespace);
    const rows = mem0Rows(await this.request("POST", "/search", signal, {
      query: question, top_k: 5, filters: { user_id: namespace, branch_namespace: namespace },
    }));
    if (rows.some((row) => row.user_id !== namespace || row.metadata.branch_namespace !== namespace))
      throw new Error("Mem0 returned context outside this person's Branch namespace");
    return rows.map((row) => row.memory).join("\n");
  }
  async sync(namespace: string, session: string, prompt: string, output: string, run: string, signal: AbortSignal): Promise<void> {
    branchNamespace(namespace);
    await this.request("POST", "/memories", signal, { user_id: namespace, agent_id: "branch", infer: false,
      messages: [{ role: "user", content: prompt }, { role: "assistant", content: output }],
      metadata: { branch_namespace: namespace, branch_session: session, branch_run: run } });
  }
  async forget(namespace: string, signal: AbortSignal): Promise<void> {
    branchNamespace(namespace);
    // Delete-all requires an admin-capable key. A refusal propagates to the pending journal.
    await this.request("DELETE", `/memories?user_id=${encodeURIComponent(namespace)}`, signal);
    const body = await this.request("GET", `/memories?user_id=${encodeURIComponent(namespace)}&top_k=1&show_expired=true`, signal);
    // The list source uses `memory`, like search/get_all; an empty response is the only completion.
    const empty = z.union([z.array(z.unknown()).max(1000), z.object({ results: z.array(z.unknown()).max(1000) })]).parse(body);
    if ((Array.isArray(empty) ? empty : empty.results).length) throw new Error("Mem0 still exposes this person's Branch memories; cleanup remains pending");
  }
}

const honchoIdentity = z.object({ id: z.string() });
const honchoContext = z.object({ peer_id: z.string(), target_id: z.string(),
  representation: z.string().max(16000).nullable().optional(), peer_card: z.array(z.string().max(2000)).max(30).nullable().optional() });
const workspacePath = (namespace: string): string => `/v2/workspaces/${encodeURIComponent(branchNamespace(namespace))}`;

/** Native v2 routes adapt honcho-python's Apache-2.0 generated workspace/peer/session/message helpers.
 * One generated workspace is exclusively Branch's for one person; no shared workspace is selected. */
export class HonchoSyncClient extends NativeClient {
  private async identity(path: string, id: string, signal: AbortSignal, body: unknown): Promise<void> {
    const found = honchoIdentity.parse(await this.request("POST", path, signal, body));
    if (found.id !== id) throw new Error("Honcho returned a different namespace or session from the one requested");
  }
  async recall(namespace: string, _session: string, question: string, signal: AbortSignal): Promise<string> {
    const query = new URLSearchParams({ search_query: question, search_top_k: "5", max_conclusions: "5" });
    const body = await this.request("GET", `${workspacePath(namespace)}/peers/person/context?${query}`, signal, undefined, true);
    if (body === undefined) return "";
    const context = honchoContext.parse(body);
    if (context.peer_id !== "person" || context.target_id !== "person") throw new Error("Honcho returned context for a different peer");
    return [context.representation, ...(context.peer_card ?? [])].filter(Boolean).join("\n");
  }
  async sync(namespace: string, session: string, prompt: string, output: string, run: string, signal: AbortSignal): Promise<void> {
    const root = workspacePath(namespace);
    await this.identity("/v2/workspaces", namespace, signal, { id: namespace, metadata: { branch_namespace: namespace } });
    await this.identity(`${root}/peers`, "person", signal, { id: "person", metadata: { branch_namespace: namespace } });
    await this.identity(`${root}/peers`, "assistant", signal, { id: "assistant", metadata: { branch_namespace: namespace } });
    await this.identity(`${root}/sessions`, session, signal, { id: session, metadata: { branch_namespace: namespace } });
    await this.request("POST", `${root}/sessions/${encodeURIComponent(session)}/messages`, signal, { messages: [
      { peer_id: "person", content: prompt, metadata: { branch_run: run } },
      { peer_id: "assistant", content: output, metadata: { branch_run: run } },
    ] });
  }
  async forget(namespace: string, signal: AbortSignal): Promise<void> {
    // Workspace deletion includes peers, messages and conclusions; deleting sessions alone would leave derived context.
    await this.request("DELETE", workspacePath(namespace), signal, undefined, true);
  }
}
