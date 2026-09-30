import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discardTemp } from './temp-dir.mjs';
import { chromium } from 'playwright';
import { createBranch } from '../dist/index.js';
import { startServer } from '../dist/server.js';
import { openChat } from "./open-chat.mjs"; // trunk-one-row: one row per Trunk

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function seed(app, text) {
  const run = app.store.createRun('local', text);
  app.store.message(run.sessionId, { role: 'user', content: text });
  app.store.message(run.sessionId, { role: 'assistant', content: 'Saved response for ' + text });
  app.store.finish(run.id, 'completed', 'Saved response');
  return run.sessionId;
}
async function fixture(t, provider) {
  const scratch = join(tmpdir(), 'Codex-session-files'); await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, 'branch-lifecycle-ui-'));
  const app = await createBranch({ workspace: join(root, 'workspace'), dataDir: join(root, 'private'),
    provider: provider ?? { name: 'lifecycle-fixture', complete: async () => ({ content: 'Follow-up finished', toolCalls: [] }) } });
  const sourceId = seed(app, 'Juniper lifecycle source');
  const original = JSON.stringify(app.store.sessionView('local', sourceId));
  const server = await startServer(app, { dataDir: join(root, 'private'), port: 0 });
  await fetch(new URL("/api/onboarding", server.url), { method: "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify({ done: true }) });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true, serviceWorkers: 'block' });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(server.url); await page.getByLabel('Session token', { exact: true }).fill(server.token);
  /* The page's own settling point is waited for on the very next line. The click itself
     therefore does not also wait on Playwright's generic after-the-click step, which on
     Chromium is a CDP round trip (`Page.enable`) and stalled for the whole thirty seconds on
     the loaded Windows checker. Nothing is waited for less: a real signal replaces a proxy. */
  await page.getByRole('button', { name: 'Connect', exact: true }).click({ noWaitAfter: true });
  await page.locator('#app #side').waitFor({ state: 'visible', timeout: 120000 });
  return { app, page, root, sourceId, original, errors };
}
/* Redesign: the new window (public/app/**). A conversation opens from its row in the sidebar list; the open one's row
   carries aria-current="true". Carrying a saved conversation on as a new one is the sidebar search's "Past sessions"
   result ([data-act="sr-sess"]) and its dialog's "Carry it on" ([data-act="sess-carry"], POST /api/sessions/{id}/duplicate),
   as in the prototype's showSession(). */
const currentId = (page) => page.evaluate(() => document.querySelector('#side [data-act="chat"][aria-current="true"]')?.dataset.id ?? null);
async function openConversation(page, id) {
  await openChat(page, id);
  await page.locator('#conversation').getByText('Saved response for', { exact: false }).first().waitFor();
}
async function pastSession(page, query, id) {
  await page.locator('#side-q').fill(query);
  await page.locator(`#side [data-act="sr-sess"][data-v="${id}"]`).click({ timeout: 10000 });
  return page.getByRole('button', { name: 'Carry it on', exact: true });
}
const card = (page, id) => page.locator(`#saved-list article[data-session-id="${id}"]`);
async function ready(page) { await page.waitForFunction(() => !document.getElementById('send').disabled); }

/* Redesign: a conversation is exported from its own More menu (data-act="chatmenu" › "Export conversation",
   data-act="export-conv"). As the prototype's, it saves the engine's Markdown copy to Library › Documents
   (GET /api/sessions/<id>/export?format=markdown, then POST /api/documents), and downloads nothing. In the desktop app the
   engine's JSON archive also goes to the Save dialog through the guarded IPC (window.branchDesktop.exportConversation,
   branch:export-conversation, #362), stood in for here. */
test("Export conversation saves Markdown to Library › Documents, and hands the desktop app the JSON archive (the new window)", async (t) => {
  const f = await fixture(t);
  const documents = () => f.page.evaluate(async () => (await (await fetch('/api/documents', {
    headers: { authorization: 'Bearer ' + sessionStorage.getItem('branch-token') } })).json()).documents ?? []);
  const exportIt = async () => {
    await openConversation(f.page, f.sourceId);
    await f.page.locator('[data-act="chatmenu"]').first().click();
    await f.page.locator('#app > .pop [data-act="export-conv"]').click();
    await f.page.locator('.toast').filter({ hasText: 'Saved as Markdown to Library › Documents.' }).waitFor({ timeout: 30000 });
  };
  let downloads = 0; f.page.on('download', () => downloads++);
  const before = (await documents()).length;
  await exportIt();
  const docs = await documents();
  assert.equal(docs.length, before + 1, 'one document is added');
  assert.ok(docs.some((d) => d.name === `conversation-${f.sourceId.slice(0, 8)}.md`), 'the Markdown copy is in Library › Documents');
  assert.equal(downloads, 0, 'the browser downloads nothing');
  /* The desktop app's preload, stood in for: it records what the window hands the guarded export. */
  await f.page.addInitScript(() => { window.__handed = []; window.branchDesktop = Object.freeze({ exportConversation: async (text) => { window.__handed.push(text); return { saved: true }; } }); });
  await f.page.reload(); await f.page.locator('#app #side').waitFor({ state: 'visible', timeout: 120000 });
  await exportIt();
  await f.page.waitForFunction(() => window.__handed.length === 1, null, { timeout: 15000 });
  const archive = JSON.parse(await f.page.evaluate(() => window.__handed[0]));
  assert.equal(archive.format, 'branch-agent-conversation');
  assert.deepEqual(archive.messages, f.app.store.messages(f.sourceId));
  assert.equal(JSON.stringify(f.app.store.sessionView('local', f.sourceId)), f.original, 'exporting changes nothing');
  assert.deepEqual(f.errors, []);
});

test('duplicating a saved conversation preserves the source and follows up in the new ID', async (t) => {
  let received;
  const f = await fixture(t, { name: 'duplicate-fixture', complete: async request => {
    received = structuredClone(request.messages); return { content: 'Independent follow-up', toolCalls: [] };
  } });
  await (await pastSession(f.page, 'Juniper', f.sourceId)).click();
  await f.page.waitForFunction((source) => {
    const id = document.querySelector('#side [data-act="chat"][aria-current="true"]')?.dataset.id;
    return id && id !== source;
  }, f.sourceId, { timeout: 20000 });
  await ready(f.page);
  const id = await currentId(f.page);
  assert.notEqual(id, f.sourceId); assert.deepEqual(f.app.store.messages(id), f.app.store.messages(f.sourceId));
  // Redesign: replaced by the new window (the "files and saved memory are shared" line is not in the design).
  await f.page.locator('#prompt').fill('A different path');
  await f.page.locator('#send').click();
  await f.page.locator('#conversation').getByText('Independent follow-up').waitFor({ timeout: 30000 }); await ready(f.page);
  assert.equal(await currentId(f.page), id, 'the follow-up is in the new conversation');
  assert.deepEqual(received.filter(message => message.role !== 'system'), [
    ...f.app.store.messages(f.sourceId), { role: 'user', content: 'A different path' },
  ]);
  assert.equal(JSON.stringify(f.app.store.sessionView('local', f.sourceId)), f.original);
  assert.deepEqual(f.errors, []);
});

test('pending send blocks saved conversation switching, duplicate, and file import', async (t) => {
  const release = deferred(), started = deferred(); t.after(() => release.resolve());
  const f = await fixture(t, { name: 'pending-fixture', complete: async () => {
    started.resolve(); await release.promise; return { content: 'finished', toolCalls: [] };
  } });
  await openConversation(f.page, f.sourceId); await ready(f.page);
  await f.page.locator('#prompt').fill('Keep working'); await f.page.locator('#send').click(); await started.promise;
  // The prototype (the lead, 2026-09-26): while a task works, an empty box shows Stop instead of Send, and Send is not
  // disabled; a message typed then is queued through the engine's busy send.
  await f.page.locator('#send[aria-label="Stop"][data-act="stop-run"]').waitFor({ timeout: 10000 });
  /* Redesign: the design lets a person move between conversations while one works (rows show "Working"), and has no
     import (replaced by the new window). Carrying the source on while its answer is pending is still refused: read now,
     asserted last. */
  /* While searching, the results stand in the list's place (as the prototype's do), so no row says which conversation is
     open: the engine's refusal is waited for, the dialog closed and the search cleared before the open row is read. */
  const carry = await pastSession(f.page, 'Juniper', f.sourceId).then(async (button) => {
    await button.evaluate(b => b.click());
    await f.page.locator('.toast').filter({ hasText: "Wait for this conversation's active task" }).waitFor({ timeout: 10000 });
    await f.page.getByRole('button', { name: 'Close', exact: true }).first().click();
    await f.page.locator('#side [data-act="sq-clear"]').click();
    return currentId(f.page);
  }).catch(error => error.message);
  release.resolve(); await ready(f.page);
  await f.page.locator('#conversation').getByText('finished', { exact: true }).waitFor({ timeout: 30000 });
  assert.equal(await currentId(f.page), f.sourceId, 'the answer lands in the conversation it was asked in');
  assert.deepEqual(f.app.store.messages(f.sourceId).slice(-2).map(m => m.content), ['Keep working', 'finished']);
  assert.deepEqual(f.errors, []);
  assert.equal(carry, f.sourceId, 'Carry it on is held while a send is pending');
});

