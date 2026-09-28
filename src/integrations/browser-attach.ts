import type { Browser, BrowserContext } from 'playwright';
import { chromium } from './playwright-lazy.js';
import { z } from 'zod';
import type { Store } from '../store.js';
import { hostRefusalFor, refusalFor } from './desktop-config.js';
import { optionalFields } from '../feature-switches.js';
import { lockdownOverrides } from '../lockdown.js'; // mac7/lockdown-fix

/**
 * Letting Branch borrow the browser the owner already has open, so a website that already knows
 * them stays signed in. The owner starts their own Chrome or Edge with a debugging door open and
 * presses a button in Settings; Branch then works in that same window for one task and lets go of
 * it at the end. It never types a password, never opens a bank or a password manager there, and
 * never closes the owner's browser — it only stops listening.
 *
 * The plain risk, in the owner's own words, is on the Settings card and in the documentation:
 * while this is on, anything that browser is signed in to is something Branch can reach.
 */
export const AttachSettingsSchema = z.object({
  /** "Let Branch use my browser for this task". Off until the owner turns it on, every time. */
  enabled: z.boolean().default(false),
  /** The debugging door the owner started their browser with. */
  port: z.number().int().min(1024).max(65535).default(9222),
  /** The task this permission was given for. A different task has to ask again. */
  runId: z.string().max(80).default(''),
  /** When the permission was given, so a stale one can be ignored. */
  grantedAt: z.string().max(40).default(''),
  /**
   * More websites of the owner's own that their browser may never be pointed at. These are added
   * to the built-in list of banks and password sites; nothing here can take one off it.
   */
  extraRefusedHosts: z.array(z.string().trim().min(1).max(253)).max(200).default([]),
}).strict();
export type AttachSettings = z.infer<typeof AttachSettingsSchema>;
export const AttachSettingsInputSchema = optionalFields(AttachSettingsSchema);
const settingsKey = 'browser-attach';
/** A permission goes stale after fifteen minutes, so a forgotten switch does not stay on for ever. */
export const attachGraceMs = 15 * 60 * 1000;

export function readAttachSettings(store: Store, owner: string): AttachSettings {
  const saved = AttachSettingsSchema.safeParse(store.get('settings', owner, settingsKey)?.data ?? {});
  const settings = saved.success ? saved.data : AttachSettingsSchema.parse({});
  // mac7/lockdown-fix: a permission saved while Lockdown is on does not count until it is off.
  return lockdownOverrides(store, owner, settingsKey) ? { ...settings, enabled: false } : settings;
}
export function saveAttachSettings(store: Store, owner: string, input: unknown): AttachSettings {
  const value = AttachSettingsInputSchema.parse(input ?? {});
  const current = readAttachSettings(store, owner);
  const next = AttachSettingsSchema.parse({ ...current, ...value,
    ...(value.enabled ? { grantedAt: new Date().toISOString() } : {}) });
  store.save('settings', owner, settingsKey, next);
  return next;
}

/** What the person is told when the switch is off. */
export const attachOffMessage =
  'Branch is not allowed to use your own browser. Start Chrome or Edge with its debugging door open, '
  + 'then turn on "Let Branch use my browser for this task" in Settings and say which task it is for.';

/** Whether this task may borrow the owner's browser right now, and why not when it may not. */
export function attachRefusal(settings: AttachSettings, runId: string, now = Date.now()): string | null {
  if (!settings.enabled) return attachOffMessage;
  if (settings.runId && settings.runId !== runId)
    return 'Using your own browser was allowed for a different task. Turn it on again for this one.';
  const granted = Date.parse(settings.grantedAt || '');
  if (!Number.isFinite(granted) || now - granted > attachGraceMs)
    return 'Permission to use your own browser has run out. Turn it on again in Settings.';
  return null;
}

/** The owner's own browser, borrowed for one task. Closing it only lets go; it never shuts anything. */
export interface AttachedBrowser {
  context: BrowserContext;
  /** The browser's own name for itself, so the context pane can say which one is being used. */
  version: string;
  /** How many pages were already open when Branch arrived; none of them is ever closed. */
  existingPages: number;
  detach(): Promise<void>;
}

/**
 * Connects to a browser the owner already started. The first window it finds is the one that is
 * used, because that is where their sign-ins live: a fresh one would know nobody.
 */
export async function attach(port: number,
  connect: (url: string) => Promise<Browser> = async url => (await chromium()).connectOverCDP(url, { timeout: 10000 })): Promise<AttachedBrowser> {
  let browser: Browser;
  try { browser = await connect(`http://127.0.0.1:${port}`); }
  catch (error) {
    throw new Error(`Branch could not find a browser listening on door ${port}. Start Chrome or Edge with `
      + `--remote-debugging-port=${port} first. (${error instanceof Error ? error.message : String(error)})`);
  }
  const context = browser.contexts()[0];
  if (!context) { await browser.close().catch(() => undefined); throw new Error('That browser has no window open. Open a tab in it and try again.'); }
  let released = false;
  return {
    context, version: browser.version(), existingPages: context.pages().length,
    // close() on a browser reached this way disconnects; the owner's browser keeps running.
    async detach() { if (released) return; released = true; await browser.close().catch(() => undefined); },
  };
}

/**
 * Whether the owner's own browser may be pointed at this address. Websites that handle money or
 * passwords are refused, and so is anything whose page is titled like a sign-in box — the same
 * refusals the screen control uses, extended to website names. The owner's own extra sites are
 * added to that list and can never shorten it.
 */
export function attachedAddressRefusal(url: string, pageTitle = '', extraRefused: readonly string[] = []): string | null {
  let host: string;
  try {
    const target = new URL(url);
    if (!['http:', 'https:'].includes(target.protocol)) return 'Only ordinary web addresses may be opened.';
    host = target.hostname;
  } catch { return 'That is not a web address.'; }
  const site = hostRefusalFor(host, extraRefused);
  if (site) return site;
  return pageTitle ? refusalFor({ title: pageTitle, program: '' }) : null;
}
