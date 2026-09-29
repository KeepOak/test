import { randomUUID } from "node:crypto";
import { mkdir, open, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import type { ToolContext, ToolDefinition } from "./contracts.js";
import type { ToolRegistry } from "./registry.js";
import type { WorkspaceFiles, WriteObserver } from "./files.js";
import type { RunArtifacts } from "./artifacts.js";
import type { WebAccess } from "./integrations/web.js";
import {
  type DataTable, describeTable, markdownTable, maxRows, previewRows, queryTables, tableFrom, tableFromText, toCsv, toXlsx,
} from "./data-table.js";
import { ChartSpecSchema, chartSvg } from "./data-chart.js";

/**
 * Spreadsheet work the assistant can do for the person: open a file of figures, say what is in it,
 * answer questions about it with read-only SQL, draw it, and save the result back. The figures stay
 * on this computer and only last as long as the task that opened them.
 */
const tableName = z.string().trim().regex(/^[a-z][a-z0-9_]{0,39}$/, "Table names use lowercase letters, digits and underscores");
/** The most a file may weigh before it is refused, whether it came from disk or an address. */
export const dataBytesLimit = 8 * 1024 * 1024;
/** The most a saved export may weigh; a table this big is already far past what anyone reads. */
export const exportBytesLimit = 8 * 1024 * 1024;
const tablesPerRun = 8;
/**
 * QA retest 2026-09-28 (m6): a file attached to the conversation a task belongs to, by the id its message named or by its
 * exact name; null when there is none. Attached files are kept outside the workspace, so a path never reached them.
 */
export type AttachedFiles = (runId: string, key: { id?: string; name?: string }) => Promise<{ name: string; size: number; read: () => Promise<Buffer> } | null>;
const missing = (error: unknown) => (error as NodeJS.ErrnoException | null)?.code === "ENOENT";

export class DataTables {
  private readonly byRun = new Map<string, Map<string, DataTable>>();
  constructor(private readonly files: WorkspaceFiles, private readonly web?: WebAccess, private readonly observer?: WriteObserver,
    private readonly attached?: AttachedFiles) {}
  /** Every table this task has open, oldest first. */
  list(runId: string): DataTable[] {
    return [...(this.byRun.get(runId)?.values() ?? [])];
  }
  get(runId: string, name?: string): DataTable {
    const open = this.byRun.get(runId);
    if (!open?.size) throw new Error("No table is open yet. Use data.load first.");
    if (!name) return [...open.values()][open.size - 1]!;
    const found = open.get(name);
    if (!found) throw new Error(`No table called "${name}" is open. Open ones: ${[...open.keys()].join(", ")}`);
    return found;
  }
  put(runId: string, table: DataTable): void {
    const open = this.byRun.get(runId) ?? new Map<string, DataTable>();
    if (!open.has(table.name) && open.size >= tablesPerRun)
      throw new Error(`Up to ${tablesPerRun} tables can be open at once; close the task or reuse a name`);
    open.set(table.name, table);
    this.byRun.set(runId, open);
  }
  /** Drops everything this task opened; called when the task finishes. */
  release(runId: string): void {
    this.byRun.delete(runId);
  }
  /** Reads a workspace file, refusing anything past the size limit before it is loaded. */
  async fromWorkspace(path: string, name: string): Promise<DataTable> {
    const handle = await open(await this.files.checked(path), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new Error("That path is not a file");
      if (stat.size > dataBytesLimit) throw new Error(`Files up to ${dataBytesLimit / 1048576} MB can be opened`);
      const buffer = Buffer.alloc(stat.size);
      await handle.read(buffer, 0, stat.size, 0);
      return tableFrom(name, path, buffer);
    } finally { await handle.close(); }
  }
  /** Reads a file attached to this task's conversation, or null when there is no such file. */
  async fromAttachment(runId: string, key: { id?: string; name?: string }, given?: string): Promise<DataTable | null> {
    const found = this.attached ? await this.attached(runId, key) : null;
    if (!found) return null;
    if (found.size > dataBytesLimit) throw new Error(`Files up to ${dataBytesLimit / 1048576} MB can be opened`);
    return tableFrom(nameFor(found.name, given), found.name, await found.read());
  }
  /** A workspace file; a bare name that is no workspace file but is a file attached to this conversation opens that. */
  async fromPath(runId: string, path: string, given?: string): Promise<DataTable> {
    try { return await this.fromWorkspace(path, nameFor(path, given)); }
    catch (error) {
      const bare = !/[\\/]/.test(path);
      const table = bare && missing(error) ? await this.fromAttachment(runId, { name: path }, given) : null;
      if (table) return table;
      throw error;
    }
  }
  /** Reads a table from a public address; the network policy decides what may be reached. */
  async fromUrl(url: string, name: string): Promise<DataTable> {
    if (!this.web) throw new Error("Web reading is not available in this launch");
    const page = await this.web.fetchPage(url, dataBytesLimit / 4);
    const text = page.text;
    if (page.truncated) throw new Error("That address holds more data than can be opened at once; save it as a file first");
    return /\.(csv|tsv|json)(\?|$)/i.test(url) ? tableFrom(name, url, Buffer.from(text, "utf8")) : tableFromText(name, url, text);
  }
  /** Saves a table into the person's workspace as comma separated text or a spreadsheet file. */
  async export(context: ToolContext, path: string, format: "csv" | "xlsx", table: DataTable): Promise<{ path: string; bytes: number; format: string }> {
    const bytes = format === "csv" ? Buffer.from(toCsv(table), "utf8") : toXlsx(table);
    if (bytes.byteLength > exportBytesLimit) throw new Error(`Saved files up to ${exportBytesLimit / 1048576} MB are allowed`);
    const target = await this.files.checked(path);
    // The same before-and-after the ordinary file tools use, so an export can be undone like anything else.
    const token = this.observer ? await this.observer.before(path, context) : undefined;
    await mkdir(dirname(target), { recursive: true });
    await this.files.checked(path);
    await writeFile(target, bytes, { mode: 0o600 });
    if (this.observer) await this.observer.after(path, context, token);
    return { path, bytes: bytes.byteLength, format };
  }
}

const summarise = (table: DataTable) => ({
  table: table.name, source: table.source, rows: table.rows.length, truncated: table.truncated,
  columns: table.columns, preview: markdownTable(table.columns.map((column) => column.name), table.rows, 5),
});
/** A name a table can be asked for by, made from the file it came from. */
export function nameFor(source: string, given?: string): string {
  if (given) return given;
  const base = (source.split("?")[0] ?? "").split("/").pop() ?? "data";
  const cleaned = base.replace(/\.[a-z0-9]+$/i, "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 39);
  return /^[a-z]/.test(cleaned) ? cleaned : `t_${cleaned || "data"}`.slice(0, 40);
}

export function registerData(registry: ToolRegistry, tables: DataTables, artifacts?: RunArtifacts): void {
  registry.onRunFinished(async (context) => tables.release(context.runId));
  for (const tool of dataTools(tables, artifacts)) registry.register(tool);
}
function dataTools(tables: DataTables, artifacts?: RunArtifacts): ToolDefinition<never>[] {
  const load: ToolDefinition<{ path?: string | undefined; url?: string | undefined; text?: string | undefined; name?: string | undefined; attachment?: string | undefined }> = {
    name: "data.load", reach: "outbound", permission: "data.read",
    description: `Open a table of figures from a workspace file (.csv, .tsv, .json, .xlsx), a file attached to this conversation (attachment: the id its message named), a public address, or pasted text. Returns the columns, the row count and a small preview — never the whole table. Up to ${maxRows} rows are kept for this task only.`,
    parameters: z.object({
      path: z.string().min(1).max(500).optional(), url: z.string().url().max(2048).optional(),
      text: z.string().min(1).max(1_000_000).optional(), name: tableName.optional(),
      attachment: z.string().regex(/^[a-f0-9]{16}$/).optional(),
    }).strict(),
    execute: async (input, context) => {
      const chosen = [input.path, input.url, input.text, input.attachment].filter((value) => value !== undefined);
      if (chosen.length !== 1) throw new Error("Give exactly one of a file path, an attached file, an address, or some text");
      const attached = input.attachment ? await tables.fromAttachment(context.runId, { id: input.attachment }, input.name) : null;
      if (input.attachment && !attached) throw new Error("That file is not attached to this conversation");
      const name = nameFor(input.path ?? input.url ?? "pasted", input.name);
      const table = attached ? attached
        : input.path ? await tables.fromPath(context.runId, input.path, input.name)
        : input.url ? await tables.fromUrl(input.url, name)
        : tableFromText(name, "pasted text", input.text!);
      tables.put(context.runId, table);
      return summarise(table);
    },
  };
  const describe: ToolDefinition<{ table?: string | undefined }> = {
    name: "data.describe", permission: "data.read",
    description: "Summarise an open table: how many rows, how full each column is, how varied, and the smallest, largest, average and middle value of every column of numbers.",
    parameters: z.object({ table: tableName.optional() }).strict(),
    execute: async (input, context) => {
      const table = tables.get(context.runId, input.table);
      const summary = describeTable(table);
      const rows = summary.columns.map((column) => [column.name, column.type, column.filled, column.missing, column.unique,
        column.type === "number" ? `${column.min} – ${column.max}` : (column.examples ?? []).join(", "),
        column.type === "number" ? String(column.mean) : ""]);
      return { table: table.name, ...summary,
        markdown: markdownTable(["column", "kind", "filled", "missing", "different", "range or examples", "average"], rows, 64) };
    },
  };
  return [load, describe, query(tables), chart(tables, artifacts), exportTool(tables)] as unknown as ToolDefinition<never>[];
}
function query(tables: DataTables): ToolDefinition<{ sql: string; limit: number }> {
  return {
    name: "data.query", permission: "data.read",
    description: `Ask a question about the open tables with read-only SQL (SELECT or WITH only, one statement). Every open table can be used by name; yes/no columns hold 1 and 0. Up to ${previewRows * 2} rows come back, with a Markdown table ready to show.`,
    parameters: z.object({ sql: z.string().trim().min(1).max(4000), limit: z.number().int().min(1).max(previewRows * 2).default(previewRows) }).strict(),
    execute: async (input, context) => {
      const open = tables.list(context.runId);
      if (!open.length) throw new Error("No table is open yet. Use data.load first.");
      const result = queryTables(open, input.sql, input.limit);
      return { ...result, markdown: markdownTable(result.columns, result.rows, input.limit) };
    },
  };
}
function chart(tables: DataTables, artifacts?: RunArtifacts): ToolDefinition<{ table?: string | undefined; spec: z.infer<typeof ChartSpecSchema> }> {
  return {
    name: "data.chart", permission: "data.read",
    description: "Draw an open table as a simple picture — bars, a line, or a pie — and keep it beside this task as an SVG file that opens in any browser.",
    parameters: z.object({ table: tableName.optional(), spec: ChartSpecSchema }).strict(),
    execute: async (input, context) => {
      if (!artifacts) throw new Error("Saving pictures is not available in this launch");
      if (!context.runId) throw new Error("Pictures are kept beside a task, so this needs to run inside one");
      const table = tables.get(context.runId, input.table);
      const svg = chartSvg(table, input.spec);
      const kept = await artifacts.write(context.runId, `chart-${randomUUID().slice(0, 8)}.svg`, "image/svg+xml", Buffer.from(svg, "utf8"));
      return { ...kept, table: table.name, type: input.spec.type, title: input.spec.title ?? `${input.spec.value} by ${input.spec.label}` };
    },
  };
}
function exportTool(tables: DataTables): ToolDefinition<{ table?: string | undefined; path: string; format: "csv" | "xlsx" }> {
  return {
    name: "data.export", permission: "data.write",
    description: "Save an open table into the person's workspace as comma separated text (.csv) or a spreadsheet (.xlsx).",
    parameters: z.object({ table: tableName.optional(), path: z.string().min(1).max(500), format: z.enum(["csv", "xlsx"]).default("csv") }).strict(),
    execute: async (input, context: ToolContext) => {
      const table = tables.get(context.runId, input.table);
      if (context.dryRun) return { path: input.path, format: input.format, wouldWrite: table.rows.length, dryRun: true };
      return { ...(await tables.export(context, input.path, input.format, table)), table: table.name, rows: table.rows.length };
    },
  };
}
