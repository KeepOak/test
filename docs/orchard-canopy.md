# Orchard and Canopy

Orchard is Branch's durable task board for several agents. Canopy is one live view of everything working. This page
compares them with the two boards they answer: Hermes Agent's Kanban and OpenClaw's Workboard.

## Using them

Orchard is the task board in **Automations → Orchard**, replacing the old Board. It is available by default, with its
tools loaded when a task needs them. Boards belong to projects. Each card moves through **Seed → Growing → Ripe →
Picked**, or **Blocked**. Ripe means the task finished; only your review moves it to Picked.

Cards you post or assign can be pulled in parallel within the board's limit. Trunks keep their own limits and pause
settings. Every card runs under your existing approval rules. Cards posted by a Trunk, chat app or key wait for your
permission. Lockdown prevents automatic pulls. Drag a card onto a Trunk to assign it, or use the card menu. Add comments
and dependencies in the card detail. Dependencies wait until their parent cards are Picked. Questions appear on the
card and each answer applies only to the exact request displayed. A repeated failure blocks the card until you reset it.

`/orchard` lists the active project's board in chats. `show`, `add` and `comment` work there. Starting, assigning and
reviewing cards requires the owner in the app or terminal. Chat comments are displayed as outside text and are not
inserted into a card's task instructions.

Canopy is the live panel in **Overview**. It shows Trunks, active tasks and their helpers, computers and all boards.
Open a task's conversation, steer its next step, pause, resume or stop it using the task's own controls. Trunk pause
holds new work while the current task finishes. Open a board to see its cards. The owner alone can see this panel.
Canopy only reads and controls existing work; it has no background model calls.

Both features use the existing engine records. The old board migrates once without starting its existing cards.
Completed cards and comments survive a restart. Canopy follows a resumed task's new identity and omits the paused
task it replaced.

## Compared with Hermes and OpenClaw

Sources (read 2026-09-27):
- Hermes Agent: [Kanban](https://hermes-agent.nousresearch.com/docs/user-guide/features/kanban),
  [Kanban tutorial](https://hermes-agent.nousresearch.com/docs/user-guide/features/kanban-tutorial),
  [Worker lanes](https://hermes-agent.nousresearch.com/docs/user-guide/features/kanban-worker-lanes).
- OpenClaw: [Workboard plugin](https://docs.openclaw.ai/plugins/workboard),
  [Workboard CLI](https://docs.openclaw.ai/cli/workboard).

## Orchard: the board

Columns: **Seed** (waiting to be picked up) → **Growing** (being worked on) → **Ripe** (done, waiting for the owner's
review) → **Picked** (accepted), plus **Blocked**.

| Feature | Hermes Kanban | OpenClaw Workboard | Branch Orchard |
|---|---|---|---|
| Storage | SQLite per board (`~/.hermes/kanban/boards/<slug>`) | Plugin-owned SQLite | Branch's own database, kept per household |
| Several boards | Yes, named boards, one database each | Yes, each with a `/workboard/<boardId>` page | Yes, one or more per project |
| Columns | triage, todo, ready, running, blocked, review, done, archived | triage, backlog, todo, scheduled, ready, running, review, blocked, done | Seed, Growing, Ripe, Picked, Blocked |
| Who posts cards | CLI, dashboard, `kanban_create` tool | CLI, Control UI, `workboard_create` tool | The owner (window, `/orchard`), or a Trunk (`orchard.card_add` tool) |
| Who works cards | Dispatcher spawns the assigned profile as a process | Dispatch pass starts up to 3 subagent runs | Trunks and Branch pull Seed cards within limits; every pulled card is an ordinary task |
| Parallel limits | `max_in_progress`, `max_in_progress_per_profile` | 3 starts per pass, one card per agent | Growing cap per board, one card per Trunk at a time, and the Trunk's own "at once" limit |
| Dependencies | Parent→child links; a child waits for its parents | Links; dependency-ready cards are promoted | Links; a card is pulled only once every card it waits on is Picked |
| Comments | Durable thread, shown to the worker | Comments on the card | Thread on the card; a Trunk working the card sees it |
| Review | `kanban_request_review`, `request_changes` | Linked session done → review | A finished task makes the card Ripe; only the owner picks it or sends it back |
| Approvals | Not per card | Not per card | Each card shows its task's waiting questions inline, answered by exact fingerprint |
| Live progress | Worker log, event feed | Worker log, lifecycle state | The card shows its task's live steps (the same steps the chat shows) |
| Assign | `assign <id> <profile>` | `--agent`, reassign tool | Pick a Trunk on the card, or drag the card onto a Trunk's face |
| Circuit breaker | `failure_limit` (2), then blocked | Failed start blocks the card | Failed tries in a row (3 by default), then Blocked until the owner resets it |
| Stop | Kill the worker | Stop button → blocked | Stop on the card or in Canopy |
| Chat commands | `/kanban <verb>` on every gateway | `/workboard` list, create, move, dispatch | `/orchard` in the window, terminal and chat apps. Chats may list, add and comment; starting work and picking are the owner's |
| Unattended work | Runs with the profile's own tools | Runs with the caller's workspace rights | Held to the owner's approval rules and never loosened. A card a Trunk posts waits for the owner's yes before it is pulled. Nothing is pulled while Lockdown is on or while its Trunk is paused |
| Who may reach it | Anyone with the home directory | `operator.read` / `operator.write` scopes | The owner only, through the one caller layer. A household person, a chat message and a short-lived key cannot change it |
| Migration | — | `doctor --fix` for old plugin state | The old Automations › Board cards move into Orchard once, with their lanes mapped |

Not carried over: Hermes' OS-process workers, scratch workspaces and LLM decomposer, and OpenClaw's templates and
per-card model buttons. In Branch a card becomes an ordinary task, so it already has the Trunk's model, computers,
memory and approval rules.

## Canopy: the live overview

OpenClaw's Workboard page shows cards linked to sessions, with an inline lifecycle state and a Stop button. Hermes shows
a Running column grouped by profile. Canopy shows all of Branch in one view.

| Feature | Hermes | OpenClaw | Branch Canopy |
|---|---|---|---|
| Agents | Running column by profile | Card's agent | Every Trunk, with its animated face, which sleeps when idle, and what it is doing |
| Helpers | — | Subagent runs | Every helper a task started, under its parent |
| Computers | — | — | This computer and the owner's paired computers, with what runs on each |
| Boards | Board switcher | Board filter | Every Orchard board with its count per column |
| Running tasks | `watch`, `tail` | Linked session state | Every working, waiting or paused task |
| Controls | Unblock, nudge dispatcher | Stop | Steer, Pause/Resume and Stop per task, and Pause per Trunk. These use the same routes as the chat, so the same rules apply |
