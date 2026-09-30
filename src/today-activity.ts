import type { Store } from "./store.js";
import { safeTitle } from "./history-ideas.js";

function calendarKey(date: Date, formatter: Intl.DateTimeFormat): string {
  return formatter.formatToParts(date).filter((p) => ["year", "month", "day"].includes(p.type))
    .map((p) => `${p.type}:${p.value}`).join("|");
}

export function todayActivity(store: Store, owner: string, timezone: string, hide: (text: string) => string) {
  if (!timezone || timezone.length > 100) throw new Error("Choose a valid local timezone.");
  const formatter = new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" });
  const now = new Date(), day = calendarKey(now, formatter);
  const scanned = store.completedActivity(owner, new Date(now.getTime() - 48 * 60 * 60 * 1000).toISOString());
  const capped = scanned.length > 1000;
  const completed = scanned.slice(0, 1000).filter((r) => {
    const time = new Date(r.completedAt);
    return Number.isFinite(time.getTime()) && time <= now && calendarKey(time, formatter) === day;
  });
  return { timezone, date: formatter.format(now), measuredAt: now.toISOString(), count: completed.length,
    capped, listed: Math.min(100, completed.length), history: "Retained local owner history only; deleted, archived, temporary, shared, helper, practice, resumed and unattributed tasks excluded. Missing or older unretained history is unknown.",
    rows: completed.slice(0, 100).map((r) => ({ ...r, title: safeTitle(r.title, hide) || "Untitled task", status: "completed" })) };
}
