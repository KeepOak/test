import { z } from "zod";
import type { Run } from "./contracts.js";
import type { Store } from "./store.js";
import { redactLeaksIn } from "./leak-guard.js";

export const ScheduleDashboardSchema = z.object({ title: z.string().trim().min(1).max(120) }).strict();
const id = z.string().regex(/^[a-z][a-z0-9_-]{0,47}$/);
const CellSchema = z.object({ value: z.string().max(500), source: z.string().trim().min(1).max(300),
  observedAt: z.iso.datetime(), status: z.enum(["fresh", "stale"]) }).strict();
const DashboardStateSchema = z.object({
  columns: z.array(z.object({ id, label: z.string().trim().min(1).max(80) }).strict()).min(1).max(8),
  rows: z.array(z.object({ id, label: z.string().trim().min(1).max(120), cells: z.record(id, CellSchema) }).strict()).max(40),
  attention: z.array(z.string().max(300)).max(12),
}).strict().superRefine((state, context) => {
  const columns = state.columns.map((column) => column.id);
  if (new Set(columns).size !== columns.length || new Set(state.rows.map((row) => row.id)).size !== state.rows.length)
    context.addIssue({ code: "custom", message: "Dashboard identifiers must be unique" });
  for (const row of state.rows) if (Object.keys(row.cells).length !== columns.length || columns.some((key) => !Object.hasOwn(row.cells, key)))
    context.addIssue({ code: "custom", message: "Every row must contain exactly the declared columns" });
});
type DashboardState = z.infer<typeof DashboardStateSchema>;
const SnapshotSchema = z.object({ title: z.string(), runId: z.string().uuid(), updatedAt: z.iso.datetime(),
  state: DashboardStateSchema, changes: z.array(z.object({ at: z.iso.datetime(), text: z.string().max(500) })).max(50) }).strict();
type Snapshot = z.infer<typeof SnapshotSchema>;
const recordId = (schedule: string) => `scheduled-dashboard:${schedule}`;
const clean = <T>(store: Store, value: T): T => redactLeaksIn(store.secrets.scrubber.deep(value)).value;
const esc = (value: string): string => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Instructions add no permissions or source calls; the scheduled task uses its existing approved reach. */
export function scheduledDashboardPrompt(data: Record<string, unknown>): string {
  const config = ScheduleDashboardSchema.safeParse(data.dashboard);
  if (!config.success) return "";
  return `\n\nKeep this dashboard updated: ${config.data.title}. Use only the sources and permissions already named in the task. `
    + 'Return only a JSON object with columns, rows and attention, shaped: '
    + JSON.stringify({ columns: [{ id: "status", label: "Status" }], rows: [{ id: "item", label: "Item", cells: {
      status: { value: "value", source: "actual source identifier", observedAt: "ISO timestamp", status: "fresh" } } }], attention: ["what needs attention"] }) + '. '
    + 'Use up to eight columns, forty unique rows, all cells for each row, and at most twelve attention notes. Each cell needs its actual source and retrieval timestamp. '
    + 'If a source fails, return that cell as stale instead of inventing a value; Branch will keep its previous good value when available. Never include credentials, HTML, scripts or private keys. '
    + 'A source value and timestamp are claims from your reads, not independent verification by the dashboard renderer.';
}
function snapshot(store: Store, owner: string, schedule: string): Snapshot | null {
  const parsed = SnapshotSchema.safeParse(store.get("governance", owner, recordId(schedule))?.data.snapshot);
  return parsed.success ? parsed.data : null;
}
/** Failed reads preserve a cell's last good value and its provenance; a failed refresh preserves the whole page. */
function mergedState(next: DashboardState, before: Snapshot | null): DashboardState {
  const previous = new Map(before?.state.rows.map((row) => [row.id, row]) ?? []);
  return { ...next, rows: next.rows.map((row) => ({ ...row, cells: Object.fromEntries(Object.entries(row.cells).map(([key, cell]) => {
    const previousRow = previous.get(row.id), old = previousRow?.cells[key];
    const sameField = previousRow?.label === row.label && before?.state.columns.find((column) => column.id === key)?.label === next.columns.find((column) => column.id === key)?.label;
    return [key, cell.status !== "stale" ? cell : old && sameField ? { ...old, status: "stale" as const } : { ...cell, value: "Unknown (no retained good value)" }];
  })) })) };
}
function changesOf(next: DashboardState, before: Snapshot | null, at: string): Snapshot["changes"] {
  const previous = new Map(before?.state.rows.map((row) => [row.id, row]) ?? []), changes: Snapshot["changes"] = [];
  for (const row of next.rows) for (const [key, cell] of Object.entries(row.cells)) {
    const old = previous.get(row.id)?.cells[key];
    if (!old || old.value !== cell.value || old.status !== cell.status || old.source !== cell.source)
      changes.push({ at, text: `${row.label} / ${key}: ${cell.status === "stale" ? "source stale; last known value kept if available" : "value updated"}` });
  }
  for (const row of before?.state.rows ?? []) if (!next.rows.some((current) => current.id === row.id)) changes.push({ at, text: `${row.label}: removed by refresh` });
  return [...changes, ...(before?.changes ?? [])].slice(0, 50);
}
const refreshError = "The dashboard refresh did not produce valid completed data. Its last valid page is retained.";
function materialState(state: DashboardState): string {
  return JSON.stringify({ ...state, rows: state.rows.map((row) => ({ ...row,
    cells: Object.fromEntries(state.columns.map(({ id }) => { const cell = row.cells[id]!;
      return [id, { value: cell.value, source: cell.source, status: cell.status }]; })) })) });
}
/** A caller supplies the engine's finished run, never HTML to serve. No provider/files/browser work happens here. */
export function recordScheduledDashboard(store: Store, owner: string, schedule: string, data: Record<string, unknown>, run: Run, unchanged = false): boolean | null {
  const config = ScheduleDashboardSchema.safeParse(data.dashboard);
  if (!config.success || run.owner !== owner) return null;
  const current = store.get("schedules", owner, schedule);
  if (!current || JSON.stringify(current.data.dashboard) !== JSON.stringify(data.dashboard) || current.data.prompt !== data.prompt) return null;
  const before = snapshot(store, owner, schedule), checkedAt = new Date().toISOString();
  const wasFailed = store.get("governance", owner, recordId(schedule))?.data.error === refreshError;
  if (unchanged && run.status === "completed") {
    store.save("governance", owner, recordId(schedule), { ...(before ? { snapshot: before } : {}), checkedAt, error: null });
    return false;
  }
  try {
    if (run.status !== "completed") throw new Error(`Dashboard task did not finish (${run.status})`);
    if (run.output.length > 180_000) throw new Error("Dashboard response exceeds its size limit");
    const source = run.output.trim().replace(/^```json\s*([\s\S]*?)\s*```$/, "$1");
    const parsed = DashboardStateSchema.parse(JSON.parse(source));
    if (parsed.rows.some((row) => Object.values(row.cells).some((cell) => Date.parse(cell.observedAt) > Date.now() + 60_000)))
      throw new Error("Dashboard source timestamp is in the future");
    const state = mergedState(DashboardStateSchema.parse(clean(store, parsed)), before);
    const next: Snapshot = { title: clean(store, config.data.title), runId: run.id, updatedAt: checkedAt, state,
      changes: changesOf(state, before, checkedAt) };
    store.save("governance", owner, recordId(schedule), { snapshot: next, checkedAt, error: null });
    store.event(run.id, "dashboard.refreshed", { scheduleId: schedule, rows: state.rows.length,
      stale: state.rows.reduce((sum, row) => sum + Object.values(row.cells).filter((cell) => cell.status === "stale").length, 0) });
    return wasFailed || !before || before.title !== next.title || materialState(before.state) !== materialState(state);
  } catch {
    store.save("governance", owner, recordId(schedule), { ...(before ? { snapshot: before } : {}), checkedAt,
      error: refreshError });
    return !wasFailed;
  }
}
function dashboardHtml(page: Snapshot, error: string | null): string {
  const headings = page.state.columns.map((column) => `<th>${esc(column.label)}</th>`).join("");
  const rows = page.state.rows.map((row) => `<tr><th>${esc(row.label)}</th>${page.state.columns.map((column) => {
    const cell = row.cells[column.id]!;
    return `<td>${esc(cell.value)}<small>${cell.status === "stale" ? "STALE — " : ""}${esc(cell.source)} · ${esc(cell.observedAt)}</small></td>`;
  }).join("")}</tr>`).join("");
  return '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">`
    + `<title>${esc(page.title)}</title><style>body{font:16px system-ui;margin:24px;background:#fafafa;color:#222}table{border-collapse:collapse;width:100%}th,td{text-align:left;border:1px solid #ccc;padding:10px}small{display:block;color:#555;margin-top:6px}li{margin:6px 0}</style>`
    + `<h1>${esc(page.title)}</h1><p>Last valid refresh: ${esc(page.updatedAt)}. Sources and retrieval times reported by the task; not independently verified.</p>`
    + (error ? `<p>${esc(error)}</p>` : "")
    + `<h2>Needs attention</h2><ul>${page.state.attention.map((note) => `<li>${esc(note)}</li>`).join("") || "<li>None reported</li>"}</ul>`
    + `<table><thead><tr><th>Item</th>${headings}</tr></thead><tbody>${rows}</tbody></table>`
    + `<h2>Recent changes</h2><ul>${page.changes.map((change) => `<li>${esc(change.at)} — ${esc(change.text)}</li>`).join("")}</ul></html>`;
}
export function readScheduledDashboard(store: Store, owner: string, schedule: string): { html: string | null; error: string | null; checkedAt: unknown; exportJson: string | null } {
  store.profiles.requireOwner("Your scheduled dashboard");
  if (!store.get("schedules", owner, schedule)) throw new Error("Schedule not found");
  const record = store.get("governance", owner, recordId(schedule)), saved = snapshot(store, owner, schedule), page = saved ? clean(store, saved) : null;
  const error = typeof record?.data.error === "string" ? record.data.error : null;
  return { html: page ? dashboardHtml(page, error) : null, error, checkedAt: record?.data.checkedAt ?? null,
    exportJson: page ? JSON.stringify({ format: "branch-scheduled-dashboard", version: 1, snapshot: page,
      error, checkedAt: record?.data.checkedAt ?? null, sourceVerification: "task-reported" }, null, 2) : null };
}
