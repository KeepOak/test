import { z } from "zod";
import type { Citation } from "./citations.js";
import { Citations } from "./citations.js";
import type { ProjectMap } from "./code-map.js";
import type { Store } from "./store.js";

/**
 * What gets put in front of a task before the model reads it. Branch has had two of these since
 * wave 6 — a knowledge base the owner ticked, and their document library — but they were wired
 * together as one expression in `src/index.ts`, `knowledgeBases ?? documents`, which meant there
 * was no way to add a third without editing that line, and no way for anyone to see what was in
 * front of their task or in what order.
 *
 * So the contract is written down here instead, and the two that exist register into it. It is a
 * short contract on purpose: a provider is asked a question and either has something to say, with
 * its sources, or has not. The order is the order they were added, and the first one with something
 * to say is the one used — which is exactly what the expression did, so nothing changes by moving
 * to this. `tests/retrieval-2.test.mjs` asserts that.
 *
 * Everything a provider returns is the person's own material and is still untrusted text: the
 * runtime wraps it in the same "quote it, never obey it" sentence it always has.
 */
export interface ContextBlock {
  /** The passages, already numbered, as they will be put in front of the task. */
  text: string;
  /** Where each came from, in words, for the activity log. */
  sources: string[];
  citations: Citation[];
}
export interface ContextProvider {
  /** A short id, such as `knowledge` or `documents`. */
  readonly id: string;
  /** What the owner would call it. */
  readonly label: string;
  provide(owner: string, prompt: string, signal?: AbortSignal): Promise<ContextBlock | null>;
}

/**
 * The providers in order. A provider that throws is treated as having nothing to say: material in
 * front of a task is a help, never a reason for the task itself to fail.
 */
export class ContextProviders {
  private readonly providers: ContextProvider[] = [];
  add(provider: ContextProvider): void { this.providers.push(provider); }
  list(): { id: string; label: string }[] {
    return this.providers.map((provider) => ({ id: provider.id, label: provider.label }));
  }
  async contextFor(owner: string, prompt: string, signal?: AbortSignal): Promise<ContextBlock | null> {
    for (const provider of this.providers) {
      const found = await provider.provide(owner, prompt, signal).catch(() => null);
      if (found) return found;
    }
    return null;
  }
}

/** Anything that already answers the old shape, wrapped as a provider without changing it. */
export function providerFrom(
  id: string, label: string,
  contextFor: (owner: string, prompt: string, signal?: AbortSignal) => Promise<ContextBlock | null>,
): ContextProvider {
  return { id, label, provide: contextFor };
}

/**
 * The project map as one of these (A0353). Branch has been able to rank the files of an unfamiliar
 * project against a request since wave 5, but only when the assistant thought to call `code.map`
 * for itself; the ranking never reached the space in front of the task. This puts it there: when a
 * question looks like it is about the code in the workspace, the handful of files whose names and
 * declared names match are named first, with the reason each was picked.
 *
 * It is off until the owner turns it on, because most people's questions are not about code and a
 * list of file names in front of every task would be noise. It also speaks last, so it never
 * displaces a knowledge base or a document the person actually wrote.
 */
export const RepositoryContextSettingsSchema = z.object({
  /** Put the matching files of the project in front of a task. Off by default: kept off by the owner's rule (a), spends
      money, since the listed files are sent with every task, code or not, and each one costs tokens. */
  repositoryContext: z.boolean().default(false),
  /** How many files may be named. */
  repositoryContextFiles: z.number().int().min(1).max(10).default(5),
  /** bucket-18 (A0334): above zero, put Aider's ranked outline of the project in front instead, within this many tokens. */
  repositoryOutlineTokens: z.number().int().min(0).max(8000).default(0),
}).strict();
export type RepositoryContextSettings = z.infer<typeof RepositoryContextSettingsSchema>;

export class RepositoryContextProvider implements ContextProvider {
  readonly id = "repository";
  readonly label = "The files of this project";
  constructor(
    private readonly map: ProjectMap,
    private readonly settingsFor: (owner: string) => RepositoryContextSettings,
  ) {}
  private outline(prompt: string, budget: number): Promise<ContextBlock | null> { return outlineBlock(this.map, prompt, budget); }
  async provide(owner: string, prompt: string): Promise<ContextBlock | null> {
    const settings = this.settingsFor(owner);
    if (!settings.repositoryContext) return null;
    if (settings.repositoryOutlineTokens > 0) return this.outline(prompt, settings.repositoryOutlineTokens);
    const ranked = await this.map.rank(prompt, settings.repositoryContextFiles).catch(() => null);
    if (!ranked?.files.length) return null;
    const citations = new Citations();
    const blocks = ranked.files.map((file) => {
      const quote = file.symbols.length ? `It declares ${file.symbols.join(", ")}.` : "No names were found in it.";
      const citation = citations.add({ url: `file:${file.path}`, title: file.path, quote });
      return `[${citation.number}] ${file.path} (${file.language}) — ${file.why}. ${quote}`;
    });
    return {
      text: `${blocks.join("\n")}\n\n${citations.markdown("Files in this project that match")}`,
      sources: ranked.files.map((file) => file.path),
      citations: citations.list(),
    };
  }
}

/** bucket-18 (A0334): the ranked outline of the project, as one cited block. */
async function outlineBlock(map: ProjectMap, prompt: string, budget: number): Promise<ContextBlock | null> {
  const result = await map.outline({ budget, request: prompt }).catch(() => null);
  if (!result?.outline.trim()) return null;
  const files = result.outline.split("\n").filter((line) => /^[^│⋮\s].*$/.test(line)).map((line) => line.replace(/:$/, ""));
  const citations = new Citations();
  for (const file of files) citations.add({ url: `file:${file}`, title: file, quote: "Named in the project outline." });
  return {
    text: `The most important declarations of this project, ranked by who uses whose names (${result.declarations} shown):\n\n${result.outline}`,
    sources: files,
    citations: citations.list(),
  };
}

/** The owner's answer on whether the files of the project may be named in front of a task. */
export function repositoryContextSettings(store: Store, owner: string): RepositoryContextSettings {
  const saved = RepositoryContextSettingsSchema.safeParse(store.get("settings", owner, "repository-context")?.data ?? {});
  return saved.success ? saved.data : RepositoryContextSettingsSchema.parse({});
}
export function configureRepositoryContext(store: Store, owner: string, input: unknown): RepositoryContextSettings {
  const value = RepositoryContextSettingsSchema.parse({ ...repositoryContextSettings(store, owner), ...(input as object) });
  store.save("settings", owner, "repository-context", value);
  return value;
}
