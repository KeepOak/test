import type { FeatureMode } from "./feature-switches.js";
import type { Store } from "./store.js";
import { unsetRecord } from "./ship-on.js";

/**
 * GitLab's switch and whether it is connected, on their own so the switch table (src/feature-switches.ts) can read them
 * without loading the connection (src/gitlab-connection.ts).
 *
 * The switch ships "when needed" (defaults audit, 2026-09-28): it does nothing until a token is saved, and every change
 * on GitLab asks the owner first (`gitlab.manage`). So the tools only reach the index once GitLab is connected: in the
 * window (Settings › Advanced › GitLab, a token kept in the locker) or by an older launch settings file naming it.
 */
export const gitlabSwitchKey = "gitlab-connection";
export const gitlabAccountKey = "gitlab-account";
export const gitlabShipsAs: FeatureMode = "when-needed";
export const gitlabToolNames = ["gitlab.issues", "gitlab.issue", "gitlab.merge_requests", "gitlab.merge_request", "gitlab.releases",
  "gitlab.pipelines", "gitlab.create_issue", "gitlab.comment", "gitlab.open_merge_request", "gitlab.create_project"] as const;
const modes: readonly string[] = ["off", "when-needed", "on"];

type Reader = Pick<Store, "get">;

/** A launch settings file that names GitLab (`git.gitlab`), per engine (its store); set when the file is loaded, for this run only. */
const launched = new WeakMap<object, unknown>();
export const gitlabLaunch = {
  set(store: Reader, settings: unknown): void { launched.set(store, settings); },
  get(store: Reader): unknown | null { return launched.has(store) ? launched.get(store) ?? {} : null; },
};

/** The owner's switch; a record holding only it was written by the owner moving it, and one that can't be read is off. */
export function gitlabMode(store: Reader, owner: string): FeatureMode {
  const found = store.get("settings", owner, gitlabSwitchKey);
  if (!found || unsetRecord(found.data)) return gitlabShipsAs;
  const mode = (found.data as { mode?: unknown } | undefined)?.mode;
  return typeof mode === "string" && modes.includes(mode) ? mode as FeatureMode : "off";
}

/** Connected: a token saved from the window (and checked with GitLab then), or a launch file naming GitLab. */
export function gitlabConnected(store: Reader, owner: string): boolean {
  if (gitlabLaunch.get(store) !== null) return true;
  const account = store.get("settings", owner, gitlabAccountKey)?.data as { connected?: unknown } | undefined;
  return account?.connected === true;
}
