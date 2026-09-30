import type { Event } from "./contracts.js";
import { stepCategory } from "./live-steps.js";

export type TrunkActivity = "work" | "think" | "search" | "read" | "talk";

// These tools actually send something; mail search, inbox listing and drafts do not speak.
const OUTGOING = new Set(["channels.broadcast", "channels.digest", "chat.send_file", "brief.send", "brief.send_voice"]);

/** A character's pose from recorded activity, without exposing tool names, arguments or labels. */
export function trunkActivity(events: readonly Event[]): TrunkActivity {
  // Store.events returns the first 2,000 events. At that boundary the current tail is unknown.
  if (events.length >= 2000) return "work";
  const active = new Map<string, string>();
  let modelActive = false;
  for (const event of events) {
    const id = typeof event.data.id === "string" ? event.data.id : String(event.data.id ?? `e${event.id}`);
    if (event.kind === "model.started") modelActive = true;
    else if (["model.completed", "model.failed", "model.stalled", "model.cancelled"].includes(event.kind)) modelActive = false;
    else if (event.kind === "tool.started" || event.kind === "program.step.started") {
      // Parallel steps use the most recently started still-active step; finishing it reveals the previous one.
      active.delete(id);
      active.set(id, typeof event.data.name === "string" ? event.data.name : "");
    } else if (["tool.completed", "tool.failed", "tool.stalled", "program.step.finished"].includes(event.kind)) active.delete(id);
  }
  const names = [...active.values()];
  if (!names.length) return modelActive ? "think" : "work";
  const name = names[names.length - 1]!;
  if (OUTGOING.has(name)) return "talk";
  const category = stepCategory(name);
  if (category === "search" || category === "find") return "search";
  if (category === "page" || category === "read") return "read";
  return "work";
}
