import { z } from "zod";
import { errorText } from "./contracts.js";

const sentence = (message: string): string => {
  const plain = message.replace(/^Invalid input:\s*/i, "").replace(/[\s.]+$/g, "").replace(/\s+/g, " ");
  return `${plain}.`;
};

/* A field's name only when it looks like one a schema declares: a key the request itself chose (a record's key, an
   unknown field) can be anything, a pasted secret included, and is never repeated back. No digits: key-shaped values
   carry them, the schemas' own field names do not. */
const plainKey = (key: PropertyKey): boolean => typeof key === "string" && /^[A-Za-z_][A-Za-z_-]{0,31}$/.test(key);
const fieldName = (path: PropertyKey[]): string => path.every((part) => typeof part === "number" || plainKey(part))
  ? path.reduce<string>((name, part) => typeof part === "number" ? `${name}[${part}]` : name ? `${name}.${String(part)}` : String(part), "")
  : "";

export const isRequestShapeError = (error: unknown): error is z.ZodError => error instanceof z.ZodError;

/* Zod's own wording ("Too small: expected string to have >=1 characters"); a message a schema wrote itself is kept. */
const stock = /^(Too small|Too big|Invalid|Unrecognized key)/;
type Issue = z.ZodError["issues"][number];
const bound = (issue: Issue): number => Number((issue as { minimum?: unknown; maximum?: unknown }).minimum ?? (issue as { maximum?: unknown }).maximum);
const origin = (issue: Issue): string => String((issue as { origin?: unknown }).origin ?? "");

function sizeText(issue: Issue, name: string, least: boolean): string {
  const n = bound(issue), kind = origin(issue), word = least ? "at least" : "at most";
  if (kind === "string") return least && n <= 1 ? `${name} cannot be empty.` : `${name} needs ${word} ${n} characters.`;
  if (kind === "array" || kind === "set") return `${name} needs ${word} ${n} ${n === 1 ? "item" : "items"}.`;
  return `${name} must be ${word} ${n}.`;
}

/** One issue in plain words: which field and what it needs. Never the value that was sent. */
function issueText(issue: Issue): string {
  if (issue.code === "unrecognized_keys") {
    const key = issue.keys[0];
    return key !== undefined && plainKey(key) ? `"${key}" is not an accepted field.` : "The request has a field that is not accepted.";
  }
  const field = fieldName(issue.path), name = field ? `"${field}"` : "The request";
  if (!stock.test(issue.message)) return issue.message; // the schema's own sentence, as it wrote it
  if (issue.code === "too_small") return sizeText(issue, name, true);
  if (issue.code === "too_big") return sizeText(issue, name, false);
  if (issue.code === "invalid_value") return `${name} must be one of: ${issue.values.map(String).join(", ")}.`;
  if (issue.code === "invalid_format") return `${name} is not in the right format.`;
  if (issue.code === "invalid_type" && /received undefined$/.test(issue.message)) return `${name} is missing.`;
  return `${name} is not valid: ${sentence(issue.message)}`;
}

/**
 * The one place a validation failure becomes words for a person: a sentence per problem (up to three), naming the field
 * and what it needs, never Zod's own dump. Every route that answers a validation failure answers this.
 */
export function validationText(error: z.ZodError): string {
  if (!error.issues.length) return "The request is not in the expected shape.";
  return error.issues.slice(0, 3).map(issueText).join(" ");
}

/** One owner-readable sentence for a malformed request; never Zod's JSON issue dump. */
export function requestErrorText(error: unknown): string {
  return isRequestShapeError(error) ? validationText(error) : errorText(error);
}
