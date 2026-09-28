/**
 * RES-402 (master plan, P1): memory recall measured on real questions, not index counts. Ten facts are put straight into
 * memory through the engine's own import (so a save the model got wrong can never read as a recall it got wrong), the
 * engine is restarted, and nine questions are asked, each in a new conversation, the way a person asks them: in the
 * fact's own words, in other words, two at once, about a fact that changed, about two things of a kind (two phones, two
 * doctors), about things never said (which must get "I don't know", never an invented value), and one that is not
 * about the owner at all (which must get no facts). Every check is named after its question, so ten runs give a count
 * per question, and each question's time is kept (RES-278's latency half).
 */
import { randomUUID } from "node:crypto";
import { check, has, runEvents } from "./util.mjs";

const A = "memory";
const DAY = 24 * 60 * 60 * 1000;

/** The facts, as the owner would have said them. `ended` is a fact a newer one replaced. */
const facts = [
  { text: "My dentist is Dr. Okafor on Oak Street.", entity: "me", attribute: "dentist" },
  { text: "My GP is Dr. Lindqvist at the Midtown clinic.", entity: "me", attribute: "gp" },
  { text: "My sister Amara's phone number is 404-555-0142.", entity: "Amara", attribute: "phone" },
  { text: "My own phone number is 404-555-0199.", entity: "me", attribute: "phone" },
  { text: "My favourite colour is teal.", entity: "me", attribute: "favourite colour" },
  { text: "I am allergic to penicillin.", entity: "me", attribute: "allergy" },
  { text: "My car is a blue 2019 Honda Civic.", entity: "me", attribute: "car" },
  { text: "My wife's birthday is 14 March.", entity: "wife", attribute: "birthday" },
  { text: "I work at Delta Air Lines.", entity: "me", attribute: "work", ended: true },
  { text: "I work at Equifax now.", entity: "me", attribute: "work" },
];

function archive(now) {
  const long = new Date(now - 400 * DAY).toISOString(), then = new Date(now - 30 * DAY).toISOString(), at = new Date(now - 2 * DAY).toISOString();
  return { format: "branch-agent-memory", version: 1, exportedAt: new Date(now).toISOString(), records: facts.map((fact) => ({
    id: randomUUID(), revision: 1,
    createdAt: fact.ended ? long : at, updatedAt: fact.ended ? then : at,
    data: { text: fact.text, source: "The owner said so", entity: fact.entity, attribute: fact.attribute,
      validFrom: fact.ended ? long : fact.attribute === "work" ? then : at, ...(fact.ended ? { validTo: then } : {}) },
  })) };
}

/** Says it does not know, in any of the usual ways. */
const saysUnknown = (answer) => /(don't|do not|doesn't|does not|didn't|did not) (know|have|seem|see|find)|not sure|no (record|information|details?|data|mention|memory|note)|haven't (told|mentioned|shared|saved|got)|not (saved|stored|mentioned|recorded|among|in (my|the|your))|isn't (saved|stored|something|in)|not something I|unable to (find|determine|locate)|(can't|cannot|couldn't|could not) (find|tell|determine|locate|see)/i.test(answer);
const seeded = ["Okafor", "Lindqvist", "0142", "0199", "teal", "penicillin", "Civic", "14 March", "Delta", "Equifax"];

/** Each question: what it asks, and what the answer must and must not hold. */
const questions = [
  { id: "q1-exact", ask: "Who is my dentist?", must: ["Okafor"], not: ["Lindqvist"] },
  { id: "q2-other-words", ask: "Who looks after my teeth?", must: ["Okafor"], not: ["Lindqvist"] },
  { id: "q3-two-at-once", ask: "What is my favourite colour, and what car do I drive?", must: ["teal", "Civic"] },
  { id: "q4-two-of-a-kind", ask: "What is my sister's phone number?", must: ["0142"], not: ["0199"] },
  { id: "q5-changed", ask: "Where do I work now?", must: ["Equifax"], not: ["Delta"] },
  { id: "q6-other-words", ask: "Which antibiotic should doctors avoid giving me?", must: ["penicillin"] },
  { id: "q7-never-said", ask: "What is my blood type?", unknown: true, invented: /\b(AB|A|B|O)\s?[+-](?![\w-])|\b(AB|A|B|O)[ -](positive|negative|pos|neg)\b/ }, // blood types are written in capitals
  { id: "q8-never-said", ask: "What is my passport number?", unknown: true, invented: /\b[A-Z]?\d{6,9}\b/ },
  { id: "q9-not-about-me", ask: "What is the capital of France?", must: ["Paris"], noFacts: true },
];

export const recallTasks = [
  {
    id: "mem-recall-real-questions", area: A, title: "Recall on real questions: other words, two at once, changed, never said",
    needsTools: true, timeoutMs: 600_000,
    async run(ctx) {
      await ctx.api("memory/import", archive(Date.now()));
      await ctx.restart();
      const checks = [], times = [], misses = [];
      for (const q of questions) {
        const started = Date.now();
        const r = await ctx.ask(q.ask); // a new conversation each time
        const ms = Date.now() - started;
        times.push(`${q.id} ${Math.round(ms / 100) / 10}s`);
        const answer = String(r.answer ?? "");
        const words = answer.replace(/\s+/g, " ").slice(0, 110);
        if (q.unknown) {
          const leaked = seeded.filter((value) => has(answer, value));
          const invented = q.invented.exec(answer)?.[0];
          const ok = saysUnknown(answer) && !invented && !leaked.length;
          checks.push(check(`${q.id}: says it does not know, invents nothing`, ok, words));
          // A check keeps only the start of an answer, so a miss says here why it missed (the scorecard's detail).
          if (!ok) misses.push(`${q.id} missed (${!saysUnknown(answer) ? "no don't-know" : invented ? `invented "${invented}"` : `named ${leaked.join(", ")}`}): ${answer.replace(/\s+/g, " ").slice(0, 300)}`);
          continue;
        }
        const missing = q.must.filter((value) => !has(answer, value));
        const wrong = (q.not ?? []).filter((value) => has(answer, value));
        let clean = true;
        if (q.noFacts) clean = !(await runEvents(ctx, r.id)).some((event) => event.kind === "memory.lookup") && !seeded.some((value) => has(answer, value));
        checks.push(check(`${q.id}: ${q.must.join(" + ")}${q.not ? ` not ${q.not.join(", ")}` : ""}${q.noFacts ? ", no facts shown" : ""}`,
          !missing.length && !wrong.length && clean, words));
      }
      const passed = checks.filter((one) => one.ok).length;
      return { checks, detail: [`${passed}/${checks.length} questions · ${times.join(" · ")}`, ...misses].join(" · ") };
    },
  },
];
