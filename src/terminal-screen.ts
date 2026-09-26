import { Canvas, fitText, textWidth, type CellStyle, type Hit, type Paint } from "./terminal-canvas.js";
import { MODEL_TABS, PANE_TABS, PLACES, SETTINGS_PAGES, placeById, type Route } from "./terminal-places.js";
import type { Row } from "./terminal-place-data.js";
import type { Glyphs } from "./terminal-style.js";
import type { TerminalPalette } from "./terminal-theme.js";
import type { Words } from "./terminal-words.js";
import { drawOak, type Season } from "./terminal-oak.js";
import type { RailItem, UsageBar } from "./terminal-everywhere.js"; // phase2/everywhere
import type { HeadFacts } from "./terminal-head.js";

/**
 * The terminal view, drawn from a plain description of what is on screen. It follows
 * `docs/design.md`: a head with the mark and the page, the five places as a tab row, the
 * conversation with a composer at its foot and a side pane that opens on demand, each place as a
 * title, one sentence, its tabs and its rows, and Settings as a window of named pages over it.
 * Nothing here reads the workspace or writes to the terminal: it only draws.
 */
/** phase2/everywhere: "ask" is the heading of a question a task stopped on, "askline" a line of it; drawn as one card. */
export interface TranscriptLine { kind: "you" | "assistant" | "step" | "note" | "warn" | "ok" | "bad" | "ask" | "askline"; text: string }
/** One choice in the palette or a picker; `run` is the slash command it stands for. */
export interface PaletteItem { label: string; section: string; hint?: string; run: string }
export type Overlay =
  | { kind: "palette"; query: string; items: PaletteItem[]; selected: number }
  | { kind: "help"; lines: string[]; offset: number }
  | { kind: "picker"; title: string; items: PaletteItem[]; selected: number };
export interface ScreenModel {
  words: Words;
  glyphs: Glyphs;
  assistant: string;
  model: string;
  lockdown: boolean;
  needs: number;
  working: boolean;
  frame: number;
  route: Route;
  /** The place under the Settings window, which stays drawn behind it. */
  behind: Route;
  focus: "composer" | "tabs" | "list" | "ask";
  transcript: TranscriptLine[];
  scroll: number;
  composer: { text: string; cursor: number; chips: string[]; question?: string };
  status: string;
  pane: { open: boolean; tab: string; rows: Row[] };
  oak: { show: boolean; season: Season };
  rows: Row[];
  selected: number;
  loading: boolean;
  ask: string;
  overlay?: Overlay | undefined;
  toast?: string | undefined;
  /* phase2/everywhere: the conversation's title in the head, the rail down the left, the usage line. */
  title?: string | undefined;
  rail?: RailItem[] | undefined;
  usage?: UsageBar | undefined;
  /* The prototype's head: this computer, the gateway on or off, the version, and each account window's share left. */
  head?: HeadFacts | undefined;
  /** Beside each rail mark, what that Trunk is doing now (empty when idle), drawn where the terminal is wide enough. */
  railStates?: string[] | undefined;
}
export interface Frame { lines: string[]; plain: string[]; cursor: { x: number; y: number } | null; hits: Hit[] }

const t = (model: ScreenModel, key: string, english: string, values?: Record<string, string | number>): string =>
  model.words.t(key, english, values);
const bar = (canvas: Canvas, y: number, bg: Paint): void => canvas.fill(0, y, canvas.columns, 1, bg);

/** Draws one whole frame. */
export function renderScreen(model: ScreenModel, size: { columns: number; rows: number }, palette: TerminalPalette,
  depth: Parameters<Canvas["lines"]>[1]): Frame {
  const columns = Math.max(20, size.columns), rows = Math.max(8, size.rows);
  const canvas = new Canvas(columns, rows);
  let top = drawHead(canvas, model);
  top = drawTabs(canvas, model, top);
  if (model.lockdown) top = drawLockdown(canvas, model, top);
  const foot = footLines(model, rows);
  const usageRow = model.usage && rows >= 16 ? 1 : 0;
  const area = { x: 0, y: top, width: columns, height: rows - top - foot.length - usageRow };
  let cursor: Frame["cursor"] = null;
  const route = model.route;
  if (!("settings" in route) && model.rail?.length && columns >= 100) {
    drawRail(canvas, model, model.rail, { x: 0, y: area.y, height: area.height });
    area.x += railWidth(columns);
    area.width -= railWidth(columns);
  }
  if ("settings" in route) cursor = drawSettings(canvas, model, area, route);
  else if (route.place === "chat") cursor = drawConversation(canvas, model, area);
  else cursor = drawPlace(canvas, model, area, route);
  if (usageRow && model.usage) drawUsage(canvas, model, model.usage, rows - foot.length - 1);
  foot.forEach((line, index) => drawFoot(canvas, model, rows - foot.length + index, line));
  if (model.overlay) cursor = drawOverlay(canvas, model, model.overlay);
  return { lines: canvas.lines(palette, depth), plain: canvas.plain(), cursor, hits: canvas.hits };
}

function drawHead(canvas: Canvas, model: ScreenModel): number {
  bar(canvas, 0, "panel");
  const g = model.glyphs;
  let x = canvas.text(1, 0, g.mark, { fg: "accent", bold: true });
  x = canvas.text(x + 1, 0, model.assistant, { fg: "text", bold: true });
  const title = pageTitle(model);
  const right = rightOfHead(model, canvas.columns);
  const room = canvas.columns - textWidth(right) - 3;
  canvas.text(x + 1, 0, fitText(`${g.dot} ${title}`, Math.max(0, room - x - 1), g.ellipsis), { fg: "muted" }, room);
  const start = canvas.columns - textWidth(right) - 1;
  if (model.working) canvas.text(start, 0, g.spinner[model.frame % g.spinner.length]!, { fg: "accent" });
  canvas.text(start + 2, 0, right.slice(2), { fg: model.lockdown ? "bad" : model.head ? "muted" : "ok" });
  return 1;
}
/**
 * The prototype's head, right side: this computer, the gateway on or off, what the tightest account has left and the
 * version (design/redesign/prototype.html termHTML). Where the view was drawn without them, the model answering.
 */
function rightOfHead(model: ScreenModel, columns: number): string {
  const g = model.glyphs, head = model.head;
  const shield = model.lockdown ? `${g.shield} ${t(model, "lockdown.label", "Lockdown")}  ` : "";
  if (!head) return `  ${shield}${g.live} ${fitText(model.model, 22, g.ellipsis)}`;
  const gateway = head.gateway ? `${g.live} ${t(model, "terminal.head.gatewayOn", "gateway on")}` : `${g.working} ${t(model, "terminal.head.gatewayOff", "gateway off")}`;
  const left = model.usage ? `${fitText(model.usage.name, 24, g.ellipsis)} ${t(model, "terminal.usage.left", "{n}% left", { n: model.usage.percentLeft })}` : "";
  const here = `${fitText(head.computer, 24, g.ellipsis)} ${gateway}`, version = head.version ?? "";
  // A narrow terminal keeps the page's name readable: the account's share goes first, then the version.
  const room = Math.floor(columns * 0.55);
  for (const parts of [[here, left, version], [here, version], [here]]) {
    const line = `  ${shield}${parts.filter(Boolean).join(` ${g.dot} `)}`;
    if (textWidth(line) <= room || parts.length === 1) return line;
  }
  return `  ${shield}${here}`;
}
/** "Inbox › Needs you", "Settings › Models › Defaults", or "Conversation". */
export function pageTitle(model: ScreenModel): string {
  const route = model.route, crumb = ` ${model.glyphs.crumb} `;
  if ("settings" in route) {
    const page = SETTINGS_PAGES.find((entry) => entry.id === route.settings)!;
    const sub = route.settings === "models" ? MODEL_TABS.find((entry) => entry.id === route.sub) : undefined;
    return [t(model, "settings.title", "Settings"), t(model, page.key, page.english), ...(sub ? [t(model, sub.key, sub.english)] : [])].join(crumb);
  }
  const place = placeById(route.place)!;
  const tab = place.tabs.find((entry) => entry.id === route.tab);
  if (route.place === "chat" && model.title) return `${t(model, place.key, place.english)}${crumb}${model.title}`; // phase2/everywhere
  return tab ? `${t(model, place.key, place.english)}${crumb}${t(model, tab.key, tab.english)}` : t(model, place.key, place.english);
}

function drawTabs(canvas: Canvas, model: ScreenModel, y: number): number {
  bar(canvas, y, "panel");
  const current = "place" in model.route ? model.route.place : "";
  const compact = PLACES.reduce((sum, place) => sum + textWidth(t(model, place.key, place.english)) + 5, 0) > canvas.columns - 8;
  let x = 1;
  PLACES.forEach((place, index) => {
    const on = place.id === current;
    const label = `${index + 1} ${t(model, place.key, place.english)}`;
    const count = place.id === "inbox" && model.needs ? ` ${model.needs}` : "";
    const style: CellStyle = on ? { fg: "accentText", bg: "accentTint", bold: true } : { fg: model.focus === "tabs" ? "text" : "muted" };
    const shown = compact && !on ? `${index + 1}` : label;
    const from = x;
    x = canvas.text(x, y, ` ${shown}`, style);
    if (count) x = canvas.text(x, y, count, { fg: "warn", bold: true, ...(on ? { bg: "accentTint" } : {}) });
    x = canvas.text(x, y, " ", on ? { bg: "accentTint" } : {});
    canvas.hit(from, y, x - from, 1, `place:${index + 1}`);
    x += compact ? 0 : 1;
  });
  const hint = `${ctrl(model)}+K ${t(model, "rail.find", "Find anything")}`;
  if (x + textWidth(hint) + 2 <= canvas.columns) canvas.text(canvas.columns - textWidth(hint) - 1, y, hint, { fg: "faint" });
  return y + 1;
}
function drawLockdown(canvas: Canvas, model: ScreenModel, y: number): number {
  bar(canvas, y, "bad");
  const words = `${t(model, "lockdown.on", "Lockdown is on. Commands are refused; all else asks you.")}  /lockdown off`;
  canvas.text(1, y, fitText(words, canvas.columns - 2, model.glyphs.ellipsis), { fg: "ground", bg: "bad", bold: true });
  return y + 1;
}
function drawFoot(canvas: Canvas, model: ScreenModel, y: number, hint: string): void {
  bar(canvas, y, "panel");
  const toast = model.toast !== undefined && hint === model.toast;
  canvas.text(1, y, fitText(hint, canvas.columns - 2, model.glyphs.ellipsis), { fg: toast ? "accentText" : "faint" });
}
/**
 * phase2/everywhere: the foot. A tall terminal in the conversation adds the window's key line under the
 * usual hints (Enter sends, Ctrl+C stops the task…), as the design's terminal shows it; anything else keeps one line.
 */
function footLines(model: ScreenModel, rows: number): string[] {
  const first = model.toast ?? footHint(model);
  const chat = "place" in model.route && model.route.place === "chat";
  if (rows < 30 || !chat || model.focus !== "composer" || model.overlay) return [first];
  // Both key lines, each naming only keys this view really answers to (src/terminal-keys.ts).
  const line1 = t(model, "terminal.keys.line", "Enter sends · Alt+Enter adds a line · Up recalls · Ctrl+E shows step details · Ctrl+C stops the task · Ctrl+D leaves");
  const line2 = t(model, "terminal.keys.line2", "Esc, then 1-6 (or Alt+1 to Alt+6): Conversation, Inbox, Automations, Library, Customize, Team · Ctrl+K or /: find anything");
  return [first, line1, line2];
}

/* ---------- phase2/everywhere: the rail and the usage line ---------- */
/**
 * The rail's width: one mark each from 100 columns, and from 140 the prototype's list, each name with what that Trunk is
 * doing beside it (design/redesign/prototype.html, the Trunks list with its states).
 */
const railWidth = (columns: number): number => (columns >= 140 ? 26 : 4);
/** This computer, the owner's other devices and Trunks, down the left as in the window. */
function drawRail(canvas: Canvas, model: ScreenModel, items: RailItem[], box: { x: number; y: number; height: number }): void {
  const width = railWidth(canvas.columns), named = width > 4;
  canvas.fill(box.x, box.y, width, box.height, "panel");
  for (let y = box.y; y < box.y + box.height; y++) canvas.text(box.x + width - 1, y, model.glyphs.v, { fg: "line", bg: "panel" });
  const room = Math.max(0, Math.floor((box.height - 1) / 2));
  items.slice(0, room).forEach((item, index) => {
    const y = box.y + 1 + index * 2;
    const style: CellStyle = item.on ? { fg: "accentText", bg: "accentTint", bold: true } : { fg: item.kind === "trunk" ? "accent" : "muted", bg: "panel" };
    const x = canvas.text(box.x, y, ` ${model.glyphs[item.kind]} `, style);
    if (named) {
      const state = model.railStates?.[index] ?? "";
      const end = canvas.text(x, y, fitText(item.name, width - 5 - (state ? Math.min(textWidth(state), 10) + 1 : 0), model.glyphs.ellipsis), { fg: item.on ? "text" : "muted", bg: "panel" });
      if (state) canvas.text(end + 1, y, fitText(state, box.x + width - end - 3, model.glyphs.ellipsis), { fg: "accent", bg: "panel" });
    }
    canvas.hit(box.x, y, width - 1, 1, `rail:${index}`);
  });
  if (items.length > room && room > 0) canvas.text(box.x + 1, box.y + box.height - 1, "+", { fg: "faint", bg: "panel" });
}
/** What the tightest connection has left, drawn as the window's ring says it: a bar, the share, when it refills. */
function drawUsage(canvas: Canvas, model: ScreenModel, usage: UsageBar, y: number): void {
  const g = model.glyphs, cells = 20, used = Math.round(((100 - usage.percentLeft) / 100) * cells);
  const tone: Paint = usage.percentLeft <= 5 ? "bad" : usage.percentLeft <= 20 ? "warn" : "accent";
  let x = canvas.text(1, y, ` ${fitText(usage.name, 28, g.ellipsis)} `, { fg: "text", bold: true });
  x = canvas.text(x + 1, y, g.full.repeat(used), { fg: tone });
  x = canvas.text(x, y, g.shade.repeat(cells - used), { fg: "faint" });
  const words = [t(model, "terminal.usage.left", "{n}% left", { n: usage.percentLeft }), usage.note].filter(Boolean).join(` ${g.dot} `);
  x = canvas.text(x + 2, y, fitText(words, Math.max(0, canvas.columns - x - 3), g.ellipsis), { fg: usage.percentLeft <= 20 ? tone : "muted" });
  // The prototype's status line: each window of that account (five hours, the week…) with its own short bar, where it fits.
  for (const window of model.head?.limits ?? []) {
    const filled = Math.round((window.percentLeft / 100) * 8);
    const piece = `${window.title} ${g.full.repeat(filled)}${g.shade.repeat(8 - filled)} ${window.percentLeft}%`;
    if (x + 3 + textWidth(piece) > canvas.columns - 1) break;
    x = canvas.text(x + 3, y, piece, { fg: "muted" });
  }
}
function footHint(model: ScreenModel): string {
  const dot = ` ${model.glyphs.dot} `;
  if (model.overlay) return [t(model, "terminal.keys.move", "Up and down move"), t(model, "terminal.keys.choose", "Enter chooses"), t(model, "terminal.keys.close", "Esc closes")].join(dot);
  if ("settings" in model.route) return [t(model, "terminal.keys.pages", "Left and right change page"), t(model, "terminal.keys.choose", "Enter chooses"), t(model, "terminal.keys.close", "Esc closes")].join(dot);
  const tab = t(model, "terminal.keys.tabPlaces", "Tab next place");
  if (model.focus === "composer") {
    const answer = model.composer.question ? t(model, "terminal.keys.answer", "y, n or s answers · a then Enter") : "";
    return [model.status, answer, `${ctrl(model)}+P ${t(model, "pane.label", "Side pane")}`, "Esc " + t(model, "terminal.keys.places", "then 1-6 for places"),
      model.composer.text ? "" : tab].filter(Boolean).join(dot);
  }
  return [t(model, "terminal.keys.number", "1-6 places"), t(model, "terminal.keys.tabs", "Left and right change tab"), tab, "? " + t(model, "menu.help", "Help")].join(dot);
}
/** The Control key as the terminal's language writes it (Strg in German). */
const ctrl = (model: ScreenModel): string => t(model, "terminal.key.ctrl", "Ctrl");

/* ---------- the conversation ---------- */
function drawConversation(canvas: Canvas, model: ScreenModel, area: { x: number; y: number; width: number; height: number }): Frame["cursor"] {
  const docked = model.pane.open && area.width >= 100;
  const paneWidth = Math.min(Math.max(32, Math.floor(area.width * 0.3)), 40, area.width - 10);
  const readWidth = docked ? area.width - paneWidth : area.width;
  const composerHeight = composerRows(model, readWidth);
  const reading = { x: area.x, y: area.y, width: readWidth, height: area.height - composerHeight };
  if (model.transcript.length) drawTranscript(canvas, model, reading);
  else drawWelcome(canvas, model, reading);
  const cursor = drawComposer(canvas, model, { x: area.x, y: area.y + area.height - composerHeight, width: readWidth, height: composerHeight });
  if (model.pane.open) drawPane(canvas, model, { x: area.x + area.width - paneWidth, y: area.y, width: paneWidth, height: docked ? area.height : area.height - composerHeight });
  return cursor;
}
const PREFIX: Record<TranscriptLine["kind"], Paint> = { you: "text", assistant: "text", step: "muted", note: "faint", warn: "warn", ok: "ok", bad: "bad",
  ask: "warn", askline: "text" };
const CARD = new Set<TranscriptLine["kind"]>(["you", "ask", "askline"]);
/** Every transcript line wrapped to the reading column, newest at the foot. */
export function wrapTranscript(lines: TranscriptLine[], width: number): { text: string; kind: TranscriptLine["kind"]; lead: boolean }[] {
  const out: { text: string; kind: TranscriptLine["kind"]; lead: boolean }[] = [];
  for (const line of lines)
    for (const [index, piece] of wrapColumns(line.text, width).entries()) out.push({ text: piece, kind: line.kind, lead: index === 0 });
  return out;
}
function drawTranscript(canvas: Canvas, model: ScreenModel, box: { x: number; y: number; width: number; height: number }): void {
  const inner = Math.min(box.width - 4, 100);
  const left = box.x + Math.max(2, Math.floor((box.width - inner) / 2));
  const wrapped = wrapTranscript(model.transcript, inner - 2);
  const end = Math.max(0, wrapped.length - model.scroll);
  const shown = wrapped.slice(Math.max(0, end - box.height), end);
  shown.forEach((line, index) => {
    const y = box.y + index, card = CARD.has(line.kind);
    if (card) canvas.fill(left - 1, y, inner + 2, 1, "raised");
    /* phase2/everywhere: a question the task stopped on is a card with a warning edge, as in the window. */
    const asking = line.kind === "ask" || line.kind === "askline";
    const lead = asking ? model.glyphs.v : line.lead && line.kind === "you" ? model.glyphs.pointer : " ";
    canvas.text(left - 1, y, lead, { fg: asking ? "warn" : "accent", ...(card ? { bg: "raised" } : {}), bold: asking });
    canvas.text(left + 1, y, line.text, { fg: PREFIX[line.kind], ...(card ? { bg: "raised" } : {}), bold: (line.kind === "you" || line.kind === "ask") && line.lead });
  });
  if (model.scroll > 0) canvas.text(box.x + box.width - 12, box.y + box.height - 1, `${model.glyphs.crumb} PgDn`, { fg: "accentText" });
}
function drawWelcome(canvas: Canvas, model: ScreenModel, box: { x: number; y: number; width: number; height: number }): void {
  const greeting = t(model, "terminal.welcome.title", "What shall we work on?");
  const line = t(model, "terminal.welcome.body", "Type below and press Enter. Esc, then 1 to 6, opens the other places; Ctrl+K finds anything.");
  const oakHeight = model.oak.show ? Math.min(10, box.height - 8) : 0;
  const lines = wrapColumns(line, Math.min(box.width - 4, 70));
  const total = oakHeight + 2 + lines.length;
  let y = box.y + Math.max(0, Math.floor((box.height - total) / 2));
  if (oakHeight >= 6) {
    const oakWidth = Math.min(box.width - 4, oakHeight * 3);
    drawOak(canvas, { x: box.x + Math.floor((box.width - oakWidth) / 2), y, width: oakWidth, height: oakHeight }, model.oak.season, model.glyphs);
    y += oakHeight + 1;
  }
  canvas.text(box.x + Math.floor((box.width - textWidth(greeting)) / 2), y, greeting, { fg: "text", bold: true });
  for (const [index, piece] of lines.entries())
    canvas.text(box.x + Math.floor((box.width - textWidth(piece)) / 2), y + 2 + index, piece, { fg: "muted" });
}
function composerRows(model: ScreenModel, width: number): number {
  const typed = model.composer.text.split("\n").reduce((sum, part) => sum + wrapColumns(part, width - 8).length, 0);
  return Math.min(8, Math.max(1, typed)) + 2;
}
function drawComposer(canvas: Canvas, model: ScreenModel, box: { x: number; y: number; width: number; height: number }): Frame["cursor"] {
  const g = model.glyphs, x = box.x + 1, width = box.width - 2;
  const edge: CellStyle = { fg: model.focus === "composer" ? "accent" : "line" };
  canvas.fill(x, box.y, width, box.height, "panel");
  canvas.text(x, box.y, g.tl + g.h.repeat(Math.max(0, width - 2)) + g.tr, { ...edge, bg: "panel" });
  let chipX = x + 2;
  for (const [index, chip] of model.composer.chips.entries())
    chipX = canvas.text(chipX, box.y, ` ${chip} `, { fg: index === 0 ? "accentText" : "muted", bg: "panel", bold: index === 0 }, x + width - 2) + 1;
  const bottom = box.y + box.height - 1;
  canvas.text(x, bottom, g.bl + g.h.repeat(Math.max(0, width - 2)) + g.br, { ...edge, bg: "panel" });
  const marker = model.composer.question ? `${model.composer.question} ` : `${g.pointer} `;
  const rows = layoutInput(model.composer.text, model.composer.cursor, width - 4 - textWidth(marker));
  for (let row = box.y + 1; row < bottom; row++) {
    canvas.text(x, row, g.v, { ...edge, bg: "panel" });
    canvas.text(x + width - 1, row, g.v, { ...edge, bg: "panel" });
  }
  canvas.text(x + 2, box.y + 1, marker, { fg: model.composer.question ? "warn" : "accent", bg: "panel", bold: true });
  const visible = rows.lines.slice(-(bottom - box.y - 1));
  const skipped = rows.lines.length - visible.length;
  const placeholder = model.composer.question
    ? t(model, "terminal.composer.answer", "Answer y (yes), n (no), a (yes, always) or s (yes, for this conversation)")
    : t(model, "terminal.composer.placeholder", "Describe what you want to do… (Enter sends, Alt+Enter adds a line)");
  if (!model.composer.text) canvas.text(x + 2 + textWidth(marker), box.y + 1, fitText(placeholder, width - 6 - textWidth(marker), g.ellipsis), { fg: "faint", bg: "panel" });
  visible.forEach((line, index) => canvas.text(x + 2 + textWidth(marker), box.y + 1 + index, line, { fg: "text", bg: "panel" }));
  return model.focus === "composer" && !model.overlay
    ? { x: x + 2 + textWidth(marker) + rows.cursor.x, y: box.y + 1 + rows.cursor.y - skipped } : null;
}
/** The typed text in rows no wider than the box, and where the cursor falls among them. */
export function layoutInput(text: string, cursor: number, width: number): { lines: string[]; cursor: { x: number; y: number } } {
  const lines: string[] = [];
  let at = { x: 0, y: 0 }, offset = 0;
  for (const part of text.split("\n")) {
    const pieces = chunk(part, Math.max(1, width));
    for (const [index, piece] of pieces.entries()) {
      const length = piece.length, last = index === pieces.length - 1;
      if (cursor >= offset && (cursor < offset + length || (last && cursor <= offset + length)))
        at = { x: textWidth(piece.slice(0, cursor - offset)), y: lines.length };
      lines.push(piece);
      offset += length;
    }
    offset += 1;
  }
  return { lines, cursor: at };
}
function chunk(text: string, width: number): string[] {
  if (!text) return [""];
  const out: string[] = [];
  let line = "", used = 0;
  for (const ch of text) {
    const w = textWidth(ch);
    if (used + w > width) { out.push(line); line = ""; used = 0; }
    line += ch;
    used += w;
  }
  out.push(line);
  return out;
}
/** Words wrapped to a number of columns, breaking inside a word only when it will not fit a line. */
export function wrapColumns(text: string, width: number): string[] {
  const out: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const word of paragraph.split(" ")) {
      const next = line ? `${line} ${word}` : word;
      if (textWidth(next) <= width) { line = next; continue; }
      if (line) out.push(line);
      line = "";
      for (const piece of chunk(word, Math.max(1, width))) {
        if (textWidth(piece) === width) out.push(piece);
        else line = piece;
      }
    }
    out.push(line);
  }
  return out;
}

function drawPane(canvas: Canvas, model: ScreenModel, box: { x: number; y: number; width: number; height: number }): void {
  canvas.fill(box.x, box.y, box.width, box.height, "panel");
  for (let y = box.y; y < box.y + box.height; y++) canvas.text(box.x, y, model.glyphs.v, { fg: "line", bg: "panel" });
  let x = box.x + 2;
  for (const tab of PANE_TABS) {
    const on = tab.id === model.pane.tab, label = t(model, tab.key, tab.english);
    canvas.hit(x, box.y, textWidth(label), 1, `pane:${tab.id}`);
    x = canvas.text(x, box.y, label, on ? { fg: "accentText", bg: "panel", bold: true, underline: true } : { fg: "muted", bg: "panel" }, box.x + box.width) + 2;
  }
  const rows = model.pane.rows.length ? model.pane.rows : [{ title: t(model, "terminal.pane.empty", "Nothing here yet in this conversation."), tone: "muted" as const }];
  drawRows(canvas, model, rows, { x: box.x + 2, y: box.y + 2, width: box.width - 3, height: box.height - 2 }, -1, "panel", "pane-row");
}

/* ---------- a place ---------- */
function drawPlace(canvas: Canvas, model: ScreenModel, area: { x: number; y: number; width: number; height: number },
  route: { place: string; tab: string }): Frame["cursor"] {
  const place = placeById(route.place)!;
  const x = area.x + 2, width = area.width - 4;
  canvas.text(x, area.y + 1, t(model, place.key, place.english).toUpperCase(), { fg: "text", bold: true });
  const intro = wrapColumns(t(model, place.intro[0], place.intro[1]), width).slice(0, 2);
  intro.forEach((line, index) => canvas.text(x, area.y + 2 + index, line, { fg: "muted" }));
  let y = area.y + 3 + intro.length, tabX = x;
  for (const tab of place.tabs) {
    const on = tab.id === route.tab, label = t(model, tab.key, tab.english);
    canvas.hit(tabX, y, textWidth(label) + 2, 1, `tab:${tab.id}`);
    tabX = canvas.text(tabX, y, ` ${label} `, on ? { fg: "accentText", bg: "accentTint", bold: true } : { fg: "muted" }) + 1;
  }
  canvas.text(x, y + 1, model.glyphs.h.repeat(Math.max(0, width)), { fg: "line" });
  const listTop = y + 2, askY = area.y + area.height - 2;
  const rows = model.loading ? [{ title: t(model, "terminal.loading", "Looking…"), tone: "muted" as const }]
    : model.rows.length ? model.rows : [emptyRow(model, `${route.place}:${route.tab}`)];
  drawRows(canvas, model, rows, { x, y: listTop, width, height: askY - listTop - 1 }, model.focus === "list" ? model.selected : -1, "ground");
  return drawAsk(canvas, model, { x, y: askY, width });
}
/** What an empty tab says: what the tab is for, and what to do next. */
export function emptyRow(model: ScreenModel, home: string): Row {
  const [key, english] = EMPTY[home] ?? ["terminal.empty.default", "Nothing here yet."];
  return { title: t(model, key, english), detail: t(model, "terminal.empty.next", "Ask below, or open the window for more."), tone: "muted" };
}
const EMPTY: Record<string, [string, string]> = {
  "inbox:needs": ["place.inbox.nothingWaits", "Nothing needs you right now."],
  "inbox:finished": ["place.inbox.nothingFinished", "Nothing finished in the last seven days."],
  "inbox:history": ["terminal.empty.history", "No tasks yet. Everything your assistant does will be listed here."],
  "automations:scheduled": ["terminal.empty.scheduled", "Nothing is scheduled. Ask for something to happen at a time."],
  "automations:procedures": ["terminal.empty.procedures", "No saved procedures yet. A procedure is a set of steps you can run again."],
  "automations:triggers": ["terminal.empty.triggers", "No triggers yet. A trigger starts work when something happens elsewhere."],
  "library:memory": ["terminal.empty.memory", "Nothing remembered yet. Tell your assistant what to keep."],
  "library:documents": ["terminal.empty.documents", "No documents yet. Documents you add can be searched while you work."],
  "library:made": ["terminal.empty.made", "Nothing made yet. Pages, pictures and reports it makes are kept here."],
  "customize:tools": ["terminal.empty.skills", "No skills yet. A skill is a page of instructions for one kind of work."],
  "customize:specialists": ["terminal.empty.specialists", "No specialists yet. A specialist is an assistant with one job."],
  "customize:channels": ["terminal.empty.channels", "No channels yet. A channel lets you reach your assistant from a chat app."],
};
function drawRows(canvas: Canvas, model: ScreenModel, rows: Row[], box: { x: number; y: number; width: number; height: number },
  selected: number, ground: Paint, action = "row"): void {
  const perRow = 2, visible = Math.max(1, Math.floor(box.height / perRow));
  const start = Math.max(0, Math.min(selected - visible + 1, rows.length - visible, selected >= 0 ? selected : 0));
  rows.slice(Math.max(0, start), Math.max(0, start) + visible).forEach((row, index) => {
    const at = Math.max(0, start) + index, y = box.y + index * perRow, on = at === selected;
    const bg: Paint = on ? "raised" : ground;
    canvas.hit(box.x - 1, y, box.width + 1, perRow, `${action}:${at}`);
    if (on) canvas.fill(box.x - 1, y, box.width + 1, 2, "raised");
    const fg: Paint = row.tone === "warn" ? "warn" : row.tone === "bad" ? "bad" : row.tone === "ok" ? "ok" : row.tone === "muted" ? "muted" : "text";
    canvas.text(box.x - 1, y, on ? model.glyphs.pointer : " ", { fg: "accent", bg });
    canvas.text(box.x + 1, y, fitText(row.title, box.width - 2, model.glyphs.ellipsis), { fg, bg, bold: on });
    if (row.detail) canvas.text(box.x + 1, y + 1, fitText(row.detail, box.width - 2, model.glyphs.ellipsis), { fg: "faint", bg });
  });
  if (rows.length > visible) {
    const more = `${Math.min(rows.length, start + visible)}/${rows.length}`;
    canvas.text(box.x + box.width - textWidth(more), box.y + box.height, more, { fg: "faint" });
  }
}
function drawAsk(canvas: Canvas, model: ScreenModel, at: { x: number; y: number; width: number }): Frame["cursor"] {
  const focused = model.focus === "ask";
  canvas.fill(at.x, at.y, at.width, 1, "panel");
  const marker = `${model.glyphs.pointer} `;
  canvas.text(at.x + 1, at.y, marker, { fg: focused ? "accent" : "faint", bg: "panel", bold: true });
  const room = at.width - 3 - textWidth(marker);
  const shown = model.ask ? fitText(model.ask.slice(-room), room) : t(model, "place.ask", "Ask your assistant anything…");
  canvas.text(at.x + 1 + textWidth(marker), at.y, shown, { fg: model.ask ? "text" : "faint", bg: "panel" });
  return focused && !model.overlay ? { x: at.x + 1 + textWidth(marker) + Math.min(textWidth(model.ask), room), y: at.y } : null;
}

/* ---------- Settings, a window over the place ---------- */
function drawSettings(canvas: Canvas, model: ScreenModel, area: { x: number; y: number; width: number; height: number },
  route: { settings: string; sub: string }): Frame["cursor"] {
  const narrow = area.width < 86;
  const box = narrow ? area : { x: area.x + 2, y: area.y + 1, width: area.width - 4, height: area.height - 2 };
  canvas.fill(box.x, box.y, box.width, box.height, "panel");
  if (!narrow) frame(canvas, model, box, t(model, "settings.title", "Settings"));
  const navWidth = narrow ? 0 : 24;
  const body = { x: box.x + navWidth + 3, y: box.y + (narrow ? 2 : 1), width: box.width - navWidth - 5, height: box.height - (narrow ? 2 : 2) };
  if (narrow) drawPageStrip(canvas, model, box, route.settings);
  else settingsNavWindow(route.settings, box.height - 2).forEach((page, index) => {
    const on = page.id === route.settings, y = box.y + 1 + index;
    canvas.hit(box.x + 2, y, navWidth - 1, 1, `page:${page.id}`);
    canvas.text(box.x + 2, y, fitText(`${on ? model.glyphs.pointer : " "} ${t(model, page.key, page.english)}`, navWidth - 1, model.glyphs.ellipsis),
      on ? { fg: "accentText", bg: "accentTint", bold: true } : { fg: "muted", bg: "panel" });
  });
  const page = SETTINGS_PAGES.find((entry) => entry.id === route.settings)!;
  canvas.text(body.x, body.y, t(model, page.key, page.english).toUpperCase(), { fg: "text", bg: "panel", bold: true });
  const intro = wrapColumns(t(model, page.intro[0], page.intro[1]), body.width).slice(0, 2);
  intro.forEach((line, index) => canvas.text(body.x, body.y + 1 + index, line, { fg: "muted", bg: "panel" }));
  let y = body.y + 2 + intro.length;
  if (route.settings === "models") {
    let x = body.x;
    for (const tab of MODEL_TABS) canvas.hit(x, y, textWidth(t(model, tab.key, tab.english)) + 2, 1, `sub:${tab.id}`), x = canvas.text(x, y, ` ${t(model, tab.key, tab.english)} `, tab.id === route.sub ? { fg: "accentText", bg: "accentTint", bold: true } : { fg: "muted", bg: "panel" }) + 1;
    y += 2;
  }
  const rows = model.loading ? [{ title: t(model, "terminal.loading", "Looking…"), tone: "muted" as const }] : model.rows;
  drawRows(canvas, model, rows, { x: body.x + 1, y, width: body.width - 1, height: box.y + box.height - y - 1 }, model.selected, "panel");
  return null;
}
function settingsNavWindow(current: string, visible: number): typeof SETTINGS_PAGES {
  const count = Math.max(1, visible);
  const index = Math.max(0, SETTINGS_PAGES.findIndex((page) => page.id === current));
  const start = Math.max(0, Math.min(index - Math.floor(count / 2), SETTINGS_PAGES.length - count));
  return SETTINGS_PAGES.slice(start, start + count);
}
function drawPageStrip(canvas: Canvas, model: ScreenModel, box: { x: number; y: number; width: number }, current: string): void {
  const index = SETTINGS_PAGES.findIndex((entry) => entry.id === current);
  const label = (at: number): string => { const page = SETTINGS_PAGES[at]; return page ? t(model, page.key, page.english) : ""; };
  const g = model.glyphs;
  const strip = `${t(model, "settings.title", "Settings")} ${g.crumb} ${label(index)}  (${index + 1}/${SETTINGS_PAGES.length})`;
  canvas.fill(box.x, box.y, box.width, 1, "raised");
  canvas.text(box.x + 1, box.y, fitText(strip, box.width - 2, g.ellipsis), { fg: "text", bg: "raised", bold: true });
  const around = `${label(index - 1) ? "< " + label(index - 1) : ""}   ${label(index + 1) ? label(index + 1) + " >" : ""}`;
  canvas.text(box.x + 1, box.y + 1, fitText(around.trim(), box.width - 2, g.ellipsis), { fg: "faint", bg: "panel" });
}
function frame(canvas: Canvas, model: ScreenModel, box: { x: number; y: number; width: number; height: number }, title: string): void {
  const g = model.glyphs, edge: CellStyle = { fg: "line", bg: "panel" };
  canvas.text(box.x, box.y, g.tl + g.h.repeat(Math.max(0, box.width - 2)) + g.tr, edge);
  canvas.text(box.x, box.y + box.height - 1, g.bl + g.h.repeat(Math.max(0, box.width - 2)) + g.br, edge);
  for (let y = box.y + 1; y < box.y + box.height - 1; y++) {
    canvas.text(box.x, y, g.v, edge);
    canvas.text(box.x + box.width - 1, y, g.v, edge);
  }
  canvas.text(box.x + 2, box.y, ` ${title} `, { fg: "text", bg: "panel", bold: true });
}

/* ---------- the palette, help and pickers ---------- */
/** The widest the Help box is drawn. */
export const HELP_WIDTH = 110;
/**
 * Help's lines wrapped to the box a terminal of this width draws, so no description is cut: a command's line goes on
 * under its own description, lined up with it.
 */
export function wrapHelp(lines: string[], columns: number): string[] {
  const room = Math.max(20, Math.min(HELP_WIDTH, columns - 4) - 4);
  return lines.flatMap((line) => {
    const lead = /^\/\S.*?\s{2,}/.exec(line)?.[0].length ?? 0;
    const pieces = wrapColumns(line.slice(lead), Math.max(10, room - lead));
    return pieces.map((piece, index) => (index === 0 ? line.slice(0, lead) : " ".repeat(lead)) + piece);
  });
}
function drawOverlay(canvas: Canvas, model: ScreenModel, overlay: Overlay): Frame["cursor"] {
  // Help is wide enough for its lines (each is wrapped to it when it is opened); a list stays narrow.
  const width = Math.min(overlay.kind === "help" ? HELP_WIDTH : 72, canvas.columns - 4), height = Math.min(canvas.rows - 4, 18);
  const box = { x: Math.floor((canvas.columns - width) / 2), y: 2, width, height };
  canvas.fill(box.x, box.y, box.width, box.height, "panel");
  if (overlay.kind === "help") {
    frame(canvas, model, box, t(model, "menu.help", "Help"));
    const shown = overlay.lines.slice(overlay.offset, overlay.offset + height - 2);
    shown.forEach((line, index) => canvas.text(box.x + 2, box.y + 1 + index, fitText(line, width - 4, model.glyphs.ellipsis), { fg: index === 0 && overlay.offset === 0 ? "accentText" : "text", bg: "panel" }));
    if (overlay.lines.length > height - 2) {
      const more = `${Math.min(overlay.lines.length, overlay.offset + height - 2)}/${overlay.lines.length}`;
      canvas.text(box.x + width - textWidth(more) - 2, box.y + height - 1, more, { fg: "faint", bg: "panel" });
    }
    return null;
  }
  const title = overlay.kind === "palette" ? t(model, "terminal.palette.title", "Find anything") : overlay.title;
  frame(canvas, model, box, title);
  let top = box.y + 1, cursor: Frame["cursor"] = null;
  if (overlay.kind === "palette") {
    const marker = `${model.glyphs.pointer} `;
    canvas.text(box.x + 2, top, marker + overlay.query, { fg: "text", bg: "panel", bold: true }, box.x + width - 2);
    cursor = { x: box.x + 2 + textWidth(marker) + textWidth(overlay.query), y: top };
    top += 2;
  }
  const rows = overlay.items.map((item) => ({ title: item.label, detail: [item.section, item.hint].filter(Boolean).join(` ${model.glyphs.dot} `) }));
  const empty = [{ title: t(model, "terminal.palette.none", "Nothing matches that."), tone: "muted" as const }];
  drawRows(canvas, model, rows.length ? rows : empty, { x: box.x + 3, y: top, width: width - 5, height: box.y + height - top - 1 }, overlay.selected, "panel", "item");
  return cursor;
}
