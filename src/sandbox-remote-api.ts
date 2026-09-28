import type { IncomingMessage } from "node:http";
import { z } from "zod";
import type { createBranch } from "./index.js";
import { firewallView, testFirewall } from "./firewall.js";
import { codeRunSettings } from "./code-run.js";
import {
  defaultSandboxProbe, sandboxBackendReport, sandboxBackendSet, sandboxBackendSettings,
  saveSandboxBackendSettings, wallReport,
} from "./sandbox-backends.js";
import { saveWallSettings, wallSettings } from "./sandbox.js";
import { audit } from "./audit.js";
import { saveSessionLimits, sessionLimits } from "./session-limits.js";
import { RetentionSettingsSchema, retentionLooser, retentionSettings, saveRetentionSettings, sentenceFor } from "./retention.js";
import { lockdownActive } from "./lockdown.js";
import { looseningRefusal, withoutConfirm } from "./policy-change-guard.js";
import { recordedWrite } from "./settings-kit/recorded-write.js";

/**
 * Batch 26 (wave 8): the screens for where scripts run, what may reach the internet, how much one
 * person may ask for, the owner's other computers, and letting old conversations go.
 *
 * Every one of these was a module with tests and no way for the owner to reach it. This is the one
 * door to all five, kept out of `src/server.ts` so it can be read on its own.
 */
type Branch = Awaited<ReturnType<typeof createBranch>>;

export class SandboxRemoteApiError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
export function handlesSandboxRemotePath(path: string): boolean {
  return /^\/api\/(sandboxes|os-sandbox|firewall|limits|remotes|marks|retention)(\/|$)/.test(path);
}

const AddressSchema = z.object({ address: z.string().trim().min(1).max(2000) }).strict();
const MarkSchema = z.object({ id: z.string().trim().min(1).max(64) }).strict();
const RemoveSchema = z.object({ computer: z.string().trim().min(1).max(64) }).strict();

/** The firewall card: the rules read back as sentences, from the settings that really decide. */
export function firewallFor(app: Branch) {
  return firewallView({
    policy: app.web.policy.settings(),
    browserOrigins: app.reach.browserOrigins,
    browserAnyWebsite: app.reach.browserAnyWebsite,
    scriptsMayReachInternet: codeRunSettings(app.store, app.runtime.owner).network,
    commandsMayReachInternet: app.reach.commandsMayReachInternet,
  });
}

export async function sandboxRemoteApi(
  app: Branch, request: IncomingMessage, path: string,
  readBody: (request: IncomingMessage, limit?: number) => Promise<unknown>,
): Promise<unknown> {
  const owner = app.runtime.owner, get = request.method === "GET", post = request.method === "POST";
  const signal = AbortSignal.timeout(60_000);

  // Where scripts run: the owner's choice, and what this computer can actually offer.
  if (path === "/api/sandboxes") {
    if (post) saveSandboxBackendSettings(app.store, owner, await readBody(request));
    const settings = sandboxBackendSettings(app.store, owner);
    const backends = await sandboxBackendReport(sandboxBackendSet({ settings, probe: defaultSandboxProbe() }));
    return { settings, backends };
  }

  // Wave mac3 (os-sandbox): the wall around programs — the owner's switch, and whether this computer
  // can build it. Only the app window's own key may change it (see offLimitsToShortLivedKeys).
  if (path === "/api/os-sandbox") {
    if (post) {
      const before = wallSettings(app.store, owner);
      const input = await readBody(request);
      const after = recordedWrite(app.store, owner, { writer: "owner-in-window", source: "card", detail: "os-sandbox" }, ["os-sandbox"],
        () => saveWallSettings(app.store, owner, input));
      // Integration review: the wall widens or narrows what a program may reach, so every change is written down.
      audit(app.store, owner, { action: "policy.changed", actor: owner,
        subject: `Wall around programs: ${after.mode}, network ${after.network}`.slice(0, 300),
        reason: `Was ${before.mode}, network ${before.network}; ${Object.keys(after.keySites).length} keys tied to sites, ${after.unreadable.length} extra hidden places.`,
        outcome: "saved" });
    }
    else if (!get) throw new SandboxRemoteApiError(405, "Only reading and saving are possible here.");
    return { settings: wallSettings(app.store, owner), computer: await wallReport() };
  }

  // What may reach out, in sentences, and the button that asks the real check about one address.
  if (get && path === "/api/firewall") return firewallFor(app);
  if (post && path === "/api/firewall/test") {
    const { address } = AddressSchema.parse(await readBody(request));
    return testFirewall((target) => app.web.policy.assertAllowed(target), address, app.reach.browserOrigins, app.reach.browserAnyWebsite);
  }

  // How much one conversation, or one person messaging from outside, may ask for.
  if (path === "/api/limits") {
    if (post) return { limits: saveSessionLimits(app.store, owner, await readBody(request)) };
    return { limits: sessionLimits(app.store, owner) };
  }

  // The owner's other computers.
  if (path === "/api/remotes") {
    if (post) return { computer: await app.remotes.add(await readBody(request)) };
    return { computers: app.remotes.list() };
  }
  if (post && path === "/api/remotes/remove") {
    const { computer } = RemoveSchema.parse(await readBody(request));
    return { removed: app.remotes.remove(computer) };
  }

  // A way back to before a set of changes was written.
  if (get && path === "/api/marks") return { marks: app.checkpoints.list() };
  if (post && path === "/api/marks/undo") {
    const { id } = MarkSchema.parse(await readBody(request));
    return app.checkpoints.undo(id, signal);
  }
  if (post && path === "/api/marks/forget") {
    const { id } = MarkSchema.parse(await readBody(request));
    return { forgotten: await app.checkpoints.forget(id, signal) };
  }

  // Letting old conversations go: the rule, what it would sweep up, and the sweep itself.
  if (path === "/api/retention") {
    if (post) {
      // Keeping conversations longer needs the owner's yes, and never under Lockdown (src/policy-change-guard.ts).
      const { confirmLoosening, input } = withoutConfirm(await readBody(request));
      const looser = retentionLooser(retentionSettings(app.store, owner), RetentionSettingsSchema.parse(input ?? {}));
      const refusal = looseningRefusal(looser, confirmLoosening, lockdownActive(app.store, owner));
      if (refusal) throw new SandboxRemoteApiError(409, refusal);
      const saved = recordedWrite(app.store, owner, { writer: "owner-in-window", source: "card", detail: "retention" }, ["retention"],
        () => saveRetentionSettings(app.store, owner, input));
      return { ...app.retention.propose(), settings: saved, sentence: sentenceFor(saved) };
    }
    return { ...app.retention.propose(), settings: retentionSettings(app.store, owner) };
  }
  if (post && path === "/api/retention/prune") return app.retention.prune(await readBody(request));

  throw new SandboxRemoteApiError(404, "Unknown address");
}
