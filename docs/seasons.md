# Seasons: how Branch gets better by itself

Seasons is the name for the whole self-improvement loop:

**work** (the owner's tasks) → **Rings** (overnight consolidation of what was learned) → **Gardener** (skills that
earn their place) → **better Trunks**.

This page records what each part does, how it compares with the two systems it is measured against (OpenClaw's
dreaming and Hermes Agent's curator), and the guards that keep it safe. The code lives in `src/seasons/`.

## Sources read

- OpenClaw, *Dreaming*: <https://docs.openclaw.ai/concepts/dreaming> and the memory configuration reference
  <https://docs.openclaw.ai/reference/memory-config> (read 2026-09-27).
- Hermes Agent, *Curator*: <https://hermes-agent.nousresearch.com/docs/user-guide/features/curator> (read 2026-09-27).

OpenClaw documents the three gate names (`minScore`, `minRecallCount`, `minUniqueQueries`) and the six weights,
but states that the phase thresholds are internal, not user configuration, and publishes no default values for
the three gates. The defaults below are Branch's own choice.

## Rings (compared with OpenClaw dreaming)

| | OpenClaw dreaming | Branch Rings |
|---|---|---|
| On by default | `dreaming.enabled: true` | Yes (`rings: "on"`), under ship-on rules (a) and (e) below |
| When | One cron sweep, default `0 3 * * *` | Inside a night window (default 01:00–06:00, this computer's local time), only after nobody has started or worked a task for `idleMinutes` (default 30), and only with no task running |
| Yields to the owner | Not documented | Re-checked between phases; the night pauses the moment the owner starts a task and resumes on a later beat |
| Model | The agent's default model unless `dreaming.model` is set | The owner's own connections only: a model on this computer first, then the owner's subscription sign-in. A connection billed per call only when the owner turns on `paidModels` (ships off, rule (a)). With none, the night is skipped and says so |
| Light phase | Reads recent recall state, daily files, redacted transcripts; dedupes and stages candidates | Runs the existing merge-by-meaning pass over what is remembered (`src/memory-consolidate.ts`), which gives new facts their vectors and stages merges for the owner. No model answers here |
| REM phase | Builds theme and reflection summaries; records reinforcement signals | One question to the free model over the requests the person typed since their last night (at most 60). A fact is kept as a candidate only when the model quotes the person's own words back **exactly** and the fact shares a word with that quote (grounding) |
| Deep phase | Ranks with weights; promotes to `MEMORY.md` when every gate passes; rehydrates snippets so deleted ones are skipped | Scores every waiting candidate with the same six weights and promotes it to a long-term fact only when every gate passes. A candidate that says what is already remembered is marked known, never saved twice |
| Weights | relevance 0.30, frequency 0.24, query diversity 0.15, recency 0.15, consolidation 0.10, conceptual richness 0.06 | The same six weights. Relevance: the model's confidence. Frequency: mentions, full at 5. Query diversity: distinct conversations, full at 3. Recency: half-life 14 days. Consolidation: distinct nights, full at 3. Richness: distinct content words, full at 8 |
| Gates | `minScore`, `minRecallCount`, `minUniqueQueries`, all must pass (values internal) | Same names, all must pass: `minScore` 0.6, `minRecallCount` 3 (times the person said it), `minUniqueQueries` 2 (in that many different conversations). The owner can set each |
| Provenance | Promoted entries must carry source references | Every candidate keeps each quote with its task, conversation, time and night; the saved fact's source says the night and the counts |
| Taint gate | Candidates with `untrusted` or `system` provenance are excluded | Only the person's own typed requests are evidence. Never a chat app's message (a chat cannot prove who is typing), a short-lived key, another program, a schedule or trigger, a helper task, a learning pass, a temporary conversation or one in Recently Deleted. A fact or quote that reads like an order is refused |
| Diary | `DREAMS.md`, a narrative written by a model after each phase | The Rings journal: one entry per person per night with what was read, kept, left waiting, refused and why. Structured, no extra model call; the window writes the sentence in the owner's language |
| Undo | Prior `MEMORY.md` kept before rewrites; append-only fallback | Undo a whole night, veto one fact, or keep it again. Undo and veto set the fact aside in the memory archive (never a delete), and a vetoed thought is never kept again however often it comes back |
| Review first | Not documented | With "ask me before changing memory" on, or an outside memory service chosen, a night only leaves suggestions in the review queue |
| Morning | Not documented | "What I learned last night": the newest finished night's kept facts, until the person has seen them |
| Household | Not documented | Each household person has their own night: their own requests only, their own candidates, facts, cursor and journal. Nothing is read or written across people. A person's night never uses the owner's sign-in |

### What Rings replaced

- The daily "look over finished tasks" (`MemoryReview.consolidate`). It started a full task on the default model
  whatever it cost, and read every task, a household person's included, as the owner's. `POST /api/memory/consolidate`
  now runs the owner's night of Rings.
- The merge-by-meaning pass's own nightly beat. It is Rings' light phase now; its switch still turns that phase off.

### Guards and where they are tested

`tests/seasons-rings.test.mjs` covers each of these, and each was broken on purpose to see its test go red:

| Guard | Code |
|---|---|
| Never a billed connection unless allowed; never the owner's sign-in for a household person | `overnightModel` in `src/seasons/overnight.ts` |
| Night window, nothing running, owner away; pause mid-night | `quietNow` in `src/seasons/overnight.ts`, `Rings.night` |
| The three gates | `missedGates` in `src/seasons/rings-store.ts` |
| Grounding and the injection check | `Rings.keepGrounded` |
| Only the person's own typed words | `Rings.requests` |
| Household separation | `Rings.requests` (person match), `RingsBook` (every query names the scope) |
| Never delete: undo, veto and keep | `src/seasons/journal.ts` |

The `seasons` settings record is held for the owner's yes on a restore (`src/backup.ts`), so a backup file cannot
switch on paid models or loosen the gates. Rings' own tables are not carried by a backup.
