import { api, token } from "../core/api.js";
import { E } from "../core/state.js";
import { onDemo17 } from "../places/demo17.js";
import { t } from "../../i18n.js";

const words = (key, vars) => t(`window.settings.telegram-depth.${key}`, vars);
const yesNo = (value) => value ? t("accounts.switch.on") : t("accounts.switch.off");
let request = 0;

/** Readouts omit account identities; stale owner reads must not open over another person's view. */
export function initTelegramDepth(show) {
  onDemo17("tgdepth", { open: async () => {
    const sequence = ++request, credential = token.get();
    const profiles = await api("profiles");
    if (profiles.active || E.profiles?.active || credential !== token.get()) return;
    const data = await api("channels/telegram-depth");
    const [current, lock] = await Promise.all([api("profiles"), api("lock")]);
    if (sequence !== request || lock.locked || current.active || E.profiles?.active || credential !== token.get()) return;
    const rows = [];
    for (const [index, connection] of data.connections.entries()) {
      rows.push([words("connection", { count: index + 1 }), words(`health-${connection.health.replaceAll(" ", "-")}`), null]);
      rows.push([words("group-activation"), words(connection.activation), null]);
      rows.push([words("pairing"), yesNo(connection.pairing), null]);
      rows.push([words("allowlist"), String(connection.allowlistedSenders), null]);
      for (const key of ["typing", "reactions", "edits", "buttons", "voiceReplies"])
        rows.push([words(key), yesNo(connection[key]), null]);
      rows.push([words("text-limit"), connection.maxTextLength == null ? words("unknown") : String(connection.maxTextLength), null]);
    }
    if (data.connections.length) for (const key of ["liveStatus", "commands", "steering", "splitting", "steps"])
      rows.push([words(key), t(`accounts.switch.${data.live[key]}`), null]);
    show("tgdepth", words(data.connections.length ? "snapshot" : "not-connected"), rows);
  } });
}
