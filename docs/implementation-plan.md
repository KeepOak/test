# Branch Agent assistant implementation plan

> For agentic workers: use subagent-driven-development for implementation and independent specification and quality reviews. Keep original implementation separate from upstream research evidence.

**Goal:** Build a usable standalone personal assistant, track the requested feature union explicitly, and add a separately evaluated Python research path.

**Architecture:** Branch Agent owns execution, persistence, permissions, memory, procedures, specialists, scheduling, and model accounting. Configured language models supply inference. Optional external tools connect through versioned contracts. No automatic inheritance of upstream internals is claimed.

**Tech stack:** Node.js 24.14.0 or newer, strict TypeScript, SQLite, a small local web interface, and Python 3.12 experiments. Runtime validation is mandatory at external boundaries. Add dependencies only for concrete capabilities; preserve their licenses.

The existing root MIT LICENSE covers Branch Agent-owned code. Required third-party license and notice files must accompany reused components; dependency distribution is not relicensed as solely Branch Agent-owned code.

## Acceptance boundaries

- A working local application and deterministic end-to-end fixture must run without a paid account.
- Real providers must be implemented and fixture-tested; live provider operation is a separate check requiring a configured account.
- Token usage includes every reported call; estimates are labeled. No hard price or efficiency promise without measured evidence.
- Untrusted tool output cannot grant itself new permissions. Subtasks inherit restricted grants and bounded budgets.
- Stateful actions must not silently replay after crashes or retries.
- Public project documentation describes Branch. Research comparisons remain outside the repository. Dependency notices remain with distributed code.
- The feature inventory is a snapshot, not proof of every feature in every current or future repository.
- No AGI, sentience, or biological fidelity claim is an acceptance result.

## Task 1: Standalone application

Files: package.json, tsconfig.json, src/core/, src/storage/, src/providers/, src/tools/, src/server/, src/cli.ts, public/, tests/.

- [x] Write behavioral tests for a multi-step tool task, persisted sessions, permissions, cancellation and budget exhaustion.
- [x] Implement typed messages/tools and runtime validation, SQLite persistence and an audit event log.
- [x] Implement a bounded tool-calling loop with configurable model providers and a deterministic scripted fixture for tests.
- [x] Implement confined workspace file tools, memory retrieval, persisted specialist definitions and restricted delegation.
- [x] Track specialist proposals, evaluation evidence, owner-authorized promotion and rollback; reuse only within granted scope.
- [x] Implement versioned procedures with preconditions, explicit verification and replay; record provenance and distinguish proposals from verified procedures.
- [x] Implement persisted reminders/schedules, restart handling, model usage accounting and context limits.
- [x] Implement CLI and a loopback web application with authenticated mutation endpoints and visible run events.
- [x] Run build and meaningful tests, then specification review, then code quality review; fix findings.

## Task 2: Interoperability and feature coverage

Files: src/integrations/, tests/integrations/, docs/features.json, docs/features.md, docs/configuration.md.

- [x] Research primary documentation of the previously identified assistant projects and group overlapping features.
- [x] Compare designs against Branch Agent's reliability, execution, access, context and maintenance needs; do not claim an unmeasured universal winner.
- [x] Implement and fixture-test MCP tool and browser integrations against the core contracts.
- [ ] Complete messaging integrations against the same contracts.
- [x] Enumerate implemented, partial, external and missing capabilities; include a concrete acceptance test for each family.
- [x] Version the inventory. Each entry needs source/revision/date in the external research registry, a Branch Agent feature ID, acceptance criterion, implementation path, status, verification evidence and remaining task. Public inventory may use feature IDs without competitor comparisons.
- [x] Validate compatibility handling and required dependency notices.

## Task 3: Python experiments

Files: experiments/, tests or Python unittest files, docs/experiments.md.

- [ ] Implement a reproducible baseline-versus-procedure evaluation including learning cost and held-out cases.
- [x] Count all planner, delegate, retry and learning calls; compare held-out success and total tokens per verified successful task. Synthetic measurements must be labeled and cannot establish live provider savings.
- [ ] Identify released fly-brain/body software and data, with exact installation and licensing requirements.
- [x] Select the actual released implementation and record the feasibility gate (download, platform, dependencies, data size and licensing). If it cannot execute, record the precise blocker; a synthetic fixture does not satisfy this deliverable.
- [x] Implement a separate runnable simulation experiment where dependencies are feasible. Label synthetic fixtures and do not present a toy circuit as the released brain.
- [x] Record what was actually run, results, unavailable components and limits.

## Task 4: Release verification

Files: README.md, CONTRIBUTING.md, ROADMAP.md, .github/workflows/, docs/verification.md.

- [x] Document exact install/start/test commands and configuration, including external-service requirements.
- [ ] Verify a fresh build, behavioral regression suite, offline end-to-end run, rendered web interface, experiment output and package contents.
- [x] Perform independent review against requirements, resolve material findings, and retain an explicit gap list.
- [ ] Commit with Conventional Commits and publish a reviewable branch/PR. Do not claim complete feature parity or perfection from passing a finite test suite.

## Desktop and design additions

- [x] Rename the application and GitHub repository to Branch Agent / Branch-Agent.
- [x] Inspect the requested existing website design without modifying it.
- [x] Implement the matching forest/copper/paper interface with local fonts.
- [x] Build and run a native Windows executable with tray, authenticated runtime, persisted settings and shutdown checks.
- [ ] Complete installer, signing, automatic updates and other native platforms.

The complete 169-entry capability union remains in progress. Accounting utilities and a stimulus-response run do not establish learned assistant improvements or AGI.
