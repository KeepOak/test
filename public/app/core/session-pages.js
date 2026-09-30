/* Recent keeps its real metadata and filters on every page. A refresh rereads the pages
   opened in this window; no old row cache can keep an archived conversation visible. */
import { api } from "./api.js";

export const sessionPages = { pages: 1, more: false, busy: false, error: null };
let principal, generation = 0, controller = null;
export const sessionPrincipal = (profiles) => JSON.stringify([profiles?.active?.id ?? null, profiles?.isOwner === true]);

export function clearSessionPages() {
  controller?.abort();
  generation += 1;
  principal = undefined;
  Object.assign(sessionPages, { pages: 1, more: false, busy: false, error: null });
}

export function resetSessionPages(profiles) {
  const next = sessionPrincipal(profiles);
  if (principal === next) return false;
  principal = next;
  controller?.abort();
  generation += 1;
  Object.assign(sessionPages, { pages: 1, more: false, busy: false, error: null });
  return true;
}

export async function readSessionPages(profiles, stillHere) {
  resetSessionPages(profiles);
  const mine = ++generation, who = principal, count = sessionPages.pages;
  controller?.abort();
  const abort = controller = new AbortController();
  sessionPages.busy = true;
  sessionPages.error = null;
  let offset = 0, first, page, loaded = 0;
  const rows = new Map();
  try {
    for (; loaded < count; loaded += 1) {
      page = await api(`sessions?limit=50&offset=${offset}`, undefined, "GET", abort.signal);
      if (mine !== generation || !stillHere() || sessionPrincipal({ active: page.profileId ? { id: page.profileId } : null, isOwner: page.isOwner }) !== who) return null;
      first ??= page;
      for (const row of page.sessions ?? []) rows.set(row.sessionId, row);
      if (!Number.isInteger(page.nextOffset) || page.nextOffset <= offset) { loaded += 1; break; }
      offset = page.nextOffset;
    }
    sessionPages.pages = Math.max(1, loaded);
    sessionPages.more = Number.isInteger(page?.nextOffset);
    return { ...first, sessions: [...rows.values()] };
  } catch (error) {
    if (mine === generation && error.name !== "AbortError") sessionPages.error = error;
    return null;
  } finally {
    if (mine === generation) sessionPages.busy = false;
  }
}

addEventListener("pagehide", clearSessionPages);
