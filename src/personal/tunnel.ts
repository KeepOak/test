import { spawn } from "node:child_process";
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Readable } from "node:stream";
import { z } from "zod";
import { tunnelMark } from "../auth-limits.js";
import type { Store } from "../store.js";
import { partSettings, requirePersonal, savePartSettings } from "./settings.js";
import { chatScreenDoorPath } from '../channels/screen-http.js';

/**
 * R17-032: a public address for incoming webhooks and the dedicated paired-owner screen page. Branch's own window never goes
 * on the internet. Instead a small door on this computer (loopback only) passes on just the
 * addresses chat services and triggers post to —
 *
 *   /webhooks/chat/…  /webhooks/whatsapp/…  /hooks/…  POST /api/triggers/<id>/fire
 *
 * — to Branch, without any key, cookie or origin a caller sends, and answers everything else with a
 * bare 404. The owner's own tunnel program (Cloudflare's cloudflared, Tailscale Funnel or ngrok,
 * already installed and signed in by them) points at that door, and the address it prints is shown
 * once, to the owner only. Stopping it, locking Branch or closing Branch stops the program.
 * Every webhook still has to pass its own signature and random-address check inside Branch.
 */
export const tunnelPrograms = ["cloudflared", "tailscale", "ngrok"] as const;
export const TunnelSettingsSchema = z.object({
  program: z.enum(tunnelPrograms).default("cloudflared"),
  /** A full path to the program, when it is not on the search path. */
  executable: z.string().trim().max(500).regex(/^(\/|[A-Za-z]:\\)[^\0\r\n]*$/, "Give the full path to the program").or(z.literal("")).default(""),
}).strict();
const settingsKey = "personal-tunnel-settings";

/** The paths the door lets through; anything else never reaches Branch. */
export function webhookOnly(method: string, path: string): boolean {
  if (path.includes("..") || path.includes("//")) return false;
  if (/^\/webhooks\/(chat|whatsapp)\/[A-Za-z0-9_-]{1,64}(\/[a-f0-9]{32})?$/.test(path)) return true;
  if (/^\/hooks\/[A-Za-z0-9_-]{1,80}$/.test(path)) return true;
  return method === "POST" && /^\/api\/triggers\/[a-f0-9-]{36}\/fire$/.test(path);
}

/** The program, its arguments, and how to find the public address in what it prints. */
export function tunnelCommand(program: (typeof tunnelPrograms)[number], port: number): { args: string[]; address: RegExp } {
  const local = `http://127.0.0.1:${port}`;
  if (program === "cloudflared") return { args: ["tunnel", "--no-autoupdate", "--url", local], address: /https:\/\/[a-z0-9-]+\.trycloudflare\.com/ };
  // Without --bg, so the funnel ends when the program does and nothing is left configured.
  if (program === "tailscale") return { args: ["funnel", local], address: /https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*\.ts\.net\/?/ };
  return { args: ["http", local, "--log", "stdout", "--log-format", "logfmt"], address: /https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*\.ngrok(-free)?\.(app|dev|io)/ };
}
/** The dedicated screen path grants no window key or generic screen route. */
export function tunnelPath(method: string, path: string): boolean { return webhookOnly(method, path) || chatScreenDoorPath(method, path); }

export interface TunnelChild { stdout: Readable | null; stderr: Readable | null; kill(signal?: NodeJS.Signals): boolean; once(event: "exit", listener: () => void): unknown }
export type TunnelSpawn = (file: string, args: string[]) => TunnelChild;
const realSpawn: TunnelSpawn = (file, args) => spawn(file, args, { stdio: ["ignore", "pipe", "pipe"], shell: false, windowsHide: true });

const dropped = new Set(["authorization", "cookie", "origin", "referer", "host", "connection", "proxy-authorization", "x-branch-key", tunnelMark]);
const maxBody = 1024 * 1024;

export interface TunnelDeps {
  store: Store;
  owner: string;
  /** A sentence when starting anything is refused right now (Lockdown), or null. */
  refusal: () => string | null;
  spawn?: TunnelSpawn;
  waitMs?: number;
}

export class WebhookTunnel {
  /** Branch's own address on this computer, set once the server is listening. */
  localAddress = "";
  /** Trusted engine lifecycle hook, never supplied by an HTTP body. */
  onStop: (() => void) | undefined;
  private door: Server | null = null;
  private child: TunnelChild | null = null;
  private address: string | null = null;
  private readonly spawnProgram: TunnelSpawn;
  constructor(private readonly deps: TunnelDeps) { this.spawnProgram = deps.spawn ?? realSpawn; }
  settings() { return partSettings(this.deps.store, this.deps.owner, settingsKey, TunnelSettingsSchema); }
  save(input: unknown) { return savePartSettings(this.deps.store, this.deps.owner, settingsKey, TunnelSettingsSchema, input); }
  status(): { running: boolean; address: string | null } { return { running: this.child !== null, address: this.address }; }

  /** Opens the door and starts the owner's tunnel program, then waits for its public address. */
  async start(): Promise<{ running: boolean; address: string | null }> {
    requirePersonal(this.deps.store, this.deps.owner, "tunnel");
    const refused = this.deps.refusal();
    if (refused) throw new Error(refused);
    if (!this.localAddress) throw new Error("Branch is not listening yet, so there is nothing to pass webhooks to");
    if (this.child) return this.status();
    const port = await this.openDoor();
    const settings = this.settings();
    const { args, address } = tunnelCommand(settings.program, port);
    const child = this.spawnProgram(settings.executable || settings.program, args);
    this.child = child;
    child.once("exit", () => { if (this.child === child) void this.stop(); });
    this.address = await this.watchFor(child, address);
    if (!this.address) {
      await this.stop();
      throw new Error(`${settings.program} did not give a public address. Check it is installed and signed in, then try again.`);
    }
    return this.status();
  }

  async stop(): Promise<{ running: boolean; address: string | null }> {
    this.onStop?.();
    const child = this.child, door = this.door;
    this.child = null; this.door = null; this.address = null;
    child?.kill("SIGTERM");
    if (door) await new Promise<void>((resolve) => { door.close(() => resolve()); door.closeAllConnections(); });
    return this.status();
  }

  private watchFor(child: TunnelChild, pattern: RegExp): Promise<string | null> {
    return new Promise((resolve) => {
      let seen = "";
      const timer = setTimeout(() => resolve(null), this.deps.waitMs ?? 30_000);
      const read = (chunk: Buffer | string) => {
        seen = (seen + chunk.toString()).slice(-8000);
        const found = pattern.exec(seen)?.[0];
        if (found) { clearTimeout(timer); resolve(found.replace(/\/$/, "")); }
      };
      child.stdout?.on("data", read);
      child.stderr?.on("data", read);
      child.once("exit", () => { clearTimeout(timer); resolve(null); });
    });
  }

  private async openDoor(): Promise<number> {
    const door = createServer((request, response) => void this.pass(request, response));
    await new Promise<void>((resolve, reject) => { door.once("error", reject); door.listen(0, "127.0.0.1", () => resolve()); });
    this.door = door;
    return (door.address() as AddressInfo).port;
  }

  /** One request through the door: exact webhook and owner screen paths pass; anything else is a 404. */
  private async pass(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const method = request.method ?? "GET";
    const asked = new URL(request.url ?? "/", "http://door");
    if (!tunnelPath(method, asked.pathname) || !["GET", "POST"].includes(method)) { response.writeHead(404).end(); request.resume(); return; }
    const target = new URL(this.localAddress);
    const headers = Object.fromEntries(Object.entries(request.headers).filter(([name]) => !dropped.has(name.toLowerCase())));
    // The path Branch is handed is the one checked above, never the raw bytes the caller sent; and the
    // mark tells Branch this came from the internet (src/auth-limits.ts).
    const upstream = httpRequest({ host: target.hostname, port: target.port, method, path: `${asked.pathname}${asked.search}`, timeout: 60_000,
      headers: { ...headers, host: target.host, "x-forwarded-proto": "https", [tunnelMark]: "1" } }, (answer) => {
      const guarded = chatScreenDoorPath(method, asked.pathname);
      response.writeHead(answer.statusCode ?? 502, { "content-type": answer.headers["content-type"] ?? "text/plain",
        ...(guarded ? Object.fromEntries(['cache-control', 'referrer-policy', 'x-content-type-options', 'content-security-policy']
          .flatMap(name => answer.headers[name] ? [[name, answer.headers[name]!]] : [])) : {}) });
      answer.pipe(response);
    });
    upstream.on("error", () => { if (!response.headersSent) response.writeHead(502); response.end(); });
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBody) { upstream.destroy(); response.writeHead(413).end(); request.destroy(); return; }
      upstream.write(chunk);
    });
    request.on("end", () => upstream.end());
  }
}
