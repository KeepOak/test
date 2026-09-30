import { z } from "zod";
import type { Store } from "../store.js";

/**
 * How "Show steps in chats" looks, for every chat app at once and for each app on its own: the owner's knobs behind
 * the Hermes Agent-style steps message (src/channels/progress-render.ts, src/channels/live-status.ts).
 *
 * Taken from both projects, keeping the better one where they differ:
 * - `detail` is Hermes Agent's `display.tool_progress`: `new` shows a step only when the kind of tool changes, `all`
 *   every step, `verbose` whole commands and each tool's input as code; `off` shows no steps in that app.
 * - `grouping` is Hermes Agent's `tool_progress_grouping`: `one` edits one message in place ("accumulate"), `each`
 *   sends a message per step ("separate").
 * - `lineChars` is OpenClaw's `streaming.progress.maxLineChars` (120) rather than Hermes Agent's 40-character preview:
 *   a sentence is cut at a word, a path in the middle so its file name stays, a command at its end.
 * - `commands` is OpenClaw's `commandText`: `show` puts the command as code (Hermes Agent's way, and Branch's), `hide`
 *   says only that a command ran.
 * - `overflow` is Hermes Agent's: a list too long for one message carries on in a new one (`roll`), where OpenClaw
 *   keeps only the newest lines (`trim`, "(N earlier)").
 * - `cleanup` is Hermes Agent's `cleanup_progress` and OpenClaw's Discord behaviour: the steps message is removed once
 *   a good answer has arrived; a failed task keeps it as the record of what happened.
 * - `noEdit` is for an app that cannot edit a message. Hermes Agent sends nothing there and OpenClaw only the answer;
 *   Branch puts one line naming the kinds of step above the reply (`summary`), or a message per step (`each`).
 * - `groups`: in a group chat the steps are counts of kinds ("📖 Reading 2 files") and never name a file or command;
 *   `off` shows no steps message in groups at all.
 *
 * Every value ships on (the owner's rule: useful features start on). A value set for one app wins over the one for
 * every app, which wins over the default.
 */
export const StepsDetailSchema = z.enum(["off", "new", "all", "verbose"]);
/** The knobs as the owner sets them, each one optional: a knob not set follows the level above it. */
const PartialDisplay = z.object({
  detail: StepsDetailSchema.optional(),
  grouping: z.enum(["one", "each"]).optional(),
  lineChars: z.number().int().min(40).max(400).optional(),
  commands: z.enum(["show", "hide"]).optional(),
  overflow: z.enum(["roll", "trim"]).optional(),
  cleanup: z.boolean().optional(),
  noEdit: z.enum(["summary", "each", "off"]).optional(),
  groups: z.enum(["kinds", "off"]).optional(),
  /**
   * Pictures of Branch's browser while a task works in it (the way GrokBot and Muse show their browser in a chat): a
   * picture of the page after the task's first browser step and then now and again, with the step as its caption. A
   * direct chat only; password and code boxes are covered, and a borrowed browser is never pictured.
   */
  pictures: z.enum(["browser", "off"]).optional(),
}).strict();
export const stepsDisplayDefaults = {
  detail: "all", grouping: "one", lineChars: 120, commands: "show", overflow: "roll", cleanup: false, noEdit: "summary", groups: "kinds",
  pictures: "browser",
} as const satisfies Required<z.infer<typeof PartialDisplay>>;
export type StepsDisplay = { -readonly [K in keyof typeof stepsDisplayDefaults]-?: NonNullable<z.infer<typeof PartialDisplay>[K]> };
export type StepsDisplayChange = z.infer<typeof PartialDisplay>;
const appName = z.string().trim().min(1).max(64).regex(/^[a-z0-9][a-z0-9_-]*$/, "An app's id or kind, such as telegram");
export const StepsSettingsSchema = z.object({
  /** For every chat app. */
  all: PartialDisplay.default({}),
  /** For one app, by its connection id ("telegram-work") or its kind ("telegram"); the id wins. */
  apps: z.record(appName, PartialDisplay).default({}),
}).strict();
export type StepsSettings = z.infer<typeof StepsSettingsSchema>;
const settingKey = "chat-steps-display";

/** The saved knobs; anything unreadable is the defaults. */
export function stepsSettings(store: Pick<Store, "get">, owner: string): StepsSettings {
  const parsed = StepsSettingsSchema.safeParse(store.get("settings", owner, settingKey)?.data ?? {});
  return parsed.success ? parsed.data : StepsSettingsSchema.parse({});
}
/**
 * Changes some knobs. `all` names the ones for every app; `apps.<name>` the ones for that app, where `null` (or an
 * empty object) goes back to following every app. Knobs not named keep their value.
 */
export function saveStepsSettings(store: Store, owner: string, input: unknown): StepsSettings {
  const change = z.object({
    all: PartialDisplay.optional(),
    apps: z.record(appName, PartialDisplay.nullable()).optional(),
  }).strict().parse(input ?? {});
  const before = stepsSettings(store, owner);
  const apps: StepsSettings["apps"] = { ...before.apps };
  for (const [name, knobs] of Object.entries(change.apps ?? {})) {
    const merged = knobs === null ? {} : { ...apps[name], ...knobs };
    if (Object.keys(merged).length) apps[name] = merged; else delete apps[name];
  }
  const next = StepsSettingsSchema.parse({ all: { ...before.all, ...change.all }, apps });
  if (Object.keys(next.apps).length > 100) throw new Error("Steps can be set for at most 100 chat apps");
  store.save("settings", owner, settingKey, next);
  return next;
}
/** The knobs one app works to: its own (by id, then by kind), then every app's, then the defaults. */
export function stepsDisplayFor(settings: StepsSettings, app: { id: string; kind: string }): StepsDisplay {
  return { ...stepsDisplayDefaults, ...defined(settings.all), ...defined(settings.apps[app.kind]), ...defined(settings.apps[app.id]) } as StepsDisplay;
}
/** The knobs actually set, leaving out any the owner left to follow the level above. */
function defined(knobs: StepsDisplayChange | undefined): StepsDisplayChange {
  return Object.fromEntries(Object.entries(knobs ?? {}).filter(([, value]) => value !== undefined));
}

const chatDetailKey = (channel: string, chatId: string): string => `chat-steps-detail:${channel}:${chatId}`;
/** A chat-specific choice wins over its app's choice; unreadable records follow the app. */
export function stepsInChat(store: Pick<Store, "get">, owner: string, channel: string, chatId: string, display: StepsDisplay): StepsDisplay {
  const saved = z.object({ detail: StepsDetailSchema }).strict().safeParse(store.get("settings", owner, chatDetailKey(channel, chatId))?.data);
  return saved.success ? { ...display, detail: saved.data.detail } : display;
}
/**
 * Adapted from Hermes gateway/slash_commands.py's /verbose cycle and gateway/display_config.py's override precedence
 * (MIT, Copyright (c) 2025 Nous Research): Branch saves the override per chat instead of changing the whole platform.
 */
export function verboseInChat(store: Pick<Store, "get" | "save" | "delete">, owner: string, channel: string, chatId: string,
  argument: string, display: StepsDisplay): string {
  const word = argument.trim().toLowerCase();
  if (word === "default") {
    store.delete("settings", owner, chatDetailKey(channel, chatId));
    return "Steps in this chat follow this app's settings again.";
  }
  const cycle = ["off", "new", "all", "verbose"] as const;
  const current = stepsInChat(store, owner, channel, chatId, display).detail;
  const choice = word === "on" ? "all" : word === "full" ? "verbose" : word;
  const next = choice ? StepsDetailSchema.safeParse(choice) : { success: true as const, data: cycle[(cycle.indexOf(current) + 1) % cycle.length]! };
  if (!next.success) return "Use /verbose off, new, all, full or default; /verbose on its own cycles the level.";
  store.save("settings", owner, chatDetailKey(channel, chatId), { detail: next.data });
  const descriptions = { off: "off", new: "only when the kind of step changes", all: "every step", verbose: "every step with its details" };
  return `Steps in this chat: ${descriptions[next.data]}. This applies to the next task; typing and reactions keep their usual settings.`;
}
