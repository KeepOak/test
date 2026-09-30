# Never breaks

The owner's words: *"this agent never breaks, even for updates … even if the gateway is restarted
mid-task the agent picks up where it left off."* OpenClaw breaks when its agent edits its own gateway;
Hermes broke three times. This page is the design that stops Branch doing either, the list of ways it
could break, and the test that proves each one is handled. Brief: `docs/agents/briefs/mac3/NEVER-BREAK.md`.

## The shape

```
            owner's app, phone, browser, chat webhooks
                              │
                    ┌─────────▼──────────┐
                    │  gateway (small)   │  listens on the public port, owns gateway.json and the
                    │  src/never-break/  │  last good copy, starts/restarts the worker, watches the
                    │  gateway.ts        │  first minutes after an update, never opens the database
                    └─────────┬──────────┘
                    loopback  │  IPC (ready / health / stop, contract version)
                    ┌─────────▼──────────┐
                    │  worker = engine   │  the whole assistant: models, tools, chat channels,
                    │  dist/cli.js start │  scheduler, branch.sqlite and journal.sqlite
                    └────────────────────┘
```

**Why the worker holds the database, not the gateway.** `src/store.ts` opens `branch.sqlite` with
`locking_mode=EXCLUSIVE`; a second process gets "already running against this data directory"
(checked on 17 September). The runtime and every tool read and write the store synchronously, in
hundreds of places, so taking model and tool work out of the process that holds the store would be a
rewrite of the engine, not a gateway. Instead the gateway holds **nothing that can be corrupted by
the work**: no database, no model, no tool. It keeps the public port open, so the owner's app and
chat webhooks always reach something that answers; it forwards to the worker on a private loopback
port; and when the worker dies it starts another only after the old one has gone (so the lock is
free). A worker whose gateway disappears notices its IPC channel closing and closes itself, so a
killed gateway never leaves an orphan holding the lock.

Chat connections and the scheduler clock run in the worker, next to the store they write to. What
makes them survive a restart is that their position is written down: the Telegram offset is saved
after each message is handled, and a schedule is claimed in the database before it runs.

### Desktop gateway draft

The desktop candidate starts a windowless stock Electron broker with `--branch-gateway` and a
separate single-instance lock. It retains the encrypted device vault, Stop notices and Mac login
service. Its worker owns the database; its shell windows join the proved public gateway. An absent
desktop preference migrates to ON, while a saved OFF is preserved. Closing a shell leaves the
broker and engine running.

Live adoption uses a private named pipe (a local socket elsewhere), with nonce/HMAC proof in both
directions. Its authority is published atomically under `dataDir/desktop-control/`; that whole
folder, including temporary writes, is protected from model reads and changes. No renderer or
public HTTP route receives that authority. The broker verifies its own staged files again, permits
one adoption at a time, pins its renderer acknowledgment chain, and records an update only after
the page has restored and drawn. Failed pages restore the old engine and window. Proved engine
adoption/rollback refreshes gateway readiness so public requests wait for the serving worker.

Isolated tests cover engine crash replacement, shell close/rejoin, live module/draft/caret retention,
active-task drain/adoption and failed-page rollback. Packaged installation, Windows job escape,
gateway implementation replacement and overlapping shell handoff remain draft acceptance work.

Compatible changes to `src/never-break/gateway.ts` can replace the resident gateway's methods from
a manifest-checked live build. The listener, proof door, held proof connections, tunnels, worker,
waiters and timers stay on the same object. A candidate is prepared before engine transfer and
adopted only after the successor engine proves itself; renderer refusal restores the old methods
before engine rollback. Start-up restores compatible code from the engine's checked live build.
The owner stop wrapper remains resident so closing the gateway still releases its desktop broker.

`gatewayCodeContract` must change whenever resident fields, private brands, callback assumptions
or lifecycle invariants change. A changed contract, method layout or stable stop wrapper is refused
as a live update and requires a packaged restart. Shared gateway dependencies still keep their
main-process classification. This method-replacement path has not received installed continuity
acceptance; compatibility must be reviewed along with every gateway change.
Native capture through a detached broker is refused until the shell's ownership can be proved.

The owner can enable **Keep awake** in Settings. The retained gateway asks Electron to prevent app
suspension while it is desired and running, then releases that request when switched off or closed.
The screen may turn off; lid closure, manual sleep and OS or battery policy can still suspend the
computer. The engine checkpoints saved work on suspend and wakes due schedules and queued
deliveries on resume; chat adapters retry their existing connections. Settings separates the saved
choice from the broker's actual OS request.

Ideas studied (MIT, reimplemented, see `THIRD_PARTY_NOTICES.md`): Hermes' restart-loop breaker
(`gateway/restart_loop_guard.py`: boots chained by gap, auto-resume skipped once tripped), Hermes'
lifecycle ledger (a "running" sentinel left behind means the last exit was unclean), and OpenClaw's
last-known-good config promotion (`src/config/io.observe-recovery.ts`).

## What the switch covers, and what it does not

Every new feature ships behind the three-way switch, off. Two things here are deliberately **not**
switchable, because a switch that could turn them off would itself be the override the brief forbids:

- **The hard deny** on the install folder, the gateway's config, the database files and the updater.
  Like path confinement, it is a security property and never loosens.
- **The journal**, and marking interrupted tasks on start. Writing down what happened costs little
  and is what every other mechanism reads.

The switch, `settings:general` → "Keeps running through crashes and updates", covers the new
*behaviour*: off (as today: `branch start` is the engine alone), when needed (the gateway runs, and
interrupted tasks are offered to the owner to carry on), on (the gateway runs and interrupted tasks
carry on by themselves, asking only where a step may already have reached the outside world). The
canary self-test before an update and the Telegram setup card follow the same switch.

## Threats, mechanisms and the test for each

Results are from the Mac on 17 September (quick chaos set, 3–6 seeds); the Linux long set runs in the final three-system round.

| # | Threat | Mechanism | Test | Result |
| --- | --- | --- | --- | --- |
| 1 | The assistant edits or deletes its own gateway, config, database or updater | `protectedTarget` in `src/never-break/protected.ts`, checked in `Runtime.checkPolicy` beside the role refusal, before any rule, grant, hook, Lockdown or switch. It covers the whole installed program (the `.app` bundle, the folder beside `resources/app`), the data folder, the sign-in service files and the update scratch folder. Commands are read as a shell reads them (quotes, escapes, known variables, `cd`, wildcards), every string of a call that can change something is searched for each protected place, file paths are followed through links and second names (hard links), and a sweeping command that names something only through an unknown variable is refused. Commands that stop, unload or kill Branch's service or process under other spellings (`pkill node`, `kill -1`, `launchctl bootout gui/501`, a label in a variable, the port) are refused | `tests/never-break-deny.test.mjs` | pass: 13 tests, including paths with spaces, links, wildcards and Windows spellings |
| 2 | A bad gateway config (typo, wrong port, junk) | `gateway.json` is validated by schema; the engine settings it may pass on are limited to four that change where things are, never what runs; the assistant can suggest only timings, checked by a dry-run start of a throwaway gateway on an empty folder (no chat bots), and the change waits for the owner; accepting it keeps the owner's switch and engine settings as they are then; `gateway.good.json` is promoted after a healthy start and restored when the current one fails, keeping the owner's switch and never bringing back a removed setting | `tests/never-break-gateway.test.mjs` | pass: settings, proposals, last-good restore with a real crashing worker, 60 rubbish files (`never-break-chaos`) |
| 3 | A crash in the middle of a tool call (worker or gateway killed) | The gateway restarts the worker with back-off and a restart-loop breaker; `journal.sqlite` records every model turn and tool call (idempotency key, side-effect class) before it runs, fsync'd: each call the model asks for is written as an intent before the request is saved to the conversation, and marked started just before it runs; on start interrupted tasks are resumed: finished steps are kept (and the conversation is told they finished when their result was not saved), a call that never got past its intent is done now when the policy allows it without asking (otherwise the conversation says it was not done, so it is asked for again), and nothing after an undecided step runs ahead of it; tasks from before intents keep the earlier handling; an in-flight step is re-run only if it changes nothing or is idempotent (decided by the tool's name and permission, never by the model), a step that may have reached the outside is checked (file checksum) or asked about. Arguments are stored with keys and passwords hidden, and such a step is never re-run from the journal. A chat task that may already have reached the outside is not started afresh when the chat app sends the message again. A journal that cannot be read is put aside and nothing carries on by itself | `tests/never-break-journal.test.mjs`, `tests/never-break-chaos.test.mjs` | pass: kill -9 of the engine and of the gateway at seeded random points, each run finishes or asks, no send twice; real engine killed behind a real gateway comes back |
| 4 | Power loss | `journal.sqlite` uses `synchronous=FULL`; the store's WAL recovery plus `recoverInterruptedRuns`; chat offsets and schedule claims are in the database; missed schedules run once with a note | `tests/never-break-journal.test.mjs` | pass: journal is flushed first; missed Telegram messages fetched once; missed timed turns run once with a note (flush on real power loss not simulated) |
| 5 | An update with data the new (or old) version cannot read | Data format stamp (`PRAGMA user_version` + `branch_format` with the oldest reader); versioned migrations run on a backup first, each with a tested down-path (additive columns need none: the older version ignores them); a version refuses, in a sentence, data newer than it can read instead of damaging it | `tests/never-break-journal.test.mjs` | pass: format stamp, up on a copy, tested way back, newer data refused untouched |
| 6 | An update that does not start | Blue/green: the new version is unpacked beside the old, started as a canary on a copy of the data (migrations applied to the copy) and must pass `branch start` in self-test mode (`BRANCH_SELF_TEST`) before the swap; after the swap the gateway watches the first minutes and rolls back; the last two versions are kept; the gateway/worker contract is versioned both ways | `tests/never-break-update.test.mjs` | pass: canary with the real engine on a copy of real data; failed check stops the update; watch ends or rolls back; contract both ways |
| 7 | Half-written files (config, swap interrupted) | Every file the gateway writes is written to a temporary name, fsync'd and renamed; an update interrupted at any step is repaired on the next start (`repairSwap`: a missing target is put back from the previous copy, a leftover incoming copy is removed) | `tests/never-break-update.test.mjs`, `tests/never-break-chaos.test.mjs` | pass: hand-over script cut after every line leaves a whole version; atomic writes leave no half file |
| 9 | An undo that costs more than the failure did | Every update writes its own record before anything moves (`src/never-break/activation.ts`, `activation.sqlite`, `synchronous=FULL`, protected): fingerprints of the installed version and of the one replacing it (a SHA-256 digest over the sorted tree), each database's format on both sides, which format changes ran, the safety copies, and the newest format the *older* version understood, read from that version while it was still running. `assessRollback` (`src/never-break/rollback.ts`) then **refuses** — with a sentence saying why and what to do instead — when the kept previous version is gone, changed or could not be checked in its budget, when the installed program is not the one this entry activated, when the data is not the shape the entry recorded (`state-moved-since`), or when the data has been migrated to a shape the older version cannot read with no recorded, copied way back (`state-migrated-no-rollback`). Two copies at once cannot both run one (a conditional claim inside `BEGIN IMMEDIATE`). Every step is appended to a ledger before it is attempted and each is tried even if an earlier failed, so a partial undo still reports; `repairRollback` puts an interrupted one back to one whole version, and the gateway's automatic rollback asks the same gate first | `tests/never-break-rollback.test.mjs` | pass: 25 tests, including the gate's own premise — the restored store opened with the older version's migration list and `migrate()` does not throw |
| 8 | A full disk | A journal write that fails stops the task with a plain sentence instead of running a step it could not record; the gateway keeps answering | `tests/never-break-chaos.test.mjs` | pass: full disk after random journal writes never runs an unrecorded step; the next task works |

**Tools run outside a conversation (mac5/manual-actions).** The refusal is not only for the model's
own calls. `Runtime.executeTool` (a tool pressed by hand in the app window, `/api/action`, the code
editor's save, a saved workflow's step, a flow box, a live voice call, the pull-request hook), "Try a
tool", another AI tool over MCP, a saved procedure's steps and a step redone after a restart all go
through `Runtime.checkPolicy`, so this refusal comes first for every one of them. Lockdown's refusals for commands, programs, the screen and the borrowed browser sit right after it in the same place, ahead of any rule or saved switch (mac7/lockdown-fix). The shared gate is
`src/tool-gate.ts`; tests in `tests/manual-actions-gate.test.mjs` and `tests/mcp-server.test.mjs`.

## What the refusal cannot see (honest limits)

The refusal reads text; it does not run the command. These still get past it, and the file
permissions and the owner's rules are the only defence against them:

- a path built at run time from pieces inside another language (`python3 -c "shutil.rmtree(home + '/Library/…')"`,
  where no whole piece names a protected place), encoded or downloaded scripts (`echo … | base64 -d | sh`, `curl … | sh`), and
  programs that delete by themselves (a script file written first, then run);
- Windows 8.3 short names (`PROGRA~1`) that do not exist yet, and a junction created by a program
  the refusal does not recognise; existing ones are followed;
- a hard link made before Branch started to a file that is not one of the database or key files;
- `find . -delete`, `git clean` and wildcards in a workspace that contains the data folder are
  refused, which is stricter than needed; a sweeping `cd ~ && rm -rf …` is read, other ways of
  changing folder (`pushd` in a script file, `Set-Location` through a variable) are not;
- `/gateway/health` answers without a key (only on this computer); it shows process ids, versions
  and the gateway's recent notes.

On the undo side: the gate is only as good as the record. `branch update --yes` and the app's own
Update button both write one; an update applied any other way (a copy unpacked by hand, a package
manager, a record put aside because it could not be read) leaves nothing to undo, and `branch
rollback` says so rather than guessing. The app's record stays `staged` until the next start
confirms which version came up, because the window quits into the hand-over script and never sees
how it went; a start on the older version marks it failed. `branch rollback` itself is macOS and
Linux only — the Windows swap is a mirror run by a batch file, and going back there is the app's
Updates screen, as installing is. The fingerprint is over each
file's path, size and contents, so it does not notice a change only in permissions or in an extended
attribute. Taking recorded format changes back out throws away whatever the newer version wrote in
the new shape; the copy taken before them is kept and named in the message, and the undo refuses
outright when there is no such copy.

On the update side: a power cut in the moment between the two renames of the swap leaves the
program at `<name>.previous`. The gateway's start-up repair puts it back when Branch runs as a
background service; the app window on its own has nothing to run the repair, so the owner has to
rename it back. On Windows an installed copy has a folder per version and switches by one rename of
`current.json` (see docs/configuration.md), so there is no moment without a whole program; only a
portable copy still swaps by copying (`robocopy /MIR`), where a power cut in the middle leaves a
mixed folder that only the previous-version copy can repair. The canary check pauses
the copy's timed jobs and silences webhooks, but a tool a resumed self-test task runs could still
reach the network; the check only resumes its own made-up task, which only lists files.

With the switch off, Branch behaves as before except for what is deliberately not switchable (the
refusal, the journal, the data format stamp) and one extra copy the updater keeps (`.previous-2`).

## Tests

All of them use temporary folders and child processes the test starts itself. None signals, reads or
writes the owner's real install, and none calls `launchctl`, `systemctl` or `schtasks`. The quick
chaos set runs a handful of seeds and belongs in CI; `BRANCH_CHAOS_SEEDS=200` runs the long set on
the Linux test machine through the shared lock.
