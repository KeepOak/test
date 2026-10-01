import { posix, win32 } from "node:path";
import type { SourceTree } from "./source-tree.js";
import type { MoveInSource } from "./types.js";

/**
 * Where each assistant keeps its things, worked out from the platform, the environment and the
 * home folder alone — nothing here looks at the disk, so every platform's answer can be checked on
 * any computer. Each assistant's own override variable wins, exactly as the assistant itself reads it.
 */
export interface Place {
  source: MoveInSource;
  /** The assistant's own folder. */
  root: string;
  /** Other places it reads: a single file (`only` names it) or a second folder. */
  extras: { name: ExtraName; folder: string; only?: string[] }[];
}
export type ExtraName = "claude-json" | "agents-skills" | "config";
export interface PlaceInput { platform: NodeJS.Platform; env: Record<string, string | undefined>; home: string }

const given = (value: string | undefined): string | undefined => (value && value.trim() ? value.trim() : undefined);

export function placesFor({ platform, env, home }: PlaceInput): Place[] {
  const path = platform === "win32" ? win32 : posix;
  const at = (...parts: string[]) => path.join(home, ...parts);
  const agentsSkills = { name: "agents-skills" as const, folder: at(".agents", "skills") };
  const hermes = given(env.HERMES_HOME)
    ?? (platform === "win32" && given(env.LOCALAPPDATA) ? path.join(env.LOCALAPPDATA!.trim(), "hermes") : at(".hermes"));
  const dataHome = given(env.XDG_DATA_HOME) ?? at(".local", "share");
  const configHome = given(env.XDG_CONFIG_HOME) ?? at(".config");
  return [
    { source: "claude-code", root: given(env.CLAUDE_CONFIG_DIR) ?? at(".claude"),
      extras: [{ name: "claude-json", folder: home, only: [".claude.json"] }] },
    { source: "codex", root: given(env.CODEX_HOME) ?? at(".codex"), extras: [agentsSkills] },
    { source: "hermes", root: hermes, extras: [] },
    { source: "openclaw", root: given(env.OPENCLAW_STATE_DIR) ?? at(".openclaw"), extras: [] },
    { source: "opencode", root: path.join(dataHome, "opencode"),
      extras: [{ name: "config", folder: path.join(configHome, "opencode") }] },
  ];
}

const has = async (tree: SourceTree, name: string, kind?: "file" | "dir"): Promise<boolean> => {
  const slash = name.lastIndexOf("/");
  const entries = await tree.list(slash < 0 ? "" : name.slice(0, slash));
  const leaf = slash < 0 ? name : name.slice(slash + 1);
  return entries.some((entry) => entry.name === leaf && (!kind || entry.kind === kind));
};

/**
 * Which assistant a folder or archive came from, judged by what is inside it rather than what it is
 * called — a zip of `~/.claude` has usually lost the name. Null when it is none of them.
 */
export async function recognise(tree: SourceTree): Promise<MoveInSource | null> {
  if (await has(tree, "conversations.json", "file")) return "chatgpt";
  if (await has(tree, "openclaw.json") || await has(tree, "clawdbot.json")
    || (await has(tree, "agents", "dir") && await has(tree, "workspace", "dir"))) return "openclaw";
  if (await has(tree, "opencode.db") || await has(tree, "storage/session", "dir")) return "opencode";
  if (await has(tree, "config.toml") || await has(tree, "session_index.jsonl")
    || (await has(tree, "sessions", "dir") && (await has(tree, "history.jsonl") || await has(tree, "memories", "dir"))))
    return "codex";
  // Codex keeps a `memories` folder too, so only files Hermes alone writes decide it is Hermes.
  if (await has(tree, "config.yaml") || await has(tree, "state.db") || await has(tree, "SOUL.md")) return "hermes";
  if (await has(tree, "projects", "dir") || await has(tree, "settings.json") || await has(tree, "CLAUDE.md"))
    return "claude-code";
  return null;
}
