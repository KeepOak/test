import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discardTemp } from './temp-dir.mjs';
import { _electron } from 'playwright';
import { saveConversationExport, saveMemoryExport, saveMemoryLinesExport } from '../dist/desktop/conversation-export.js';
import { exportedMemoryLines } from '../dist/memory-export.js';
import { createBranch } from '../dist/index.js';
import { connected, desktopOptions, onboarded, send, taskDone } from './fixtures/desktop-options.mjs';

const archive = { format: 'branch-agent-conversation', version: 1, exportedAt: '2026-09-15T00:00:00.000Z',
  messages: [{ role: 'user', content: 'Export fixture' }, { role: 'assistant', content: 'Saved response' }] };
const memoryArchive = { format: 'branch-agent-memory', version: 1, exportedAt: archive.exportedAt,
  records: [{ id: 'memory-fixture', data: { text: 'Saved fact', source: 'Fixture', sourceRunId: '' },
    createdAt: archive.exportedAt, updatedAt: archive.exportedAt, revision: 1 }] };

test('native export validates text before choosing a file and writes only a chosen destination', async (t) => {
  const scratch = join(tmpdir(), 'Codex-session-files'); await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, 'branch-export-')), path = join(root, 'conversation.json');
  t.after(() => discardTemp(root));
  let dialogs = 0;
  const choose = async () => { dialogs++; return path; };
  for (const value of [archive, '{broken', '{}', '☃'.repeat(1500000), JSON.stringify({ ...archive, path })])
    await assert.rejects(saveConversationExport(value, choose));
  assert.equal(dialogs, 0);
  assert.deepEqual(await saveConversationExport(JSON.stringify(archive), async () => undefined), { saved: false });
  await assert.rejects(stat(path), { code: 'ENOENT' });
  assert.deepEqual(await saveConversationExport(JSON.stringify(archive), choose), { saved: true });
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), archive);
  assert.equal(dialogs, 1);
});

test('native memory export validates archive and raw UTF8 size before opening the save dialog', async t => {
  const scratch = join(tmpdir(), 'Codex-session-files'); await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, 'branch-memory-export-')), path = join(root, 'memory.json');
  t.after(() => discardTemp(root));
  let dialogs = 0; const choose = async () => { dialogs++; return path; };
  for (const value of [memoryArchive, '{}', JSON.stringify(archive), '☃'.repeat(5600000), JSON.stringify({ ...memoryArchive, path })])
    await assert.rejects(saveMemoryExport(value, choose));
  assert.equal(dialogs, 0);
  assert.deepEqual(await saveMemoryExport(JSON.stringify(memoryArchive), async () => undefined), { saved: false });
  await assert.rejects(stat(path), { code: 'ENOENT' });
  assert.deepEqual(await saveMemoryExport(JSON.stringify(memoryArchive), choose), { saved: true });
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), memoryArchive);
});

/* rw4: Library › Memory's "Export what it remembers" (JSON Lines), saved through the same guarded export. */
const memoryLines = [
  { id: 'memory-line-1', data: { text: 'First saved fact', source: 'Fixture', sourceRunId: '' }, createdAt: archive.exportedAt, updatedAt: archive.exportedAt, revision: 1 },
  { id: 'memory-line-2', data: { text: 'Second saved fact', source: 'Fixture', sourceRunId: '' }, createdAt: archive.exportedAt, updatedAt: archive.exportedAt, revision: 2 },
].map((line) => JSON.stringify(line)).join('\n') + '\n';

/* Mutation: in src/desktop/conversation-export.ts saveMemoryLinesExport, write `input` instead of
   `exportedMemoryLines(input)` → a bad line reaches the Save dialog and is written. */
test('native memory lines export checks every line before choosing a file and writes only the facts it read', async t => {
  const scratch = join(tmpdir(), 'Codex-session-files'); await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, 'branch-memory-lines-')), path = join(root, 'memory.jsonl');
  t.after(() => discardTemp(root));
  let dialogs = 0; const choose = async () => { dialogs++; return path; };
  const bad = [
    { lines: memoryLines },                                  // not text
    `${memoryLines}{broken\n`,                               // one line that is not JSON
    `${memoryLines}${JSON.stringify({ id: 'x', path })}\n`,   // one line that is not a saved fact
    JSON.stringify(memoryArchive),                           // the full archive, not lines
    `${memoryLines}${'x'.repeat(17 * 1024 * 1024)}`,         // over 16 MiB
  ];
  for (const value of bad) await assert.rejects(saveMemoryLinesExport(value, choose));
  assert.equal(dialogs, 0, 'nothing that failed the check reached the Save dialog');
  assert.deepEqual(await saveMemoryLinesExport(memoryLines, async () => undefined), { saved: false });
  await assert.rejects(stat(path), { code: 'ENOENT' });
  assert.deepEqual(await saveMemoryLinesExport(memoryLines.replaceAll('\n', '\r\n'), choose), { saved: true });
  assert.equal(await readFile(path, 'utf8'), memoryLines, 'the facts as read back, one per line');
  assert.deepEqual(await saveMemoryLinesExport('', choose), { saved: true }, 'no facts is an empty file');
  assert.equal(await readFile(path, 'utf8'), '');
  assert.equal(dialogs, 2);
});

/* The desktop's check must take a real owner's export as it is: facts saved the ordinary way (the memory tool, with a
   subject, detail and kind, and one carrying every optional field), not only facts that came in through the import. */
test('the engine\'s own JSON Lines export passes the desktop check unchanged', async t => {
  const root = await mkdtemp(join(tmpdir(), 'branch-memory-lines-real-'));
  const provider = { name: 'scripted', async complete() { return { content: 'Done.', toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, 'workspace'), dataDir: join(root, 'data'), provider });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const owner = app.runtime.owner;
  const run = app.store.createRun(owner, 'remember these');
  const context = app.runtime.context({ runId: run.id });
  await app.registry.execute('memory.put', { text: 'Ada likes tea', source: 'chat', entity: 'Ada', attribute: 'drink', kind: 'preference' }, context);
  await app.registry.execute('memory.put', { text: 'A plain fact', source: 'chat' }, context);
  const later = new Date(Date.now() + 86400000).toISOString();
  app.store.save('memory', owner, '11111111-2222-4333-8444-555555555555', { text: 'Every field', source: 'owner', sourceRunId: run.id,
    originRunId: run.id, validFrom: new Date().toISOString(), validTo: null, scope: 'shared', project: 'home', promoted: true, tags: ['kept'], expiresAt: later });
  const text = app.memory.transfer.export(owner);
  assert.equal(text.trim().split('\n').length, 3, text);
  assert.equal(exportedMemoryLines(text), text, 'what the desktop writes is exactly what the browser downloads');
});

/* Redesign: the old window exported from Conversation history (Ctrl+K) and Memory's own buttons, through
   window.branchDesktop. The new window exports a conversation from its menu (the prototype's "Export conversation")
   and memory from Library › Memory's menu ("Save a full archive", and "Export what it remembers" as JSON Lines). The
   guarded IPC, the refused other window and the blanket download blocker are checked first, from the page; then each
   export is pressed in the window and must reach the guarded IPC, since a <a download> is dropped by the blocker. */
async function launchWithDialog(name) {
  const { home, options } = await desktopOptions(), path = join(home, name);
  const electron = await _electron.launch(options);
  // Each click waits for the window to take it; a loaded build machine has spent over ten seconds on one click.
  const page = await electron.firstWindow(); page.setDefaultTimeout(60000);
  await onboarded(page);
  await electron.evaluate(({ dialog }, path) => {
    globalThis.fixtureExportDialogs = [];
    dialog.showSaveDialog = async (_window, options) => {
      globalThis.fixtureExportDialogs.push(options);
      return { canceled: false, filePath: path };
    };
  }, path);
  return { electron, page, path };
}

const dialogsShown = (electron) => electron.evaluate(() => globalThis.fixtureExportDialogs);
/* The file is written after the dialog answers, so it is read again until it is whole (it once read mid-write). */
async function savedJson(path) {
  for (let waited = 0; ; waited += 100) {
    try { return JSON.parse(await readFile(path, 'utf8')); }
    catch (error) { if (waited >= 10000) throw error; await new Promise((done) => setTimeout(done, 100)); }
  }
}
async function windowAskedForFile(electron, what) {
  for (let waited = 0; waited < 15000 && !(await dialogsShown(electron)).length; waited += 250)
    await new Promise((done) => setTimeout(done, 250));
  assert.equal((await dialogsShown(electron)).length, 1,
    `Window bug: ${what} in the desktop app never reaches window.branchDesktop (it saves with <a download>, which the desktop's download blocker drops), so nothing is saved`);
}

test('native conversation export uses guarded IPC and leaves the blanket download blocker enabled', { timeout: 360000 }, async () => {
  const { electron, page, path } = await launchWithDialog('exported-conversation.json');
  try {
    const invalid = await page.evaluate(() => window.branchDesktop.exportConversation('{}').then(() => 'allowed', error => error.message));
    assert.notEqual(invalid, 'allowed');
    const invalidMemory = await page.evaluate(() => window.branchDesktop.exportMemory('{}').then(() => 'allowed', error => error.message));
    assert.notEqual(invalidMemory, 'allowed');
    const invalidLines = await page.evaluate(() => window.branchDesktop.exportMemoryLines('{"id":"x"}\n').then(() => 'allowed', error => error.message));
    assert.notEqual(invalidLines, 'allowed');
    assert.equal((await dialogsShown(electron)).length, 0);
    assert.equal(await downloadBlocked(electron), true);
    await rejectOtherWindow(electron, page.url());
    await send(page, 'Export the demo conversation');
    // Waiting for a whole task to finish, not for the page to paint: widened for a loaded build machine.
    await taskDone(page, 'Export the demo conversation');
    await page.locator('[data-act="chatmenu"]').first().click();
    await page.locator('.pop [data-act="export-conv"]').click();
    await windowAskedForFile(electron, 'Export conversation');
    const saved = await savedJson(path);
    assert.equal(saved.format, 'branch-agent-conversation');
    assert.equal(saved.messages[0].content, 'Export the demo conversation');
    assert.equal(saved.messages.at(-1).role, 'assistant');
    assert.deepEqual((await dialogsShown(electron))[0].filters[0].extensions, ['json']);
    assert.equal(await downloadBlocked(electron), true);
  } finally { await electron.close(); }
});

test('native memory export from Library uses guarded IPC', { timeout: 360000 }, async () => {
  const { electron, page, path } = await launchWithDialog('exported-memory.json');
  try {
    // The new Library has no box to type a fact into (Trunks suggest what to remember); the fact is put in through the
    // engine's own import, as a person's earlier export would be.
    await page.evaluate(async () => {
      const jsonl = JSON.stringify({ id: '6b1f3c2e-8d4a-4f5e-9a7b-2c3d4e5f6a7b', data: { text: 'Native exported memory' } });
      const response = await fetch('/api/memory/import', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonl }) });
      if (!response.ok) throw new Error(`import: ${response.status}`);
    });
    // The import sends the window no event, so the window reads the engine again, as a person reopening it would.
    await page.reload();
    await connected(page);
    await page.locator('#side [data-act="view"][data-v="library"]').click();
    await page.locator('[data-act="ptab"][data-place="library"][data-v="memory"][aria-selected="true"]').waitFor();
    await page.locator('.memst15').filter({ hasText: /\b1 of \d+ remembered/ }).waitFor();
    await page.getByRole('button', { name: 'More for memory', exact: true }).click();
    await page.locator('.pop [data-act="memexp15"][data-v="archive"]').click();
    await windowAskedForFile(electron, 'Library › Memory, "Save a full archive"');
    const saved = await savedJson(path);
    assert.equal(saved.format, 'branch-agent-memory');
    assert.equal(saved.records[0].data.text, 'Native exported memory');
    assert.equal(saved.records[0].revision, 1);
    assert.equal((await dialogsShown(electron))[0].defaultPath, 'branch-memory.json');
    assert.equal(await downloadBlocked(electron), true);
  } finally { await electron.close(); }
});

/* rw4: "Export what it remembers" (JSON Lines) goes through the same guarded export, to a .jsonl file.
   Mutation: in public/app/places/library.js drop the `exportMemoryLines` branch → the download is dropped, no dialog. */
test('native memory lines export from Library uses guarded IPC', { timeout: 360000 }, async () => {
  const { electron, page, path } = await launchWithDialog('exported-memory.jsonl');
  try {
    await page.evaluate(async () => {
      const jsonl = JSON.stringify({ id: '7c2a4d3f-9e5b-4a6c-8b1d-3e4f5a6b7c8d', data: { text: 'Native exported lines' } });
      const response = await fetch('/api/memory/import', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonl }) });
      if (!response.ok) throw new Error(`import: ${response.status}`);
    });
    await page.reload();
    await connected(page);
    await page.locator('#side [data-act="view"][data-v="library"]').click();
    await page.locator('[data-act="ptab"][data-place="library"][data-v="memory"][aria-selected="true"]').waitFor();
    await page.locator('.memst15').filter({ hasText: /\b1 of \d+ remembered/ }).waitFor();
    await page.getByRole('button', { name: 'More for memory', exact: true }).click();
    await page.locator('.pop [data-act="memexp15"]:not([data-v])').click();
    await windowAskedForFile(electron, 'Library › Memory, "Export what it remembers"');
    let text = '';
    for (let waited = 0; waited < 10000 && !text.endsWith('\n'); waited += 100) {
      text = await readFile(path, 'utf8').catch(() => '');
      if (!text.endsWith('\n')) await new Promise((done) => setTimeout(done, 100));
    }
    const lines = text.trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(lines.length, 1);
    assert.equal(lines[0].data.text, 'Native exported lines');
    const [shown] = await dialogsShown(electron);
    assert.equal(shown.defaultPath, 'memory.jsonl');
    assert.deepEqual(shown.filters[0].extensions, ['jsonl']);
    assert.equal(await downloadBlocked(electron), true);
  } finally { await electron.close(); }
});

async function downloadBlocked(electron) {
  return electron.evaluate(({ BrowserWindow }) => {
    let blocked = false;
    BrowserWindow.getAllWindows()[0].webContents.session.emit('will-download', { preventDefault() { blocked = true; } });
    return blocked;
  });
}
async function rejectOtherWindow(electron, url) {
  const opened = electron.waitForEvent('window');
  const id = await electron.evaluate(({ app, BrowserWindow }, url) => {
    const other = new BrowserWindow({ show: false, webPreferences: {
      preload: `${app.getAppPath()}/dist/desktop/preload.cjs`, sandbox: true, contextIsolation: true,
    } });
    void other.loadURL(url); return other.id;
  }, url);
  try {
    const other = await opened;
    const result = await other.evaluate(text => window.branchDesktop.exportConversation(text).then(() => 'allowed', error => error.message), JSON.stringify(archive));
    assert.match(result, /access denied/);
    const memory = await other.evaluate(text => window.branchDesktop.exportMemory(text).then(() => 'allowed', error => error.message), JSON.stringify(memoryArchive));
    assert.match(memory, /access denied/);
    const lines = await other.evaluate(text => window.branchDesktop.exportMemoryLines(text).then(() => 'allowed', error => error.message), memoryLines);
    assert.match(lines, /access denied/);
  } finally { await electron.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id)?.destroy(), id); }
}

