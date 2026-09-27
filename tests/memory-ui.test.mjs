import test from 'node:test';
import { openPlace } from "./places.mjs";
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { newWindow, openPlace as openNewPlace, placeRoot } from './new-window-places.mjs';

/* Redesign: the new window's Library › Memory (public/app/places/library.js) lists what is remembered with Forget, a
   "N of M remembered" ring, Tidy up, and a More menu that exports (JSON Lines or a full archive) and opens the archive.
   The prototype has no per-fact editor, no "Save memory" box, no limit field and no import box; tests of those are
   skipped as replaced, and what they proved of the engine is asked of its routes. */
async function windowFixture(t, seed = true) {
  const provider = { name: 'memory-ui', async complete(request) {
    const reply = request.messages.findLast(message => message.role === 'tool');
    if (reply) return { content: JSON.parse(reply.content).result[0].data.text, toolCalls: [] };
    return { content: '', toolCalls: [{ id: 'memory', name: 'memory.search', arguments: '{"query":"Juniper"}' }] };
  } };
  const f = await newWindow(t, { provider, seed: seed ? app => app.runtime.executeTool('memory.put', { text: 'Juniper meeting Monday', source: 'Original note' }) : undefined });
  await openNewPlace(f.page, 'library', 'memory');
  return f;
}
const importArchive = (f, body) => fetch(new URL('/api/memory/import', f.server.url), { method: 'POST',
  headers: { authorization: `Bearer ${f.server.token}`, 'content-type': 'application/json' }, body }).then(async r => ({ status: r.status, body: await r.json() }));

const record = f => f.app.store.list('memory', 'local')[0];
const fact = page => page.locator('#memory-list article').first();
async function edit(page, text, source) {
  await fact(page).getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByLabel('Edit memory fact', { exact: true }).fill(text);
  await page.getByLabel('Edit memory source', { exact: true }).fill(source);
}
/* An import is finished only when the box takes files again: the result is written first and the
   page refreshed after, and a file chosen before then is ignored. On a loaded runner the next file
   was chosen in that gap and the first import's result was read back as the second's. */
const importDone = page => page.waitForFunction(() => !document.getElementById('memory-import').disabled);
async function upload(page, archive) {
  await importDone(page);
  await page.locator('#memory-import').setInputFiles({ name: 'memory.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(archive)) });
  await importDone(page);
}

test('memory capacity rejects additional facts and cannot drop below the saved count', async t => {
  // Redesign: the limit is set through the engine (POST /api/memory/capacity; prototype.html has no limit field), and the
  // window's ring reads what the engine keeps.
  const f = await windowFixture(t), ring = placeRoot(f.page).locator('.memst15');
  assert.deepEqual(await f.call('/api/memory/capacity', { maxFacts: 1 }), { count: 1, maxFacts: 1 });
  await f.page.reload(); await f.page.locator('#app #side').waitFor({ state: 'visible', timeout: 120000 });
  await openNewPlace(f.page, 'library', 'memory');
  await ring.filter({ hasText: '1 of 1 remembered' }).waitFor();
  const refused = await f.call('/api/action', { tool: 'memory.put', args: { text: 'Extra fact', source: 'Typed here' } });
  assert.match(JSON.stringify(refused), /capacity reached/);
  assert.equal(f.app.store.list('memory', 'local').length, 1);
  assert.deepEqual(await f.call('/api/memory/capacity', { maxFacts: 2 }), { count: 1, maxFacts: 2 });
  await f.call('/api/action', { tool: 'memory.put', args: { text: 'Extra fact', source: 'Typed here' } });
  await f.page.reload(); await f.page.locator('#app #side').waitFor({ state: 'visible', timeout: 120000 });
  await openNewPlace(f.page, 'library', 'memory');
  await ring.filter({ hasText: '2 of 2 remembered' }).waitFor();
  assert.match(await placeRoot(f.page).innerText(), /Juniper meeting Monday[\s\S]*Extra fact|Extra fact[\s\S]*Juniper meeting Monday/);
  assert.match(JSON.stringify(await f.call('/api/memory/capacity', { maxFacts: 1 })), /below the current count/);
  assert.deepEqual(f.errors, []);
});

test('memory file export/import preserves metadata in an empty store and conflicts merge atomically', async t => {
  // Redesign: the archive is saved from Library › Memory's More menu ("Save a full archive"); prototype.html has no import
  // box, so the file goes back in through the engine's own route (POST /api/memory/import).
  const source = await windowFixture(t), destination = await windowFixture(t, false);
  await placeRoot(source.page).locator('[data-act="memmore15"]').click();
  const download = source.page.waitForEvent('download');
  await source.page.locator('.pop [data-act="memexp15"][data-v="archive"]').click();
  const file = await download, path = join(source.root, 'memory.json'); await file.saveAs(path);
  const archive = JSON.parse(await readFile(path, 'utf8'));
  assert.deepEqual(await importArchive(destination, JSON.stringify(archive)), { status: 200, body: { imported: 1, unchanged: 0 } });
  assert.deepEqual(record(destination), record(source));
  await destination.page.reload(); await destination.page.locator('#app #side').waitFor({ state: 'visible', timeout: 120000 });
  await openNewPlace(destination.page, 'library', 'memory');
  await placeRoot(destination.page).getByText('Juniper meeting Monday').waitFor();
  assert.deepEqual((await importArchive(destination, JSON.stringify(archive))).body, { imported: 0, unchanged: 1 });
  const snapshot = JSON.stringify(destination.app.store.list('memory', 'local'));
  const conflict = structuredClone(archive);
  conflict.records.unshift({ ...structuredClone(archive.records[0]), id: 'new-fact' });
  conflict.records[1].data.text = 'Conflicting text';
  assert.match((await importArchive(destination, JSON.stringify(conflict))).body.error, /conflicts/);
  assert.equal(JSON.stringify(destination.app.store.list('memory', 'local')), snapshot);
  const broken = await importArchive(destination, '{broken');
  assert.equal(broken.status, 400);
  assert.deepEqual([...source.errors, ...destination.errors], []);
});
