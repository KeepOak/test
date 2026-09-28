import { execFile } from "node:child_process";
import { z } from "zod";
import { miniAppMount, miniAppPagePath } from "./door.js";

/**
 * Where the owner's phone can open the Telegram Mini App. Telegram only opens one from an HTTPS address; the owner's
 * Tailscale gives this computer one on its private tailnet name when `tailscale serve` forwards to the Mini App's door
 * (door.ts). This reads what `tailscale serve status --json` says and nothing more: the address is known only while
 * Tailscale really forwards an HTTPS path to that door, and is null otherwise.
 */
const HandlerSchema = z.object({ Proxy: z.string().max(500).optional() }).loose();
const WebSchema = z.record(z.string().max(300), z.object({ Handlers: z.record(z.string().max(300), HandlerSchema).optional() }).loose());
const ServeSchema = z.object({ Web: WebSchema.optional(), Foreground: z.record(z.string(), z.object({ Web: WebSchema.optional() }).loose()).optional() }).loose();

/** The Mini App's HTTPS address from `tailscale serve status --json`, when a path forwards to the door on `port`. */
export function readServe(json: string, port: number): string | null {
  let parsed: z.infer<typeof ServeSchema>;
  try { parsed = ServeSchema.parse(JSON.parse(json)); } catch { return null; }
  const webs = [parsed.Web ?? {}, ...Object.values(parsed.Foreground ?? {}).map((one) => one.Web ?? {})];
  for (const web of webs) {
    for (const [hostPort, site] of Object.entries(web)) {
      const [host, listen] = hostPort.split(":");
      if (!host || !/^[a-z0-9-]+(\.[a-z0-9-]+)*\.ts\.net$/i.test(host) || (listen ?? "443") !== "443") continue;
      for (const [mount, handler] of Object.entries(site.Handlers ?? {})) {
        const target = /^http:\/\/(127\.0\.0\.1|localhost):(\d+)(\/[^?#]*)?$/.exec(handler.Proxy ?? "");
        if (!target || Number(target[2]) !== port || !/^\/[a-z0-9/_-]*$/i.test(mount)) continue;
        // Tailscale forwards `mount` to the door's `target path`; the door reads both with or without /branch.
        const base = mount.replace(/\/$/, "");
        const forwarded = (target[3] ?? "").replace(/\/$/, "");
        if (forwarded && forwarded !== miniAppMount) continue;
        return `https://${host.toLowerCase()}${base}${miniAppPagePath}`;
      }
    }
  }
  return null;
}

export type Runner = (file: string, args: string[]) => Promise<string>;
export const runTailscale: Runner = (file, args) => new Promise((resolve, reject) => {
  execFile(file, args, { timeout: 15_000, windowsHide: true }, (error, stdout, stderr) =>
    (error ? reject(Object.assign(error, { stderr: String(stderr) })) : resolve(String(stdout))));
});

/**
 * What "Turn on phone access" and "Turn off" run, exactly as the owner is shown it before saying yes: Tailscale forwards
 * https://<this computer's tailnet name>/branch to the Mini App's door, in the background, until turned off. Only that
 * path is added or removed; the rest of the owner's own Tailscale setup is left as it is. Never `funnel`: the address
 * stays on the owner's private tailnet.
 */
export function serveCommand(turn: "on" | "off", port: number): string[] {
  return turn === "on"
    ? ["tailscale", "serve", "--bg", "--yes", "--https=443", `--set-path=${miniAppMount}`, `http://127.0.0.1:${port}`]
    : ["tailscale", "serve", "--yes", "--https=443", `--set-path=${miniAppMount}`, "off"];
}

/** Asks Tailscale at most once a minute; while it isn't installed or answers nothing useful, the address is null. */
export class PhoneAccess {
  private known: { url: string | null; at: number } | null = null;
  private asking: Promise<string | null> | null = null;
  constructor(private readonly port: () => number | null, private readonly run: Runner = runTailscale, private readonly now = Date.now) {}

  /** The last answer, asking again in the background when it is old; never waits. */
  address(): string | null {
    if (!this.known || this.now() - this.known.at > 60_000) void this.refresh();
    return this.known?.url ?? null;
  }
  /** The exact command for turning phone access on or off now, or null while the Mini App's door isn't open. */
  command(turn: "on" | "off"): string[] | null {
    const port = this.port();
    return port ? serveCommand(turn, port) : null;
  }
  /**
   * Runs the command the owner was shown and said yes to (`shown` must be exactly what `command` gives now), then asks
   * Tailscale again. Tailscale's own words come back when it refuses (HTTPS not turned on for the tailnet, say).
   */
  async turn(turn: "on" | "off", shown: readonly string[]): Promise<string | null> {
    const command = this.command(turn);
    if (!command) throw new Error("The Telegram Mini App's door isn't open, so there is nothing to forward to.");
    if (command.length !== shown.length || command.some((part, index) => part !== shown[index]))
      throw new Error("That isn't the command that runs now. Look at it again before saying yes.");
    await this.run(command[0]!, command.slice(1)).catch((error: unknown) => {
      const said = String((error as { stderr?: unknown }).stderr ?? "").trim() || (error instanceof Error ? error.message : String(error));
      throw new Error(`Tailscale said: ${said.slice(0, 400)}`);
    });
    this.known = null;
    return this.refresh();
  }
  refresh(): Promise<string | null> {
    this.asking ??= (async () => {
      const port = this.port();
      const url = port ? await this.run("tailscale", ["serve", "status", "--json"]).then((json) => readServe(json, port), () => null) : null;
      this.known = { url, at: this.now() };
      return url;
    })().finally(() => { this.asking = null; });
    return this.asking;
  }
}
