Continuous QA is opt-in in Settings → Branch itself. It reuses the isolated Test
copy runner from SELF-102 (PR #1138), with a selected exact-commit copy and its
prepared dependencies. It never installs an app or replaces the running engine.
No execution happens until the owner enables it. Intervals are 30–1440 minutes,
with a persisted daily cycle limit; shutdown, disabling, App lock and Lockdown
stop or prevent work.

The dogfood mode runs focused contract tests, then a fresh engine with its own
data/workspace inside the same confined container. Prepared Playwright Chromium
follows a fixed five-step General → Appearance → Usage → Branch itself → General
navigation plan, clicking only the Settings sidebar and page-navigation controls.
Each step verifies selected navigation, visible rendered headings and readable
content, and saves bounded DOM/screenshot artifacts. The browser performs
no form writes or setting changes; only explicitly listed read API routes and same-origin
static files are allowed. Non-GET/HEAD requests, fix query parameters, external
addresses, service workers and WebSockets are blocked. No provider is configured
or called during observations. Missing Node 24/dependencies/Chromium is a hold,
not a passing result; nothing downloads or installs them.

A failure immediately writes a fix-contract draft with exact source SHA, scope,
test obligations, evidence and rollback, and pauses QA for human review. With a
separate explicit preset and bounded token opt-in, a tool-free isolated model
call proposes edits to owner-selected existing files already inside the source
contract. The actual edits are written only to the detached copy and recorded
as untested code drafts. No code is executed after that edit, and no branch is
pushed, PR published, approval fabricated or merge sent. The owner must inspect
the draft, authorize a real source contract and validate it before publication.
Without model consent, the draft contains the finding and contract terms only.
Daily token reservations are conservative caps, not measured model billing.

The optional `desktop-copy` target uses an already prepared Linux package at
`release/Branch-Agent-linux-x64/branch-agent` inside the isolated copy, plus
prepared Playwright Electron support and Xvfb in the container. It never launches
the owner's executable. It checks `app.isPackaged`, runtime version/platform,
executable location and the package's existing `dist/build-info.json` commit
against the verified source SHA, and fingerprints executable/app.asar bytes.
Missing artifacts or identity mismatches hold execution. An identity manifest
records what was actually observed; creating the task definition supplies no
runtime proof. Artifacts remain under the Test-copy home, in `dogfood-*` folders.

SELF-210 remains **partial**: the fixed read-only Settings navigation is only a
subset of using an installed app like a person. Native Windows/macOS desktop
targets, arbitrary user workflows, provider access and updates are not covered.
The Linux packaged target is implemented but has not been run or validated.
The changed source has not been compiled, tested or run in this
delivery; authorized tests remain necessary. PR #1138 is an explicit prerequisite
carried unchanged before this change's separate commit.

Native Windows/macOS extension (stacked on #1155): the owner explicitly selects
one to three fixed read-only journeys in Settings. Windows uses Windows Sandbox,
with networking, clipboard, audio/video and printers disabled. Only the exact
copy (read-only) and a new dedicated temp artifact/home directory (writable)
are mapped. Portable Node must be prepared inside qa-runtime; copied package,
runtime and dependencies containing links/junctions are refused. The worker
requires WDAGUtilityAccount and schedules Sandbox shutdown even on a worker crash.
No owner executable or data folder is mapped.

macOS uses sandbox-exec around the worker and every descendant: deny-default,
read access limited to OS libraries, the approved source copy, Node executable
and dedicated temp root; write access limited to that temp root; network limited
to loopback. Missing/deprecated sandbox-exec or unavailable Electron services
holds execution; there is no unrestricted host fallback. Child process groups
are terminated on cancellation/deadline. Windows cleanup targets only the spawned
Sandbox launcher; Sandbox-internal shutdown supplies an independent deadline.

The actual packaged Electron child must report the selected SHA, expected plain
executable, dedicated userData and random worker identity, with a distinct live
PID. Playwright launches that child; it never connects to an existing desktop or
CDP endpoint. Rendered journey assertions and screenshots use that child's first
window. Artifacts contain real observations only after a future authorized run.
Native runs do not reuse container-focused tests: they are UI observation jobs;
contract testing remains a separate Test-copy job before human publication.

SELF210 remains partial: native runners are implemented source, not validated
runtime proof; journeys cover Settings reading only. Arbitrary workflows and
whole-app installed-app acceptance remain outstanding. No app, test, build,
model or provider was executed in this delivery.
