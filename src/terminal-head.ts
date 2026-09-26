import type { Runtime } from "./runtime.js";
import { neverBreakModeSync } from "./never-break/gateway-config.js";
import { shareLeft } from "./usage-glance.js";
import { usageGlance } from "./usage-limits-api.js";
import { trunksFor } from "./trunks/index.js";
import { reachFor } from "./reach/index.js";
import type { PlaceApp } from "./terminal-place-data.js";
import type { RailItem } from "./terminal-everywhere.js";
import type { Words } from "./terminal-words.js";

/**
 * What the prototype's terminal shows along its head and status line (design/redesign/prototype.html termHTML):
 * this computer's name, the gateway on or off, the version, and each window of the tightest account with what it
 * has left. All of it is read from what the window reads; nothing is written in when the engine has no value.
 */
export interface LimitWindowLeft { title: string; percentLeft: number }
export interface HeadFacts { computer: string; gateway: boolean; version?: string; limits: LimitWindowLeft[] }

/** The windows of the account with the least left, each with its share; none for anybody but the owner. */
function limitWindows(app: PlaceApp): LimitWindowLeft[] {
  const glance = usageGlance(app as unknown as Parameters<typeof usageGlance>[0]);
  if (!glance.available || glance.settings.ring === "hidden" || !glance.tightest) return [];
  const tight = glance.tightest;
  const row = glance.rows.find((entry) => entry.connection === tight.connection && entry.accountLabel === tight.accountLabel);
  return (row?.windows ?? []).flatMap((window) => {
    const share = shareLeft(window);
    return share === null ? [] : [{ title: window.title, percentLeft: Math.floor(share) }];
  }).slice(0, 2);
}

/**
 * This computer's name as the window's switcher shows it: the name the owner gave it (GET /api/reach machineName), or
 * the window's own words for it while it has none (public/app/shell/shell.js).
 */
function computerName(runtime: Runtime, words: Words): string {
  let name = "";
  try { name = reachFor(runtime)?.machineName() ?? ""; } catch { name = ""; } // no name given yet: the window's words
  return name || words.t("dashboard.computer.title", "This computer");
}

export function headFacts(app: PlaceApp | undefined, runtime: Runtime, words: Words): HeadFacts {
  let limits: LimitWindowLeft[] = [];
  try { limits = app ? limitWindows(app) : []; } catch { limits = []; }
  return { computer: computerName(runtime, words), gateway: neverBreakModeSync(runtime.store.folder) !== "off",
    ...(app?.version ? { version: app.version } : {}), limits };
}

/** Beside each Trunk on the rail, what it is doing now: working, or waiting for the owner. Nothing when idle. */
export function railStates(app: PlaceApp | undefined, rail: RailItem[], words: Words): string[] {
  if (!app || !app.store.profiles.isOwner()) return rail.map(() => "");
  const trunks = trunksFor(app.runtime)?.records.list() ?? [];
  const active = new Map(app.store.activeRuns(app.runtime.owner).map((run) => [run.sessionId, run.status]));
  return rail.map((item) => {
    if (item.kind !== "trunk") return "";
    const trunk = trunks.find((entry) => !entry.hidden && (entry.name === item.name || entry.name.startsWith(item.name.replace(/…$/, ""))));
    const status = trunk ? active.get(trunk.chatSessionId) : undefined;
    return status === "needs_input" ? words.t("dashboard.needs.title", "Needs you") : status === "running" ? words.t("window.shell.working", "Working") : "";
  });
}
