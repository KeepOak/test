/**
 * Setup's "Tools to start with" step: what this Branch can use, read from the engine rather than written into the window.
 *
 * - Built in: the registry's own tools, sorted into six plain kinds by their toolbox (src/catalog.ts). Tools a tool
 *   server, a skill package or a connected program lends are left out: they are somebody else's, and the window lists
 *   the tool servers apart. Machinery that is always there (answering, the tool index, settings, skills) is left out too.
 *   Each kind says how many tools it has, how many of those are switched off (src/feature-switches.ts), and how many
 *   ask first or are refused, judged the way a new conversation in the window is judged: the owner's saved approval
 *   settings under the mode a new conversation starts on (src/conversation-mode.ts), before anything is asked for.
 * - What each starter Trunk from setup needs: references only (a chat app, one of the personal connectors, a
 *   command-line tool the engine looks for, or a skill that comes with Branch). Their state is read from the routes
 *   that change them: GET /api/channels, /api/personal, /api/clis and the skills in GET /api/state.
 */
import type { ToolRegistry } from "./registry.js";
import type { Store } from "./store.js";
import { evaluatePolicy, isReadOnlyPermission, readPolicy, type Policy } from "./policy.js";
import { conversationModeSettings, policyForMode } from "./conversation-mode.js";
import { lockdownActive } from "./lockdown.js";
import { switchedToolTiers } from "./feature-switches.js";
import { isCommandTool } from "./policy-resources.js";

/** The six kinds, each the toolboxes it is made of. */
export const setupKinds = [
  { id: "files", boxes: ["files", "documents", "workbook"] },
  { id: "web", boxes: ["web", "browser"] },
  { id: "terminal", boxes: ["code", "git", "remote"] },
  { id: "mail", boxes: ["personal", "channels"] },
  { id: "memory", boxes: ["memory", "memory-extra", "todos"] },
  { id: "more", boxes: ["media", "data", "research", "desktop", "schedules", "automations", "agents"] },
] as const;

/** Tools lent by a tool server, a skill package or a connected program. */
const lent = (name: string): boolean => /^(mcp|skill|client)\./.test(name);

export type StarterNeed =
  | { kind: "channel"; id: string }
  | { kind: "personal"; id: string }
  | { kind: "cli"; id: string }
  | { kind: "skill"; id: string };

/**
 * What each starter Trunk in setup works with, by the template's id (the last part of its words' key). Every id here is
 * one the engine has: a chat app in data/channel-setup.json, a part in src/personal/settings.ts, a name in
 * src/own-clis.ts `knownClis`, or a skill in src/browser-skills.ts (tests/setup-tools.test.mjs holds it to that).
 */
export const starterNeeds: Record<string, readonly StarterNeed[]> = {
  inbox: [{ kind: "channel", id: "email" }, { kind: "personal", id: "google" }, { kind: "personal", id: "microsoft" }],
  expense: [{ kind: "channel", id: "email" }, { kind: "personal", id: "mail-search" }],
  researcher: [{ kind: "skill", id: "search-and-summarise" }, { kind: "skill", id: "read-several-pages-of-one-site" }],
  chief: [{ kind: "personal", id: "google" }, { kind: "personal", id: "microsoft" }],
  bug: [{ kind: "cli", id: "git" }, { kind: "cli", id: "gh" }],
  trip: [{ kind: "skill", id: "search-and-summarise" }, { kind: "skill", id: "watch-a-page-for-a-change" }, { kind: "skill", id: "fill-a-form-from-a-document" }],
};

export interface SetupKind { id: string; tools: number; off: number; asks: number; refused: number; names: string[] }

/** The policy a new conversation in the window is held to, as src/runtime.ts `conversationPolicy` builds it. */
function newConversationPolicy(registry: ToolRegistry, store: Store, owner: string): { policy: Policy; mode: string } {
  const saved = readPolicy(store, owner);
  const mode = conversationModeSettings(store, owner).newConversation;
  if (mode === "follow") return { policy: saved, mode };
  return { policy: policyForMode(saved, mode, lockdownActive(store, owner), registry.outboundTools()), mode };
}

/** Each kind with its built-in tools counted: how many, how many are off, and how many ask first or are refused. */
export function setupKindsView(registry: ToolRegistry, store: Store, owner: string): { mode: string; kinds: SetupKind[] } {
  const { policy, mode } = newConversationPolicy(registry, store, owner);
  const tools = registry.inventory().filter((tool) => !lent(tool.name));
  const hidden = new Set(switchedToolTiers(store, owner, tools.map((tool) => tool.name)).hidden);
  const kinds = setupKinds.map(({ id, boxes }) => {
    const mine = tools.filter((tool) => (boxes as readonly string[]).includes(registry.groupOf(tool.name)));
    const on = mine.filter((tool) => !hidden.has(tool.name));
    const decided = on.map((tool) => evaluatePolicy(policy, {
      tool: tool.name, target: "", readOnly: isReadOnlyPermission(tool.permission),
      resource: isCommandTool(tool.name) ? { kind: "command", value: "" } : null,
    }).decision);
    return { id, tools: mine.length, off: mine.length - on.length, asks: decided.filter((d) => d === "ask").length,
      refused: decided.filter((d) => d === "deny").length, names: mine.map((tool) => tool.name).sort() };
  });
  return { mode, kinds };
}

export function setupToolsView(registry: ToolRegistry, store: Store, owner: string) {
  return { ...setupKindsView(registry, store, owner), starters: starterNeeds };
}
