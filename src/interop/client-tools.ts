import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { z } from "zod";
import { audit } from "../audit.js";
import { validationText } from "../request-errors.js";
import type { ToolContext } from "../contracts.js";
import type { ToolRegistry } from "../registry.js";
import type { Store } from "../store.js";
import { acceptKey, frame, readFrame } from "../ws.js";
import { interopMode } from "./settings.js";

/**
 * Tools lent by a connected program. A program on this computer — an editor, a game, a script —
 * opens a socket, says which tools it can carry out, and those tools join the assistant's catalog
 * for as long as the socket stays open. When the model calls one, the call goes down the socket and
 * the program's answer comes back up. Closing the socket takes the tools away again.
 *
 * Every lent tool needs the "client.tools" permission, which counts as able to change something, so
 * "Ask before changes" asks before each call; its description is treated as somebody else's text.
 * The idea comes from Letta Code's client-side tools; this is an independent implementation.
 *
 * The words on the wire, one JSON object per text frame:
 *   program → Branch   {"type":"hello","client":"my-editor","tools":[{"name":"open_file","description":"…","parameters":{…}}]}
 *   Branch → program   {"type":"ready","tools":["client.my-editor.open_file"]}
 *   Branch → program   {"type":"call","id":"…","tool":"open_file","arguments":{…}}
 *   program → Branch   {"type":"result","id":"…","output":…}   or   {"type":"result","id":"…","error":"…"}
 *   Branch → program   {"type":"cancel","id":"…"}   when the task stopped waiting
 */
export const clientToolPermission = "client.tools";
export const clientToolsPath = "/api/interop/client-tools/ws";
const maxTools = 16;
/** How many programs may lend tools at once, so the catalog cannot be flooded. */
const maxPrograms = 8;
const maxFrameBytes = 256 * 1024;
const maxOutputChars = 16000;
const callTimeoutMs = 60000;

const ToolOfferSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]{0,40}$/, "A lent tool's name is lower-case letters, digits and underscores"),
  description: z.string().trim().min(1).max(500),
  parameters: z.record(z.string(), z.unknown()).optional(),
}).strict();
const HelloSchema = z.object({
  type: z.literal("hello"),
  client: z.string().regex(/^[a-z][a-z0-9-]{0,30}$/, "A program's name is lower-case letters, digits and dashes"),
  tools: z.array(ToolOfferSchema).min(1).max(maxTools),
}).strict();
const ResultSchema = z.object({
  type: z.literal("result"),
  id: z.string().min(1).max(100),
  output: z.unknown().optional(),
  error: z.string().max(2000).optional(),
}).strict();

/** A lent tool's input shape must describe an object and stay small; anything else becomes "any object". */
export function safeInputSchema(offered: Record<string, unknown> | undefined): Record<string, unknown> {
  const fallback = { type: "object", additionalProperties: true };
  if (!offered || offered.type !== "object") return fallback;
  return JSON.stringify(offered).length <= 8000 ? offered : fallback;
}

export interface ClientLink { send(value: unknown): void; close(): void }
interface Pending { resolve(value: unknown): void; reject(error: Error): void }

/** One connected program: what it lent, and the calls still waiting for its answer. */
export class ClientConnection {
  client = "";
  readonly tools: string[] = [];
  private readonly pending = new Map<string, Pending>();
  constructor(private readonly hub: ClientToolHub, private readonly link: ClientLink) {}

  receive(text: string): void {
    let message: unknown;
    try { message = JSON.parse(text); } catch { this.link.send({ type: "error", message: "That was not JSON." }); return; }
    const kind = (message as { type?: unknown } | null)?.type;
    if (kind === "hello") return this.hello(message);
    if (kind === "result") return this.result(message);
    this.link.send({ type: "error", message: "Send hello first, then result messages." });
  }
  private hello(message: unknown): void {
    const parsed = HelloSchema.safeParse(message);
    if (!parsed.success) { this.link.send({ type: "error", message: validationText(parsed.error) }); return; }
    if (this.client) { this.link.send({ type: "error", message: "This socket already said hello." }); return; }
    const refusal = this.hub.claim(this, parsed.data.client);
    if (refusal) { this.link.send({ type: "error", message: refusal }); this.link.close(); return; }
    this.client = parsed.data.client;
    for (const offer of parsed.data.tools) this.tools.push(this.hub.lend(this, offer));
    this.link.send({ type: "ready", tools: this.tools });
  }
  private result(message: unknown): void {
    const parsed = ResultSchema.safeParse(message);
    const waiting = parsed.success ? this.pending.get(parsed.data.id) : undefined;
    if (!parsed.success || !waiting) return;
    this.pending.delete(parsed.data.id);
    if (parsed.data.error !== undefined) waiting.reject(new Error(`${this.client} answered: ${parsed.data.error}`));
    else waiting.resolve(parsed.data.output ?? null);
  }
  /** Sends one call down the socket and waits for the answer, the task being stopped, or the time limit. */
  call(tool: string, args: unknown, context: ToolContext): Promise<unknown> {
    const id = randomUUID();
    return new Promise<unknown>((resolve, reject) => {
      const stop = (error: Error): void => {
        if (!this.pending.delete(id)) return;
        this.link.send({ type: "cancel", id });
        reject(error);
      };
      const timer = setTimeout(() => stop(new Error(`${this.client} did not answer within ${callTimeoutMs / 1000} seconds`)), callTimeoutMs);
      const aborted = (): void => stop(new Error("The task stopped waiting for the program's answer"));
      context.signal.addEventListener("abort", aborted, { once: true });
      const settle = (): void => { clearTimeout(timer); context.signal.removeEventListener("abort", aborted); };
      this.pending.set(id, {
        resolve: (value) => { settle(); resolve(value); },
        reject: (error) => { settle(); reject(error); },
      });
      this.link.send({ type: "call", id, tool, arguments: args });
    });
  }
  /** Hangs up from this side, as when the owner switches lending off. */
  shut(): void { this.link.close(); this.closed(); }
  /** The socket went away: its tools go, and every call still waiting is told why. */
  closed(): void {
    for (const [id, waiting] of this.pending) {
      this.pending.delete(id);
      waiting.reject(new Error(`${this.client || "The program"} disconnected before answering`));
    }
    this.hub.release(this);
  }
}

export class ClientToolHub {
  private readonly connections = new Map<string, ClientConnection>();
  constructor(private readonly registry: ToolRegistry, private readonly store: Store, private readonly owner: string) {}

  enabled(): boolean { return interopMode(this.store, this.owner, "client-tools") !== "off"; }
  open(link: ClientLink): ClientConnection { return new ClientConnection(this, link); }
  list(): { client: string; tools: string[] }[] {
    return [...this.connections.values()].map((c) => ({ client: c.client, tools: [...c.tools] }));
  }

  claim(connection: ClientConnection, client: string): string | null {
    if (!this.enabled()) return "Tools lent by a connected program are switched off.";
    if (this.connections.has(client)) return `A program called ${client} is already connected.`;
    if (this.connections.size >= maxPrograms) return `At most ${maxPrograms} programs may lend tools at once.`;
    this.connections.set(client, connection);
    audit(this.store, this.owner, { action: "connection.changed", actor: client, subject: `${client} lent tools over a socket`,
      reason: "A program on this computer offered tools to the assistant", outcome: "connected" });
    return null;
  }
  lend(connection: ClientConnection, offer: z.infer<typeof ToolOfferSchema>): string {
    const name = `client.${connection.client}.${offer.name}`;
    this.registry.unregister(name);
    this.registry.register<Record<string, unknown>>({
      name, group: "client", external: true, permission: clientToolPermission,
      description: `${offer.description} (lent by ${connection.client})`,
      parameters: z.record(z.string(), z.unknown()),
      inputSchema: safeInputSchema(offer.parameters),
      execute: async (args, context) => {
        if (!this.enabled()) throw new Error("Tools lent by a connected program are switched off.");
        const output = await connection.call(offer.name, args, context);
        const text = typeof output === "string" ? output : JSON.stringify(output) ?? "";
        return { lentBy: connection.client, output: text.length > maxOutputChars ? `${text.slice(0, maxOutputChars)}…` : text };
      },
    });
    return name;
  }
  /** Every connected program is hung up on, and its tools go with it. */
  disconnectAll(): void {
    for (const connection of [...this.connections.values()]) connection.shut();
  }
  release(connection: ClientConnection): void {
    for (const name of connection.tools) this.registry.unregister(name);
    if (connection.client && this.connections.get(connection.client) === connection) this.connections.delete(connection.client);
  }
}

/** Completes the handshake and carries frames both ways until either side closes. */
export function serveClientToolSocket(hub: ClientToolHub, request: IncomingMessage, socket: Duplex): void {
  const key = String(request.headers["sec-websocket-key"] ?? "");
  socket.write(["HTTP/1.1 101 Switching Protocols", "Upgrade: websocket", "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${acceptKey(key)}`, "Sec-WebSocket-Protocol: bearer", "", ""].join("\r\n"));
  let open = true, pending = Buffer.alloc(0);
  const link: ClientLink = {
    send: (value) => { if (open) socket.write(frame(JSON.stringify(value))); },
    close: () => { if (open) { open = false; socket.end(Buffer.from([0x88, 0x00])); } },
  };
  const connection = hub.open(link);
  socket.on("data", (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk]);
    if (pending.length > maxFrameBytes + 14) { link.close(); return; }
    for (let decoded = readFrame(pending); decoded; decoded = readFrame(pending)) {
      pending = pending.subarray(decoded.consumed);
      if (decoded.opcode === 0x8) link.close();
      // A control frame carries at most 125 bytes; anything longer is not a real ping.
      else if (decoded.opcode === 0x9 && decoded.payload.length > 125) link.close();
      else if (decoded.opcode === 0x9) socket.write(Buffer.concat([Buffer.from([0x8a, decoded.payload.length]), decoded.payload]));
      else if (decoded.opcode === 0x1 && decoded.fin) connection.receive(decoded.payload.toString("utf8"));
    }
  });
  const gone = (): void => { open = false; connection.closed(); };
  socket.once("close", gone);
  socket.on("error", () => socket.destroy());
}
