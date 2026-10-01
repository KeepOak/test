# Common Rules and Patterns

## One CI workflow

Every pull request runs one workflow, `Checks`, and one required check, `Checks / verify-suite`.
`scripts/run-tests.mjs --lane=<system>` runs each test file once, on the system that can run it: Linux runs every
file but the desktop app's; Windows runs the desktop app's, the Windows helpers, the uninstall and console files and
every file with a Windows-only test; macOS every file with a macOS-only test. Each lane is split into shares by
measured time (`tests/shard-weights.json`). Refresh them from a run's timings:

```sh
node scripts/test-weights.mjs <run-id>
```

The `plan` job (`scripts/select-affected-tests.mjs`) decides what a run tests. Every push, the nightly run, a run by
hand and a pull request into anything but `redesign/window` run the whole suite on every system. A pull request into
`redesign/window` runs what its change can reach, from the merge ref's own diff:

- `docs`: documentation only. Whitespace and documentation references are checked; no test file runs.
- `partial`: tests, test helpers and `public/` only. The changed tests, the tests that use a changed helper or page
  file (`scripts/test-graph.mjs`: imports, quoted file names, folders listed), every browser test when `public/`
  changed, the reviewed mappings in `tests/test-impact.json`, and `always`. The Linux shares split that selection;
  verify-suite and the plan's summary say `PARTIAL`.
- `full`: anything in `src/`, the build, the workflows, a rename or delete, a file nothing names, or a selection
  above `partialCeiling` of the Linux lane's time. A static import graph cannot narrow a `src/` change: most test
  files import `dist/index.js`, which imports nearly all of `src/`.

A pull request into `redesign/window` is then made light, because the merge queue runs the whole suite on every
system before anything lands: at most `prLinuxShards` (4) Linux shares, filled with `always`, the changed tests, what
the change reaches by name, mapping or graph, the tests near a `src/` change (`nearTests`: the tests that use a
changed file or a `src/` file that uses it, never through a hub file that more than `hubTests` tests import), then
every browser test for a page change, lightest first within each group, while the predicted time fits `prLinuxShards` of
the whole suite's eight Linux shares (now four). What does not fit is named in the summary as left for the merge queue. `npm run build` in each
share is the type-check, and every pull request that is not documentation only plans at least one share.

Windows and macOS run on a pull request only when it touches their own code (`platforms` in
`tests/test-impact.json`, Windows computer control included), a `src/` file their own tests import directly that at
most `platformSourceTests` (5) tests import, their own test files, or a test helper those tests use. Local voice runs
on a pull request only when the change reaches `tests/voice-local-whisper.test.mjs`. verify-suite is
red unless the plan ran and every planned share passed, and on a push it also requires the whole suite, so promote
moves `mac/cross-platform` only to a commit the whole suite passed. A push to `redesign/window` lands the commit a
merge-queue group already tested with the whole suite, so it reuses that green run (`scripts/ci-reuse.mjs`: the same
commit, or a commit with the same tree) instead of running the suite a second time; verify-suite names the run it
reused, and the push run still ends green, so promote and the Beta updater (`newestGreen` in
`src/desktop/dev-build.ts`) find the same commit. Without such a run the whole suite runs. The downloads and the phone apps are built only
for a release tag or by hand (`package.yml`, `mobile.yml`), and release publication still requires the exact
commit's `Checks` success.

At most `prSlots` (3) pull-request runs (`tests/test-impact.json`) hold runners at once, oldest first
(`scripts/ci-queue.mjs`). Every unfinished pull-request run holds a slot: an admitted run whose shares all wait for
runners reports `queued`, not `in_progress`, and counting only `in_progress` runs let about 29 runs in at once on
2026-09-29. A run asking for a slot counts only the unfinished runs that started before it, so runs that plan at the
same moment agree, and the oldest is always admitted. A run that must wait says "Waiting for a CI slot, position k of m" in its `plan` job,
labels its pull request `ci-waiting` and cancels itself: it is waiting, not red. Every run that finishes, a push to
`redesign/window` included, starts the oldest waiting pull request again. A pull request whose newest run for its
head was cancelled (held, or parked by hand) is waiting too; drafts and pull requests labelled `hold` are skipped.
Pushes are never held. Only a rerun the queue itself started goes straight to its slot; a rerun started by a person
(the Rerun button, or rerunning failed jobs) waits in line like any run. Label a pull request `ci-priority` to put
it at the front of the line. Do not rerun a cancelled run by hand: the queue does it.

How 3 slots and 4 shares were sized (2026-10-01): this is modeled admitted work against a cap of 180 concurrent jobs.
That 180 is the owner's reading of the organization's enterprise settings page; it was not measured by us, and our
token cannot read that setting. The model counts every admitted pull request at the full matrix, whatever its plan: a
pull request labelled `ci-full` or into a base other than `redesign/window` runs all 8 Linux shares, because
`prLinuxShards` caps only a light plan. A full pull-request run is about 14 Checks jobs (plan, local voice, 8 Linux,
2 Windows, 1 macOS, verify-suite), and CodeQL default setup adds 6 more for the same pull request, one of them a macOS
Swift job: about 20 jobs, 2 of them macOS. A merge-queue group is the same 14 Checks jobs (with the stale-group check in
place of plan) and the same 6 CodeQL jobs, and the merge queue builds at most 5 groups at once (`max_entries_to_build`
in the ruleset). So 3 pull-request runs × 20 = 60 jobs (6 macOS) plus 5 groups × 20 = 100 (10 macOS) is about 160
admitted jobs. That is close to the cap with no reserve: CodeQL for pull requests still waiting for a slot, pushes, the
nightly run and unrelated workflows are not counted and can push the total over 180, in which case the jobs past the
limit wait in GitHub's queue rather than fail. Revisit these numbers when the owner confirms a higher limit.

Shared hosted-runner queue time is not controlled by repository code. Never run fork pull-request code on a personal
NAS or runner with vault, LAN, or signing-secret access.

## Testing Patterns

### Avoiding Silent Dependencies on Machine Speed

Tests should never depend on wall-clock timing without deliberate control. A test that relies on elapsed time between tool calls can pass on a fast machine and fail intermittently on CI because the machine is slower.

**The problem:** If a test measures elapsed time (e.g., checking that a tool call completed within a rate-limit window), on fast machines the calls happen close enough together; on slow CI machines, the elapsed time exceeds expectations and the test fails.

**Example:** A rate-limit test that sets a 1000ms window and checks that two tool calls are rate-limited. On a developer's machine, both calls land within the window and the test passes. On slow CI, more than 1000ms elapses between the calls, the first call ages out of the window, and the test fails incorrectly.

**The fix:** Use constructor-injected clock functions instead of wall-clock time. Pass a controlled clock to the component being tested so that time can be deterministic:

```typescript
// BAD: wall-clock timing, machine speed dependent
test("rate limit", async (t) => {
  const { app } = await served(t, steps, { /* no clock */ });
  const origComplete = provider.complete.bind(provider);
  let callNumber = 0;
  provider.complete = async (request) => {
    const result = await origComplete(request);
    if (result.toolCalls?.length) callNumber++;
    return result;
  };
  // Between origComplete calls, time passes. On slow CI, > 1000ms elapses.
  // Test fails if the window ages out between calls.
});

// GOOD: constructor-injected clock, deterministic
test("rate limit", async (t) => {
  let callNumber = 0;
  const baseTime = 10000;
  const testClock = () => baseTime + (callNumber * 500);
  
  const { app } = await served(t, steps, { 
    reliability: { rateWindowMs: 1000 },
    clock: testClock,  // Inject the clock
  });
  
  const origComplete = provider.complete.bind(provider);
  provider.complete = async (request) => {
    const result = await origComplete(request);
    if (result.toolCalls?.length) callNumber++;  // Increments the clock
    return result;
  };
  // Clock is controlled; first call at T=10000, second at T=10500.
  // Both are within the 1000ms window. Test passes consistently.
});
```

**Pattern:** Components that use `Date.now()` should accept an optional clock function parameter in their constructor (defaulting to `Date.now`). Tests can pass a controlled clock; production uses the real clock. Never use mutable fields (like `testNow`) as escape hatches; they silently break rate limiting if set and not cleared.

### Rationale

Rate limiting, timeouts, and other time-dependent behavior must work correctly on slow machines. A test that passes only on fast machines is a test that does not verify the behavior. Constructor injection of clock functions provides determinism without mutable escape hatches that can be forgotten or accidentally left set.
