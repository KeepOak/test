import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { supportedProtocolVersions } from "../mcp-server.js";

/**
 * SELF-083: a handed-off Claude Code runs commands, and only through Branch's own held shell. Claude Code's own
 * Bash stays refused, since nothing walls it in on Windows. For each hand-off, Branch opens this small door on
 * 127.0.0.1 with a key made for that job alone. The door is a Model Context Protocol server over HTTP with one
 * tool, and Claude Code is told about it with `--mcp-config` (a file only this user can read, never the command
 * line). Every command it sends is weighed and run by Branch as its own `shell.execute` would be (src/index.ts):
 * the owner's rules, the self-development contract, and writes held to the job's folder. The door closes when
 * the job ends.
 *
 * The idea of approving a CLI agent's own tools through the host follows OpenClaw's cli-native-tool-approval
 * (MIT, src/agents/cli-runner/cli-native-tool-approval.ts), and so does failing closed on what cannot be shown
 * whole. Here the command is not approved for Claude Code to run itself: Branch runs it.
 */

export const doorServer = "branch";
export const doorTool = "run_command";
/** The name Claude Code gives the door's tool, and the only extra tool it is allowed. */
export const doorToolName = `mcp__${doorServer}__${doorTool}`;

const alias = z.string().regex(/^[a-z][a-z0-9_-]{0,29}$/, "A program is one of Branch's command names, such as npm, node, npx or git");
export const DoorCommandSchema = z.object({
  program: alias,
  args: z.array(z.string().max(4000).refine((value) => !value.includes("\0"), "NUL is not permitted")).max(80).default([]),
  /** A folder inside the job's folder, from its top. */
  cwd: z.string().trim().min(1).max(400).default("."),
  timeoutSeconds: z.number().int().min(1).max(1800).optional(),
}).strict();
export type DoorCommand = z.infer<typeof DoorCommandSchema>;

/** What a command came to, in the words Claude Code reads back. */
export interface DoorAnswer { text: string; isError: boolean }
/** `stop`: aborted when the door closes, so a command still running when the job ends is stopped, not left behind. */
export type DoorRunner = (command: DoorCommand, stop: AbortSignal) => Promise<DoorAnswer>;

const description = "Run a command-line program in the folder you are working in, through Branch's own held shell. "
  + "Use it for builds, tests and read-only Git (for example program \"npm\" with args [\"test\"], or \"node\" with "
  + "[\"--test\", \"tests/a.test.mjs\"]). Name one program and its arguments as a list: there is no shell, so no pipes, "
  + "redirects or &&. cwd is a folder inside your folder, from its top. Writes are held to your folder. "
  + "Branch's own rules decide each command, and a refused one says why. Bash is not available.";
const inputSchema = z.toJSONSchema(DoorCommandSchema, { io: "input" });

const bodyLimit = 1_000_000;
const jsonRpc = (id: unknown, result: unknown) => ({ jsonrpc: "2.0", id, result });
const rpcError = (id: unknown, code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

/** One door, for one hand-off: its address, its key, the file that tells Claude Code about it, and its closing. */
export class CommandDoor {
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;
  private readonly stopping = new AbortController();
  private constructor(
    private readonly server: Server, private readonly key: Buffer, private readonly folder: string,
    readonly url: string, readonly configFile: string,
  ) {}

  /** Opens a door on 127.0.0.1 that sends each command to `run`, one at a time. */
  static async open(run: DoorRunner): Promise<CommandDoor> {
    const key = randomBytes(32);
    const token = key.toString("base64url");
    let door: CommandDoor | null = null;
    const server = createServer((request, response) => {
      if (!door) { response.writeHead(503).end(); return; }
      door.serve(request, response, run).catch(() => { if (!response.headersSent) response.writeHead(500); response.end(); });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
    });
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
    // The key goes in a file in a private folder (0700 / 0600), never on the command line, where anyone could read it.
    const folder = await mkdtemp(join(tmpdir(), "branch-hand-off-door-"));
    const configFile = join(folder, "mcp.json");
    await writeFile(configFile, JSON.stringify({ mcpServers: { [doorServer]: { type: "http", url,
      headers: { Authorization: `Bearer ${token}` } } } }), { mode: 0o600 });
    door = new CommandDoor(server, key, folder, url, configFile);
    return door;
  }

  /** The arguments that give Claude Code this door and nothing else from MCP. */
  claudeArgs(): string[] {
    return ["--mcp-config", this.configFile, "--allowedTools", doorToolName];
  }

  /**
   * Closes the door. A command still running (Claude Code gave up on it, or ended first) is stopped, and this returns
   * only once it has settled, so nothing is still writing in the folder when Branch looks at what the job changed.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.stopping.abort(new Error("The job is over"));
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    await this.queue;
    await rm(this.folder, { recursive: true, force: true }).catch(() => undefined);
  }

  private keyFits(header: string | undefined): boolean {
    const given = /^Bearer (\S+)$/.exec(header ?? "")?.[1];
    if (!given) return false;
    const bytes = Buffer.from(given, "base64url");
    return bytes.length === this.key.length && timingSafeEqual(bytes, this.key);
  }

  private async serve(request: IncomingMessage, response: ServerResponse, run: DoorRunner): Promise<void> {
    const port = (this.server.address() as AddressInfo).port;
    // Only this computer, only by its own address (no other site's page reaching it through a renamed host).
    if (request.headers.host !== `127.0.0.1:${port}` || !request.url?.startsWith("/mcp")) { response.writeHead(404).end(); return; }
    if (!this.keyFits(request.headers.authorization)) { response.writeHead(401).end(); return; }
    // No stream of its own to offer: every answer comes back on the request that asked (Streamable HTTP allows this).
    if (request.method !== "POST") { response.writeHead(405, { Allow: "POST" }).end(); return; }
    const text = await readBody(request);
    if (text === null) { response.writeHead(413).end(); return; }
    let message: unknown;
    try { message = JSON.parse(text); } catch { return send(response, 400, rpcError(null, -32700, "Parse error")); }
    const batch = Array.isArray(message) ? message : [message];
    const answers = (await Promise.all(batch.map((one) => this.answer(one, run)))).filter((one) => one !== null);
    if (!answers.length) { response.writeHead(202).end(); return; }
    send(response, 200, Array.isArray(message) ? answers : answers[0]);
  }

  /** One JSON-RPC message in; its answer, or null for a notification. */
  private async answer(message: unknown, run: DoorRunner): Promise<unknown> {
    const { id, method, params } = (message ?? {}) as { id?: unknown; method?: unknown; params?: unknown };
    if (typeof method !== "string") return rpcError(id, -32600, "Invalid request");
    if (id === undefined) return null;
    if (method === "initialize") {
      const asked = (params as { protocolVersion?: unknown } | undefined)?.protocolVersion;
      const version = (supportedProtocolVersions as readonly unknown[]).includes(asked) ? asked : supportedProtocolVersions[0];
      return jsonRpc(id, { protocolVersion: version, capabilities: { tools: {} }, serverInfo: { name: "branch-hand-off", version: "1.0.0" } });
    }
    if (method === "ping") return jsonRpc(id, {});
    if (method === "tools/list") return jsonRpc(id, { tools: [{ name: doorTool, description, inputSchema }] });
    if (method === "tools/call") return jsonRpc(id, await this.call(params, run));
    return rpcError(id, -32601, `Method not found: ${method}`);
  }

  private async call(params: unknown, run: DoorRunner): Promise<unknown> {
    const { name, arguments: args } = (params ?? {}) as { name?: unknown; arguments?: unknown };
    if (name !== doorTool) return failure(`There is no tool called ${String(name)} here; use ${doorTool}.`);
    const parsed = DoorCommandSchema.safeParse(args ?? {});
    if (!parsed.success) return failure(`That command was not run: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
    if (this.closed) return failure("The job is over, so no more commands run.");
    // One at a time, in the order they came: Branch's shell runs one command at once.
    const mine = this.queue.then(() => (this.closed ? { text: "The job is over, so no more commands run.", isError: true } : run(parsed.data, this.stopping.signal)));
    this.queue = mine.catch(() => undefined);
    try {
      const answer = await mine;
      return { content: [{ type: "text", text: answer.text }], isError: answer.isError };
    } catch (error) {
      return failure(error instanceof Error ? error.message : String(error));
    }
  }
}

const failure = (text: string) => ({ content: [{ type: "text", text }], isError: true });

function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
}

function readBody(request: IncomingMessage): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > bodyLimit) { request.destroy(); resolve(null); return; }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

/** What a command came to, for Claude Code: how it ended, then what it printed, each cut to a readable length. */
export function commandAnswer(result: { status: string; exitCode: number | null; stdout: string; stderr: string; truncated?: boolean }): DoorAnswer {
  const cut = (text: string, limit: number): string => (text.length > limit ? `…${text.slice(text.length - limit)}` : text);
  const ended = result.status === "completed" ? `exit code ${result.exitCode ?? 0}` : `${result.status} (exit code ${result.exitCode ?? "none"})`;
  const parts = [ended];
  if (result.stdout.trim()) parts.push(`stdout:\n${cut(result.stdout, 20_000)}`);
  if (result.stderr.trim()) parts.push(`stderr:\n${cut(result.stderr, 8_000)}`);
  if (result.truncated) parts.push("(output was cut short)");
  return { text: parts.join("\n\n"), isError: result.status !== "completed" || (result.exitCode ?? 0) !== 0 };
}
