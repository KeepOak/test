import { z } from "zod";
import { audit } from "../audit.js";
import { registerSignedInGemini } from "../gemini-signin.js";
import type { ModelRouter } from "../models.js";
import type { OAuthConnections } from "../oauth.js";
import { CliAgentChoiceSchema, registerCliAgent } from "../providers/cli-agent.js";
import type { Store } from "../store.js";
import { geminiSignInState } from "../voice-api.js";

/**
 * The sign-in connections the owner made come back after Branch starts again:
 *   - each coding assistant added with POST /api/providers/cli-agents (Claude Code, Codex, Copilot, Gemini CLI, or a
 *     command the owner named), written down as the choice that was asked for and checked again by `rowFor` when it
 *     is registered, exactly as the add route checks it. Nothing is started: the program runs only when asked.
 *   - Gemini signed in with Google, when a client id is saved and the sign-in's tokens are in the locker.
 * Only choices are kept, owner by owner; the programs keep their own sign-ins and Branch never reads them. This is not
 * asks/runtimes and does not follow its switch: running a plan the owner already pays for spends nothing new.
 */
const settingKey = "cli-agents-added";
const SavedSchema = z.object({ agents: z.array(CliAgentChoiceSchema).max(20).default([]) }).strict();
type Choice = z.infer<typeof CliAgentChoiceSchema>;
type Registers = Pick<ModelRouter, "register">;

export function savedPrograms(store: Pick<Store, "get">, owner: string): Choice[] {
  const saved = SavedSchema.safeParse(store.get("settings", owner, settingKey)?.data ?? {});
  return saved.success ? saved.data.agents : [];
}

/** The add route: registered first (which refuses anything `rowFor` refuses), then written down under its id. */
export function addProgram(models: Registers, store: Store, owner: string, input: unknown) {
  const choice = CliAgentChoiceSchema.parse(input);
  const made = registerCliAgent(models, choice);
  const others = savedPrograms(store, owner).filter((entry) => entry.id !== choice.id);
  store.save("settings", owner, settingKey, SavedSchema.parse({ agents: [...others, choice].slice(-20) }));
  audit(store, owner, { action: "connection.changed", actor: owner, subject: made.id,
    reason: "A coding assistant installed on this computer was added as a connection, with its own sign-in", outcome: "added" });
  return made;
}

/** A connection taken out (POST /api/connections/forget) stays out after a restart. */
export function forgetProgram(store: Store, owner: string, connection: string): void {
  if (!connection.startsWith("cli-")) return;
  const kept = savedPrograms(store, owner).filter((entry) => `cli-${entry.id}` !== connection);
  if (kept.length !== savedPrograms(store, owner).length) store.save("settings", owner, settingKey, { agents: kept });
}

/** At start: every saved program registered again (one that no longer passes the checks is skipped), then Gemini. */
export async function restoreSignIns(deps: { store: Store; owner: string; models: ModelRouter; oauth?: OAuthConnections }): Promise<string[]> {
  const back: string[] = [];
  for (const choice of savedPrograms(deps.store, deps.owner)) {
    try { back.push(registerCliAgent(deps.models, choice).id); } catch { /* skipped: it no longer passes rowFor's checks */ }
  }
  const { settings } = geminiSignInState(deps.store, deps.owner, deps.models);
  const oauth = deps.oauth;
  if (oauth && settings.clientId && await oauth.saved("google-gemini")) {
    // Renewing an expired token may reach Google, so start-up does not wait for it.
    void registerSignedInGemini(oauth, settings, (preset) => deps.models.register(preset)).catch(() => undefined);
  }
  return back;
}
