import { z } from "zod";

/**
 * The engine runs in a process of its own (src/desktop/engine-process.ts), started by the window's main process
 * (src/desktop/engine-host.ts), so no database query, big JSON or busy task in the engine can ever hold up the window,
 * the tray or Windows' "is this app still answering?" check. The two talk over Electron's private message channel
 * (a utility process's parentPort), never over the network. This file is what they say to each other, kept free of
 * Electron so it can be checked on its own.
 *
 * Everything that arrives is checked against these shapes first: the engine runs the owner's tasks and tools, so the
 * main process takes nothing from it that it did not expect.
 */

/** What main hands the engine when it starts it. The model key travels here, never in the engine's environment. */
/** hot-update: a live build in use: its change, its record's hash, its version and when it went into use. */
export const LiveInUseSchema = z.object({
  commit: z.string().regex(/^[0-9a-f]{40}$/), digest: z.string().regex(/^[0-9a-f]{64}$/), version: z.string().max(80), at: z.iso.datetime(),
}).strict();

export const EngineConfigSchema = z.object({
  dataDir: z.string().min(1).max(4096),
  workspace: z.string().min(1).max(4096),
  /** The saved model connection as provider variables, or null for none (or when the launch environment names one). */
  providerEnv: z.record(z.string(), z.string().max(32768)).nullable(),
  version: z.string().max(40),
  /** The installed program file, for the sign-in list and the terminal's `branch` command; null from source. */
  executable: z.string().max(4096).nullable(),
  installRoot: z.string().max(4096).nullable(),
  packaged: z.boolean(),
  /** macOS: the app's own login item as it is now; null elsewhere. */
  loginItem: z.object({ enabled: z.boolean(), needsApproval: z.boolean() }).nullable(),
  /** The window's main process, which the "already running here" note names: the app is closed only once it is gone. */
  appPid: z.number().int().positive(),
  /** Test builds only: lets a test block the engine on purpose (never set in a packaged app). */
  testHooks: z.boolean(),
  /** A detached desktop gateway owns the public address and running record; this worker uses an internal port. */
  gateway: z.boolean().optional(),
  /**
   * hot-update: the port to listen on, exactly, when a newer engine takes over from one the window already talks to (the
   * window's address must not change); left out, the port of last time is asked for and any free one taken instead.
   */
  port: z.number().int().min(1).max(65535).optional(),
  /** hot-update: tasks handed over by the engine this one replaces wait until main says this one passed its check. */
  holdHandedOver: z.boolean().optional(),
  /** hot-update: the program's own folder, which holds the live builds (src/hot-update/live-folder.ts). */
  appRoot: z.string().min(1).max(4096).optional(),
  /** hot-update: a live build whose window files are served instead of the engine's own (checked before use). */
  liveWindow: LiveInUseSchema.optional(),
}).strict();
export type EngineConfig = z.infer<typeof EngineConfigSchema>;

/**
 * hot-update: which version of these messages an engine speaks. A newer engine that speaks another is not handed the
 * window's work live: that update waits for the packaged swap, which replaces main and the engine together.
 */
export const engineContract = 1;
const id = z.number().int().nonnegative();
const call = z.object({ kind: z.literal("call"), id, method: z.string().max(40), args: z.unknown().optional() }).strict();
const reply = z.object({ kind: z.literal("reply"), id, ok: z.boolean(), value: z.unknown().optional(), error: z.string().max(2000).optional() }).strict();

/** What the Stop notice may say: Branch's own fixed words, but checked all the same before they reach a window. */
export const BannerNoticeSchema = z.object({
  title: z.string().max(200), text: z.string().max(500), button: z.string().max(60),
}).strict();

/** From the engine to main. */
export const FromEngineSchema = z.discriminatedUnion("kind", [
  /** hot-update: the engine's code is loaded and it waits to be started; the change it was built from, when recorded. */
  z.object({ kind: z.literal("loaded"), contract: z.number().int().min(1), commit: z.string().regex(/^[0-9a-f]{40}$/).nullable() }).strict(),
  z.object({ kind: z.literal("ready"), url: z.string().regex(/^http:\/\/127\.0\.0\.1:\d{1,5}$/), token: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  z.object({ kind: z.literal("key"), token: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  z.object({ kind: z.literal("failed"), message: z.string().max(2000) }).strict(),
  z.object({ kind: z.literal("event"), name: z.string().max(40), args: z.unknown().optional() }).strict(),
  call, reply,
]);
export type FromEngine = z.infer<typeof FromEngineSchema>;

/** From main to the engine. */
export const ToEngineSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("start"), config: EngineConfigSchema }).strict(),
  z.object({ kind: z.literal("event"), name: z.string().max(40), args: z.unknown().optional() }).strict(),
  call, reply,
]);
export type ToEngine = z.infer<typeof ToEngineSchema>;

type Handler = (args: unknown) => unknown;
type Outgoing = { kind: "call"; id: number; method: string; args?: unknown } | { kind: "reply"; id: number; ok: boolean; value?: unknown; error?: string };

/**
 * Asking and answering over one message channel, in both directions. A question with no answer in time is refused,
 * so neither side ever waits on the other for good; a channel that closes refuses every question still open.
 */
export class Link {
  private next = 1;
  private readonly waiting = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private readonly handlers = new Map<string, Handler>();
  constructor(private readonly post: (message: Outgoing) => void) {}

  handle(method: string, handler: Handler): void { this.handlers.set(method, handler); }

  call<T = unknown>(method: string, args?: unknown, timeoutMs = 30000): Promise<T> {
    const id = this.next++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error(`No answer to "${method}" within ${timeoutMs} ms`));
      }, timeoutMs);
      timer.unref?.();
      this.waiting.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      try { this.post({ kind: "call", id, method, ...(args === undefined ? {} : { args }) }); }
      catch (error) { clearTimeout(timer); this.waiting.delete(id); reject(error as Error); }
    });
  }

  /** A checked message of kind "call" or "reply"; anything else is the caller's. */
  receive(message: { kind: "call"; id: number; method: string; args?: unknown } | { kind: "reply"; id: number; ok: boolean; value?: unknown; error?: string | undefined }): void {
    if (message.kind === "reply") {
      const open = this.waiting.get(message.id);
      if (!open) return;
      this.waiting.delete(message.id);
      clearTimeout(open.timer);
      if (message.ok) open.resolve(message.value);
      else open.reject(new Error(message.error ?? "Refused"));
      return;
    }
    const handler = this.handlers.get(message.method);
    const answer = (ok: boolean, value?: unknown, error?: string) => {
      try { this.post({ kind: "reply", id: message.id, ok, ...(ok ? { value } : { error: (error ?? "Refused").slice(0, 2000) }) }); }
      catch { /* the other side has gone; nothing is waiting any more */ }
    };
    if (!handler) { answer(false, undefined, `Unknown request "${message.method}"`); return; }
    Promise.resolve().then(() => handler(message.args)).then((value) => answer(true, value), (error: unknown) => answer(false, undefined, error instanceof Error ? error.message : String(error)));
  }

  /** The channel closed: every question still open is refused. */
  close(why = "The engine stopped"): void {
    for (const [, open] of this.waiting) { clearTimeout(open.timer); open.reject(new Error(why)); }
    this.waiting.clear();
  }
}
