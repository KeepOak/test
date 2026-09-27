/** Shared helpers for the tasks: polling the engine's own routes and reading the truth out of a finished run. */

export const has = (text, needle) => String(text ?? "").toLowerCase().includes(String(needle).toLowerCase());
export const check = (name, ok, got = "") => ({ name, ok: Boolean(ok), got: String(got).slice(0, 120) });

/** Poll a GET route until `done(data)` or the deadline; returns the last data seen. */
export async function until(ctx, path, done, { ms = 60_000, every = 500 } = {}) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    last = await ctx.api(path).catch(() => null);
    if (last && done(last)) return last;
    await new Promise((r) => setTimeout(r, every));
  }
  return last;
}

/** The tool calls a run made, from its inspect view: [{name, status, ok, output}]. */
export async function toolCalls(ctx, runId) {
  const inspect = await ctx.api(`runs/${runId}/inspect`).catch(() => null);
  return (inspect?.calls ?? []).map((call) => ({ name: call.name, status: call.status, ok: call.status === "done", output: call.output ?? "" }));
}

/** The kinds of a run's events, and a test for one being present (folds, failures, delegation). */
export async function runEvents(ctx, runId) {
  const data = await ctx.api(`runs/${runId}`).catch(() => null);
  return data?.events ?? [];
}

/** Turn Trunks and rooms on and make two Trunks, each on the eval's model. Returns their ids and handles. */
export async function twoTrunks(ctx) {
  await ctx.api("trunks/switch", { part: "trunks", mode: "on" });
  await ctx.api("trunks/switch", { part: "rooms", mode: "on" });
  const a = (await ctx.api("trunks", { name: "Ann", description: "Answers about apples" })).trunk;
  const b = (await ctx.api("trunks", { name: "Bo", description: "Answers about boats" })).trunk;
  return { a, b };
}
