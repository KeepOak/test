import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { world, matrix, goldenText, probedRoutes } from './caller-policy-world.mjs';

test('the eight browser endpoints (demonstration and network capture since #890) preserve exact route policy answers across all isolated caller states', async t => {
  const w = await world(); t.after(() => w.close());
  const routes = probedRoutes().filter(({ path }) => path === '/api/panels/browser' || path.startsWith('/api/panels/browser/'));
  assert.equal(routes.length, 16);
  const rows = await matrix(w, { routes }), generated = goldenText(rows).split('\n').filter(line => line && !line.startsWith('#'));
  const kept = new Set((await readFile(join(import.meta.dirname, 'caller-policy.golden.txt'), 'utf8')).split('\n'));
  assert.equal(generated.length, 80); assert.deepEqual(generated.filter(line => !kept.has(line)), []);
  for (const row of rows) for (const [kind, answer] of row.each) {
    if (['phone', 'legacy', 'remote', 'person', 'read', 'run'].includes(kind)) assert.notEqual(answer, 'ok', `${row.state} ${row.method} ${row.path} ${kind}`);
  }
});
