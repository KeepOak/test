# Codex provider boundaries (cloud QA, 2026-10-01)

Scope: Codex used as a model through the official app-server or its exec fallback.

- `src/providers/cli-agent.ts`: exec calls name `sandbox_mode="read-only"` and
  `approval_policy="never"` explicitly, matching app-server thread policy.
  Conflicting custom sandbox/approval arguments fail closed before execution
- `src/providers/codex-environment.ts`: passes only configured HTTP(S)/SOCKS proxy,
  no-proxy, CA-bundle/directory, and `CODEX_HOME` variables for Codex. It does not
  forward API keys, endpoint/client-identity overrides, Node injection options,
  or TLS-verification bypasses. Other providers' allowlists are unchanged
- `src/asks/codex-app-server.ts`: direct and primary Codex paths receive that
  transport configuration; warm children are keyed by effective account home
- Explicit account homes take precedence over the configured process home.
  The code selects a path only; it neither reads nor copies credentials nor
  initiates a login. A new profile needs separately authorized official sign-in

Acceptance: `tests/codex-provider-boundaries.test.mjs` checks allowlist/exclusion,
empty NO_PROXY preservation, actual stand-in child environment, account-home
precedence and warm-child separation, truthful Branch client identification,
and explicit read-only/no-approval settings after app-server fallback, on the
exec-only route and during model probes. Custom policy overrides are rejected.
`tests/codex-model-per-call.test.mjs` covers the updated argument contract.

Official references:
- https://learn.chatgpt.com/docs/app-server
- https://learn.chatgpt.com/docs/auth
- https://learn.chatgpt.com/docs/config-file/config-reference

Validation uses mock processes only. CLI help was read with a newly created
empty HOME/CODEX_HOME and no inherited environment. No account, authentication
file, saved session, or live model request was used. Model choices and automatic
model probes are unchanged and must be accounted for before any live QA switch.

Validation results:
- `npm run build`: passed
- Seven focused mock files: 39 passed, one Windows-only skipped, no failures
- Additional `asks-runtimes.test.mjs`: all nine cases passed in a native-terminal
  fixture. The shell sandbox initially blocked network-interface discovery; the
  same unmodified tests passed through the native terminal
- Total targeted coverage: 48 passed, one Windows-only skipped, no failures
- `git diff --check`: passed
- No full repository suite or live-account/inference test was run

Native Windows pre-push validation (2026-10-01): TypeScript --noEmit and npm run build passed. The eight named mock fixture files passed 47 tests with one existing POSIX stand-in skip, 14.942 seconds. Windows process-environment fixtures use nonconflicting case aliases and assert every allowed value plus exclusions; the plain-object fixture still independently covers different uppercase/lowercase values. No real accounts or live inference used.

Returning-review correction: official exec alias e is normalized before policy pinning; unsupported non-exec invocations and conflicting custom overrides refuse before launch. Warm child identity includes effective HOME/USERPROFILE and configured transport, so changed fallback account home, proxy, CA or explicit empty NO_PROXY cannot silently reuse the previous environment. Native validation after normal protected 0cf75d35d4374035a5910d0d97f650c6af71e272 integration: tsc --noEmit/build PASS; same eight mock files 49 PASS, one existing skip, 15.762 seconds. No live Codex request/account or credential read.

Windows direct/full-environment review correction: canonicalize case-insensitive child environment names before both warm identity and spawn. Conflicting aliases refuse before launch rather than selecting an account/transport value; POSIX retains distinct names. Mixed-case Home, codex_home, Http_Proxy, explicit empty no_proxy and equivalent-casing reuse are covered. Native pre-push on protected 4f0b961244721ad53d05e77c9ee86d5e91fb6bb6: tsc --noEmit and build PASS, eight files 50 PASS/one existing skip, 16.396 seconds. No real accounts or live inference.

Final invocation guard also refuses an end-of-options terminator before exec/e, where the apparent subcommand and inserted config could instead be positional text. Both alias forms have no-launch mocks. Final pre-push tsc --noEmit/build passed; the same eight mock files passed 50 tests with one existing skip (13.080 seconds) on protected 4f0 integration.
