import { runtimeIds, runtimeInfo } from "../local-launch.js";

/**
 * mac7/adapt: naming what stopped a task, from the sentence Branch already said.
 *
 * Branch has said these things for a long time — "Git is not installed on this computer", "Not
 * enough disk space", "Your Mac is not letting Branch take pictures of the screen". This file adds
 * no new error language at all: it reads those sentences back and says which kind of missing thing
 * each one is, so `/adapt` can offer the right fix. A sentence it does not recognise is not a
 * blocker it understands, and it says so rather than guess.
 *
 * Pure, and takes no store, no runner and no network, so every kind is tested on every computer.
 */

export const blockerKinds = ["runner", "model", "program", "key", "switch", "permission", "disk", "network"] as const;
export type BlockerKind = (typeof blockerKinds)[number];

/** The kinds of model a task can be missing, in the words the model list already uses. */
export const modelKinds = ["speech", "transcription", "embeddings", "vision", "images"] as const;
export type ModelKind = (typeof modelKinds)[number];

export interface Blocker {
  kind: BlockerKind;
  /** What exactly is missing: a program's name, a model kind, a switch's name, a folder. */
  what: string;
  /** Which kind of model, when the kind is "model"; empty otherwise. */
  modelKind: ModelKind | "";
  /** The sentence Branch said, kept exactly as it was said. */
  said: string;
}

const blocker = (kind: BlockerKind, what: string, said: string, modelKind: ModelKind | "" = ""): Blocker =>
  ({ kind, what, said: said.trim().slice(0, 400), modelKind });

/** The programs that run models, by the name their own errors use ("Ollama is not installed…"). */
const runnerNames = new Map(runtimeIds.map((id) => [runtimeInfo[id].name.toLowerCase(), runtimeInfo[id].name]));

/** Each kind, with the sentences Branch already says for it. The first match wins, in this order. */
const readers: { kind: BlockerKind; read: (said: string) => Blocker | null }[] = [
  // Lockdown, a switch that is off, or a feature that refuses: always read first, because those
  // sentences also name programs and models and must not be taken for a missing one.
  { kind: "switch", read: (said) => {
    const off = /(?:is|are) switched off|Branch is not set up to|Turn (?:that|them|it) on in Settings|Turn them on at the top of this card/i.exec(said);
    if (!off) return null;
    const named = /^(?:The )?([^.:]{2,60}?) (?:is|are) switched off/i.exec(said.trim());
    return blocker("switch", (named?.[1] ?? "a switch in Settings").trim(), said);
  } },
  { kind: "permission", read: (said) => {
    if (!/Your Mac is not letting Branch|System Settings, Privacy & Security|Windows Settings, Privacy & security|Full Disk Access/i.test(said)) return null;
    const page = /Privacy & Security, ([A-Za-z &]{3,40})/i.exec(said)?.[1]?.trim();
    return blocker("permission", page ? `permission for ${page}` : "a permission this computer has not granted", said);
  } },
  { kind: "disk", read: (said) => /Not enough disk space/i.test(said) ? blocker("disk", "room on this disk", said) : null },
  { kind: "network", read: (said) =>
    /Could not reach that address|Cannot reach the [a-z ]+service|Cannot reach (?:audio transcription|speech) endpoint|ENOTFOUND|ECONNREFUSED|fetch failed|getaddrinfo/i.test(said)
      ? blocker("network", "a working connection to the internet", said) : null },
  { kind: "key", read: (said) => {
    if (!/needs a key before it can be used|has no key yet|key is required|provider with a key|no key picked|no account picked/i.test(said)) return null;
    const named = /^([A-Za-z0-9 .+-]{2,40}?) (?:needs a key|has no key yet)/.exec(said.trim())
      ?? /^A ([A-Za-z0-9 ]{2,30}) key is required/.exec(said.trim());
    return blocker("key", named?.[1]?.trim() ?? "a model service", said);
  } },
  { kind: "runner", read: (said) => {
    if (/No program that runs models is installed yet/i.test(said)) return blocker("runner", runtimeInfo.ollama.name, said);
    const named = /\b([A-Za-z][\w.+-]*(?: Studio)?) is not installed on this computer/.exec(said);
    const runner = named ? runnerNames.get(named[1]!.toLowerCase()) : undefined;
    return runner ? blocker("runner", runner, said) : null;
  } },
  { kind: "model", read: (said) => {
    const kind = modelKindIn(said);
    if (!kind) return null;
    return blocker("model", `a model that can do ${wordFor[kind]}`, said, kind);
  } },
  { kind: "program", read: (said) => {
    // "needs X, which is not installed" comes first: the plainer pattern would otherwise read the
    // "which" of that sentence as the program's own name.
    const missing = /needs? ([A-Za-z][\w.+-]*), which is not installed/.exec(said)
      ?? /\b([A-Za-z][\w.+-]*) is not installed(?: at | on this computer|,|\.|$)/.exec(said)
      ?? /No ([a-z ]{3,30}) is set up on this computer/.exec(said);
    return missing ? blocker("program", missing[1]!.trim(), said) : null;
  } },
];

const wordFor: Record<ModelKind, string> = {
  speech: "reading aloud", transcription: "writing out speech",
  embeddings: "comparing passages by meaning", vision: "looking at pictures", images: "drawing pictures",
};

/** Which kind of model a sentence is short of, from the words those sentences already use. */
function modelKindIn(said: string): ModelKind | "" {
  if (/Reading aloud|speech engine|Higher-quality voice/i.test(said)) return "speech";
  if (/Writing out speech|Speech to text|transcription/i.test(said)) return "transcription";
  if (/compare passages by meaning|comparing passages/i.test(said)) return "embeddings";
  if (/picture service|drawing a picture|without a picture/i.test(said)) return "images";
  if (/look at pictures|cannot see pictures/i.test(said)) return "vision";
  if (/is not offered for|needs a model from Branch's list|no MLX weights/i.test(said)) return "transcription";
  return "";
}

/**
 * What stopped this task, or null when the sentence is not one Branch knows how to place. A null is
 * not a failure: `/adapt` then says plainly that it cannot tell what is missing.
 */
export function readBlocker(said: string): Blocker | null {
  const text = String(said ?? "").trim();
  if (!text) return null;
  for (const reader of readers) {
    const found = reader.read(text);
    if (found) return found;
  }
  return null;
}
