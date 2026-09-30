import { api } from '../core/api.js';
import { esc } from '../core/dom.js';
import { on } from '../core/actions.js';
import { openPop, closePop, toast } from '../core/ui.js';
import { markLive } from '../core/features.js';
import { t } from '../../i18n.js';

let host, binding, requests = [], draft = null, anchor = null, capturing = false, busy = false;
const field = (id, label, value = '') => `<label>${esc(label)}<input id="net-${id}" value="${esc(value)}" autocomplete="off"></label>`;
const value = id => document.getElementById(`net-${id}`)?.value.trim() ?? '';
const button = (action, label) => `<button class="btn sm" type="button" data-act="network-${action}">${label}</button>`;
const show = html => openPop(anchor, `<div class="network-learning" role="group" aria-label="Learn an API">${html}</div>`, { force: true, label: 'Learn an API' });
const call = (operation, extra = {}) => api('panels/browser/network', { ...binding, operation, ...extra });
const attempt = action => async el => {
  if (busy) return;
  busy = true;
  try { await action(el); } catch (error) { toast(error.message); } finally { busy = false; }
};

export function networkLearningButtons() {
  return host?.available() ? button('open', capturing ? 'Review API capture' : 'Learn an API') : '';
}
async function open(el) {
  anchor = el;
  if (capturing) { await review(); return; }
  binding = host.bound(); requests = []; draft = null;
  show(`<b>Learn a selected API request</b><p>Observe this tab for 30 seconds. Branch keeps field names only; cookies, headers, input values and answers are never recorded.</p>
    ${field('origin', 'Website origin', 'https://')}${field('path', 'Exact API path', '/api/')}
    <label>Method<select id="net-method"><option>GET</option><option>POST</option></select></label>
    ${button('start', 'Start observing')}`);
}
async function start() {
  await call('start', { options: { origin: value('origin'), path: value('path'), method: value('method'), seconds: 30 } });
  capturing = true; closePop(); host.onChange(); toast(t('window.network-learning.observing'));
}
async function review() {
  const result = await call('stop'); capturing = false; requests = result.requests; host.onChange();
  show(`<b>Choose a request</b><p>${requests.length} matching requests. No captured values will be reused.</p>${requests.map((request, index) =>
    `<button class="mi" type="button" data-act="network-select" data-index="${index}" ${request.unsupported ? 'disabled' : ''}>${esc(request.method)} ${esc(request.path)}<small>${esc(request.unsupported ?? [...request.query, ...request.body].join(', '))}</small></button>`).join('')}`);
}
let selected;
function select(el) {
  selected = requests[Number(el.dataset.index)];
  if (!selected || selected.unsupported) return;
  show(`<b>Create a reusable API skill</b>${field('name', 'Skill name', 'my-api')}${field('description', 'What this skill does')}
    ${field('pick', 'Response fields (comma-separated dotted paths)', 'result')}
    <p>${selected.needsCredentials ? 'The request used browser credentials. Supply a saved API credential; cookies cannot be copied.' : 'Optional: use an API credential saved in this project.'}</p>
    ${field('secret', 'Locker secret name (optional)')}<label>Credential header<select id="net-header"><option>Authorization</option><option>X-Api-Key</option></select></label>
    <label><input id="net-bearer" type="checkbox">Use Bearer prefix</label>${button('draft', 'Create draft')}`);
}
async function createDraft() {
  const secret = value('secret');
  draft = await call('draft', { requestId: selected.id, options: { name: value('name'), description: value('description'),
    pick: value('pick').split(',').map(part => part.trim()).filter(Boolean),
    ...(secret ? { credential: { name: value('header'), secret, bearer: document.getElementById('net-bearer').checked } } : {}) } });
  showTest();
}
function showTest() {
  show(`<b>Test ${esc(draft.name)}</b><p>${esc(draft.tool.method)} ${esc(draft.tool.url)}. This sends one real request. Inputs and expected values are used for this test only.</p>
    ${Object.keys(draft.tool.input).map(name => field(`arg-${name}`, name)).join('')}
    ${draft.tool.pick.map((path, i) => field(`expect-${i}`, `Expected ${path} (JSON value)`)).join('')}
    ${draft.tool.method === 'POST' ? '<label><input id="net-mutation" type="checkbox">I authorize this exact POST and its side effect</label>' : ''}
    ${button('test', 'Send request and check result')}`);
}
async function testDraft() {
  const args = Object.fromEntries(Object.keys(draft.tool.input).map(name => [name, value(`arg-${name}`)]));
  const expected = Object.fromEntries(draft.tool.pick.map((path, i) => [path, JSON.parse(value(`expect-${i}`))]));
  if (draft.tool.method === 'POST' && !document.getElementById('net-mutation')?.checked) throw new Error('Confirm the POST side effect first.');
  const result = await call('test', { draftId: draft.id, options: { arguments: args, expected, confirm: true,
    ...(draft.tool.method === 'POST' ? { confirmMutation: `${draft.tool.method} ${draft.tool.url} ${draft.revision} ${JSON.stringify(args)}` } : {}) } });
  if (!result.passed) { toast(t('window.network-learning.mismatch')); return; }
  show(`<b>Test passed</b><p>${esc(draft.name)} calls ${esc(new URL(draft.tool.url).host)} using skills.http. Installation keeps it switched off until you enable it in Skills.</p>${button('install', 'Install tested skill')}`);
}
async function install() {
  await call('install', { draftId: draft.id, revision: draft.revision }); closePop(); draft = null;
  toast(t('window.network-learning.installed'));
}
export function initNetworkLearning(options) {
  host = options;
  markLive(['network-open', 'network-start', 'network-select', 'network-draft', 'network-test', 'network-install']);
  on('network-open', attempt(open)); on('network-start', attempt(start)); on('network-select', attempt(select));
  on('network-draft', attempt(createDraft)); on('network-test', attempt(testDraft)); on('network-install', attempt(install));
}
