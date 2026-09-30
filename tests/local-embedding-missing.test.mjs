/**
 * QA retest 2026-09-28 (m7): with only a model on this computer, Library documents said "Comparing by meaning failed:
 * The model on this computer could not read these passages (404)". Ollama answers 404 when the model that compares
 * passages (nomic-embed-text, used in place of the cloud default) is not downloaded; the note now names that model and
 * how to add it. Node only: the real dist/, a stand-in for Ollama's answers.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { OllamaClient } from "../dist/local-models.js";

const answering = (status, body) => async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("a missing model for comparing passages is named, with how to add it", async () => {
  const missing = new OllamaClient("http://127.0.0.1:11434", answering(404, { error: 'model "nomic-embed-text" not found, try pulling it first' }));
  await assert.rejects(missing.embed(["hello"], "nomic-embed-text", AbortSignal.timeout(5000)),
    (error) => error.message === 'nomic-embed-text, the model that compares passages by meaning, is not on this computer. Run "ollama pull nomic-embed-text" to add it.');
  const broken = new OllamaClient("http://127.0.0.1:11434", answering(500, { error: "out of memory" }));
  await assert.rejects(broken.embed(["hello"], "nomic-embed-text", AbortSignal.timeout(5000)), /could not read these passages \(500\)/, "any other refusal is said as before");
});
