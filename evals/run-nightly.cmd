@echo off
REM The Windows task BranchEvalsNightly runs this file from a dedicated clean clone of the repo (evals/README.md,
REM "Installing the nightly run"). evals\nightly.mjs fast-forwards that clone, builds, runs the harness smoke test and
REM the full suite, and commits the scorecard into the coordination repo; if it fails before writing anything,
REM evals\nightly-stub.cjs writes a "did not run" line, so a silent night is never mistaken for a green one.
REM Everything after the setup is ONE line on purpose: nightly.mjs fast-forwards the clone, which may rewrite this very
REM file, and cmd reads a batch file line by line as it goes. No parenthesised block either: cmd parses such a block
REM whole, and a quoted reason inside one once broke it.
setlocal EnableDelayedExpansion
set EVAL_RUNNER_DIR=%~dp0..
cd /d "%EVAL_RUNNER_DIR%" || exit /b 2
node "%~dp0nightly.mjs" || node "%~dp0nightly-stub.cjs" "the launcher (evals/nightly.mjs) failed before writing a scorecard; see nightly.log in the runner clone" & exit /b !ERRORLEVEL!
