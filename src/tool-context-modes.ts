import { z } from "zod";
import type { Store } from "./store.js";

/**
 * What the owner chose for each source of tools: a connected MCP server (`mcp:<id>`), a plugin (`plugin:<id>`) or a
 * skill (`skill:<id>`). "always" sends that source's tools (or the skill's whole description) with every request, the
 * way the core tools travel. "when-needed", the default, puts only a short line about it in the request; the model
 * loads what it needs by calling `tools.search` or `tools.describe` (for a skill, `skills.list` then `skills.read`),
 * and what it loads stays for the rest of the task. The product's own tools have no source and always travel as before.
 *
 * Nothing here widens what a task may do: a mode only decides how much of an already-permitted tool's description is
 * sent. Every call still goes through the same permission and approval checks.
 */
export type ContextMode = "always" | "when-needed";
export const contextModesSetting = "tool-context-modes";
export const defaultContextMode: ContextMode = "when-needed";
/** Enough for every server, plugin and skill Branch can hold, without letting the saved list grow without end. */
const maxSaved = 400;
export const sourcePattern = /^(mcp|plugin|skill):[A-Za-z0-9._-]{1,80}$/;
export const ContextModeChangeSchema = z.object({
  source: z.string().regex(sourcePattern),
  mode: z.enum(["always", "when-needed"]),
}).strict();

const Saved = z.object({ modes: z.record(z.string().regex(sourcePattern), z.enum(["always", "when-needed"])).default({}) }).strict();

/** The owner's saved choices. Only "always" is ever kept; anything missing is "when-needed". */
export function readContextModes(store: Pick<Store, "get">, owner: string): Record<string, ContextMode> {
  const parsed = Saved.safeParse(store.get("settings", owner, contextModesSetting)?.data ?? {});
  return parsed.success ? parsed.data.modes : {};
}
export function saveContextMode(store: Pick<Store, "get" | "save">, owner: string, input: unknown): Record<string, ContextMode> {
  const { source, mode } = ContextModeChangeSchema.parse(input);
  const modes = { ...readContextModes(store, owner) };
  if (mode === defaultContextMode) delete modes[source];
  else modes[source] = mode;
  if (Object.keys(modes).length > maxSaved) throw new Error(`Branch keeps at most ${maxSaved} of these choices.`);
  store.save("settings", owner, contextModesSetting, { modes });
  return modes;
}
export const modeOfSource = (modes: Readonly<Record<string, ContextMode>>, source: string): ContextMode =>
  modes[source] ?? defaultContextMode;

/** Where a tool came from: what it says itself, else a connected server's tools by their `mcp.<id>.` names. */
export function sourceOfTool(name: string, declared?: string): string | undefined {
  if (declared) return declared;
  const server = /^mcp\.([^.]+)\./.exec(name);
  return server ? `mcp:${server[1]}` : undefined;
}
