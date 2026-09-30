import { z } from 'zod';
import type { Page } from 'playwright';
import type { createBranch } from './index.js';
import { BrowserNetworkCapture, NetworkCaptureSchema } from './browser-network-capture.js';
import { CapturedApiSkills } from './captured-api-skills.js';
import { BrowserApiError } from './browser-control-api.js';
import { folderTrustMode } from './folder-trust.js';

type Branch = Awaited<ReturnType<typeof createBranch>>;
export const capturedApiSkillsPath = '/api/panels/browser/network';
const BoundSchema = z.object({ sessionId: z.string().uuid(), clientId: z.string().uuid(), profile: z.string().nullable(),
  id: z.string().uuid(), epoch: z.number().int().positive(), tabId: z.string().uuid() }).strict();
const RequestSchema = BoundSchema.extend({ operation: z.enum(['start', 'view', 'stop', 'draft', 'edit', 'test', 'install']),
  options: z.unknown().optional(), requestId: z.string().uuid().optional(), draftId: z.string().uuid().optional(),
  revision: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict();
type Bound = z.infer<typeof BoundSchema>;
interface Access { authorize(): void; signal: AbortSignal }
interface Capture { bound: Bound; capture: BrowserNetworkCapture }

/** This is deliberately an owner-window API, never a model-callable recording tool. */
export class CapturedApiSkillsApi {
  private captures = new Map<string, Capture>();
  readonly skills: CapturedApiSkills;
  constructor(private readonly app: Branch) {
    this.skills = new CapturedApiSkills(app.store, app.runtime.owner,
      { store: app.store, policy: app.web.policy, fetchImpl: app.web.policy.guard(globalThis.fetch) }, app.skillPackages);
  }
  close(): void { for (const item of this.captures.values()) item.capture.stop(); this.captures.clear(); }
  private checked(input: Bound, access: Access): Page {
    access.authorize(); access.signal.throwIfAborted();
    if (!this.app.store.ownsSession(this.app.runtime.owner, input.sessionId)) throw new BrowserApiError(404, 'Conversation not found.');
    const browser = this.app.browser;
    if (!browser) throw new BrowserApiError(503, 'Browser is not configured.');
    const binding = { owner: this.app.runtime.owner, conversation: input.sessionId, profile: input.profile };
    const control = browser.controls.get(binding, input.id).view();
    if (control.epoch !== input.epoch || control.writer?.kind !== 'owner' || control.writer.id !== input.clientId)
      throw new BrowserApiError(409, 'Take control of this browser before learning an API.');
    const target = browser.controlledPageTarget(binding, input.id, input.tabId);
    if (!target) throw new BrowserApiError(409, 'The selected tab is no longer available.');
    return target.page as Page;
  }
  private current(input: Bound): BrowserNetworkCapture {
    const entry = this.captures.get(input.id);
    if (!entry || entry.bound.tabId !== input.tabId || entry.bound.clientId !== input.clientId || entry.bound.epoch !== input.epoch)
      throw new BrowserApiError(404, 'No capture belongs to these browser controls.');
    return entry.capture;
  }
  private start(input: Bound, options: unknown, access: Access) {
    this.captures.get(input.id)?.capture.stop();
    const active = [...this.captures.values()].filter(entry => entry.capture.isActive()).length;
    if (active >= 5) throw new Error('Stop another browser capture first.');
    if (!this.captures.has(input.id) && this.captures.size >= 20) {
      const oldest = [...this.captures].find(([, entry]) => !entry.capture.isActive());
      if (oldest) this.captures.delete(oldest[0]);
    }
    const page = this.checked(input, access), parsed = NetworkCaptureSchema.parse(options);
    const capture = new BrowserNetworkCapture(page, parsed, () => {
      if (this.checked(input, access) !== page) throw new Error('The selected browser page changed.');
    });
    this.captures.set(input.id, { bound: input, capture }); return capture.view();
  }
  async handle(body: unknown, access: Access): Promise<unknown> {
    const input = RequestSchema.parse(body); this.checked(input, access);
    if (input.operation === 'start') return this.start(input, input.options, access);
    if (input.operation === 'view') return this.current(input).view();
    if (input.operation === 'stop') { const capture = this.current(input); capture.stop(); return capture.view(); }
    if (input.operation === 'draft') {
      const shape = this.current(input).view().requests.find(request => request.id === input.requestId);
      if (!shape) throw new Error('Select a request from this capture.');
      return this.skills.create(shape, input.options);
    }
    if (!input.draftId) throw new Error('Select an API skill draft.');
    if (input.operation === 'edit') return this.skills.edit(input.draftId, input.options);
    if (input.operation === 'install') return this.skills.install(input.draftId, input.revision ?? '');
    return this.test(input, access);
  }
  private async test(input: z.infer<typeof RequestSchema>, access: Access) {
    const project = this.app.store.projects.active(this.app.runtime.owner).id;
    const authorize = () => {
      this.checked(input, access);
      if (this.app.store.projects.active(this.app.runtime.owner).id !== project) throw new Error('The active project changed; test again.');
      if (folderTrustMode(this.app.store, this.app.runtime.owner) !== 'off' && this.app.runtime.guards.trust() === 'untrusted')
        throw new Error('Trust this workspace before testing an API skill.');
    };
    const run = this.app.store.createRun(this.app.runtime.owner, 'Test captured API skill', input.sessionId, false, 'window');
    let passed = false;
    try {
      const result = await this.skills.test(input.draftId!, input.options,
        this.app.runtime.context({ runId: run.id, signal: access.signal, permissions: ['skills.http'] }), authorize);
      passed = result.passed; return result;
    } finally { this.app.store.finish(run.id, passed ? 'completed' : 'failed', 'API skill test finished.', { mend: false }); }
  }
}
