import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { BrowserHistoryRangeSchema, browserHistoryBetween, readBrowserLibrary, saveBrowserPage, changeBrowserLibrary } from './integrations/browser-library.js';
import type { createBranch } from './index.js';
import type { ToolContext } from './contracts.js';
import type { BrowserBinding, BrowserControl } from './browser-control.js';
import { BrowserControlError } from './browser-control.js';
import { profileNameSchema, isTrunkProfile, trunkProfileName } from './integrations/browser-profiles.js';
import { tryToolByHand, TryToolSchema } from './playground.js';
import { manualVerdict } from './tool-gate.js';
import { argumentFingerprint } from './runtime.js';
import { readPolicy } from './policy.js';
import { runOrigin, startedWithShortLivedKey } from './key-context.js';
import { currentPerson } from './people/context.js';
import { lockdownActive, onLockdownChange } from './lockdown.js';
import type { Page } from 'playwright';
import { BrowserDemonstrations, DemonstrationError, prepareDemonstratedInput, finishDemonstratedInput, type DemonstrationScope } from './browser-demonstrations.js';

type Branch = Awaited<ReturnType<typeof createBranch>>;
export const browserApiPath = '/api/panels/browser';
export const browserApiPaths = ['/api/panels/browser', '/api/panels/browser/start', '/api/panels/browser/control',
  '/api/panels/browser/library', '/api/panels/browser/action', '/api/panels/browser/disconnect', '/api/panels/browser/stop', '/api/panels/browser/demonstration'] as const;
export const handlesBrowserApiPath = (path: string): boolean => browserApiPaths.some(value => value === path);
const ScopeSchema = z.object({ sessionId: z.string().uuid(), profile: profileNameSchema.nullable(), clientId: z.string().uuid() }).strict();
const BoundSchema = ScopeSchema.extend({ id: z.string().uuid(), epoch: z.number().int().min(1) });
/** `runId`: take over that running task's own window, which becomes this conversation's kept browser. */
const StartSchema = ScopeSchema.extend({ confirmToken: z.string().uuid().optional(), runId: z.string().uuid().optional() });
const ControlSchema = BoundSchema.extend({ operation: z.enum(['takeover', 'handback']), runId: z.string().uuid().optional(), confirmToken: z.string().uuid().optional() });
const ActionSchema = BoundSchema.extend({ frameId: z.string().uuid(), sequence: z.number().int().min(1), tabId: z.string().uuid(),
  tool: z.enum(['browser.navigate', 'browser.tab', 'browser.owner_input', 'browser.pdf']), arguments: z.record(z.string(), z.unknown()), confirmToken: z.string().uuid().optional() });
const DemonstrationSchema = BoundSchema.extend({ tabId: z.string().uuid(), operation: z.enum(['start', 'preview', 'save', 'cancel']),
  name: z.string().trim().min(1).max(80).default('Learned browser workflow'), previewToken: z.string().uuid().optional() });
const LibrarySchema = z.discriminatedUnion('operation', [
  BoundSchema.extend({ operation: z.literal('list'), range: BrowserHistoryRangeSchema.optional() }),
  BoundSchema.extend({ operation: z.literal('bookmark'), frameId: z.string().uuid(), tabId: z.string().uuid() }),
  BoundSchema.extend({ operation: z.literal('remove'), entryId: z.string().uuid() }),
  BoundSchema.extend({ operation: z.literal('clear') }),
  BoundSchema.extend({ operation: z.literal('history'), enabled: z.boolean() }),
]);

type Scope = z.infer<typeof ScopeSchema>;
type Bound = z.infer<typeof BoundSchema>;
interface RequestAccess { authorize(): void; signal: AbortSignal }
interface Frame { id: string; epoch: number; tabId: string; page: object | null; url: string; ready: boolean; at: number }
interface Approval { key: string; until: number }
type Permit = { confirmed: boolean; policy: string };
type Question = { status: 'asked'; question: string; confirmToken: string } | { status: 'refused'; reason: string };
export class BrowserApiError extends Error { constructor(readonly status: number, message: string) { super(message); } }
export function requireBrowserOwner(app: Branch, fullWindowKey: boolean, throughDoor: boolean): void {
  if (!fullWindowKey || startedWithShortLivedKey() || currentPerson()) throw new BrowserApiError(403, 'Browser controls require this computer\'s full owner window key.');
  if (throughDoor) throw new BrowserApiError(403, 'Browser controls are available only in Branch\'s window on this computer.');
  if (!app.store.profiles.isOwner()) throw new BrowserApiError(403, 'Only the owner controls this browser.');
  if (app.sessionLock.shut()) throw new BrowserApiError(423, 'Branch is locked.');
  if (lockdownActive(app.store, app.runtime.owner)) throw new BrowserApiError(403, 'Lockdown is on, so browser controls are stopped.');
}
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Request authorization remains live; page ownership and confirmation never come from a model's arguments. */
export class BrowserControlApi {
  private frames = new Map<string, Frame>();
  private approvals = new Map<string, Approval>();
  private revisions = new Map<string, number>();
  private leases = new Map<string, { clientId: string; timer: ReturnType<typeof setTimeout> }>();
  private closed = false;
  private stopLockdown: () => void;
  private readonly demonstrations: BrowserDemonstrations;
  private readonly acting = new Set<string>();
  constructor(private readonly app: Branch) {
    this.demonstrations = new BrowserDemonstrations(value => app.store.secrets.scrubber.deep(value));
    this.stopLockdown = onLockdownChange((store, owner, on) => { if (store === app.store && owner === app.runtime.owner && on) this.revoke(); });
    app.channelHost.onLock(async () => { if (!this.closed) this.revoke(); });
    this.share();
  }
  /** The owner's own running tasks in a conversation work in its kept browser; nobody else's ever do. */
  private share(): void {
    const browser = this.app.browser;
    if (browser && !browser.sharesWith) browser.sharesWith = (owner, conversation, runId) => {
      if (this.closed || owner !== this.app.runtime.owner || lockdownActive(this.app.store, owner)) return false;
      try { this.liveRun({ owner, conversation, profile: null }, runId); return true; } catch { return false; }
    };
  }
  revoke(): void {
    this.demonstrations.clear();
    this.app.browser?.controls.revokeAll(); this.frames.clear(); this.approvals.clear();
    for (const { timer } of this.leases.values()) clearTimeout(timer);
    this.leases.clear();
  }
  private browser() {
    if (!this.app.browser) throw new BrowserApiError(503, 'Branch browser is not configured.');
    this.share();
    return this.app.browser;
  }
  private binding(input: Scope, access: RequestAccess): BrowserBinding {
    access.authorize(); access.signal.throwIfAborted();
    if (!this.app.store.ownsSession(this.app.runtime.owner, input.sessionId)) throw new BrowserApiError(404, 'Conversation not found.');
    const trunk = this.app.trunks.trunkForConversation(input.sessionId)?.trunkId;
    if (input.profile && isTrunkProfile(input.profile) && input.profile !== trunkProfileName(trunk ?? ''))
      throw new BrowserApiError(403, 'This browser profile belongs to another Trunk.');
    return { owner: this.app.runtime.owner, conversation: input.sessionId, profile: input.profile };
  }
  private bound(input: Bound, access: RequestAccess): { binding: BrowserBinding; control: BrowserControl } {
    const binding = this.binding(input, access), control = this.browser().controls.get(binding, input.id);
    if (control.view().epoch !== input.epoch) throw new BrowserApiError(409, 'Browser control changed; refresh before continuing.');
    return { binding, control };
  }
  private policy(): string { return digest(readPolicy(this.app.store, this.app.runtime.owner)); }
  private guard(binding: BrowserBinding, access: RequestAccess, policy?: string): () => void {
    const trunk = this.app.trunks.trunkForConversation(binding.conversation)?.trunkId;
    return () => {
      access.authorize(); access.signal.throwIfAborted();
      if (!this.app.store.ownsSession(binding.owner, binding.conversation)) throw new BrowserApiError(404, 'Conversation not found.');
      if (trunk !== this.app.trunks.trunkForConversation(binding.conversation)?.trunkId) throw new BrowserApiError(409, 'This conversation changed Trunks; refresh browser control.');
      if (policy && policy !== this.policy()) throw new BrowserApiError(409, 'Browser permissions changed; review the action again.');
    };
  }
  private context(binding: BrowserBinding, runId: string, signal: AbortSignal): ToolContext {
    const trunk = this.app.trunks.trunkForConversation(binding.conversation)?.trunkId;
    return { ...this.app.runtime.context({ runId, signal }), ...(trunk ? { trunk } : {}) };
  }
  private manualGuard(binding: BrowserBinding, access: RequestAccess, permit: Permit, context: ToolContext, tool: string, args: unknown,
    target?: () => void): () => void {
    const check = this.guard(binding, access, permit.policy);
    return () => {
      check(); target?.();
      const verdict = manualVerdict(this.app.runtime, tool, args, context, argumentFingerprint(tool, JSON.stringify(args)));
      if (verdict.decision === 'deny' || (verdict.decision === 'ask' && !permit.confirmed))
        throw new BrowserApiError(403, verdict.reason ?? 'Browser permission changed; review this action again.');
    };
  }
  private async withRun<T>(binding: BrowserBinding, access: RequestAccess, work: (context: ToolContext) => Promise<T>): Promise<T> {
    const run = this.app.store.createRun(binding.owner, 'Owner browser control', binding.conversation, false, 'window');
    let succeeded = false;
    try { const result = await work(this.context(binding, run.id, access.signal)); succeeded = true; return result; }
    finally {
      this.app.store.finish(run.id, succeeded ? 'completed' : 'failed', 'Owner browser control finished.', { mend: false });
      await this.browser().closeRun({ owner: binding.owner, runId: run.id });
    }
  }
  private permit(payload: unknown, context: ToolContext, tool: string, args: unknown, token?: string): Permit | Question {
    const verdict = manualVerdict(this.app.runtime, tool, args, context, argumentFingerprint(tool, JSON.stringify(args)));
    if (verdict.decision === 'deny') return { status: 'refused', reason: verdict.reason ?? 'Browser action is refused by your settings.' };
    const policy = this.policy(), key = digest([payload, policy, verdict.target]);
    if (token) {
      const approval = this.approvals.get(token); this.approvals.delete(token);
      if (!approval || approval.until < Date.now() || approval.key !== key) throw new BrowserApiError(409, 'That browser question expired or the action changed.');
      return { confirmed: true, policy };
    }
    if (verdict.decision === 'allow') return { confirmed: false, policy };
    for (const [id, approval] of this.approvals) if (approval.until < Date.now()) this.approvals.delete(id);
    if (this.approvals.size >= 32) throw new BrowserApiError(429, 'Too many browser questions are waiting.');
    const confirmToken = randomUUID(); this.approvals.set(confirmToken, { key, until: Date.now() + 60_000 });
    return { status: 'asked', question: `Allow ${tool}${verdict.target ? ` on ${verdict.target}` : ''} for this exact browser action?`, confirmToken };
  }
  private changed(id: string): void { this.frames.delete(id); this.revisions.set(id, (this.revisions.get(id) ?? 0) + 1); }
  private lease(input: Scope, control: BrowserControl, duration = 30_000): void {
    const view = control.view();
    if (view.writer?.kind !== 'owner' || view.writer.id !== input.clientId) return;
    const had = this.leases.get(view.id); if (had) clearTimeout(had.timer);
    const timer = setTimeout(() => { control.disconnect(input.clientId); this.demonstrations.clear(view.id); this.changed(view.id); this.leases.delete(view.id); }, duration);
    timer.unref?.(); this.leases.set(view.id, { clientId: input.clientId, timer });
  }
  private async start(input: z.infer<typeof StartSchema>, access: RequestAccess) {
    if (input.runId) return this.adopt(input, input.runId, access);
    const binding = this.binding(input, access);
    return this.withRun(binding, access, async context => {
      const { confirmToken, ...payload } = input, permit = this.permit(payload, context, 'browser.tab', { action: 'list' }, confirmToken);
      if ('status' in permit) return permit;
      const check = this.manualGuard(binding, access, permit, context, 'browser.tab', { action: 'list' }); check();
      const view = await this.browser().createControlled(binding, input.clientId, context);
      try { check(); } catch (error) { await this.browser().stopControlled(binding, view.id); throw error; }
      const control = this.browser().controls.get(binding, view.id); this.lease(input, control);
      return { status: 'ready', control: view };
    });
  }
  /** Take over a running task's own window: it becomes the kept browser, the owner drives, and the task waits. */
  private async adopt(input: z.infer<typeof StartSchema>, runId: string, access: RequestAccess) {
    const scope = this.binding({ ...input, profile: null }, access);
    this.liveRun(scope, runId);
    return this.withRun(scope, access, async context => {
      const { confirmToken, ...payload } = input, permit = this.permit(payload, context, 'browser.tab', { action: 'list' }, confirmToken);
      if ('status' in permit) return permit;
      this.manualGuard(scope, access, permit, context, 'browser.tab', { action: 'list' })();
      let control: BrowserControl;
      try { control = this.browser().adoptRun(scope.owner, scope.conversation, runId, input.clientId); }
      catch (error) { throw error instanceof BrowserControlError ? error : new BrowserApiError(409, error instanceof Error ? error.message : String(error)); }
      const binding = control.binding;
      if (binding.profile && isTrunkProfile(binding.profile)
        && binding.profile !== trunkProfileName(this.app.trunks.trunkForConversation(binding.conversation)?.trunkId ?? ''))
        throw new BrowserApiError(403, 'This browser profile belongs to another Trunk.');
      this.browser().bindControlledRun(binding, control.id, context);
      this.changed(control.id);
      const view = control.view().writer?.kind === 'owner' ? control.view() : await control.takeOver(control.view().epoch, input.clientId);
      this.lease({ ...input, profile: binding.profile }, control);
      return { status: 'ready', control: view };
    });
  }
  /** The conversation's kept browser, if it has one, so a window that reopened finds it again. */
  private find(input: Scope, access: RequestAccess) {
    this.binding(input, access);
    const found = this.app.browser?.controls.forConversation(this.app.runtime.owner, input.sessionId) ?? null;
    return found ? { status: 'found', control: found.view() } : { status: 'none' };
  }
  private async view(input: Bound, access: RequestAccess) {
    const { binding, control } = this.bound(input, access), revision = this.revisions.get(input.id) ?? 0;
    const context = this.context(binding, `browser-control:${input.id}`, access.signal);
    const check = this.manualGuard(binding, access, { confirmed: false, policy: this.policy() }, context, 'browser.snapshot', {}); check();
    const watched = await this.browser().watchControlled(binding, input.id); check();
    if (control.view().epoch !== input.epoch || revision !== (this.revisions.get(input.id) ?? 0)) return { status: 'changed', control: control.view() };
    const index = watched?.tabs.findIndex(tab => tab.active) ?? 0, tabId = control.view().tabs[Math.max(0, index)]!;
    const target = this.browser().controlledPageTarget(binding, input.id, tabId);
    const frame: Frame = { id: randomUUID(), epoch: input.epoch, tabId,
      page: target?.page ?? null, url: target?.url ?? '', ready: !!watched?.frame, at: Date.now() };
    this.frames.set(input.id, frame); this.lease(input, control);
    if (watched && !watched.borrowed) saveBrowserPage(this.app.store, binding.owner, this.libraryScope(binding), watched, false);
    return { status: 'ready', control: control.view(), frameId: frame.id, tabId, ready: frame.ready,
      page: watched ? { ...watched, frame: watched.frame?.toString('base64') ?? null } : null };
  }
  private libraryScope(binding: BrowserBinding): string {
    const trunk = this.app.trunks.trunkForConversation(binding.conversation)?.trunkId;
    return trunk ? `trunk:${trunk}` : `conversation:${binding.conversation}`;
  }
  private async library(input: z.infer<typeof LibrarySchema>, access: RequestAccess) {
    const { binding, control } = this.bound(input, access), scope = this.libraryScope(binding);
    const context = this.context(binding, `browser-control:${input.id}`, access.signal);
    const check = this.manualGuard(binding, access, { confirmed: false, policy: this.policy() }, context, 'browser.snapshot', {}); check();
    const current = () => {
      check();
      if (control.view().epoch !== input.epoch || scope !== this.libraryScope(binding)) throw new BrowserApiError(409, 'Browser scope changed; refresh before continuing.');
    };
    if (input.operation === 'list') {
      current();
      const library = readBrowserLibrary(this.app.store, binding.owner, scope);
      return { status: 'library', library: input.range ? browserHistoryBetween(library, input.range) : library };
    }
    const writer = control.view().writer;
    if (writer?.kind !== 'owner' || writer.id !== input.clientId) throw new BrowserApiError(409, 'Take over this browser before changing saved pages.');
    if (input.operation === 'bookmark') {
      const action = { ...input, sequence: control.view().sequence + 1, tool: 'browser.owner_input' as const, arguments: {} };
      this.frame(action, control);
      const watched = await this.browser().watchControlled(binding, input.id); current(); this.frame(action, control);
      if (!watched || watched.borrowed || watched.url !== this.frames.get(input.id)?.url) throw new BrowserApiError(409, 'The page changed; refresh before saving it.');
      return { status: 'library', library: saveBrowserPage(this.app.store, binding.owner, scope, watched, true) };
    }
    current(); this.lease(input, control);
    const value = input.operation === 'history' ? input.enabled : input.operation === 'remove' ? input.entryId : undefined;
    return { status: 'library', library: changeBrowserLibrary(this.app.store, binding.owner, scope, input.operation, value) };
  }
  private liveRun(binding: BrowserBinding, runId: string | undefined): string {
    const run = runId ? this.app.store.run(runId) : null;
    const origin = run ? runOrigin(this.app.store, run.id) : null;
    if (!run || run.owner !== binding.owner || run.sessionId !== binding.conversation || run.status !== 'running' || !this.app.runtime.activeRunSignal(run.id)
      || !origin || origin.source !== 'owner' || origin.shortLivedKey || origin.personProfileId || origin.lentTo)
      throw new BrowserApiError(403, 'Choose a currently running owner task in this conversation.');
    return run.id;
  }
  private async transfer(input: z.infer<typeof ControlSchema>, access: RequestAccess) {
    const { binding, control } = this.bound(input, access);
    return this.withRun(binding, access, async context => {
      this.browser().bindControlledRun(binding, input.id, context);
      const { confirmToken, ...payload } = input, permit = this.permit(payload, context, 'browser.tab', { action: 'select', index: 0 }, confirmToken);
      if ('status' in permit) { if (permit.status === 'asked') this.lease(input, control, 60_000); return permit; }
      const check = this.manualGuard(binding, access, permit, context, 'browser.tab', { action: 'select', index: 0 }); check(); this.changed(input.id);
      this.demonstrations.clear(input.id);
      if (input.operation === 'takeover') {
        const view = await control.takeOver(input.epoch, input.clientId);
        try { check(); } catch (error) { control.disconnect(input.clientId); throw error; }
        this.lease(input, control); return { status: 'ready', control: view };
      }
      const runId = this.liveRun(binding, input.runId), taskSignal = this.app.runtime.activeRunSignal(runId)!, task = this.context(binding, runId, taskSignal);
      this.browser().bindControlledRun(binding, input.id, task);
      taskSignal.addEventListener('abort', () => { this.browser().controls.finishRun(binding.owner, runId); }, { once: true });
      const view = await control.handBack(input.epoch, input.clientId, runId);
      try { check(); this.liveRun(binding, runId); } catch (error) { control.unbindRun(runId); throw error; }
      return { status: 'ready', control: view };
    });
  }
  private frame(input: z.infer<typeof ActionSchema>, control: BrowserControl): void {
    const view = control.view(), frame = this.frames.get(input.id);
    if (view.state !== 'owner' || view.writer?.id !== input.clientId || view.writer.kind !== 'owner'
      || input.sequence !== view.sequence + 1 || !view.tabs.includes(input.tabId)) throw new BrowserApiError(409, 'This window no longer holds those browser controls.');
    if (!frame || frame.id !== input.frameId || frame.epoch !== input.epoch || frame.tabId !== input.tabId || Date.now() - frame.at > 60_000)
      throw new BrowserApiError(409, 'The browser view changed; refresh before typing.');
    this.sameTarget(control.binding, control.id, frame);
    if (input.tool === 'browser.owner_input' && !frame.ready) throw new BrowserApiError(409, 'The browser page is not visible for input.');
  }
  private sameTarget(binding: BrowserBinding, id: string, frame: Frame): void {
    if (!frame.page) return; // The first Navigate itself opens this owned page.
    const target = this.browser().controlledPageTarget(binding, id, frame.tabId);
    if (!target || target.page !== frame.page || target.url !== frame.url)
      throw new BrowserApiError(409, 'The browser page changed; refresh before using this approval.');
  }
  /**
   * One input, answered with the page as it is afterwards: the window draws that picture at once instead of asking for
   * it in a second request (tests/owner-browser-speed.test.mjs measures click and key to picture).
   */
  private async action(input: z.infer<typeof ActionSchema>, access: RequestAccess) {
    const answer = await this.act(input, access);
    if (!('control' in answer)) return answer;
    const { id, epoch: _epoch, frameId: _frame, sequence: _sequence, tabId: _tab, tool: _tool, arguments: _args, confirmToken: _token, ...scope } = input;
    const view = await this.view({ ...scope, id, epoch: answer.control.epoch }, access).catch(() => null);
    return view?.status === 'ready' ? { ...answer, view } : answer;
  }
  private async act(input: z.infer<typeof ActionSchema>, access: RequestAccess) {
    const { binding, control } = this.bound(input, access); this.frame(input, control);
    const frame = this.frames.get(input.id)!;
    const args = this.app.registry.runArgs(input.tool, input.arguments);
    if (this.acting.has(input.id)) throw new BrowserApiError(409, 'A browser action is still running.');
    this.acting.add(input.id);
    return this.withRun(binding, access, async context => {
      this.browser().bindControlledRun(binding, input.id, context);
      const { confirmToken, ...payload } = input, permit = this.permit(payload, context, input.tool, args, confirmToken);
      if ('status' in permit) { if (permit.status === 'asked') this.lease(input, control, 60_000); return permit; }
      let effectStarted = false;
      const check = this.manualGuard(binding, access, permit, context, input.tool, args,
        () => { if (!effectStarted) this.sameTarget(binding, input.id, frame); });
      check(); this.frame(input, control);
      const capture = await this.prepareDemonstration(input, binding, args as Record<string, unknown>);
      check(); this.frame(input, control); this.changed(input.id);
      const result = await this.browser().ownerCommand(binding, input.id, { epoch: input.epoch, sequence: input.sequence,
        writer: { kind: 'owner', id: input.clientId }, tabId: input.tabId }, context, scoped =>
        tryToolByHand(this.app, TryToolSchema.parse({ name: input.tool, arguments: args, confirm: permit.confirmed, sessionId: input.sessionId }), scoped,
          () => ({ id: context.runId, done: () => undefined })), check, () => { effectStarted = true; });
      try { this.manualGuard(binding, access, permit, context, input.tool, args)(); }
      catch (error) { control.disconnect(input.clientId); throw error; }
      if (result.status === 'ran' && capture) await capture();
      this.lease(input, control); return { ...result, control: control.view() };
    }).finally(() => this.acting.delete(input.id));
  }
  private demonstrationScope(input: Bound & { tabId: string }, binding: BrowserBinding): DemonstrationScope {
    return { owner: binding.owner, conversation: binding.conversation, control: input.id, client: input.clientId, tab: input.tabId, epoch: input.epoch, profile: binding.profile };
  }
  private async prepareDemonstration(input: z.infer<typeof ActionSchema>, binding: BrowserBinding, args: Record<string, unknown>) {
    const scope = this.demonstrationScope(input, binding);
    if (!this.demonstrations.active(scope)) return null;
    if (input.tool === 'browser.navigate') return async () => this.demonstrations.append(scope, this.demonstrations.navigation(String(args.url)));
    if (input.tool === 'browser.tab') throw new BrowserApiError(409, 'Preview or cancel this single-tab demonstration before changing tabs.');
    const target = this.browser().controlledPageTarget(binding, input.id, input.tabId);
    if (!target) throw new BrowserApiError(409, 'The demonstration page is no longer available.');
    const page = target.page as Page, prepared = await prepareDemonstratedInput(page, args);
    return async () => {
      const entry = await finishDemonstratedInput(page, prepared).catch(() => ({ omission: 'This action could not be recorded reliably. Record a new demonstration.' }));
      this.demonstrations.append(scope, entry);
    };
  }
  private demonstration(input: z.infer<typeof DemonstrationSchema>, access: RequestAccess) {
    if (this.acting.has(input.id)) throw new BrowserApiError(409, 'Wait for the current browser action to finish.');
    const { binding, control } = this.bound(input, access), view = control.view();
    if (view.state !== 'owner' || view.writer?.kind !== 'owner' || view.writer.id !== input.clientId || !view.tabs.includes(input.tabId))
      throw new BrowserApiError(409, 'Take control of this browser before recording a demonstration.');
    const scope = this.demonstrationScope(input, binding);
    if (input.operation === 'cancel') { this.demonstrations.clear(input.id); return { status: 'cancelled' }; }
    if (input.operation === 'start') {
      const target = this.browser().controlledPageTarget(binding, input.id, input.tabId);
      this.demonstrations.start(scope, target?.url ?? 'about:blank'); return { status: 'recording' };
    }
    if (input.operation === 'preview') return { status: 'preview', ...this.demonstrations.preview(scope, input.name) };
    const definition = this.demonstrations.saved(scope, input.previewToken ?? '', input.name);
    const trunk = this.app.trunks.trunkForConversation(binding.conversation)?.trunkId;
    const workflow = this.app.workflows.create(this.app.workflows.forOwner(binding.owner), definition, trunk ? { given: trunk } : {});
    this.demonstrations.clear(input.id);
    return { status: 'saved', workflow };
  }
  async handle(method: string, path: string, body: unknown, access: RequestAccess): Promise<unknown> {
    if (this.closed) throw new BrowserApiError(503, 'Browser controls are closed.');
    access.authorize(); access.signal.throwIfAborted();
    if (method === 'GET' && path === browserApiPath) {
      const asked = body as { id?: unknown };
      return asked?.id ? this.view(BoundSchema.parse(body), access) : this.find(ScopeSchema.parse(body), access);
    }
    if (method !== 'POST') throw new BrowserApiError(405, 'Browser endpoint does not support that method.');
    if (path === `${browserApiPath}/start`) return this.start(StartSchema.parse(body), access);
    if (path === `${browserApiPath}/control`) return this.transfer(ControlSchema.parse(body), access);
    if (path === `${browserApiPath}/library`) return this.library(LibrarySchema.parse(body), access);
    if (path === `${browserApiPath}/action`) return this.action(ActionSchema.parse(body), access);
    if (path === `${browserApiPath}/demonstration`) return this.demonstration(DemonstrationSchema.parse(body), access);
    const input = BoundSchema.parse(body), { binding, control } = this.bound(input, access); this.changed(input.id);
    if (path === `${browserApiPath}/disconnect`) { this.demonstrations.clear(input.id); control.disconnect(input.clientId); return { status: 'ready', control: control.view() }; }
    if (path === `${browserApiPath}/stop`) {
      this.demonstrations.clear(input.id);
      await this.browser().stopControlled(binding, input.id); this.guard(binding, access)();
      const lease = this.leases.get(input.id); if (lease) clearTimeout(lease.timer);
      this.leases.delete(input.id); this.revisions.delete(input.id);
      return { status: 'stopped', control: control.view() };
    }
    throw new BrowserApiError(404, 'Browser endpoint not found.');
  }
  close(): void {
    this.revoke(); this.closed = true; this.stopLockdown();
    for (const { timer } of this.leases.values()) clearTimeout(timer);
    this.leases.clear(); this.frames.clear(); this.approvals.clear(); this.revisions.clear();
  }
  error(error: unknown): BrowserApiError {
    if (error instanceof DemonstrationError) return new BrowserApiError(error.status, error.message);
    return error instanceof BrowserApiError ? error : error instanceof BrowserControlError
      ? new BrowserApiError(409, error.message) : new BrowserApiError(500, 'Browser control did not finish. Refresh before continuing.');
  }
}
