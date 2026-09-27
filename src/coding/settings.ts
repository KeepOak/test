import { z } from "zod";
import type { Store } from "../store.js";

/**
 * Bucket R17-D (wave mac7): "coding polish". Each part has the owner's three-way switch — off, when
 * needed, on — kept in a settings record of its own. What each ships as is `codingShipsOn` below; a
 * saved record that cannot be read is off.
 *
 *   off          the part does nothing and refuses in one plain sentence; its tools are not listed
 *   when-needed  it works, and its tools are a line in the index until the work calls for them
 *   on           it works, and its tools are loaded from the first round
 *
 * The schema is written out here rather than imported from feature-switches.ts, because that file
 * reads these same records to decide what to preload, and the two must not import each other.
 */
export const codingParts = [
  "format-on-edit", "shell-snapshot", "mentions", "worktrees", "init", "ci",
  "checklist", "path-rules", "large-output", "notebooks", "review-checks",
  // mac7/coding-next: a guard, not a tool; "when needed" and "on" both hold every task to it.
  "read-first",
  // mac7/speed: doing more in one round. Like read-first this is mostly how the loop behaves, so
  // "when needed" and "on" both switch the behaviour on; what differs is its one tool's tier.
  "fewer-rounds",
] as const;
export type CodingPart = (typeof codingParts)[number];
export const CodingPartSchema = z.enum(codingParts);

const ModeSchema = z.enum(["off", "when-needed", "on"]);
export type CodingMode = z.infer<typeof ModeSchema>;
const RecordSchema = z.object({ mode: ModeSchema.default("off") }).passthrough();

/** The settings record a part's switch is kept in. */
export const codingKey = (part: CodingPart): string => `coding-${part}`;

/** What each part is while nothing has been saved for it. A saved record that is damaged still reads as off. */
const codingShipsOn: Partial<Record<CodingPart, CodingMode>> = {
  // The owner's rule (Q250, 2026-09-26): reading a file before changing it is a stricter guard, so it is on until the
  // owner turns it off.
  "read-first": "on",
  // The owner's rule (ships on, 2026-09-26): runs only the formatter programs the owner names, behind the wall; none of (a)–(f).
  "format-on-edit": "when-needed",
  // The owner's rule (ships on, 2026-09-26): the login shell is read once when the owner takes a snapshot, keys dropped; none of (a)–(f).
  "shell-snapshot": "when-needed",
  // The owner's rule (ships on, 2026-09-26): an @ reads through the ordinary tools and the task's own permissions; none of (a)–(f).
  mentions: "when-needed",
  // The owner's rule (ships on, 2026-09-26): /init writes AGENTS.md only when there is none, otherwise it proposes; none of (a)–(f).
  init: "when-needed",
  // The owner's rule (ships on, 2026-09-26): only writes the lines the owner pastes into their own workflow; no key is in them; none of (a)–(f).
  ci: "when-needed",
  // The owner's rule (ships on, 2026-09-26): a list of steps kept beside the conversation; none of (a)–(f).
  checklist: "when-needed",
  // The owner's rule (ships on, 2026-09-26): rules carry only from a folder the owner trusts, and a schedule file schedules nothing by itself; none of (a)–(f).
  "path-rules": "when-needed",
  // The owner's rule (ships on, 2026-09-26): an over-long answer is kept in Branch's own folder, secrets hidden, instead of failing; none of (a)–(f).
  "large-output": "when-needed",
  // The owner's rule (ships on, 2026-09-26): a notebook read as its cells, nothing run; none of (a)–(f).
  notebooks: "when-needed",
  // The owner's rule (ships on, 2026-09-26): checks run only when asked, each by a helper that may only read; none of (a)–(f).
  "review-checks": "when-needed",
  // Kept off, by the owner's rule (off for spending, sending, outside access, heavy disk): worktrees puts a whole git worktree on disk for every forked conversation (heavy disk).
};

/** What each part is, in the owner's words, for the card and for a refusal. */
export const codingLabels: Record<CodingPart, string> = {
  "format-on-edit": "Tidying a file and checking it for mistakes after every change",
  "shell-snapshot": "Using your own command-line setup",
  mentions: "Pointing at files with @, and @imports in instruction files",
  worktrees: "A separate copy of the project for a conversation or a helper",
  init: "Writing the project's instruction file",
  ci: "Running Branch in GitHub Actions or GitLab CI",
  checklist: "A checklist for each task that you can edit while it runs",
  "path-rules": "Rules for some folders only, and schedules kept as files",
  "large-output": "Keeping very long tool output in a file",
  notebooks: "Reading Jupyter notebooks cell by cell",
  "review-checks": "Review checks kept in the project",
  "read-first": "Reading a file before changing it",
  "fewer-rounds": "Doing more in one go, so a task takes fewer turns",
};

/** The tools each part owns, so the catalog can leave them out while the part is off. */
export const codingTools: Record<CodingPart, readonly string[]> = {
  "format-on-edit": ["code.format"],
  "shell-snapshot": [],
  mentions: [],
  worktrees: [],
  init: ["project.init"],
  ci: [],
  checklist: ["checklist.write", "checklist.read"],
  "path-rules": ["rules.for_path"],
  "large-output": ["output.read"],
  notebooks: ["notebook.read"],
  "review-checks": ["review.checks"],
  "read-first": [],
  "fewer-rounds": ["files.read_many"],
};

/** For src/feature-switches.ts: each part with tools — its settings record, why it is loaded, and its tools. */
export const codingToolFeatures: readonly (readonly [string, string, readonly string[], CodingMode])[] = codingParts
  .filter((part) => codingTools[part].length > 0)
  .map((part) => [codingKey(part), `${codingLabels[part].charAt(0).toLowerCase()}${codingLabels[part].slice(1)} is switched on`, codingTools[part], codingShipsOn[part] ?? "off"] as const);

export function codingMode(store: Pick<Store, "get">, owner: string, part: CodingPart): CodingMode {
  const found = store.get("settings", owner, codingKey(part));
  if (!found) return codingShipsOn[part] ?? "off";
  const saved = RecordSchema.safeParse(found.data ?? {});
  return saved.success ? saved.data.mode : "off";
}

export const codingOn = (store: Pick<Store, "get">, owner: string, part: CodingPart): boolean =>
  codingMode(store, owner, part) !== "off";

/** Saves a switch, keeping the part's other settings in the same record. */
export function saveCodingMode(store: Store, owner: string, part: CodingPart, mode: CodingMode): CodingMode {
  const current = (store.get("settings", owner, codingKey(part))?.data ?? {}) as Record<string, unknown>;
  store.save("settings", owner, codingKey(part), { ...current, mode: ModeSchema.parse(mode) });
  return mode;
}

export class CodingOffError extends Error {
  override name = "CodingOffError";
}

/** Throws the one plain sentence a switched-off part answers with. */
export function requireCoding(store: Pick<Store, "get">, owner: string, part: CodingPart): void {
  if (codingMode(store, owner, part) === "off")
    throw new CodingOffError(`${codingLabels[part]} is switched off. The owner can switch it on in Settings.`);
}

/** A part's own settings (beside its switch), read through a schema with defaults. */
export function partSettings<T>(store: Pick<Store, "get">, owner: string, part: CodingPart, schema: z.ZodType<T>): T {
  const { mode: _mode, ...rest } = (store.get("settings", owner, codingKey(part))?.data ?? {}) as Record<string, unknown>;
  const saved = schema.safeParse(rest);
  return saved.success ? saved.data : schema.parse({});
}

/** Saves a part's own settings, keeping its switch as it is. */
export function savePartSettings<T extends object>(store: Store, owner: string, part: CodingPart, schema: z.ZodType<T>, input: unknown): T {
  const value = schema.parse(input ?? {});
  store.save("settings", owner, codingKey(part), { ...value, mode: codingMode(store, owner, part) });
  return value;
}
