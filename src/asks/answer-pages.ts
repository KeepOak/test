import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { z } from "zod";
import { pageStyle, redactText, RedactionSchema } from "../conversation-share.js";
import type { WorkspaceFiles } from "../files.js";
import type { ToolRegistry } from "../registry.js";
import type { Store } from "../store.js";
import { requireAsk } from "./settings.js";

/**
 * A0355: answers kept as pages. An answer with its sources (from the answer engine, a research
 * report, or anything the assistant wrote) is kept in Library as a page of its own: it can be opened
 * again, retitled, updated with a fresh answer, and handed to someone else as one HTML file. The file
 * carries no script and nothing from outside, and keys are blanked out before it is written, the
 * same way a shared conversation is. Nothing is put online; the owner decides where the file goes.
 */
export const PageSourceSchema = z.object({
  number: z.number().int().min(1).max(200),
  title: z.string().max(300),
  url: z.string().max(2048),
}).strict();
export type PageSource = z.infer<typeof PageSourceSchema>;

export const SavePageSchema = z.object({
  id: z.string().uuid().optional(),
  title: z.string().trim().min(1).max(160),
  question: z.string().trim().max(500).default(""),
  body: z.string().min(1).max(60000),
  sources: z.array(PageSourceSchema).max(200).default([]),
}).strict();

/**
 * SELF-309: a page the assistant publishes for the owner, such as a report or a tracker like the master plan. It holds
 * its own words, updated by id as the work moves on, or it is bound to a file in the workspace and shown from that file
 * every time it is opened, so it is always current with no copy to fall behind. Either way it stays on this computer,
 * is the owner's alone and is read with the same rules as any file the assistant reads.
 */
export const pageFormats = ["markdown", "text"] as const;
export const PublishPageSchema = z.object({
  /** The page to update; left out, a new page is made. */
  id: z.string().uuid().optional(),
  title: z.string().trim().min(1).max(160),
  /** The page's own words; or `sourcePath`. */
  body: z.string().min(1).max(60000).optional(),
  /** A file in the workspace (such as MASTER-PLAN.md) shown live every time the page is opened; or `body`. */
  sourcePath: z.string().trim().min(1).max(500).optional(),
  format: z.enum(pageFormats).default("markdown"),
}).strict().refine((value) => (value.body === undefined) !== (value.sourcePath === undefined),
  "Give the page either its words (body) or a workspace file to show live (sourcePath), not both.");

/** The largest file a live page shows. */
const liveBytes = 512 * 1024;

export interface AnswerPage {
  id: string; title: string; question: string; body: string; sources: PageSource[];
  createdAt: string; updatedAt: string; revision: number;
  /** A live page's file in the workspace, or null for a page that holds its own words. */
  sourcePath: string | null;
  format: (typeof pageFormats)[number];
  /** For a live page as opened: whether its file could be read, and why not when it could not. */
  missing?: string;
}

const escape = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Only plain web addresses become links; anything else is shown as words. */
const safeLink = (url: string): string | null => (/^https?:\/\/[^\s"<>]+$/i.test(url) ? url : null);

/** The page as one file: no scripts, colours written in, keys blanked out. */
export function pageHtml(page: AnswerPage): { html: string; blanked: number } {
  const redact = RedactionSchema.parse({});
  const body = redactText(page.body, redact);
  const blanked = body.secrets + body.contactDetails;
  const sources = page.sources.map((source) => {
    const link = safeLink(source.url);
    const title = escape(source.title || source.url);
    return `<li>[${source.number}] ${link ? `<a href="${escape(link)}" rel="noreferrer noopener">${title}</a>` : title}</li>`;
  }).join("");
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'" />
<meta name="robots" content="noindex, nofollow" />
<title>${escape(page.title)}</title>
<style>${pageStyle}</style></head>
<body><main><h1>${escape(page.title)}</h1>
<p class="meta">Kept by Branch Agent · updated ${escape(page.updatedAt.slice(0, 10))}${page.question ? ` · ${escape(page.question)}` : ""}</p>
${blanked ? `<p class="notice">${blanked} thing${blanked === 1 ? " was" : "s were"} blanked out of this copy.</p>` : ""}
<article><p style="white-space:pre-wrap">${escape(body.text)}</p></article>
${sources ? `<h2>Sources</h2><ol>${sources}</ol>` : ""}
<footer>A read-only page. It cannot run anything and is not connected to the assistant.</footer>
</main></body></html>\n`;
  return { html, blanked };
}

const fromRow = (row: Record<string, unknown>): AnswerPage => ({
  id: String(row.id), title: String(row.title), question: String(row.question), body: String(row.body),
  sources: JSON.parse(String(row.sources)) as PageSource[], createdAt: String(row.created_at),
  updatedAt: String(row.updated_at), revision: Number(row.revision),
  sourcePath: row.source_path ? String(row.source_path) : null, format: row.format === "markdown" ? "markdown" : "text",
});

export class AnswerPages {
  constructor(private readonly store: Store, private readonly owner: string, private readonly files?: WorkspaceFiles) {
    store.sqlite.exec(`CREATE TABLE IF NOT EXISTS asks_pages(id TEXT PRIMARY KEY, owner TEXT NOT NULL, title TEXT NOT NULL,
      question TEXT NOT NULL, body TEXT NOT NULL, sources TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
    // SELF-309: a page may show a workspace file live, and say how its words are written.
    const columns = new Set(store.sqlite.prepare("PRAGMA table_info(asks_pages)").all().map((row) => String(row.name)));
    if (!columns.has("source_path")) store.sqlite.exec("ALTER TABLE asks_pages ADD COLUMN source_path TEXT");
    if (!columns.has("format")) store.sqlite.exec("ALTER TABLE asks_pages ADD COLUMN format TEXT NOT NULL DEFAULT 'text'");
    // The file a live page was bound to, as a full path: a later project or worktree switch never shows another file.
    if (!columns.has("source_where")) store.sqlite.exec("ALTER TABLE asks_pages ADD COLUMN source_where TEXT");
  }
  /** SELF-309: publishes a page, or updates one by id (its revision moves on); a live page is checked to be readable now. */
  async publish(input: unknown): Promise<AnswerPage> {
    requireAsk(this.store, this.owner, "answer-pages");
    const value = PublishPageSchema.parse(input);
    const existing = value.id ? this.find(value.id) : null;
    if (value.id && !existing) throw new Error("That page was not found");
    const sourcePath = value.sourcePath ? value.sourcePath.replace(/\\/g, "/").replace(/^\.\//, "") : null;
    if (sourcePath) {
      if (!this.files) throw new Error("A live page needs the workspace, and there is none here.");
      await this.files.read(sourcePath, liveBytes); // outside the workspace, hidden, a link or too big: refused now
    }
    const where = sourcePath && this.files ? await this.files.checked(sourcePath) : null;
    const now = new Date().toISOString(), id = existing?.id ?? randomUUID();
    this.store.sqlite.prepare(`INSERT INTO asks_pages(id, owner, title, question, body, sources, revision, created_at, updated_at, source_path, format, source_where)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET title=excluded.title, body=excluded.body, revision=asks_pages.revision+1,
      updated_at=excluded.updated_at, source_path=excluded.source_path, format=excluded.format, source_where=excluded.source_where`)
      .run(id, this.owner, value.title, existing?.question ?? "", value.body ?? "", JSON.stringify(existing?.sources ?? []), 1,
        existing?.createdAt ?? now, now, sourcePath, value.format, where);
    return this.get(id);
  }
  /**
   * A page as it is opened: a live page's words are read from its file now, dated by when the file last changed. A file
   * that cannot be read is said plainly, never shown as an empty page.
   */
  async open(id: string): Promise<AnswerPage> {
    const page = this.get(id);
    if (!page.sourcePath) return page;
    if (!this.files) return { ...page, missing: "There is no workspace here to read it from." };
    try {
      const bound = this.store.sqlite.prepare("SELECT source_where FROM asks_pages WHERE id=? AND owner=?").get(page.id, this.owner)?.source_where;
      if (!bound || await this.files.checked(page.sourcePath) !== String(bound))
        return { ...page, body: "", missing: `${page.sourcePath} was published from another project or worktree; switch back to it to see this page.` };
      const { content } = await this.files.read(page.sourcePath, liveBytes);
      const changed = await stat(await this.files.checked(page.sourcePath)).then((info) => info.mtime.toISOString(), () => page.updatedAt);
      return { ...page, body: content, updatedAt: changed };
    } catch (error) {
      return { ...page, body: "", missing: `${page.sourcePath} cannot be read now: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
  /** Keeps a new page, or updates one (its revision moves on and its first date stays). */
  save(input: unknown): AnswerPage {
    requireAsk(this.store, this.owner, "answer-pages");
    const value = SavePageSchema.parse(input);
    const now = new Date().toISOString();
    const existing = value.id ? this.find(value.id) : null;
    if (value.id && !existing) throw new Error("That page was not found");
    const id = existing?.id ?? randomUUID();
    this.store.sqlite.prepare(`INSERT INTO asks_pages(id, owner, title, question, body, sources, revision, created_at, updated_at)
      VALUES(?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET title=excluded.title, question=excluded.question, body=excluded.body,
      sources=excluded.sources, revision=asks_pages.revision+1, updated_at=excluded.updated_at`)
      .run(id, this.owner, value.title, value.question, value.body, JSON.stringify(value.sources), 1, existing?.createdAt ?? now, now);
    return this.get(id);
  }
  private find(id: string): AnswerPage | null {
    const row = this.store.sqlite.prepare("SELECT * FROM asks_pages WHERE owner=? AND id=?").get(this.owner, id);
    return row ? fromRow(row) : null;
  }
  get(id: string): AnswerPage {
    const page = this.find(id);
    if (!page) throw new Error("That page was not found");
    return page;
  }
  list(): Omit<AnswerPage, "body">[] {
    return this.store.sqlite.prepare("SELECT * FROM asks_pages WHERE owner=? ORDER BY updated_at DESC LIMIT 200").all(this.owner)
      .map((row) => { const { body: _body, ...rest } = fromRow(row); return rest; });
  }
  remove(id: string): { removed: boolean } {
    return { removed: this.store.sqlite.prepare("DELETE FROM asks_pages WHERE owner=? AND id=?").run(this.owner, id).changes > 0 };
  }
  /** The file to hand to someone else; a live page as its file reads now. */
  async exportPage(id: string): Promise<{ filename: string; html: string; blanked: number }> {
    const page = await this.open(id);
    const slug = page.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "page";
    return { filename: `${slug}.html`, ...pageHtml(page) };
  }
}

export function registerAnswerPages(registry: ToolRegistry, pages: AnswerPages): void {
  registry.register({
    // Ships-on sweep (2026-09-26): its own box, not "core" by its name's "answer" prefix, so shipping it on does not put it in every mode.
    name: "answer.page", group: "documents", permission: "pages.write",
    description: "Keep an answer with its numbered sources as a page in the owner's Library, or update one (pass its id). The page can be opened again and handed on as one file.",
    parameters: SavePageSchema,
    execute: async (input) => { const page = pages.save(input); return { id: page.id, title: page.title, revision: page.revision }; },
  });
  // SELF-309: pages the assistant publishes for the owner and keeps current.
  registry.register({
    name: "pages.publish", group: "documents", permission: "pages.write",
    description: "Publish a page for the owner to open in Branch (Library, or #page=<id>): a report or a tracker. Give its words (body), updated later by passing its id, or bind it to a workspace file (sourcePath) so it is shown live from that file every time it is opened. It stays on this computer.",
    parameters: PublishPageSchema,
    target: (input) => (typeof input.sourcePath === "string" ? input.sourcePath : `page:${typeof input.title === "string" ? input.title : ""}`),
    execute: async (input) => {
      const page = await pages.publish(input);
      return { id: page.id, title: page.title, revision: page.revision, live: page.sourcePath !== null, sourcePath: page.sourcePath, link: `#page=${page.id}` };
    },
  });
  registry.register({
    name: "pages.list", group: "documents", permission: "documents.read",
    description: "The pages kept for the owner, newest first: id, title, whether each is live from a file, and when it last changed.",
    parameters: z.object({}).strict(),
    execute: async () => ({ pages: pages.list().map(({ id, title, sourcePath, updatedAt, revision }) => ({ id, title, live: sourcePath !== null, sourcePath, updatedAt, revision })) }),
  });
}
