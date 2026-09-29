import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { z } from "zod";
import type { Store } from "../store.js";

/**
 * The Telegram Mini App's own door: a small listener on this computer's loopback address that serves the Mini App's
 * page and its API (src/miniapp/api.ts), and nothing else of Branch. Telegram only opens a Mini App from an HTTPS
 * address, so the owner's Tailscale puts it on their private tailnet name with `tailscale serve` (phone-access.ts).
 * Pointing that at this door and not at Branch's own port matters: whatever Tailscale forwards arrives from
 * 127.0.0.1, and Branch's own port trusts that address as "this computer". Here every other path is a 404, so the
 * tailnet reaches the Mini App and never the rest of Branch.
 *
 * Tailscale may forward with the path it was mounted on (`/branch`) or without it; both are read the same.
 */
export const miniAppMount = "/branch";
export const miniAppPagePath = "/miniapp/telegram";
const files: Record<string, [string, string]> = {
  [miniAppPagePath]: ["miniapp/telegram/index.html", "text/html; charset=utf-8"],
  [`${miniAppPagePath}/app.js`]: ["miniapp/telegram/app.js", "text/javascript; charset=utf-8"],
  [`${miniAppPagePath}/style.css`]: ["miniapp/telegram/style.css", "text/css; charset=utf-8"],
};
const languages = new Set(["en", "fr", "de", "es"]);
/** Telegram opens the page in its own app, or framed in Telegram's web app; nothing else may frame it. */
const policy = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; "
  + "frame-ancestors https://web.telegram.org https://*.telegram.org; base-uri 'none'; form-action 'none'";
const SavedSchema = z.object({ port: z.number().int().min(1024).max(65535) }).strict();
const settingsId = "miniapp-door";

export type MiniAppApiHandler = (path: string, request: IncomingMessage, response: ServerResponse) => Promise<void>;

export class MiniAppDoor {
  private server: Server | null = null;
  constructor(private readonly store: Store, private readonly owner: string, private readonly api: MiniAppApiHandler) {}

  /** The port it listens on, or null while closed. */
  get port(): number | null { return (this.server?.address() as AddressInfo | null)?.port ?? null; }

  /**
   * Listens on the port it used before, so the owner's `tailscale serve` keeps pointing at it across restarts; the
   * first time (or when that port is taken now) any free one, which is then kept.
   */
  async open(): Promise<number> {
    const saved = SavedSchema.safeParse(this.store.get("settings", this.owner, settingsId)?.data ?? {});
    const port = await this.listen(saved.success ? saved.data.port : 0).catch(() => this.listen(0));
    if (!saved.success || saved.data.port !== port) this.store.save("settings", this.owner, settingsId, { port });
    return port;
  }
  private listen(port: number): Promise<number> {
    const server = createServer((request, response) => { void this.answer(request, response); });
    server.requestTimeout = 60_000; server.headersTimeout = 10_000;
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => {
        server.off("error", reject);
        this.server = server;
        resolve((server.address() as AddressInfo).port);
      });
    });
  }
  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return;
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
  }

  private async answer(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const raw = new URL(request.url ?? "/", "http://door").pathname;
      const path = raw === miniAppMount || raw.startsWith(`${miniAppMount}/`) ? raw.slice(miniAppMount.length) || "/" : raw;
      if (path.startsWith("/api/miniapp/telegram/")) { await this.api(path, request, response); return; }
      if (request.method !== "GET") { this.refuse(response, 405); return; }
      const words = /^\/miniapp\/telegram\/locales\/([a-z]{2})\.json$/.exec(path);
      if (words && languages.has(words[1]!)) { await this.words(words[1]!, response); return; }
      const file = Object.hasOwn(files, path) ? files[path]! : null;
      if (!file) { this.refuse(response, 404); return; }
      const body = await readFile(new URL(`../../public/${file[0]}`, import.meta.url));
      response.writeHead(200, { ...this.headers(), "content-type": file[1] });
      response.end(body);
    } catch {
      if (!response.headersSent) this.refuse(response, 500);
      else response.destroy();
    }
  }
  /** Only the Mini App's own words from a language's file, so the page never loads the whole app's. */
  private async words(language: string, response: ServerResponse): Promise<void> {
    const all = JSON.parse(await readFile(new URL(`../../public/locales/${language}.json`, import.meta.url), "utf8")) as Record<string, unknown>;
    const mine = Object.fromEntries(Object.entries(all).filter(([key]) => key.startsWith("miniapp.")));
    response.writeHead(200, { ...this.headers(), "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(mine));
  }
  private headers(): Record<string, string> {
    return { "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "content-security-policy": policy };
  }
  private refuse(response: ServerResponse, status: number): void {
    response.writeHead(status, { ...this.headers(), "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ error: status === 404 ? "Not found." : status === 405 ? "Not allowed." : "Something went wrong." }));
  }
}
