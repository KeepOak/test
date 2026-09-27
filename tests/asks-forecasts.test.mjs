/**
 * packages.forecasting (docs/features.json): "Store probabilistic forecasts and calculate a calibration
 * score after recording outcomes." (src/asks/forecasts.ts)
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { scoreForecasts } from "../dist/asks/forecasts.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-forecasts-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const context = () => { const run = app.store.createRun(app.runtime.owner, "forecast"); return app.runtime.context({ runId: run.id }); };
  return { app, run: (name, args) => app.registry.execute(name, args, context()) };
}

test("the Brier score and calibration are worked out from answered forecasts only", () => {
  const at = new Date().toISOString();
  const one = (probability, happened) => ({ id: String(Math.random()), question: "q?", probability, resolveBy: null, note: null,
    createdAt: at, happened, resolvedAt: happened === null ? null : at, resolution: null });
  const score = scoreForecasts([one(0.9, true), one(0.9, false), one(0.2, false), one(1, true), one(0.7, null)]);
  // (0.01 + 0.81 + 0.04 + 0) / 4 = 0.215
  assert.equal(score.brier, 0.215);
  assert.equal(score.resolved, 4);
  assert.equal(score.open, 1, "the unanswered one waits, and counts towards neither number");
  const top = score.calibration.find((row) => row.band === "90–100%");
  assert.deepEqual({ forecasts: top.forecasts, said: top.said, happened: top.happened }, { forecasts: 3, said: 0.9333, happened: 0.6667 },
    "100% lands in the top band, not outside every band");
  const empty = score.calibration.find((row) => row.band === "50–60%");
  assert.deepEqual({ forecasts: empty.forecasts, said: empty.said, happened: empty.happened }, { forecasts: 0, said: null, happened: null },
    "an empty band says so instead of inventing a number");
  assert.equal(scoreForecasts([]).brier, null, "no answers, no score");
});

test("ships when needed; switched off, no forecast tools, and the part refuses in a sentence", async (t) => {
  const { app } = await fixture(t);
  // The ship-on rule (src/asks/settings.ts): forecasts ship "when needed"; the owner switches them off.
  assert.equal(app.asks.modes().forecasts, "when-needed");
  app.asks.setMode("forecasts", { mode: "off" });
  assert.equal(app.asks.modes().forecasts, "off");
  for (const name of ["forecast.add", "forecast.resolve", "forecast.score"])
    assert.ok(!app.registry.names().includes(name), `${name} is offered while the switch is off`);
});

test("switched on, a forecast is kept, answered once, and scored", async (t) => {
  const { app, run } = await fixture(t);
  app.asks.setMode("forecasts", { mode: "when-needed" });
  assert.ok(app.registry.names().includes("forecast.add"));
  const rain = await run("forecast.add", { question: "Will it rain on Saturday?", probability: 0.7, resolveBy: "2026-09-26" });
  const late = await run("forecast.add", { question: "Will the parcel be late?", probability: 0.2 });
  await assert.rejects(run("forecast.add", { question: "Too sure?", probability: 1.4 }));
  await run("forecast.resolve", { id: rain.id, happened: true, note: "It poured." });
  await assert.rejects(run("forecast.resolve", { id: rain.id, happened: false }), /already answered/);
  const score = await run("forecast.score", { which: "open" });
  assert.equal(score.resolved, 1);
  assert.equal(score.brier, 0.09);
  assert.deepEqual(score.forecasts.map((one) => one.id), [late.id], "only the open one is listed when asked for open");
  app.asks.setMode("forecasts", { mode: "off" });
  assert.ok(!app.registry.names().includes("forecast.add"), "switching off takes the tools away at once");
  assert.equal(app.asks.forecasts.score().resolved, 1, "and keeps what was written down");
});

test("the card's words are in English and real French", async () => {
  const en = JSON.parse(await readFile(join(import.meta.dirname, "..", "public", "locales", "en.json"), "utf8"));
  const fr = JSON.parse(await readFile(join(import.meta.dirname, "..", "public", "locales", "fr.json"), "utf8"));
  for (const key of ["asks.part.forecasts", "asks.forecasts.title", "asks.forecasts.purpose", "asks.forecasts.noneYet", "asks.forecasts.summary", "asks.forecasts.band"]) {
    assert.ok(en[key], `${key} has no English`);
    assert.ok(fr[key] && fr[key] !== en[key], `${key} needs real French`);
  }
  assert.ok(fr["asks.forecasts.summary"].includes("{brier}") && fr["asks.forecasts.band"].includes("{happened}"), "the French keeps its placeholders");
});
