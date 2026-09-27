# Branch Agent: capability logic

**Date:** 2026-09-26.

**Inputs:**
- `AI-Agents-Landscape.md` (14 products plus two open-source groups);
- `Behaviour-Workbooks.zip` (10 product workbooks; full chapters for the Hermes Telegram connector, OpenClaw teammates and JEV);
- `RESULTS.md` (the JEV blind-rebuild experiment);
- Branch's own code at `redesign/window` 7d384019.

**Working files, all in `research/`:**
- `CAT-landscape-1.md` (264 rows), `CAT-landscape-2.md` (188), `CAT-workbooks.md` (279), `CAT-branch.md` (313);
- `GAP-MATRIX.md`: 486 distinct external capabilities, each matched to Branch with evidence.

Facts are cited in those files. What follows is the logic and my recommendations.

---

## 1. The verdict in one table

| Branch status against 486 external capabilities | count | share |
|---|---|---|
| **Live** in the new window | 114 | 23% |
| **Engine only**: Branch can do it, the window doesn't reach it | 144 | 30% |
| **Partial**: a narrower version exists | 137 | 28% |
| **Designed, not built** | 9 | 2% |
| **Missing** | 82 (73 features + 9 business-model rows) | 17% |

- **Branch has something for 83% of what the whole field does.** None of the 73 missing features appears in more than three products; 63 appear in only one.
- **The biggest gap is reach, not capability.** 144 things already work in the engine, but a person can't reach them from the window. Surfacing those is worth more than any new feature.
- **Branch has many things nobody else has** (GAP-MATRIX §5). Examples:
  - adapt-a-stopped-task;
  - account pools with rotation;
  - a one-button local model sized to the machine;
  - a model arena;
  - byte-identical document edits;
  - SQL over spreadsheets;
  - a hash-chain activity log;
  - the never-break gateway;
  - household profiles;
  - 55 chat apps.

  These belong at the front of the product, not buried.

---

## 2. The logic every capability follows

Every feature, existing or new, is one **capability**, described the same way. This is the contract a builder follows and the reviewer checks.

### 2.1 The objects everything hangs off

| Object | What it is | Already in Branch |
|---|---|---|
| **Owner and household** | Who is using Branch, and what each person may do | profiles, roles, PINs (`src/profiles.ts`) |
| **Trunk** | A named agent with a look, instructions, tools, computers and a way of working | `src/trunks/*` |
| **Conversation / room** | Where a person and one Trunk (or several, in a room) talk | sessions, rooms |
| **Task** (run) | One piece of work, with steps, plan, approvals, cost, recording | runtime, runs |
| **Tool** | Something a task can do: built-in, MCP server, skill, plugin, CLI | registry, MCP, skills, plugins |
| **Computer** | Where a task's actions happen: this PC, a sandbox, another Branch, a cloud box, a phone | devices, sandboxes, reach |
| **Channel** | Where Branch is reached: window, phone, terminal, 55 chat apps, API | channels, surfaces |
| **Automation** | Work that starts by itself: schedule, trigger, procedure, check-in, standing order | scheduler, autonomy |
| **Memory and knowledge** | What Branch remembers and can look up | memory, documents, knowledge |
| **Policy** | What needs a yes, what's refused, Lockdown | approvals, rules, conversation modes |

A new capability always attaches to one of these objects. If it can't be said which one, it isn't designed yet.

### 2.2 The seven fields of a capability

For each capability, write down:
1. **Object:** which of the objects above it belongs to.
2. **Surfaces:** window place or settings page (the prototype decides where), terminal command, chat command, API route.
3. **Gate:** which approval category it passes through (read / browse / send / change / spend / run), plus its feature switch.
4. **Default:** apply the owner's rule. **Ships ON**, unless it means outside access, extra spend, data leaving the computer, or weaker safety. Those ship OFF and are offered at the moment they're useful.
5. **State and audit:** what it stores, what lands in the activity log, and how it's undone (checkpoint, roll back, rewind).
6. **Failure words:** the exact sentence the owner sees when it can't run, taken from the engine and never invented.
7. **Proof:** a conformance check (see §6) plus a verify script that exercises it through the engine's own routes.

### 2.3 The laws (non-negotiable, already how Branch works)
1. **Real or greyed, never fake.** Something is drawn live only when the engine does it.
2. **Every action goes through the policy gate.** Nothing bypasses approvals. Loosening is the owner's own act, in the owner's window, and is logged.
3. **Everything from outside is untrusted:** pages, documents, chat messages, tool output. It's wrapped as information, never taken as instructions (`src/content-guard.ts`).
4. **The model never sees a secret value.** It gets locker, vault-autofill or scoped injection instead.
5. **Everything is visible and undoable:** activity log, checkpoints, roll back.
6. **Local-first.** Nothing leaves the computer unless the owner turns it on.
7. **No AI attribution** in anything Branch writes on the owner's behalf. The owner's rule. It also means "git co-author trailers" from Codex and OpenClaw stay OFF unless the owner names one.

---

## 3. Tier 1: surface what the engine already does (144 capabilities)

This is the highest-value work, because it's all "window reach". GAP-MATRIX §4 lists every item with its natural home. The main groups:

| Home in the window | What to surface (examples) |
|---|---|
| **Conversation** (message box, side pane) | steer a running task; sub-agents and their approvals in Activity; live status |
| **Inbox** | deferred and handed-over work, adapt a stopped task |
| **Automations** | standing orders, loops, procedure proposals, trigger kinds |
| **Library** | knowledge graph, document analysis and compare, SQL over spreadsheets with charts |
| **Customize** | specialists (styles, evaluation, promotion, rollback), plugins, MCP both ways, registry |
| **Settings › Models** | model arena, compare models, mixtures and savings, second model, media models |
| **Settings › Computer** | sandboxes, network reach, other computers, browser container |
| **Settings › Permissions** | rule tester, firewall explained in sentences, "why is this set?", loop guards, trusted folders |
| **Settings › Data** | retention, backup, bringing things in (move-in from 5 other agents), whole-agent export |
| **Settings › Advanced** | health, diagnostics, tracing, evaluation, developer tools |
| **Feature switches** | about 40 capabilities are model tools that only need their switch in the window |

**Logic:** each item gets the prototype's own slot if one exists; the `oneone.cjs` fill round did most of these slots. Where the prototype has no slot, the item goes at the Advanced or Technical level of the matching Settings page, never on the chat screen (the owner's density rule).

---

## 4. Tier 2: engine features the design already wants

These are the greyed controls whose engine side is missing. Each is small or medium, and the window is already drawn.

| Feature | Logic |
|---|---|
| **Pause a Trunk / pause all** | A `paused` state on the Trunk. The scheduler, triggers and chat routing skip a paused Trunk. Running tasks finish, or stop on "pause now". Logged. |
| **Connector catalogue plus "add your own server"** | Persist MCP servers through a route, with the existing preflight, malware check and fingerprint. The catalogue is curated data. Adding one that starts a program asks first. |
| **Words → schedule** | The model proposes a structured schedule (`dailyAt`/`cron`) from the sentence, and the owner confirms it ("Branch will confirm the schedule before it first runs"). It never saves unconfirmed. |
| **Edit procedure steps** | A step change is a new proposal the owner approves, same id, history kept (task already queued). |
| **Room answering rule** | Room setting: "lead Trunk decides" / "everyone every time" / "mentions only" (today's). |
| **Default multi-agent pattern** | An owner default (one at a time / lead and helpers / swarm / router / in parallel). The model can still suggest another, but the default wins unless the owner agrees. |
| **Computers per Trunk** | Allow-list of computers per Trunk, an "at once" limit, and a pick per conversation. Pairing stays security-reviewed. |
| **Release notes / What's new** | The engine serves notes for the installed version, from the release file. |
| **Flag one reply** | Per-reply report with a reason and note, kept locally. It's exported only if the owner sends it. |
| **Voice without a cloud model** | A bundled local speech-to-text (whisper.cpp) and system TTS voices. Live voice still needs a provider. |
| **Per-Trunk instruction files** | Each Trunk gets its own copy of the instruction files, falling back to the shared set. |
| **Memory purge-all, undo gateway change, diff before a self-change** | Each is a route over data the engine already keeps. |

---

## 5. Tier 3: new capabilities worth adding (from the landscape)

My picks are the ones that fit Branch's shape and that people clearly want. Each notes which object it extends.

| Capability (who has it) | Why | Logic in Branch |
|---|---|---|
| **Always-on cloud computer per Trunk** (Grok Bot) | The headline trend of 2026: agents that keep working while the PC sleeps | A Computer of kind "cloud", through the existing sandbox backends and remote workspaces. Ships OFF (outside access and spend). Credentials go through the locker, never raw. |
| **Replayable timeline of every model call, tool and approval** (Muse Code) | Trust, debugging, audit | Branch already has the hash-chain activity log, run recordings and inspect. Unify them into one per-task Timeline with Step and Replay. The watch-again player (#312) is the start. |
| **Branch a conversation / parallel paths** (Manus, Pi) | Try two approaches from one point | "Branch from here" on any message, from the existing rewind plus duplicate. Each branch is its own conversation, linked in the side pane. |
| **Hide from the model without deleting** (Pi context edits) | Clean context without losing history | Pins already exist. Add a "leave out of context" mark per message: kept, shown faded, never sent. |
| **Sub-agent approvals and thinking in the parent** (T3 Code) | Multi-agent without losing oversight | Delegation surfaces its children's approvals in the parent's Activity tab; each still names its exact request. |
| **Teach a task by showing it** (Grok Bot) | Learning from the user | `teach` shipped in #314. Next: turn a taught run into a procedure proposal. |
| **Secret-blind sign-in and payment** (Hermes) | Real errands safely | Branch has vault-autofill. Surface it, with the prompt indicators Hermes has. Payment stays behind an explicit yes, every time. |
| **Small decision models** (OpenClaw, JEV) | Cheap, fast yes/no/pick/score | `jev-decisions` exists. Add `filter` and multi-question `run`, and use it for routing and triage. |
| **Phone calls and meeting bots** (Instinct, OpenClaw) | Voice as a surface | Later. Build on live voice and Twilio, behind a consent flow. Ships OFF. |
| **Quick entry: a global ask shortcut** (Hermes) | Speed | Electron `globalShortcut` opens a small ask box, into a new conversation. |
| **Mermaid diagrams in answers** (3 products) | Common, small | Render fenced mermaid in the chat and artifacts, sandboxed. |
| **Chat-app polish** (Hermes workbook) | Reliability in the chat apps | The agent sees a message's latest edit, photo albums batch, a polling-stall watchdog, a prompt when a bot token is revoked, per-app formatting, and online/offline status. |
| **Unread state** (Buzz) | Inbox hygiene | Unread on conversations and inbox items. |
| **Behaviour workbooks as a skill** (the workbook method, §6) | Novel. No product has it. | "Learn this app/workflow, write its spec, prove it": Branch reads a tool or site, writes a MUST checklist, derives checks, and runs them against the real thing. |

### What I'd skip (and why)
- **Enterprise Postgres/Helm, per-profile gateways, pluggable storage, a composition runtime:** they fight Branch's local-first, single-engine design.
- **A 3D office, the DOOM extension:** novelty.
- **Metered credits, a hosted free tier, data-sharing discounts:** business models, not features. The data-sharing tier contradicts local-first.
- **Git co-author attribution:** conflicts with the owner's no-attribution rule. It's only possible as an owner-named trailer, default OFF.

---

## 6. Borrowing the workbook method (RESULTS.md) for Branch itself

**What the experiment proved:**
- One agent reading a big spec and building it all in one go is unreliable (22% → 34% → 51% → 30%).
- The largest failure class was the builder skipping behaviour the spec already stated.
- The fix was a split method:
  1. one consolidated MUST checklist;
  2. blind test-writers turn it into a conformance suite;
  3. a builder iterates against the failing MUST ids;
  4. **run the conformance suite against the original product**, which exposed 51 spec defects that spec-derived tests can't see.
- A passing check isn't proof. The Telegram chapter passed 33/33 citation checks yet missed the whole vault feature.

**How it maps onto what we already do:**

| Workbook step | Branch redesign today | Gap to close |
|---|---|---|
| MUST checklist | FEATURE-AUDIT (453 actions) and the design doc | Give each capability a numbered MUST list (§2.2) |
| Conformance suite | per-area `verify-*.cjs` and the gate tests | Keep; every PR ships one (already enforced) |
| Builder loop on failing ids | review → send back with exact lines | Keep |
| **Validate the suite against the source of truth** | `oneone.cjs` (window vs prototype) | Extend it: run the verify scripts' expectations against the *prototype* too, so a check that encodes a spec mistake fails there |
| Mechanical data beats hand-written | the check-fakes rule "toast words must be in the prototype" | Generate more checks from the prototype mechanically (strings, levels, which controls exist) |

---

## 7. Pain points to design against (from GAP-MATRIX §6)

Where Branch has **no or partial** safeguard, add one:

| Risk seen elsewhere | Fix |
|---|---|
| Interrupt not absolute (Hermes) | A test that Stop, emergency stop and Lockdown halt every path, including follow-ups and notifications |
| Signal-killed commands reported as success (Pi) | Verify that the shell reports signals as failure; add a test |
| Thinking dropped on model switch (Claude Code) | Tell the owner in the conversation when a switch drops reasoning (Branch never sends thinking back, by design) |
| Chat message edits ignored; a bot token revoked silently (Hermes) | Handle `edited_message`; a revoked-token prompt in Inbox |
| "Multi-user is not a boundary between adversaries" (OpenClaw) | Say it plainly in the household invite flow and the docs |
| No advisory process; unsigned Windows builds flagged by antivirus | `SECURITY.md`, an advisory process, code signing |
| Sandboxing opt-in everywhere, including Branch | Offer the sandbox at the moment a task runs unknown code; consider default-on for untrusted repos |
| Polling stalls in chat apps | A watchdog on every polling channel, reported in Settings › Gateway |

---

## 8. Recommended order

1. **Finish the redesign gates (now):** the bug-fix round, the test ports green, 1:1 at 85.6% of controls (the rest is example data), then #290 ready for review.
2. **Tier 1, surface the engine:** 2–3 area rounds using GAP-MATRIX §4 as the list; the window's slots mostly exist.
3. **Tier 2, the design's own engine gaps:** pause Trunk, connector catalogue, words→schedule, procedure edits, room rule, default pattern, computers per Trunk, release notes. Each greyed control goes live as its feature lands.
4. **The security-held list:** the owner decides which of the ~37 held controls go live; each gets a design and the two-review gate.
5. **Tier 3, new capabilities:** timeline, conversation branching, hide-from-model, sub-agent oversight, quick entry, Mermaid and chat-app polish first; cloud computers, calls and meetings after.
6. **Method:** every capability is written up as §2.2 plus a MUST list, and its checks are validated against the prototype.
