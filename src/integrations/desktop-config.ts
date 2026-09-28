import { z } from 'zod';
import type { Store } from '../store.js';
import { FeatureModeSchema, optionalFields, settleSwitch } from '../feature-switches.js';
import { lockdownOverrides } from '../lockdown.js'; // mac7/lockdown-fix

/**
 * Settings, input shapes and refusals for letting the assistant use the screen and keyboard of
 * this computer. Nothing here touches the screen: this file only says what may be asked for.
 *
 * The switch is off until the owner turns it on, and it is read again before every single action,
 * so turning it off stops work that is already under way.
 */
export const DesktopSettingsSchema = z.object({
  /** "Allow the assistant to use my screen and keyboard". Off until the owner turns it on. */
  enabled: z.boolean().default(false),
  /** mac2: off / when needed / on. Older saves have only `enabled`; see feature-switches.ts. */
  mode: FeatureModeSchema.optional(),
  /** Most screen actions one task may take before it has to stop and be asked again. */
  maxActionsPerRun: z.number().int().min(1).max(200).default(40),
}).strict();
export type DesktopSettings = z.infer<typeof DesktopSettingsSchema>;
export const DesktopSettingsInputSchema = optionalFields(DesktopSettingsSchema); // Q65: a field left out stays out
const settingsKey = 'desktop-control';

export function readDesktopSettings(store: Store, owner: string): DesktopSettings {
  const saved = DesktopSettingsSchema.safeParse(store.get('settings', owner, settingsKey)?.data ?? {});
  const settings = saved.success ? saved.data : DesktopSettingsSchema.parse({});
  // mac7/lockdown-fix: while Lockdown is on the switch reads off, whatever mode was saved.
  if (lockdownOverrides(store, owner, settingsKey)) return { ...settings, enabled: false, mode: 'off' };
  return { ...settings, ...settleSwitch(settings, {}) };
}
export function saveDesktopSettings(store: Store, owner: string, input: unknown): DesktopSettings {
  const value = DesktopSettingsInputSchema.parse(input ?? {});
  const current = readDesktopSettings(store, owner);
  const next = DesktopSettingsSchema.parse({ ...current, ...value, ...settleSwitch(current, value) });
  store.save('settings', owner, settingsKey, next);
  return next;
}

/** What the person is told when the switch is off. One plain sentence, no jargon. */
export const switchedOffMessage =
  'Branch is not allowed to use your screen and keyboard. Turn on "Allow the assistant to use my screen and keyboard" in Settings first.';
/** What the person is told when a task has already taken its allowance of screen actions. */
export const cappedMessage = (cap: number): string =>
  `This task has already used the screen ${cap} times, which is as many as it may. Start it again if you want it to carry on.`;

/**
 * Windows that are never photographed and never typed into: password managers, the Windows sign-in
 * and permission prompts, and anything that asks for a password. Matched against the title the
 * computer reports and the name of the program, never against what was asked for, so asking for
 * "Bit*" cannot slip past it.
 */
const refusedTitles = [
  /bitwarden/i, /1password/i, /keepass/i, /lastpass/i, /dashlane/i, /nordpass/i, /roboform/i,
  /enpass/i, /proton pass/i, /keeper password/i, /\bvault\b/i,
  /windows security/i, /windows hello/i, /credential/i, /\bsign in\b/i, /\bpassword\b/i,
  /\bpasskey\b/i, /authenticator/i, /\bunlock\b/i, /lock screen/i,
];
const refusedPrograms = [
  /^logonui$/i, /^consent$/i, /^credentialuibroker$/i, /^lockapp$/i, /^bitwarden/i,
  /^1password/i, /^keepass/i, /^dashlane/i, /^nordpass/i, /^authenticator/i,
];
export interface WindowInfo {
  handle: string;
  title: string;
  className: string;
  program: string;
  processId: number;
  minimised: boolean;
  width: number;
  height: number;
}
/** Why this window is out of bounds, or null when it may be used. */
export function refusalFor(window: Pick<WindowInfo, 'title' | 'program'>): string | null {
  if (refusedTitles.some((pattern) => pattern.test(window.title)))
    return `That window is called "${window.title}", which looks like a password or sign-in window, so Branch will not touch it.`;
  if (refusedPrograms.some((pattern) => pattern.test(window.program)))
    return `That window belongs to ${window.program}, which handles passwords, so Branch will not touch it.`;
  return null;
}

/**
 * The same idea as the refused windows above, written for websites, so that letting Branch borrow
 * the owner's own signed-in browser can never reach a bank or a password manager. The window list
 * matches titles and program names, which a website name would never trip, so the sites are named
 * here beside it and both are checked. Matching covers the site and anything under it, so
 * "chase.com" covers "secure.chase.com".
 */
export const refusedHosts = [
  'bitwarden.com', 'vault.bitwarden.com', '1password.com', 'lastpass.com', 'dashlane.com',
  'nordpass.com', 'keeper.io', 'keepersecurity.com', 'enpass.io', 'proton.me', 'roboform.com',
  'chase.com', 'bankofamerica.com', 'wellsfargo.com', 'citi.com', 'citibank.com', 'usbank.com',
  'capitalone.com', 'americanexpress.com', 'amex.com', 'discover.com', 'schwab.com',
  'fidelity.com', 'vanguard.com', 'paypal.com', 'wise.com', 'revolut.com', 'monzo.com',
  'barclays.co.uk', 'hsbc.com', 'lloydsbank.com', 'natwest.com', 'santander.co.uk',
  'coinbase.com', 'binance.com', 'kraken.com', 'irs.gov', 'ssa.gov',
  // Email is how every other account is taken back, so a mailbox is treated like a bank.
  'mail.google.com', 'gmail.com', 'outlook.com', 'outlook.live.com', 'outlook.office.com',
  'office.com', 'mail.yahoo.com', 'icloud.com', 'mail.com', 'zoho.com', 'fastmail.com',
] as const;
/** Words in a website's name that mean it handles money or sign-ins, whoever runs it. */
const refusedHostWords = [/\bbank\b/i, /\bbanking\b/i, /\bcredit-?union\b/i, /\bvault\b/i, /password/i];

/**
 * Why this website is out of bounds for the owner's own browser, or null when it may be opened.
 * The owner may name more sites of their own (`extraRefusedHosts` in Settings); those are added to
 * the list above and can never take anything off it, so widening what Branch may reach in the
 * owner's own browser is not something this setting can do.
 */
export function hostRefusalFor(host: string, extra: readonly string[] = []): string | null {
  const name = host.trim().toLowerCase().replace(/:\d+$/, '');
  if (!name) return 'No website was named.';
  const mine = extra.map((entry) => entry.trim().toLowerCase()).filter(Boolean);
  const listed = [...refusedHosts, ...mine].find((entry) => name === entry || name.endsWith('.' + entry));
  if (listed)
    return `${listed} handles money or passwords, so Branch will not use your own browser there. Ask it to do this in its own browser, or do it yourself.`;
  if (refusedHostWords.some((pattern) => pattern.test(name)))
    return `"${host}" looks like a bank or a password site, so Branch will not use your own browser there.`;
  return null;
}

const windowMatch = z.string().trim().min(1).max(200);
export const DesktopScreenshotSchema = z.object({
  /** Part of the title of the window to photograph. Leave it out to photograph the whole screen. */
  window: windowMatch.optional(),
  /** Which screen to photograph when no window is named: 1 is the main one. */
  display: z.number().int().min(1).max(8).optional(),
}).strict();
export const DesktopWindowsSchema = z.object({
  action: z.enum(['list', 'focus', 'minimize', 'close']).default('list'),
  /** Part of the title of the window to act on; needed for everything but "list". */
  window: windowMatch.optional(),
}).strict();
export const DesktopReadSchema = z.object({
  window: windowMatch,
  /** Most parts of the window to describe; the rest are left out and the count says so. */
  limit: z.number().int().min(10).max(400).default(150),
}).strict();
/** computer-control: one spot in a window: a part by the ref desktop.read gave it, a part by name, or a point. */
const partRef = z.string().trim().regex(/^-?[0-9]+(\.-?[0-9]+){0,15}$/, 'Use a ref exactly as desktop.read gave it');
const windowPoint = z.object({ x: z.number().int().min(0).max(20000), y: z.number().int().min(0).max(20000) }).strict();
const spotFields = {
  /** The name of the button, box or link, exactly as `desktop.read` shows it. */
  name: z.string().trim().min(1).max(200).optional(),
  /** The ref `desktop.read` gave a part: exact even when several parts share a name. */
  ref: partRef.optional(),
  /** A place inside the window, in pixels from its top-left corner, as in its picture. */
  point: windowPoint.optional(),
};
const oneSpot = (value: { name?: string | undefined; ref?: string | undefined; point?: unknown }): boolean =>
  [value.name, value.ref, value.point].filter((part) => part !== undefined).length === 1;
export const DesktopSpotSchema = z.object(spotFields).strict().refine(oneSpot, 'Give one of a name, a ref or a point');
/** The picture or reading a point was taken from (desktop.screenshot, desktop.read): refused if the window moved since. */
const shot = z.string().regex(/^[a-f0-9]{16}$/).optional();
const modifierKeys = z.array(z.enum(['ctrl', 'shift', 'alt'])).max(3).optional();
export const DesktopClickSchema = z.object({
  window: windowMatch, ...spotFields, shot,
  /** Which mouse button; right opens a menu. */
  button: z.enum(['left', 'right', 'middle']).default('left'),
  /** 2 is a double-click, 3 a triple-click (a whole line or paragraph). */
  count: z.number().int().min(1).max(3).default(1),
  /** Keys held down during the click, such as ["ctrl"] to add to a selection. */
  modifiers: modifierKeys,
}).strict().refine(oneSpot, 'Give one of a name, a ref or a point');
export const DesktopMoveSchema = z.object({
  window: windowMatch, ...spotFields, shot,
  /** How long to rest there, in milliseconds, so a tooltip or a menu opened by hovering can appear. */
  hoverMs: z.number().int().min(0).max(10000).default(800),
}).strict().refine(oneSpot, 'Give one of a name, a ref or a point');
export const DesktopDragSchema = z.object({
  window: windowMatch, shot,
  from: DesktopSpotSchema, to: DesktopSpotSchema,
  button: z.enum(['left', 'right']).default('left'),
  modifiers: modifierKeys,
}).strict();
export const DesktopScrollSchema = z.object({
  window: windowMatch, ...spotFields, shot,
  direction: z.enum(['up', 'down', 'left', 'right']),
  /** Wheel notches (or small steps of a scrolling list), 1 to 10. */
  amount: z.number().int().min(1).max(10).default(3),
  modifiers: modifierKeys,
}).strict().refine((value) => [value.name, value.ref, value.point].filter((part) => part !== undefined).length <= 1, 'Give at most one of a name, a ref or a point');
export const DesktopWaitSchema = z.object({
  /** Seconds to wait for a program to catch up, 0.1 to 30. Stop ends the wait at once. */
  seconds: z.number().min(0.1).max(30),
}).strict();
export const DesktopZoomSchema = z.object({
  window: windowMatch, shot,
  /** The part of the window to look at closely, in window pixels as in its picture. */
  region: z.object({ x: z.number().int().min(0).max(20000), y: z.number().int().min(0).max(20000),
    width: z.number().int().min(4).max(4000), height: z.number().int().min(4).max(4000) }).strict(),
}).strict();
export const DesktopTypeSchema = z.object({
  window: windowMatch,
  /** The name of the box to type into; without it the window's first writable box is used. */
  name: z.string().trim().min(1).max(200).optional(),
  text: z.string().min(1).max(4000),
}).strict();
export const DesktopKeySchema = z.object({
  window: windowMatch,
  /** One key press such as "enter", "ctrl+s" or "alt+f4". */
  chord: z.string().trim().min(1).max(60),
  /** Press it this many times, such as 5 downs through a list. */
  repeat: z.number().int().min(1).max(20).default(1),
}).strict();
export const DesktopOpenSchema = z.object({
  /** A program to start, such as "notepad". Give this or a file, not both. */
  app: z.string().trim().min(1).max(100).regex(/^[a-z0-9 ._-]+$/i, 'Use the plain name of a program').optional(),
  /** A file in your workspace to open with whatever program usually opens it. */
  path: z.string().trim().min(1).max(500).optional(),
}).strict().refine((value) => Boolean(value.app) !== Boolean(value.path), 'Give either a program or a file, not both');
export const DesktopClipboardSchema = z.object({
  action: z.enum(['read', 'write']),
  text: z.string().max(4000).optional(),
}).strict().refine((value) => (value.action === 'write') === (value.text !== undefined), 'Writing needs text; reading takes none');

/**
 * Files that are programs rather than documents. "Open this with whatever usually opens it" is
 * meant for a document, and the switch the owner ticked says "use my screen and keyboard", not
 * "run programs out of my workspace" — so these are turned down and pointed at the host-command
 * tool, which has a switch of its own.
 */
const runnableEndings = ['.exe', '.com', '.bat', '.cmd', '.ps1', '.psm1', '.msi', '.scr', '.lnk', '.vbs', '.js', '.jse', '.wsf', '.hta', '.reg'];
export function runnableFile(path: string): string | null {
  const ending = runnableEndings.find((suffix) => path.toLowerCase().endsWith(suffix));
  return ending
    ? `A ${ending} file is a program, not a document, so Branch will not open it this way. Use the host-command tool if running something is really what is wanted.`
    : null;
}

/** Text that looks like it is standing in for a saved password, which is never typed. */
export function secretReferenceIn(text: string): string | null {
  if (/\{\{/.test(text)) return 'That text still has a {{placeholder}} in it, so Branch will not type it.';
  if (/\$env:[A-Z_]/i.test(text) || /%[A-Z][A-Z0-9_]{2,}%/.test(text))
    return 'That text points at a saved password or setting. Branch never types saved passwords for you.';
  return null;
}

const namedKeys: Record<string, string> = {
  enter: '{ENTER}', return: '{ENTER}', tab: '{TAB}', esc: '{ESC}', escape: '{ESC}',
  backspace: '{BACKSPACE}', delete: '{DELETE}', del: '{DELETE}', home: '{HOME}', end: '{END}',
  pageup: '{PGUP}', pagedown: '{PGDN}', up: '{UP}', down: '{DOWN}', left: '{LEFT}', right: '{RIGHT}',
  space: ' ', insert: '{INSERT}',
};
const modifiers: Record<string, string> = { ctrl: '^', control: '^', alt: '%', shift: '+' };
/**
 * Turns "ctrl+s" into the form Windows expects. Only plain letters, digits, function keys and the
 * named keys above are allowed, so nothing else can be smuggled in as a key press.
 */
export function keyChord(chord: string): string {
  const parts = chord.toLowerCase().split('+').map((part) => part.trim()).filter(Boolean);
  const last = parts.pop();
  if (!last || parts.length > 3) throw new Error(`"${chord}" is not a key Branch knows how to press`);
  let prefix = '';
  for (const part of parts) {
    const symbol = modifiers[part];
    if (!symbol) throw new Error(`"${part}" is not a key Branch knows how to hold down`);
    prefix += symbol;
  }
  if (namedKeys[last]) return prefix + namedKeys[last];
  if (/^f([1-9]|1[0-2])$/.test(last)) return `${prefix}{${last.toUpperCase()}}`;
  if (/^[a-z0-9]$/.test(last)) return prefix + last;
  throw new Error(`"${chord}" is not a key Branch knows how to press`);
}

/* computer-control: the rest of Anthropic's computer tool, in Branch's own terms. */

const heldVirtualKeys: Record<string, number> = { ctrl: 0x11, control: 0x11, shift: 0x10, alt: 0x12 };
const namedVirtualKeys: Record<string, number> = {
  enter: 0x0d, return: 0x0d, tab: 0x09, esc: 0x1b, escape: 0x1b, backspace: 0x08, delete: 0x2e, del: 0x2e,
  home: 0x24, end: 0x23, pageup: 0x21, pagedown: 0x22, up: 0x26, down: 0x28, left: 0x25, right: 0x27,
  space: 0x20, insert: 0x2d,
};
/**
 * A chord ("shift", "ctrl+a", "down") as the Windows virtual-key codes held for hold_key, in the order pressed. Only the
 * keys keyChord accepts, so a held chord can never be something a pressed one could not.
 */
export function holdKeyCodes(chord: string): number[] {
  // A chord of held keys alone ("shift", "ctrl+alt") is checked as that chord plus a letter; any other, as it is.
  keyChord(chord.split('+').every((part) => heldVirtualKeys[part.trim().toLowerCase()] !== undefined) ? `${chord}+a` : chord);
  const parts = chord.toLowerCase().split('+').map((part) => part.trim()).filter(Boolean);
  return parts.map((part) => {
    if (heldVirtualKeys[part] !== undefined) return heldVirtualKeys[part]!;
    if (namedVirtualKeys[part] !== undefined) return namedVirtualKeys[part]!;
    const f = /^f([1-9]|1[0-2])$/.exec(part);
    if (f) return 0x6f + Number(f[1]);
    if (/^[a-z0-9]$/.test(part)) return part.toUpperCase().charCodeAt(0);
    throw new Error(`"${chord}" is not a key Branch knows how to hold`);
  });
}
export const DesktopHoldKeySchema = z.object({
  window: windowMatch,
  /** The key or chord to hold, such as "shift" or "ctrl+a". */
  chord: z.string().trim().min(1).max(60),
  /** How long to hold it, 0.1 to 10 seconds. */
  seconds: z.number().min(0.1).max(10),
}).strict();
export const DesktopButtonSchema = z.object({
  window: windowMatch, ...spotFields, shot,
  button: z.enum(['left', 'right', 'middle']).default('left'),
}).strict().refine((value) => [value.name, value.ref, value.point].filter((part) => part !== undefined).length <= 1, 'Give at most one of a name, a ref or a point');
export const DesktopCursorSchema = z.object({
  /** A window to say the pointer's place in, in its pixels; without one, the place on the screen. */
  window: windowMatch.optional(),
}).strict();
const pair = z.tuple([z.number().int().min(0).max(20000), z.number().int().min(0).max(20000)]);
/**
 * Anthropic's computer tool, action for action, so a Claude model drives Branch's computer as it was trained to. The
 * one difference: coordinates are in the pixels of the named window's own picture (desktop.screenshot of it), not of a
 * whole display, because Branch works a window at a time.
 */
export const DesktopComputerSchema = z.object({
  window: windowMatch.optional(),
  action: z.enum(['screenshot', 'zoom', 'left_click', 'right_click', 'middle_click', 'double_click', 'triple_click',
    'left_click_drag', 'mouse_move', 'left_mouse_down', 'left_mouse_up', 'scroll', 'type', 'key', 'hold_key', 'wait', 'cursor_position']),
  coordinate: pair.optional(),
  start_coordinate: pair.optional(),
  /** The words for type, the key for key and hold_key, or held keys ("shift", "ctrl+shift") for a click or scroll. */
  text: z.string().max(4000).optional(),
  scroll_direction: z.enum(['up', 'down', 'left', 'right']).optional(),
  scroll_amount: z.number().int().min(1).max(10).optional(),
  /** Seconds, for wait and hold_key. */
  duration: z.number().min(0.1).max(30).optional(),
  /** For zoom: [x0, y0, x1, y1] in window pixels. */
  region: z.tuple([z.number().int().min(0), z.number().int().min(0), z.number().int().min(0), z.number().int().min(0)]).optional(),
  /** For key: press it this many times. */
  repeat: z.number().int().min(1).max(20).optional(),
  shot: z.string().regex(/^[a-f0-9]{16}$/).optional(),
}).strict();

/** Held keys for a click or scroll as Anthropic's tool writes them ("shift", "ctrl+shift"). Other keys are refused. */
export function computerModifiers(text: string | undefined): ('ctrl' | 'shift' | 'alt')[] {
  if (!text) return [];
  return text.toLowerCase().split('+').map((part) => part.trim()).filter(Boolean).map((part) => {
    if (part === 'ctrl' || part === 'control') return 'ctrl';
    if (part === 'shift' || part === 'alt') return part;
    throw new Error(`"${part}" cannot be held during a click here; use ctrl, shift or alt.`);
  });
}
