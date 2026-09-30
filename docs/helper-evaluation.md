# Helper evaluation

The `helpers` product evaluation suite covers explicit delegation and restraint on a trivial
direct answer. These case categories adapt the actual Gemini CLI subagent evaluation source
(`evals/subagents.eval.ts`, Apache-2.0, commit `38700b4b38bf387dafded6c97c3f190d084b49e9`).
Gemini's Vitest TestRig and unified agent tool do not fit Branch's declarative suites and generic
background helper API; the prompts and engine receipt implementation here are original.

The delegated case requires both the actual helper tool arguments and a completed direct child
with the required answer. The scorer reads engine-authored `run.started` parent provenance and
the stored run status for the same owner. A proposed tool call, another task's child, a running
child or a parent answer that merely claims delegation cannot pass. A receipt keeps the first
2,000 characters of a child's answer and records whether it was cut; a cut answer never passes an
exact answer check, because the part left out may differ. The restraint case counts children in
every status, including failed or unfinished attempts.

The suite is not labelled read-only: starting a helper creates an audited run and spends the
chosen model's budget, even with no tools available to the child. Missing helper tools skip the
delegated case. Model and account availability, tool policy, time limits and helper completion
remain real prerequisites. Use an owner-approved isolated evaluation engine. No evaluation,
model call or verification test was executed for this source change; no pass rate is claimed.

Integration with the routine evaluation attribution change (#1096) retains its callback additions;
this change only adds the separate `readTrajectory` child-receipt projection in that module.
