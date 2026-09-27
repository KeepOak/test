import { attachToRunning, type Attachment } from "./install/running.js";

/**
 * Batch 20 (wave 8): talking to the copy of Branch that is already running.
 *
 * `branch chat --attach` and `branch schedule` do not start an engine of their own: they find the
 * one working in the background, join its conversation, and go through exactly the same door as the
 * app window — the same local key, the same rules, the same record of what was allowed. Two
 * terminals can therefore be in one conversation at once and each sees what the other said.
 *
 * Nothing here reaches beyond this computer: the address always comes from the note the running
 * engine left in the data folder, never from anything typed.
 */
export interface Client {
  url: string;
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body: unknown, timeoutMs?: number): Promise<T>;
}

export const notRunning =
  "Branch is not working in the background on this computer. Start it with: branch start (or branch daemon install)";

/** Joins the running engine, or says plainly that there is none. */
export async function connect(dataDir: string, fetchImpl: typeof fetch = globalThis.fetch): Promise<Client> {
  const found = await attachToRunning(dataDir, { fetch: fetchImpl });
  if (!found) throw new Error(notRunning);
  return clientFor(found, fetchImpl);
}

/** The same client, built from an attachment a caller already has (tests, and the daemon check). */
export function clientFor(found: Attachment, fetchImpl: typeof fetch = globalThis.fetch): Client {
  const call = async (path: string, init: RequestInit, timeoutMs: number): Promise<unknown> => {
    const response = await fetchImpl(found.url + path, {
      ...init,
      headers: { authorization: `Bearer ${found.token}`, ...(init.body ? { "content-type": "application/json" } : {}) },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    let parsed: unknown = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { text }; }
    if (!response.ok) {
      const said = (parsed as { error?: unknown } | null)?.error;
      throw new Error(typeof said === "string" ? said : `Branch answered ${response.status}`);
    }
    return parsed;
  };
  return {
    url: found.url,
    get: <T>(path: string) => call(path, { method: "GET" }, 30_000) as Promise<T>,
    post: <T>(path: string, body: unknown, timeoutMs = 300_000) =>
      call(path, { method: "POST", body: JSON.stringify(body ?? {}) }, timeoutMs) as Promise<T>,
  };
}

export interface AttachedSession { id: string; opening: string; lastMessage: string }
export interface ViewedMessage { role: string; content: string; messageId: number; toolCalls?: unknown[]; from?: string }

/** The conversations the running engine has, newest first, for the list a second terminal shows. */
export async function conversations(client: Client, limit = 10): Promise<AttachedSession[]> {
  const rows = await client.get<unknown>(`/api/sessions?limit=${limit}`);
  const list = Array.isArray(rows) ? rows : (rows as { sessions?: unknown })?.sessions;
  return (Array.isArray(list) ? list : [])
    .map((row) => row as { sessionId?: string; opening?: string; lastMessage?: string })
    .filter((row) => typeof row.sessionId === "string")
    .map((row) => ({ id: row.sessionId!, opening: row.opening ?? "", lastMessage: row.lastMessage ?? "" }));
}

/** Everything said in one conversation, so a second terminal can catch up before it joins in. */
export async function messagesOf(client: Client, sessionId: string): Promise<ViewedMessage[]> {
  const view = await client.get<{ messages?: ViewedMessage[] }>(`/api/sessions/${sessionId}`);
  return (view.messages ?? []).filter((message) => (message.role === "user" || message.role === "assistant") && message.from !== "branch");
}

/** One line per message, the way a terminal shows it: who said it, and what. */
export function transcriptLines(messages: ViewedMessage[]): string[] {
  return messages
    .filter((message) => message.content.trim() && !message.toolCalls?.length)
    .map((message) => `${message.role === "user" ? "you" : "branch"}: ${message.content.trim()}`);
}

/**
 * Anything said in the conversation since the message id given, so a terminal that is only
 * watching prints what the other terminal asked and what came back.
 */
export async function since(client: Client, sessionId: string, after: number): Promise<{ lines: string[]; last: number }> {
  const messages = await messagesOf(client, sessionId);
  const fresh = messages.filter((message) => message.messageId > after);
  return { lines: transcriptLines(fresh), last: messages.at(-1)?.messageId ?? after };
}
