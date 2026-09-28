import { STEP_ICONS, stepCategory, type LiveStep, type StepCategory } from "../live-steps.js";

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
  /**
   * The owner's knobs (src/channels/steps-display.ts): `new` shows a step only when the tool changes, `verbose` whole
   * commands and each tool's input; `lineChars` bounds a line; `commands: "hide"` says only that a command ran.
   */
  detail?: "new" | "all" | "verbose";
  lineChars?: number;
  commands?: "show" | "hide";
}

const COMMAND_KEY = "window.chat.live.running";
/** The most of a whole command, a script or a tool's input shown in verbose detail. */
const VERBOSE_CLIP = 1500;
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, Math.max(1, max - 1))}…` : text);
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();
/** A sentence cut at a word, so repeated edits do not wrap differently (OpenClaw's compact lines). */
export function cutWords(text: string, max: number): string {
  if (text.length <= max) return text;
  const room = text.slice(0, Math.max(1, max - 1));
  const space = room.lastIndexOf(" ");
  return `${(space > max * 0.6 ? room.slice(0, space) : room).trimEnd()}…`;
}
/** A path cut in the middle, so the file's own name at its end stays visible (OpenClaw's middle ellipsis). */
export function cutMiddle(text: string, max: number): string {
  if (text.length <= max) return text;
  const tail = Math.ceil((max - 1) * 0.6), head = Math.max(1, max - 1 - tail);
  return `${text.slice(0, head)}…${text.slice(text.length - tail)}`;
}
/** A command's first line, cut at its end (Hermes Agent: the program and its first arguments are what matter). */
function commandLine(command: string, max: number): string {
  const lines = command.split("\n").filter((line) => line.trim());
  const first = (lines[0] ?? command).trimEnd();
  const more = lines.length > 1 ? " …" : "";
  return first.length + more.length > max ? clip(first, max) : first + more;
}

/** One line of the message, before repeats are folded: its text and the spans inside it, measured from its start. */
interface Line { text: string; spans: RichSpan[] }

/** The steps a chat shows. */
export function chatSteps(steps: readonly LiveStep[]): LiveStep[] {
  return steps.filter((step) => step.kind !== "think" && step.kind !== "ask" && !(step.tool ?? "").startsWith("tools."));
}
/** "Changes only" (Hermes Agent's `new`): a step whose tool is the one before it is left out, unless it failed. */
function changesOnly(steps: readonly LiveStep[]): LiveStep[] {
  return steps.filter((step, index) => index === 0 || !step.tool || step.tool !== steps[index - 1]!.tool || step.state === "failed");
}

/** A script and its language from the call's input, for `code.run`: its first line, or all of it in verbose detail. */
function scriptOf(step: LiveStep, whole: boolean): { code: string; language: string } | null {
  if (step.tool !== "code.run" || !step.input) return null;
  try {
    const input = JSON.parse(step.input) as { source?: unknown; language?: unknown };
    const source = typeof input.source === "string" ? input.source : "";
    const first = source.split("\n").find((line) => line.trim()) ?? "";
    const more = source.trim().includes("\n");
    const code = whole ? source.trim() : first.trimEnd() + (more ? " …" : "");
    return code.trim() ? { code, language: input.language === "python" ? "python" : "javascript" } : null;
  } catch { return null; } // cut short or not JSON: the label alone is shown
}

/** The words of a line, a path in them cut in the middle and the rest at a word; with where the path landed. */
function wordsOf(said: string, path: string, max: number): { words: string; path: string } {
  const at = path ? said.indexOf(path) : -1;
  if (at < 0) return { words: cutWords(said, max), path: "" };
  if (said.length <= max) return { words: said, path };
  const shown = cutMiddle(path, Math.max(12, max - (said.length - path.length)));
  const words = said.slice(0, at) + shown + said.slice(at + path.length);
  // Words before the path that still leave the line too long are cut, keeping the path whole where it fits.
  return words.length <= max || at + shown.length >= max ? { words, path: shown } : { words: cutWords(words, max), path: shown };
}

function lineOf(step: LiveStep, scrub: (text: string) => string, options: RenderOptions): Line {
  const max = options.lineChars ?? 120, verbose = options.detail === "verbose";
  const lead = `${step.depth > 0 ? "↳ " : ""}${step.icon} `;
  const failed = step.state === "failed" ? ` ${STEP_ICONS.failed}${step.result ? ` ${cutWords(oneLine(scrub(step.result)), Math.min(160, max))}` : ""}` : "";
  const block = (head: string, code: string, language: string): Line => {
    const top = `${lead}${head}${failed}\n`;
    return { text: top + code, spans: [{ offset: top.length, length: code.length, kind: "block", language }] };
  };
  const command = step.say?.label?.key === COMMAND_KEY ? step.say.label.values?.command : undefined;
  if (typeof command === "string" && command.trim()) {
    if (options.commands === "hide") return { text: `${lead}Running a command${failed}`, spans: [] };
    const shown = scrub(command);
    return block("Running", verbose ? clip(shown.trim(), VERBOSE_CLIP) : commandLine(shown, max), "shell");
  }
  const script = scriptOf(step, verbose);
  const label = oneLine(scrub(step.label)) || (step.tool ?? "");
  if (script) return block(cutWords(label, max), verbose ? clip(scrub(script.code), VERBOSE_CLIP) : clip(scrub(script.code), max), script.language);
  const said = step.kind === "state" && step.result ? `${label} — ${oneLine(scrub(step.result))}` : label;
  const { words, path } = wordsOf(said, step.path ? oneLine(scrub(step.path)) : "", max);
  const text = `${lead}${words}${failed}`;
  const at = path ? text.indexOf(path, lead.length) : -1;
  const line: Line = { text, spans: at >= 0 ? [{ offset: at, length: path.length, kind: "inline" }] : [] };
  // Verbose (Hermes Agent's /verbose): what the tool was given, as code under its line.
  if (verbose && step.input && step.kind === "tool") {
    const input = clip(scrub(step.input), VERBOSE_CLIP), top = `${text}\n`;
    return { text: top + input, spans: [...line.spans, { offset: top.length, length: input.length, kind: "block", language: "json" }] };
  }
  return line;
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
/** A single line longer than a whole message (a verbose input) is cut to fit; a code span is kept only while whole. */
function fitLine(line: Line, room: number): Line {
  if (line.text.length <= room) return line;
  const text = clip(line.text, Math.max(1, room));
  return { text, spans: line.spans.filter((span) => span.offset + span.length <= text.length - 1) };
}

/** The lines the message shows, folded, from the task's steps and the owner's knobs. */
function stepLines(view: ChatStepsView, options: RenderOptions): { lines: Line[]; tail: Line[] } {
  const scrub = options.scrub ?? ((text: string) => text);
  const shown = chatSteps(view.steps);
  const picked = options.detail === "new" ? changesOnly(shown) : shown;
  const lines = fold(picked.map((step) => lineOf(step, scrub, options)));
  const tail: Line[] = options.final ? [{ text: summary(shown.length, view.seconds, options.final), spans: [] }] : [];
  return { lines, tail };
}
const size = (list: Line[]) => list.reduce((sum, line) => sum + line.text.length + 1, 0);

/** The whole progress message: the newest lines that fit, an "(N earlier)" line when some do not, and the ending. */
export function renderChatSteps(view: ChatStepsView, options: RenderOptions): RichText {
  const { lines, tail } = stepLines(view, options);
  if (!lines.length && !tail.length) return { text: "Working on it…", spans: [] };
  const room = options.limit - size(tail) - 20; // 20: the "(N earlier)" line
  const kept: Line[] = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    if (size(kept) + lines[i]!.text.length + 1 > room) break;
    kept.unshift(lines[i]!);
  }
  if (!kept.length && lines.length) kept.push(fitLine(lines.at(-1)!, room));
  const earlier = lines.length - kept.length;
  return join([...(earlier > 0 ? [{ text: `(${earlier} earlier)`, spans: [] }] : []), ...kept, ...tail]);
}
/**
 * The steps as one or more messages (Hermes Agent's overflow): each message holds the lines that fit, in order, and a
 * list too long for one carries on in the next, so nothing is dropped. The last message ends with how the task ended.
 * `each` puts every line in a message of its own (Hermes Agent's "separate"), with no ending line.
 */
export function pageChatSteps(view: ChatStepsView, options: RenderOptions & { each?: boolean }): RichText[] {
  const { final, ...rest } = options;
  const { lines, tail } = stepLines(view, options.each || !final ? rest : { ...rest, final });
  if (!lines.length && !tail.length) return options.each ? [] : [{ text: "Working on it…", spans: [] }];
  const pages: Line[][] = [];
  let current: Line[] = [];
  for (const raw of lines) {
    const line = fitLine(raw, options.limit - size(tail) - 1);
    if (current.length && (options.each || size(current) + line.text.length + 1 > options.limit)) { pages.push(current); current = []; }
    current.push(line);
  }
  if (tail.length && current.length && size(current) + size(tail) > options.limit) { pages.push(current); current = []; }
  current.push(...tail);
  if (current.length) pages.push(current);
  return pages.map(join);
}

/** The spans as Telegram message entities: a code block with its language label and copy button, or inline code. */
export function telegramEntities(spans: readonly RichSpan[]): Record<string, unknown>[] {
  return spans.map((span) => span.kind === "block"
    ? { type: "pre", offset: span.offset, length: span.length, ...(span.language ? { language: span.language } : {}) }
    : { type: "code", offset: span.offset, length: span.length });
}

/* ---------- a group's short message: kinds and counts, never a name ---------- */
const times = (text: string, n: number) => (n > 1 ? `${text} (×${n})` : text);
const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
/** What each kind of step did, counted, in words that name no file, page, command or person. */
const KIND_WORDS: Partial<Record<StepCategory, (n: number) => string>> = {
  search: (n) => count(n, "search", "searches"),
  page: (n) => `Reading ${count(n, "web page", "web pages")}`,
  read: (n) => `Reading ${count(n, "file", "files")}`,
  write: (n) => `Writing ${count(n, "file", "files")}`,
  edit: (n) => `Changing ${count(n, "file", "files")}`,
  find: (n) => times("Searching files", n),
  files: (n) => times("Looking through files", n),
  command: (n) => `Running ${count(n, "command", "commands")}`,
  process: (n) => times("Managing a background program", n),
  code: (n) => `Running ${count(n, "script", "scripts")}`,
  memory: (n) => times("Checking memory", n),
  browser: (n) => times("Using the browser", n),
  helper: (n) => count(n, "helper", "helpers"),
  message: (n) => count(n, "message", "messages"),
  plan: (n) => times("Updating the plan", n),
  question: (n) => count(n, "question", "questions"),
  schedule: (n) => times("Updating a schedule", n),
  settings: (n) => times("Checking settings", n),
  git: (n) => times("Working with saved versions", n),
};
/**
 * The steps of a task in a group chat, where other people read along: one line per kind of step with its emoji and a
 * count ("📖 Reading 2 files"), in the order the kinds first came. No label, path, command or page is ever shown.
 */
export function kindLines(toolNames: readonly string[]): string[] {
  const counts = new Map<StepCategory, number>();
  for (const name of toolNames) {
    const kind = stepCategory(name);
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  return [...counts].map(([kind, n]) => `${STEP_ICONS[kind]} ${(KIND_WORDS[kind] ?? ((k: number) => count(k, "step", "steps")))(n)}`);
}

/* ---------- the same spans in each app's own way ---------- */
/**
 * The spans as Markdown code, for Discord and Slack: a block as a fence on its own lines, a file as `inline code`.
 * `tag` puts the language after the opening fence (Discord shows it; Slack would print it as a first code line, so it
 * gets none, as Hermes Agent found). A part that already holds backticks is left as plain words rather than broken.
 */
export function fenced(text: string, spans: readonly RichSpan[], options: { tag: boolean }): string {
  let out = "", at = 0;
  for (const span of [...spans].sort((a, b) => a.offset - b.offset)) {
    if (span.offset < at) continue;
    const words = text.slice(span.offset, span.offset + span.length);
    out += text.slice(at, span.offset);
    if (words.includes("`")) out += words;
    else if (span.kind === "block") out += `\`\`\`${options.tag ? span.language ?? "" : ""}\n${words}\n\`\`\``;
    else out += `\`${words}\``;
    at = span.offset + span.length;
  }
  return out + text.slice(at);
}
const html = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** The spans as Matrix's HTML (`formatted_body`): `<pre><code class="language-…">` for a block, `<code>` for a file. */
export function matrixHtml(text: string, spans: readonly RichSpan[]): string {
  let out = "", at = 0;
  const lines = (part: string) => html(part).replace(/\n/g, "<br>");
  for (const span of [...spans].sort((a, b) => a.offset - b.offset)) {
    if (span.offset < at) continue;
    const before = text.slice(at, span.offset), words = html(text.slice(span.offset, span.offset + span.length));
    if (span.kind === "block") {
      const language = span.language && /^[a-z0-9+-]{1,20}$/.test(span.language) ? ` class="language-${span.language}"` : "";
      out += lines(before.replace(/\n$/, "")) + `<pre><code${language}>${words}</code></pre>`;
    } else out += lines(before) + `<code>${words}</code>`;
    at = span.offset + span.length;
    if (span.kind === "block" && text[at] === "\n") at++; // the block ends its line
  }
  return out + lines(text.slice(at));
}
/**
 * One line for an app that cannot edit a message (WhatsApp, Signal, iMessage, email…), put above the reply once the
 * task is over: each kind of step as its emoji with a count, then how it ended ("📖×2 🔍 · ✅ Done · 3 steps · 12 s").
 * It names nothing, so no file, page or command is ever in it.
 */
export function compactSummary(view: ChatStepsView, final: "done" | "error"): string | null {
  const shown = chatSteps(view.steps);
  if (!shown.length) return null;
  const counts = new Map<string, number>();
  for (const step of shown) counts.set(step.icon, (counts.get(step.icon) ?? 0) + 1);
  const icons = [...counts].map(([icon, n]) => (n > 1 ? `${icon}×${n}` : icon)).join(" ");
  return `${icons} · ${summary(shown.length, view.seconds, final)}`;
}
