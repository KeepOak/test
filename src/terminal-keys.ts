import type { Key } from "node:readline";
import type { Hit } from "./terminal-canvas.js";
import type { MouseEvent } from "./terminal-input.js";
import { findCommand, terminalCommands } from "./terminal-command-table.js";
import { MODEL_TABS, settingsPage } from "./terminal-places.js";
import { paletteItems } from "./terminal-palette.js";
import type { Tui } from "./terminal-tui.js";

/**
 * What each key means in the drawn view. The composer gets every key it can use; Escape steps out
 * of it without touching what was typed, and from there the digits 1 to 5 open the places, as the
 * window's keyboard does. Alt+1 to Alt+5 (which a terminal sends as Escape then the digit) work from
 * anywhere. Returning true means the key was used here.
 */
const isChat = (tui: Tui): boolean => "place" in tui.route && tui.route.place === "chat";
const printable = (str: string | undefined, key: Key): boolean =>
  typeof str === "string" && str.length === 1 && str >= " " && str !== "\x7f" && !key.ctrl && !key.meta;
const digit = (key: Key): number => (/^[1-5]$/.test(key.name ?? "") ? Number(key.name) : 0);

export function routeKey(tui: Tui, str: string | undefined, key: Key): boolean {
  if (tui.overlay) return overlayKey(tui, str, key);
  if (key.ctrl && !["k", "n", "p", "r"].includes(key.name ?? "")) return false;
  if (key.ctrl && key.name === "k") { tui.openPalette(); return true; }
  if (key.ctrl && key.name === "n") { tui.newConversation(); return true; }
  if ((key.ctrl && key.name === "p") || key.name === "f2") { tui.togglePane(); return true; }
  if (key.name === "f1") { tui.keys(); return true; }
  if (key.meta && digit(key)) { tui.goPlace(digit(key)); return true; }
  if ("settings" in tui.route) return settingsKey(tui, str, key);
  if (isChat(tui)) return chatKey(tui, str, key);
  return placeKey(tui, str, key);
}

function scroll(tui: Tui, lines: number): void {
  tui.scroll = Math.max(0, tui.scroll + lines);
  tui.requestDraw();
}
function chatKey(tui: Tui, str: string | undefined, key: Key): boolean {
  if (key.name === "pageup") { scroll(tui, 10); return true; }
  if (key.name === "pagedown") { scroll(tui, -10); return true; }
  if (tui.focus === "composer") {
    if (key.name === "escape") { tui.focus = "tabs"; tui.requestDraw(); return true; }
    if (str === "/" && !tui.editor.text && !tui.conversation.awaiting) { tui.openPalette("/"); return true; }
    return false;
  }
  if (digit(key)) { tui.goPlace(digit(key)); return true; }
  if (key.name === "right") { tui.goPlace(2); return true; }
  if (key.name === "up") { scroll(tui, 1); return true; }
  if (key.name === "down") { scroll(tui, -1); return true; }
  if (str === "?") { tui.keys(); return true; }
  tui.focus = "composer";
  tui.requestDraw();
  return key.name === "escape" || key.name === "return";
}

function move(tui: Tui, by: number, count: number): void {
  tui.selected = Math.max(0, Math.min(Math.max(0, count - 1), tui.selected + by));
  tui.requestDraw();
}
function openRow(tui: Tui): void {
  const row = tui.rows[tui.selected];
  if (row?.command) void tui.command(row.command);
  else if (row?.sessionId) tui.resume(row.sessionId);
}
function placeKey(tui: Tui, str: string | undefined, key: Key): boolean {
  if (tui.focus === "ask") {
    if (key.name === "escape" || key.name === "tab" || key.name === "up") { tui.leaveAsk(); tui.requestDraw(); return true; }
    return false;
  }
  if (digit(key)) { tui.goPlace(digit(key)); return true; }
  const moves: Record<string, () => void> = {
    escape: () => tui.go({ place: "chat", tab: "" }),
    up: () => move(tui, -1, tui.rows.length), down: () => move(tui, 1, tui.rows.length),
    pageup: () => move(tui, -5, tui.rows.length), pagedown: () => move(tui, 5, tui.rows.length),
    left: () => tui.step(-1), right: () => tui.step(1),
    return: () => openRow(tui), tab: () => tui.enterAsk(),
  };
  const action = moves[key.name ?? ""];
  if (action && !key.ctrl && !key.meta) { action(); return true; }
  if (key.ctrl && key.name === "r") { void tui.reload(); return true; }
  if (str === "/") { tui.openPalette("/"); return true; }
  if (str === "?") { tui.keys(); return true; }
  if (printable(str, key)) { tui.enterAsk(); return false; }
  return true;
}

function nextModelTab(tui: Tui, direction: 1 | -1): void {
  if (!("settings" in tui.route) || tui.route.settings !== "models") return;
  const index = MODEL_TABS.findIndex((tab) => tab.id === (tui.route as { sub: string }).sub);
  tui.go({ settings: "models", sub: MODEL_TABS[(index + direction + MODEL_TABS.length) % MODEL_TABS.length]!.id });
}
function settingsKey(tui: Tui, str: string | undefined, key: Key): boolean {
  if (digit(key)) { tui.goPlace(digit(key)); return true; }
  const moves: Record<string, () => void> = {
    escape: () => tui.closeSettings(),
    up: () => move(tui, -1, tui.rows.length), down: () => move(tui, 1, tui.rows.length),
    left: () => tui.step(-1), right: () => tui.step(1),
    tab: () => nextModelTab(tui, key.shift ? -1 : 1),
    return: () => openRow(tui),
  };
  const action = moves[key.name ?? ""];
  if (action && !key.ctrl) action();
  else if (str === "/") tui.openPalette("/");
  else if (str === "?") tui.keys();
  return true;
}

function overlayMove(tui: Tui, by: number): void {
  const overlay = tui.overlay;
  if (!overlay) return;
  if (overlay.kind === "help") {
    overlay.offset = Math.max(0, Math.min(overlay.lines.length - 1, overlay.offset + by));
    return tui.requestDraw();
  }
  overlay.selected = Math.max(0, Math.min(overlay.items.length - 1, overlay.selected + by));
  const item = overlay.items[overlay.selected];
  if (overlay.kind === "picker" && item?.run.startsWith("/theme ")) {
    tui.previewTheme = item.run.slice(7);
    tui.readLook(true);
  }
  tui.requestDraw();
}
function choose(tui: Tui): void {
  const overlay = tui.overlay;
  if (!overlay || overlay.kind === "help") return tui.closeOverlay();
  const typed = overlay.kind === "palette" ? overlay.query.trim() : "";
  const item = overlay.items[overlay.selected];
  tui.overlay = undefined;
  tui.previewTheme = undefined;
  if (typed.startsWith("/") && findCommand(typed.split(/\s+/)[0]!, tui.commandMode())) return void tui.command(typed);
  if (!item) return tui.closeOverlay();
  const entry = findCommand(item.run.split(/\s+/)[0]!, tui.commandMode());
  if (entry?.args.startsWith("<") && item.run === `/${entry.name}`) {
    tui.go({ place: "chat", tab: "" });
    tui.editor.clear();
    tui.editor.insert(`/${entry.name} `);
    return;
  }
  void tui.command(item.run);
}
function typeInPalette(tui: Tui, str: string | undefined, key: Key): void {
  const overlay = tui.overlay;
  if (!overlay || overlay.kind !== "palette") return;
  if (key.name === "backspace") {
    if (!overlay.query) return tui.closeOverlay();
    overlay.query = overlay.query.slice(0, -1);
  } else if (printable(str, key)) overlay.query += str;
  else return;
  const recent = tui.runtime.store.recentSessions(tui.runtime.owner, 8).sessions;
  overlay.items = paletteItems(tui.words, recent, overlay.query, tui.style.unicode ? " › " : " > ", terminalCommands(tui.commandMode()));
  overlay.selected = 0;
  tui.requestDraw();
}
function overlayKey(tui: Tui, str: string | undefined, key: Key): boolean {
  if (key.ctrl && (key.name === "c" || key.name === "d")) return false;
  if (key.name === "escape" || (key.ctrl && key.name === "k")) { tui.closeOverlay(); return true; }
  if (key.name === "return" || key.name === "enter") { choose(tui); return true; }
  const moves: Record<string, number> = { up: -1, down: 1, pageup: -8, pagedown: 8 };
  if (moves[key.name ?? ""] !== undefined) { overlayMove(tui, moves[key.name!]!); return true; }
  if (tui.overlay?.kind === "help") {
    // Any other key closes the help and then does what it always does.
    tui.closeOverlay();
    return routeKey(tui, str, key);
  }
  typeInPalette(tui, str, key);
  return true;
}

/* ---------- clicks and the wheel, when the owner switched them on ---------- */
const inside = (hit: Hit, event: MouseEvent): boolean =>
  event.x >= hit.x && event.x < hit.x + hit.width && event.y >= hit.y && event.y < hit.y + hit.height;

export function routeMouse(tui: Tui, event: MouseEvent, hits: Hit[]): void {
  if (event.kind === "wheel-up" || event.kind === "wheel-down") {
    const by = event.kind === "wheel-up" ? -1 : 1;
    if (tui.overlay) return overlayMove(tui, by * 3);
    if (isChat(tui)) return scroll(tui, -by * 3);
    if ("settings" in tui.route && hits.some((hit) => hit.action.startsWith("page:") && inside(hit, event)))
      return tui.step(by);
    return move(tui, by, tui.rows.length);
  }
  if (event.kind !== "press" || event.button !== 0) return;
  const hit = [...hits].reverse().find((entry) => inside(entry, event));
  if (tui.overlay && !hit?.action.startsWith("item:")) return tui.closeOverlay();
  if (!hit) return;
  clickOn(tui, hit.action);
}
function clickOn(tui: Tui, action: string): void {
  const [kind, value = ""] = action.split(":");
  if (kind === "place") return tui.goPlace(Number(value));
  if (kind === "tab" && "place" in tui.route) return tui.go({ place: tui.route.place, tab: value });
  if (kind === "pane") return tui.togglePane(value);
  if (kind === "page") return tui.go(settingsPage(value));
  if (kind === "sub") return tui.go({ settings: "models", sub: value });
  if (kind === "row") { tui.selected = Number(value); tui.focus = "list"; return openRow(tui); }
  if (kind === "item" && tui.overlay && tui.overlay.kind !== "help") { tui.overlay.selected = Number(value); return choose(tui); }
  if (kind === "rail") return tui.railSay(Number(value)); // phase2/everywhere
}
