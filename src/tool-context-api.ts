/**
 * GET/POST /api/tools/context: each source of tools (a connected MCP server, a plugin, a skill), whether it travels
 * with every request ("always") or waits in the short index until a task needs it ("when-needed", the default), and
 * what it costs a request in tokens either way, estimated the way the engine estimates the requests it sends
 * (src/contracts.ts estimateTokens). Changing a mode reaches a running task from its next round and every new task,
 * with no restart. Only the owner at the window sees or changes these (src/server.ts).
 */
import { estimateTokens } from "./contracts.js";
import type { ToolRegistry } from "./registry.js";
import type { Store } from "./store.js";
import { ToolIndex, indexLine } from "./tool-index.js";
import { sourceIndex } from "./tool-loading.js";
import { skillIndex } from "./skill-tools.js";
import { modeOfSource, readContextModes, saveContextMode, type ContextMode } from "./tool-context-modes.js";

export interface ContextSource {
  source: string;
  kind: "mcp" | "plugin" | "skill";
  /** The server's id, the plugin's id or the skill's name. */
  name: string;
  tools: number;
  mode: ContextMode;
  /** Tokens it adds to a request in each mode, and in the one it is in. */
  tokens: { always: number; whenNeeded: number; now: number };
}

interface Deps { store: Store; registry: ToolRegistry; owner: string }

function toolSources(deps: Deps, modes: Readonly<Record<string, ContextMode>>): ContextSource[] {
  const registry = deps.registry;
  const tools = registry.descriptions(new Set(registry.permissions()));
  const index = new ToolIndex(tools, { groupOf: (name) => registry.groupOf(name), external: (name) => registry.isExternal(name) });
  const bySource = new Map<string, typeof tools>();
  for (const tool of tools) {
    const source = registry.sourceOf(tool.name);
    if (source) bySource.set(source, [...(bySource.get(source) ?? []), tool]);
  }
  // A source's share of the short index is worked out over every source waiting, as a request lays it out.
  const waiting = [...bySource.keys()].filter((source) => modeOfSource(modes, source) === "when-needed");
  const entriesOf = (source: string) => (bySource.get(source) ?? []).map((tool) => index.entry(tool.name)!).filter(Boolean);
  const lines = sourceIndex(waiting.flatMap(entriesOf), new Set(), [], (name) => registry.sourceOf(name));
  return [...bySource].map(([source, list]) => {
    const own = lines.filter((line) => line.startsWith(`${source} (`) || list.some((tool) => line.startsWith(`${tool.name} — `)));
    const whenNeeded = estimateTokens(own.length ? own.join("\n") : entriesOf(source).map(indexLine).join("\n"));
    const always = estimateTokens(list.map((tool) => ({ ...tool, description: index.entry(tool.name)?.description ?? "" })));
    const mode = modeOfSource(modes, source);
    const kind = source.startsWith("mcp:") ? "mcp" as const : "plugin" as const;
    return { source, kind, name: source.slice(source.indexOf(":") + 1), tools: list.length, mode,
      tokens: { always, whenNeeded, now: mode === "always" ? always : whenNeeded } };
  });
}

function skillSources(deps: Deps, modes: Readonly<Record<string, ContextMode>>): ContextSource[] {
  const skills = deps.store.skills.catalog(deps.owner);
  const waiting = skills.filter((skill) => modeOfSource(modes, `skill:${skill.id}`) === "when-needed");
  // The names-only form applies to every waiting skill at once, so each one's share is the whole line over their count.
  const share = waiting.length ? Math.ceil(estimateTokens(skillIndex(waiting)) / waiting.length) : 0;
  return skills.map((skill) => {
    const source = `skill:${skill.id}`, mode = modeOfSource(modes, source);
    const always = estimateTokens(JSON.stringify(skill));
    const whenNeeded = mode === "when-needed" ? share : estimateTokens(skillIndex([skill]));
    return { source, kind: "skill" as const, name: skill.name, tools: 0, mode,
      tokens: { always, whenNeeded, now: mode === "always" ? always : whenNeeded } };
  });
}

export function contextSources(deps: Deps): { sources: ContextSource[] } {
  const modes = readContextModes(deps.store, deps.owner);
  return { sources: [...toolSources(deps, modes), ...skillSources(deps, modes)] };
}
export function changeContextMode(deps: Deps, input: unknown): { sources: ContextSource[] } {
  saveContextMode(deps.store, deps.owner, input);
  return contextSources(deps);
}
