/* QA retest 2026-09-28: every popular chat app's card promised "Two minutes to set up", Signal included, which needs a
   separate program installed and a phone linked, and WhatsApp, which needs a Meta developer app. A card now says what
   that app really needs (window.channels.needs.<id>); an app with no line of its own says nothing about time. */
import { t } from "../../i18n.js";

export function setupNeeds(channel) {
  const key = `window.channels.needs.${channel?.id ?? ""}`;
  const words = t(key);
  return words === key ? null : words;
}
