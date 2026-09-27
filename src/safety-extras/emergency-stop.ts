import { z } from "zod";
import { audit } from "../audit.js";
import { globMatches, hostMatches, type PolicyResource } from "../policy-resources.js";
import type { Store } from "../store.js";
import { codesResting, releaseNeedsCode, restingRefusal, takeCode } from "./code-approvals.js";

/**
 * mac7/r17-g (R17-063): an emergency stop by level, beside Lockdown (which is all or nothing and
 * still lets the owner say yes). Each level refuses outright, for every task and every hand-pressed
 * tool, until the owner lets it go:
 *
 *   everything  no tool runs at all
 *   network     nothing that reaches past this computer (web, browser, messages, other AI tools),
 *               and the owner's network rules refuse every address
 *   sites       the named sites, in tools and in the network rules
 *   tools       the named tools ("shell.execute", "browser.*")
 *
 * Pressing it never needs a code; letting it go does, once the owner has set up authenticator codes
 * and ticked that choice. The levels follow ZeroClaw's `security/estop.rs` (MIT or Apache-2.0);
 * the code is written here.
 */
const stateKey = "safety-emergency-stop";
const hostList = z.array(z.string().trim().toLowerCase().min(1).max(253).regex(/^[a-z0-9.*-]+$/, "Give a site as a plain name, such as example.com")).max(200);
export const StopLevelsSchema = z.object({
  everything: z.boolean().default(false),
  network: z.boolean().default(false),
  sites: hostList.default([]),
  tools: z.array(z.string().trim().min(1).max(80)).max(200).default([]),
}).strict();
export type StopLevels = z.infer<typeof StopLevelsSchema>;
export interface StopState extends StopLevels { engaged: boolean; since: string | null }

type Reader = Pick<Store, "get">;
export function stopState(store: Reader, owner: string): StopState {
  const data = (store.get("settings", owner, stateKey)?.data ?? {}) as Record<string, unknown>;
  const parsed = StopLevelsSchema.safeParse({ everything: data.everything, network: data.network, sites: data.sites, tools: data.tools });
  const levels = parsed.success ? parsed.data : StopLevelsSchema.parse({});
  const engaged = levels.everything || levels.network || levels.sites.length > 0 || levels.tools.length > 0;
  return { ...levels, engaged, since: engaged && typeof data.since === "string" ? data.since : null };
}

/** Presses the stop at the levels given, adding to whatever is already stopped. */
export function engageStop(store: Store, owner: string, input: unknown): StopState {
  const asked = StopLevelsSchema.parse(input ?? {});
  const now = stopState(store, owner);
  // Checked as it will be read back: a record stopState cannot read counts as nothing stopped, so pressing again with
  // more than it can hold is refused and what is already stopped stays as it is.
  const next: StopLevels = StopLevelsSchema.parse({
    everything: now.everything || asked.everything, network: now.network || asked.network,
    sites: [...new Set([...now.sites, ...asked.sites])], tools: [...new Set([...now.tools, ...asked.tools])],
  });
  store.save("settings", owner, stateKey, { ...next, since: now.since ?? new Date().toISOString() });
  audit(store, owner, { action: "lockdown.changed", actor: owner, subject: "Emergency stop pressed",
    reason: describeLevels(next), outcome: "saved" });
  return stopState(store, owner);
}

export const releaseCodeRefusal = "Letting the emergency stop go needs the six-digit code from your authenticator app.";

/** Lets every level go. Needs a good code when the owner chose that. */
export async function releaseStop(store: Store, owner: string, input: unknown): Promise<StopState> {
  const { code } = z.object({ code: z.string().max(12).optional() }).strict().parse(input ?? {});
  if (releaseNeedsCode(store, owner) && !(await takeCode(store, owner, code ?? "")))
    throw new Error(codesResting(store, owner) ? restingRefusal : releaseCodeRefusal);
  store.save("settings", owner, stateKey, { ...StopLevelsSchema.parse({}), since: null });
  audit(store, owner, { action: "lockdown.changed", actor: owner, subject: "Emergency stop let go",
    reason: "Every level of the emergency stop was released", outcome: "saved" });
  return stopState(store, owner);
}

export function describeLevels(levels: StopLevels): string {
  const parts = [levels.everything ? "every tool" : "", levels.network ? "everything that reaches past this computer" : "",
    levels.sites.length ? `the sites ${levels.sites.join(", ")}` : "", levels.tools.length ? `the tools ${levels.tools.join(", ")}` : ""];
  return `Stopped: ${parts.filter(Boolean).join("; ") || "nothing"}`;
}

/**
 * Tools that reach past this computer, judged from the tool's name and permission only. Programs
 * and scripts are among them: nothing stops a program opening a connection of its own.
 */
const reachesOut = /^(web|browser|http|fetch|channels|email|mcp|a2a|remote|realtime|voice\.live|github|issues|payments|webhooks|nodes|hindsight|answer|sources|shell|terminal|code\.run|code\.execute|process\.start|tools\.script)\b/;

const hostOfValue = (value: string): string => {
  try { return new URL(value).hostname.toLowerCase(); } catch { return value.trim().toLowerCase(); }
};

/** Why the stop refuses this call, or null. */
export function stopRefusal(store: Reader, owner: string, tool: string, permission: string, resource: PolicyResource | null): string | null {
  const state = stopState(store, owner);
  if (!state.engaged) return null;
  const tail = " The emergency stop is on; let it go in Settings, Permissions.";
  if (state.everything) return `No tool runs while everything is stopped.${tail}`;
  if (state.tools.some((pattern) => globMatches(pattern, tool))) return `${tool} is stopped.${tail}`;
  if (state.network && (reachesOut.test(tool) || reachesOut.test(permission) || resource?.kind === "host"))
    return `Nothing that reaches past this computer runs now.${tail}`;
  const host = resource?.kind === "host" ? hostOfValue(resource.value) : null;
  if (host && state.sites.some((site) => hostMatches(site.replace(/^\*\./, ""), host))) return `${host} is stopped.${tail}`;
  return null;
}

/** For the owner's network rules: throws when the stop refuses this address. */
export function assertAddressNotStopped(store: Reader, owner: string, target: URL): void {
  const state = stopState(store, owner);
  if (!state.engaged) return;
  const host = target.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (state.everything || state.network) throw new Error("The emergency stop is on, so nothing is reached over the network.");
  if (state.sites.some((site) => hostMatches(site.replace(/^\*\./, ""), host))) throw new Error(`The emergency stop is on for ${host}.`);
}
