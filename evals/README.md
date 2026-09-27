# Branch evals — does it do real work well?

These evals measure whether Branch actually does real work well, not just whether buttons render. Every task runs
end to end through a **real engine** (its own temp data dir, its own port, started exactly the way a person starts
it) with a **real model**, and is scored on **real outcomes**: files on disk, diffs, the engine's own GET routes,
and `node --test` exit codes. An LLM judge is used only where no machine check can see the thing being tested, and
its rubric is in [`judge-rubric.md`](judge-rubric.md).

## Running it

```sh
npm run evals                       # the full suite on the best local model
node evals/run.mjs --model ollama:qwen2.5:3b
node evals/run.mjs --only edit-file,mem-forget
npm run evals:smoke                 # the 3-task CI subset, scripted stand-in, no GPU
```

A scorecard (JSON + a short Markdown table with a trend against the previous run) is written to `evals/results/`
(or `--out <dir>`).

## Models — never a paid API

- **`ollama`** (default): the best tool-capable model Ollama has on this computer. `ollama:<tag>` names one.
  A sized copy is made first (`num_ctx` from `EVAL_NUM_CTX`, default 8192), which is exactly what Branch's own
  "on this computer" flow does — a raw Ollama connection would fall back to a tiny window and truncate the tool list.
- **`claude-code` / `codex`**: a coding assistant installed here, used through Branch's own subscription connection
  and its own sign-in (`src/providers/cli-agent.ts`). These answer in words and never call Branch's tools by design,
  so they run only the words-only tasks (summarise, refuse, coherence); the rest are marked `n/a`. If the CLI is not
  installed or needs a sign-in that cannot be done non-interactively, its tasks are `needs sign-in` — never a fake pass.
- **`standin`**: a scripted OpenAI-shaped stand-in for the CI smoke subset only. It proves the plumbing, never a
  model's quality, and its scorecard says so.
- **A model on another machine** (e.g. a bigger GPU on the home network): point `EVAL_OLLAMA_URL` at it. The nightly
  run can then use it with a larger model.

## Statuses

Only **pass** and **fail** enter the pass rate. Kept apart: **timeout** (per-task cap), **needs local model**,
**needs sign-in**, **n/a** (a by-design limit, e.g. a words-only model on a tool task), **harness-error**.

## Nightly

`evals/nightly.mjs` fast-forwards a dedicated clean clone (`C:/Users/bishi/Code/branch-evals-runner`) to
`origin/redesign/window`, builds, runs the full suite, and commits the scorecard into the private coordination repo
at `branch-agent-work-coord/evals/<date>.md` (+ `.json`). It never runs in CI. The Windows task **BranchEvalsNightly**
(03:30 daily) runs `run-nightly.cmd` in the clone, which fast-forwards and then runs `nightly.mjs`; if the suite is
not yet on `redesign/window` (before this PR merges) it still writes a clear line, so a silent night is never mistaken
for a green one.

## What the CI smoke subset is

`tests/evals-smoke.test.mjs` runs three tasks (a tool writes a file, a guarded tool waits for and gets an approval,
an unsafe demand is refused) against the stand-in, one engine shared, in well under 30 seconds. That is the only part
of the evals that runs in CI.
