# Common Rules and Patterns

## Two CI lanes

Every pull request runs two workflows.

`Checks / verify-suite` is the whole suite, in under fifteen minutes. `scripts/run-tests.mjs --lane=<system>`
runs each test file once, on the system that can run it: Linux runs every file but the desktop app's; Windows
runs the desktop app's, the Windows helpers, the uninstall and console files and every file with a Windows-only
test; macOS every file with a macOS-only test. Each lane is split into shares by measured time
(`tests/shard-weights.json`). Refresh them from a run's timings:

```sh
node scripts/test-weights.mjs <run-id>
```

`PR Fast Checks / verify-fast` is capped at five minutes. `scripts/select-affected-tests.mjs` reads the exact
base-to-head diff without shell interpolation and chooses one of three outcomes:

- `docs-only`: check whitespace and documentation references.
- `narrow`: build once and run the reviewed, budgeted tests in `tests/test-impact.json`.
- `full-required`: nothing is selected; the change is left to `verify-suite`.

Unknown product paths, stale mappings, renames, deletions, build or workflow changes, and selected
tests above the Linux time budget are all `full-required`. The downloads and the phone apps are built only
for a release tag or by hand (`package.yml`, `mobile.yml`), and release publication still requires the exact
commit's `Checks` success.

The five-minute ceiling starts when GitHub assigns a runner. Shared hosted-runner queue time is not
controlled by repository code and therefore is reported separately rather than promised as part of
the ceiling. An end-to-end five-minute service objective requires a reserved isolated runner. Never
run fork pull-request code on a personal NAS or runner with vault, LAN, or signing-secret access.

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
