import { randomUUID } from 'node:crypto';
import { mkdir, open, rm, stat } from 'node:fs/promises';
import { dirname, join as joinPath } from 'node:path';
import type { Browser, Download, LaunchOptions, Locator, Page } from 'playwright';
import { chromium } from './playwright-lazy.js';
import { browserPaintWake } from './browser-paint-wake.js';
import { z } from 'zod';
import { WatchConditionSchema } from './browser-watch-condition.js';
import { instructionsRemovedNote, withoutInstructions } from '../content-guard.js';
import { carriedData } from '../egress-guard.js';
import type { ToolRegistry } from '../registry.js';
import type { ToolContext } from '../contracts.js';
import type { RunArtifacts } from '../artifacts.js';
import { BrowserSession, type BrowserRequest, type DownloadRecord } from './browser-session.js';
import { BrowserProfiles, profileNameSchema, trunkProfileName, isTrunkProfile, type StorageState } from './browser-profiles.js';
import {
  CODE_SIBLINGS, ExtractSchema, ScreenshotSchema, WaitSchema, clearSecretValues, extract, holdsSecret, liveFrame, plainValue, safeDownloadName,
  screenshot, scrubAddress, scrubAddresses, scrubMessage, scrubSnapshot, scrubText, secretValues, waitFor,
} from './browser-page.js';
import { AnnotateSchema, MarkRegistry, annotate, clearMarks, liveMarkKey, markLine } from './browser-marks.js';
import { ExtractSchemaSchema, extractSchema } from './browser-schema.js';
import { resolve as healResolve, type HealTarget } from './browser-heal.js';
import { SiteSkills, applyQuirks, type QuirksApplied } from './browser-sites.js';
import { consentNotice, rejectConsent } from './browser-consent.js';
import { attach, attachRefusal, attachedAddressRefusal, readAttachSettings, saveAttachSettings, type AttachedBrowser } from './browser-attach.js';
import { startRecording } from './browser-trace.js';
import { registerPageNotes } from './browser-notes-tool.js'; // w911 (A2144)
import { registerBrowserFlow } from './browser-flow.js'; // FQ-execution.browser
import type { MarkChecks } from './browser-heal.js'; // w911 (A2144)
import type { Store } from '../store.js';
import { audit } from '../audit.js';
import { browserCare, browserCareDefaults, downloadHeld, downloadNotKnown, marksOff, uploadsBlocked, type BrowserCare } from '../comfort/browser-safety.js'; // R17-S19
import { tmpdir } from 'node:os';
import { copyFile } from 'node:fs/promises';
import type { BrowserSandbox } from './browser-container.js'; // w911 (A2019) hook: import
import type { SignInBox, SignInPage } from '../vault-autofill.js'; // mac7/vault-autofill (R17-068)
import { whileSignInShows } from '../sign-in-showing.js'; // parity-b2 (review)
import { BrowserPinProxy, type PinRules } from './browser-pin-proxy.js';
import { BrowserControls, type BrowserBinding, type BrowserCommand, type BrowserControl, type BrowserWrite } from '../browser-control.js';
import { OwnerInputSchema, ownerPageInput, type OwnerInput } from './browser-owner-input.js';
import { platformFetch } from '../pinned-fetch.js';
import { ConsoleSchema, HistorySchema, HoverSchema, ImagesSchema, KeysSchema, NetworkSchema, ScrollSchema, SelectSchema,
  chooseOption, goInHistory, listImages, pressKeys, scrollPage } from './browser-actions.js';
import { detectInjection } from '../content-guard.js';
import { redactLeaksIn } from '../leak-guard.js';

export const BrowserConfigSchema = z.object({
  /** The only websites the browser may open, as exact origins. */
  allowedOrigins: z.array(z.string().url()).min(1).max(30).optional(),
  /**
   * Instead of a list: any website the shared network rules let Branch reach (never this computer or the home network
   * unless the owner allows them there). Every request a page makes is then held to those rules, not only the page.
   */
  anyWebsite: z.literal(true).optional(),
  channel: z.enum(['chrome', 'msedge']).optional(),
  maxRuns: z.number().int().min(1).max(30).default(8),
  /** Most browser actions one task may take before it has to stop and report back. */
  maxActionsPerRun: z.number().int().min(1).max(500).default(80),
  /** Most different websites one task may open. */
  maxOriginsPerRun: z.number().int().min(1).max(30).default(5),
  /** Largest file a website may send that is kept, in bytes. */
  maxDownloadBytes: z.number().int().min(1024).max(50 * 1024 * 1024).default(10 * 1024 * 1024),
  /** File endings that may be saved from a website. Anything else is refused and reported. */
  downloadTypes: z.array(z.string().regex(/^[a-z0-9]{1,8}$/)).max(40)
    .default(['pdf', 'csv', 'txt', 'md', 'json', 'xml', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'xlsx', 'docx', 'pptx', 'zip']),
}).strict().refine(config => (config.anyWebsite === true) !== (config.allowedOrigins !== undefined),
  'The browser takes either a list of websites (allowedOrigins) or anyWebsite, not both and not neither');
export type BrowserConfig = z.infer<typeof BrowserConfigSchema>;
/**
 * Branch's own browser ships on (the owner's rule: a useful feature is on by default). With no launch settings file it
 * may open any website the network rules allow, the way the owner's own browser would, under the owner's approval rules.
 */
export const defaultBrowserConfig: z.input<typeof BrowserConfigSchema> = { anyWebsite: true };
/** What a page that cannot open says when the small private browser Branch uses is not on this computer. */
export const missingBrowser = 'The private browser Branch uses is not installed on this computer. Run: npx playwright install chromium --only-shell (or branch doctor --fix), then try again.';
/** Whether a browser step failed only because its task reached the per-task limit on websites or actions. */
export const runLimitReached = (message: string): boolean => /^This task has already (opened|taken) \d+ /.test(message);
/** Where files a website sends are kept, inside the person's workspace. */
export const downloadFolder = 'downloads';
/** What the person is told when a task has wandered too far; it stops and reports instead. */
const originStop = (limit: number) =>
  `This task has already opened ${limit} different websites, which is as many as one task may. Stop, tell the person what you found and what you still wanted to look at, and let them decide.`;
const actionStop = (limit: number) =>
  `This task has already taken ${limit} browser actions, which is as many as one task may. Stop and tell the person what you have so far.`;

function originsOf(input: string[]): Set<string> {
  return new Set(input.map(value => {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.origin !== value)
      throw new Error('Browser allowlist entries must be exact HTTP(S) origins');
    return url.origin;
  }));
}
/** The paths a workspace file tool checks for the browser: the same confinement files.* uses. */
export interface WorkspacePaths { checked(path: string, allowRoot?: boolean): Promise<string> }
interface RunEntry {
  session: BrowserSession;
  detach: () => void;
  origins: Set<string>;
  actions: number;
  host: string;
  profile: string | null;
  /** The numbers handed out to the things on the pages this task has looked at. */
  marks: MarkRegistry;
  /** The address the task itself asked `navigate` for, already judged (and asked about) as that tool call. */
  asked?: string;
  /** The owner's own browser, while this task is borrowing it. */
  borrowed: AttachedBrowser | null;
  // w911 (A1726) hook: a benchmark window (see benchmarkWindow) — its one extra origin, and whether
  // the end of a task leaves it open for the benchmark to read and close itself.
  /**
   * mac7/vault-autofill (R17-068): the website of the last address this task opened by address, and
   * whether it has pressed anything since. Together they say whether the page it is on now was
   * reached from another website — which is what "a link in untrusted content" means here. Pressing
   * "Sign in" on the site whose address was opened is not that, and 2FA would be impossible if it were.
   */
  typedHost: string;
  pressed: boolean;
  granted?: string | undefined;
  held?: boolean | undefined;
  /** The sites the task's pages were shown on (Downloads may come from known sites only). */
  shown?: Set<string> | undefined;
  /** A recording started by Settings' "Record browser tasks", kept by itself when the task ends. */
  autoRecording?: boolean | undefined;
  /** Whether this task's Trunk's own saved sign-in was looked for (trunkProfile). */
  trunkChecked?: boolean;
  /**
   * live-stage: per page, the boxes a saved sign-in was typed into (with the rest of a split code beside each), covered
   * in every picture and taken out of every page text, for as long as that page shows the document they were typed
   * into (`document` is its performance.timeOrigin). Kept for the task's life, since each is only a selector.
   */
  filled: Map<Page, { document: number; boxes: Locator[] }>;
  /** What this task itself typed into a page, which is shown back to it even in the owner's own window. */
  typed: Set<string>;
  /**
   * The secret values a box of this task's window held at any step (the latest 64), kept for the task's life so a page
   * that carries one on in its address or title after the box is gone (a form sent to the next page) is still scrubbed.
   */
  seen: Set<string>;
  control?: BrowserControl;
  tabIds?: string[];
  agentSequence?: { epoch: number; next: number };
  budgets?: Map<string, { actions: number; origins: Set<string> }>;
}
/** live-stage: what the run's window shows now (BranchBrowser.watch). */
export interface WatchedWindow {
  url: string;
  title: string;
  tabs: { url: string; title: string; active: boolean; loading?: boolean; icon?: string }[];
  /** A JPEG of the tab being worked in, or null (a borrowed window, or no frame could be taken). */
  frame: Buffer | null;
  borrowed: boolean;
  /** The page is asking for a person: a sign-in (a password or one-time-code box) or a "prove you're a person" check. */
  needs?: 'sign-in' | 'captcha' | null;
  /** Completed files, confined to this session; source addresses contain only their origin. */
  downloads?: { file: string; bytes: number; from: string; saved: boolean }[];
}
/** w911 (A1726): a page Branch itself opened for a benchmark task, before the task starts. */
export interface BenchmarkWindow {
  /** Runs a script in the page and hands back its value. */
  evaluate<T>(script: string): Promise<T>;
  /** Makes this very page the one the task with this id works in. */
  handTo(runId: string): void;
  close(): Promise<void>;
}
/** Where the trace of one task is written, when the launch keeps traces. */
export interface BrowserTracer {
  start(runId: string, kind: 'tool', name: string, attributes?: Record<string, unknown>):
    { end(status: 'ok' | 'error', message?: string, attributes?: Record<string, string | number | boolean>): void } | null;
}

/** How many times in a row a site may send the browser onwards before it is simply refused. */
export const redirectHops = 5;
const ownerCommandScope = Symbol('Branch owner browser command');

export class BranchBrowser {
  private browser: Browser | undefined;
  private starting: Promise<Browser> | undefined;
  private closing: Promise<void> | undefined;
  private closed = false;
  private readonly sessions = new Map<string, RunEntry>();
  private readonly origins: Set<string>;
  private readonly config: BrowserConfig;
  readonly controls = new BrowserControls();
  private readonly controlled = new Map<string, RunEntry>();
  private readonly controlledOpening = new Map<string, Promise<RunEntry>>();
  private readonly ownerCommands = new WeakMap<object, { command: BrowserCommand; authorize?: () => void; effectStarted?: () => void }>();
  /**
   * Which tasks may work in a conversation's kept browser on their own: set by the owner's browser controls
   * (src/browser-control-api.ts) to the owner's own running tasks in that conversation. Unset, none do.
   */
  sharesWith: ((owner: string, conversation: string, runId: string) => boolean) | undefined;
  /**
   * Downloads ask each time: files a page sent, waiting outside the workspace for the owner's yes, by id. Kept in
   * memory for an hour (a task that stopped to ask carries on under its own conversation when the owner answers).
   */
  private readonly heldDownloads = new Map<string, { path: string; name: string; from: string; owner: string; conversation: string; at: number }>();
  /** Where held files wait: this computer's temporary folder, never the workspace. Replaced in tests. */
  heldFolder = joinPath(tmpdir(), 'branch-held-downloads');
  /** Each site's small icon for the owner's tabs, as a data: address ("" while unknown or when it has none). */
  private readonly icons = new Map<string, string>();
  constructor(input: unknown) {
    this.config = BrowserConfigSchema.parse(input);
    this.origins = originsOf(this.config.allowedOrigins ?? []);
  }
  /** Any website the network rules allow, rather than a list. */
  get anyWebsite(): boolean { return this.config.anyWebsite === true; }
  /**
   * Shared network policy; when set, navigation is checked against it as well as the origin list. Any-website mode also
   * needs `allowedAddresses`, which holds Chromium's connections to the addresses the check judged (browser-pin-proxy.ts).
   */
  policy: ({ assertAllowed(target: URL, what?: string): Promise<void> } & Partial<PinRules>) | undefined;
  /** Any-website mode: the local door every connection of Branch's own Chromium goes through. */
  private pinProxy: BrowserPinProxy | undefined;
  private pinServer: Promise<string> | undefined;
  /** Saved sign-ins, encrypted beside the private database. */
  profiles: BrowserProfiles | undefined;
  /** Where screenshots and saved pages are kept. */
  artifacts: RunArtifacts | undefined;
  /** The workspace, for files sent to a website and files a website sends back. */
  files: WorkspacePaths | undefined;
  /** Where a task's steps are written down, so a healed action can say which way worked. */
  tracer: BrowserTracer | undefined;
  /** The settings store, so "let Branch use my browser" can be read again before every attach. */
  store: Store | undefined;
  /** Opens a connection to the owner's own browser. Replaced in tests by one they start themselves. */
  connect: typeof attach = attach;
  /** w911 (A2019) hook: the browser sandbox (Docker or a remote Playwright server); unset means this computer only. */
  sandbox: BrowserSandbox | undefined;
  /**
   * The site skills this owner has installed: the quirks of particular websites, kept in the skill
   * that knows about the site rather than in this tool. Left unset, no site has any quirks.
   */
  siteSkills: ((owner: string) => SiteSkills) | undefined;

  /**
   * The secret values this launch has unlocked (src/egress-guard.ts). A page the browser is sent to whose address
   * carries one, or a card or account number (a form sent by address, a link, a redirect), is not opened.
   */
  egressSecrets: (() => readonly string[]) | undefined;
  /** R17-S19: the owner's browser care (Settings › Computer & browser); defaults without a store. */
  private care(owner: string): BrowserCare {
    return this.store ? browserCare(this.store, owner) : browserCareDefaults;
  }
  /** A1726: besides the listed websites, the one address this run was granted (the local task page). */
  private allowed(value: string, entry?: RunEntry): boolean {
    try {
      const url = new URL(value), origin = url.origin;
      if (this.anyWebsite && ['http:', 'https:'].includes(url.protocol)) return true;
      return this.origins.has(origin) || (!!entry?.granted && entry.granted === origin);
    } catch { return false; }
  }
  /** Checks Chromium's actual request, including each redirect destination, before it is sent. */
  private async guardRequest(request: BrowserRequest, entry?: RunEntry): Promise<void> {
    if (!this.allowed(request.url, entry)) throw new Error('Browser destination is not an allowed origin');
    const target = new URL(request.url);
    // With no list, nothing but the network rules keeps a page's pictures, scripts and fetches away from this computer
    // and the home network, so every request is held to them, not only the page itself.
    if (this.anyWebsite && entry?.granted !== target.origin) await this.pinRules().allowedAddresses(target, 'browser address');
    // Playwright says 'document' and Chromium's pause says 'Document'; both are the same navigation.
    if (request.resourceType.toLowerCase() !== 'document') return;
    const carried = this.egressSecrets && request.url !== entry?.asked ? carriedData(request.url, this.egressSecrets()) : null;
    if (carried) throw new Error(`That page's address would carry ${carried} out of Branch, so it was not opened`);
    if (entry?.granted !== target.origin && !this.anyWebsite)
      await this.policy?.assertAllowed(target, 'browser address');
    // How many different websites a task may visit is charged here, where every real navigation
    // passes — including the ones a site sends the browser to. Charging it only where an address is
    // typed meant going straight to a second website was refused and being *sent* there was not, so a
    // chain of redirects could walk a task across every allowed website for the price of one.
    // `Document` is the boundary: a page fetching a picture from a CDN it was allowed is not the task
    // visiting a website, and counting those would refuse ordinary pages.
    if (!entry || entry.origins.has(target.origin)) return;
    if (entry.origins.size >= this.config.maxOriginsPerRun) throw new Error(originStop(this.config.maxOriginsPerRun));
    entry.origins.add(target.origin);
  }
  /** The network rules any-website mode relies on; without them it opens nothing at all. */
  private networkRules(): { assertAllowed(target: URL, what?: string): Promise<void> } {
    if (!this.policy) throw new Error('The browser opens any website only under the network rules, and none are set');
    return this.policy;
  }
  /** The network rules as any-website mode uses them: every check, and every connection held to what it judged. */
  private pinRules(): PinRules {
    const rules = this.networkRules() as Partial<PinRules>;
    if (typeof rules.allowedAddresses !== 'function')
      throw new Error('The browser opens any website only under network rules that hold its connections to the addresses they checked');
    return rules as PinRules;
  }
  /**
   * Any-website mode: Chromium connects only through the local door, which dials the addresses the network rules judged
   * for that name, so a site cannot pass the check with one answer and be reached at another (DNS rebinding).
   * `<-loopback>` sends this computer's own addresses through the door too, and WebRTC is kept to proxied connections.
   */
  private async pinning(): Promise<Pick<LaunchOptions, 'proxy' | 'args'>> {
    if (!this.anyWebsite) return {};
    const rules = this.pinRules();
    this.pinProxy ??= new BrowserPinProxy({ rules: () => rules,
      granted: (host, port) => [...this.sessions.values()].some(entry => entry.granted === `http://${host}:${port}`) });
    const server = await (this.pinServer ??= this.pinProxy.start().catch((error: unknown) => { this.pinServer = undefined; throw error; }));
    return { proxy: { server, bypass: '<-loopback>' },
      args: ['--force-webrtc-ip-handling-policy', '--webrtc-ip-handling-policy=disable_non_proxied_udp'] };
  }
  private async launch(): Promise<Browser> {
    const env = Object.fromEntries(['PATH', 'SystemRoot', 'LOCALAPPDATA', 'TEMP', 'TMP', 'HOME']
      .flatMap(key => process.env[key] ? [[key, process.env[key]!]] : []));
    const pinned = await this.pinning();
    const browser = await (await chromium()).launch({ headless: true, env, ...pinned,
      ...(this.config.channel ? { channel: this.config.channel } : {}) }).catch((error: unknown) => {
      // Said the way `branch doctor` says it (src/doctor-fix.ts), not as Playwright's own instructions.
      if (!this.config.channel && /Executable doesn't exist/i.test(error instanceof Error ? error.message : String(error)))
        throw new Error(missingBrowser);
      throw error;
    });
    this.browser = browser;
    if (this.closed) { await browser.close(); throw new Error('Browser is closed'); }
    return browser;
  }
  private key(context: Pick<ToolContext, 'owner' | 'runId'>): string {
    if (!context.owner || !context.runId) throw new Error('Browser requires an owner and run ID');
    return JSON.stringify([context.owner, context.runId]);
  }
  private entry(context: ToolContext): RunEntry {
    if (this.closed) throw new Error('Browser is closed');
    const key = this.key(context), existing = this.sessions.get(key) ?? this.sharedFor(context);
    if (existing) {
      if (existing.control?.view().state === 'stopped') throw new Error('This browser was stopped.');
      return existing;
    }
    if (new Set([...this.sessions.values(), ...this.controlled.values()]).size >= this.config.maxRuns) throw new Error('Browser active run limit reached');
    // A1726: the run entry is named here so the route rule can read the address this run was granted.
    let created: RunEntry | undefined = undefined;
    // w911 (A2019) hook: the sandbox decides per task at first launch; null keeps the local launch below.
    const session: BrowserSession = new BrowserSession(
      () => this.sandbox?.pick(context.owner, !!session.options.storageState) ?? (this.starting ??= this.launch()),
      request => this.guardRequest(request, created), redirectHops);
    session.options.saveDownload = download => this.saveDownload(download, context, created);
    session.options.dialogAnswer = () => this.care(context.owner).dialogs; // R17-S19
    const cancel = () => { void this.closeRun(context).catch(() => undefined); };
    context.signal.addEventListener('abort', cancel, { once: true });
    created = { session, origins: new Set(), actions: 0, host: '', profile: null,
      marks: new MarkRegistry(), borrowed: null, typedHost: '', pressed: false, filled: new Map(), typed: new Set(), seen: new Set(),
      detach: () => context.signal.removeEventListener('abort', cancel) };
    this.sessions.set(key, created);
    return created;
  }

  /**
   * A Trunk's task works in its conversation's kept browser (the one the owner opened or took over), so what the owner
   * signed into and left open is where the task carries on. Only the owner's own tasks in that conversation, and never
   * one using another Trunk's saved sign-in.
   */
  private sharedFor(context: ToolContext): RunEntry | undefined {
    const run = typeof this.store?.run === 'function' ? this.store.run(context.runId) : undefined;
    if (!run?.sessionId || run.owner !== context.owner) return undefined;
    const control = this.controls.forConversation(context.owner, run.sessionId), entry = control && this.controlled.get(control.id);
    if (!control || !entry || !this.sharesWith?.(context.owner, run.sessionId, context.runId)) return undefined;
    const profile = control.binding.profile;
    if (profile && isTrunkProfile(profile) && profile !== trunkProfileName(context.trunk ?? '')) return undefined;
    this.controls.bindRun(control.binding, control.id, context.runId, true);
    this.sessions.set(this.key(context), entry);
    return entry;
  }
  /**
   * The owner takes over a running task's own window: it becomes the conversation's kept browser, the task keeps its
   * limits so far, and its next step waits for Hand back. A borrowed browser, a benchmark window and a window being
   * recorded are never taken over.
   */
  async adoptRun(owner: string, conversation: string, runId: string, clientId: string): Promise<BrowserControl> {
    const key = this.key({ owner, runId }), entry = this.sessions.get(key);
    if (entry?.control) {
      if (entry.control.binding.conversation !== conversation) throw new Error('This browser belongs to another conversation.');
      return entry.control;
    }
    if (!entry || !entry.session.started()) throw new Error('That task has no browser page open.');
    if (entry.borrowed || entry.session.isBorrowed()) throw new Error('That task is working in your own browser, so there is nothing to take over here.');
    if (entry.held) throw new Error('A benchmark window cannot be taken over.');
    // A recording Settings started is kept before the owner drives, so nothing the owner types is in it.
    if (entry.autoRecording) await this.keepAutoRecording(runId, entry);
    if (entry.session.isRecording()) throw new Error('That task is keeping a recording of its browser. Stop the recording before taking over.');
    if (this.sessions.get(key) !== entry || entry.control) throw new Error('That task\'s browser changed; try again.');
    const control = this.controls.adopt({ owner, conversation, profile: entry.profile }, clientId, runId, entry.session.tabs().length);
    entry.control = control;
    entry.tabIds = control.view().tabs;
    entry.budgets = new Map([[runId, { actions: entry.actions, origins: entry.origins }]]);
    entry.trunkChecked = true;
    this.controlled.set(control.id, entry);
    this.sessions.set(this.key({ owner, runId: `browser-control:${control.id}` }), entry);
    return control;
  }
  /** Creates a kept Branch-owned session before its first page; routes retain their existing caller/tool gates. */
  async createControlled(binding: BrowserBinding, clientId: string, context: ToolContext) {
    this.controlledScope(binding, context);
    const control = this.controls.ensure(binding, clientId), had = this.controlled.get(control.id);
    if (had) return this.bindControlledRun(binding, control.id, context);
    let opening = this.controlledOpening.get(control.id);
    if (!opening) {
      opening = this.openControlledEntry(binding, control, context);
      this.controlledOpening.set(control.id, opening);
      void opening.finally(() => this.controlledOpening.delete(control.id)).catch(() => undefined);
    }
    await opening;
    context.signal.throwIfAborted();
    return this.bindControlledRun(binding, control.id, context);
  }
  private async openControlledEntry(binding: BrowserBinding, control: BrowserControl, context: ToolContext): Promise<RunEntry> {
    const entry = this.entry(context);
    if (entry.control || entry.borrowed || entry.session.started())
      throw new Error('Choose the shared browser session before opening a page or borrowing a browser.');
    entry.control = control;
    entry.tabIds = control.view().tabs;
    entry.budgets = new Map();
    entry.trunkChecked = true; // The explicitly selected profile, including none, stays fixed.
    try {
      if (binding.profile) {
        const state = await this.requireProfiles().load(binding.owner, binding.profile);
        if (!state) throw new Error(`There is no saved sign-in called "${binding.profile}"`);
        entry.session.options.storageState = state; entry.profile = binding.profile;
      }
      context.signal.throwIfAborted();
      if (control.view().state === 'stopped') throw new Error('This browser was stopped.');
      entry.detach(); // A task ending releases its binding, rather than closing the shared page.
      this.controlled.set(control.id, entry);
      this.sessions.set(this.key({ owner: binding.owner, runId: `browser-control:${control.id}` }), entry);
      return entry;
    } catch (error) {
      control.stop(); entry.detach(); await entry.session.close();
      if (this.sessions.get(this.key(context)) === entry) this.sessions.delete(this.key(context));
      throw error;
    }
  }
  bindControlledRun(binding: BrowserBinding, id: string, context: ToolContext) {
    this.controlledScope(binding, context);
    const entry = this.controlled.get(id);
    if (!entry || entry.control?.view().state === 'stopped') throw new Error('Browser session not found.');
    const key = this.key(context), had = this.sessions.get(key);
    if (had && had !== entry) throw new Error('That task already has another browser window.');
    this.controls.bindRun(binding, id, context.runId);
    this.sessions.set(key, entry);
    return entry.control!.view();
  }
  private controlledScope(binding: BrowserBinding, context: ToolContext): void {
    context.signal.throwIfAborted();
    if (binding.owner !== context.owner) throw new Error('This browser belongs to another owner.');
    if (binding.profile && isTrunkProfile(binding.profile) && binding.profile !== trunkProfileName(context.trunk ?? ''))
      throw new Error('This browser profile belongs to another Trunk.');
    if (this.store) {
      const run = this.store.run(context.runId);
      if (!run || run.owner !== context.owner || run.sessionId !== binding.conversation)
        throw new Error('This browser belongs to another conversation.');
    }
  }
  /** A route supplies an exact owner command around one existing manually gated browser operation. */
  async ownerCommand<T>(binding: BrowserBinding, id: string, command: BrowserCommand, context: ToolContext,
    action: (scoped: ToolContext) => Promise<T>, authorize?: () => void, effectStarted?: () => void): Promise<T> {
    this.controlledScope(binding, context);
    const control = this.controls.get(binding, id), entry = this.sessions.get(this.key(context));
    if (entry?.control !== control || command.writer.kind !== 'owner') throw new Error('This task is not bound to the owner browser command.');
    const token = {};
    this.ownerCommands.set(token, { command: { ...command, writer: { ...command.writer } },
      ...(authorize ? { authorize } : {}), ...(effectStarted ? { effectStarted } : {}) });
    try { return await action({ ...context, [ownerCommandScope]: token } as ToolContext); }
    finally { this.ownerCommands.delete(token); }
  }
  async stopControlled(binding: BrowserBinding, id: string): Promise<void> {
    this.controls.stop(binding, id);
    const entry = this.controlled.get(id);
    if (!entry) return;
    this.controlled.delete(id);
    this.sessions.delete(this.key({ owner: binding.owner, runId: `browser-control:${id}` }));
    try { await this.keepSignIn(binding.owner, entry); }
    finally { await entry.session.close(); }
  }
  /** Uses the existing masked preview even after every task binding has ended. */
  async watchControlled(binding: BrowserBinding, id: string): Promise<WatchedWindow | null> {
    const control = this.controls.get(binding, id);
    const before = control.view(), page = this.controlled.get(id)?.session.watched()?.page;
    const url = page?.url();
    if (before.state === 'stopped') return null;
    const frame = await this.watch(binding.owner, `browser-control:${id}`), after = control.view();
    if (before.epoch !== after.epoch || after.state === 'stopped' || this.controlled.get(id)?.session.watched()?.page !== page
      || page?.url() !== url) return null;
    return frame;
  }
  /** The exact native page behind a stable owned tab, used only to reject stale owner input. */
  controlledPageTarget(binding: BrowserBinding, id: string, tabId: string): { page: object; url: string } | null {
    const control = this.controls.get(binding, id), entry = this.controlled.get(id);
    if (!entry || entry.control !== control || control.view().state === 'stopped') return null;
    const index = entry.tabIds?.indexOf(tabId) ?? -1, page = entry.session.tabPage(index);
    return page && !page.isClosed() ? { page, url: page.url() } : null;
  }
  private async writeFor<T>(context: ToolContext, action: (write: BrowserWrite | null, signal: AbortSignal) => Promise<T>): Promise<T> {
    const entry = this.entry(context), control = entry.control;
    if (!control) return action(null, context.signal);
    const token = (context as ToolContext & { [ownerCommandScope]?: object })[ownerCommandScope];
    const own = token && this.ownerCommands.get(token);
    if (!own) await control.agentTurn(context.runId, context.signal);
    const view = control.view();
    own?.authorize?.();
    const sequence = entry.agentSequence?.epoch === view.epoch ? entry.agentSequence.next : 1;
    const active = entry.session.tabs().find(tab => tab.active)?.index ?? 0;
    const command: BrowserCommand = own?.command ?? { epoch: view.epoch, sequence,
      writer: { kind: 'agent', id: context.runId }, tabId: entry.tabIds![active]! };
    const result = control.write(command, async write => {
      const signal = AbortSignal.any([context.signal, write.signal]);
      signal.throwIfAborted();
      const guarded = { ...write, check: () => { write.check(); signal.throwIfAborted(); own?.authorize?.(); } };
      const budget = entry.budgets!.get(context.runId) ?? { actions: 0, origins: new Set<string>() };
      entry.budgets!.set(context.runId, budget);
      entry.actions = budget.actions; entry.origins = budget.origins;
      try {
        if (own && entry.session.started()) await entry.session.selectTab(entry.tabIds!.indexOf(command.tabId), signal);
        guarded.check();
        return await action(guarded, signal);
      } finally { budget.actions = entry.actions; }
    });
    if (!own) entry.agentSequence = { epoch: view.epoch, next: sequence + 1 };
    return result;
  }
  /** Available only inside an exact ownerCommand capability; model arguments never provide this grant. */
  async ownerInput(input: OwnerInput, context: ToolContext) {
    const token = (context as ToolContext & { [ownerCommandScope]?: object })[ownerCommandScope];
    if (!token || !this.ownerCommands.has(token) || !this.entry(context).control)
      throw new Error('Page input requires the owner window\'s current browser grant.');
    if (this.entry(context).session.isRecording()) throw new Error('Stop the browser recording before typing directly into this page.');
    const control = this.entry(context).control!;
    try { return await this.operation(context, (page, check) => ownerPageInput(page, input, check)); }
    catch {
      if (input.kind === 'drag') await this.stopControlled(control.binding, control.id).catch(() => undefined);
      throw new Error('The page input did not finish. Refresh browser control before continuing.');
    }
  }
  /**
   * Browser profiles that stay signed in, per Trunk: a Trunk's task opens its first page with that Trunk's own saved
   * sign-in when it has kept one (browser.profile "keep"), and writes it back when the task ends, so it doesn't sign in
   * every time. Another Trunk, and Branch itself, never open it.
   */
  private async trunkProfile(context: ToolContext, entry: RunEntry): Promise<void> {
    if (entry.trunkChecked || entry.profile || !context.trunk || !this.profiles || entry.session.started()) return;
    entry.trunkChecked = true;
    const name = trunkProfileName(context.trunk), state = await this.profiles.load(context.owner, name).catch(() => null);
    if (!state || entry.session.started()) return;
    entry.session.options.storageState = state;
    entry.profile = name;
  }
  private markOwnerEffect(context: ToolContext): void {
    const token = (context as ToolContext & { [ownerCommandScope]?: object })[ownerCommandScope];
    if (token) this.ownerCommands.get(token)?.effectStarted?.();
  }
  private async operation<T extends object>(context: ToolContext, action: (page: Page, check: () => void) => Promise<T>, graceMs = 0, before?: () => Promise<void>): Promise<T> {
    return this.writeFor(context, async (write, signal) => {
      signal.throwIfAborted();
      const entry = this.entry(context);
      await this.trunkProfile(context, entry);
      if (before) await before();
      write?.check();
      if (++entry.actions > this.config.maxActionsPerRun) throw new Error(actionStop(this.config.maxActionsPerRun));
      try {
      const { result, hidden } = await entry.session.use({ ...context, signal }, page => this.scrubbingErrors(context, page, async page => {
        write?.check(); signal.throwIfAborted();
        this.markOwnerEffect(context);
        return action(page, () => { write?.check(); signal.throwIfAborted(); });
      }), graceMs);
      const events = entry.session.takeEvents();
      // A message box's words are page text and a download's source is an address: scrubbed the same way.
      const dialogs = events.dialogs.map(box => ({ ...box, message: hidden === null ? '' : scrubText(box.message, hidden) }));
      const downloads = events.downloads.map(file => ({ ...file, from: scrubAddress(file.from, hidden) }));
      return scrubAddresses({ ...result, ...(dialogs.length ? { messageBoxes: dialogs } : {}),
        ...(downloads.length ? { downloads } : {}) }, hidden);
      } finally { if (context.signal.aborted) await this.closeRun(context); }
    });
  }
  /**
   * Runs one step on the page. A page library's message quotes the boxes it found, attributes and all, so a message the
   * step fails with is scrubbed the way page text is (pageSecrets); when the page cannot be asked, only its first line,
   * before any quoted box, is kept.
   * The secrets the step's answer is scrubbed of (every address and title in it, `operation`) are read before the step
   * and after it: a form sent the way that puts its boxes into the next page's address leaves no box behind to read.
   * When the page cannot be asked after the step, `hidden` is null. While a recording is kept nothing is asked: what a
   * box holds, once read, would be written into the recording, so `hidden` is null then too.
   */
  private async scrubbingErrors<T>(context: ToolContext, page: Page, action: (page: Page) => Promise<T>): Promise<{ result: T; hidden: string[] | null }> {
    const asking = !this.entry(context).session.isRecording();
    const before = asking ? await this.pageSecrets(context, page).then(found => found.hidden, () => []) : [];
    try {
      const result = await action(page);
      const after = asking ? await this.pageSecrets(context, page).then(found => found.hidden, () => null) : null;
      return { result, hidden: after && this.remembered(context, [...before, ...after]) };
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      const hidden = await this.pageSecrets(context, page).then(found => found.hidden, () => null);
      const message = hidden ? scrubMessage(error.message, hidden) : error.message.split('\n')[0] ?? '';
      if (message !== error.message) { error.stack = `${error.name}: ${message}`; error.message = message; }
      throw error;
    }
  }
  /**
   * Whether this window may open `url` at all — the website list, no password in the address, and
   * the shared network policy — checked without touching the page. `navigate` asks before every
   * page it opens; `browser.flow` asks for every page of a journey before the first step runs.
   */
  async checkAddress(url: string, context: ToolContext): Promise<void> {
    const known = this.sessions.get(this.key(context));
    // Something that is not an address at all is refused in the same plain words as an address on
    // no list: `allowed` answers false for it, so the reason never becomes the URL parser's own.
    if (!this.allowed(url, known)) throw new Error('Browser destination is not an allowed origin');
    const target = new URL(url);
    if (target.username || target.password) throw new Error('Browser destination is not an allowed origin');
    // w911 (A1726): the one loopback page Branch itself serves to this window skips the network policy.
    if (known?.granted === target.origin) return;
    if (this.anyWebsite) await this.pinRules().allowedAddresses(target, 'browser address');
    else await this.policy?.assertAllowed(target, 'browser address');
  }
  async navigate(url: string, context: ToolContext) {
    const entry = this.entry(context);
    // In the owner's own browser the refusals that keep the screen control away from banks and
    // password managers apply to website names too.
    const refused = entry.borrowed ? attachedAddressRefusal(url, '', this.extraRefusedHosts(context.owner)) : null;
    if (refused) throw new Error(refused);
    entry.asked = URL.canParse(url) ? new URL(url).href : url;
    const opened = await this.operation(context, async (page, check) => {
      const origin = new URL(url).origin;
      if (!entry.origins.has(origin) && entry.origins.size >= this.config.maxOriginsPerRun)
        throw new Error(originStop(this.config.maxOriginsPerRun));
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      // Counted only once the page really opened, so a refused address costs the task nothing.
      entry.origins.add(origin);
      // mac7/vault-autofill: an address, not something somebody put on a page for Branch to press.
      // Read from where the page really ended up, never from the address that was asked for: an
      // open redirect on the address means the two are different websites, and a signal that lies
      // about which website the task is on is worse than no signal at all (integration review).
      entry.typedHost = hostOf(page.url()) || hostOf(url);
      (entry.shown ??= new Set()).add(new URL(page.url()).origin);
      entry.pressed = false;
      entry.host = new URL(url).host;
      check();
      const site = await this.quirks(context, page, url);
      const consent = await consentNotice(page);
      return { url: page.url(), title: await page.title(), ...(site ? { site } : {}),
        ...(consent.status !== 'not-found' ? { consent, next: consent.status === 'available'
          ? 'Use browser.act with action reject-consent to decline non-essential cookies under the interaction rules.'
          : consent.status === 'ambiguous' ? 'Cookie choices are ambiguous; hand the page to the owner rather than accept tracking.'
          : 'The cookie notice could not be inspected; do not assume consent was handled.' } : {}) };
    }, 0, () => this.checkAddress(url, context));
    await this.autoRecord(context, entry).catch(() => { entry.autoRecording = false; });
    return opened;
  }
  /** The quirks of this website, when a skill knows any, applied the moment the page has opened. */
  private async quirks(context: ToolContext, page: Page, url: string): Promise<QuirksApplied | null> {
    const known = this.siteSkills?.(context.owner)?.forUrl(url);
    // Pressing a notice is not reading, so a task allowed only to read is told what it would have
    // pressed rather than having a press made on its behalf.
    return known ? applyQuirks(page, known, context.permissions.has('browser.interact')) : null;
  }
  /**
   * Site skills: which websites a skill knows the quirks of, and the readings one of them names.
   * A reading is an ordinary shaped extraction the skill wrote down, so a task asks for "basket"
   * rather than working out the selectors of that site again.
   */
  async site(input: { action: 'list' | 'read'; name?: string | undefined }, context: ToolContext) {
    const skills = this.siteSkills?.(context.owner);
    if (!skills) throw new Error('Site skills are switched off for this launch');
    if (input.action === 'list') return { sites: skills.list() };
    const name = input.name ?? '';
    return this.operation(context, async page => {
      const known = skills.forUrl(page.url());
      if (!known) throw new Error(`No installed skill knows this website. Ask browser.site for the list of sites that have one.`);
      const reading = known.site.readings[name];
      if (!reading) throw new Error(`The skill "${known.skill}" has no reading called "${name}". `
        + `It has: ${Object.keys(known.site.readings).join(', ') || 'none'}.`);
      return { skill: known.skill, reading: name, ...await extractSchema(page, reading, (await this.pageSecrets(context, page)).hidden) };
    });
  }
  /** Wait for one explicit text condition, then preserve this exact page for the owner to take over. */
  async watchChange(input: z.infer<typeof WatchConditionSchema>, context: ToolContext) {
    const entry = this.entry(context), page = entry.session.watched()?.page;
    if (!page) throw new Error('Open the task browser page before starting a watch.');
    const url = page.url(), beforeEpoch = entry.control?.view().epoch;
    const scoped = () => {
      context.signal.throwIfAborted();
      const run = this.store?.run(context.runId);
      if (!this.store || !run || !['running', 'needs_input'].includes(run.status) || !this.store.profiles.isOwner() || this.store.profiles.scope() !== context.owner
        || run.owner !== context.owner || !this.store.ownsSession(context.owner, run.sessionId)
        || this.store.runs(context.owner).find(one => one.sessionId === run.sessionId)?.id !== run.id)
        throw new Error('This task no longer owns the current conversation.');
      if (entry.borrowed || entry.session.isBorrowed() || entry.held || entry.session.isRecording()
        || entry.session.watched()?.page !== page || page.isClosed() || page.url() !== url)
        throw new Error('This exact task page is no longer available for handoff.');
      if (entry.profile && isTrunkProfile(entry.profile) && entry.profile !== trunkProfileName(context.trunk ?? ''))
        throw new Error('This browser profile belongs to another Trunk.');
      if (entry.control && (entry.control.binding.owner !== context.owner || entry.control.binding.conversation !== run.sessionId
        || entry.control.binding.profile !== entry.profile)) throw new Error('This browser binding no longer matches the task.');
      return run;
    };
    scoped();
    let observed = false;
    try {
      await this.operation(context, async (working, check) => {
        scoped(); check();
        if (working !== page) throw new Error('The task page changed before the watch.');
        const matches = page.getByText(input.text, { exact: true }), locator = matches.first();
        if (await matches.count() > 1) throw new Error('The watched text is ambiguous on this page.');
        const initial = await locator.isVisible();
        if (initial === (input.state === 'appears')) return { observed: false };
        await locator.waitFor({ state: input.state === 'appears' ? 'visible' : 'hidden', timeout: input.timeoutMs });
        if (await matches.count() > 1 || await locator.isVisible() !== (input.state === 'appears'))
          throw new Error('The watched text became ambiguous or changed again.');
        check(); scoped(); observed = true;
        return { observed: true };
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError') { scoped(); return { changed: false, handedOff: false }; }
      throw error;
    }
    const run = scoped();
    if (!observed) return { changed: false, handedOff: false, alreadyMatched: true };
    if (entry.control && entry.control.view().epoch !== beforeEpoch) throw new Error('Browser control changed during the watch.');
    const control = entry.control ?? await this.adoptRun(context.owner, run.sessionId, context.runId, '');
    await control.offerToOwner(control.view().epoch, context.runId, () => { scoped(); });
    return { changed: true, handedOff: true, browserId: control.id, conversation: run.sessionId,
      note: 'The recorded text condition changed. This page is kept for your Take over; no owner input grant was issued.' };
  }
  /** The page's accessibility tree, with every value a box holds that the assistant must not read taken out (pageSecrets). */
  async snapshot(context: ToolContext) {
    return this.operation(context, async page => {
      const tree = await page.locator('body').ariaSnapshot();
      const { hidden, typed } = await this.pageSecrets(context, page);
      return pageText({ url: page.url(), accessibility: scrubSnapshot(tree, hidden, typed).slice(0, 16000) });
    });
  }
  /**
   * What page text handed to the assistant must not carry (src/integrations/browser-page.ts, secretValues): the values
   * of secret boxes and of boxes a saved sign-in typed into, and in the owner's own window, whatever this task did not
   * type itself (`typed`, null otherwise).
   */
  private async pageSecrets(context: ToolContext, page: Page): Promise<{ hidden: string[]; typed: ReadonlySet<string> | null }> {
    const entry = this.entry(context), typed = entry.borrowed ? entry.typed : null;
    return { hidden: await secretValues(page, this.filledOn(context, page), typed), typed };
  }
  async click(role: 'button' | 'link', name: string, context: ToolContext) {
    this.entry(context).pressed = true; // mac7/vault-autofill: wherever this lands came off a page
    return this.operation(context, async page => {
      await page.getByRole(role, { name, exact: true }).click();
      return { url: page.url(), clicked: name };
    }, 500);
  }
  async fill(label: string, value: string, context: ToolContext) {
    return this.operation(context, async (page, check) => {
      const locator = page.getByLabel(label, { exact: true });
      if ((await locator.getAttribute('type'))?.trim().toLowerCase() === 'password')
        throw new Error('Password fields require a dedicated credential integration');
      check();
      this.entry(context).typed.add(plainValue(value));
      await locator.fill(value); return { filled: label };
    });
  }
  /**
   * A picture of the page, kept beside the private database. Every secret in every frame is covered, and so is every
   * box a saved sign-in typed into, the same way the live stage covers them (src/integrations/browser-page.ts).
   */
  async screenshot(options: z.infer<typeof ScreenshotSchema>, context: ToolContext) {
    const artifacts = this.artifacts;
    if (!artifacts) throw new Error('Screenshots are switched off because there is nowhere to keep the picture');
    return this.operation(context, async page => {
      const element = options.name !== undefined || options.mark !== undefined ? await this.found(context, page, options) : undefined;
      const bytes = await screenshot(page, options, this.filledOn(context, page), element);
      const kept = await artifacts.write(context.runId, `screenshot-${randomUUID().slice(0, 8)}.png`, 'image/png', bytes);
      return { ...kept, url: page.url() };
    });
  }
  /** The page as a PDF, kept the same way a screenshot is. */
  async pdf(context: ToolContext) {
    const artifacts = this.artifacts;
    if (!artifacts) throw new Error('Saving a page is switched off because there is nowhere to keep the file');
    return this.operation(context, async page => {
      // A saved page is drawn by the browser itself, where nothing can be covered, so it is never made with a secret in it.
      if (await holdsSecret(page, this.filledOn(context, page)))
        throw new Error('This page holds a password or a sign-in code, so it cannot be saved. Take a screenshot instead.');
      const bytes = await page.pdf({ printBackground: true });
      const kept = await artifacts.write(context.runId, `page-${randomUUID().slice(0, 8)}.pdf`, 'application/pdf', bytes);
      return { ...kept, url: page.url() };
    });
  }
  /** One element by selector, by name or by its number from browser.annotate, healed by name if the page changed. */
  private async found(context: ToolContext, page: Page, target: HealTarget): Promise<Locator> {
    if (target.mark !== undefined && !this.care(context.owner).numberMarks) throw new Error(marksOff);
    const entry = this.entry(context);
    return (await healResolve(page, target, 2000, { keyOf: id => entry.marks.keyOf(id), liveKey: id => liveMarkKey(page, id) })).locator;
  }
  async scroll(input: z.infer<typeof ScrollSchema>, context: ToolContext) {
    return this.operation(context, async (page, check) => {
      const element = input.selector || input.name || input.mark ? await this.found(context, page, input) : null;
      check();
      return scrollPage(page, input, element);
    });
  }
  async hover(input: z.infer<typeof HoverSchema>, context: ToolContext) {
    return this.operation(context, async (page, check) => {
      const element = await this.found(context, page, input);
      check();
      await element.hover({ timeout: 5000 });
      return { url: page.url(), hovered: input.name ?? input.selector ?? `#${input.mark}` };
    });
  }
  async keys(input: z.infer<typeof KeysSchema>, context: ToolContext) {
    return this.operation(context, async (page, check) => { check(); return pressKeys(page, input); });
  }
  async select(input: z.infer<typeof SelectSchema>, context: ToolContext) {
    return this.operation(context, async (page, check) => {
      const element = await this.found(context, page, input);
      check();
      return { url: page.url(), ...await chooseOption(element, input) };
    });
  }
  /** The page's images as untrusted words: addresses without their query, and what the page says each shows. */
  async images(input: z.infer<typeof ImagesSchema>, context: ToolContext) {
    return this.operation(context, async page => {
      const { hidden } = await this.pageSecrets(context, page), found = await listImages(page, input);
      const images = found.images.map(image => ({ ...image, src: scrubAddress(image.src, hidden), alt: scrubText(image.alt, hidden) }));
      return { ...found, images: redactLeaksIn(images).value, untrusted: true };
    });
  }
  async history(input: z.infer<typeof HistorySchema>, context: ToolContext) {
    return this.operation(context, async (page, check) => { check(); return goInHistory(page, input.action); });
  }
  /**
   * What the task's pages logged (console lines and uncaught errors), newest last, as the website's own untrusted
   * words: the page's secrets and anything key-shaped are taken out, and words that try to give instructions are named.
   */
  async consoleLog(input: z.infer<typeof ConsoleSchema>, context: ToolContext) {
    return this.operation(context, async page => {
      const log = this.entry(context).session.log, { hidden } = await this.pageSecrets(context, page);
      const wanted = log.console.filter(line => input.level === 'all' || line.level === input.level
        || (input.level === 'warning' && line.level === 'error'));
      const lines = wanted.slice(-input.limit).map(line => ({ ...line, text: scrubText(line.text, hidden) }));
      if (input.clear) log.console.length = 0;
      const clean = redactLeaksIn(lines).value, warnings = detectInjection(clean.map(line => line.text).join('\n'));
      return { url: page.url(), lines: clean, more: Math.max(0, wanted.length - lines.length), untrusted: true,
        ...(warnings.length ? { warnings } : {}) };
    });
  }
  /** The requests the task's pages made: method, address without its query, kind, status or failure. Never headers or bodies. */
  async networkLog(input: z.infer<typeof NetworkSchema>, context: ToolContext) {
    return this.operation(context, async page => {
      const log = this.entry(context).session.log, { hidden } = await this.pageSecrets(context, page);
      const filter = input.filter?.toLowerCase();
      const wanted = log.requests.filter(request => (!input.failedOnly || request.failure || (request.status ?? 0) >= 400)
        && (!filter || request.url.toLowerCase().includes(filter) || request.kind === filter));
      const requests = wanted.slice(-input.limit).map(request => ({ ...request, url: scrubAddress(request.url, hidden) }));
      if (input.clear) log.requests.length = 0;
      return { url: page.url(), requests: redactLeaksIn(requests).value, more: Math.max(0, wanted.length - requests.length) };
    });
  }
  async wait(options: z.infer<typeof WaitSchema>, context: ToolContext) {
    return this.operation(context, page => waitFor(page, options));
  }
  async extract(options: z.infer<typeof ExtractSchema>, context: ToolContext) {
    return this.operation(context, async page => pageText(await extract(page, options, (await this.pageSecrets(context, page)).hidden)));
  }
  /** Data in the exact shape the assistant asked for, or a refusal naming the field that did not fit. */
  async extractShaped(options: z.infer<typeof ExtractSchemaSchema>, context: ToolContext) {
    return this.operation(context, async page => pageText(await extractSchema(page, options, (await this.pageSecrets(context, page)).hidden)));
  }
  /**
   * Numbers everything on the page that can be pressed or typed into and hands back the list. The
   * numbers belong to the things themselves, so they survive the page redrawing itself.
   */
  async annotate(options: z.infer<typeof AnnotateSchema>, context: ToolContext) {
    if (!this.care(context.owner).numberMarks) throw new Error(marksOff);
    const entry = this.entry(context);
    return this.operation(context, async page => {
      const found = await annotate(page, options, entry.marks);
      const { hidden } = await this.pageSecrets(context, page);
      const named = found.marks.map(mark => ({ ...mark, name: scrubText(mark.name, hidden) }));
      return { url: found.url, map: named.map(markLine).join('\n'), numbered: named.length, truncated: found.truncated,
        marks: named.map(mark => ({ id: mark.id, role: mark.role, name: mark.name })) };
    });
  }
  /** w911 (A2144): one read-only look at the page this task has open, with its numbers checkable. */
  async lookAtPage<T extends object>(context: ToolContext, look: (page: Page, checks: MarkChecks) => Promise<T>): Promise<T> {
    const entry = this.entry(context);
    return this.operation(context, page => look(page, { keyOf: id => entry.marks.keyOf(id), liveKey: id => liveMarkKey(page, id) }));
  }
  /** Takes the numbered labels off the page again. */
  async clearMarks(context: ToolContext) {
    return this.operation(context, async page => { await clearMarks(page); return { cleared: true, url: page.url() }; });
  }
  /**
   * Presses or types into a thing, trying several ways of finding it before giving up: the
   * selector given, what it is called, the words on it, then its number. The way that worked is
   * written into the task's trace.
   */
  async act(input: HealTarget & { action: 'click' | 'fill' | 'check' | 'press' | 'reject-consent'; value?: string | undefined }, context: ToolContext) {
    if (input.mark !== undefined && !this.care(context.owner).numberMarks) throw new Error(marksOff);
    const entry = this.entry(context);
    if (input.action === 'reject-consent') return this.operation(context, async (page, check) => {
      const consent = await rejectConsent(page, check);
      if (consent.rejected) entry.pressed = true;
      return { url: page.url(), consent };
    });
    if (input.action === 'click') entry.pressed = true; // mac7/vault-autofill
    // Dogfood D4: a key on the page itself (Escape on a cookie wall), in Branch's own browser and nowhere else.
    if (input.action === 'press') {
      const key = pageKey(input.value);
      return this.operation(context, async page => { await page.keyboard.press(key); return { url: page.url(), action: 'press', key }; });
    }
    return this.operation(context, async (page, check) => {
      const found = await healResolve(page, input, 2000,
        { keyOf: id => entry.marks.keyOf(id), liveKey: id => liveMarkKey(page, id) });
      check();
      if (input.action === 'fill') {
        if ((await found.locator.getAttribute('type'))?.trim().toLowerCase() === 'password')
          throw new Error('Password fields require a dedicated credential integration');
        check();
        entry.typed.add(plainValue(input.value ?? ''));
        await found.locator.fill(input.value ?? '');
      } else if (input.action === 'check') await found.locator.check();
      else await found.locator.click();
      this.noteHealing(context, entry, input.action, found.way, found.attempts);
      return { url: page.url(), action: input.action, foundBy: found.way, attempts: found.attempts, tried: found.tried };
    }, input.action === 'click' ? 500 : 0);
  }
  /** Writes down which way of finding the thing worked, so a step that keeps healing can be fixed. */
  private noteHealing(context: ToolContext, entry: RunEntry, action: string, way: string, attempts: number): void {
    const span = this.tracer?.start(context.runId, 'tool', `browser.act ${action}`,
      { host: entry.host, foundBy: way, attempts });
    span?.end('ok', '', { foundBy: way, attempts, healed: way !== 'selector' });
  }
  /** Sends one file from the person's workspace to a file box on the page. */
  /**
   * Sends files from the workspace to a file box on the page, found by selector, by its name, or by its number from
   * browser.annotate. A box that takes one file is given one; every file is checked inside the workspace first.
   */
  async upload(input: { selector?: string | undefined; name?: string | undefined; mark?: number | undefined; paths: string[] }, context: ToolContext) {
    if (!this.files) throw new Error('Sending a file to a website needs the workspace');
    return this.operation(context, async (page, check) => {
      if (this.care(context.owner).blockUploads) throw new Error(uploadsBlocked); // R17-S19
      const targets = [];
      for (const path of input.paths) targets.push(await this.files!.checked(path));
      const box = input.selector ? page.locator(input.selector).first() : await this.found(context, page, input);
      if (targets.length > 1 && !await box.evaluate(node => (node as HTMLInputElement).multiple).catch(() => false))
        throw new Error('That file box takes one file at a time.');
      check();
      await box.setInputFiles(targets, { timeout: 5000 });
      return { uploaded: input.paths.length === 1 ? input.paths[0] : input.paths, ...(input.selector ? { selector: input.selector } : {}),
        ...(input.name ? { name: input.name } : {}), ...(input.mark !== undefined ? { mark: input.mark } : {}) };
    });
  }
  /**
   * Borrows the browser the owner already has open, so websites that know them stay signed in.
   * Only for this task, only when they turned it on for this task, and let go of at the end.
   */
  async borrow(context: ToolContext) {
    if (!this.store) throw new Error('Using your own browser is switched off for this launch');
    const settings = readAttachSettings(this.store, context.owner);
    const refused = attachRefusal(settings, context.runId);
    if (refused) throw new Error(refused);
    const entry = this.entry(context);
    if (entry.control) throw new Error('A shared Branch browser session cannot borrow your own browser.');
    if (entry.borrowed) return this.borrowedReport(entry);
    // A recording takes pictures of every tab in the window, so it must never be your own window.
    // Checked before the window question, because it is the more useful thing to be told.
    if (entry.session.isRecording())
      throw new Error('This task is keeping a recording, which would photograph your own tabs as well. Keep the recording first, then ask for your browser.');
    if (entry.session.started())
      throw new Error('Ask for your own browser before opening a page: this task already has a browser window of its own');
    const attached = await this.connect(settings.port);
    // A switch turned on without a task named is tied to the first task that uses it, so the next
    // one has to ask again rather than inheriting a permission it was never given.
    if (!settings.runId) saveAttachSettings(this.store, context.owner, { runId: context.runId });
    entry.borrowed = attached;
    entry.session.options.attached = { context: attached.context, detach: () => attached.detach() };
    // Every request Branch's own tab makes is checked, not only the addresses it is asked to open.
    entry.session.options.guardUrl = url => attachedAddressRefusal(url, '', settings.extraRefusedHosts);
    // Batch 20 (wave 8): reaching into the owner's own browser window widens what Branch can see,
    // so it is written into the record of what the assistant was allowed to do, both ways.
    audit(this.store, context.owner, { action: 'browser.borrowed', actor: 'a task', runId: context.runId,
      subject: 'your own browser window', reason: 'A task asked to work in the browser you already have open', outcome: 'borrowed' });
    return this.borrowedReport(entry);
  }
  /** The extra websites the owner added to the refused list; none, when settings are not kept. */
  private extraRefusedHosts(owner: string): readonly string[] {
    return this.store ? readAttachSettings(this.store, owner).extraRefusedHosts : [];
  }
  private borrowedReport(entry: RunEntry) {
    const attached = entry.borrowed!;
    return { using: 'your own browser', version: attached.version, yourTabsOpen: attached.existingPages,
      note: 'Branch works in its own new tab and closes only that one. Banks and password sites are refused.' };
  }
  /** Gives the owner's browser back. Nothing of theirs is closed; Branch only stops listening. */
  async giveBack(context: ToolContext) {
    const entry = this.sessions.get(this.key(context));
    if (!entry?.borrowed) return { released: false };
    await this.closeRun(context);
    if (this.store)
      audit(this.store, context.owner, { action: 'browser.borrowed', actor: 'a task', runId: context.runId,
        subject: 'your own browser window', reason: 'The task finished with it', outcome: 'given back' });
    return { released: true };
  }
  /** These secret values with every one this task's window held before (RunEntry.seen), which keeps the latest 64. */
  private remembered(context: ToolContext, hidden: readonly string[]): string[] {
    return this.rememberValues(this.entry(context), hidden);
  }
  private rememberValues(entry: RunEntry, hidden: readonly string[]): string[] {
    const seen = entry.seen;
    for (const value of hidden) { seen.delete(value); seen.add(value); }
    for (const value of seen) { if (seen.size <= 64) break; seen.delete(value); }
    return [...seen];
  }
  /** Owned interactive pages may contain secrets the owner typed without a tool call. */
  private async watchedSecrets(entry: RunEntry, page: Page): Promise<string[] | null> {
    const found = await Promise.race([
      secretValues(page, entry.filled.get(page)?.boxes ?? [], null).catch(() => null),
      new Promise<null>(done => { setTimeout(() => done(null), 1000).unref?.(); }),
    ]);
    return found === null ? null : this.rememberValues(entry, found);
  }
  /** The boxes a saved sign-in typed into on this page (live-stage). */
  private filledOn(context: ToolContext, page: Page): Locator[] {
    return this.entry(context).filled.get(page)?.boxes ?? [];
  }
  /**
   * Keeps the boxes a saved sign-in typed into on this page, with the rest of a split code beside each, until the page
   * shows another document. A move within the same document (a sign-in page changing its own address) keeps them, and
   * so does a page that cannot say which document it shows.
   */
  private async keepFilled(entry: RunEntry, page: Page, box: Locator): Promise<void> {
    const document = await page.evaluate(() => performance.timeOrigin);
    const kept = entry.filled.get(page), boxes = [box, box.locator(CODE_SIBLINGS)];
    if (kept) { if (kept.document !== document) kept.boxes = []; kept.document = document; kept.boxes.push(...boxes); return; }
    const mine = { document, boxes };
    entry.filled.set(page, mine);
    page.on('framenavigated', frame => {
      if (frame !== page.mainFrame()) return;
      void page.evaluate(() => performance.timeOrigin).then(now => { if (now !== mine.document) mine.boxes = []; }, () => undefined);
    });
    page.once('close', () => entry.filled.delete(page));
  }
  /** Starts keeping a recording of this task's browser window. */
  async startRecording(context: ToolContext) {
    return this.writeFor(context, async (write) => {
    const entry = this.entry(context);
    if (entry.control && await this.ownedRecordingPrivate(entry))
      throw new Error('This shared browser holds or has handled private values, so a recording cannot start.');
    // A recording's pictures are the browser's own and cannot be covered, so none starts while a saved sign-in's
    // value is still in a box of the window.
    // A box that cannot be asked counts as holding one, as it does for a saved page (holdsSecret).
    const boxes = [...entry.filled.values()].flatMap(kept => kept.boxes);
    const typed = await Promise.all(boxes.map(box => box.evaluateAll(found => found.some(one => !!(one as HTMLInputElement).value)).catch(() => true)));
    if (typed.some(Boolean))
      throw new Error('A saved sign-in is still typed into a box of this window, so a recording cannot start yet. Start it once the sign-in is done.');
    // A recording photographs every tab in the window it is made in, so it is never made in the
    // owner's own window: their other tabs are none of Branch's business.
    if (entry.borrowed)
      throw new Error('This task is working in your own browser, so a recording would photograph your other tabs too. Give your browser back first, then start a recording.');
    await this.trunkProfile(context, entry); // a recording that opens the window opens it with the Trunk's own sign-in
    write?.check();
    await entry.session.record(startRecording);
    // The same boxes page text leaves out (secretValues), so what a step reads is what the recording writes down.
    entry.session.options.beforeAction = page => clearSecretValues(page);
    return { recording: true,
      note: 'Pictures of each step are kept; the page\'s own markup is not, and password and one-time-code boxes are emptied before every step, so no password or code can get into the file.' };
    });
  }
  private async ownedRecordingPrivate(entry: RunEntry): Promise<boolean> {
    if (entry.seen.size) return true;
    const pages = entry.session.tabs().map(tab => entry.session.tabPage(tab.index)).filter((page): page is Page => !!page);
    const privatePages = Promise.all(pages.map(page => holdsSecret(page, entry.filled.get(page)?.boxes ?? []).catch(() => true)));
    return Promise.race([privatePages.then(found => found.some(Boolean)),
      new Promise<boolean>(done => { setTimeout(() => done(true), 1000).unref?.(); })]);
  }
  /** Ends the recording and keeps it beside the task's other files. */
  async keepRecording(context: ToolContext) {
    return this.writeFor(context, async (write) => {
    const artifacts = this.artifacts;
    if (!artifacts) throw new Error('Recordings are switched off because there is nowhere to keep the file');
    const entry = this.entry(context);
    const bytes = await entry.session.keepRecording();
    write?.check();
    entry.session.options.beforeAction = undefined;
    const kept = await artifacts.write(context.runId, `browser-recording-${randomUUID().slice(0, 8)}.zip`,
      'application/zip', bytes);
    return { ...kept, note: 'Open this in Playwright\'s trace viewer to watch what the browser did.' };
    });
  }
  async tab(action: 'list' | 'open' | 'select' | 'close', index: number | undefined, context: ToolContext) {
    return this.writeFor(context, async (write, signal) => {
    const entry = this.entry(context), session = entry.session;
    if (++entry.actions > this.config.maxActionsPerRun) throw new Error(actionStop(this.config.maxActionsPerRun));
    if (action === 'open') {
      await this.trunkProfile(context, entry); write?.check();
      await session.openTab(signal, () => { if (write) entry.tabIds!.push(write.addTab()); });
    } else if (action === 'select') await session.selectTab(requireIndex(index), signal);
    else if (action === 'close') {
      const chosen = requireIndex(index), id = entry.tabIds?.[chosen];
      await session.closeTab(chosen, signal, () => {
        if (write && id) { write.closeTab(id); entry.tabIds!.splice(chosen, 1); }
      });
    }
    // Each tab's address is scrubbed of what that tab's own boxes hold, as every other answer is (operation).
    return { tabs: await Promise.all(session.tabs().map(async tab => {
      const page = session.tabPage(tab.index);
      const hidden = page && !session.isRecording()
        ? await this.pageSecrets(context, page).then(found => this.remembered(context, found.hidden), () => null) : null;
      return { ...tab, url: scrubAddress(tab.url, hidden) };
    })) };
    });
  }
  /** Chooses which saved sign-in this task's browser window uses; it must be asked for before a page opens. */
  async useProfile(name: string, context: ToolContext) {
    const entry = this.entry(context);
    if (entry.control) throw new Error('The shared browser keeps its explicitly selected profile.');
    const profiles = this.requireProfiles();
    const state = await profiles.load(context.owner, name);
    if (!state) throw new Error(`There is no saved sign-in called "${name}"`);
    if (entry.session.started())
      throw new Error('Choose the saved sign-in before opening a page: this task already has a browser window open');
    entry.session.options.storageState = state;
    entry.profile = name;
    return { using: name, cookies: state.cookies.length, sites: state.origins.length };
  }
  private requireProfiles(): BrowserProfiles {
    if (!this.profiles) throw new Error('Saved sign-ins are switched off for this launch');
    return this.profiles;
  }
  async profileAction(action: 'list' | 'create' | 'remove' | 'use' | 'keep', name: string | undefined, context: ToolContext) {
    const profiles = this.requireProfiles();
    if (action === 'list') return { profiles: (await profiles.list(context.owner)).filter(p => !isTrunkProfile(p.name) || p.name === trunkProfileName(context.trunk ?? '')) };
    if (action === 'keep') return this.keepForTrunk(context);
    const chosen = profileNameSchema.parse(name ?? '');
    // Each Trunk's own saved sign-in is that Trunk's alone: no other Trunk, and not Branch itself, uses, makes or removes it.
    if (isTrunkProfile(chosen) && chosen !== trunkProfileName(context.trunk ?? ''))
      throw new Error(`"${chosen}" is another Trunk's own saved sign-in, so this task cannot use or change it`);
    if (action === 'create') return { created: await profiles.create(context.owner, chosen) };
    if (action === 'remove') return { removed: await profiles.remove(context.owner, chosen), name: chosen };
    return this.useProfile(chosen, context);
  }
  /**
   * "keep": this Trunk keeps its own saved sign-in from now on. It is made if it is missing; when this task already has a
   * window open, what the window holds now is written into it when the task ends; otherwise the next page opens with it.
   */
  private async keepForTrunk(context: ToolContext) {
    if (!context.trunk) throw new Error('Only a Trunk keeps a browser profile of its own; this task is not a Trunk’s');
    const profiles = this.requireProfiles(), name = trunkProfileName(context.trunk), entry = this.entry(context);
    if (entry.control && entry.profile !== name) throw new Error('The shared browser keeps its explicitly selected profile.');
    // A task using another saved sign-in would copy it into the Trunk's own for good: keeping is for a task that uses none.
    if (entry.profile && entry.profile !== name)
      throw new Error(`This task uses the saved sign-in "${entry.profile}", so it cannot be kept as this Trunk's own. Keep one in a task that uses no other.`);
    const state = await profiles.load(context.owner, name) ?? (await profiles.create(context.owner, name), null);
    entry.trunkChecked = true;
    if (!entry.session.started() && state) entry.session.options.storageState = state;
    entry.profile = name;
    return { keeping: true, cookies: state?.cookies.length ?? 0, sites: state?.origins.length ?? 0 };
  }
  /**
   * The owner signs in by hand in a window they can see; only the cookies that keep them signed in
   * are saved. Nothing about this passes through the assistant, so it never sees the password.
   */
  async signIn(owner: string, name: string, url: string, timeoutMs = 300000): Promise<{ name: string; cookies: number; sites: number }> {
    const profiles = this.requireProfiles();
    profileNameSchema.parse(name);
    if (!this.allowed(url)) throw new Error('That website is not one the browser is allowed to open');
    await this.policy?.assertAllowed(new URL(url), 'browser address');
    // parity-b2: this window is on the screen for as long as the owner signs in, so the live view of it takes no frame.
    return whileSignInShows(async () => {
      const browser = await (await chromium()).launch({ headless: false, ...(this.config.channel ? { channel: this.config.channel } : {}) });
      try {
        const context = await browser.newContext(), page = await context.newPage();
        await page.goto(url, { waitUntil: 'domcontentloaded' });
        await Promise.race([page.waitForEvent('close', { timeout: timeoutMs }).catch(() => undefined),
          new Promise(resolve => setTimeout(resolve, timeoutMs))]);
        const state = (await context.storageState()) as unknown as StorageState;
        const saved = await profiles.save(owner, name, state);
        return { name: saved.name, cookies: saved.cookies, sites: saved.sites };
      } finally { await browser.close().catch(() => undefined); }
    });
  }
  /** Saves a file a website sent into the workspace's downloads folder, within the size and type limits. */
  private async saveDownload(download: Download, context: Pick<ToolContext, 'owner' | 'runId'>, entry?: RunEntry): Promise<DownloadRecord> {
    const owner = context.owner;
    if (!this.files) throw new Error('saving files from websites needs the workspace');
    // Settings › Permissions › Downloads may come from › Ask each time. A file the owner downloaded while driving their
    // own browser view is their own doing and is kept at once.
    if (this.care(owner).downloadsFrom === 'ask' && entry?.control?.view().writer?.kind !== 'owner') return this.holdDownload(download, context);
    // Settings › Permissions › Downloads may come from: only a site this task's pages were on.
    if (this.care(owner).downloadsFrom === 'known') {
      let origin = '', host = '';
      try { const from = new URL(download.url()); origin = from.origin; host = from.host; } catch { /* not an address: refused below */ }
      // A page's own sites: where its tabs are now, and every page the task's tabs showed. A download's own address is
      // never one of them by itself, since a file that is downloaded is never shown as a page.
      const shown = new Set([...(entry?.shown ?? []), ...(entry?.session.tabs() ?? []).map(tab => { try { return new URL(tab.url).origin; } catch { return ''; } })]);
      if (!origin || !shown.has(origin)) throw new Error(downloadNotKnown(host || 'an unknown place'));
    }
    const name = safeDownloadName(download.suggestedFilename());
    const ending = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
    if (!this.config.downloadTypes.includes(ending))
      throw new Error(`files ending in .${ending || '(nothing)'} are not saved`);
    // Two files arriving at once can pick the same free name, so a taken name is tried again once.
    for (let attempt = 0; ; attempt++) {
      const relative = await this.freeName(name);
      const target = await this.files.checked(relative);
      await mkdir(dirname(target), { recursive: true });
      try { return await this.stream(download, target, relative); }
      catch (error) {
        if (attempt > 0 || (error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
  }
  private async stream(download: Download, target: string, relative: string): Promise<DownloadRecord> {
    const handle = await open(target, 'wx');
    const limit = this.config.maxDownloadBytes;
    let bytes = 0;
    try {
      const source = await download.createReadStream();
      for await (const chunk of source as AsyncIterable<Buffer>) {
        bytes += chunk.byteLength;
        if (bytes > limit) throw new Error(`the file is larger than ${Math.round(limit / 1048576)} MB`);
        await handle.write(chunk);
      }
    } catch (error) {
      await handle.close().catch(() => undefined);
      await rm(target, { force: true });
      throw error;
    }
    await handle.close();
    return { file: relative, bytes, from: download.url().slice(0, 300) };
  }
  /** Ask each time: the file is written outside the workspace, with the same name and size limits, until the owner answers. */
  private async holdDownload(download: Download, context: Pick<ToolContext, 'owner' | 'runId'>): Promise<DownloadRecord> {
    const name = safeDownloadName(download.suggestedFilename());
    const ending = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
    if (!this.config.downloadTypes.includes(ending)) throw new Error(`files ending in .${ending || '(nothing)'} are not saved`);
    for (const [id, held] of this.heldDownloads) if (Date.now() - held.at > 3_600_000) this.dropHeld(id);
    if (this.heldDownloads.size >= 20) throw new Error('twenty files are already waiting for your yes; answer those first');
    await mkdir(this.heldFolder, { recursive: true });
    const id = randomUUID(), path = joinPath(this.heldFolder, id);
    const record = await this.stream(download, path, name);
    const conversation = this.store?.run(context.runId)?.sessionId ?? '';
    this.heldDownloads.set(id, { path, name, from: record.from, owner: context.owner, conversation, at: Date.now() });
    return { file: '', bytes: record.bytes, from: `${record.from} — ${downloadHeld(name)}`, held: id, name };
  }
  private dropHeld(id: string): void {
    const held = this.heldDownloads.get(id);
    this.heldDownloads.delete(id);
    if (held) void rm(held.path, { force: true }).catch(() => undefined);
  }
  /** browser.keep_download: once the owner said yes, the held file moves into the workspace; keep false throws it away. */
  async keepDownload(input: { id: string; keep: boolean }, context: ToolContext) {
    const held = this.heldDownloads.get(input.id);
    const conversation = this.store?.run(context.runId)?.sessionId ?? '';
    if (!held || held.owner !== context.owner || held.conversation !== conversation)
      throw new Error('No file with that id is waiting for this conversation.');
    if (!input.keep) { this.dropHeld(input.id); return { discarded: held.name }; }
    if (!this.files) throw new Error('saving files from websites needs the workspace');
    for (let attempt = 0; ; attempt++) {
      const relative = await this.freeName(held.name), target = await this.files.checked(relative);
      await mkdir(dirname(target), { recursive: true });
      try { await copyFile(held.path, target, 1 /* COPYFILE_EXCL */); this.dropHeld(input.id); return { file: relative, from: held.from }; }
      catch (error) { if (attempt > 0 || (error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    }
  }
  /** Where a held file came from, so the approval names the site. */
  heldHost(id: unknown): string {
    const held = typeof id === 'string' ? this.heldDownloads.get(id) : undefined;
    try { return held ? new URL(held.from.split(' ')[0]!).host : ''; } catch { return ''; }
  }
  /** A name inside the downloads folder that is not taken yet. */
  private async freeName(name: string): Promise<string> {
    const stop = name.lastIndexOf('.'), stem = stop > 0 ? name.slice(0, stop) : name, ending = stop > 0 ? name.slice(stop) : '';
    for (let attempt = 0; attempt < 100; attempt++) {
      const candidate = `${downloadFolder}/${stem}${attempt ? `-${attempt}` : ''}${ending}`;
      const full = await this.files!.checked(candidate);
      if (!(await stat(full).catch(() => null))) return candidate;
    }
    throw new Error('too many files with that name are already saved');
  }
  /**
   * live-stage (src/live-stage.ts): what the run's own window shows now, for the owner watching it — the tab it works
   * in as a frame, its address and title, and the tabs beside it. Null when the run has no window open. A window in
   * the owner's own browser (browser.borrow) is never pictured: that is their real browser, and a picture there can
   * wake or hold up a tab. A frame that cannot be taken comes back as null, never without its password boxes covered.
   */
  async watch(owner: string, runId: string): Promise<WatchedWindow | null> {
    let entry: RunEntry | undefined;
    try { entry = this.sessions.get(this.key({ owner, runId })); } catch { return null; } // no owner or run: nothing to watch
    const seen = entry?.session.watched();
    if (!entry || !seen) return null;
    // A tab whose page is busy may not answer; its title is left empty after a second rather than holding up the view.
    const titleOf = (tab: Page) => Promise.race([tab.title().catch(() => ''), new Promise<string>(done => { setTimeout(() => done(''), 1000).unref?.(); })]);
    const pageSecrets: (string[] | null)[] = [];
    const tabs = await Promise.all(seen.tabs.map(async (tab, index) => {
      const [title, hidden, extra] = await Promise.all([titleOf(tab), entry.control ? this.watchedSecrets(entry, tab) : undefined,
        entry.control ? this.tabExtras(tab) : undefined]);
      if (hidden !== undefined) pageSecrets.push(hidden);
      return { url: hidden === undefined ? tab.url() : scrubAddress(tab.url(), hidden),
        title: hidden === undefined ? title : hidden === null ? '' : scrubText(title, hidden), active: index === seen.active, ...extra };
    }));
    const borrowed = entry.session.isBorrowed();
    // A box a saved sign-in was typed into holds that secret whatever kind of box it is (a code goes into a plain one).
    const filled = entry.filled.get(seen.page)?.boxes ?? [];
    const frame = borrowed ? null : await liveFrame(seen.page, filled).catch(() => null);
    const needs = borrowed ? null : await needsPerson(seen.page);
    const hidden = pageSecrets.length && pageSecrets.every(values => values !== null) ? pageSecrets.flatMap(values => values!) : null;
    const downloads = entry.control ? entry.session.completedDownloads().map(record => ({
      file: hidden === null ? '' : scrubText(record.file, hidden), bytes: record.bytes, saved: !!record.file,
      from: scrubAddress(record.from, null),
    })) : undefined;
    return { url: tabs[seen.active]?.url ?? '', title: tabs[seen.active]?.title ?? '', tabs, frame, borrowed,
      needs, ...(downloads ? { downloads } : {}) };
  }
  /** A paint signal for an already open Branch page. It never returns CDP image data. */
  async paintWake(owner: string, runId: string, signal: AbortSignal, painted: () => void, readable: () => boolean) {
    const key = this.key({ owner, runId }), entry = this.sessions.get(key), page = entry?.session.watched()?.page;
    if (!entry || !page || entry.session.isBorrowed() || entry.session.isRecording() || entry.held) return null;
    const url = page.url(), epoch = entry.control?.view().epoch;
    const current = () => !signal.aborted && readable() && this.sessions.get(key) === entry
      && entry.session.watched()?.page === page && !page.isClosed() && page.url() === url
      && entry.control?.view().epoch === epoch && entry.control?.view().state !== 'stopped';
    return browserPaintWake(page, painted, signal, current);
  }
  /** For the owner's tabs: whether the page is still loading, and its site's small icon once known. */
  private async tabExtras(tab: Page): Promise<{ loading: boolean; icon: string }> {
    const state = await Promise.race([tab.evaluate(() => document.readyState).catch(() => 'complete'),
      new Promise<string>(done => { setTimeout(() => done('loading'), 300).unref?.(); })]);
    return { loading: state !== 'complete', icon: this.iconFor(tab) };
  }
  /**
   * A site's icon, fetched once per site under the same network rules as every other request (the policy's own
   * checked fetch, held to the addresses it judged), no bigger than 16 KB and only an image. Never blocks the view:
   * the first read says "" and a later one has the icon.
   */
  private iconFor(tab: Page): string {
    let origin: string;
    try { const url = new URL(tab.url()); if (!['http:', 'https:'].includes(url.protocol)) return ''; origin = url.origin; } catch { return ''; }
    const known = this.icons.get(origin);
    if (known !== undefined) return known;
    this.icons.set(origin, '');
    while (this.icons.size > 64) this.icons.delete(this.icons.keys().next().value!);
    const guard = (this.policy as { guard?: (base: typeof fetch) => typeof fetch } | undefined)?.guard;
    if (!guard) return '';
    void (async () => {
      const href = await Promise.race([tab.evaluate(() => (document.querySelector('link[rel~="icon"]') as HTMLLinkElement | null)?.href ?? '').catch(() => ''),
        new Promise<string>(done => { setTimeout(() => done(''), 1000).unref?.(); })]);
      const target = new URL(/^https?:\/\//.test(href) ? href : '/favicon.ico', origin);
      if (!this.allowed(target.href)) return;
      const answer = await guard.call(this.policy, platformFetch)(target, { redirect: 'manual', signal: AbortSignal.timeout(3000) });
      const type = answer.headers.get('content-type')?.split(';')[0]?.trim() ?? '';
      if (!answer.ok || Number(answer.headers.get('content-length') ?? 0) > 16_384) { void answer.body?.cancel().catch(() => undefined); return; }
      const bytes = Buffer.from(await answer.arrayBuffer());
      if (answer.ok && /^image\/[\w.+-]+$/.test(type) && bytes.length > 0 && bytes.length <= 16_384)
        this.icons.set(origin, `data:${type};base64,${bytes.toString('base64')}`);
    })().catch(() => undefined);
    return '';
  }
  /** The website the run's page is on, so the approval policy can match on it. */
  hostFor(context: Pick<ToolContext, 'owner' | 'runId'>): string {
    try {
      const entry = this.sessions.get(this.key(context));
      // The page in front now (the owner may have moved it), with its port, as the approval rules name a site.
      let now = '';
      try { const at = new URL(entry?.session.watched()?.page.url() ?? ''); if (at.protocol === 'http:' || at.protocol === 'https:') now = at.host; } catch { /* no page yet */ }
      return now || entry?.host || '';
    } catch { return ''; }
  }
  /**
   * Gives every borrowed browser back at once, without stopping anything else. Used when Branch
   * locks itself: a locked Branch must not still be holding the door to a signed-in browser open.
   * Only the owner's own windows are let go of; a task using a browser of Branch's own carries on.
   */
  async releaseBorrowed(): Promise<number> {
    const borrowed = [...this.sessions].filter(([, entry]) => !!entry.borrowed);
    for (const [key, entry] of borrowed) {
      entry.detach();
      await entry.session.close().catch(() => undefined);
      if (this.sessions.get(key) === entry) this.sessions.delete(key);
    }
    return borrowed.length;
  }

  /* ──────────────── mac7/vault-autofill (R17-068): filling one of the owner's saved sign-ins ────────────────
     The browser is the only thing here that ever sees the value, and only for as long as it takes to
     type it. `browser.fill` and `browser.act` still refuse a password box outright, exactly as
     before, because the assistant supplies the value there; this way in is the owner's own, it
     supplies the value itself (src/vault-autofill.ts), and it hands nothing back. */

  /** The page this task is on, as the sign-in filling needs it. Nothing here returns what it typed. */
  signInPage(): SignInPage {
    return {
      where: (context) => this.operation(context, async page => {
        const entry = this.entry(context), address = page.url(), host = hostOf(address);
        // Across sites, and only across sites: the same website the task opened by address is where
        // a sign-in flow stays, and a hop away from it is what nobody but the owner may vouch for.
        return { address, acrossSites: entry.pressed && (!host || host !== entry.typedHost),
          // A recording writes down what every step was asked to type, so nothing is filled while
          // one is being kept (integration review; src/vault-autofill.ts refuses on this).
          recording: entry.session.isRecording() };
      }),
      type: async (context, box, label, value) => {
        if (this.entry(context).session.isRecording())
          throw new Error('This task is keeping a recording of the browser, which writes down everything typed into a page.');
        await this.operation(context, async (page, check) => {
          const found = await signInBox(page, box, label);
          // live-stage: kept before anything is typed, so no frame of the window is taken with the value showing.
          await this.keepFilled(this.entry(context), page, found);
          check();
          // Nothing thrown from inside `fill` is passed on: a page library writes what it was asked
          // to type into its own message, and that message must never leave this method.
          try { await found.fill(value); } catch { throw new Error(`Branch could not type into that ${box} box.`); }
          return { typed: box };
        });
      },
    };
  }

  async closeRun(context: Pick<ToolContext, 'owner' | 'runId'>): Promise<void> {
    const key = this.key(context), entry = this.sessions.get(key);
    if (!entry || entry.held) return; // w911 (A1726): a benchmark window is closed by the benchmark

    if (entry.control) {
      this.controls.finishRun(context.owner, context.runId);
      entry.budgets?.delete(context.runId);
      this.sessions.delete(key);
      return;
    }

    entry.detach();
    await this.keepAutoRecording(context.runId, entry);
    await this.keepSignIn(context.owner, entry);
    await entry.session.close();
    if (this.sessions.get(key) === entry) this.sessions.delete(key);
  }
  /**
   * Settings' "Record browser tasks": once a task's first page has opened, its window keeps a recording, as
   * browser.recording "start" would, unless a saved sign-in's value is still typed in, the window is the owner's own,
   * or it is the conversation's kept browser (which the owner may take over and type into). Skipped quietly then.
   */
  private async autoRecord(context: ToolContext, entry: RunEntry): Promise<void> {
    if (!this.care(context.owner).recordTasks || !this.artifacts || entry.control || entry.borrowed || entry.held
      || entry.session.isBorrowed() || entry.session.isRecording() || entry.autoRecording !== undefined) return;
    const boxes = [...entry.filled.values()].flatMap(kept => kept.boxes);
    const typed = await Promise.all(boxes.map(box => box.evaluateAll(found => found.some(one => !!(one as HTMLInputElement).value)).catch(() => true)));
    if (typed.some(Boolean)) return;
    entry.autoRecording = false;
    await entry.session.record(startRecording);
    entry.session.options.beforeAction = page => clearSecretValues(page);
    entry.autoRecording = true;
  }
  /** A recording Settings started is kept beside the task's other files when the task ends or the owner takes over. */
  private async keepAutoRecording(runId: string, entry: RunEntry): Promise<{ path: string } | null> {
    if (!entry.autoRecording || !entry.session.isRecording() || !this.artifacts) return null;
    entry.autoRecording = false;
    try {
      const bytes = await entry.session.keepRecording();
      entry.session.options.beforeAction = undefined;
      return await this.artifacts.write(runId, `browser-recording-${randomUUID().slice(0, 8)}.zip`, 'application/zip', bytes);
    } catch { return null; } // a recording that could not be kept never holds up the end of a task
  }
  /** A run that used a saved sign-in writes what it learned back, so the person stays signed in. */
  private async keepSignIn(owner: string, entry: RunEntry): Promise<void> {
    if (!entry.profile || !this.profiles || !entry.session.started()) return;
    try {
      const state = await entry.session.storageState();
      if (state) await this.profiles.save(owner, entry.profile, state);
    } catch { /* a sign-in that could not be refreshed is never worth failing a task for */ }
  }
  /**
   * w911 (A1726) hook: a benchmark opens its task page in a window of Branch's own before the task
   * starts, hands that very window to the task, and reads the page again once the task is over. Only
   * a page Branch serves on 127.0.0.1 may be opened, and that one origin is allowed for this window
   * alone. The window outlives the task until the benchmark closes it (see src/benchmark-miniwob.ts).
   */
  async benchmarkWindow(owner: string, url: string): Promise<BenchmarkWindow> {
    const target = new URL(url);
    if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1' || !target.port || target.username || target.password)
      throw new Error('A benchmark window may only open a page Branch serves on 127.0.0.1');
    const context = { owner, runId: `benchmark-${randomUUID()}`, signal: new AbortController().signal } as ToolContext;
    const entry = this.entry(context);
    entry.granted = target.origin;
    entry.held = true;
    let key = this.key(context);
    const close = async () => {
      entry.held = false; entry.detach();
      await entry.session.close();
      if (this.sessions.get(key) === entry) this.sessions.delete(key);
    };
    const use = <T>(action: (page: Page) => Promise<T>) => entry.session.use(context, action);
    try { await use(page => page.goto(url, { waitUntil: 'load' })); }
    catch (error) { await close(); throw error; }
    entry.origins.add(target.origin);
    entry.host = target.host;
    return { close, evaluate: <T>(script: string) => use(page => page.evaluate(script) as Promise<T>),
      handTo: runId => {
        const next = this.key({ owner, runId });
        if (this.sessions.has(next)) throw new Error('That task already has a browser window');
        this.sessions.delete(key); this.sessions.set(next, entry); key = next;
      } };
  }
  close(): Promise<void> {
    this.closed = true;
    return this.closing ??= this.shutdown();
  }
  private async shutdown(): Promise<void> {
    this.controls.stopAll();
    const pending = [...new Set([...this.sessions.values(), ...this.controlled.values()])].map(async entry => {
      entry.detach();
      try { if (entry.control) await this.keepSignIn(entry.control.binding.owner, entry); }
      finally { await entry.session.close(); }
    });
    const results = await Promise.allSettled(pending);
    await this.starting?.catch(() => undefined);
    await this.sandbox?.close(); // w911 (A2019) hook: closes the sandbox browser and stops its container
    await this.browser?.close();
    await this.pinProxy?.close();
    this.sessions.clear();
    this.controlled.clear();
    const failures = results.filter(result => result.status === 'rejected');
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Browser cleanup failed');
  }
}

/**
 * Whether the page in front is waiting for a person rather than a task: a visible password or one-time-code box (a
 * sign-in, which Branch never types for itself), or a "prove you're a person" check (never solved by Branch). Read
 * only, bounded to a third of a second; a page that cannot be asked counts as needing nobody.
 */
export async function needsPerson(page: Page): Promise<'sign-in' | 'captcha' | null> {
  const asked = page.evaluate(() => {
    const shown = (element: Element): boolean => {
      const box = element.getBoundingClientRect(), style = getComputedStyle(element);
      return box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const frames = [...document.querySelectorAll('iframe')].map(frame => frame.getAttribute('src') ?? '');
    if (frames.some(src => /recaptcha|hcaptcha|challenges\.cloudflare\.com|turnstile|arkoselabs|funcaptcha/i.test(src))) return 'captcha';
    const boxes = document.querySelectorAll('input[type="password"], input[autocomplete~="one-time-code"], input[autocomplete~="current-password"]');
    return [...boxes].some(shown) ? 'sign-in' : null;
  }).catch(() => null);
  return Promise.race([asked, new Promise<null>(done => { setTimeout(() => done(null), 300).unref?.(); })]);
}

/**
 * mac7/vault-autofill: the one box a saved sign-in is typed into. A password goes only into a real
 * password box, whatever label was given, so a page that labels a plain text box "Password" cannot
 * have the value typed where everyone can read it.
 */
async function signInBox(page: Page, box: SignInBox, label: string | undefined) {
  // Only ever the page's own top frame: a Playwright locator does not reach into a frame from
  // another website (it takes a frameLocator, which nothing here has), so a page cannot have the
  // value typed into a box it borrowed from somebody else. Proven in the integration review.
  const found = label
    ? page.getByLabel(label, { exact: true })
    : page.locator(box === 'password' ? 'input[type="password"]'
      : 'input[autocomplete="one-time-code"], input[inputmode="numeric"]').first();
  const tag = await found.evaluate(node => node.tagName);
  const refusal = signInBoxFor(box, String(tag), await found.getAttribute('type'));
  if (refusal) throw new Error(refusal);
  return found;
}

/**
 * mac7/vault-autofill (integration review): whether that really is the box it was said to be, from
 * the element itself rather than from what the page called it. A password goes only into a real
 * password box; a one-time code goes only into an ordinary text box, never into something that is
 * not a box at all and never into a password box, whatever label a page hangs on it.
 */
export function signInBoxFor(box: SignInBox, tagName: string, type: string | null): string | null {
  if (tagName.toUpperCase() !== 'INPUT')
    return `That is not a box on this page, so nothing was typed into it.`;
  const kind = (type ?? '').trim().toLowerCase();
  if (box === 'password')
    return kind === 'password' ? null : 'That is not a password box on this page, so nothing was typed into it.';
  return ['text', 'tel', 'number', ''].includes(kind)
    ? null : 'That is not a box a one-time code goes into, so nothing was typed into it.';
}

/** The website name of an address, or '' when Branch cannot read it. */
function hostOf(address: string): string {
  try { return new URL(address).hostname.toLowerCase(); } catch { return ''; }
}

function requireIndex(index: number | undefined): number {
  if (index === undefined) throw new Error('Say which tab, by its number');
  return index;
}

/** Dogfood D4: the keys browser.act may press on a page. Anything else (a shortcut that could reach the browser itself) is refused. */
const pageKeys = ['Escape', 'Enter', 'Tab', 'Space', 'Backspace', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End'] as const;
export function pageKey(value: string | undefined): string {
  const asked = String(value ?? '').trim().toLowerCase();
  const found = pageKeys.find((key) => key.toLowerCase() === asked || (asked === 'esc' && key === 'Escape'));
  if (!found) throw new Error(`Name one key to press in value: ${pageKeys.join(', ')}.`);
  return found === 'Space' ? ' ' : found;
}
export function registerBrowser(registry: ToolRegistry, browser: BranchBrowser): void {
  registry.onRunFinished(context => browser.closeRun(context));
  const host = (_a: unknown, c: ToolContext) => browser.hostFor(c);
  registry.register({ name: 'browser.owner_input', permission: 'browser.interact',
    description: 'Page input reserved for the owner window holding the browser controls.', parameters: OwnerInputSchema,
    execute: (input, context) => browser.ownerInput(input, context), target: host });
  registry.register({ name: 'browser.navigate', reach: 'outbound', permission: 'browser.read',
    description: 'Open a configured origin in an isolated browser.',
    parameters: z.object({ url: z.string().url().max(2000) }).strict(), execute: (a, c) => browser.navigate(a.url, c) });
  registry.register({ name: 'browser.snapshot', permission: 'browser.read',
    description: 'Read a bounded accessibility snapshot of the current page as untrusted content.',
    parameters: z.object({}).strict(), execute: (_a, c) => browser.snapshot(c) });
  registry.register({ name: 'browser.click', permission: 'browser.interact',
    description: 'Click a uniquely named button or link. This may submit data or perform an external action.',
    parameters: z.object({ role: z.enum(['button', 'link']), name: z.string().min(1).max(300) }).strict(),
    execute: (a, c) => browser.click(a.role, a.name, c), target: host });
  registry.register({ name: 'browser.fill', permission: 'browser.interact',
    description: 'Fill a non-password field by its exact visible label.',
    parameters: z.object({ label: z.string().min(1).max(300), value: z.string().max(4000) }).strict(),
    execute: (a, c) => browser.fill(a.label, a.value, c), target: host });
  registerBrowserExtras(registry, browser, host);
}

/** The rest of the browser tools: pictures, waiting, pulling out rows, files and tabs. */
function registerBrowserExtras(registry: ToolRegistry, browser: BranchBrowser,
  host: (a: unknown, c: ToolContext) => string): void {
  registry.register({ name: 'browser.screenshot', permission: 'browser.read',
    description: 'Take a picture of the current page, or of one element (selector, name or number from browser.annotate). Password boxes are blacked out before the picture is taken. Use this when the page is visual and the text snapshot is not enough.',
    parameters: ScreenshotSchema, execute: (a, c) => browser.screenshot(a, c) });
  registry.register({ name: 'browser.keep_download', permission: 'browser.interact',
    description: 'Keep (or throw away, keep false) a file a page sent that is waiting outside the workspace because Settings says to ask each time. The owner is asked before it is kept.',
    parameters: z.object({ id: z.string().uuid(), keep: z.boolean().default(true) }).strict(),
    execute: (a, c) => browser.keepDownload(a, c), target: a => browser.heldHost(a.id) });
  registry.register({ name: 'browser.scroll', permission: 'browser.read',
    description: 'Scroll the page: a direction (one screen, or amount pixels), to the top or bottom, or until one element (by selector, name or number) is in view. Says where the page is and whether it reached the end.',
    parameters: ScrollSchema, execute: (a, c) => browser.scroll(a, c), target: host });
  registry.register({ name: 'browser.hover', permission: 'browser.interact',
    description: 'Rest the pointer on one element (by selector, name or number from browser.annotate), to open a menu or show a tip.',
    parameters: HoverSchema, execute: (a, c) => browser.hover(a, c), target: host });
  registry.register({ name: 'browser.keys', permission: 'browser.interact',
    description: 'Press a key or a combination on the page, such as Enter, Tab, Escape, ArrowDown, Control+A or Shift+Tab, optionally several times. This may submit data or perform an external action.',
    parameters: KeysSchema, execute: (a, c) => browser.keys(a, c), target: host });
  registry.register({ name: 'browser.select', permission: 'browser.interact',
    description: 'Choose one or more options in a drop-down list (by selector, name or number), by the words shown or the option value. This may change what the page sends.',
    parameters: SelectSchema, execute: (a, c) => browser.select(a, c), target: host });
  registry.register({ name: 'browser.history', reach: 'outbound', permission: 'browser.interact',
    description: 'Go back or forward in this tab, or reload it. Reloading a page a form opened may send that form again.',
    parameters: HistorySchema, execute: (a, c) => browser.history(a, c), target: host });
  registry.register({ name: 'browser.images', permission: 'browser.read',
    description: 'List the pictures on the page: address (without its query), the words the page gives for each, and its drawn size, as untrusted text. minWidth skips icons.',
    parameters: ImagesSchema, execute: (a, c) => browser.images(a, c), target: host });
  registry.register({ name: 'browser.console', permission: 'browser.read',
    description: 'Read what the pages logged to their console and any uncaught errors, newest last, as untrusted text. Use it to see why a page misbehaves.',
    parameters: ConsoleSchema, execute: (a, c) => browser.consoleLog(a, c), target: host });
  registry.register({ name: 'browser.network', permission: 'browser.read',
    description: 'Read the requests the pages made (method, address without its query, kind, status or failure), newest last. Never headers, cookies or bodies.',
    parameters: NetworkSchema, execute: (a, c) => browser.networkLog(a, c), target: host });
  registry.register({ name: 'browser.pdf', permission: 'browser.read',
    description: 'Save the current page as a PDF file.',
    parameters: z.object({}).strict(), execute: (_a, c) => browser.pdf(c) });
  registry.register({ name: 'browser.wait', permission: 'browser.read',
    description: 'Wait for some words or an element to appear, for words to go (textGone), for the address to contain some words (url), or for the page to stop loading things.',
    parameters: WaitSchema, execute: (a, c) => browser.wait(a, c) });
  registry.register({ name: 'browser.watch_change', permission: 'browser.read', target: host,
    description: 'Watch exact visible text appear or disappear in this task page for at most a minute; when it changes, keep the page for the owner to Take over. Already matched conditions and timeouts do not hand it over. This is a foreground text watch, not a scheduled or arbitrary page-change monitor.',
    parameters: WatchConditionSchema, execute: (a, c) => browser.watchChange(a, c) });
  registry.register({ name: 'browser.extract', permission: 'browser.read',
    description: 'Pull rows out of a table or a repeated block of cards as untrusted data. Give the selector for one row, and optionally a name for each column.',
    parameters: ExtractSchema, execute: (a, c) => browser.extract(a, c) });
  registry.register({ name: 'browser.upload', permission: 'browser.interact',
    description: 'Send a file (path) or several (paths, when the box takes more than one) from the workspace to a file box on the page, found by selector, by its name, or by its number from browser.annotate. This shares the files with the website.',
    parameters: z.object({ selector: z.string().min(1).max(300).optional(), name: z.string().min(1).max(300).optional(),
      mark: z.number().int().min(1).max(500).optional(), path: z.string().min(1).max(500).optional(),
      paths: z.array(z.string().min(1).max(500)).min(1).max(10).optional() }).strict()
      .refine(a => [a.selector, a.name, a.mark].filter(v => v !== undefined).length === 1, 'Name one file box: a selector, its name or its number')
      .refine(a => (a.path === undefined) !== (a.paths === undefined), 'Give path for one file or paths for several'),
    execute: (a, c) => browser.upload({ selector: a.selector, name: a.name, mark: a.mark, paths: a.paths ?? [a.path!] }, c), target: host });
  registry.register({ name: 'browser.tab', permission: 'browser.interact',
    description: 'List the tabs of this task, open another one, switch to one, or close one.',
    parameters: z.object({ action: z.enum(['list', 'open', 'select', 'close']),
      index: z.number().int().min(0).max(9).optional() }).strict(),
    execute: (a, c) => browser.tab(a.action, a.index, c), target: host });
  registerBrowserSecondPass(registry, browser, host);
  registry.register({ name: 'browser.profile', permission: 'browser.interact',
    description: 'Saved sign-ins: list them, make an empty one, remove one, or use one for this task so the website already knows the person. The person signs in by hand in Settings; you never see their password. A Trunk may "keep" its own browser profile, so it stays signed in from one task to the next.',
    parameters: z.object({ action: z.enum(['list', 'create', 'remove', 'use', 'keep']),
      name: z.string().min(1).max(40).optional() }).strict(),
    execute: (a, c) => browser.profileAction(a.action, a.name, c) });
}

/**
 * The second pass of browser tools: describing a page by numbering the things on it, pulling data
 * out in a named shape, acting on something several different ways before giving up, borrowing the
 * owner's own browser, and keeping a recording of what happened.
 */
function registerBrowserSecondPass(registry: ToolRegistry, browser: BranchBrowser,
  host: (a: unknown, c: ToolContext) => string): void {
  registry.register({ name: 'browser.annotate', permission: 'browser.read',
    description: 'Number everything on the page you can press or type into and list them, so you can say "press 3" instead of guessing at a selector. A number stays with the same thing while the task lasts.',
    parameters: AnnotateSchema, execute: (a, c) => browser.annotate(a, c) });
  registry.register({ name: 'browser.unmark', permission: 'browser.read',
    description: 'Take the numbered labels off the page again, so a picture shows it the way the website meant it.',
    parameters: z.object({}).strict(), execute: (_a, c) => browser.clearMarks(c) });
  registry.register({ name: 'browser.shape', permission: 'browser.read',
    description: 'Pull data off the page in the exact shape you name: a field list, each with where to read it and whether it is words, a number, a yes/no, a date or an address. Anything that does not fit is refused by name rather than guessed at.',
    parameters: ExtractSchemaSchema, execute: (a, c) => browser.extractShaped(a, c) });
  registry.register({ name: 'browser.act', permission: 'browser.interact',
    description: 'Press, type into or tick something, found by selector, by name, by the words on it, or by its number from browser.annotate. Several ways are tried before it gives up. action "press" presses one key on the page itself, named in value. action "reject-consent" needs no selector and declines non-essential cookies only when one explicit reject/necessary-only choice is recognized; it never accepts tracking. Prefer it for consent notices. This may submit data or perform an external action.',
    parameters: z.object({ action: z.enum(['click', 'fill', 'check', 'press', 'reject-consent']),
      selector: z.string().min(1).max(300).optional(), name: z.string().min(1).max(300).optional(),
      mark: z.number().int().min(1).max(500).optional(), value: z.string().max(4000).optional() }).strict(),
    execute: (a, c) => browser.act(a, c), target: host });
  registry.register({ name: 'browser.borrow', permission: 'browser.interact',
    description: 'Work in the browser the person already has open, so websites they are signed in to know them. Only when they turned this on for this task in Settings. Banks and password sites are always refused, and their own tabs are never touched.',
    parameters: z.object({ action: z.enum(['borrow', 'give back']) }).strict(),
    execute: (a, c) => a.action === 'borrow' ? browser.borrow(c) : browser.giveBack(c), target: host });
  registry.register({ name: 'browser.site', permission: 'browser.read',
    description: 'What an installed skill knows about this website: list the sites that have a skill, or read this page by the name of a reading that skill wrote down.',
    parameters: z.object({ action: z.enum(['list', 'read']),
      name: z.string().min(1).max(40).optional() }).strict(),
    execute: (a, c) => browser.site(a, c) });
  registry.register({ name: 'browser.recording', permission: 'browser.read',
    description: 'Keep a recording of what the browser does in this task, to look at afterwards. Start it, then keep it when the work is done.',
    parameters: z.object({ action: z.enum(['start', 'keep']) }).strict(),
    execute: (a, c) => a.action === 'start' ? browser.startRecording(c) : browser.keepRecording(c) });
  registerPageNotes(registry, browser); // w911 (A2144) hook: page notes, hidden and refused while switched off.
  registerBrowserFlow(registry, browser); // FQ-execution.browser: a named multi-page journey, one picture per step.
}

export { trunkProfileName, isTrunkProfile, trunkProfilePrefix } from './browser-profiles.js';

/** What the browser read off a page, with lines that give the assistant orders taken out (src/content-guard.ts). */
function pageText<T extends object>(result: T): T & { note?: string } {
  const { value, removed } = withoutInstructions(result);
  return removed ? { ...value, note: instructionsRemovedNote(removed) } : value;
}
