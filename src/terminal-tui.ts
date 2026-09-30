import type { EventEmitter } from "node:events";
import type { Readable, Writable } from "node:stream";
import type { Runtime } from "./runtime.js";
import { lockdownState, setLockdown } from "./lockdown.js";
import { LineEditor, type MouseEvent } from "./terminal-input.js";
import { glyphsFor, progressIndicator, resolveStyle, windowTitle, wrap, type TerminalStyle } from "./terminal-style.js";
import {
  LOOK_LANGUAGES, loadThemeCatalogue, lookLanguage, lookMode, paletteFor, readLook, saveLook, saveLookMode, saveTerminalSwitch,
  terminalSwitches, type Look, type LookMode, type TerminalPalette, type TerminalSwitches, type ThemeCatalogue,
} from "./terminal-theme.js";
import { loadWords, type Words } from "./terminal-words.js";
import { Conversation } from "./terminal-conversation.js";
import { runCommand, helpLines, terminalCommands, type CommandContext } from "./terminal-command-table.js";
// Wave mac3 (commands): the shared table's switch, and what its commands can reach.
import { commandMode } from "./commands/settings.js";
import { commandHost } from "./commands/host.js";
import type { FeatureMode } from "./feature-switches.js";
import { PLACE_ROWS, assistantName, needsCount, type PlaceApp, type Row } from "./terminal-place-data.js";
import { knowCopysCommit, settingsRows } from "./terminal-settings.js";
import { PLACES, SETTINGS_PAGES, firstTab, homeOf, parseRoute, placeById, settingsPage, type PlaceId, type Route } from "./terminal-places.js";
import { renderScreen, wrapHelp, type Overlay, type PaletteItem, type ScreenModel } from "./terminal-screen.js";
import { ScreenWriter } from "./terminal-output.js";
import type { Hit } from "./terminal-canvas.js";
import { paletteItems, themeItems } from "./terminal-palette.js";
import { seasonOf } from "./terminal-oak.js";
import { routeKey, routeMouse } from "./terminal-keys.js";
// R17-S16/S21: the owner's status line, the comfort settings as controls, and the model picker.
import { switchComfort, terminalStatus } from "./comfort/terminal.js";
import { readComfort } from "./comfort/settings.js";
import type { OutboundNetwork } from "./comfort/network.js";
import { activeModel, sessionTotals } from "./terminal-commands.js";
import { railItems, usageBar, type EverywhereApp, type RailItem, type UsageBar } from "./terminal-everywhere.js"; // phase2/everywhere
import { headFacts, railStates, type HeadFacts } from "./terminal-head.js";

export { usageLine, runCost, stepRow } from "./terminal-conversation.js";

/**
 * `branch` and `branch chat` in a terminal: the window's design in character cells. The five
 * places sit on a tab row (keys 1 to 6 after Escape, or Alt+1 to Alt+6), the conversation has its
 * composer and a side pane, every place lists what it holds, Settings opens its pages by name,
 * and Ctrl+K finds anything. A terminal that cannot be drawn on (NO_COLOR, TERM=dumb) gets the same
 * commands as plain lines.
 */
export interface TuiOptions {
  input?: Readable & { setRawMode?: (mode: boolean) => void; isTTY?: boolean };
  output?: Writable & { columns?: number; rows?: number };
  env?: NodeJS.ProcessEnv;
  signals?: EventEmitter;
  pollIntervalMs?: number;
  /** What the places read from; without it they say where to look instead. */
  app?: PlaceApp;
  /** Where to open: "inbox", "settings models", and so on. */
  route?: string;
  sessionId?: string;
}
export function startTui(runtime: Runtime, options: TuiOptions = {}): Promise<void> {
  return new Tui(runtime, options).start();
}

type Focus = ScreenModel["focus"];
const CHAT: Route = { place: "chat", tab: "" };

export class Tui {
  readonly env: NodeJS.ProcessEnv;
  readonly input: NonNullable<TuiOptions["input"]>;
  readonly output: NonNullable<TuiOptions["output"]>;
  readonly signals: EventEmitter;
  readonly style: TerminalStyle;
  readonly screen: ScreenWriter | null;
  readonly conversation: Conversation;
  readonly editor: LineEditor;
  readonly app: PlaceApp | undefined;
  words: Words = loadWords("en");
  catalogue: ThemeCatalogue | undefined;
  palette: TerminalPalette | undefined;
  look!: Look;
  mode: LookMode | "follow" = "dark";
  switches!: TerminalSwitches;
  route: Route = CHAT;
  behind: Route = CHAT;
  lastTab: Record<string, string> = {};
  focus: Focus = "composer";
  rows: Row[] = [];
  selected = 0;
  loading = false;
  pane = { open: false, tab: "activity", auto: false };
  overlay: Overlay | undefined;
  previewTheme: string | undefined;
  drafts = { composer: "", ask: "" };
  scroll = 0;
  hits: Hit[] = [];
  private frame = 0;
  private spinner: NodeJS.Timeout | undefined;
  private toast: string | undefined;
  private toastTimer: NodeJS.Timeout | undefined;
  private drawPending = false;
  private printed = 0;
  private lookReadAt = 0;
  private needs = 0;
  /* phase2/everywhere: the rail and the usage line, read with the look (at most once a second). */
  rail: RailItem[] = [];
  private usage: UsageBar | undefined;
  /* The prototype's head (this computer, the gateway, the version) and each Trunk's state beside its name. */
  private head: HeadFacts | undefined;
  private railStates: string[] = [];
  private closing = false;
  private resolveDone: (() => void) | undefined;

  constructor(readonly runtime: Runtime, private readonly options: TuiOptions) {
    this.env = options.env ?? process.env;
    this.input = options.input ?? process.stdin;
    this.output = options.output ?? process.stdout;
    this.signals = options.signals ?? process;
    this.app = options.app;
    this.style = resolveStyle(this.env, { columns: this.output.columns, rows: this.output.rows });
    this.screen = this.style.cursor ? new ScreenWriter(this.output) : null;
    this.conversation = new Conversation(runtime, (kind) => this.onConversation(kind), options.pollIntervalMs ?? 75);
    this.editor = new LineEditor({
      submit: (text) => void this.submit(text),
      interrupt: () => this.conversation.interrupt(),
      quit: () => this.quit(),
      shortcut: (name) => this.shortcut(name),
      changed: () => this.requestDraw(),
      key: (str, key) => (this.screen ? routeKey(this, str, key) : false),
    });
    this.readLook(true);
  }

  start(): Promise<void> {
    const done = new Promise<void>((resolve) => { this.resolveDone = resolve; });
    this.editor.attach(this.input, (event) => this.onMouse(event));
    this.signals.on("SIGINT", this.onSignal);
    this.input.once("end", this.quit);
    this.output.on?.("resize", this.onResize);
    void this.boot();
    return done;
  }
  private async boot(): Promise<void> {
    this.catalogue = await loadThemeCatalogue().catch(() => undefined);
    this.readLook(true);
    if (this.options.sessionId) this.resume(this.options.sessionId);
    if (this.screen) {
      this.screen.enter(windowTitle(this.style, "Branch Agent"));
      this.screen.setMouse(this.switches.mouse === "on");
      if (this.switches.sidePane === "on") this.pane.open = true;
    } else this.print("Branch Agent — type a message and press Enter. /help lists what you can do here.");
    if (this.options.route) this.open(this.options.route);
    this.requestDraw();
  }

  /* ---------- the look, read from the shared settings ---------- */
  readLook(force = false): void {
    if (!force && Date.now() - this.lookReadAt < 1000) return;
    this.lookReadAt = Date.now();
    const { store, owner } = this.runtime;
    this.look = readLook(store, owner);
    this.switches = terminalSwitches(store, owner);
    const saved = store.get("settings", owner, "preferences")?.data ?? {};
    this.mode = saved.followSystem === true ? "follow" : saved.appearance === "daylight" ? "light" : "dark";
    const language = lookLanguage(this.look, this.env);
    if (language !== this.words.language) this.words = loadWords(language);
    if (this.catalogue) this.palette = paletteFor(this.catalogue, this.previewTheme ?? this.look.theme, lookMode(store, owner, this.env), this.look.contrast);
    this.needs = this.app ? needsCount(this.app) : 0;
    // phase2/everywhere: answers are headed with the assistant's own name, in the drawn and the plain view alike.
    this.conversation.assistant = this.app ? assistantName(this.app) : "Branch Agent";
    this.readEverywhere();
    this.screen?.setMouse(this.switches.mouse === "on" || (this.switches.mouse === "when-needed" && (!!this.overlay || "settings" in this.route)));
  }
  /** phase2/everywhere: a failure to read either leaves it out rather than stopping the view. */
  private readEverywhere(): void {
    if (!this.app) return;
    const app = this.app as unknown as EverywhereApp;
    try { this.rail = railItems(app, this.words, this.conversation.sessionId); } catch { this.rail = []; }
    try { this.usage = usageBar(app, this.words); } catch { this.usage = undefined; }
    this.head = headFacts(this.app, this.runtime, this.words);
    this.railStates = railStates(this.app, this.rail, this.words);
  }
  /** A click on the rail says what that mark is. */
  railSay(index: number): void {
    const item = this.rail[index];
    if (item) this.say(`${item.name} ${this.style.unicode ? "·" : "-"} ${item.detail}`);
  }
  themeName(): string {
    return this.catalogue?.THEMES.find((theme) => theme[0] === this.look.theme)?.[1] ?? this.look.theme;
  }

  /* ---------- drawing ---------- */
  size(): { columns: number; rows: number } {
    return { columns: this.output.columns ?? this.style.columns, rows: this.output.rows ?? this.style.rows };
  }
  requestDraw(): void {
    if (this.drawPending || this.closing) return;
    this.drawPending = true;
    setImmediate(() => { this.drawPending = false; this.draw(); });
  }
  private draw(): void {
    if (this.closing) return;
    if (!this.screen) return this.echoPrompt();
    this.readLook();
    if (!this.palette) return;
    const frame = renderScreen(this.model(), this.size(), this.palette, this.style.depth);
    this.hits = frame.hits;
    this.screen.draw(frame);
  }
  model(): ScreenModel {
    const { rows } = this.size();
    const oak = this.switches.oak === "on" || (this.switches.oak === "when-needed" && rows >= 30);
    const partial = this.conversation.partial;
    return {
      words: this.words, glyphs: glyphsFor(this.style.unicode), assistant: this.app ? assistantName(this.app) : "Branch Agent",
      model: this.conversation.modelName(), lockdown: lockdownState(this.runtime.store, this.runtime.owner).on,
      needs: this.needs, working: this.conversation.working, frame: this.frame, route: this.route, behind: this.behind,
      focus: this.focus, scroll: this.scroll,
      transcript: partial ? [...this.conversation.transcript, { kind: "assistant", text: partial }] : this.conversation.transcript,
      composer: {
        text: this.focus === "ask" ? this.drafts.composer : this.editor.text, cursor: this.focus === "ask" ? 0 : this.editor.at,
        chips: this.conversation.chips(this.words), ...(this.conversation.awaiting ? { question: "y/n/a/s?" } : {}),
      },
      status: this.comfortStatus() ?? this.conversation.status(this.words), // R17-S16
      pane: { open: this.pane.open, tab: this.pane.tab, rows: this.conversation.paneRows(this.pane.tab, this.words) },
      oak: { show: oak && this.style.unicode, season: seasonOf(new Date()) },
      rows: this.rows, selected: this.selected, loading: this.loading,
      ask: this.focus === "ask" ? this.editor.text : this.drafts.ask, overlay: this.overlay, toast: this.toast,
      title: this.conversation.title(), rail: this.rail, usage: this.usage, // phase2/everywhere
      ...(this.head ? { head: this.head } : {}), railStates: this.railStates,
    };
  }
  say(text: string): void {
    if (!this.screen) { this.print(text); return; }
    this.toast = text;
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => { this.toast = undefined; this.requestDraw(); }, 4000);
    this.toastTimer.unref?.();
    this.requestDraw();
  }

  /* ---------- plain lines, for a terminal that cannot be drawn on ---------- */
  print(text: string): void {
    for (const line of wrap(text, Math.max(24, this.style.columns))) this.output.write(line + "\n");
  }
  private echoPrompt(): void {
    if (this.input.isTTY !== true || this.closing) return;
    const marker = this.conversation.awaiting ? "Answer (y/n/a/s)> " : "You> ";
    this.output.write("\r" + marker + this.editor.text.split("\n").join(" ") + " \x08");
  }
  private onConversation(kind: "line" | "work"): void {
    if (kind === "work") this.onWork();
    if (this.screen) { this.scroll = 0; this.requestDraw(); return; }
    const lines = this.conversation.transcript;
    if (this.printed > lines.length) this.printed = 0;
    for (; this.printed < lines.length; this.printed++) if (lines[this.printed]!.kind !== "you") this.print(lines[this.printed]!.text);
  }
  private onWork(): void {
    const working = this.conversation.working;
    this.output.write(progressIndicator(this.style, working ? "working" : "none"));
    if (working && !this.spinner && this.screen) {
      this.spinner = setInterval(() => { this.frame++; this.requestDraw(); }, 120);
      this.spinner.unref?.();
    }
    if (!working) { clearInterval(this.spinner); this.spinner = undefined; void this.reload(); }
    if (this.switches.sidePane === "when-needed" && this.size().columns >= 60) {
      if (working && !this.pane.open) this.pane = { ...this.pane, open: true, auto: true };
      if (!working && this.pane.auto) this.pane = { ...this.pane, open: false, auto: false };
    }
  }

  /* ---------- where the view is ---------- */
  open(text: string): void {
    const route = parseRoute(text.trim(), this.words);
    if (!route) { this.conversation.say("warn", this.words.t("terminal.noPlace", "There is no place called {name}. Try /go inbox or /settings models.", { name: text.trim() })); return; }
    this.go(route);
  }
  go(route: Route): void {
    if ("place" in route && route.place !== "chat" && !route.tab) route = { place: route.place, tab: this.lastTab[route.place] ?? firstTab(route.place) };
    if ("settings" in route && !("settings" in this.route)) this.behind = this.route;
    if ("place" in route) this.lastTab[route.place] = route.tab;
    this.leaveAsk();
    this.route = route;
    this.selected = 0;
    this.overlay = undefined;
    this.focus = "place" in route && route.place === "chat" ? "composer" : "list";
    this.output.write(windowTitle(this.style, `Branch Agent — ${homeOf(route)}`));
    void this.reload();
    if (!this.screen) void this.printPlace();
    this.readLook(true);
    this.requestDraw();
  }
  closeSettings(): void { this.go(this.behind); }
  async reload(): Promise<void> {
    const route = this.route, home = homeOf(route);
    if ("place" in route && route.place === "chat") { this.rows = []; return; }
    this.rows = await this.rowsFor(route).catch((error: unknown) => [{ title: String(error instanceof Error ? error.message : error), tone: "bad" as const }]);
    if (homeOf(this.route) !== home) return;
    this.loading = false;
    this.selected = Math.max(0, Math.min(this.selected, this.rows.length - 1));
    this.requestDraw();
  }
  private async rowsFor(route: Route): Promise<Row[]> {
    if (!this.app) return [{ title: this.words.t("terminal.noApp", "Open Branch to see this."), tone: "muted" }];
    if ("settings" in route) {
      const state = { look: this.look, mode: this.mode, themeName: this.themeName(), switches: this.switches };
      await knowCopysCommit();
      return settingsRows(this.app, this.words, route.settings, route.sub, state);
    }
    this.loading = true;
    return PLACE_ROWS[homeOf(route)]!(this.app, this.words);
  }
  private async printPlace(): Promise<void> {
    const route = this.route;
    if ("place" in route && route.place === "chat") return this.print(this.words.t("nav.chat", "Conversation"));
    const rows = await this.rowsFor(route);
    const title = "place" in route ? placeById(route.place)! : SETTINGS_PAGES.find((page) => page.id === route.settings)!;
    this.print(`== ${this.words.t(title.key, title.english)} ${"place" in route ? this.tabName(route) : route.sub} ==`);
    this.print(this.words.t(title.intro[0], title.intro[1]));
    for (const row of rows) this.print(`- ${row.title}${row.detail ? " — " + row.detail : ""}${row.command ? `  (${row.command})` : ""}`);
    if ("place" in route) this.print(placeById(route.place)!.tabs.map((tab) => `/${route.place} ${tab.id}`).join(" · "));
  }
  private tabName(route: { place: PlaceId; tab: string }): string {
    const tab = placeById(route.place)?.tabs.find((entry) => entry.id === route.tab);
    return tab ? `› ${this.words.t(tab.key, tab.english)}` : "";
  }
  /** The next or previous tab of a place, or page of Settings. */
  step(direction: 1 | -1): void {
    const route = this.route;
    if ("settings" in route) {
      const index = SETTINGS_PAGES.findIndex((page) => page.id === route.settings);
      const next = SETTINGS_PAGES[(index + direction + SETTINGS_PAGES.length) % SETTINGS_PAGES.length]!;
      return this.go(settingsPage(next.id));
    }
    const place = placeById(route.place);
    if (!place || !place.tabs.length) return;
    const index = place.tabs.findIndex((tab) => tab.id === route.tab);
    this.go({ place: route.place, tab: place.tabs[(index + direction + place.tabs.length) % place.tabs.length]!.id });
  }
  goPlace(number: number): void {
    const place = PLACES[number - 1];
    if (place) this.go({ place: place.id as PlaceId, tab: "" });
  }
  /** Tab and Shift+Tab: the next or the last place on the tab row, round from the last to the first (Overview is off the row). */
  nextPlace(direction: 1 | -1): void {
    const at = "place" in this.route ? PLACES.findIndex((place) => place.id === (this.route as { place: string }).place) : -1;
    const index = at < 0 ? (direction === 1 ? 0 : PLACES.length - 1) : (at + direction + PLACES.length) % PLACES.length;
    this.goPlace(index + 1);
  }
  /** One key answers the question a task stopped on, as the prototype's y / a / n; the answer is bound to that question. */
  answer(key: string): void {
    if (!this.conversation.awaiting) return;
    void this.conversation.send(key);
  }

  /* ---------- the ask box and the composer share one line editor ---------- */
  enterAsk(): void {
    if (this.focus === "ask") return;
    this.drafts.composer = this.editor.text;
    this.swapEditor(this.drafts.ask);
    this.focus = "ask";
    this.requestDraw();
  }
  leaveAsk(): void {
    if (this.focus !== "ask") return;
    this.drafts.ask = this.editor.text;
    this.swapEditor(this.drafts.composer);
    this.focus = "list";
  }
  private swapEditor(text: string): void {
    this.editor.clear();
    if (text) this.editor.insert(text);
  }

  /* ---------- input ---------- */
  private async submit(text: string): Promise<void> {
    if (this.closing) return;
    const trimmed = text.trim();
    if (this.focus === "ask") {
      this.drafts.ask = "";
      this.focus = "list";
      this.swapEditor(this.drafts.composer);
      if (!trimmed) return;
      this.go(CHAT);
      return this.conversation.send(trimmed);
    }
    this.requestDraw();
    if (!trimmed) return;
    if (this.conversation.awaiting) return this.conversation.send(trimmed);
    if (trimmed.startsWith("/")) return this.command(trimmed);
    this.scroll = 0;
    await this.conversation.send(trimmed);
  }
  async command(text: string): Promise<void> {
    await runCommand(this.commandContext(), text);
    this.requestDraw();
  }
  private shortcut(name: string): void {
    if (name === "ctrl+e") {
      this.conversation.details = !this.conversation.details;
      this.conversation.say("note", `[step details ${this.conversation.details ? "on" : "off"}]`);
      if (this.conversation.details) for (const step of this.conversation.steps) this.conversation.say("step", `    ${step.tool} — ${step.detail || step.label} (${step.status})`);
    }
    if (name === "ctrl+l") { this.screen?.invalidate(); this.requestDraw(); }
  }
  private onSignal = (): void => this.conversation.interrupt();
  private onResize = (): void => { this.screen?.invalidate(); this.requestDraw(); };
  private onMouse(event: MouseEvent): void {
    if (this.screen) routeMouse(this, event, this.hits);
  }

  /* ---------- what the commands can reach ---------- */
  commandContext(): CommandContext {
    return {
      runtime: this.runtime, conversation: this.conversation, words: this.words,
      say: (kind, text) => this.conversation.say(kind, text),
      open: (route) => (typeof route === "string" ? this.open(route) : this.go(route)),
      theme: (argument) => this.theme(argument),
      togglePane: (tab) => this.togglePane(tab),
      lockdown: (argument) => this.lockdown(argument),
      switchSetting: (name, value) => this.switchSetting(name, value),
      resume: (id) => this.resume(id),
      sessions: () => this.sessions(),
      newConversation: () => this.newConversation(),
      quit: () => this.quit(),
      keys: () => this.keys(),
      pickModel: () => this.pickModel(), // R17-S21
      host: commandHost(this.runtime, this.app),
      ...(this.app ? { app: this.app } : {}),
      pick: (title, items) => this.pick(title, items),
    };
  }
  /** A list to choose from, drawn over the view; Enter runs the chosen row's command. */
  pick(title: string, items: PaletteItem[]): boolean {
    if (!this.screen) return false;
    this.overlay = { kind: "picker", title, items, selected: 0 };
    this.requestDraw();
    return true;
  }
  /** Wave mac3 (commands): where the owner's switch for the shared commands is. */
  commandMode(): FeatureMode {
    return commandMode(this.runtime.store, this.runtime.owner, "terminal");
  }
  newConversation(): void {
    if (this.conversation.sessionId) this.runtime.stopHelpers(this.conversation.sessionId); // helper-lifecycle
    this.conversation.reset();
    this.printed = 0;
    this.go(CHAT);
    this.conversation.say("note", "[new conversation; the next message starts it]");
  }
  resume(id: string): void {
    const found = this.runtime.store.recentSessions(this.runtime.owner, 100).sessions.find((entry) => entry.sessionId === id || entry.sessionId.startsWith(id));
    if (!found) { this.conversation.say("warn", this.words.t("terminal.noConversation", "There is no conversation {id}.", { id })); return; }
    this.conversation.reset(found.sessionId);
    this.printed = 0;
    this.go(CHAT);
  }
  sessions(): void {
    const recent = this.runtime.store.recentSessions(this.runtime.owner, 30).sessions;
    if (this.screen) {
      const items = recent.map((entry) => ({ label: (entry.opening || entry.sessionId).replace(/\s+/g, " ").slice(0, 80), section: entry.createdAt.slice(0, 16).replace("T", " "), hint: entry.sessionId.slice(0, 8), run: `/sessions ${entry.sessionId}` }));
      this.overlay = { kind: "picker", title: this.words.t("rail.recents", "Recents"), items, selected: 0 };
      this.requestDraw();
      return;
    }
    if (!recent.length) this.print(this.words.t("terminal.noConversations", "No conversations yet."));
    for (const entry of recent) this.print(`${entry.sessionId.slice(0, 8)}  ${entry.createdAt.slice(0, 16).replace("T", " ")}  ${entry.opening.replace(/\s+/g, " ").slice(0, 60)}`);
  }
  togglePane(tab?: string): void {
    const tabs = ["activity", "plan", "files", "memory"];
    if (tab && tabs.includes(tab)) this.pane = { open: true, tab, auto: false };
    else this.pane = { ...this.pane, open: !this.pane.open, auto: false };
    if (!("place" in this.route && this.route.place === "chat")) this.go(CHAT);
    if (!this.screen) this.conversation.paneRows(this.pane.tab, this.words).forEach((row) => this.print(`- ${row.title}${row.detail ? " — " + row.detail : ""}`));
    this.requestDraw();
  }
  /** `/lockdown on` or `off` changes it; on its own it only says whether it is on, as `branch lockdown` does. */
  lockdown(argument: string): void {
    const { store, owner } = this.runtime;
    const word = argument.trim().toLowerCase();
    if (word !== "on" && word !== "off") {
      const now = lockdownState(store, owner).on;
      if (word) this.conversation.say("warn", this.words.t("terminal.lockdown.use", "Send /lockdown on or /lockdown off."));
      else this.conversation.say(now ? "warn" : "note", now ? this.words.t("lockdown.on", "Lockdown is on. Commands are refused; all else asks you.")
        : this.words.t("lockdown.off", "Lockdown is off. Commands follow the permission rules above."));
      return;
    }
    const on = word === "on";
    setLockdown(store, owner, { on }, "owner-by-command");
    // As the Lockdown route does: turning it on also ends the yeses already given (wave mac3, commands).
    if (on) this.runtime.approvals.forgetAll();
    this.conversation.say(on ? "warn" : "note", on ? this.words.t("lockdown.on", "Lockdown is on. Commands are refused; all else asks you.")
      : this.words.t("lockdown.off", "Lockdown is off. Commands follow the permission rules above."));
    void this.reload();
  }
  switchSetting(name: string, value: string): void {
    if (this.switchComfort(name, value)) return; // R17-S21
    const key = name === "pane" ? "sidePane" : name;
    if (!["mouse", "sidePane", "oak"].includes(key)) { this.conversation.say("warn", "Use /switch mouse, /switch sidePane or /switch oak."); return; }
    const current = this.switches[key as keyof TerminalSwitches];
    const next = value || (current === "off" ? "when-needed" : current === "when-needed" ? "on" : "off");
    this.switches = saveTerminalSwitch(this.runtime.store, this.runtime.owner, key, next);
    this.say(`${key}: ${next}`);
    this.readLook(true);
    void this.reload();
  }
  // ── R17-S16/S21: the comfort settings (src/comfort/terminal.ts) ──
  private comfortStatus(): string | null {
    const { store, owner, workspace } = this.runtime;
    if (readComfort(store, owner, "display").statusLine === null) return null;
    const totals = sessionTotals(this.runtime, this.conversation.sessionId, activeModel(this.runtime, this.conversation.model));
    return terminalStatus(store, owner, { model: this.conversation.modelName(), folder: workspace,
      used: totals.input + totals.output, cost: totals.cost }, this.words, glyphsFor(this.style.unicode).dot);
  }
  private switchComfort(name: string, value: string): boolean {
    const { store, owner } = this.runtime;
    const outbound = (this.app as { comfort?: { outbound?: OutboundNetwork } } | undefined)?.comfort?.outbound;
    let said: string | null;
    try {
      said = switchComfort(store, owner, name, value, this.words, (card) => {
        if (card === "network") outbound?.apply(readComfort(store, owner, "network"));
        // As the window does: asking before sensitive browser steps also ends the yeses already given.
        if (card === "browser" && readComfort(store, owner, "browser").confirmSensitive) this.runtime.approvals.forgetAll();
      });
    } catch (error) {
      this.conversation.say("warn", `[${error instanceof Error ? error.message : String(error)}]`);
      return true;
    }
    if (said === null) return false;
    this.say(said);
    void this.reload();
    return true;
  }
  /** `/model` with nothing after it: a picker of the connections, in the full-screen view. */
  pickModel(): boolean {
    if (!this.screen) return false;
    const summary = this.runtime.models.summary(this.runtime.owner);
    const active = this.conversation.model ?? summary.activePreset ?? summary.defaultPreset;
    const items = summary.presets.map((preset) => ({ label: `${preset.id === active ? "● " : ""}${preset.name}`, section: preset.model, hint: preset.id, run: `/model ${preset.id}` }));
    const selected = Math.max(0, summary.presets.findIndex((preset) => preset.id === active));
    this.overlay = { kind: "picker", title: this.words.t("comfort.terminal.pickModel", "Model for this conversation"), items, selected };
    this.requestDraw();
    return true;
  }
  // ── end R17-S16/S21 ──
  async theme(argument: string): Promise<void> {
    const { store, owner } = this.runtime;
    const word = argument.trim();
    if (!word || word === "list") return this.themeList();
    if (["light", "dark", "follow"].includes(word)) saveLookMode(store, owner, word as LookMode | "follow");
    else if (word === "mode") saveLookMode(store, owner, this.mode === "follow" ? "dark" : this.mode === "dark" ? "light" : "follow");
    else if (word === "contrast") await saveLook(store, owner, { contrast: this.look.contrast === "more" ? "standard" : "more" });
    else if (word === "language") {
      // auto → each language on file in turn → auto
      const cycle = ["auto", ...LOOK_LANGUAGES] as const;
      await saveLook(store, owner, { language: cycle[(cycle.indexOf(this.look.language) + 1) % cycle.length] });
    }
    else await saveLook(store, owner, { theme: word });
    this.previewTheme = undefined;
    this.readLook(true);
    this.say(`${this.words.t("look.theme", "Theme")}: ${this.themeName()} · ${this.mode}`);
    void this.reload();
  }
  private themeList(): void {
    if (!this.catalogue) return;
    const items = themeItems(this.catalogue, this.look.theme);
    if (!this.screen) { for (const item of items) this.print(`${item.label} (${item.hint}) — ${item.section}`); return; }
    const selected = Math.max(0, this.catalogue.THEMES.findIndex((theme) => theme[0] === this.look.theme));
    this.overlay = { kind: "picker", title: this.words.t("look.allThemes", "All 44 themes…"), items, selected };
    this.requestDraw();
  }
  keys(): void {
    const lines = [
      ...helpLines(this.words, this.commandMode()),
      "",
      this.words.t("terminal.keys.help1", "Esc, then 1-6 (or Alt+1 to Alt+6): Conversation, Inbox, Automations, Library, Customize, Team"),
      this.words.t("terminal.keys.help2", "Ctrl+K or /: find anything · Ctrl+N: new conversation · Ctrl+P or F2: side pane"),
      this.words.t("terminal.keys.help3", "Tab and Shift+Tab: the next and the last place · In a place: up and down choose, left and right change tab, Enter opens, typing asks"),
      this.words.t("terminal.keys.help6", "When Branch asks: y yes, s yes for this conversation, n no, one key each; a (yes, always) then Enter"),
      this.words.t("terminal.keys.help4", "In Settings: left and right change page, Tab changes the Models tab, Esc closes"),
      this.words.t("terminal.keys.help5", "PgUp and PgDn scroll the conversation · Ctrl+L draws everything again"),
    ];
    if (!this.screen) { lines.forEach((line) => this.print(line)); return; }
    this.overlay = { kind: "help", lines: wrapHelp(lines, this.size().columns), offset: 0 };
    this.requestDraw();
  }
  openPalette(query = ""): void {
    const recent = this.runtime.store.recentSessions(this.runtime.owner, 8).sessions;
    this.overlay = { kind: "palette", query, items: paletteItems(this.words, recent, query, this.style.unicode ? " › " : " > ", terminalCommands(this.commandMode())), selected: 0 };
    this.readLook(true);
    this.requestDraw();
  }
  closeOverlay(): void {
    if (this.previewTheme) { this.previewTheme = undefined; this.readLook(true); }
    this.overlay = undefined;
    this.readLook(true);
    this.requestDraw();
  }

  quit = (): void => {
    if (this.closing) return;
    this.closing = true;
    this.conversation.stop();
    clearInterval(this.spinner);
    clearTimeout(this.toastTimer);
    const reset = progressIndicator(this.style, "none") + windowTitle(this.style, "Branch Agent");
    if (this.screen) this.screen.leave(reset);
    else this.output.write(reset);
    this.output.write("Goodbye.\n");
    this.editor.detach();
    this.input.removeListener("end", this.quit);
    this.signals.removeListener("SIGINT", this.onSignal);
    this.output.removeListener?.("resize", this.onResize);
    this.resolveDone?.();
    this.resolveDone = undefined;
  };
}
