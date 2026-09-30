import type { Page } from 'playwright';
import { z } from 'zod';
import { ExtractSchemaSchema } from './browser-schema.js';
import { hostRefusalFor } from './desktop-config.js';

/**
 * A site skill: the handful of things that are odd about one particular website, written down in
 * the skill that knows about that site rather than built into the browser tool. A shopping site
 * that puts a cookie notice over everything, a listing site that draws its rows a moment after the
 * page opens, a table whose columns never change — each of those is a line of data in a
 * `site.json` beside the skill's instructions, not a special case in Branch.
 *
 * Everything here is data and only data: selectors, a wait, a pause and named readings. There is
 * deliberately no place to put a piece of script, because a skill can arrive from anyone. A site
 * skill can also never widen what Branch may do — it cannot add a website to the allowed list, and
 * a bank, broker, password manager or mailbox is refused as a site skill outright.
 */
const hostName = z.string().trim().max(253)
  .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/,
    'A site skill names a plain website, such as shop.example.com');
const selector = z.string().trim().min(1).max(300)
  .regex(/^[^<>{}]+$/, 'A site skill names a plain selector, never markup or script');
const readingName = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/, 'A reading is named in lower case, such as basket');

export const SiteSkillSchema = z.object({
  /** The websites this skill knows about. A page on any of them gets its quirks. */
  hosts: z.array(hostName).min(1).max(10),
  /** Things to press once when a page opens, such as a cookie notice. One that is not there is skipped. */
  dismiss: z.array(selector).max(5).default([]),
  /** Wait for this to appear before the page counts as ready. */
  waitFor: selector.optional(),
  /** How long to let the page settle once it has opened, in thousandths of a second. */
  settleMs: z.number().int().min(0).max(5000).default(0),
  /** Readings of this site by name, so a task asks for "basket" instead of writing selectors. */
  readings: z.record(readingName, ExtractSchemaSchema).default({}),
  /** What is odd about this site, in plain words, for the person reading the skill. */
  notes: z.string().max(600).default(''),
}).strict();
export type SiteSkill = z.infer<typeof SiteSkillSchema>;
/** The whole of a `site.json` file inside a skill package. */
export const SiteSkillFileSchema = z.object({ site: SiteSkillSchema }).strict();
/** The name of the file a skill package keeps its site quirks in. */
export const siteSkillEntry = 'site.json';

export interface SiteSkillEntry { skill: string; site: SiteSkill; /** The installed skill it came from, when known. */ skillId?: string }

/** The site skills one owner has installed, and which of them a given address belongs to. */
export class SiteSkills {
  private readonly entries: SiteSkillEntry[] = [];
  /**
   * Takes one skill's site block. A website Branch refuses everywhere — a bank, a broker, a
   * password manager, a mailbox — is refused here too, so no installed skill can reach one.
   */
  add(skill: string, input: unknown, skillId?: string): SiteSkillEntry {
    const site = SiteSkillFileSchema.parse(input).site;
    for (const host of site.hosts) {
      const refused = hostRefusalFor(host, []);
      if (refused) throw new Error(`The skill "${skill}" names ${host}, which Branch never opens. ${refused}`);
    }
    const entry: SiteSkillEntry = { skill, site, ...(skillId ? { skillId } : {}) };
    this.entries.push(entry);
    return entry;
  }
  /** The skill that knows this address, when one does. The most exact website name wins. */
  forUrl(url: string): SiteSkillEntry | undefined {
    let host: string;
    try { host = new URL(url).hostname.toLowerCase(); } catch { return undefined; }
    const matches = this.entries.filter(entry => entry.site.hosts.some(
      name => host === name || host.endsWith(`.${name}`)));
    return matches.sort((left, right) => longest(right.site.hosts) - longest(left.site.hosts))[0];
  }
  /** Every site skill, for the list the assistant and the owner are shown. */
  list(): { skill: string; skillId?: string; hosts: string[]; readings: string[]; notes: string }[] {
    return this.entries.map(entry => ({ skill: entry.skill, ...(entry.skillId ? { skillId: entry.skillId } : {}), hosts: [...entry.site.hosts],
      readings: Object.keys(entry.site.readings), notes: entry.site.notes }));
  }
  get size(): number { return this.entries.length; }
}
const longest = (hosts: readonly string[]): number => Math.max(...hosts.map(host => host.length));

/** What applying a site's quirks to a page actually did, so the result can say so plainly. */
export interface QuirksApplied {
  skill: string; dismissed: string[]; waited: boolean; notes: string;
  /** Notices it would have pressed, when this task is only allowed to read. */
  notPressed: string[];
}

/**
 * Applies one site's quirks to a page that has just opened: waits for the thing that says the page
 * is really ready, presses the notices that sit over everything, and lets it settle. Nothing here
 * can fail a navigation — a quirk that does not apply is simply not applied.
 *
 * Opening a page is a reading permission, and pressing something is not, so a task that may only
 * read gets the waiting and the settling but never the pressing: what it would have pressed is
 * reported instead, so the assistant can ask for what it needs rather than wonder why the notice
 * is still there.
 */
export async function applyQuirks(page: Page, entry: SiteSkillEntry, mayPress: boolean): Promise<QuirksApplied> {
  const { site } = entry;
  const waited = site.waitFor
    ? await page.waitForSelector(site.waitFor, { timeout: 5000, state: 'attached' }).then(() => true).catch(() => false)
    : false;
  const dismissed: string[] = [];
  for (const target of mayPress ? site.dismiss : []) {
    const locator = page.locator(target).first();
    if (!await locator.count().catch(() => 0)) continue;
    const pressed = await locator.click({ timeout: 2000 }).then(() => true).catch(() => false);
    if (pressed) dismissed.push(target);
  }
  if (site.settleMs) await page.waitForTimeout(site.settleMs);
  return { skill: entry.skill, dismissed, waited, notes: site.notes,
    notPressed: mayPress ? [] : [...site.dismiss] };
}

/** One skill package as it is kept, of which only the site block matters here. */
export interface StoredPackage { skillId?: string; manifest?: { name?: string }; files?: Record<string, string> }

/**
 * The site skills among the packages an owner has installed. A skill that is installed but turned
 * off brings no quirks, in the same way it brings no instructions; a site block that does not
 * parse, or that names a website Branch never opens, is left out rather than failing the launch.
 */
export function siteSkillsFrom(packages: readonly StoredPackage[], enabled: ReadonlySet<string>): SiteSkills {
  const skills = new SiteSkills();
  for (const record of packages) {
    const file = record.files?.[siteSkillEntry];
    if (!file || !record.skillId || !enabled.has(record.skillId)) continue;
    try { skills.add(record.manifest?.name ?? record.skillId, JSON.parse(file), record.skillId); } catch { continue; }
  }
  return skills;
}

/** Just enough of the settings store to find the packages an owner installed and whether each is on. */
export interface SiteSkillSource {
  list(table: 'settings', owner: string): readonly { id: string; data: unknown }[];
  skills: { list(owner: string): readonly { id: string; activeVersion: number | null }[] };
}

/** The site skills one owner has switched on right now, read fresh so an install needs no restart. */
export function siteSkillsFor(source: SiteSkillSource, owner: string): SiteSkills {
  const enabled = new Set(source.skills.list(owner).filter(skill => skill.activeVersion !== null).map(skill => skill.id));
  const packages = source.list('settings', owner).filter(row => row.id.startsWith('skill-package:'))
    .map(row => row.data as StoredPackage);
  return siteSkillsFrom(packages, enabled);
}
