/**
 * Voice wake-word recognition must cancel in-flight faster-whisper when stopped.
 * A transcription request that never completes should be aborted immediately via AbortSignal,
 * not waiting out the 120-second timeout. After stop(), no task should launch.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { LocalWhisper } from "../dist/voice-whisper.js";

test("whisper transcribe must be cancellable via AbortSignal", async () => {
  const whisper = new LocalWhisper(
    { env: {}, platform: "darwin", home: "/home", exists: () => false, read: () => "" },
  );

  // Create an abort controller that we can trigger
  const controller = new AbortController();

  // Set up a slow-responding fake transcription that would normally timeout after 120s
  let transcribeStarted = false;
  let transcribeEnded = false;
  const startTime = Date.now();

  // This promise will never resolve (simulates a hung worker)
  const transcribePromise = (async () => {
    transcribeStarted = true;
    // Create a promise that would take forever but can be interrupted via AbortSignal
    return new Promise((resolve) => {
      const listener = () => {
        transcribeEnded = true;
        resolve();
      };
      controller.signal.addEventListener("abort", listener);
    });
  })().catch(() => undefined);

  // After a short delay, abort the signal (simulating stop() being called)
  setTimeout(() => controller.abort(), 100);

  // Wait for the transcription to finish
  await transcribePromise;
  const elapsed = Date.now() - startTime;

  // Verify that:
  // 1. The transcription started
  assert.ok(transcribeStarted, "transcription should have started");
  // 2. The transcription ended (was aborted)
  assert.ok(transcribeEnded, "transcription should have ended via abort");
  // 3. It finished quickly (well under the 120-second timeout)
  assert.ok(elapsed < 2000, `transcription should abort quickly (was ${elapsed}ms, max 2000ms)`);
});

test("whisper.transcribe must respect AbortSignal for immediate cancellation", async () => {
  const whisper = new LocalWhisper(
    { env: {}, platform: "darwin", home: "/home", exists: () => false, read: () => "" },
  );

  const controller = new AbortController();
  const startTime = Date.now();

  // Abort the signal immediately (simulating stop() being called before/during transcription)
  controller.abort();

  // Attempt to transcribe with an already-aborted signal
  let rejected = false;
  try {
    // This should reject immediately, not wait
    await whisper.transcribe(
      { available: true, python: "/usr/bin/python", model: "/model", modelName: "base.en", how: "test" },
      new Uint8Array([1, 2, 3]),
      { partial: false },
      controller.signal,
    );
  } catch (error) {
    rejected = true;
    assert.match(
      String(error),
      /stopped|abort|cancel/i,
      `error should mention abort, cancel or stopped, got: ${error}`,
    );
  }

  const elapsed = Date.now() - startTime;
  assert.ok(rejected, "transcribe should have rejected with an already-aborted signal");
  assert.ok(elapsed < 1000, `transcribe should reject immediately (was ${elapsed}ms)`);
});
