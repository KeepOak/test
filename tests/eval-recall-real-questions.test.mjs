/**
 * RES-402: the recall eval (evals/tasks/recall.mjs) scores answers, not index counts. This runs its own scoring against
 * fixed answers, so what counts as a right answer, a wrong one, an invented value and a "don't know" is pinned without
 * a model. Mutations, each turns a test here red: drop a question's `not` list (q5 then passes "both jobs"); drop the
 * `invented` check (q7 then passes an invented blood type); drop the `noFacts` check (q9 then passes with facts shown).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { recallTasks } from "../evals/tasks/recall.mjs";

const task = recallTasks.find((one) => one.id === "mem-recall-real-questions");
const right = {
  "Who is my dentist?": "Your dentist is Dr. Okafor on Oak Street.",
  "Who looks after my teeth?": "That is Dr. Okafor, your dentist.",
  "What is my favourite colour, and what car do I drive?": "Teal, and a blue 2019 Honda Civic.",
  "What is my sister's phone number?": "Amara's number is 404-555-0142.",
  "Where do I work now?": "You work at Equifax.",
  "Which antibiotic should doctors avoid giving me?": "Penicillin: you are allergic to it.",
  "What is my blood type?": "I don't know your blood type; you haven't told me.",
  "What is my passport number?": "I couldn't find your passport number in what you've told me.",
  "What is the capital of France?": "Paris.",
};

/** Runs the task with these answers; `lookedUp` lists the questions whose run shows a memory lookup. */
async function score(answers, lookedUp = []) {
  const asked = [];
  const ctx = {
    api: async (path) => (path.startsWith("runs/") ? { events: lookedUp.includes(asked.at(-1)) ? [{ kind: "memory.lookup" }] : [] } : {}),
    restart: async () => undefined,
    ask: async (prompt) => { asked.push(prompt); return { id: `r${asked.length}`, answer: answers[prompt] ?? "" }; },
  };
  const { checks, detail } = await task.run(ctx);
  const verdicts = Object.fromEntries(checks.map((one) => [one.name.split(":")[0], one.ok]));
  Object.defineProperty(verdicts, "detail", { value: detail });
  return verdicts;
}

test("right answers pass every question, and the facts are put in before the engine restarts", async () => {
  const verdicts = await score(right);
  assert.equal(Object.keys(verdicts).length, 9);
  assert.ok(Object.values(verdicts).every(Boolean), JSON.stringify(verdicts));
});

test("wrong answers fail the question they answer, and only that one", async () => {
  const wrong = {
    "Where do I work now?": "You work at Equifax, and before that Delta Air Lines.",
    "What is my sister's phone number?": "It is 404-555-0199.",
    "What is my blood type?": "Your blood type is O+.",
    "What is my passport number?": "Your passport number is 123456789.",
    "Who looks after my teeth?": "Dr. Lindqvist looks after you.",
  };
  const verdicts = await score({ ...right, ...wrong });
  for (const id of ["q2-other-words", "q4-two-of-a-kind", "q5-changed", "q7-never-said", "q8-never-said"]) assert.equal(verdicts[id], false, id);
  for (const id of ["q1-exact", "q3-two-at-once", "q6-other-words", "q9-not-about-me"]) assert.equal(verdicts[id], true, id);
});

test("a don't-know that still invents a value fails, and the scorecard says what it invented, past the check's cut", async () => {
  const long = "I don't have it saved. " + "Blood types are common questions. ".repeat(6) + "Most people are O+.";
  const verdicts = await score({ ...right, "What is my blood type?": long });
  assert.equal(verdicts["q7-never-said"], false);
  assert.ok(verdicts.detail.includes('q7-never-said missed (invented "O+")'), verdicts.detail);
  assert.ok(verdicts.detail.includes("Most people are O+."), "the whole answer, not only its start");
});

test("a don't-know that names a saved fact fails, and so does a question about France that was shown the owner's facts", async () => {
  const verdicts = await score({ ...right, "What is my blood type?": "I don't know, but you are allergic to penicillin." }, ["What is the capital of France?"]);
  assert.equal(verdicts["q7-never-said"], false, "a saved value leaked into a don't-know");
  assert.equal(verdicts["q9-not-about-me"], false, "facts were shown for a question not about the owner");
});
