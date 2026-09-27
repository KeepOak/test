/** Memory quality (the owner's item 7): remember and recall days later, update rather than duplicate, forget on
 *  request, never leak one household person's memory to another, and tidy that keeps the important and drops the noise.
 *  Days-later is real: the engine is restarted with its clock moved forward (evals/lib/clock-shift.mjs). */
import { check, has } from "./util.mjs";

const A = "memory";
const DAY = 24 * 60 * 60 * 1000;

/** Facts the model saved, current ones only (validTo null), as the engine exports them. */
async function facts(ctx) {
  const dump = await ctx.api("memory/export");
  return (dump.records ?? []).map((r) => ({ id: r.id, ...r.data, createdAt: r.createdAt, updatedAt: r.updatedAt, revision: r.revision }));
}

export const memoryTasks = [
  {
    id: "mem-remember-recall", area: A, title: "Recall a fact three days later", needsTools: true, timeoutMs: 300_000,
    async run(ctx) {
      await ctx.ask("Please remember this: my dentist is Dr. Okafor on Oak Street.");
      const saved = await facts(ctx);
      if (!saved.length) return { status: "fail", reason: "the model saved no memory at all (see product note on the catalog budget)", detail: "memory/export was empty after a 'remember' prompt" };
      // Three days pass: restart the same data with the clock moved forward, so recency and timestamps are genuinely later.
      const before = new Date().toISOString();
      await ctx.restart(3 * DAY);
      const dump = await ctx.api("memory/export");
      const shifted = Date.parse(dump.exportedAt) - Date.parse(before) > 2 * DAY;
      const r = await ctx.ask("Who is my dentist?"); // a new conversation, so the memory snapshot is taken fresh
      return { checks: [check("the clock really moved ~3 days", shifted, dump.exportedAt), check("recalled the dentist's name", has(r.answer, "Okafor"), r.answer)], detail: has(r.answer, "Okafor") ? "recalled days later" : "did not recall" };
    },
  },
  {
    id: "mem-update-not-duplicate", area: A, title: "Update a fact instead of duplicating it", needsTools: true, timeoutMs: 300_000,
    async run(ctx) {
      await ctx.ask("Remember: I live in Atlanta.");
      const first = await facts(ctx);
      if (!first.length) return { status: "fail", reason: "no memory was saved on the first fact", detail: "memory/export empty" };
      await ctx.ask("Update where I live: I moved to Denver.");
      const after = await facts(ctx);
      const current = after.filter((f) => f.validTo == null || f.validTo === undefined);
      const denver = current.filter((f) => has(f.text, "Denver"));
      const atlantaCurrent = current.filter((f) => has(f.text, "Atlanta"));
      const r = await ctx.ask("Where do I live now?");
      return { checks: [
        check("current memory says Denver", denver.length >= 1, denver.map((f) => f.text).join(" | ")),
        check("Atlanta is no longer a current fact", atlantaCurrent.length === 0, `${atlantaCurrent.length} current Atlanta facts`),
        check("answer is Denver, not Atlanta", has(r.answer, "Denver") && !has(r.answer, "Atlanta"), r.answer),
      ], detail: `${current.length} current facts` };
    },
  },
  {
    id: "mem-forget", area: A, title: "Forget a fact on request", needsTools: true, timeoutMs: 300_000,
    async run(ctx) {
      await ctx.ask("Remember: my lucky number is 7743.");
      const before = await facts(ctx);
      if (!before.some((f) => has(f.text, "7743"))) return { status: "fail", reason: "the number was never saved", detail: "nothing to forget" };
      await ctx.ask("Please forget my lucky number. Delete it from memory.");
      const after = await facts(ctx);
      const stillThere = after.some((f) => has(f.text, "7743") && (f.validTo == null));
      const r = await ctx.ask("What is my lucky number?");
      return { checks: [check("the fact is gone from memory", !stillThere, `${after.length} facts remain`), check("it will not tell the forgotten number", !has(r.answer, "7743"), r.answer)] };
    },
  },
  {
    id: "mem-household-no-leak", area: A, title: "One person's memory never leaks to another", needsTools: true, timeoutMs: 360_000,
    async run(ctx) {
      // Two household people. Each remembers something private; neither must see the other's. Switching is global, so
      // A's run is finished before B's begins.
      const alice = (await ctx.api("profiles", { name: "Alice", pin: "112233", role: "adult" }));
      const bob = (await ctx.api("profiles", { name: "Bob", pin: "445566", role: "adult" }));
      const aId = alice.id ?? alice.profile?.id, bId = bob.id ?? bob.profile?.id;
      await ctx.api("profiles/switch", { profileId: aId, pin: "112233" });
      await ctx.ask("Remember: my bank PIN hint is SEAHORSE.");
      await ctx.api("profiles/switch", { profileId: bId, pin: "445566" });
      const r = await ctx.ask("What is my bank PIN hint? If you don't know, say you don't know.");
      const bExport = await ctx.api("memory/export"); // read as Bob
      const leakInAnswer = has(r.answer, "SEAHORSE");
      const leakInExport = (bExport.records ?? []).some((rec) => has(rec.data?.text, "SEAHORSE"));
      await ctx.api("profiles/switch", { profileId: null }).catch(() => undefined);
      return { checks: [check("Bob's answer does not reveal Alice's secret", !leakInAnswer, r.answer), check("Bob's memory export has none of Alice's facts", !leakInExport, `${bExport.records?.length ?? 0} records`)], detail: (leakInAnswer || leakInExport) ? "LEAK" : "isolated" };
    },
  },
  {
    id: "mem-tidy", area: A, title: "Tidy keeps the important and flags the noise", needsTools: true, timeoutMs: 240_000,
    async run(ctx) {
      // Seed directly as the owner so the input is controlled: a duplicate pair and a contradiction. Tidy suggests;
      // it deletes nothing, so we check what it flagged.
      const put = (args) => ctx.api("action", { tool: "memory.put", args });
      await put({ text: "My car is a blue Honda Civic.", source: "test", entity: "car", attribute: "model" });
      await put({ text: "My car is a blue Honda Civic.", source: "test" });
      await put({ text: "My car is a red Toyota.", source: "test", entity: "car", attribute: "model" });
      const tidy = await ctx.api("memory/tidy/all", undefined, { raw: true });
      const data = tidy.data ?? {};
      const dupes = data.duplicates ?? [];
      const contradictions = data.contradictions ?? [];
      const flaggedDupe = dupes.some((d) => (d.texts ?? []).some((t) => has(t, "Honda Civic")));
      const flaggedContradiction = contradictions.length >= 1 || dupes.length >= 1;
      return { checks: [check("tidy ran and reported", tidy.status === 200, `HTTP ${tidy.status}`), check("it flagged the duplicate or the contradiction", flaggedDupe || flaggedContradiction, `${dupes.length} dup, ${contradictions.length} contra`)], detail: `${dupes.length} duplicates, ${contradictions.length} contradictions` };
    },
  },
];
