import type { Store } from "../store.js";
import type { PreloadedTool } from "../tool-loading.js";
import { codingMode } from "./settings.js";

/**
 * mac7/speed — doing more in one round.
 *
 * On a hosted model a task's clock is very nearly (how many times it goes back to the model) times
 * (how long a round trip takes): measured on this branch, 88–94% of a coding task's wall time is
 * waiting for the model, and packing the same tool calls into fewer rounds cut one task from 1,958
 * ms to 928 ms. So this part is about rounds, not about making anything in Branch run faster.
 *
 * Four things, all switched together by the `fewer-rounds` coding part, which ships "when needed":
 *
 *   - the tools a coding task always reaches for are loaded from the first round, so it never
 *     spends a round trip searching for `files.edit` before it can start;
 *   - the assistant is told, in one line, that it may ask for several independent things at once;
 *   - `files.read_many` reads several files in one call (registered by the part's own switch, so
 *     "when needed" leaves it a line in the index and "on" loads it from the first round);
 *   - calls in one reply that only look at things run at the same time rather than one after
 *     another (`parallelGroups`, below).
 *
 * Like `read-first`, the behaviour is the same in "when needed" and "on" — there is no useful
 * middle setting for how a loop behaves. What the two modes really choose is the tier its tool
 * travels in, which is the ordinary meaning of the switch.
 */

/**
 * What a coding task reaches for, in the order it usually does. Measured over five ordinary coding
 * requests (`experiments/speed/catalog-probe.mjs`): 14 of these 30 places were a search away rather
 * than described in full, and one request ("Add a --verbose flag … and document it in the README")
 * was shown **none** of the six. With this list loaded it is 1 of 30.
 */
export const codingWorkingSet = [
  "files.read", "files.grep", "files.list", "files.glob", "files.edit", "files.write",
] as const;

/** Why they were loaded, in the words the run inspector shows beside a pre-loaded tool. */
const reason = "a coding task nearly always needs this, so it is here from the first round";

/** Whether the part is switched on at all. Both non-off modes switch the behaviour on. */
export const fewerRoundsOn = (store: Pick<Store, "get">, owner: string): boolean =>
  codingMode(store, owner, "fewer-rounds") !== "off";

/**
 * Something that reads like a file the person is pointing at: a name, a dot, a short extension.
 * Deliberately narrow — a sentence ending in "…in the README." is not a match, `README.md` is.
 */
const namesAFile = /(^|[\s"'`([{,])[\w./-]+\.(js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|java|kt|swift|c|h|cpp|cs|php|sh|sql|json|ya?ml|toml|ini|md|txt|html|css|scss)(?![\w-])/i;

/**
 * Whether this is work on the project's files. The toolboxes the request opened say so most of the
 * time — but not always, and the miss is expensive. On the plan's five-way window,
 * *"Add a `--shout` flag to cli.mjs … Document the flag in README.md"* opened **only** the documents
 * toolbox: the word "Document" won, the code box was never opened at all, and the task spent five of
 * its twelve rounds buying back `files.read`, `files.write`, `code.run` and `code.check` one search
 * at a time. A request that names a file is work on files whatever box the words happened to open.
 */
export const looksLikeCodingWork = (prompt: string, open: readonly string[]): boolean =>
  open.includes("code") || open.includes("files") || namesAFile.test(prompt);

/**
 * The coding tools to load before the first round, when this is work on the project's files. Only
 * tools the task is actually allowed and that are really registered are named, so a narrowed task
 * cannot be handed one it may not use.
 */
export function codingPreload(
  store: Pick<Store, "get">, owner: string,
  open: readonly string[], available: readonly string[], prompt = "",
): PreloadedTool[] {
  if (!fewerRoundsOn(store, owner)) return [];
  if (!looksLikeCodingWork(prompt, open)) return [];
  const here = new Set(available);
  return codingWorkingSet.filter((name) => here.has(name)).map((name) => ({ name, reason }));
}

/**
 * The one line the assistant is told. Deliberately short: the measurement that justifies it is
 * about round trips, and a paragraph here costs tokens on every single round.
 */
export const batchingNote =
  " When several things you need are independent of each other — reading four files, searching for "
  + "two different words — ask for them all in one go rather than one at a time. Each exchange with "
  + "you costs real time, so fewer, fuller turns finish the work sooner.";

/** That line, when the part is on; nothing at all when it is off. */
export const batchingInstructions = (store: Pick<Store, "get">, owner: string): string =>
  fewerRoundsOn(store, owner) ? batchingNote : "";

/**
 * mac7/speed: what a task is told when this computer will not run anything for it.
 *
 * In the five-way window eight rounds across twelve tasks were spent calling the project's check
 * and being told it could not run — a whole exchange with the model each time, to learn something
 * the task could have been told at the start. It says what to do instead rather than only what is
 * refused, and it is one sentence because it is charged on every round of the task.
 *
 * It belongs in the instructions rather than in a note after the request: a note would make the
 * last thing the model sees a line from Branch rather than what the person actually asked for.
 *
 * Integration (mac7/speed): it used to say the project's tests were off too. They are not the same
 * switch — `code.check` runs them through its own yes (src/coding/project-tests.ts) and works with
 * scripts switched off — so on a computer where the owner had allowed the tests this sentence told
 * the assistant not to try something it was allowed to do. It now says only what `code-run` really
 * decides.
 */
export const cannotRunNote =
  " Running commands and scripts is switched off on this computer, so do not try: you will only be "
  + "refused. Work from the files themselves, and when your answer depends on something having been "
  + "run, say plainly what you would have run and that it was not run.";

/** That sentence, for a task that is work on files and cannot run anything. */
export const cannotRunInstructions = (
  canRunScripts: boolean, prompt: string, open: readonly string[] = [],
): string => (!canRunScripts && looksLikeCodingWork(prompt, open) ? cannotRunNote : "");

/** The most calls that may run at the same time, so one reply cannot open fifty things at once. */
export const parallelLimit = 8;

export interface CallLike { id: string; name: string; arguments: string }
export interface GroupingRules {
  /** Whether this tool only looks at things — `isReadOnlyPermission` of its permission. */
  readOnly(name: string): boolean;
  /** What the call would touch, in the form the rules match against. */
  targetOf(call: CallLike): string;
  /**
   * What the rules say about this call as they stand: `"allow"` when running it would raise no
   * question at all, `"ask"` when it would stop and put a question to the person, anything else
   * (a refusal) when it would simply come back refused.
   */
  decisionOf(call: CallLike): string;
  /** Tools that must run alone because they change what the next round is shown. */
  alone: readonly string[];
}

/**
 * Splits a reply's tool calls into runs that may go at the same time.
 *
 * A call may share a run only when it **only looks at things** — so nothing it does can depend on,
 * or be undone by, what another call in the run does — and it is not one of the tools that change
 * what the next round is shown. Everything else is a run of its own, left exactly where it was, so
 * a read and a later change never swap places and the conversation reads as it always did.
 *
 * Two calls about the *same* thing are the delicate case. A "just this once" yes is remembered by
 * tool and target, so two such calls could spend one yes between them. They may therefore share a
 * run only when **both are already allowed outright** and nothing would be asked: then there is no
 * yes to spend. If either would raise a question, they run one after another, and the second is
 * asked again — which is exactly what happens today. That is what lets four searches of the same
 * folder go together while two calls waiting on one answer do not.
 *
 * Nothing here decides whether a call is allowed. Every call still goes through its own journal
 * entry, its own loop guard, its own permission check, approval, wall and deadline, exactly as it
 * does one at a time; the only thing shared is the clock.
 */
export function parallelGroups<T extends CallLike>(calls: readonly T[], rules: GroupingRules): T[][] {
  const groups: T[][] = [];
  let open: T[] = [];
  /** The first call in the open run about each thing; a later one about the same thing meets it. */
  let firstWith = new Map<string, T>();
  // What the rules say, asked once per call and remembered. It is a read of the saved rules and
  // nothing else — it writes nothing down and asks nobody.
  const answers = new Map<T, string>();
  const decision = (call: T): string => {
    const known = answers.get(call);
    if (known !== undefined) return known;
    const now = rules.decisionOf(call);
    answers.set(call, now);
    return now;
  };
  const allowed = (call: T): boolean => decision(call) === "allow";
  const flush = (): void => { if (open.length) groups.push(open); open = []; firstWith = new Map(); };
  for (const call of calls) {
    // Integration (mac7/speed): a call that would put a question to the person runs on its own.
    // Two such calls in one run each registered their own question, the task could only be stopped
    // by one of them, and the other was left waiting to be answered for a call that was no longer
    // running — answerable from a phone or a chat channel, and counting against the small number of
    // questions a conversation may have waiting, so it could push a real one out. A refusal needs no
    // question and may still share a run; it simply comes back refused, as it does today.
    if (!rules.readOnly(call.name) || rules.alone.includes(call.name) || decision(call) === "ask") {
      flush(); groups.push([call]); continue;
    }
    const target = rules.targetOf(call);
    const before = firstWith.get(target);
    // Everything already in the run about this thing was let through by this same test, so meeting
    // the first of them is enough to know none of them would raise a question.
    const targetOk = before === undefined || (allowed(before) && allowed(call));
    if (!targetOk || open.length >= parallelLimit) flush();
    open.push(call);
    if (!firstWith.has(target)) firstWith.set(target, call);
  }
  flush();
  return groups;
}
