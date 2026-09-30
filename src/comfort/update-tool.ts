import { z } from "zod";
import type { Store } from "../store.js";
import type { ToolContext } from "../contracts.js";
import type { ToolRegistry } from "../registry.js";
import { chatOwnerOnly, runOrigin, startedFromChat, startedWithShortLivedKey } from "../key-context.js";
import { lockedDown } from "../lockdown.js";
import { requestInstallNow, updateSummary, type UpdateSummary } from "./update-now.js";

/**
 * `branch.update`: the owner asks Branch about its own updates, or asks it to update itself. `status` says which
 * version runs, the newest change that passed its checks, and why an update waits; `install` asks the app's own update
 * loop to install the newest version at the next safe moment (update-now.ts), through the same updater, check on a copy
 * of the work and way back as any update. Only the owner, in the Branch app or a task of their own: a chat's task, a
 * short-lived key or somebody else's conversation cannot ask for an install (the owner's own chat has `/update`).
 */
const UpdateToolSchema = z.object({ action: z.enum(["status", "install"]).default("status") }).strict();

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
    description: "Branch's own updates. action \"status\" says which version of Branch is running, the newest change that passed its checks, whether updating by itself is on, and why an update is waiting. action \"install\" asks Branch to install the newest version at the next safe moment (the owner only; it is checked on a copy of the work first and goes back by itself if the new version does not start).",
    parameters: UpdateToolSchema,
    target: (input: z.infer<typeof UpdateToolSchema>) => (input.action === "install" ? "install the newest Branch" : "Branch's version and updates"),
    execute: async (input: z.infer<typeof UpdateToolSchema>, context: ToolContext) => {
      store.profiles.requireOwner("Branch's updates");
      if (input.action === "install") {
        mayInstall(store, context);
        if (context.dryRun) return { wouldAsk: "install the newest version at the next safe moment" };
        requestInstallNow(store, context.owner, "branch.update");
        const now = await updateStatus(store, context.owner, facts);
        return { asked: true, words: `${now.words} It installs at the next safe moment; the app looks within a few minutes.`, status: now };
      }
      return await updateStatus(store, context.owner, facts);
    },
  });
}
