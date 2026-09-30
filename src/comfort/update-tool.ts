import { z } from "zod";
import type { Store } from "../store.js";
import type { ToolContext } from "../contracts.js";
import type { ToolRegistry } from "../registry.js";
import { chatOwnerOnly, runOrigin, startedFromChat, startedWithShortLivedKey } from "../key-context.js";
import { lockedDown } from "../lockdown.js";
import { requestInstallNow, updateSummary, type UpdateSummary } from "./update-now.js";

/**
 * `branch.update`: the owner asks Branch about its own updates: which version runs, the newest change that passed its
 * checks, and why an update waits. `branch.install_update` asks the app's own update loop to install the newest version at the next safe moment (update-now.ts), through the same updater, check on a copy
 * of the work and way back as any update. Only the owner, in the Branch app or a task of their own: a chat's task, a
 * short-lived key or somebody else's conversation cannot ask for an install (the owner's own chat has `/update`).
 */

export interface UpdateFacts { version: string; commit: () => string | null; newestPassing: () => Promise<string | null> }

export async function updateStatus(store: Store, owner: string, facts: UpdateFacts): Promise<UpdateSummary> {
  return updateSummary(store, owner, { version: facts.version, commit: facts.commit(), newestPassing: await facts.newestPassing() });
}

function mayInstall(store: Store, context: ToolContext): void {
  const what = "Updating Branch";
  store.profiles.requireOwner(what);
  const origin = context.runId && store.run(context.runId) ? runOrigin(store, context.runId) : null;
  if (startedWithShortLivedKey() || origin?.shortLivedKey) throw new Error(`${what} is for the owner only, and a short-lived key cannot ask for it.`);
  if (startedFromChat(context, store)) throw chatOwnerOnly(what);
  if (origin?.personProfileId || origin?.lentTo) throw new Error(`${what} is for the owner only, and this conversation belongs to somebody else.`);
  if (lockedDown(store, context.owner)) throw new Error(`${what} waits while Lockdown is on.`);
}

export function registerUpdateTool(registry: ToolRegistry, store: Store, facts: UpdateFacts): void {
  registry.register({
    name: "branch.update", permission: "settings.read", group: "settings",
    description: "Branch's own updates: which version of Branch is running, the newest change that passed its checks, whether updating by itself is on, and why an update is waiting. To install the newest version, the owner asks for branch.install_update.",
    parameters: z.object({}).strict(),
    target: () => "Branch's version and updates",
    execute: async (_input: Record<string, never>, context: ToolContext) => {
      store.profiles.requireOwner("Branch's updates");
      return await updateStatus(store, context.owner, facts);
    },
  });
  // Installing changes what runs and goes ahead even with updating by itself off, so it is a change, not a look: its own
  // tool with a changing permission, which the approval policy asks about in Ask first and a read-only task never has.
  registry.register({
    name: "branch.install_update", permission: "settings.write", group: "settings",
    description: "Asks Branch to install its newest version at the next safe moment (the owner only). It is checked on a copy of the work first and goes back by itself if the new version does not start. branch.update says what would be installed.",
    parameters: z.object({}).strict(),
    target: () => "install the newest Branch",
    execute: async (_input: Record<string, never>, context: ToolContext) => {
      store.profiles.requireOwner("Branch's updates");
      mayInstall(store, context);
      if (context.dryRun) return { wouldAsk: "install the newest version at the next safe moment" };
      requestInstallNow(store, context.owner, "branch.install_update");
      const now = await updateStatus(store, context.owner, facts);
      return { asked: true, words: `${now.words} It installs at the next safe moment; the app looks within a few minutes.`, status: now };
    },
  });
}
