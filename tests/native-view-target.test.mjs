import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeWindowViewable } from '../dist/integrations/native-view-target.js';
const window = { processId: 42, program: 'notepad', className: 'Notepad', minimised: false };
test('only trusted external application provenance qualifies for the initial native viewer grant', () => {
  assert.equal(nativeWindowViewable(window, 100), true);
  for (const changed of [null, {}, { ...window, processId: 100 }, { ...window, processId: 0 }, { ...window, minimised: true },
    { ...window, program: '' }, { ...window, program: 'C:\\fake\\editor.exe' }, { ...window, className: '' }])
    assert.equal(nativeWindowViewable(changed, 100), false);
  assert.equal(nativeWindowViewable(window, 0), false);
});
test('browser and Branch process identities refuse independently of misleading titles', () => {
  for (const program of ['chrome', 'Chromium.exe', 'msedgewebview2', 'firefox', 'electron', 'branch', 'Branch Agent', 'browser', 'brave', 'opera', 'librewolf'])
    assert.equal(nativeWindowViewable({ ...window, program, title: 'Stand-in native Notes' }, 100), false, program);
  for (const className of ['Chrome_WidgetWin_1', 'MozillaWindowClass', 'CefBrowserWindow', 'WinWebView2', 'ChromiumHidden'])
    assert.equal(nativeWindowViewable({ ...window, program: 'renamed-editor', className }, 100), false, className);
});
