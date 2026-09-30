/* SCREEN-022: a plan step's browser frame, seen while the owner watched that step, can be shown again ("Back to live"
   returns). Frames are kept briefly in memory only, for the newest task and its exact plan, and not at all with task
   recordings switched off. An in-memory store and made-up frames; no browser runs. */
import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../dist/store.js";
import { rememberReplay, readReplay, sameReplayStep } from "../dist/live-stage-replay.js";
import { saveRecordingSettings } from "../dist/run-recording.js";

const RUN = "11111111-1111-4111-8111-111111111111", PLAN_AT = "2026-09-30T10:00:00.000Z";
const plan = (working, extra = {}) => ({ runId: RUN, createdAt: PLAN_AT, ...extra,
  steps: ["Open the site", "Find the form", "Fill it in"].map((title, i) => ({ title, status: i < working ? "done" : i === working ? "working" : "pending" })) });
const frame = (text, at = new Date().toISOString()) => ({ runId: RUN, url: "https://example.com", title: "Example", tabs: [], frame: Buffer.from(text), preview: "ready", live: true, at });

test("SCREEN-022: a frame seen during a working step is kept for that step and can be asked for again", () => {
  const store = new Store(":memory:");
  const step = sameReplayStep(plan(1), plan(1));
  assert.equal(step, 1);
  rememberReplay(store, "local", "k", plan(1), step, frame("form page"));
  const listed = readReplay(store, "local", "k", RUN, plan(1));
  assert.deepEqual(listed.replaySteps.map((one) => one.step), [1]);
  const again = readReplay(store, "local", "k", RUN, plan(1), { step: "1", runId: RUN, planAt: PLAN_AT });
  assert.equal(again.replay.frame.toString(), "form page");
  assert.equal(again.replay.live, false, "a replay is never shown as live");
  assert.equal(readReplay(store, "local", "k", RUN, plan(1), { step: "0", runId: RUN, planAt: PLAN_AT }).replay, null);
});

test("SCREEN-022: a step that changed while its frame was taken, another plan, or a newer task keeps nothing to replay", () => {
  const store = new Store(":memory:");
  assert.equal(sameReplayStep(plan(1), plan(2)), null, "the step moved on during the capture");
  rememberReplay(store, "local", "k", plan(1), 1, frame("form page"));
  assert.deepEqual(readReplay(store, "local", "k", RUN, plan(1, { createdAt: "2026-09-30T11:00:00.000Z" })).replaySteps, []);
  assert.deepEqual(readReplay(store, "local", "k", "22222222-2222-4222-8222-222222222222", plan(1)).replaySteps, []);
});

test("SCREEN-022: with task recordings off nothing is kept, and what was kept is dropped", () => {
  const store = new Store(":memory:");
  rememberReplay(store, "local", "k", plan(0), 0, frame("home page"));
  assert.equal(readReplay(store, "local", "k", RUN, plan(0)).replaySteps.length, 1);
  saveRecordingSettings(store, "local", { mode: "off" });
  assert.deepEqual(readReplay(store, "local", "k", RUN, plan(0)).replaySteps, []);
  rememberReplay(store, "local", "k", plan(0), 0, frame("home page"));
  assert.deepEqual(readReplay(store, "local", "k", RUN, plan(0)).replaySteps, []);
});

test("SCREEN-022: kept frames stay within two megabytes", () => {
  const store = new Store(":memory:");
  const big = "x".repeat(900 * 1024);
  for (const step of [0, 1, 2]) rememberReplay(store, "local", "k", plan(step), step, frame(big + step));
  assert.deepEqual(readReplay(store, "local", "k", RUN, plan(2)).replaySteps.map((one) => one.step), [1, 2], "the oldest gave way");
});

test("SCREEN-022: the pushed live view observes plan steps as the fast read does", async () => {
  const { readFile } = await import("node:fs/promises");
  const server = await readFile(new URL("../src/server.ts", import.meta.url), "utf8");
  const streamed = /await streamLiveStage\(\{([\s\S]*?)\}, session, response, readable\)/.exec(server)?.[1] ?? "";
  assert.ok(streamed, "the stream route hands its own deps to streamLiveStage");
  assert.match(streamed, /plan: session => app\.runtime\.orchestration\.plan\(session\)/, "the stream reads the plan");
  assert.match(streamed, /observeSteps: true/, "the stream keeps a frame for the working step");
});
