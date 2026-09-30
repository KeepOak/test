import { esc } from '../core/dom.js';
import { api } from '../core/api.js';
import { on } from '../core/actions.js';
import { openDlg, closeDlg, toast } from '../core/ui.js';
import { markLive } from '../core/features.js';
import { t } from '../../i18n.js';

let hooks, lesson = null, preview = null;
const button = (action, text) => `<button class="btn sm" type="button" data-act="demo-${action}">${text}</button>`;
export function demonstrationButtons() {
  if (!hooks?.available()) return '';
  return lesson ? button('preview', t('demonstration.preview')) + button('cancel', t('demonstration.cancel')) : button('start', t('demonstration.start'));
}
export function forgetDemonstration() { lesson = null; preview = null; }
async function call(operation, extra = {}) {
  const scope = hooks.bound();
  if (!scope.tabId) throw new Error(t('demonstration.wait'));
  if (lesson && (lesson.id !== scope.id || lesson.sessionId !== scope.sessionId)) forgetDemonstration();
  return api('panels/browser/demonstration', { ...scope, operation, ...extra });
}
async function start() {
  await call('start'); lesson = hooks.bound(); hooks.onChange(true);
  toast(t('demonstration.recording'));
}
async function showPreview() {
  preview = await call('preview');
  const omissions = preview.omissions.map(text => `<li>${esc(text)}</li>`).join('');
  openDlg({ title: t('demonstration.title'), body: `<label>${t('demonstration.name')}<input id="demo-name" maxlength="80" value="${esc(preview.definition.name)}"></label>
    <p>${t('demonstration.explanation')}</p>${omissions ? `<p>${t('demonstration.omissions')}</p><ul>${omissions}</ul>` : ''}
    <pre>${esc(JSON.stringify(preview.definition.steps, null, 2))}</pre>`,
    foot: button('cancel', t('demonstration.discard')) + (omissions ? '' : button('save', t('demonstration.save'))) });
}
async function save() {
  if (!preview) return;
  const name = document.getElementById('demo-name')?.value.trim() || preview.definition.name;
  const result = await call('save', { name, previewToken: preview.previewToken });
  forgetDemonstration(); closeDlg(); hooks.onChange(true); toast(t('demonstration.saved', { name: result.workflow.name }));
}
async function cancel() { await call('cancel'); forgetDemonstration(); closeDlg(); hooks.onChange(true); }
export function initDemonstrations(context) {
  hooks = context; markLive(['demo-start', 'demo-preview', 'demo-save', 'demo-cancel']);
  const perform = work => hooks.inOrder(async () => { try { await work(); } catch (error) { toast(error.message); } });
  on('demo-start', () => perform(start));
  on('demo-preview', () => perform(showPreview));
  on('demo-save', () => perform(save));
  on('demo-cancel', () => perform(cancel));
}
