import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discardTemp } from './temp-dir.mjs';
import { chromium } from 'playwright';
import { createBranch } from '../dist/index.js';
import { startServer } from '../dist/server.js';
import { openChat } from "./open-chat.mjs"; // trunk-one-row: one row per Trunk

/* Redesign: the new window (public/app/**). A conversation is opened from its row in the sidebar list
   ([data-act="chat"][data-id]); the row of the open one carries aria-current="true". "Branch from here" is one of a
   message's own actions (design doc: message actions on hover; prototype msgActs), not a button in a Memory search. */

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
async function fixture(t, complete) {
  const scratch = join(tmpdir(), 'Codex-session-files');
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, 'branch-session-ui-'));
  const app = await createBranch({ workspace: join(root, 'workspace'), dataDir: join(root, 'private'),
    provider: { name: 'session-ui-fixture', complete } });
  const source = app.store.createRun('local', 'Original task');
  for (const [role, content] of [
    ['user', 'Original choice'], ['assistant', 'Juniper checkpoint'],
    ['user', 'Later instruction'], ['assistant', 'Later outcome'],
  ]) app.store.message(source.sessionId, { role, content });
  app.store.finish(source.id, 'completed', 'Later outcome');
  const original = JSON.stringify(app.store.sessionView('local', source.sessionId));
  const server = await startServer(app, { dataDir: join(root, 'private'), port: 0 });
  await fetch(new URL("/api/onboarding", server.url), { method: "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify({ done: true }) });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => {
    await browser.close(); await server.close(); await app.close();
    await discardTemp(root);
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, serviceWorkers: 'block' });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel('Session token', { exact: true }).fill(server.token);
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await page.locator('#app #side').waitFor({ state: 'visible', timeout: 120000 });
  return { app, page, source, original, errors };
}
const currentId = (page) => page.evaluate(() => document.querySelector('#side [data-act="chat"][aria-current="true"]')?.dataset.id ?? null);
const message = (page, text) => page.locator('#conversation .b, #conversation .u').filter({ hasText: text }).first();
async function openConversation(page, id, text) {
  await openChat(page, id);
  await page.locator('#conversation').getByText(text, { exact: true }).first().waitFor();
}
async function branchButton(page, text) {
  await message(page, text).hover();
  return message(page, text).getByRole('button', { name: 'Branch from here', exact: true });
}
async function branchFrom(page, text) {
  await (await branchButton(page, text)).click({ timeout: 10000 });
  /* Redesign: "Branch from here" opens pass 17's dialog; "Start the new path" (data-act="brmake17c") makes it. The dialog
     closes once the engine made the path; when the engine refuses, its reason stays inside the dialog. */
  const dlg = page.locator(".dlg");
  await dlg.waitFor({ timeout: 10000 });
  await dlg.locator('[data-act="brmake17c"]').click();
  await page.waitForFunction(() => !document.querySelector(".dlg") || document.querySelector("#br-error17c")?.textContent, null, { timeout: 15000 });
}
async function readyConversation(page) {
  await page.waitForFunction(() => !document.getElementById('send').disabled);
}
const becameCurrent = (page, other) => page.waitForFunction((other) => {
  const id = document.querySelector('#side [data-act="chat"][aria-current="true"]')?.dataset.id;
  return id && id !== other;
}, other, { timeout: 20000 });
async function reloadSignedIn(page) {
  await page.reload();
  await page.locator('#app #side').waitFor({ state: 'visible', timeout: 120000 });
}

test('browser branches a historical prefix and follows up without changing the original', async (t) => {
  let messages;
  const f = await fixture(t, async request => {
    messages = structuredClone(request.messages);
    return { content: 'Follow-up completed in the branch', toolCalls: [] };
  });
  await writeFile(join(f.app.runtime.workspace, 'shared.txt'), 'Shared workspace');
  const memory = f.app.store.save('memory', 'local', 'shared-memory', { text: 'Shared memory' });
  await openConversation(f.page, f.source.sessionId, 'Juniper checkpoint');
  await branchFrom(f.page, 'Juniper checkpoint'); await becameCurrent(f.page, f.source.sessionId); await readyConversation(f.page);
  const id = await currentId(f.page);
  assert.notEqual(id, f.source.sessionId);
  // Redesign: replaced by the new window (the old "Branched conversation" label and its "shares workspace files and
  // saved memory" line are not in the design; that files and memory stay shared is still checked below).
  // The branch's messages are read after it becomes the open conversation, so they are waited for.
  await f.page.locator('#conversation').getByText('Original choice').first().waitFor({ timeout: 15000 });
  assert.match(await f.page.locator('#conversation').innerText(), /Original choice/);
  assert.doesNotMatch(await f.page.locator('#conversation').innerText(), /Later instruction|Later outcome/);
  assert.equal(await f.page.locator('#conversation').getByRole('button', { name: 'Branch from here' }).count(), 2);
  if (process.env.BRANCH_SESSION_SCREENSHOT)
    await f.page.screenshot({ path: process.env.BRANCH_SESSION_SCREENSHOT, fullPage: true });
  await f.page.locator('#prompt').fill('New direction');
  await f.page.locator('#send').click();
  await f.page.locator('#conversation').getByText('Follow-up completed in the branch').waitFor({ timeout: 30000 });
  await readyConversation(f.page);
  assert.equal(await currentId(f.page), id, 'the follow-up stays in the branch');
  assert.deepEqual(messages.filter(message => message.role !== 'system'), [
    { role: 'user', content: 'Original choice' }, { role: 'assistant', content: 'Juniper checkpoint' },
    { role: 'user', content: 'New direction' },
  ]);
  assert.equal(JSON.stringify(f.app.store.sessionView('local', f.source.sessionId)), f.original);
  assert.equal(await readFile(join(f.app.runtime.workspace, 'shared.txt'), 'utf8'), 'Shared workspace');
  assert.deepEqual(f.app.store.get('memory', 'local', 'shared-memory'), memory);
  // "Open original conversation" is its row in the list.
  await openConversation(f.page, f.source.sessionId, 'Later outcome');
  assert.equal(await currentId(f.page), f.source.sessionId);
  assert.deepEqual(f.errors, []);
});

/* Redesign: the design lets a person move between conversations while one works (each row shows its own "Working"
   state; prototype chats[].status), so switching is no longer blocked. What stays proven: one send at a time, the
   answer lands in the conversation it was asked in, the other conversation is untouched, the window never shows one
   conversation's answer under another's row, and branching waits for the pending answer. */
test('pending chat disables branching and conversation switching until its response settles', async (t) => {
  const release = deferred(), started = deferred();
  t.after(() => release.resolve());
  let requests = 0;
  const f = await fixture(t, async () => {
    requests++; started.resolve(); await release.promise;
    return { content: 'Pending task finished', toolCalls: [] };
  });
  const other = f.app.store.createRun('local', 'Other task');
  f.app.store.message(other.sessionId, { role: 'user', content: 'Other question' });
  f.app.store.message(other.sessionId, { role: 'assistant', content: 'Other answer' });
  f.app.store.finish(other.id, 'completed', 'Other answer');
  const otherView = JSON.stringify(f.app.store.sessionView('local', other.sessionId));
  await reloadSignedIn(f.page);
  await openConversation(f.page, f.source.sessionId, 'Juniper checkpoint'); await readyConversation(f.page);
  await f.page.locator('#prompt').fill('Wait for fixture');
  await f.page.locator('#send').click(); await started.promise;
  // The prototype (the lead, 2026-09-26): while a task works, an empty box shows Stop instead of Send, and Send is not
  // disabled; a message typed then is queued through the engine's busy send.
  await f.page.locator('#send[aria-label="Stop"][data-act="stop-run"]').waitFor({ timeout: 10000 });
  await f.page.locator('#composer').evaluate(form => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  await f.page.locator('#prompt').press('Enter');
  assert.equal(requests, 1, 'a pending send is never sent twice');
  await f.page.locator('#prompt').fill('Then this too');
  const queued = f.page.waitForRequest((r) => r.url().endsWith('/api/flows-boards/busy/send') && r.method() === 'POST', { timeout: 10000 });
  await f.page.locator('#prompt').press('Enter');
  await queued;
  assert.equal(requests, 1, 'a message typed while it works is queued, not sent to the model at once');
  /* Read now, while the answer is pending; asserted last so the other checks still report. */
  const branchHeld = await branchButton(f.page, 'Juniper checkpoint').then(b => b.isDisabled({ timeout: 10000 })).catch(error => error.message);
  await openChat(f.page, other.sessionId);
  release.resolve(); await readyConversation(f.page);
  await f.page.waitForFunction(() => !document.querySelector('#conversation .typing, #conversation .think'));
  const shown = await currentId(f.page);
  const thread = await f.page.locator('#conversation').innerText();
  if (shown === f.source.sessionId) assert.match(thread, /Pending task finished/);
  else {
    assert.equal(shown, other.sessionId);
    assert.doesNotMatch(thread, /Pending task finished|Wait for fixture/, 'no answer lands under another row');
  }
  // The waiting line ships when needed (the ship-on rule), so the message typed while it worked runs next, after the answer.
  const said = f.app.store.messages(f.source.sessionId).map(m => m.content);
  const at = said.indexOf('Wait for fixture');
  assert.deepEqual(said.slice(at, at + 2), ['Wait for fixture', 'Pending task finished']);
  assert.ok(said.indexOf('Then this too') === -1 || said.indexOf('Then this too') > at + 1, 'the queued message comes after the answer');
  assert.equal(JSON.stringify(f.app.store.sessionView('local', other.sessionId)), otherView, 'the other conversation is untouched');
  assert.deepEqual(f.errors, []);
  assert.equal(branchHeld, true, 'Branch from here waits for the pending answer');
});

test('a rejected historical tool-request branch leaves the current conversation unchanged', async (t) => {
  const f = await fixture(t, async () => ({ content: 'done', toolCalls: [] }));
  const run = f.app.store.createRun('local', 'tool fixture');
  f.app.store.message(run.sessionId, { role: 'user', content: 'Use a tool' });
  f.app.store.message(run.sessionId, { role: 'assistant', content: 'Unsafe checkpoint', toolCalls: [{ id: 't1', name: 'files.read', arguments: '{"path":"x"}' }] });
  f.app.store.finish(run.id, 'cancelled', 'fixture');
  await reloadSignedIn(f.page);
  await openConversation(f.page, run.sessionId, 'Unsafe checkpoint');
  await branchFrom(f.page, 'Unsafe checkpoint');
  await f.page.locator('.dlg').getByRole('alert').filter({ hasText: 'without tool requests' }).waitFor();
  assert.equal(await f.page.locator('.dlg').isVisible(), true, 'the refused dialog stays open with its reason');
  await f.page.locator('.dlg [data-act="dlg-close"]').first().click();
  await readyConversation(f.page);
  assert.equal(await currentId(f.page), run.sessionId, 'the conversation shown is unchanged');
  assert.match(await f.page.locator('#conversation').innerText(), /Unsafe checkpoint/);
  assert.deepEqual(f.errors, []);
});
