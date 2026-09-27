import type { Page } from 'playwright';
import { z } from 'zod';
import { scrubText } from './browser-page.js';

/**
 * Pulling a page apart into a shape the assistant asked for. The assistant says what it wants —
 * a name for each field, whether it is words, a number, a yes/no or a date, and where on the page
 * to read it from — and gets back either data that fits that shape exactly, or a refusal naming
 * the field that did not fit. Nothing is guessed: a field that is not there is reported as missing
 * rather than filled in.
 */
const fieldTypes = ['text', 'number', 'boolean', 'date', 'url'] as const;
export const SchemaFieldSchema = z.object({
  /** Where to read this field from, inside each row. Leave it out to read the row's own words. */
  selector: z.string().min(1).max(300).optional(),
  type: z.enum(fieldTypes).default('text'),
  /** Read this attribute instead of the words, for example "href" on a link. */
  attribute: z.string().regex(/^[a-zA-Z][a-zA-Z0-9:_-]{0,40}$/).optional(),
  /** A field that must be there. A row missing it makes the whole thing a refusal. */
  required: z.boolean().default(false),
}).strict();
export const ExtractSchemaSchema = z.object({
  /** The repeated block to read, such as a table row or a card. Leave it out to read the page once. */
  rows: z.string().min(1).max(300).optional(),
  fields: z.record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/), SchemaFieldSchema).refine(
    value => Object.keys(value).length >= 1 && Object.keys(value).length <= 25,
    'Give between one and twenty-five fields'),
  limit: z.number().int().min(1).max(100).default(25),
}).strict();
export type ExtractSchemaInput = z.infer<typeof ExtractSchemaSchema>;

/** A value read off the page, before it is checked against the shape that was asked for. */
type RawRow = Record<string, string | null>;

/** Turns the shape the assistant asked for into the checker that decides whether the page fits. */
export function validatorFor(input: ExtractSchemaInput): z.ZodType<Record<string, unknown>> {
  const shape: Record<string, z.ZodType> = {};
  for (const [name, field] of Object.entries(input.fields)) {
    const base = field.type === 'number' ? z.number().finite()
      : field.type === 'boolean' ? z.boolean()
      : field.type === 'date' ? z.string().regex(/^\d{4}-\d{2}-\d{2}/, 'a date such as 2026-09-16')
      : field.type === 'url' ? z.string().url()
      : z.string().min(1);
    shape[name] = field.required ? base : base.nullable();
  }
  return z.object(shape).strict();
}

/** Turns one piece of page text into the kind of value the field asked for, or null when it cannot. */
export function coerce(value: string | null, type: (typeof fieldTypes)[number]): unknown {
  const text = (value ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  if (type === 'text') return text.slice(0, 2000);
  if (type === 'number') {
    const digits = text.replace(/[^0-9eE.+-]/g, '');
    const parsed = Number(digits);
    return digits && Number.isFinite(parsed) ? parsed : null;
  }
  if (type === 'boolean') {
    if (/^(yes|true|on|1|✓|checked)$/i.test(text)) return true;
    if (/^(no|false|off|0|✗|unchecked)$/i.test(text)) return false;
    return null;
  }
  if (type === 'date') {
    const iso = /(\d{4})-(\d{2})-(\d{2})/.exec(text);
    if (iso) return iso[0];
    const parsed = new Date(text);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
  }
  try { return new URL(text).toString(); } catch { return null; }
}

/**
 * Reads the page and hands back data that fits the shape asked for. A row that does not fit is
 * refused by name and by field, so the assistant can fix its request rather than act on guesswork.
 */
export async function extractSchema(page: Page, input: ExtractSchemaInput, hidden: readonly string[] = []): Promise<{
  url: string; rows: Record<string, unknown>[]; matched: number; truncated: boolean;
}> {
  const plan = Object.entries(input.fields).map(([name, field]) => ({ name,
    selector: field.selector ?? null, attribute: field.attribute ?? null }));
  const found = await page.evaluate(readRows, { rows: input.rows ?? null, limit: input.limit, plan });
  const validator = validatorFor(input);
  const rows = found.rows.map((raw, index) => {
    const shaped: Record<string, unknown> = {};
    // A secret a box holds is taken out before the text is read as anything, so a code never comes back as a number.
    for (const [name, field] of Object.entries(input.fields)) shaped[name] = coerce(scrubbed(raw[name] ?? null, hidden), field.type);
    const checked = validator.safeParse(shaped);
    if (!checked.success) {
      const issue = checked.error.issues[0];
      throw new Error(`Row ${index + 1} does not fit the shape you asked for: `
        + `"${issue?.path.join('.') ?? 'a field'}" ${issue?.message ?? 'did not fit'}. `
        + 'Check the selector for that field, or mark it as not required.');
    }
    return checked.data;
  });
  return { url: page.url(), rows, matched: found.matched, truncated: found.matched > rows.length };
}

/** A value read off the page with every secret a box holds taken out (browser-page.ts, scrubText). */
function scrubbed(value: string | null, hidden: readonly string[]): string | null {
  return value === null ? null : scrubText(value, hidden);
}

/** Runs inside the page. Reads the requested places out of each row, as plain text, nothing more. */
function readRows(options: {
  rows: string | null; limit: number;
  plan: { name: string; selector: string | null; attribute: string | null }[];
}): { rows: RawRow[]; matched: number } {
  const read = (scope: Element, field: { selector: string | null; attribute: string | null }): string | null => {
    const target = field.selector ? scope.querySelector(field.selector) : scope;
    if (!target) return null;
    return field.attribute ? target.getAttribute(field.attribute) : (target.textContent ?? '');
  };
  const scopes = options.rows ? [...document.querySelectorAll(options.rows)] : [document.body];
  const rows: RawRow[] = [];
  for (const scope of scopes.slice(0, options.limit)) {
    const row: RawRow = {};
    // Long enough that a secret in it is still whole when it is taken out; `coerce` cuts it to 2000 after that.
    for (const field of options.plan) row[field.name] = read(scope, field)?.slice(0, 6000) ?? null;
    rows.push(row);
  }
  return { rows, matched: scopes.length };
}
