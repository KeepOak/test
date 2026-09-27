import { randomUUID } from "node:crypto";
import { z } from "zod";
import { pageStyle, redactText, RedactionSchema } from "../conversation-share.js";
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

export interface AnswerPage {
  id: string; title: string; question: string; body: string; sources: PageSource[];
  createdAt: string; updatedAt: string; revision: number;
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
<article><p>${escape(body.text)}</p></article>
${sources ? `<h2>Sources</h2><ol>${sources}</ol>` : ""}
<footer>A read-only page. It cannot run anything and is not connected to the assistant.</footer>
</main></body></html>\n`;
  return { html, blanked };
}

const fromRow = (row: Record<string, unknown>): AnswerPage => ({
  id: String(row.id), title: String(row.title), question: String(row.question), body: String(row.body),
  sources: JSON.parse(String(row.sources)) as PageSource[], createdAt: String(row.created_at),
  updatedAt: String(row.updated_at), revision: Number(row.revision),
});

export class AnswerPages {
  constructor(private readonly store: Store, private readonly owner: string) {
    store.sqlite.exec(`CREATE TABLE IF NOT EXISTS asks_pages(id TEXT PRIMARY KEY, owner TEXT NOT NULL, title TEXT NOT NULL,
      question TEXT NOT NULL, body TEXT NOT NULL, sources TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
  }
  /** Keeps a new page, or updates one (its revision moves on and its first date stays). */
  save(input: unknown): AnswerPage {
    requireAsk(this.store, this.owner, "answer-pages");
    const value = SavePageSchema.parse(input);
    const now = new Date().toISOString();
    const existing = value.id ? this.find(value.id) : null;
    if (value.id && !existing) throw new Error("That page was not found");
    const id = existing?.id ?? randomUUID();
    this.store.sqlite.prepare(`INSERT INTO asks_pages VALUES(?,?,?,?,?,?,?,?,?)
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
  /** The file to hand to someone else. */
  exportPage(id: string): { filename: string; html: string; blanked: number } {
    const page = this.get(id);
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
}
