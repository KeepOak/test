import { z } from "zod";
import type { Store } from "../store.js";
import { unsetRecord } from "../ship-on.js";
import { audit } from "../audit.js";

/**
 * mac7/r17-g: the safety extras (re-audit rows R17-061 … R17-067). Each part has the owner's
 * three-way switch — off, when needed, on — kept in a settings record of its own. What each ships as is
 * `safetyShipsOn` below (the owner's ship-on rule, src/ship-on.ts); a saved record that cannot be read is off.
 *
 *   off          the part does nothing at all; its tools are not in the catalog
 *   when-needed  the part works where the work calls for it (each part says what that means)
 *   on           the part works everywhere, and its tools are loaded from the first round
 *
 * The emergency stop has no switch: it is a button, and until it is pressed it stops nothing.
 * The schema is written out here rather than imported from feature-switches.ts, because that file
 * reads these records to decide what to preload, and the two must not import each other.
 */
export const safetyParts = [
  "tool-scripts", "wasm-add-ons", "code-approvals", "command-scan", "progress-judge", "activity-chain", "history-repair",
] as const;
export type SafetyPart = (typeof safetyParts)[number];
export const SafetyPartSchema = z.enum(safetyParts);
const ModeSchema = z.enum(["off", "when-needed", "on"]);
export type SafetyMode = z.infer<typeof ModeSchema>;
const RecordSchema = z.object({ mode: ModeSchema.default("off") }).strict();

export const safetyKey = (part: SafetyPart): string => `safety-${part}`;

/** What each part is while the owner never set it. */
export const safetyShipsOn: Partial<Record<SafetyPart, SafetyMode>> = {
  // The owner's rule (ships on, 2026-09-26): the scan can only make an answer stricter, and "when needed" reads only
  // commands that would run without asking; none of (a)–(f).
  "command-scan": "when-needed",
  // The owner's rule (ships on, 2026-09-26): a tamper-evident chain over what the assistant was allowed, refused and
  // asked, kept on this computer; none of (a)–(f).
  "activity-chain": "when-needed",
  // The owner's rule (ships on, 2026-09-26): every call a script makes goes through the one gate with the task's own
  // permissions, and a call that would be asked about is left to the task; none of (a)–(f).
  "tool-scripts": "when-needed",
  // The owner's rule (ships on, 2026-09-26): runs only add-ons the owner installed, in a sealed worker with caps; none of (a)–(f).
  "wasm-add-ons": "when-needed",
  // The owner's rule (ships on, 2026-09-26): holds nothing until the owner enrols an authenticator and picks the yeses; none of (a)–(f).
  "code-approvals": "when-needed",
  // Defaults audit (2026-09-28): history repair tidies only the copy sent, and repairs only broken pairs; a call id reused
  // in a later answer (as local models do) is its own call now (src/safety-extras/history-repair.ts). None of (a)–(f).
  "history-repair": "when-needed",
  // Kept off, by the owner's rule: progress-judge asks the model on its own every few rounds (a).
};

/** What each part is, in the owner's words, for the card and for a refusal. */
export const safetyLabels: Record<SafetyPart, string> = {
  "tool-scripts": "Scripts that call several tools at once",
  "wasm-add-ons": "Add-ons that run in a sealed WebAssembly box",
  "code-approvals": "A code from your authenticator app for chosen yeses",
  "command-scan": "Checking commands for look-alike letters, piped downloads, hidden terminal codes and dangerous commands",
  "progress-judge": "Asking whether a long task is getting anywhere",
  "activity-chain": "A tamper-evident chain over the record of what happened",
  "history-repair": "Tidying a conversation's history before it is sent",
};

/** The tools each part owns, so the catalog can leave them out while the part is off. */
export const safetyTools: Record<SafetyPart, readonly string[]> = {
  "tool-scripts": ["tools.script"],
  "wasm-add-ons": ["wasm.run"],
  "code-approvals": [],
  "command-scan": [],
  "progress-judge": [],
  "activity-chain": [],
  "history-repair": [],
};

/** For src/feature-switches.ts: each part with tools — its settings record, why it is loaded, and its tools. */
export const safetyToolFeatures: readonly (readonly [string, string, readonly string[], SafetyMode])[] = safetyParts
  .filter((part) => safetyTools[part].length > 0)
  .map((part) => [safetyKey(part), `${safetyLabels[part].charAt(0).toLowerCase()}${safetyLabels[part].slice(1)} is switched on`, safetyTools[part], safetyShipsOn[part] ?? "off"] as const);

type Reader = Pick<Store, "get">;

export function safetyMode(store: Reader, owner: string, part: SafetyPart): SafetyMode {
  const found = store.get("settings", owner, safetyKey(part));
  if (unsetRecord(found?.data)) return safetyShipsOn[part] ?? "off";
  const saved = RecordSchema.safeParse(found?.data ?? {});
  return saved.success ? saved.data.mode : "off";
}

export function allSafetyModes(store: Reader, owner: string): Record<SafetyPart, SafetyMode> {
  return Object.fromEntries(safetyParts.map((part) => [part, safetyMode(store, owner, part)])) as Record<SafetyPart, SafetyMode>;
}

export function saveSafetyMode(store: Store, owner: string, part: SafetyPart, input: unknown): SafetyMode {
  const { mode } = RecordSchema.parse(input);
  store.save("settings", owner, safetyKey(part), { mode });
  return mode;
}

/**
 * Integration review: the settings kit (src/settings-kit/catalogue.ts) saves a switch through the
 * app's own SafetyExtras, so a part's tools come and go with it and the change is written in the
 * record. Without a running app (a file read before start), the record is saved and noted directly.
 */
const liveSwitches = new WeakMap<object, (part: SafetyPart, mode: SafetyMode) => void>();
export function followSafetySwitches(store: object, apply: (part: SafetyPart, mode: SafetyMode) => void): () => void {
  liveSwitches.set(store, apply);
  return () => { if (liveSwitches.get(store) === apply) liveSwitches.delete(store); };
}
export function saveSafetySwitch(store: Store, owner: string, part: SafetyPart, input: unknown): void {
  const { mode } = RecordSchema.parse({ mode: (input as { mode?: unknown } | null)?.mode ?? safetyMode(store, owner, part) });
  const live = liveSwitches.get(store);
  if (live) { live(part, mode); return; }
  saveSafetyMode(store, owner, part, { mode });
  audit(store, owner, { action: "policy.changed", actor: owner, subject: `${safetyLabels[part]}: ${mode}`,
    reason: "Changed from Settings: presets, reset or a settings file", outcome: "saved" });
}

export class SafetyOffError extends Error {
  constructor(part: SafetyPart) {
    super(`${safetyLabels[part]} is switched off. The owner can turn it on in Settings, Permissions.`);
  }
}

/** Throws the part's plain refusal while it is off. */
export function requireSafety(store: Reader, owner: string, part: SafetyPart): SafetyMode {
  const mode = safetyMode(store, owner, part);
  if (mode === "off") throw new SafetyOffError(part);
  return mode;
}
