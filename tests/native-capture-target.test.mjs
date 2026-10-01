import test from 'node:test';
import assert from 'node:assert/strict';
import { DesktopScriptRunner, LiveScreenProcess, captureInputPayload, desktopScript } from '../dist/integrations/desktop-script.js';

const bounds = { x: -1920, y: 50, w: 1920, h: 1080 };
const monitor = { kind: 'monitor', deviceName: 'display2', bounds };
const window = { kind: 'window', handle: '123', processId: 7, bounds };
const exclusion = { processId: 99, handles: ['999'] };
const payload = (target = window) => ({ handle: '123', expectedTarget: target, expectedProcessId: 7,
  exclusion, expectedWindowBounds: bounds, pointOnTarget: { x: 0.5, y: 0.25 } });

test('input provenance and pointer/scroll bounds are checked before reaching a native program', () => {
  assert.deepEqual(captureInputPayload('click', payload()).expectedTarget, window);
  assert.equal(captureInputPayload('scroll', { ...payload(monitor), steps: -10 }).steps, -10);
  for (const changed of [{ expectedProcessId: 99 }, { expectedProcessId: 8 }, { handle: '124' },
    { pointOnTarget: { x: 1.1, y: 0 } }, { pointOnTarget: undefined }, { exclusion: undefined }])
    assert.throws(() => captureInputPayload('click', { ...payload(), ...changed }));
  for (const steps of [0, 11, -11, 0.5, NaN, undefined])
    assert.throws(() => captureInputPayload('scroll', { ...payload(), steps }));
  assert.throws(() => captureInputPayload('click', { ...payload(monitor), expectedWindowBounds: undefined }));
  assert.throws(() => captureInputPayload('click', { ...payload(monitor), expectedProcessId: 99 }));
  assert.deepEqual(captureInputPayload('type', { handle: '123', text: 'ordinary tool' }), { handle: '123', text: 'ordinary tool' });
});

function reader(t, answer, target = monitor) {
  const program = `require('readline').createInterface({input:process.stdin}).on('line',()=>process.stdout.write(${JSON.stringify(JSON.stringify(answer) + '\n')}));`;
  const process = new LiveScreenProcess(async () => ({ executable: globalThis.process.execPath, args: ['-e', program] }), target);
  t.after(() => process.close());
  return process;
}
const frame = { width: 640, height: 360, data: '/9j/', windows: [], after: [], target: monitor, method: 'monitor', screen: bounds };

test('the framed stream retains pinned monitor identity and desktop coordinates for negative-origin display', async (t) => {
  const answer = await reader(t, frame).frame(640, new AbortController().signal);
  assert.deepEqual(answer.target, monitor);
  assert.deepEqual(answer.screen, bounds);
  assert.equal(answer.method, 'monitor');
});

test('moved/resized targets, switched windows/PIDs and missing native metadata cannot become a usable frame', async (t) => {
  const answers = [
    { ...frame, target: { ...monitor, deviceName: 'display1' } },
    { ...frame, target: { ...monitor, bounds: { ...bounds, x: 0 } } },
    { ...frame, screen: { ...bounds, w: 900 } },
    { ...frame, method: 'window' }, { ...frame, target: undefined },
  ];
  for (const answer of answers) await assert.rejects(reader(t, answer).frame(640, new AbortController().signal));
  for (const changed of [{ handle: '124' }, { processId: 8 }]) {
    const answer = { ...frame, target: { ...window, ...changed }, method: 'window' };
    await assert.rejects(reader(t, answer, window).frame(640, new AbortController().signal));
  }
});

test('native target refusals propagate without a substitute frame or monitor', async (t) => {
  for (const error of ['That window closed or changed.', 'The target moved or resized.', 'Branch could not exclude its viewer.'])
    await assert.rejects(reader(t, { error }).frame(640, new AbortController().signal), new RegExp(error.replace('.', '\\.')));
});

test('startup concurrency, early cancellation and close cannot create a second native reader', async (t) => {
  let resume, starts = 0;
  const delayed = new Promise((resolve) => { resume = resolve; });
  const process = new LiveScreenProcess(async () => {
    starts++;
    await delayed;
    return { executable: globalThis.process.execPath, args: ['-e', 'process.exit(0)'] };
  }, monitor);
  t.after(() => process.close());
  const first = process.frame(640, new AbortController().signal);
  await assert.rejects(process.frame(640, new AbortController().signal), /already/);
  process.close(); resume();
  await assert.rejects(first, /closed/);
  assert.equal(starts, 1);
  assert.equal(process.running, false);
  const aborted = new AbortController(); aborted.abort();
  const early = new LiveScreenProcess(async () => { throw new Error('must not start'); }, monitor);
  await assert.rejects(early.frame(640, aborted.signal), /stopped/);
  assert.equal(early.running, false);
});

test('unsupported native target/control paths refuse before invoking Mac or Linux stand-ins', async () => {
  for (const platform of ['darwin', 'linux']) {
    const runner = new DesktopScriptRunner(undefined, { platform, enabled: true, exec: () => { throw new Error('must not run'); } });
    await assert.rejects(runner.run('capture-targets', {}, new AbortController().signal), /Windows only/);
    await assert.rejects(runner.run('click', payload(), new AbortController().signal), /Windows only/);
    await assert.rejects(runner.run('scroll', { ...payload(), steps: 2 }, new AbortController().signal), /Windows only/);
    assert.equal(runner.liveProcess(monitor, exclusion), null);
  }
});

test('Windows live capture source pins actual provenance and never substitutes the first monitor', () => {
  const live = /'live' \{([\s\S]*?)\n  default/.exec(desktopScript)?.[1] ?? '';
  assert.doesNotMatch(live, /AllScreens\[0\]/);
  assert.match(live, /display\.DeviceName == deviceName/);
  assert.match(live, /pid != targetPid/);
  assert.match(live, /pid == ownPid/);
  assert.match(live, /bounds != pinned/);
  assert.match(live, /!IsWindow\(targetWindow\)/);
  assert.match(live, /if \(IsIconic\(targetWindow\)\)/);
  assert.match(live, /affinity != 0x11/);
  assert.match(live, /version\.Build < 19041/);
  assert.match(live, /!composed/);
  assert.match(live, /VerifyExclusion\(\) != excluded/);
  assert.match(live, /Capture\(full, bounds\);\s*TargetBounds\(\)/);
  const capture = /static void Capture\([\s\S]*?\n  }/.exec(live)?.[0] ?? '';
  assert.match(capture, /if \(kind == "monitor"\).*return;/);
  assert.match(capture, /if \(!printed\) throw/);
  assert.match(capture, /if \(EmptyWindow\(image\)\) throw/);
  assert.match(live, /image\.LockBits/);
  assert.match(live, /y < image\.Height/);
  assert.match(live, /x < row\.Length; x \+= 4/);
  assert.match(live, /finally \{ image\.UnlockBits\(data\); \}/);
  assert.doesNotMatch(live, /image\.GetPixel/, 'sparse useful content is not classified by sampled pixels');
  assert.equal((capture.match(new RegExp('CopyFrom' + 'Screen', 'g')) ?? []).length, 1, 'screen copy occurs only in explicit monitor branch');
  assert.match(desktopScript, /Assert-CaptureInput \$handle\s*\[System\.Windows\.Forms\./);
  assert.match(desktopScript, /\$point = Capture-Point \$handle\s*Assert-Uncovered \$handle \$point\s*\[BranchDesktop\]::Wheel/); // computer-control: and nothing covers it
});

test('native capture snapshots include class provenance and guarded input rechecks it before effect', () => {
  const live = /'live' \{([\s\S]*?)\n  default/.exec(desktopScript)?.[1] ?? '';
  assert.match(live, /GetClassNameW\(h, className, 256\)/);
  assert.match(live, /Quoted\(className\.ToString\(\)\)/);
  const guard = /function Assert-CaptureInput\(\$handle\) \{([\s\S]*?)\n\}/.exec(desktopScript)?.[1] ?? '';
  assert.match(guard, /Get-Process -Id \$owner -ErrorAction Stop/);
  assert.match(guard, /\[BranchDesktop\]::ClassOf\(\$handle\)/);
  assert.match(guard, /chrome_widget\|chromium\|mozilla\|webview\|cefbrowser/);
  assert.match(guard, /Browser and Branch viewer windows cannot be controlled/);
});