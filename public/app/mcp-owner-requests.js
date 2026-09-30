import { api } from './core/api.js';
import { toast } from './core/ui.js';
import { on } from './core/actions.js';
import { markLive } from './core/features.js';
import { t } from '../i18n.js';

/** A visible, local owner form is the heartbeat; closing it immediately stops renewing capability. */
export function initMcpOwnerRequests() {
  markLive(['mcp-owner-requests']);
  on('mcp-owner-requests', open);
}
async function open() {
  const panel = document.createElement('dialog');
  const heading = document.createElement('h2'); heading.textContent = t('window.mcp-asks.title');
  const notice = document.createElement('p');
  notice.textContent = t('window.mcp-asks.purpose');
  const settings = document.createElement('form'), requests = document.createElement('section');
  const close = document.createElement('button'); close.type = 'button'; close.textContent = t('window.mcp-asks.close');
  close.addEventListener('click', () => panel.close());
  panel.append(heading, notice, settings, requests, close); document.body.append(panel); panel.showModal();
  let seen = '', busy = false;
  const poll = async () => {
    if (!panel.open || busy || document.visibilityState !== 'visible') return;
    busy = true;
    try {
      const state = await api('mcp/owner-requests/window', {});
      if (!settings.childNodes.length) drawSettings(settings, state.models);
      const ids = state.requests.map(r => r.id).join(',');
      if (ids !== seen) {
        seen = ids;
        const wanted = new Set(state.requests.map(r => r.id));
        for (const card of requests.children) if (!wanted.has(card.dataset.request)) card.remove();
        for (const request of state.requests) if (![...requests.children].some(card => card.dataset.request === request.id)) requests.append(question(request));
      }
    } catch (error) { toast(error.message); panel.close(); }
    finally { busy = false; }
  };
  const timer = setInterval(poll, 5000);
  panel.addEventListener('close', () => { clearInterval(timer); panel.remove(); void api('mcp/owner-requests/close', {}).catch(() => {}); }, { once: true });
  await poll();
}
function field(form, label, type = 'text') {
  const row = document.createElement('label'), input = document.createElement('input');
  row.textContent = label; input.type = type; row.append(input); form.append(row); return input;
}
function drawSettings(form, models) {
  const server = field(form, 'Server ID'); server.required = true; server.pattern = '[a-z][a-z0-9-]{0,29}';
  const sampling = field(form, 'Allow requests to a model', 'checkbox');
  const elicitation = field(form, 'Allow questions for you', 'checkbox');
  const rpm = field(form, 'Requests per minute', 'number'); rpm.value = '3'; rpm.min = '1'; rpm.max = '20';
  const cap = field(form, 'Maximum output tokens per request', 'number'); cap.value = '2048'; cap.min = '128'; cap.max = '8192';
  const allowed = document.createElement('select'); allowed.multiple = true;
  allowed.setAttribute('aria-label', t('window.mcp-asks.models'));
  for (const model of models) { const option = new Option(model.name, model.id); allowed.add(option); }
  form.append(allowed);
  const load = document.createElement('button'); load.type = 'button'; load.textContent = t('window.mcp-asks.read');
  load.onclick = async () => {
    try {
      const value = await api(`mcp/owner-requests/settings?server=${encodeURIComponent(server.value)}`);
      sampling.checked = value.sampling; elicitation.checked = value.elicitation;
      rpm.value = String(value.requestsPerMinute); cap.value = String(value.tokenCap);
      for (const option of allowed.options) option.selected = value.models.includes(option.value);
    } catch (error) { toast(error.message); }
  };
  const save = document.createElement('button'); save.type = 'submit'; save.textContent = t('window.mcp-asks.save'); form.append(load, save);
  form.onsubmit = async event => {
    event.preventDefault();
    try { await api('mcp/owner-requests/settings', { server: server.value, settings: {
      sampling: sampling.checked, elicitation: elicitation.checked, requestsPerMinute: Number(rpm.value),
      tokenCap: Number(cap.value), models: [...allowed.selectedOptions].map(o => o.value) } }); toast('Saved. Reconnect this server to advertise the enabled features.'); }
    catch (error) { toast(error.message); }
  };
}
function question(request) {
  const form = document.createElement('form'), title = document.createElement('h3'), body = document.createElement('pre');
  form.dataset.request = request.id;
  title.textContent = `${request.server}: ${request.kind === 'sampling' ? 'Permission to ask a model' : 'A question for you'}`;
  const inputs = new Map();
  if (request.kind === 'sampling') body.textContent = `${request.details.notice}\nModel: ${request.details.modelName}\nOutput limit: ${request.details.maxTokens}\n${request.details.messages.map(m => `${m.role}: ${m.content}`).join('\n\n')}`;
  else body.textContent = `${request.details.message}\nYour answers will be sent to ${request.server}.`;
  form.append(title, body);
  if (request.kind === 'elicitation') for (const [name, spec] of Object.entries(request.details.requestedSchema.properties)) {
    const input = field(form, spec.title || name, spec.type === 'boolean' ? 'checkbox' : spec.type === 'number' || spec.type === 'integer' ? 'number' : 'text');
    if (spec.type === 'number') input.step = 'any';
    if (spec.type === 'array') input.placeholder = t('window.mcp-asks.list-hint');
    if (spec.description || spec.enum) { const hint = document.createElement('p'); hint.textContent = spec.description || `${t('window.mcp-asks.choose-one')} ${spec.enum.join(', ')}`; form.append(hint); }
    input.required = spec.type !== 'boolean' && (request.details.requestedSchema.required || []).includes(name);
    inputs.set(name, { input, spec });
  }
  for (const [action, label] of [['accept', 'Allow this request'], ['decline', 'Decline'], ['cancel', 'Cancel']]) {
    const button = document.createElement('button'); button.type = 'button'; button.textContent = label;
    button.onclick = async () => {
      if (action === 'accept' && !form.reportValidity()) return;
      try {
        const content = action !== 'accept' ? {} : Object.fromEntries([...inputs].filter(([, { input, spec }]) => input.value !== '' || spec.type === 'boolean').map(([name, { input, spec }]) => [name,
          spec.type === 'boolean' ? input.checked : spec.type === 'number' || spec.type === 'integer' ? Number(input.value) : spec.type === 'array' ? JSON.parse(input.value) : input.value]));
        await api('mcp/owner-requests/answer', { id: request.id, action, ...(action === 'accept' && request.kind === 'elicitation' ? { content } : {}) }); form.remove();
      } catch (error) { toast(error.message); }
    };
    form.append(button);
  }
  form.onsubmit = event => event.preventDefault(); return form;
}
