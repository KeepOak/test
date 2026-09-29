import { z } from "zod";
import type { createBranch } from "../index.js";
import { BrowserApiError, browserApiPath, type BrowserControlApi } from "../browser-control-api.js";
import { BrowserControlError } from "../browser-control.js";
import { browserHolder, holdTaskBrowser, taskBrowser, type BrowserHoldDeps } from "../browser-hold.js";
import { lockdownActive, onLockdownChange } from "../lockdown.js";
import { AppLockRefusal } from "../session-lock.js";
import { MiniAppRefusal } from "./init-data.js";
import { miniAppTiming, type MiniAppSession } from "./sessions.js";

/**
 * The Telegram Mini App's way into one task's browser (docs/chat-parity.md, "Live screen and remote control from a
 * chat"). Browser controls are otherwise Branch's own window's alone (browser-control-api.ts requireBrowserOwner); this
 * is the one narrow way in from a phone, and each of its rules is checked here:
 * - the owner's own direct chat only: Telegram's signed launch data must name the person the task came from, in their
 *   private chat with the bot, and they must still be paired or on the owner's list;
 * - a fresh yes for every session: the App lock PIN, checked and counted like an unlock (none set: nothing opens);
 * - never under Lockdown or App lock, and every session ends the moment either comes on;
 * - it ends on its own after five idle minutes and after thirty whatever happens, and the phone can end it (End hands
 *   the browser back); Branch's window can take the browser from it at any time;
 * - every change of hands and every input is written on the task's record.
 * A session reaches that task's browser and nothing else: it is not a Branch key and every other route refuses it.
 */
type Branch = Awaited<ReturnType<typeof createBranch>>;
export const miniAppApiPrefix = "/api/miniapp/telegram/";
export const handlesMiniAppPath = (path: string): boolean => path.startsWith(miniAppApiPrefix);

const OpenSchema = z.object({ initData: z.string().max(8192), runId: z.string().uuid(), pin: z.string().min(1).max(64) }).strict();
const ControlSchema = z.object({ operation: z.enum(["take", "give"]) }).strict();
const ActionSchema = z.object({ id: z.string().uuid(), epoch: z.number().int().min(1), frameId: z.string().uuid(),
  sequence: z.number().int().min(1), tabId: z.string().uuid(), tool: z.enum(["browser.navigate", "browser.tab", "browser.owner_input"]),
  arguments: z.record(z.string(), z.unknown()), confirmToken: z.string().uuid().optional() }).strict();
const from = "telegram mini app";
const ended = "Your phone's hold on this browser ended. Open it again from your chat.";

export interface MiniAppRequest { method: string; token: string; body: () => Promise<unknown>; signal: AbortSignal }

export class MiniAppApi {
  private readonly stopLockdown: () => void;
  constructor(private readonly app: Branch, private readonly controls: BrowserControlApi) {
    this.stopLockdown = onLockdownChange((store, owner, on) => { if (store === app.store && owner === app.runtime.owner && on) this.sessions.endAll(); });
    app.channelHost.onLock(async () => { this.sessions.endAll(); });
  }
  private get sessions() { return this.app.miniAppSessions; }
  private deps(): BrowserHoldDeps {
    return { browser: this.app.browser, store: this.app.store, owner: this.app.runtime.owner,
      locked: () => this.app.sessionLock.locked(), running: (runId) => !!this.app.runtime.activeRunSignal(runId) };
  }
  close(): void { this.stopLockdown(); this.sessions.endAll(); }

  async handle(path: string, request: MiniAppRequest): Promise<unknown> {
    const name = path.slice(miniAppApiPrefix.length);
    if (name === "session" && request.method === "POST") return this.open(await request.body());
    const session = this.sessions.find(request.token);
    if (!session) throw new MiniAppRefusal(401, ended);
    const access = { authorize: () => this.check(request.token, session), signal: request.signal };
    access.authorize();
    if (name === "browser" && request.method === "GET") return this.view(session, access);
    if (request.method !== "POST") throw new MiniAppRefusal(404, "Not found.");
    if (name === "control") return this.control(session, ControlSchema.parse(await request.body()).operation);
    if (name === "action") return this.action(session, ActionSchema.parse(await request.body()), access);
    if (name === "end") return this.end(request.token, session);
    throw new MiniAppRefusal(404, "Not found.");
  }

  /** Everything that must still hold for this phone, asked again before every step it takes. */
  private check(token: string, session: MiniAppSession): void {
    const app = this.app;
    if (this.sessions.find(token) !== session) throw new MiniAppRefusal(401, ended);
    const refusal = lockdownActive(app.store, app.runtime.owner) ? new MiniAppRefusal(403, "Lockdown is on, so the browser can't be reached from your phone.")
      : app.sessionLock.locked() ? new MiniAppRefusal(423, "Branch is locked. Unlock it on your computer first.")
      : !app.store.profiles.isOwner() ? new MiniAppRefusal(403, "Only the owner can reach this browser.")
      : !app.channels.mayHoldBrowser(session.runId, session.channel, session.userId, session.userId) ? new MiniAppRefusal(403, ended)
      : !app.runtime.activeRunSignal(session.runId) ? new MiniAppRefusal(409, "That task has finished.") : null;
    if (refusal) { this.sessions.end(token); throw refusal; }
  }

  private open(body: unknown): unknown {
    const input = OpenSchema.parse(body), app = this.app;
    if (!app.sessionLock.pinSet())
      throw new MiniAppRefusal(409, "Set an App lock PIN in Branch's Settings first. It is asked each time your phone takes the browser.");
    if (lockdownActive(app.store, app.runtime.owner)) throw new MiniAppRefusal(403, "Lockdown is on, so the browser can't be reached from your phone.");
    if (app.sessionLock.locked()) throw new MiniAppRefusal(423, "Branch is locked. Unlock it on your computer first.");
    const came = app.channels.cameFrom(input.runId), adapter = came ? app.channels.adapter(came.channel) : undefined;
    if (!came || !adapter?.miniAppUser) throw new MiniAppRefusal(404, "That task didn't come from your Telegram chat.");
    const user = adapter.miniAppUser(input.initData);
    if (user.chatType !== null && user.chatType !== "sender" && user.chatType !== "private")
      throw new MiniAppRefusal(403, "Open it from your own chat with the bot, not from a group.");
    if (!app.channels.mayHoldBrowser(input.runId, came.channel, user.userId, user.userId))
      throw new MiniAppRefusal(403, "Only the person who started this task, in their own chat with the bot, can open its browser.");
    if (!app.runtime.activeRunSignal(input.runId)) throw new MiniAppRefusal(409, "That task has finished.");
    app.sessionLock.confirmPin(input.pin);
    const { token, session } = this.sessions.open({ userId: user.userId, channel: came.channel, runId: input.runId,
      conversation: app.store.run(input.runId)?.sessionId ?? "" });
    app.store.event(session.runId, "browser.hands", { from, channel: came.channel, opened: true });
    return { token, idleMs: miniAppTiming.idleMs, mostMs: miniAppTiming.mostMs, holder: this.holder(session) };
  }

  /** "you" while this phone holds it; otherwise who does. */
  private holder(session: MiniAppSession): "you" | "owner" | "task" | "none" {
    const control = taskBrowser(this.deps(), session.runId), writer = control?.view().writer;
    // No kept browser yet: the task is still working in its own window.
    return writer?.kind === "owner" && writer.id === session.clientId ? "you" : control ? browserHolder(control) : "task";
  }

  private async view(session: MiniAppSession, access: { authorize: () => void; signal: AbortSignal }): Promise<unknown> {
    const control = taskBrowser(this.deps(), session.runId);
    if (this.holder(session) === "you" && control) {
      const view = control.view();
      const answer = await this.controls.handle("GET", browserApiPath, { sessionId: session.conversation, clientId: session.clientId,
        profile: view.binding.profile, id: view.id, epoch: view.epoch }, access) as Record<string, unknown>;
      return { ...answer, holder: this.holder(session) };
    }
    // Before taking over, and while somebody else holds it: the page as the task sees it, to look at only.
    const watched = await this.app.browser?.watch(this.app.runtime.owner, session.runId) ?? null;
    access.authorize();
    return { status: "watching", holder: this.holder(session),
      page: watched ? { ...watched, frame: watched.frame?.toString("base64") ?? null } : null };
  }

  private async control(session: MiniAppSession, operation: "take" | "give"): Promise<unknown> {
    const mine = (holder: string): boolean => holder === session.clientId || holder === `chat:${session.runId}`;
    try {
      await holdTaskBrowser(this.deps(), session.runId, operation, session.clientId, mine);
    } catch (error) {
      if (error instanceof BrowserControlError || error instanceof MiniAppRefusal) throw error;
      throw new MiniAppRefusal(409, error instanceof Error ? error.message : String(error));
    }
    const holder = this.holder(session);
    this.app.store.event(session.runId, "browser.hands", { from, channel: session.channel,
      pressed: operation === "take" ? "take over" : "hand back", holder: holder === "you" ? "owner" : holder });
    return { status: "ready", holder };
  }

  private async action(session: MiniAppSession, input: z.infer<typeof ActionSchema>, access: { authorize: () => void; signal: AbortSignal }): Promise<unknown> {
    const control = taskBrowser(this.deps(), session.runId);
    if (!control || this.holder(session) !== "you" || control.view().id !== input.id)
      throw new MiniAppRefusal(409, "Take over first, then try again.");
    const answer = await this.controls.handle("POST", `${browserApiPath}/action`, { ...input, sessionId: session.conversation,
      clientId: session.clientId, profile: control.view().binding.profile }, access);
    this.app.store.event(session.runId, "browser.hands", { from, channel: session.channel, input: input.tool });
    return answer;
  }

  private async end(token: string, session: MiniAppSession): Promise<unknown> {
    if (this.holder(session) === "you") await this.control(session, "give");
    this.sessions.end(token);
    this.app.store.event(session.runId, "browser.hands", { from, channel: session.channel, ended: true });
    return { status: "ended" };
  }

  /** The HTTP answer for anything this refused. */
  error(error: unknown): { status: number; message: string } | null {
    if (error instanceof MiniAppRefusal || error instanceof AppLockRefusal) return { status: error.status, message: error.message };
    if (error instanceof BrowserApiError || error instanceof BrowserControlError) {
      const refused = this.controls.error(error);
      return { status: refused.status, message: refused.message };
    }
    return null;
  }
}
