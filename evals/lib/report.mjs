/**
 * The scorecard: a machine-readable JSON and a short Markdown table, with a trend against the previous run. Only
 * `pass` and `fail` enter the pass rate; the rest (needs local model, needs sign-in, timeout, n/a, harness-error) are
 * kept apart so nothing is ever counted as a pass it did not earn.
 */
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const COUNTED = new Set(["pass", "fail"]);
export const STATUS_ORDER = ["pass", "fail", "timeout", "needs local model", "needs sign-in", "n/a", "harness-error"];

export function summarise(results) {
  const counts = Object.fromEntries(STATUS_ORDER.map((s) => [s, 0]));
  for (const r of results) counts[r.status] = (counts[r.status] ?? 0) + 1;
  const counted = results.filter((r) => COUNTED.has(r.status));
  const passed = counted.filter((r) => r.status === "pass").length;
  return { counts, counted: counted.length, passed, passRate: counted.length ? passed / counted.length : null };
}

/** The newest earlier JSON scorecard in `dir`, for the trend, skipping the one just written. */
export async function previousRun(dir, exceptFile) {
  const files = (await readdir(dir).catch(() => [])).filter((f) => f.endsWith(".json") && f !== exceptFile).sort();
  for (const file of files.reverse()) {
    const data = await readFile(join(dir, file), "utf8").then(JSON.parse).catch(() => null);
    if (data?.results) return { file, data };
  }
  return null;
}

export function scorecardJson({ model, startedAt, finishedAt, results, host }) {
  const summary = summarise(results);
  return {
    kind: "branch-evals-scorecard", version: 1, model, host, startedAt, finishedAt,
    durationMs: Date.parse(finishedAt) - Date.parse(startedAt), summary,
    results: results.map((r) => ({ id: r.id, area: r.area, title: r.title, status: r.status, ms: r.ms,
      tokens: r.tokens ?? null, tokensEstimated: r.tokensEstimated ?? false, detail: r.detail ?? "",
      checks: r.checks ?? [], reason: r.reason ?? "" })),
  };
}

export function scorecardMarkdown(current, previous) {
  const s = current.summary;
  const prev = previous?.data ? summarise(previous.data.results) : null;
  const byId = new Map((previous?.data?.results ?? []).map((r) => [r.id, r.status]));
  const lines = [];
  lines.push(`# Branch evals — ${current.finishedAt.slice(0, 10)}`);
  lines.push("");
  lines.push(`Model: **${current.model.label}** · host: ${current.host} · ${Math.round(current.durationMs / 1000)}s`);
  if (current.ownerSkills?.setHash) lines.push(`Skill fixture: ${current.ownerSkills.side} · ${current.ownerSkills.count} selected package(s) · SKILL.md only · corpus ${current.ownerSkills.setHash}`);
  const rate = s.passRate === null ? "—" : `${s.passed}/${s.counted} (${Math.round(s.passRate * 100)}%)`;
  const prevRate = prev && prev.passRate !== null ? ` (was ${prev.passed}/${prev.counted}, ${Math.round(prev.passRate * 100)}%)` : "";
  lines.push(`Pass rate (pass+fail only): **${rate}**${prevRate}`);
  lines.push("");
  lines.push(STATUS_ORDER.filter((k) => s.counts[k]).map((k) => `${k}: ${s.counts[k]}`).join(" · "));
  lines.push("");
  lines.push("| Task | Area | Status | Trend | Time | Tokens | Notes |");
  lines.push("|---|---|---|---|---|---|---|");
  for (const r of current.results) {
    const was = byId.get(r.id);
    const trend = !was ? "new" : was === r.status ? "=" : `${was} → ${r.status}`;
    const arrow = !was || was === r.status ? trend : (r.status === "pass" ? "▲ " : r.status === "fail" ? "▼ " : "") + trend;
    const tok = r.tokens ? `${r.tokens}${r.tokensEstimated ? "~" : ""}` : "—";
    const notes = (r.detail || r.reason || "").replace(/\s+/g, " ").replace(/\|/g, "\\|").trim().slice(0, 90);
    lines.push(`| ${r.id} | ${r.area} | ${badge(r.status)} | ${arrow} | ${r.ms ? Math.round(r.ms / 100) / 10 + "s" : "—"} | ${tok} | ${notes} |`);
  }
  lines.push("");
  return lines.join("\n");
}

function badge(status) {
  return status === "pass" ? "PASS" : status === "fail" ? "FAIL" : status;
}

export async function writeScorecard(dir, current, previous) {
  const date = current.finishedAt.slice(0, 10);
  const jsonPath = join(dir, `${date}.json`), mdPath = join(dir, `${date}.md`);
  await writeFile(jsonPath, JSON.stringify(current, null, 2));
  await writeFile(mdPath, scorecardMarkdown(current, previous));
  return { jsonPath, mdPath };
}

/**
 * One night, several models side by side: each model's pass rate, then one row per task with each model's status and
 * time. A model whose suite could not run is a column with the reason instead of results, never an empty pass.
 * `cards` are scorecardJson() results, or { model: { label }, missing: "<why>" }; `links` name each model's own page.
 */
export function sideBySideMarkdown(date, cards, links = []) {
  const lines = [`# Branch evals — ${date}`, "", "| Model | Pass rate (pass+fail only) | Time | Other statuses |", "|---|---|---|---|"];
  for (const card of cards) {
    if (card.missing) { lines.push(`| ${card.model.label} | did not run: ${cell(card.missing)} | — | — |`); continue; }
    const s = card.summary, rate = s.passRate === null ? "—" : `**${s.passed}/${s.counted}** (${Math.round(s.passRate * 100)}%)`;
    const other = STATUS_ORDER.filter((k) => !COUNTED.has(k) && s.counts[k]).map((k) => `${k}: ${s.counts[k]}`).join(" · ") || "—";
    lines.push(`| ${card.model.label} | ${rate} | ${Math.round(card.durationMs / 1000)}s | ${other} |`);
  }
  const ran = cards.filter((card) => !card.missing);
  if (ran.some((card) => card.ownerSkills?.setHash)) lines.push("", "Selected skill instructions are separate with/without columns. Package resources, tools and hooks are omitted; these results do not prove full package behavior.");
  for (const card of cards.filter((entry) => entry.skillPairRefusal)) lines.push("", `${cell(card.model.label)}: ${cell(card.skillPairRefusal)}`);
  const ids = [...new Set(ran.flatMap((card) => card.results.map((r) => r.id)))];
  lines.push("", `| Task | Area | ${cards.map((card) => card.model.label).join(" | ")} |`, `|---|---|${cards.map(() => "---|").join("")}`);
  for (const id of ids) {
    const area = ran.map((card) => card.results.find((r) => r.id === id)?.area).find(Boolean) ?? "";
    const cells = cards.map((card) => {
      const r = card.results?.find((x) => x.id === id);
      return r ? `${badge(r.status)}${r.ms ? ` · ${Math.round(r.ms / 100) / 10}s` : ""}` : "—";
    });
    lines.push(`| ${id} | ${area} | ${cells.join(" | ")} |`);
  }
  if (links.length) lines.push("", `Each model's own page, with notes and the trend against its previous night: ${links.join(" · ")}`);
  lines.push("");
  return lines.join("\n");
}

function cell(words) { return String(words).replace(/\s+/g, " ").replace(/\|/g, "\\|").trim().slice(0, 160); }
