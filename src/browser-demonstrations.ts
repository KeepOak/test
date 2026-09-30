import { randomUUID } from "node:crypto";
import type { Page } from "playwright";
import type { FlowStep } from "./integrations/browser-flow.js";
import type { WorkflowDefinition } from "./workflows.js";
import { redactLeaksIn } from './leak-guard.js';

type Entry = { step: FlowStep } | { omission: string };
export interface DemonstrationScope { owner: string; conversation: string; control: string; client: string; tab: string; epoch: number; profile?: string | null }
interface Lesson { scope: DemonstrationScope; entries: Entry[]; at: number; preview: string | null; timer: ReturnType<typeof setTimeout> }
export type DemonstratedAction = { step: FlowStep } | { omission: string } | { fill: string } | null;
const sensitive = /password|passwd|passphrase|secret|token|credential|otp|one.?time|verification|security|credit.?card|card.?number|cvc|cvv|\bpin\b|\bssn\b|social.?security|2fa|mfa|session|api.?key|access.?key|private.?key|\bkey\b|auth|csrf|xsrf|recovery|bearer/i;
export class DemonstrationError extends Error { readonly status = 409; }
const failure = (message: string) => new DemonstrationError(message);

/** Only owner controls call this recorder. No raw input, page body, cookies or credentials enter its storage. */
export class BrowserDemonstrations {
  private lessons = new Map<string, Lesson>();
  constructor(private readonly scrub: <T>(value: T) => T) {}
  clear(control?: string): void {
    if (control) { clearTimeout(this.lessons.get(control)?.timer); this.lessons.delete(control); }
    else { for (const lesson of this.lessons.values()) clearTimeout(lesson.timer); this.lessons.clear(); }
  }
  private lesson(scope: DemonstrationScope): Lesson {
    const found = this.lessons.get(scope.control);
    if (!found || JSON.stringify(found.scope) !== JSON.stringify(scope)) throw failure("This demonstration belongs to another browser control or tab.");
    if (Date.now() - found.at > 30 * 60_000) { this.clear(scope.control); throw failure("This demonstration expired. Start a new recording."); }
    return found;
  }
  active(scope: DemonstrationScope): boolean {
    if (!this.lessons.has(scope.control)) return false;
    return !this.lesson(scope).preview;
  }
  start(scope: DemonstrationScope, url: string): void {
    for (const [id, lesson] of this.lessons) if (Date.now() - lesson.at > 30 * 60_000) this.clear(id);
    if (this.lessons.has(scope.control)) throw failure("Preview or cancel the current demonstration first.");
    if (this.lessons.size >= 8) throw failure("Too many demonstrations are open.");
    const entry = this.navigation(url);
    const timer = setTimeout(() => this.clear(scope.control), 30 * 60_000); timer.unref?.();
    this.lessons.set(scope.control, { scope: { ...scope }, entries: entry ? [entry] : [], at: Date.now(), preview: null, timer });
  }
  navigation(url: string): Entry | null {
    if (!url || url === "about:blank") return null;
    try {
      const parsed = new URL(url);
      if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password || [...parsed.searchParams.keys()].some(key => sensitive.test(key) || /^(key|code|auth)$/i.test(key))
        || parsed.hash || redactLeaksIn(this.scrub(url)).value !== url) return { omission: "Open the required page yourself; its address may contain private information." };
      return { step: { action: "navigate", url } };
    } catch { return { omission: "Open the required page yourself; its address cannot be recorded." }; }
  }
  append(scope: DemonstrationScope, entry: Entry | null): void {
    const lesson = this.lesson(scope);
    if (!entry || lesson.preview) return;
    if (lesson.entries.length >= 60) { lesson.entries[59] = { omission: "This recording exceeded its limit. Record a shorter workflow." }; return; }
    const cleaned = redactLeaksIn(this.scrub(entry)).value;
    if (JSON.stringify(cleaned) !== JSON.stringify(entry)) entry = { omission: "Complete an action containing private information yourself." };
    const previous = lesson.entries.at(-1);
    if ("step" in entry && entry.step.action === "fill" && previous && "step" in previous
      && previous.step.action === "fill" && previous.step.label === entry.step.label) lesson.entries[lesson.entries.length - 1] = entry;
    else lesson.entries.push(entry);
  }
  preview(scope: DemonstrationScope, name: string) {
    const lesson = this.lesson(scope);
    lesson.preview ??= randomUUID();
    const definition = compileDemonstration(name, lesson.entries, scope.profile);
    return { previewToken: lesson.preview, definition, omissions: lesson.entries.filter(entry => "omission" in entry).map(entry => entry.omission) };
  }
  saved(scope: DemonstrationScope, token: string, name: string): WorkflowDefinition {
    const lesson = this.lesson(scope);
    if (!lesson.preview || lesson.preview !== token) throw failure("Preview this demonstration before saving it.");
    if (lesson.entries.some(entry => 'omission' in entry)) throw failure("Some actions cannot be replayed safely. Record a new demonstration after signing in, using labelled fields and buttons.");
    if (lesson.entries.length > 12) throw failure("A browser workflow holds at most 12 actions. Record a shorter demonstration.");
    return compileDemonstration(name, lesson.entries, scope.profile);
  }
}

function compileDemonstration(name: string, entries: Entry[], profile?: string | null): WorkflowDefinition {
  if (!entries.some(entry => "step" in entry)) throw failure("There are no repeatable actions to save yet.");
  const flow = entries.flatMap(entry => 'step' in entry ? [entry.step] : []);
  return { name, description: "Learned from your browser demonstration. Each replay uses current permissions and a fresh task browser.",
    steps: [{ name: 'Demonstrated browser journey', kind: 'tool', tool: 'browser.flow', args: { steps: flow, ...(profile ? { profile } : {}) }, retries: 0, timeoutMs: 120000 }] };
}

/** Metadata only: secret values are never read, even briefly, when identifying a field. */
async function targetMetadata(page: Page, point?: { x: number; y: number }) {
  return page.evaluate(({ point }) => {
    const picked = point ? document.elementFromPoint(point.x * innerWidth, point.y * innerHeight) : document.activeElement;
    const el = picked?.closest("button,a,input,textarea,[role=button],[role=link]");
    if (!el) return null;
    const labels = "labels" in el ? Array.from((el as HTMLInputElement).labels ?? []).map(label => {
      const copy = label.cloneNode(true) as Element;
      copy.querySelectorAll('input,textarea,select').forEach(field => field.remove());
      return copy.textContent?.trim() ?? '';
    }) : [];
    const label = el.getAttribute("aria-label") ?? labels.join(" ");
    const clickable = el.matches('button,a,[role=button],[role=link]');
    return { tag: el.tagName, type: el.getAttribute('type') ?? 'text', role: el.getAttribute("role"), name: clickable ? el.getAttribute("aria-label") ?? el.textContent?.trim() ?? "" : '',
      label, hints: [el.getAttribute("type"), el.getAttribute("autocomplete"), el.id, el.getAttribute("name"), label].join(" ") };
  }, { point });
}

export async function prepareDemonstratedInput(page: Page, args: Record<string, unknown>): Promise<DemonstratedAction> {
  const kind = args.kind;
  if (kind === "wheel") return null;
  if (kind !== "click" && kind !== "text") return { omission: "Repeat an unsupported keyboard, drag or history action yourself before continuing." };
  const meta = await targetMetadata(page, kind === "click" ? { x: Number(args.x), y: Number(args.y) } : undefined);
  if (!meta) return { omission: "Repeat an action on a target without a reliable label yourself." };
  if (sensitive.test(meta.hints)) return kind === "text" ? { omission: "Enter the required private field yourself before continuing. Its value was not recorded." } : null;
  if (kind === "text") {
    if (!meta.label || meta.label.length > 300 || await page.getByLabel(meta.label, { exact: true }).count() !== 1)
      return { omission: "Fill the unlabelled or ambiguous field yourself." };
    return { fill: meta.label };
  }
  if (meta.tag === "TEXTAREA" || (meta.tag === "INPUT" && /^(text|search|email|url|tel|number)$/i.test(meta.type))) return null;
  const role = meta.role ?? (meta.tag === "BUTTON" ? "button" : meta.tag === "A" ? "link" : "");
  if ((role !== "button" && role !== "link") || !meta.name || meta.name.length > 300 || args.button !== "left" || args.count !== 1
    || await page.getByRole(role, { name: meta.name, exact: true }).count() !== 1)
    return { omission: "Repeat a click with an unsupported or ambiguous target yourself." };
  return { step: { action: "click", role, name: meta.name } };
}

export async function finishDemonstratedInput(page: Page, prepared: DemonstratedAction): Promise<Entry | null> {
  if (!prepared || !("fill" in prepared)) return prepared;
  const target = page.getByLabel(prepared.fill, { exact: true });
  const meta = await targetMetadata(page);
  if (!meta || meta.label !== prepared.fill || sensitive.test(meta.hints)) return { omission: "Fill the field yourself; it changed while typing." };
  const value = await target.evaluate((element, pattern) => {
    const input = element as HTMLInputElement;
    const hints = [input.type, input.autocomplete, input.id, input.name, input.getAttribute('aria-label'),
      ...Array.from(input.labels ?? []).map(label => label.textContent)].join(' ');
    return new RegExp(pattern, 'i').test(hints) ? null : input.value;
  }, sensitive.source);
  if (typeof value !== 'string' || value.length > 4000) return { omission: "Fill this private or unsupported field yourself." };
  return { step: { action: "fill", label: prepared.fill, value } };
}
