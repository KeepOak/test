import type { ToolContext } from "../contracts.js";
import { binnedRuns } from "../conversation-actions.js";
import { detectInjection } from "../content-guard.js";
import { checkResult } from "../delegation.js";
import { runOrigin } from "../key-context.js";
import { jaccard, wordsOf } from "../learning-more/curator.js";
import type { MemoryConsolidation } from "../memory-consolidate.js";
import { factKinds } from "../memory-layers.js";
import { ringsSource } from "../memory-review.js";
import type { ModelPreset } from "../models.js";
import { profileScope } from "../profiles.js";
import type { Runtime } from "../runtime.js";
import { learningTask, learningTaskPrefix } from "../skill-authoring.js";
import type { Store } from "../store.js";
import { typedBy } from "./evidence.js";
import { fileProblems, type Filer } from "./code-problems.js";
import type { Gardener } from "./gardener.js";
import { nightOf, overnightModel, quietNow, type QuietReason } from "./overnight.js";
import { emptyNight, missedGates, RingsBook, scoreOf, sameThought, signalsOf, type Candidate, type Night, type NightData } from "./rings-store.js";
import { seasonsSettings } from "./settings.js";

/**
 * Rings: the overnight consolidation. Each night, for the owner and for each household person apart, it reads the
 * requests that person typed since the last night (Light), asks the owner's own free model once which lasting
 * facts those words state, keeping only what it can quote back word for word (REM), and keeps for good only what
 * passes every gate, with where it came from (Deep). A night's entry can be read, undone and vetoed.
 *
 * It replaces the daily "look over finished tasks" pass (it asked the default model, whatever it cost, and read
 * every person's tasks as the owner's) and runs the quiet merge-by-meaning pass as its light phase. The phases
 * follow OpenClaw's dreaming (Light, REM, Deep); the code is Branch's own. See docs/seasons.md.
 */
export interface Scope { scope: string; person: string | null }
export type NightOutcome = { night: Night } | { night: null; reason: QuietReason | "already" | "busy" };
/** One grounded fact the REM step may keep: its words, and exact quotes of the person's own requests. */
interface Found { text: string; kind: string; confidence: number; quotes: { n: number; words: string }[] }
interface Request { runId: string; sessionId: string; prompt: string; at: string }
/** At most this many requests are read per person per night; the rest wait for the next night. */
export const requestsPerNight = 60;
const maxFactChars = 600;

export const remInstructions = [
  "You read requests one person typed to their assistant. Find lasting facts about that person that their own words state:",
  "preferences, who they are, how they like things done, standing details of their life or work.",
  "Leave out anything tied to one request (a date, a file, an error) and anything about other people's private lives.",
  "Reply with JSON only: {\"facts\":[{\"text\":\"one sentence about the person\",\"kind\":\"preference\",\"confidence\":0.8,",
  "\"quotes\":[{\"n\":1,\"words\":\"words copied exactly from request 1\"}]}]}.",
  `kind is one of ${factKinds.filter((kind) => kind !== "task-scratch").join(", ")}. Every fact needs a quote copied exactly. An empty list is the normal answer.`,
].join(" ");

const plain = (text: string): string => text.toLowerCase().replace(/\s+/g, " ").trim();

export class Rings {
  readonly book: RingsBook;
  private running: Promise<unknown> | null = null;
  private readonly nights = new Map<string, Promise<NightOutcome>>();
  /** Seasons: the Gardener and where code-level problems are filed, both connected at start-up. */
  gardener?: Gardener;
  problems?: Filer;
  constructor(private readonly store: Store, private readonly runtime: Runtime, private readonly consolidation?: MemoryConsolidation) {
    this.book = new RingsBook(store.sqlite);
  }
  /** The owner and each household person, each a scope of their own. */
  scopes(): Scope[] {
    return [{ scope: this.runtime.owner, person: null },
      ...this.store.profiles.list().map((profile) => ({ scope: profileScope(profile.id), person: profile.id }))];
  }
  scopeOf(scope: string): Scope | undefined { return this.scopes().find((entry) => entry.scope === scope); }
  /** Waits for a night under way, for tests and shutdown. */
  async idle(): Promise<void> { await Promise.all([this.running, ...this.nights.values()].map((work) => work?.catch(() => undefined))); }

  /** The scheduler's beat: starts tonight's work in the background when it is quiet and not yet done. */
  tick(now: Date = new Date()): void {
    if (this.running) return;
    const settings = seasonsSettings(this.store, this.runtime.owner);
    if (!quietNow(this.store.sqlite, this.runtime.owner, settings, now).quiet) return;
    const due = this.scopes().filter((entry) => !["done", "skipped", "undone"].includes(this.book.night(entry.scope, nightOf(now, settings))?.status ?? ""));
    if (!due.length) return;
    this.running = (async () => { for (const entry of due) await this.night(entry, now, false); })()
      .finally(() => { this.running = null; });
  }
  /** One person's night. `asked` is the owner pressing the button: it skips the quiet check, never the model gate. */
  night(entry: Scope, now: Date = new Date(), asked = true): Promise<NightOutcome> {
    const key = `${entry.scope}:${nightOf(now, seasonsSettings(this.store, this.runtime.owner))}`;
    const active = this.nights.get(key);
    if (active) return active;
    const work = this.runNight(entry, now, asked).finally(() => { this.nights.delete(key); });
    this.nights.set(key, work);
    return work;
  }
  private async runNight(entry: Scope, now: Date, asked: boolean): Promise<NightOutcome> {
    const settings = seasonsSettings(this.store, this.runtime.owner);
    const night = nightOf(now, settings);
    const before = this.book.night(entry.scope, night);
    if (!asked && before && before.status !== "paused" && before.status !== "running") return { night: null, reason: "already" };
    const record: Night = { id: before?.id ?? `${entry.scope}:${night}`, scope: entry.scope, night, status: "running",
      startedAt: now.toISOString(), finishedAt: null, model: null, modelKind: null, data: emptyNight(), seenAt: null };
    const models = [...this.runtime.models.presets.values()];
    const chosen = overnightModel(models, this.runtime.models.summary(this.runtime.owner).defaultPreset, settings.paidModels, entry.person === null);
    if (!chosen.preset) return { night: this.finish(record, "skipped", "no-free-model") };
    record.model = chosen.preset.name; record.modelKind = chosen.kind;
    this.book.saveNight(record);
    // Checked again between steps, on the night's own clock moved on by the time the steps took.
    const began = Date.now();
    const stillQuiet = (): boolean => {
      const fresh = seasonsSettings(this.store, this.runtime.owner);
      return fresh.rings !== "off" && (chosen.kind !== "billed" || fresh.paidModels)
        && (asked || quietNow(this.store.sqlite, this.runtime.owner, fresh, new Date(now.getTime() + Date.now() - began)).quiet);
    };
    try {
      if (!stillQuiet()) return { night: this.finish(record, "paused", "settings-or-activity-changed") };
      await this.light(entry.scope, record.data);
      if (!stillQuiet()) return { night: this.finish(record, "paused", "owner-active") };
      const read = await this.rem(entry, chosen.preset, record);
      if (!stillQuiet()) return { night: this.finish(record, "paused", "owner-active") };
      if (!await this.deep(entry.scope, record, now, stillQuiet)) return { night: this.finish(record, "paused", "settings-or-activity-changed") };
      if (read) this.book.moveCursor(entry.scope, read.at, read.runId);
      // The owner's night goes on to the garden: skills are the owner's, so a household person's never does.
      if (entry.person === null && this.gardener && stillQuiet()) {
        const garden = await this.gardener.night({ preset: chosen.preset, stillQuiet, now });
        record.data.garden = { ...garden, problems: fileProblems(this.store, this.runtime.owner, this.problems) };
      }
      if (!stillQuiet()) return { night: this.finish(record, "paused", "settings-or-activity-changed") };
      return { night: this.finish(record, "done") };
    } catch (error) {
      // A failure is not retried on every beat (that would ask the model all night); the night is over, and says why.
      return { night: this.finish(record, "skipped", error instanceof Error ? error.message.slice(0, 300) : String(error)) };
    }
  }
  private finish(record: Night, status: Night["status"], reason?: string): Night {
    return this.book.saveNight({ ...record, status, finishedAt: new Date().toISOString(), data: { ...record.data, ...(reason ? { reason } : {}) } });
  }

  /** Light: the quiet merge-by-meaning pass over what is already remembered. No model answers here. */
  private async light(scope: string, data: NightData): Promise<void> {
    if (!this.consolidation || !this.consolidation.settings(scope).enabled) return;
    const result = await this.consolidation.run(scope);
    data.light = { embedded: result.embedded, merges: result.proposed };
  }

  /**
   * The requests one person typed since their last night: their own words only. A request from a chat app (which
   * cannot prove who is typing), from a short-lived key, from another program, a schedule, a helper task, a
   * learning pass, a temporary conversation or one in Recently Deleted is never evidence.
   */
  requests(entry: Scope): Request[] {
    const binned = binnedRuns(this.store.sqlite);
    const found: Request[] = [];
    const cursor = this.book.cursorPosition(entry.scope);
    let at = cursor.at, id = cursor.id, first = !id;
    while (found.length < requestsPerNight) {
      const rows = this.store.sqlite.prepare(`SELECT id, session_id, prompt, created_at FROM tasks WHERE owner=?
        AND (created_at>? OR (?=0 AND created_at=? AND id>?))
        AND status IN ('completed','failed') AND prompt NOT LIKE '${learningTaskPrefix}%'
        ORDER BY created_at ASC,id ASC LIMIT 400`).all(this.runtime.owner, at, first ? 1 : 0, at, id);
      for (const row of rows) {
        const request = { runId: String(row.id), sessionId: String(row.session_id), prompt: String(row.prompt), at: String(row.created_at) };
        if (!binned.has(request.runId) && typedBy(this.store, { id: request.runId, prompt: request.prompt, sessionId: request.sessionId }, entry.person)) found.push(request);
        if (found.length === requestsPerNight) break;
      }
      if (rows.length < 400 || found.length === requestsPerNight) break;
      const last = rows.at(-1)!;
      at = String(last.created_at); id = String(last.id); first = false;
    }
    return found;
  }

  /** REM: one question to the free model; only facts it can quote back from the person's own words are kept. */
  private async rem(entry: Scope, preset: ModelPreset, record: Night): Promise<Request | null> {
    const requests = this.requests(entry);
    record.data.read = requests.length;
    if (!requests.length) return null;
    const numbered = requests.map((request, i) => `[${i + 1}] ${request.prompt.replace(/\s+/g, " ").slice(0, 600)}`).join("\n").slice(0, 16000);
    const { parent, context } = learningTask(this.store, this.runtime.owner, "Rings: read the day", this.runtime);
    let reply: string;
    try {
      const scoped: ToolContext = { ...context, signal: AbortSignal.any([context.signal, AbortSignal.timeout(120_000)]) };
      reply = await this.runtime.completeAside(parent, scoped, preset, `${remInstructions}\n\nThe requests:\n${numbered}`);
      this.store.finish(parent.id, "completed", "Read the day");
    } catch (error) {
      this.store.finish(parent.id, "failed", error instanceof Error ? error.message : String(error));
      throw error;
    }
    const checked = checkResult(reply, { type: "object" });
    if (checked.status !== "resolved") throw new Error(`The night's reading could not be read (${checked.reason})`);
    const facts = foundFacts(checked.value);
    record.data.rem.found = facts.length;
    for (const fact of facts) this.keepGrounded(entry.scope, fact, requests, record);
    return requests.at(-1)!;
  }
  private keepGrounded(scope: string, fact: Found, requests: Request[], record: Night): void {
    if (detectInjection(fact.text).length) { record.data.rem.refused++; return; }
    const grounded = fact.quotes.filter((quote) => {
      const request = requests[quote.n - 1];
      const words = plain(quote.words);
      return request && words.length >= 3 && plain(request.prompt).includes(words) && !detectInjection(quote.words).length;
    });
    // The fact must be about what was quoted: it shares a word with the person's own words, or it is not kept.
    const quoted = wordsOf(grounded.map((quote) => quote.words).join(" "));
    if (!grounded.length || ![...wordsOf(fact.text)].some((word) => quoted.has(word))) { record.data.rem.ungrounded++; return; }
    record.data.rem.grounded++;
    for (const quote of grounded) {
      const request = requests[quote.n - 1]!;
      this.book.addMention(scope, fact.text, fact.kind, { runId: request.runId, sessionId: request.sessionId,
        quote: quote.words.slice(0, 300), at: request.at, night: record.night, confidence: fact.confidence });
    }
  }

  /** Deep: every waiting candidate is scored; one that passes every gate is kept for good, with its evidence. */
  private async deep(scope: string, record: Night, now: Date, stillQuiet: () => boolean): Promise<boolean> {
    const known = this.store.list("memory", scope).map((fact) => wordsOf(String(fact.data.text ?? "")));
    for (const entry of this.book.candidates(scope).filter((candidate) => candidate.status === "pending")) {
      if (!stillQuiet()) return false;
      const settings = seasonsSettings(this.store, this.runtime.owner);
      if (known.some((words) => jaccard(words, wordsOf(entry.text)) >= sameThought)) {
        this.book.saveCandidate({ ...entry, status: "known" }); record.data.deep.known++; continue;
      }
      if (missedGates(signalsOf(entry, now), settings).length) { record.data.deep.waiting++; continue; }
      const kept = await this.promote(scope, entry, record);
      record.data.deep[kept.status === "promoted" ? "promoted" : "staged"].push(kept.id);
    }
    return stillQuiet();
  }
  /**
   * Through the review queue, so the checks every suggestion meets are met here too. The owner's "ask me before
   * changing memory" switch, or an outside memory service, leaves it waiting there for a yes instead.
   */
  private async promote(scope: string, entry: Candidate, record: Night): Promise<Candidate> {
    const signals = signalsOf(entry, new Date());
    const source = `${ringsSource} ${record.night}: said ${signals.mentions} times in ${signals.conversations} conversations`;
    const proposal = this.store.review.propose(scope, { kind: "put", text: entry.text.slice(0, maxFactChars), source,
      runId: entry.evidence[0]?.runId ?? "", note: `score ${scoreOf(signals)}` }, { kind: entry.kind, layer: "long-term" });
    const waits = this.store.review.settings(scope).requireApproval || !!this.store.review.provider?.isOutside(scope);
    if (waits) return this.book.saveCandidate({ ...entry, status: "staged", proposalId: proposal.id, promotedNight: record.night });
    return this.acceptNow(scope, entry, proposal.id, record.night);
  }
  private async acceptNow(scope: string, entry: Candidate, proposalId: string, night: string): Promise<Candidate> {
    const { applied } = await this.store.review.decide(scope, proposalId, true);
    const id = (applied as { id?: unknown } | null)?.id;
    return this.book.saveCandidate({ ...entry, status: "promoted", proposalId, promotedNight: night, memoryId: typeof id === "string" ? id : null });
  }
}

/** The facts a reply lists, each checked for shape; a malformed one is left out. */
export function foundFacts(value: unknown): Found[] {
  const facts = (value as { facts?: unknown })?.facts;
  if (!Array.isArray(facts)) return [];
  return facts.slice(0, 20).flatMap((item) => {
    const fact = item as Record<string, unknown>;
    const text = typeof fact.text === "string" ? fact.text.trim() : "";
    const kind = factKinds.includes(fact.kind as never) && fact.kind !== "task-scratch" ? String(fact.kind) : "fact-about-person";
    const quotes = Array.isArray(fact.quotes) ? fact.quotes.slice(0, 5).flatMap((quote) => {
      const q = quote as Record<string, unknown>;
      return Number.isInteger(q.n) && typeof q.words === "string" ? [{ n: Number(q.n), words: q.words }] : [];
    }) : [];
    const confidence = typeof fact.confidence === "number" && Number.isFinite(fact.confidence) ? Math.min(1, Math.max(0, fact.confidence)) : 0.5;
    return text && text.length <= maxFactChars ? [{ text, kind, confidence, quotes }] : [];
  });
}
