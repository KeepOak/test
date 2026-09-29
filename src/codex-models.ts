import { z } from "zod";
import type { Store } from "./store.js";

/**
 * QA 2026-09-28: which model Codex answers with, chosen in Branch and never read from the owner's own Codex settings.
 *
 * The candidates are the models Codex may take with a ChatGPT sign-in, most capable first. GPT-5.6 Sol is the light one
 * (chatgpt-provider.ts), so Terra comes before it; Luna's place between them is an assumption, not a measurement. The
 * GPT-5.x ones were checked to answer through Codex with a ChatGPT account on 2026-09-17. The GPT-6 ones are not
 * trusted until Codex itself takes them: GPT-6 Sol was refused on 2026-09-28 although the account's model list named
 * it. So a model list is never proof; what counts is a call Codex answered (accepted) or refused in its own words
 * (refused). Codex's own folder is never read for this.
 *
 * The check spends one tiny request per model Codex accepts; a refusal costs nothing. It runs for the models not yet
 * trusted whenever Codex's version changes (a new Codex may take them), and for every candidate when the owner presses
 * Check. Only a clear answer or a clear refusal is kept: a sign-in, trust or limit failure leaves the version unchecked,
 * so it is tried again later rather than marking a model refused.
 */
export const codexCandidates = ["gpt-6-sol", "gpt-6-luna", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.5"] as const;
export const codexVerified: readonly string[] = ["gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.5"];
export const codexDefaultModel: string = codexVerified[0]!;
const unverified = codexCandidates.filter((model) => !codexVerified.includes(model));

const model = z.enum(codexCandidates);
const SettingsSchema = z.object({
  /** The owner's pick; null is the most capable model Codex takes. */
  chosen: model.nullable().default(null),
  /** The Codex version the last check ran against, and what it found. */
  version: z.string().max(200).nullable().default(null),
  accepted: z.array(model).default([]),
  refused: z.array(model).default([]),
  checkedAt: z.string().max(40).nullable().default(null),
}).strict();
export type CodexModelSettings = z.infer<typeof SettingsSchema>;
const key = "codex-models";

export function codexModelSettings(store: Pick<Store, "get">, owner: string): CodexModelSettings {
  const saved = SettingsSchema.safeParse(store.get("settings", owner, key)?.data ?? {});
  return saved.success ? saved.data : SettingsSchema.parse({});
}
function save(store: Store, owner: string, value: CodexModelSettings): CodexModelSettings {
  const parsed = SettingsSchema.parse(value);
  store.save("settings", owner, key, parsed);
  return parsed;
}
/** The models Codex takes, most capable first: every one it answered, and each checked one it has not refused. */
export function codexOffered(settings: CodexModelSettings): string[] {
  return codexCandidates.filter((one) => settings.accepted.includes(one) || (codexVerified.includes(one) && !settings.refused.includes(one)));
}
/** The model a call names: the owner's pick, else the most capable one Codex takes. */
export function codexChosen(settings: CodexModelSettings): string {
  return settings.chosen ?? codexOffered(settings)[0] ?? codexDefaultModel;
}

export type CodexTry = "accepted" | "refused" | "unknown";
/** What the check needs from the program: its version, and one tiny call on a model. */
export interface CodexProbe { version(): Promise<string | null>; tryModel(model: string): Promise<CodexTry> }

export class CodexModels {
  private running: Promise<CodexModelSettings | null> | null = null;
  constructor(private readonly store: Store, private readonly owner: string) {}
  settings(): CodexModelSettings { return codexModelSettings(this.store, this.owner); }
  offered(): string[] { return codexOffered(this.settings()); }
  chosen(): string { return codexChosen(this.settings()); }
  /** The owner's pick (null goes back to the most capable), refused unless Codex takes it. */
  choose(input: unknown): CodexModelSettings {
    const { chosen } = z.object({ chosen: model.nullable() }).strict().parse(input);
    const current = this.settings();
    if (chosen && !codexOffered(current).includes(chosen))
      throw new Error(`Codex does not take ${chosen} with this sign-in. Choose one it takes: ${codexOffered(current).join(", ")}.`);
    return save(this.store, this.owner, { ...current, chosen });
  }
  /** On a new Codex version, the models not yet trusted are checked in the background. Never waited for. */
  refreshIfUpdated(probe: CodexProbe): void {
    if (this.running) return;
    void this.check(probe, "new").catch(() => null);
  }
  /** Checks the candidates now (all of them, or only the untrusted ones on a new version); null when nothing was kept. */
  check(probe: CodexProbe, which: "all" | "new"): Promise<CodexModelSettings | null> {
    this.running ??= this.run(probe, which).finally(() => { this.running = null; });
    return this.running;
  }
  private async run(probe: CodexProbe, which: "all" | "new"): Promise<CodexModelSettings | null> {
    const version = await probe.version();
    if (!version) return null;
    const current = this.settings();
    if (which === "new" && current.version === version) return null;
    const accepted = new Set(which === "all" ? [] : current.accepted.filter((one) => codexVerified.includes(one)));
    const refused = new Set(which === "all" ? [] : current.refused.filter((one) => codexVerified.includes(one)));
    for (const one of which === "all" ? codexCandidates : unverified) {
      const said = await probe.tryModel(one);
      if (said === "unknown") return null; // a sign-in, trust or limit failure proves nothing: checked again later
      (said === "accepted" ? accepted : refused).add(one);
    }
    const next = { ...this.settings(), version, accepted: [...accepted], refused: [...refused], checkedAt: new Date().toISOString() };
    if (next.chosen && !codexOffered(next).includes(next.chosen)) next.chosen = null; // a pick Codex now refuses goes back to the best
    return save(this.store, this.owner, next);
  }
}

/** One per model router, so each Codex connection (and each of its accounts) reads the same choice at call time. */
const attached = new WeakMap<object, CodexModels>();
export function attachCodexModels(models: object, codex: CodexModels): void { attached.set(models, codex); }
export function codexModelsFor(models: object): CodexModels | null { return attached.get(models) ?? null; }
