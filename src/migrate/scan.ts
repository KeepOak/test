import { lstat } from "node:fs/promises";
import type { Store } from "../store.js";
import { scanClaudeCode } from "./claude-code.js";
import { scanChatGPT } from "./chatgpt.js";
import { scanCodex } from "./codex.js";
import { placesFor, recognise, type ExtraName, type Place, type PlaceInput } from "./detect.js";
import { scanHermes } from "./hermes.js";
import { scanOpenClaw } from "./openclaw.js";
import { scanOpenCode } from "./opencode.js";
import { movedCounts, movedIn } from "./record.js";
import { folderTree, type SourceTree } from "./source-tree.js";
import {
  itemKinds, kindNames, moveInSources, sourceNames,
  type ItemKind, type KeyPrompt, type MoveInSource, type ScanResult,
} from "./types.js";

export interface ScanInput { tree: SourceTree; extras: Partial<Record<ExtraName, SourceTree>> }

const readers: Record<MoveInSource, (input: ScanInput) => Promise<ScanResult>> = {
  "claude-code": scanClaudeCode, codex: scanCodex, hermes: scanHermes, openclaw: scanOpenClaw, opencode: scanOpenCode, chatgpt: scanChatGPT,
};

export const scanSource = (source: MoveInSource, input: ScanInput): Promise<ScanResult> => readers[source](input);

/** The trees for an assistant's usual place on this computer. */
export function placeInput(place: Place): ScanInput {
  const extras: ScanInput["extras"] = {};
  for (const extra of place.extras) extras[extra.name] = folderTree(extra.folder, extra.only);
  return { tree: folderTree(place.root), extras };
}

const isFolder = async (path: string): Promise<boolean> => (await lstat(path).catch(() => null))?.isDirectory() === true;

export interface FoundSource {
  source: MoveInSource; name: string; folder: string; found: boolean;
  /** How many things of each kind have already come over from it. */
  moved: Partial<Record<ItemKind, number>>;
}

/** Which of the assistants have a folder on this computer, and what has already come over from each. */
export async function foundSources(store: Store, owner: string, input: PlaceInput, exists = isFolder): Promise<FoundSource[]> {
  const places = placesFor(input), result: FoundSource[] = [];
  for (const place of places) {
    const found = await exists(place.root) && await recognise(folderTree(place.root)) !== null;
    result.push({ source: place.source, name: sourceNames[place.source], folder: place.root, found,
      moved: movedCounts(store, owner, place.source) });
  }
  return result;
}

/** The first-run sentence, naming the assistants found that still have something to bring. */
export function offerSentence(sources: FoundSource[]): string | null {
  const waiting = sources.filter((entry) => entry.found && !Object.keys(entry.moved).length).map((entry) => entry.name);
  if (!waiting.length) return null;
  const names = waiting.length === 1 ? waiting[0]! : `${waiting.slice(0, -1).join(", ")} or ${waiting[waiting.length - 1]}`;
  return `Bring your chats and memory from ${names}.`;
}

export interface PreviewItem {
  key: string; title: string; detail: string; origin: string;
  provenance?: import("./types.js").ChatProvenance;
  blocked: boolean; alreadyMoved: boolean; needsKeys: string[];
}
export interface Preview {
  source: MoveInSource; name: string; from: string;
  groups: { kind: ItemKind; name: string; items: PreviewItem[] }[];
  keys: KeyPrompt[]; notes: string[];
}

/** What the owner is shown before anything is brought over. Reading only: nothing in Branch changes. */
export function previewOf(store: Store, owner: string, source: MoveInSource, from: string, result: ScanResult): Preview {
  const record = movedIn(store, owner, source);
  const groups = itemKinds.map((kind) => ({
    kind, name: kindNames[kind],
    items: result.items.filter((item) => item.kind === kind).map((item) => ({
      key: item.key, title: item.title, detail: item.detail, origin: item.origin,
      ...(item.provenance ? { provenance: item.provenance } : {}),
      blocked: item.blocked, alreadyMoved: item.key in record, needsKeys: item.needsKeys,
    })),
  })).filter((group) => group.items.length);
  return { source, name: sourceNames[source], from, groups, keys: result.keys, notes: result.notes };
}

export { moveInSources, recognise };
