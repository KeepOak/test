import { STEP_ICONS, type LiveStep } from "../live-steps.js";

/**
 * A task's steps as one chat message, the way Hermes Agent shows work in Telegram: one line per step with the step's
 * own emoji, a command or a script as a code block, a file as inline code, a repeat folded into "(×N)", and a last
 * line saying how it ended.
 *
 * The lines are the window's own lines (src/live-steps.ts `liveSteps`, with its one emoji table), so a step looks the
 * same in a chat as in the window; nothing is invented for a chat. What a chat leaves out:
 * - the model's thoughts (neither Hermes Agent nor OpenClaw sends reasoning to a chat unasked);
 * - questions (they go out as their own message with buttons);
 * - Branch finding its way to a tool (`tools.*`).
 *
 * The words come out as plain text plus `spans` saying which parts are code. Telegram turns the spans into message
 * entities, so a command gets Telegram's code block with its language label and copy button; an app that has no such
 * thing simply shows the plain text. Every piece is scrubbed (`scrub`) before a span is measured, so hiding a secret
 * can never shift a span onto the wrong words.
 */
export interface RichSpan { offset: number; length: number; kind: "block" | "inline"; language?: string }
export interface RichText { text: string; spans: RichSpan[] }
/** What a chat is shown of one task: its lines (as `liveSteps` gives them), how long it took, how it ended. */
export interface ChatStepsView { steps: LiveStep[]; seconds: number | null }
export interface RenderOptions {
  /** The longest message the chat app takes. */
  limit: number;
  /** Hides secrets in each piece of text before it is placed (the chat's leak guard). */
  scrub?: (text: string) => string;
  /** The task is over: a last line says how it ended. */
  final?: "done" | "error";
}

const COMMAND_KEY = "window.chat.live.running";
/** Longest command or first line of a script shown in a code block. */
const CODE_CLIP = 200;
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

/** One line of the message, before repeats are folded: its text and the spans inside it, measured from its start. */
interface Line { text: string; spans: RichSpan[] }

/** The steps a chat shows. */
export function chatSteps(steps: readonly LiveStep[]): LiveStep[] {
  return steps.filter((step) => step.kind !== "think" && step.kind !== "ask" && !(step.tool ?? "").startsWith("tools."));
}

/** A script's first line and its language, from the call's input, for `code.run`. */
function scriptOf(step: LiveStep): { code: string; language: string } | null {
  if (step.tool !== "code.run" || !step.input) return null;
  try {
    const input = JSON.parse(step.input) as { source?: unknown; language?: unknown };
    const first = typeof input.source === "string" ? input.source.split("\n").find((line) => line.trim()) ?? "" : "";
    const more = typeof input.source === "string" && input.source.trim().includes("\n");
    return first.trim() ? { code: first.trimEnd() + (more ? " …" : ""), language: input.language === "python" ? "python" : "javascript" } : null;
  } catch { return null; } // cut short or not JSON: the label alone is shown
}

function lineOf(step: LiveStep, scrub: (text: string) => string): Line {
  const lead = `${step.depth > 0 ? "↳ " : ""}${step.icon} `;
  const failed = step.state === "failed" ? ` ${STEP_ICONS.failed}${step.result ? ` ${clip(oneLine(scrub(step.result)), 160)}` : ""}` : "";
  const block = (head: string, code: string, language: string): Line => {
    const top = `${lead}${head}${failed}\n`;
    return { text: top + code, spans: [{ offset: top.length, length: code.length, kind: "block", language }] };
  };
  const command = step.say?.label?.key === COMMAND_KEY ? step.say.label.values?.command : undefined;
  if (typeof command === "string" && command.trim()) return block("Running", clip(scrub(command), CODE_CLIP), "shell");
  const script = scriptOf(step);
  const label = oneLine(scrub(step.label)) || (step.tool ?? "");
  if (script) return block(label, clip(scrub(script.code), CODE_CLIP), script.language);
  const text = `${lead}${label}${step.kind === "state" && step.result ? ` — ${oneLine(scrub(step.result))}` : ""}${failed}`;
  const path = step.path ? oneLine(scrub(step.path)) : "";
  const at = path ? text.indexOf(path, lead.length) : -1;
  return { text, spans: at >= 0 ? [{ offset: at, length: path.length, kind: "inline" }] : [] };
}

/** Consecutive lines that say the same thing become one, with "(×N)" after it. */
function fold(lines: Line[]): Line[] {
  const out: (Line & { times: number })[] = [];
  for (const line of lines) {
    const last = out.at(-1);
    if (last && last.text === line.text) { last.times++; continue; }
    out.push({ ...line, times: 1 });
  }
  return out.map(({ times, ...line }) => {
    if (times === 1) return line;
    // On the step's own first line, so it never lands inside or after a code block.
    const mark = ` (×${times})`, at = line.text.includes("\n") ? line.text.indexOf("\n") : line.text.length;
    return { text: line.text.slice(0, at) + mark + line.text.slice(at),
      spans: line.spans.map((span) => (span.offset >= at ? { ...span, offset: span.offset + mark.length } : span)) };
  });
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
/** "42 s", "3 min": how long the task worked. */
function took(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return "";
  return seconds >= 60 ? `${Math.round(seconds / 60)} min` : `${Math.max(1, Math.round(seconds))} s`;
}
function summary(count: number, seconds: number | null, final: "done" | "error"): string {
  const parts = [final === "done" ? `${STEP_ICONS.done} Done` : `${STEP_ICONS.failed} Stopped`, plural(count, "step", "steps"), took(seconds)];
  return parts.filter(Boolean).join(" · ");
}

/** Joins lines into one text, moving each line's spans to where the line lands. */
function join(lines: Line[]): RichText {
  let text = "";
  const spans: RichSpan[] = [];
  for (const line of lines) {
    if (text) text += "\n";
    for (const span of line.spans) spans.push({ ...span, offset: text.length + span.offset });
    text += line.text;
  }
  return { text, spans };
}

/** The whole progress message: the newest lines that fit, an "(N earlier)" line when some do not, and the ending. */
export function renderChatSteps(view: ChatStepsView, options: RenderOptions): RichText {
  const scrub = options.scrub ?? ((text: string) => text);
  const shown = chatSteps(view.steps);
  const lines = fold(shown.map((step) => lineOf(step, scrub)));
  const tail: Line[] = options.final ? [{ text: summary(shown.length, view.seconds, options.final), spans: [] }] : [];
  if (!lines.length && !tail.length) return { text: "Working on it…", spans: [] };
  const size = (list: Line[]) => list.reduce((sum, line) => sum + line.text.length + 1, 0);
  const room = options.limit - size(tail) - 20; // 20: the "(N earlier)" line
  const kept: Line[] = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    if (size(kept) + lines[i]!.text.length + 1 > room) break;
    kept.unshift(lines[i]!);
  }
  // A single line longer than the whole message (it cannot happen with the clips above) is cut, never sent too long.
  if (!kept.length && lines.length) kept.push({ text: clip(lines.at(-1)!.text.split("\n")[0]!, Math.max(1, room)), spans: [] });
  const earlier = lines.length - kept.length;
  return join([...(earlier > 0 ? [{ text: `(${earlier} earlier)`, spans: [] }] : []), ...kept, ...tail]);
}

/** The spans as Telegram message entities: a code block with its language label and copy button, or inline code. */
export function telegramEntities(spans: readonly RichSpan[]): Record<string, unknown>[] {
  return spans.map((span) => span.kind === "block"
    ? { type: "pre", offset: span.offset, length: span.length, ...(span.language ? { language: span.language } : {}) }
    : { type: "code", offset: span.offset, length: span.length });
}
