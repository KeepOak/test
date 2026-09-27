/**
 * The Branch Agent client. Nothing here is installed from anywhere: it is one file of plain
 * JavaScript that talks to the copy of Branch Agent already running on this computer, using the
 * same address and the same local session key the app itself uses. Types for everything it sends
 * and gets back are in types.d.ts, generated from the app's own input checks.
 *
 * Everything is one request, except the two ways of watching a task as it happens: `stream`, which
 * reads the events over a long-lived reply, and `watch`, which uses a socket. Both hand back an
 * async iterator, so a caller writes `for await (const event of ...)`.
 */

export class BranchError extends Error {
  constructor(status, message, path) {
    super(message);
    this.name = "BranchError";
    this.status = status;
    this.path = path;
  }
}

/** Reads the address and key the app wrote for this install, so a script needs no configuration. */
export async function fromDataDir(dataDir, { readFile, port = 3210 } = {}) {
  const read = readFile ?? (await import("node:fs/promises")).readFile;
  const token = (await read(`${dataDir}/session-token`, "utf8")).trim();
  return new BranchClient({ url: `http://127.0.0.1:${port}`, token });
}

/**
 * The session key is the whole of the app's security: it goes over plain http only to this
 * computer's own address, and over https to anything else.
 */
function checkedUrl(address) {
  let parsed;
  try { parsed = new URL(String(address)); } catch { parsed = null; }
  if (!parsed || (parsed.protocol !== "http:" && parsed.protocol !== "https:"))
    throw new Error("Give the web address Branch Agent is listening on, starting with http:// or https://");
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  const local = host === "localhost" || host === "::1" || /^127\.\d+\.\d+\.\d+$/.test(host);
  if (parsed.protocol === "http:" && !local)
    throw new Error("Plain http is only used for a Branch Agent on this computer; use https for any other address");
  return String(address).replace(/\/+$/, "");
}

export class BranchClient {
  /**
   * @param {{url: string, token: string, fetch?: typeof fetch, timeoutMs?: number}} options
   */
  constructor(options) {
    if (!options?.url || !options?.token) throw new Error("Give the address Branch Agent is listening on and its session key");
    this.url = checkedUrl(options.url);
    // Not enumerable, so printing or JSON-encoding a client never shows the key.
    Object.defineProperty(this, "token", { value: String(options.token), enumerable: false });
    this.fetch = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 120000;
    this.runs = new Runs(this);
    this.sessions = new Sessions(this);
    this.memory = new Memory(this);
    this.documents = new Documents(this);
    this.schedules = new Schedules(this);
    this.policy = new Policy(this);
  }

  headers(extra) {
    return { authorization: `Bearer ${this.token}`, ...extra };
  }

  /** One request. A reply that is not a success is turned into a BranchError with its message. */
  async request(method, path, body, { signal, timeoutMs } = {}) {
    const response = await this.fetch(`${this.url}${path}`, {
      method,
      headers: this.headers(body === undefined ? {} : { "content-type": "application/json" }),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: signal ?? AbortSignal.timeout(timeoutMs ?? this.timeoutMs),
      // A redirect could carry the key somewhere else; it is answered as a refusal instead.
      redirect: "manual",
    });
    const text = await response.text();
    let value;
    try { value = text ? JSON.parse(text) : {}; } catch { value = { error: text.slice(0, 300) }; }
    if (!response.ok) throw new BranchError(response.status, value?.error ?? `Branch Agent answered ${response.status}`, path);
    return value;
  }

  get(path, options) { return this.request("GET", path, undefined, options); }
  post(path, body, options) { return this.request("POST", path, body ?? {}, options); }

  /** Everything the app knows about itself right now: settings, tools, tasks, connections. */
  state() { return this.get("/api/state"); }
  /** Every tool this copy can run, with the permission each one needs. */
  tools() { return this.get("/api/tools"); }
  /** The record of what the assistant was allowed to do. */
  audit(filters = {}) { return this.get(`/api/audit${search(filters)}`); }
  /** Runs one tool directly, without a task around it. */
  action(tool, args = {}) { return this.post("/api/action", { tool, args }); }
  /** Up to five questions to put to the person before a task starts. */
  askFirst(prompt, askFirst) { return this.post("/api/ask-first", askFirst === undefined ? { prompt } : { prompt, askFirst }); }
  /** The request with the answers written underneath it, ready to start. */
  withAnswers(prompt, answers) { return this.post("/api/ask-first/answers", { prompt, answers }); }
  /** Documents and saved notes together, best answer first. */
  search(query) { return this.post("/api/retrieval/search", { query }); }
  /** What an issue says, pulled in from its web address as a passage with a citation. */
  issueContext(url) { return this.post("/api/issues/context", { url }); }
}

class Runs {
  constructor(client) { this.client = client; }
  /** Starts a task. Comes back as soon as the task is accepted, not when it finishes. */
  start(input) { return this.client.post("/api/run", input); }
  /** One task with its events, its messages and what it has used so far. */
  get(runId) { return this.client.get(`/api/runs/${runId}`); }
  /** Says something to a task while it is working. */
  steer(runId, text) { return this.client.post(`/api/runs/${runId}/steer`, { text }); }
  cancel(runId) { return this.client.post(`/api/runs/${runId}/cancel`); }
  /** Picks a task up again after it was interrupted. */
  resume(runId) { return this.client.post(`/api/runs/${runId}/resume`); }
  /** Answers the question a paused task stopped on: pass the fingerprint it was shown with (GET /api/policy waiting). */
  approve(sessionId, decision, remember = "session", fingerprint) {
    return this.client.post("/api/policy/approve", { sessionId, decision, remember, ...(fingerprint ? { fingerprint } : {}) });
  }
  /** Every tool result of a task with whether its receipt is genuine. */
  receipts(runId) { return this.client.get(`/api/runs/${runId}/receipts`); }
  /** Tasks in progress, with what each one is doing right now. */
  activity() { return this.client.get("/api/activity"); }

  /**
   * The events of a task as they happen, over a long-lived reply. Start from `after` to pick up
   * where an earlier read stopped; the iterator ends when the task does.
   */
  async *stream(runId, { after = 0, signal } = {}) {
    const response = await this.client.fetch(`${this.client.url}/api/runs/${runId}/stream?after=${after}`, {
      headers: this.client.headers({ accept: "text/event-stream" }),
      redirect: "manual",
      ...(signal ? { signal } : {}),
    });
    if (!response.ok || !response.body) throw new BranchError(response.status, "That task's events could not be read", `/api/runs/${runId}/stream`);
    let buffer = "";
    for await (const chunk of response.body) {
      buffer += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
      let split;
      while ((split = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        const event = readFrame(frame);
        if (event) yield event;
      }
    }
  }

  /**
   * The same events over a socket, for callers that would rather hold one connection open. The
   * session key travels as the socket's second protocol, the way the app's own screens send it.
   */
  async *watch(runId, { signal } = {}) {
    const socket = new WebSocket(`${this.client.url.replace(/^http/, "ws")}/api/runs/${runId}/ws`, ["bearer", this.client.token]);
    const queue = [];
    let wake = () => {};
    let done = false;
    let failure = null;
    socket.addEventListener("message", (message) => {
      try { queue.push(JSON.parse(String(message.data))); } catch { /* a frame that is not JSON is skipped */ }
      wake();
    });
    socket.addEventListener("close", () => { done = true; wake(); });
    socket.addEventListener("error", () => { failure = new BranchError(0, "The connection to that task closed unexpectedly", `/api/runs/${runId}/ws`); done = true; wake(); });
    signal?.addEventListener("abort", () => socket.close(), { once: true });
    try {
      while (!done || queue.length) {
        if (!queue.length) { await new Promise((resolve) => { wake = resolve; }); continue; }
        yield queue.shift();
      }
      if (failure) throw failure;
    } finally { socket.close(); }
  }
}

class Sessions {
  constructor(client) { this.client = client; }
  get(sessionId) { return this.client.get(`/api/sessions/${sessionId}`); }
  search(input) { return this.client.post("/api/sessions/search", input); }
  summary(sessionId) { return this.client.get(`/api/sessions/${sessionId}/summary`); }
  export(sessionId) { return this.client.get(`/api/sessions/${sessionId}/export`); }
  followUp(sessionId, prompt) { return this.client.post(`/api/sessions/${sessionId}/followups`, { prompt }); }
}

class Memory {
  constructor(client) { this.client = client; }
  search(query, limit) { return this.client.post("/api/memory/search", limit === undefined ? { query } : { query, limit }); }
  export() { return this.client.get("/api/memory/export"); }
  /** Brings the index in line with the saved facts and compares them by meaning where it can. */
  index() { return this.client.post("/api/memory/index"); }
  settings() { return this.client.get("/api/memory/retrieval"); }
  configure(input) { return this.client.post("/api/memory/retrieval", input); }
}

class Documents {
  constructor(client) { this.client = client; }
  list() { return this.client.get("/api/documents"); }
  add(input) { return this.client.post("/api/documents", input); }
  search(query, limit) { return this.client.post("/api/documents/search", limit === undefined ? { query } : { query, limit }); }
  remove(id) { return this.client.request("DELETE", `/api/documents/${id}`); }
  settings() { return this.client.get("/api/documents/settings"); }
}

class Schedules {
  constructor(client) { this.client = client; }
  get(scheduleId) { return this.client.get(`/api/schedules/${scheduleId}`); }
  trigger(scheduleId) { return this.client.post(`/api/schedules/${scheduleId}/trigger`); }
}

class Policy {
  constructor(client) { this.client = client; }
  /** The saved approval settings, the presets on offer, and anything waiting on an answer. */
  get() { return this.client.get("/api/policy"); }
  save(input) { return this.client.post("/api/policy", input); }
  /** A question that carries a fingerprint is answered only with it; an answer without one is refused (409). */
  approve(sessionId, decision, remember = "session", fingerprint) {
    return this.client.post("/api/policy/approve", { sessionId, decision, remember, ...(fingerprint ? { fingerprint } : {}) });
  }
  /** Approvals decided a kind of thing at a time rather than a tool at a time. */
  categories() { return this.client.get("/api/approvals/categories"); }
  setCategories(decisions) { return this.client.post("/api/approvals/categories", decisions); }
}

/**
 * One server-sent frame turned back into the event it carried. The last frame of a task is named
 * "end" and carries only the status, so the name is kept alongside whatever the frame said.
 */
function readFrame(frame) {
  const lines = frame.split("\n");
  const name = lines.find((line) => line.startsWith("event:"))?.slice(6).trim() ?? "";
  const data = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
  if (!data) return null;
  try { return { kind: name, ...JSON.parse(data) }; } catch { return null; }
}
function search(filters) {
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(filters ?? {}))
    if (value !== undefined && value !== null) query.set(name, String(value));
  const text = query.toString();
  return text ? `?${text}` : "";
}

export default BranchClient;
