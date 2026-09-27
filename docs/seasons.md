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
| Undo | Prior `MEMORY.md` kept before rewrites; append-only fallback | Undo a whole night, veto one fact, or keep it again. Local facts move to the archive. Outside facts retain a private restorable copy and are removed from their original service after verification; Keep verifies restoration. A vetoed thought stays vetoed beyond the recent list |
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
| Fresh switches, night window, nothing running, owner away; pause mid-night | `quietNow` in `src/seasons/overnight.ts`, `Rings.night`; settings checked before each phase and promotion |
| The three gates | `missedGates` in `src/seasons/rings-store.ts` |
| Grounding and the injection check | `Rings.keepGrounded` |
| Only the person's own typed words | `Rings.requests` |
| Household separation | `Rings.requests` (person match), `RingsBook` (every query names the scope) |
| Restorable archive and verified original-backend Undo/Keep | `src/seasons/journal.ts`, `MemoryProvider.setAsideAt/restoreAt` |

The `seasons` settings record is held for the owner's yes on a restore (`src/backup.ts`), so a backup file cannot
switch on paid models or loosen the gates. Rings' own tables are not carried by a backup.

Accepted facts have private destination receipts scoped to the person. Outside Undo preserves a restorable copy,
uses that receipt's exact fact ID, and checks authenticated deletion and absence from the original service.
Keep refuses an ID occupied by different content and verifies restored content before updating the journal.
Changing the selected service or credential prevents either action from reaching another service; select the
original service again to retry. These receipt/archive tables do not travel with backups. Older outside facts
without a trustworthy destination receipt fail visibly instead of being falsely reported undone.

## Gardener (compared with Hermes Agent's curator)

| | Hermes curator | Branch Gardener |
|---|---|---|
| On by default | `curator.enabled: true`; LLM consolidation `consolidate: false` | Yes (`gardener: "on"`). It drafts and proves only on the night's free model, inside the quiet night |
| When | Every `interval_hours` (168) once the agent has been idle `min_idle_hours` (2); skips while a turn is active | Each night, after Rings, under the same quiet gate; stops between steps once the owner is back |
| Where skills come from | The agent creates skills in the foreground, including after complex tasks | Only from the owner's four triggers: the same kind of request at least 3 times; a failed task fixed by real work; the owner saying "remember how to do this"; a capability Budding built. A task that merely used several tools makes none (the old "draft after a 3-tool task" was removed) |
| Before adoption | No verification | **Proved.** The seed's own tasks are replayed as practice runs without the draft and with it, on the same model, and each answer is graded 0–10 by that model. Adopted only when the gain is at least `minGain` (0.1); otherwise discarded with the reason. A replay where a side produced nothing is refused, never counted as a loss |
| Size | Not capped | Short (`maxSkillChars` 2400) and loaded only when needed (its one-line index entry, #471). The cap is on context cost: every adopted skill's index line together stays under `indexBudget` (400 tokens) |
| Usage | `use_count`, `view_count`, `last_used_at`, … in `.usage.json` | Which tasks drew on each skill, from the governance record every task keeps (`src/learning-more/curator.ts`) |
| Lifecycle | active → stale (14 days) → archived (30 days) | The same states and defaults for skills the Gardener adopted (`staleAfterDays`, `archiveAfterDays`). Archived means switched off, never removed |
| Merging | Optional LLM pass proposes umbrella skills | **Grafting:** two adopted skills that overlap get one merged version, proved against the two it replaces on both skills' tasks, and switched on only when it does no worse |
| After adoption | Not re-checked | Each night one adopted skill is re-proved; one now worse than no skill, or worse than when it was adopted, is **rolled back by itself** |
| Pinning | `curator pin` keeps a skill from transitions | Pinning keeps a skill from pruning, grafting and rollback. A re-rooted skill, or one whose rollback the owner undid, is pinned |
| Undo | Snapshots (`curator rollback`) and single-mutation ledger rollback | Every change is a ledger entry with each skill's version before and after; undo puts that back. Undoing a discard puts the draft back from its seed, switched off, to be proved again |
| Never deletes | Worst case is archival | Same. A discarded draft's switched-off install, which nothing ever used, leaves the skills list, but its whole file stays in its seed |
| Whose skills | Agent-created only | Only skills the Gardener adopted are pruned, grafted or rolled back. The Gardener reads only the owner's own requests; a household person's never seed the owner's skills |

### Code-level problems

A tool that keeps failing with an error only a bug in Branch makes (a `TypeError`, a value read from nothing) in at
least 3 of the owner's tasks across 2 conversations becomes one request to change Branch itself (#456/#557), filed
once. Filing starts nothing: the owner answers it in the app, and only a yes there prepares a change, which the owner
reviews as a pull request.

### Gardener guards and where they are tested

`tests/seasons-gardener.test.mjs`:

| Guard | Code |
|---|---|
| Four triggers only; no seed without one | `src/seasons/triggers.ts`, `Gardener.plantFromTriggers` |
| Eval-gated adoption, refusal of an unreadable replay | `Gardener.grow`, `src/seasons/proof.ts` |
| Context-cost cap, short skills | `Gardener.grow` (`maxSkillChars`, `indexBudget`) |
| Automatic rollback on regression | `Gardener.recheck` |
| Graft, prune, re-root and undo, never a delete | `Gardener.graft`, `prune`, `reroot`, `undo` |
| Owner's garden only | `src/seasons/api.ts`, `typedBy(…, null)` |

## Budding

`seasons.bud` preserves an owner's original request and tries the cheapest rung first:

1. Compose existing tools under the task's current permissions. Success finishes the original request and plants a
   waiting Gardener seed; it does not adopt a skill.
2. If composition fails, offer matching MCP connectors with their prerequisites. Each installation needs the owner's
   approval in **Library → Seasons**. Command servers also retain the existing exact program-launch approval.
   A connected approved server hot reloads its tools and takes up the preserved task once, adding only that server's
   tool permissions. Credentials are configured through the existing tool-server flow.
3. After an unsuitable connector is declined, `seasons.build_tool` tests a held JavaScript tool against explicit
   input/expected fixtures before registration. It inherits no extra file, network or credential permissions; nested
   scripts and held capabilities are refused. A passing tool is registered as a deferred plugin tool and the original
   request continues. The ordinary wall and approval gates still apply to every execution.
4. When the held rung cannot work, the owner can file a Branch change for review. The existing source-change contract
   and PR review workflow remain responsible for preparing and publishing the change. An approved request is taken up
   after an installed version change and the owner's per-item acknowledgement that this reviewed change was installed;
   an unrelated version change alone cannot resume it. `seasons.finish_bud` then uses current normal permissions.

Windows currently has no trustworthy file/network wall for JavaScript tool scripts. Budding preserves the reason,
runs no held code there, and offers the Branch review rung. A missing connector address is an external configuration
prerequisite shown with the instruction to configure it in Customize → Tool servers.

Capability requests and tested source live in private tables excluded from backup import. Restarts restore tested
tools only where a held wall is supported. The scheduler reads only waiting requests, not completed source history.
Lockdown and household profiles cannot build or approve capabilities. Learning stays cheap: successful capabilities
become drafts that the overnight Gardener evaluates; the foreground does not run extra adoption reasoning.

`tests/seasons-budding.test.mjs` exercises the ladder with a stand-in held executor, including failed fixtures,
permission boundaries, connector hot reload, once-only continuation, Windows refusal and owner decisions.
`tests/safety-extras-scripts.test.mjs` exercises the underlying script wall and mediated tool calls.
