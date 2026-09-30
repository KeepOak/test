import { z } from "zod";
import { forgetChosen, markChosen, savedFields, shippedUnlessChosen } from "../ship-on.js";
import type { Store } from "../store.js";
import { isSecretEntry } from "../files.js";

/**
 * R17-S15 … R17-S21: the comfort settings. Every default below is exactly what Branch did before the
 * setting existed, so a fresh install behaves as it always has. Each card has its own record, so
 * saving one card never touches another.
 */

/**
 * A key combination written the way people say it: "Ctrl+K", "Ctrl+Shift+K", "F8". Empty means none.
 * "Ctrl" is the computer's main key: Command on a Mac, Control elsewhere. On a Mac the Control key
 * itself is "Control", so Control+B and Command+B are two different combinations there.
 */
export const keyCombo = z.string().max(40).regex(
  /^$|^((Ctrl|Control|Alt|Shift)\+){1,4}([A-Z0-9,./;]|Space|Enter|Tab|F([1-9]|1[0-2]))$|^F([1-9]|1[0-2])$/,
  "Write a key as Ctrl+K, Alt+Shift+P or F8",
);
/** The window's shortcuts that can be changed, with the keys they have always had. */
export const shortcutDefaults = {
  palette: "Ctrl+K",
  newConversation: "Ctrl+N",
  appearance: "Ctrl+,",
  sidePane: "Ctrl+Shift+K",
  sideList: "Ctrl+B",
  newTrunk: "",
  /** UI-106: the message box, and the list's own search (Telegram-style), each one key away. */
  focusPrompt: "Ctrl+L",
  stopTask: "Ctrl+Shift+S",
  /** Turn Lockdown on; turning it off remains an explicit banner/Settings choice. */
  lockdownOn: "Ctrl+Shift+L",
  searchHistory: "Ctrl+Shift+F",
  lookInside: "",
  /** Pass 17: the small ask box from any app. The desktop app registers it system-wide; ⌥ Space on a Mac. */
  quickAsk: "Ctrl+Shift+Space",
  /** The redesigned window's own (prototype KEYS15): focus mode, Talk live, the Inbox, the next conversation. */
  focusMode: "Ctrl+.",
  talkLive: "Ctrl+Shift+V",
  openInbox: "Ctrl+I",
  nextConversation: "Ctrl+Tab",
  /** UI-106: the conversation before the one open, and "Who is using Branch" (the person menu). */
  previousConversation: "Ctrl+Shift+Tab",
  switchPerson: "",
  findConversation: "Ctrl+F",
  conversation1: "Ctrl+1",
  conversation2: "Ctrl+2",
  conversation3: "Ctrl+3",
  conversation4: "Ctrl+4",
  conversation5: "Ctrl+5",
  conversation6: "Ctrl+6",
  conversation7: "Ctrl+7",
  conversation8: "Ctrl+8",
  conversation9: "Ctrl+9",
} as const;
export type ShortcutAction = keyof typeof shortcutDefaults;
export const shortcutActions = Object.keys(shortcutDefaults) as ShortcutAction[];

/**
 * A shortcut left unset takes its default, unless another shortcut already has those keys: then it gives way and has
 * none, so a new default (the window's own, parity B6) never clashes with keys the owner chose before it existed, and
 * never makes their whole saved record unreadable.
 */
function defaultsGiveWay(input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const saved = input as Record<string, unknown>;
  const taken = new Set(shortcutActions.map((action) => saved[action]).filter((v): v is string => typeof v === "string" && v !== "").map((v) => v.toLowerCase()));
  const out: Record<string, unknown> = { ...saved };
  for (const action of shortcutActions)
    if (!(action in saved) && shortcutDefaults[action] && taken.has(shortcutDefaults[action].toLowerCase())) out[action] = "";
  return out;
}

/** R17-S15: which keys do what in the window, and vim keys in the message box. */
export const ComfortKeysSchema = z.preprocess(defaultsGiveWay, z.object({
  palette: keyCombo.default(shortcutDefaults.palette),
  newConversation: keyCombo.default(shortcutDefaults.newConversation),
  appearance: keyCombo.default(shortcutDefaults.appearance),
  sidePane: keyCombo.default(shortcutDefaults.sidePane),
  sideList: keyCombo.default(shortcutDefaults.sideList),
  newTrunk: keyCombo.default(shortcutDefaults.newTrunk),
  focusPrompt: keyCombo.default(shortcutDefaults.focusPrompt),
  stopTask: keyCombo.default(shortcutDefaults.stopTask),
  lockdownOn: keyCombo.default(shortcutDefaults.lockdownOn),
  searchHistory: keyCombo.default(shortcutDefaults.searchHistory),
  lookInside: keyCombo.default(shortcutDefaults.lookInside),
  quickAsk: keyCombo.default(shortcutDefaults.quickAsk),
  focusMode: keyCombo.default(shortcutDefaults.focusMode),
  talkLive: keyCombo.default(shortcutDefaults.talkLive),
  openInbox: keyCombo.default(shortcutDefaults.openInbox),
  nextConversation: keyCombo.default(shortcutDefaults.nextConversation),
  previousConversation: keyCombo.default(shortcutDefaults.previousConversation),
  switchPerson: keyCombo.default(shortcutDefaults.switchPerson),
  findConversation: keyCombo.default(shortcutDefaults.findConversation),
  conversation1: keyCombo.default(shortcutDefaults.conversation1),
  conversation2: keyCombo.default(shortcutDefaults.conversation2),
  conversation3: keyCombo.default(shortcutDefaults.conversation3),
  conversation4: keyCombo.default(shortcutDefaults.conversation4),
  conversation5: keyCombo.default(shortcutDefaults.conversation5),
  conversation6: keyCombo.default(shortcutDefaults.conversation6),
  conversation7: keyCombo.default(shortcutDefaults.conversation7),
  conversation8: keyCombo.default(shortcutDefaults.conversation8),
  conversation9: keyCombo.default(shortcutDefaults.conversation9),
  /** Esc leaves typing for moving (h j k l, w b, 0 $, x, dd, i a o), as in vim. */
  vim: z.boolean().default(false),
}).strict().superRefine((value, context) => {
  const used = shortcutActions.map((action) => value[action].toLowerCase()).filter(Boolean);
  if (new Set(used).size !== used.length) context.addIssue({ code: "custom", message: "Two shortcuts use the same keys. Give each its own." });
}));

export const statusItems = ["model", "context", "folder", "cost", "time"] as const;
export type StatusItem = (typeof statusItems)[number];
/** R17-S16: what the status line shows, and a time on every message. */
export const ComfortDisplaySchema = z.object({
  /** null keeps the line as it has always been; a list shows exactly those, in that order. */
  statusLine: z.array(z.enum(statusItems)).max(statusItems.length).nullable().default(null),
  /** Show when each message was written. */
  timestamps: z.boolean().default(false),
  /** wire-greyed: message times Never: no time on a message, not even on hover. Only counts while timestamps is off. */
  hideTimes: z.boolean().default(false),
}).strict();

/** R17-S17: how Branch gets your attention, and whether it updates itself. */
export const ComfortNotifySchema = z.object({
  /** system: a notification from the computer as well as the banner; window: the banner only. */
  method: z.enum(["system", "window"]).default("system"),
  /** A short sound when Branch needs you. */
  sound: z.enum(["off", "chime", "knock"]).default("off"),
  /**
   * wire-greyed: tell the owner when a Trunk waits for their yes, and when a task that ran two minutes or longer finishes.
   * Both are told in the window (and by the computer when `method` is "system"); nothing is sent anywhere else. On by
   * default under the ship-on rule: none of (a)–(f).
   */
  needsYes: z.boolean().default(true),
  taskDone: z.boolean().default(true),
  /** off: manual only; check: daily for Stable, every minute for Beta; install: also install when idle. Read through `readComfort`, which ships "install". */
  autoUpdate: z.enum(["off", "check", "install"]).default("off"),
  /**
   * Stable (the default) installs published releases; Beta builds every merged change on this computer. Dev was
   * that build before it became Beta, so a saved "dev" reads, and is kept, as "beta".
   */
  releaseChannel: z.preprocess((value) => (value === "dev" ? "beta" : value), z.enum(["stable", "beta"])).default("stable"),
}).strict();

/** R17-S18: a key to hold while speaking, and the longest a recording may run. */
export const ComfortVoiceSchema = z.object({
  pushToTalkKey: keyCombo.default(""),
  /** A recording stops by itself after this many seconds; null means it runs until you let go. */
  maxRecordingSeconds: z.number().int().min(5).max(600).nullable().default(null),
}).strict();

/** R17-S19: how carefully the browser acts. Owner only. */
export const ComfortBrowserSchema = z.object({
  /** Ask every time before the browser types, presses, uploads or borrows your browser. */
  confirmSensitive: z.boolean().default(false),
  /** Refuse every file upload to a website. */
  blockUploads: z.boolean().default(false),
  /** What happens to a website's pop-up message box: dismiss (Cancel) or accept (OK). */
  dialogs: z.enum(["dismiss", "accept"]).default("dismiss"),
  /** Ask once for each site before a task opens an address on it; a yes for always is kept as a rule for that site. */
  askNewSites: z.boolean().default(false),
  /** Open the conversation's browser full size when its task starts working in it. Ships on. */
  openFullSize: z.boolean().default(true),
  /** A Trunk may number what can be pressed on a page and act by number (browser.annotate). Ships on, as it always was. */
  numberMarks: z.boolean().default(true),
  /** Keep a step-by-step browser trace of every task that opens a page, beside its other files. Off: it writes a file per task. */
  recordTasks: z.boolean().default(false),
  /**
   * Where a file a page sends may come from: anywhere the network rules allow, only a site the task's pages were on, or
   * held outside the workspace until the owner says yes to keeping it (browser.keep_download, asked every time).
   */
  downloadsFrom: z.enum(["anywhere", "known", "ask"]).default("anywhere"),
}).strict();

const hostName = z.string().trim().min(1).max(253).regex(/^[a-z0-9.*-]+$/i, "Write a host name such as intranet.example.com");
/** A certificate the owner trusts, as PEM text. Checked in network.ts before it is kept. */
export const CaCertificateSchema = z.object({
  name: z.string().trim().min(1).max(80),
  pem: z.string().min(100).max(20000),
}).strict();
/** R17-S20: a proxy and extra certificates for everything Branch reaches. Owner only. */
export const ComfortNetworkSchema = z.object({
  /** http://host:port or https://host:port; null means no proxy. */
  proxy: z.string().trim().max(300).nullable().default(null),
  /** Hosts that are reached directly, not through the proxy. */
  noProxy: z.array(hostName).max(50).default([]),
  /** Certificates added to the ones this computer already trusts. They never replace them. */
  caCertificates: z.array(CaCertificateSchema).max(10).default([]),
}).strict();

const ignoreName = z.string().trim().min(1).max(120)
  .regex(/^[^/\\:*?"<>|]+$/, "Name a file in the workspace's top folder, such as .aiignore")
  // Integration review: a file that may hold secrets is never read, not even as a list of names.
  .refine((name) => !isSecretEntry(name), "That file may hold secrets, so it cannot be used as an ignore file");
/** R17-S20: which ignore files hide paths from the assistant's searches. */
export const ComfortFilesSchema = z.object({
  /** Use .gitignore when there is no .branchignore (as always). Off uses .branchignore only. */
  respectGitignore: z.boolean().default(true),
  /** Further ignore files whose lines are added to the ones above. */
  extraIgnoreFiles: z.array(ignoreName).max(8).default([]),
}).strict();

/** R17-S20: how long a tool server may take to start. */
export const ComfortMcpSchema = z.object({
  startupTimeoutSeconds: z.number().int().min(1).max(300).default(10),
}).strict();

export const comfortCards = {
  keys: ComfortKeysSchema,
  display: ComfortDisplaySchema,
  notify: ComfortNotifySchema,
  voice: ComfortVoiceSchema,
  browser: ComfortBrowserSchema,
  network: ComfortNetworkSchema,
  files: ComfortFilesSchema,
  mcp: ComfortMcpSchema,
} as const;
export type ComfortCard = keyof typeof comfortCards;
export type ComfortValues = { [K in ComfortCard]: z.infer<(typeof comfortCards)[K]> };
export const comfortCardNames = Object.keys(comfortCards) as ComfortCard[];
/** Cards only the owner may change, in the owner's own profile, with the computer's own key. */
export const ownerOnlyComfortCards: readonly ComfortCard[] = ["browser", "network"];

const keyOf = (card: ComfortCard): string => `comfort-${card}`;
type Reader = Pick<Store, "get">;

/** One card's settings, with today's behaviour for anything never saved or saved wrongly. */
/**
 * The owner's rule (ships on, 2026-09-26): a short chime when Branch needs you is sound out only; none of (a)–(f).
 * Updating by itself installs when nothing is working (the owner's standing rule: updates work with zero clicks, for
 * everyone). It only fetches Branch's own releases, sends nothing of the owner's and publishes nothing, so it is not (b).
 */
export const comfortShipsOn: Partial<Record<ComfortCard, Record<string, unknown>>> = { notify: { sound: "chime", autoUpdate: "install" } };

/**
 * What a saved card ships as. Installing by itself ships on for Beta too (the owner's standing rule: they never press
 * Update, and Beta is how each merged fix reaches them). An "off" the owner chose is kept (ship-on.ts chosenFields).
 */
function shipsFor(card: ComfortCard): Record<string, unknown> | undefined {
  return comfortShipsOn[card];
}

export function readComfort<K extends ComfortCard>(store: Reader, owner: string, card: K): ComfortValues[K] {
  const schema = comfortCards[card] as unknown as z.ZodType<ComfortValues[K]>;
  const saved = schema.safeParse(store.get("settings", owner, keyOf(card))?.data ?? {});
  if (!saved.success) return schema.parse({});
  const ships = shipsFor(card);
  return ships ? shippedUnlessChosen(store, owner, keyOf(card), saved.data as Record<string, unknown>, ships) as ComfortValues[K] : saved.data;
}

/** Saves one card; fields left out keep what was there. Returns what is now in force. */
export function saveComfort<K extends ComfortCard>(store: Store, owner: string, card: K, input: unknown): ComfortValues[K] {
  const schema = comfortCards[card] as unknown as z.ZodType<ComfortValues[K]>;
  const before = store.get("settings", owner, keyOf(card))?.data;
  const next = schema.parse({ ...readComfort(store, owner, card), ...(input && typeof input === "object" ? input : {}) });
  store.save("settings", owner, keyOf(card), next as Record<string, unknown>);
  markChosen(store, owner, keyOf(card), savedFields(before, schema.safeParse(before ?? {}).success, input, comfortShipsOn[card] ?? {}));
  return next;
}

/** Every card, for the screen. */
export function allComfort(store: Reader, owner: string): ComfortValues {
  return Object.fromEntries(comfortCardNames.map((card) => [card, readComfort(store, owner, card)])) as ComfortValues;
}

/** Puts one card back to how Branch ships. */
export function resetComfort(store: Store, owner: string, card: ComfortCard): void {
  store.save("settings", owner, keyOf(card), {});
  forgetChosen(store, owner, keyOf(card));
}
