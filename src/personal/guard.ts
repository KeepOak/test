import type { ToolContext, ToolDefinition } from "../contracts.js";
import { runOrigin, startedFromChat, startedWithShortLivedKey } from "../key-context.js";
import type { RunSource } from "../policy.js";
import type { ToolRegistry } from "../registry.js";
import type { Store } from "../store.js";
import { listedPersonalTools, personalParts, personalTools } from "./settings.js";
import { calendarWriteTools } from "./calendar-write.js";
import { mailSendTools } from "./mail-send.js";

/**
 * R17-C integration review: what keeps the owner's mail, calendar, files elsewhere, music and house
 * the owner's own, whoever or whatever else can reach a tool.
 *
 *   - Every personal tool refuses a household profile, a signed-in person and a short-lived key
 *     before it does anything (`ownerOnlyTools`).
 *   - Work the owner did not start themselves — a schedule, a trigger, another AI tool, another
 *     agent — is asked about before any personal tool runs, whatever the rules say, including
 *     "No approvals" (`personalHold`, called from the runtime's policy check).
 *   - A lock, a door, a garage door or an alarm is asked about every time, just this once, for the
 *     owner's own work too.
 */
const personalToolNames = new Set(listedPersonalTools(() => true));
export const isPersonalTool = (tool: string): boolean => personalToolNames.has(tool);

/** Kinds of Home Assistant device that open the house or stop it being watched. */
export const alwaysAskDomains: ReadonlySet<string> = new Set(["lock", "cover", "alarm_control_panel", "valve", "siren", "button"]);

/** Whether a home.call (its arguments, or its target entity) touches a lock, door or alarm. */
export function opensTheHouse(tool: string, argsOrTarget: unknown): boolean {
  if (tool !== "home.call") return false;
  const kinds = typeof argsOrTarget === "string" ? [argsOrTarget.split(".")[0]]
    : [(argsOrTarget as { domain?: unknown } | null)?.domain, String((argsOrTarget as { entity?: unknown } | null)?.entity ?? "").split(".")[0]];
  return kinds.some((kind) => typeof kind === "string" && alwaysAskDomains.has(kind));
}

export interface PersonalHold { reason: string; onceOnly: boolean }

/** Why this call must be put to the owner even where the rules would let it through, or null. */
export function personalHold(tool: string, args: unknown, source: RunSource): PersonalHold | null {
  if (mailSendTools.has(tool))
    return { reason: "Send this exact mail preview? Sending always needs your one-time confirmation", onceOnly: true };
  if (calendarWriteTools.has(tool))
    return { reason: "Calendar changes and their meeting notifications always need your confirmation for this exact change", onceOnly: true };
  if (opensTheHouse(tool, args))
    return { reason: "Locks, doors, garage doors and alarms are always asked about, just this once", onceOnly: true };
  if (isPersonalTool(tool) && source !== "owner")
    return { reason: "Work you did not start yourself asks before it reaches your mail, calendar, files, music or house", onceOnly: false };
  return null;
}

export const chatPersonalRefusal =
  "A message from a chat app cannot reach your mail, calendar, files, music or house. Do it in the app window.";
export const shortLivedPersonalRefusal =
  "A short-lived key cannot reach your mail, calendar, files, music or house. Do it in the app window.";

/** A registry whose tools refuse anybody but the owner before they run. */
export function ownerOnlyTools(registry: ToolRegistry, store: Store, requireOwner: (what: string) => void): Pick<ToolRegistry, "register"> {
  const check = (context: ToolContext): void => {
    requireOwner("Your mail, calendar, files, music and house");
    const origin = context.runId && store.run(context.runId) ? runOrigin(store, context.runId) : null;
    if (startedWithShortLivedKey() || origin?.shortLivedKey) throw new Error(shortLivedPersonalRefusal);
    if (startedFromChat(context, store)) throw new Error(chatPersonalRefusal);
  };
  return {
    register<T>(definition: ToolDefinition<T>): void {
      registry.register<T>({ ...definition, execute: async (input, context) => { check(context); return definition.execute(input, context); } });
    },
  };
}
