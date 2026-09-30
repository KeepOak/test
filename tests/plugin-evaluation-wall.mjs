// The strong wall a plugin evaluation uses, built for real, with only its last step stood in: instead of starting
// WSL (Windows) or bubblewrap (elsewhere), the fixture's own host program runs in the scratch folder. The plan the
// wall wrote is checked first. Tests that need the real wall itself live in tests/plugin-lifecycle.test.mjs and skip
// where this computer has none (Linux build machines have no bubblewrap).
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

async function runHost(cwd) {
  const output = await promisify(execFile)(process.execPath, [join(cwd, 'host.mjs')], { cwd });
  return { status: 'completed', exitCode: 0, stdout: output.stdout, stderr: output.stderr, truncated: false, durationMs: 1 };
}

/** Windows: the held WSL plan (no registry, no network, scratch only, nothing of Windows' environment). */
function heldWsl(runs) {
  return {
    wallDeps: { platform: 'win32', probe: async (_exe, args) => ({ code: 0, stdout: args.includes('-p') ? 'linux' : '', stderr: '' }) },
    spawn: async (start, limits) => {
      const plan = JSON.parse(await readFile(join(start.cwd, 'held-plan.json'), 'utf8'));
      assert.equal(plan.registry, false); assert.equal(plan.open, undefined); assert.equal(plan.interactive, false); assert.equal(plan.scratchOnly, true);
      assert.deepEqual(plan.env, {}); assert.deepEqual(plan.secrets, []); assert.equal(limits.network, false);
      assert.match(start.executable, /wsl\.exe$/i); runs.push(plan);
      return runHost(start.cwd);
    },
  };
}

/** Linux and macOS hosts: the bubblewrap plan, narrowed to scratch plus the runtime, with no network. */
function bubblewrap(runs) {
  return {
    wallDeps: { platform: 'linux', locateBwrap: async () => '/usr/bin/bwrap', probe: async () => ({ code: 0, stdout: '', stderr: '', missing: false }) },
    spawn: async (start, limits) => {
      const args = start.args, at = args.indexOf('--tmpfs');
      assert.ok(args.includes('/usr/bin/bwrap'), 'started through bubblewrap');
      assert.equal(args[at + 1], '/', 'the whole disk is replaced by an empty scratch root');
      assert.ok(!args.some((arg, i) => arg === '--ro-bind' && args[i + 1] === '/' && args[i + 2] === '/'), 'the owner disk is not bound');
      assert.ok(args.includes('--unshare-net')); assert.equal(limits.network, false);
      runs.push({ args });
      return runHost(start.cwd);
    },
  };
}

/** `{ wallDeps, spawn, runs }` for a PluginEvaluations `wall` option, on whatever system the tests run. */
export function evaluationWall() {
  const runs = [];
  return { ...(process.platform === 'win32' ? heldWsl(runs) : bubblewrap(runs)), runs };
}
