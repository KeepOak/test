import type { Store } from "../store.js";
import { readComfort } from "./settings.js";
import { updateProblem } from "./auto-update.js";

/**
 * The owner asking Branch to update itself (the `branch.update` tool, `/update install` from their own chat). The
 * request is kept here, and the app's own update loop takes it on its next look (every 30 s to 5 min): it looks for the
 * newest version and installs it at the next safe moment, through the same updater, check on a copy of the work and
 * way back as any update. Asked for by the owner, it goes ahead even with updating by itself off, and tries again a
 * version whose install failed before. It is dropped once Branch has the newest version, or after six hours.
 */
const requestKey = "comfort-update-install-now";
const requestLastsMs = 6 * 60 * 60 * 1000;

export function requestInstallNow(store: Store, owner: string, by: string, now = new Date()): void {
  store.save("settings", owner, requestKey, { at: now.toISOString(), by });
}
export function installRequested(store: Pick<Store, "get">, owner: string, now = Date.now()): boolean {
  const at = store.get("settings", owner, requestKey)?.data?.at;
  return typeof at === "string" && now - Date.parse(at) < requestLastsMs;
}
export function clearInstallRequest(store: Store, owner: string): void {
  if (store.get("settings", owner, requestKey)?.data?.at) store.save("settings", owner, requestKey, { at: null });
}

/** What the last look at the plan said (auto-update.ts noteUpdateLook), for the owner's status. */
export interface LastLook { at: string; step?: string; reason?: string }
export function lastLook(store: Pick<Store, "get">, owner: string): LastLook | null {
  const data = store.get("settings", owner, "comfort-update-looked")?.data as { at?: unknown; step?: unknown; reason?: unknown } | undefined;
  if (typeof data?.at !== "string") return null;
  return { at: data.at, ...(typeof data.step === "string" ? { step: data.step } : {}), ...(typeof data.reason === "string" ? { reason: data.reason } : {}) };
}

/**
 * The newest change on Beta's line whose whole suite passed on GitHub (the same rule the updater takes, dev-build.ts
 * newestGreen): asked at most every five minutes, one small unauthenticated request. Null when GitHub cannot say.
 */
export function newestPassing(repo: string, fetchImpl: typeof fetch = globalThis.fetch, everyMs = 5 * 60_000): () => Promise<string | null> {
  let known: string | null = null, askedAt = 0;
  return async () => {
    if (known && Date.now() - askedAt < everyMs) return known;
    try {
      const response = await fetchImpl(`https://api.github.com/repos/${repo}/actions/workflows/checks.yml/runs?branch=redesign%2Fwindow&event=push&status=success&per_page=1`,
        { headers: { accept: "application/vnd.github+json", "user-agent": "Branch-Agent" }, signal: AbortSignal.timeout(15_000) });
      if (response.ok) {
        const sha = ((await response.json()) as { workflow_runs?: { head_sha?: unknown }[] }).workflow_runs?.[0]?.head_sha;
        if (typeof sha === "string" && /^[0-9a-f]{40}$/.test(sha)) { known = sha; askedAt = Date.now(); }
      }
    } catch { /* offline: the last one found stands */ }
    return known;
  };
}

export interface UpdateSummary {
  version: string; commit: string | null; channel: string; updatingByItself: string;
  newestPassing: string | null; newer: boolean | null; installRequested: boolean;
  lastLook: LastLook | null; problem: string | null; words: string;
}
/** Which version runs, the newest that passed its checks, and why an update waits, in plain words. */
export function updateSummary(store: Pick<Store, "get">, owner: string, facts: { version: string; commit: string | null; newestPassing: string | null }): UpdateSummary {
  const notify = readComfort(store, owner, "notify");
  const look = lastLook(store, owner), problem = updateProblem(store, owner)?.message || null, requested = installRequested(store, owner);
  const short = (sha: string | null) => sha ? sha.slice(0, 7) : "unknown";
  const newer = facts.commit && facts.newestPassing ? facts.commit !== facts.newestPassing : null;
  const parts = [`Branch ${facts.version} is running (change ${short(facts.commit)}), on ${notify.releaseChannel === "stable" ? "Stable" : "Beta"}.`];
  if (notify.releaseChannel !== "stable")
    parts.push(facts.newestPassing ? `The newest change that passed its checks is ${short(facts.newestPassing)}${newer === false ? ", which is this one." : "."}` : "GitHub did not say which change passed its checks last.");
  parts.push(notify.autoUpdate === "install" ? "Updating by itself is on." : notify.autoUpdate === "check" ? "Branch only looks for updates by itself; it does not install them." : "Updating by itself is off.");
  if (requested) parts.push("An update was asked for: it installs at the next safe moment.");
  if (look) parts.push(`Last look ${look.at.slice(11, 16)} UTC${look.reason ? `: ${look.reason}` : "."}`);
  else parts.push("The app has not looked for an update yet.");
  if (problem) parts.push(`Problem: ${problem}`);
  return { version: facts.version, commit: facts.commit, channel: notify.releaseChannel, updatingByItself: notify.autoUpdate,
    newestPassing: facts.newestPassing, newer, installRequested: requested, lastLook: look, problem, words: parts.join(" ") };
}
