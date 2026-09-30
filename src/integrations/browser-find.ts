import { z } from 'zod';
import type { Mark } from './browser-marks.js';

/** Searches the labels and roles already read from the current page; it never performs an action. */
export const FindSchema = z.object({
  description: z.string().trim().min(1).max(300),
  limit: z.number().int().min(1).max(10).default(5),
}).strict();

const filler = new Set(['the', 'a', 'an', 'please', 'find', 'me', 'called', 'named', 'labelled', 'labeled', 'with']);
const roles: Readonly<Record<string, readonly string[]>> = {
  button: ['button', 'input:submit', 'input:button', 'input:reset'],
  link: ['link'], tab: ['tab'], checkbox: ['checkbox', 'input:checkbox'],
  radio: ['radio', 'input:radio'], dropdown: ['select', 'combobox'],
  select: ['select', 'combobox'], field: ['input:', 'textarea', 'textbox'],
  input: ['input:', 'textarea', 'textbox'], textbox: ['input:', 'textarea', 'textbox'],
};
const words = (text: string): string[] => text.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

/** Words are literal label words, with optional role words such as "the Save button". No inferred synonyms. */
export function matchingMarks(marks: readonly Mark[], description: string): Mark[] {
  const parts = words(description), roleWords = parts.filter(part => Object.hasOwn(roles, part));
  const wanted = parts.filter(part => !filler.has(part) && !Object.hasOwn(roles, part));
  if (!wanted.length) throw new Error('Include the words on the element or its label, such as "the Save button".');
  return marks.filter(mark => {
    if (mark.role === 'input:password') return false;
    if (!roleWords.every(word => roles[word]!.some(role => role === 'input:' ? mark.role.startsWith(role) : mark.role === role))) return false;
    const name = new Set(words(mark.name));
    return wanted.every(word => name.has(word));
  });
}
