Continuous QA is opt-in in Settings → Branch itself. It reuses the isolated Test
copy runner from SELF-102 (PR #1138), with a selected exact-commit copy and its
prepared dependencies. It never installs an app or replaces the running engine.
No execution happens until the owner enables it. Intervals are 30–1440 minutes,
with a persisted daily cycle limit; shutdown, disabling, App lock and Lockdown
stop or prevent work.

The dogfood mode runs focused contract tests, then a fresh engine with its own
data/workspace inside the same confined container. Prepared Playwright Chromium
observes General, Branch itself and Usage Settings pages, verifies each selected
page rendered readable content, and records page errors. The browser performs
no clicks or form writes; only explicitly listed read API routes and same-origin
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

This is continuous isolated web-app observation, not native installed desktop
control. It does not prove native windows, provider access, updates, or arbitrary
user workflows. The changed source has not been compiled, tested or run in this
delivery; authorized tests remain necessary. PR #1138 is an explicit prerequisite
carried unchanged before this change's separate commit.
