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
npm run evals:smoke                 # the 3-task smoke subset, scripted stand-in, no GPU
```

A scorecard (JSON + a short Markdown table with a trend against the previous run) is written to `evals/results/`
(or `--out <dir>`).

## Models — never a paid API

### Scoring your own skills

Pass `--owner-skills <absolute JSON path>` to `evals/run.mjs`, or set `EVAL_OWNER_SKILLS` for the nightly launcher.
The export is explicit; the harness never opens your live data folder. Every case installs the supplied document
into its own fresh evaluation engine, requires a successful `skills.read` for that installed skill, and checks the
completed answer against every `answerContains` phrase (case insensitive). Results appear as `owner-skills` tasks
in the ordinary nightly scorecard, with the document SHA-256 so changed versions can be distinguished. Smoke runs
do not load owner exports. A skill needing scan review is marked `n/a`, never automatically approved.

```json
{
  "version": 1,
  "skills": [{
    "id": "your-skill",
    "document": "---\nname: Your skill\ndescription: Your instructions\n---\nYour skill body here.",
    "cases": [{ "prompt": "A representative request", "answerContains": ["expected result"] }]
  }]
}
```

Keep this file outside source control. Only documents and cases you explicitly select belong in the export;
do not include credentials. Evaluation engines retain ordinary tool approval checks; this does not grant skills
new permissions. Phrase checks measure these cases only, not general skill quality.

- **`ollama`** (default): the best tool-capable model Ollama has on this computer. `ollama:<tag>` names one.
  A sized copy is made first (`num_ctx` from `EVAL_NUM_CTX`, default 8192), which is exactly what Branch's own
  "on this computer" flow does — a raw Ollama connection would fall back to a tiny window and truncate the tool list.
- **`claude-code` / `codex`**: a coding assistant installed here, used through Branch's own subscription connection
  and its own sign-in (`src/providers/cli-agent.ts`). These answer in words and never call Branch's tools by design,
  so they run only the words-only tasks (summarise, refuse, coherence); the rest are marked `n/a`. If the CLI is not
  installed or needs a sign-in that cannot be done non-interactively, its tasks are `needs sign-in` — never a fake pass.
- **`standin`**: a scripted OpenAI-shaped stand-in for the smoke subset only. It proves the plumbing, never a
  model's quality, and its scorecard says so.
- **A model on another machine** (e.g. a bigger GPU on the home network): point `EVAL_OLLAMA_URL` at it. The nightly
  run can then use it with a larger model.

## Statuses

Only **pass** and **fail** enter the pass rate. Kept apart: **timeout** (per-task cap), **needs local model**,
**needs sign-in**, **n/a** (a by-design limit, e.g. a words-only model on a tool task), **harness-error**.

## Nightly

`evals/nightly.mjs` fast-forwards a dedicated clean clone to `origin/redesign/window`, installs (only when the lockfile
moved), builds, runs the harness smoke test and then the full suite, and commits the scorecard into the private
coordination repo at `evals/<date>.md` (+ `.json`). It never runs in CI. `evals/run-nightly.cmd` is what the scheduled
task runs; if the launcher fails before writing anything, `evals/nightly-stub.cjs` writes a "did not run" page instead,
so a silent night is never mistaken for a green one. A night that did not score exits non-zero, so the task's last
result shows it too.

### Installing the nightly run (Windows)

1. A clone used for nothing else (the run checks out and fast-forwards `redesign/window` in it):
   `git clone https://github.com/stabrea/Branch-Agent.git C:\Users\<you>\Code\branch-evals-runner`, then `npm ci` in it.
2. The coordination repo cloned where the run can commit and push without a prompt. The default is
   `C:/Users/bishi/Code/branch-agent-work-coord`; another place goes in `EVAL_COORD_DIR`.
3. Ollama running with a tool-capable model: `ollama pull qwen2.5:7b` (the default). Another goes in `EVAL_MODEL`
   (e.g. `ollama:qwen3:14b`), and a model on another machine in `EVAL_OLLAMA_URL`.
4. The task, daily at 03:30, logging next to the clone (one line):

   ```bat
   schtasks /Create /TN BranchEvalsNightly /SC DAILY /ST 03:30 /F /TR "cmd /c C:\Users\<you>\Code\branch-evals-runner\evals\run-nightly.cmd >> C:\Users\<you>\Code\branch-evals-runner\nightly.log 2>&1"
   ```

   `EVAL_COORD_DIR`, `EVAL_MODEL` and `EVAL_OLLAMA_URL` come from your user environment (`setx EVAL_MODEL ollama:qwen2.5:7b`).
   `run-nightly.cmd` sets `EVAL_RUNNER_DIR` to the clone it sits in.
5. Try it once: `schtasks /Run /TN BranchEvalsNightly`, then read `nightly.log` and the new page in the coordination
   repo. `schtasks /Query /TN BranchEvalsNightly /V /FO LIST` shows the last result: 0 when a scorecard was written.

### A model on another machine

A night can also run the suite on a model whose Ollama listens only on another machine's localhost (a bigger GPU on
the home network). The runner reaches it through an SSH local port forward (`evals/lib/ssh-forward.py`, Python with
`paramiko`), open only while that model's suite runs. Put `nightly.local.json` in the runner clone's root (git ignores
it; `EVAL_NIGHTLY_CONFIG` names another file):

```json
{ "remote": { "sshHost": "<host>", "sshUser": "<user>", "bitwardenItem": "<vault item id>", "localPort": 11436,
              "remotePort": 11434, "model": "ollama:<tag>" } }
```

- The SSH password is read from the Bitwarden vault through the owner's helper (`EVAL_BW_HELPER`) inside the forward's
  own process, into memory only: never printed, logged, put on a command line or in the environment.
- The server's host key is pinned on first contact in `.nightly-known-hosts` (git ignores it) and must match after.
- The forward listens on 127.0.0.1 only, on a port of its own (another tool may hold its own tunnel to the same box);
  a port already in use is refused, not shared. It closes when the nightly run ends, even if the run crashes.
- Nothing is run or changed on the other machine: no sized copy is made there (a remote model is used as it is, so
  name a tag that already has a large enough context window), and the judge stays on this computer (`EVAL_JUDGE_URL`)
  so every model in a night is graded by the same judge.

Each model's results go to its own folder in the coordination repo (`evals/<model>/<date>.md`, with a trend against
its previous night), and `evals/<date>.md` shows the night's models side by side. A model that could not be reached
is a column saying why.

## The harness's smoke test, and CI

No part of the evals runs in a pull request's checks (CI is kept to 15 minutes). `evals/smoke.test.mjs` runs three
tasks (a tool writes a file, a guarded tool waits for and gets an approval, an unsafe demand is refused) against the
stand-in in about 10 seconds. It sits outside `tests/`, so the test runner never picks it up; the nightly run runs it
first and says so when the harness itself is broken. Run it by hand with `node --test evals/smoke.test.mjs`.
