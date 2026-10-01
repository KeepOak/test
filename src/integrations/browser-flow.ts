import { z } from 'zod';
import type { ToolContext, ToolTarget } from '../contracts.js';
import type { ToolRegistry } from '../registry.js';
import { ScreenshotSchema, WaitSchema } from './browser-page.js';
import type { DialogRecord, DownloadRecord } from './browser-session.js';
import { profileNameSchema } from './browser-profiles.js';

/**
 * FQ-execution.browser: one page or action, as a step in a `browser.flow`. Kept small on purpose —
 * the four things a journey across a website is actually made of — rather than opening this tool
 * up to the whole browser surface.
 */
export const FlowStepSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('navigate'), url: z.string().url().max(2000) }).strict(),
  z.object({ action: z.literal('click'), role: z.enum(['button', 'link']), name: z.string().min(1).max(300) }).strict(),
  z.object({ action: z.literal('fill'), label: z.string().min(1).max(300), value: z.string().max(4000) }).strict(),
  z.object({
    action: z.literal('wait'), text: z.string().min(1).max(300).optional(),
    selector: z.string().min(1).max(300).optional(), networkIdle: z.boolean().optional(),
    timeoutMs: z.number().int().min(100).max(60000).default(10000),
  }).strict(),
]);
export type FlowStep = z.infer<typeof FlowStepSchema>;
export const FlowSchema = z.object({
  steps: z.array(FlowStepSchema).min(1).max(12),
  /** Explicit saved sign-in, selected in the same task before opening any page. */
  profile: profileNameSchema.optional(),
  /** Passed straight through to each step's picture. */
  fullPage: z.boolean().default(false),
}).strict().superRefine((value, ctx) => {
  // Kept as a separate pass, not a `.refine` on the step itself: `discriminatedUnion` needs each
  // option to stay a plain `ZodObject` so it can read the discriminator off its shape. A wait step
  // is held to `browser.wait`'s own rule, so the two can never say different things.
  value.steps.forEach((step, index) => {
    if (step.action !== 'wait') return;
    const checked = WaitSchema.safeParse(toolCall(step).args);
    if (!checked.success) for (const issue of checked.error.issues)
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['steps', index], message: issue.message });
  });
});

/** What a page did on its own while a step ran: message boxes answered and files it sent. */
interface PageEvents { messageBoxes?: DialogRecord[]; downloads?: DownloadRecord[] }

/** One step's report: what it did, the page it left the browser on, and the picture kept of it. */
export interface FlowStepReport extends PageEvents {
  step: number;
  action: FlowStep['action'];
  url: string;
  screenshot: { path: string; bytes: number; sha256: string };
}

/** What the browser tool lends the flow runner: its own actions, called one after another. */
export interface FlowHost {
  profileAction?(action: 'use', name: string, context: ToolContext): Promise<unknown>;
  navigate(url: string, context: ToolContext): Promise<{ url: string; title: string } & PageEvents>;
  click(role: 'button' | 'link', name: string, context: ToolContext): Promise<{ url: string; clicked: string } & PageEvents>;
  fill(label: string, value: string, context: ToolContext): Promise<{ filled: string } & PageEvents>;
  wait(options: { text?: string | undefined; selector?: string | undefined; networkIdle?: boolean | undefined; timeoutMs: number },
    context: ToolContext): Promise<{ waitedFor: string; url: string } & PageEvents>;
  screenshot(options: z.infer<typeof ScreenshotSchema>, context: ToolContext):
    Promise<{ path: string; bytes: number; sha256: string; mediaType: string; url: string } & PageEvents>;
  /** Whether the window may open this address at all (the website list and the network policy). */
  checkAddress(url: string, context: ToolContext): Promise<void>;
  /** The website the window is on right now, as the single-step tools are judged on. */
  hostFor(context: ToolContext): string;
}

/** The single-step tool a step stands for, with the arguments that tool would be called with. */
function toolCall(step: FlowStep): { tool: string; args: Record<string, unknown> } {
  const { action, ...args } = step;
  return { tool: `browser.${action}`, args };
}

/**
 * Where each step will be when it runs: only opening a page moves the window to another website
 * (`BranchBrowser.navigate` sets the host a click or a fill is judged on), so a step is on the host
 * of the last page the flow opened before it, or on the one the window is on now. Known limit: a click
 * or fill can itself move the window to another website (through a link, redirect, or form submission),
 * but later steps are still judged by the last navigate host, not the actual current one.
 */
function stepHosts(steps: readonly FlowStep[], current: string): string[] {
  let host = current;
  return steps.map(step => {
    if (step.action === 'navigate') host = new URL(step.url).host;
    return host;
  });
}

/** Every website the flow opens or acts on, for the rules that judge `browser.flow` as a whole. */
export function flowTargets(input: z.infer<typeof FlowSchema>, current: string): ToolTarget[] {
  const hosts = stepHosts(input.steps, current);
  return input.steps.flatMap((step, index): ToolTarget[] => {
    if (step.action === 'navigate') return [{ kind: 'read', url: step.url }];
    if (step.action === 'wait' || !hosts[index]) return [];
    return [{ kind: 'write', url: `https://${hosts[index]}/` }];
  });
}

/** A one-time yes for a step was taken by another run of the same flow judged at the same moment. */
export const stepYesUsedRefusal = "A yes given just once for a step here was already used by another run of this flow, so nothing was done. Ask again.";

/**
 * What a question about the flow as a whole, and a standing yes to it, is kept for: the websites it
 * declares (`flowTargets`), each once, in the order it reaches them — one host alone, or "2 websites:
 * a, b". A flow that names no website, arguments that do not parse (the tool refuses them anyway), and
 * a list too long to be kept whole are "", which may never be given a standing yes
 * (`Runtime.approve`): cut text would be a start that other flows share, and a rule on it would cover
 * them too.
 */
export function flowTarget(sent: unknown, current: string): string {
  const parsed = FlowSchema.safeParse(sent);
  if (!parsed.success) return '';
  const hosts = [...new Set(flowTargets(parsed.data, current).map(target => new URL(target.url!).host))];
  const text = hosts.length > 1 ? `${hosts.length} websites: ${hosts.join(', ')}` : hosts[0] ?? '';
  return text.length > 300 ? '' : text;
}

/**
 * Every step judged before the first one runs, each as the single-step tool it stands for — the
 * same rules, the same questions, the same network policy as `browser.navigate`, `browser.click`,
 * `browser.fill` and `browser.wait` — so a refusal or a question stops the flow before anything is
 * done. Returns the fingerprints of once-only overrules used by steps, so they can be consumed
 * (taken) only after all steps pass judgment and before any step runs. A yes followed by trying
 * again never does an earlier step twice.
 */
async function judgeFlow(registry: ToolRegistry, host: FlowHost, input: z.infer<typeof FlowSchema>,
  context: ToolContext): Promise<string[]> {
  const hosts = stepHosts(input.steps, host.hostFor(context));
  const usedOverrules: string[] = [];
  if (input.profile) {
    if (!host.profileAction) throw new Error('Saved browser profiles are unavailable for this flow.');
    const fingerprint = registry.judgeStep?.('browser.profile', { action: 'use', name: input.profile }, context);
    if (fingerprint) usedOverrules.push(fingerprint);
  }
  for (const [index, step] of input.steps.entries()) {
    const { tool, args } = toolCall(step);
    const moved = step.action === 'click' || step.action === 'fill';
    const fingerprint = registry.judgeStep?.(tool, args, context, moved ? hosts[index] : undefined, index);
    if (fingerprint) usedOverrules.push(fingerprint);
    if (step.action === 'navigate') await host.checkAddress(step.url, context);
  }
  const screenshotFp = registry.judgeStep?.('browser.screenshot', { fullPage: input.fullPage }, context);
  if (screenshotFp) usedOverrules.push(screenshotFp);
  return usedOverrules;
}

/** Runs one step; the picture that follows it, in `runFlow`, is what reads the page it landed on. */
async function runStep(host: FlowHost, step: FlowStep, context: ToolContext): Promise<PageEvents> {
  if (step.action === 'navigate') return host.navigate(step.url, context);
  if (step.action === 'click') return host.click(step.role, step.name, context);
  if (step.action === 'fill') return host.fill(step.label, step.value, context);
  return host.wait(step, context);
}

/** The message boxes and files of a step and of the picture after it; either can be the one that saw them. */
function pageEvents(...seen: PageEvents[]): PageEvents {
  const messageBoxes = seen.flatMap(one => one.messageBoxes ?? []);
  const downloads = seen.flatMap(one => one.downloads ?? []);
  return { ...(messageBoxes.length ? { messageBoxes } : {}), ...(downloads.length ? { downloads } : {}) };
}

/**
 * Runs a short, named sequence of pages and actions one after another in the task's own browser
 * window, taking a picture after every step. It is the very same window and the very same cookies
 * the whole way through — a `browser.profile` sign-in, or a cookie a page sets itself, from an
 * earlier step is still there on a later page. This is the difference from calling
 * navigate/click/screenshot by hand for every page: the owner asks for the journey once and gets
 * back a picture of each step of it, proof that the session carried rather than a claim that it did.
 */
export async function runFlow(registry: ToolRegistry, host: FlowHost, input: z.infer<typeof FlowSchema>,
  context: ToolContext): Promise<{ steps: FlowStepReport[]; pages: number }> {
  const usedOverrules = await judgeFlow(registry, host, input, context);
  // The one-time yeses the steps were judged on are used now, before any step runs. One already
  // used by a run judged alongside this one means this run has no yes of its own: nothing runs.
  if (usedOverrules.length > 0) {
    if (!registry.takeStepYeses) throw new Error(stepYesUsedRefusal);
    if (!registry.takeStepYeses(usedOverrules, context)) throw new Error(stepYesUsedRefusal);
  }
  if (input.profile) await host.profileAction!('use', input.profile, context);
  const steps: FlowStepReport[] = [];
  const seen = new Set<string>();
  for (const [index, step] of input.steps.entries()) {
    const done = await runStep(host, step, context);
    const picture = await host.screenshot({ fullPage: input.fullPage }, context);
    seen.add(picture.url);
    steps.push({ step: index + 1, action: step.action, url: picture.url,
      screenshot: { path: picture.path, bytes: picture.bytes, sha256: picture.sha256 }, ...pageEvents(done, picture) });
  }
  return { steps, pages: seen.size };
}

export function registerBrowserFlow(registry: ToolRegistry, host: FlowHost): void {
  registry.register({
    name: 'browser.flow', permission: 'browser.interact',
    description: 'Run a short, named journey across one or more pages in the task\'s own browser window — navigate, '
      + 'click, fill or wait, in order — taking a picture after every step, with the same signed-in session carried '
      + 'from page to page. Use this for a journey across more than one page instead of calling '
      + 'navigate/click/screenshot by hand for each one.',
    parameters: FlowSchema,
    targets: (input, context) => flowTargets(input, host.hostFor(context)),
    // A yes to one flow is kept for the websites it names, never for every flow (flowTarget).
    target: (input, context) => flowTarget(input, host.hostFor(context)),
    execute: (input, context) => runFlow(registry, host, input, context),
  });
}
