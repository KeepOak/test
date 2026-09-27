import { t, language } from "../../i18n.js";

/** A service's reset instant in the viewer's local zone. Missing instants stay unknown. */
export function usageReset(value, { locale = language(), timeZone } = {}) {
  if (typeof value !== "string" || !value.trim()) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const clock = { hour: "numeric", minute: "2-digit", timeZoneName: "short", ...(timeZone ? { timeZone } : {}) };
  return {
    full: new Intl.DateTimeFormat(locale, { weekday: "long", year: "numeric", month: "numeric", day: "numeric", ...clock }).format(date),
    compact: new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", ...clock }).format(date),
  };
}

export function resetWords(value, compact = false) {
  const reset = usageReset(value);
  return reset ? t("window.shell.usage.resets-time", { time: reset[compact ? "compact" : "full"] }) : t("glance.resetUnknown");
}
