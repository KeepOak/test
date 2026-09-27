import test from "node:test";
import assert from "node:assert/strict";
import { cliExitMetadata } from "../dist/credential-cli.js";

test("CLI metadata keeps timeout, signal and elapsed without copying process error details", () => {
  const failure = { killed: true, signal: "SIGTERM", code: "ETIMEDOUT", message: "secret://windows/private and encoded command" };
  assert.deepEqual(cliExitMetadata(failure, 30042.4, 30000), { timedOut: true, signal: "SIGTERM", elapsedMs: 30042 });
  assert.doesNotMatch(JSON.stringify(cliExitMetadata(failure, 30042.4, 30000)), /private|secret|encoded|command/);
  assert.deepEqual(cliExitMetadata({ killed: true, signal: "SIGTERM", code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }, 30042, 30000),
    { timedOut: false, signal: "SIGTERM", elapsedMs: 30042 });
  assert.deepEqual(cliExitMetadata({ killed: false, signal: "unsafe-token", code: "EACCES" }, -50),
    { timedOut: false, signal: null, elapsedMs: 0 });
  assert.deepEqual(cliExitMetadata(null, 999999), { timedOut: false, signal: null, elapsedMs: 360000 });
});
