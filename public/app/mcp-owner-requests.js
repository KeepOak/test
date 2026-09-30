import { api } from './core/api.js';
import { toast } from './core/ui.js';

/** A visible, local owner form is the heartbeat; closing it immediately stops renewing capability. */
export function initMcpOwnerRequests() {
  const button = document.createElement('button');
  button.type = 'button'; button.className = 'btn sm'; button.textContent = 'Server questions';
  button.addEventListener('click', open);
  document.body.append(button);
}
async function open() {
  const panel = document.createElement('dialog');
  const heading = document.createElement('h2'); heading.textContent = 'Server questions';
  const notice = document.createElement('p');
  notice.textContent = 'Each server feature starts off. Keep this window open to receive questions. After enabling a feature, reconnect that server to advertise it.';
  const settings = document.createElement('form'), requests = document.createElement('section');
  const close = document.createElement('button'); close.type = 'button'; close.textContent = 'Close';
  close.addEventListener('click', () => panel.close());
  panel.append(heading, notice, settings, requests, close); document.body.append(panel); panel.showModal();
  let seen = '', busy = false, browserWaiting = false;
  const poll = async () => {
    if (!panel.open || busy || (document.visibilityState !== 'visible' && !browserWaiting)) return;
    busy = true;
    try {
      const state = await api('mcp/owner-requests/window', { nativeUrlOpener: typeof window.branchDesktop?.openMcpElicitation === 'function' });
      if (!settings.childNodes.length) drawSettings(settings, state.models);
      const urls = state.urls || [];
      browserWaiting = urls.length > 0;
      const ids = state.requests.map(r => r.id).concat(urls.map(r => `${r.id}:${r.stage}`)).join(',');
      if (ids !== seen) {
        seen = ids;
        const wanted = new Set([...state.requests, ...urls].map(r => r.id));
        for (const card of requests.children) if (!wanted.has(card.dataset.request)) card.remove();
        for (const request of state.requests) if (![...requests.children].some(card => card.dataset.request === request.id)) requests.append(question(request));
        for (const request of urls) {
          const old = [...requests.children].find(card => card.dataset.request === request.id);
          if (old?.dataset.stage === request.stage) continue;
          if (old) old.replaceWith(browserQuestion(request)); else requests.append(browserQuestion(request));
        }
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
  const roots = field(form, 'Allow requests to see a task workspace root', 'checkbox');
  const urlElicitation = field(form, 'Allow browser questions in the desktop app', 'checkbox');
  const origins = field(form, 'Approved HTTPS origins, separated by commas');
  origins.placeholder = 'https://accounts.example.com';
  const rpm = field(form, 'Requests per minute', 'number'); rpm.value = '3'; rpm.min = '1'; rpm.max = '20';
  const cap = field(form, 'Maximum output tokens per request', 'number'); cap.value = '2048'; cap.min = '128'; cap.max = '8192';
  const allowed = document.createElement('select'); allowed.multiple = true;
  allowed.setAttribute('aria-label', 'Allowed models');
  for (const model of models) { const option = new Option(model.name, model.id); allowed.add(option); }
  form.append(allowed);
  const load = document.createElement('button'); load.type = 'button'; load.textContent = 'Read saved choices';
  load.onclick = async () => {
    try {
      const value = await api(`mcp/owner-requests/settings?server=${encodeURIComponent(server.value)}`);
      sampling.checked = value.sampling; elicitation.checked = value.elicitation;
      roots.checked = value.roots === true;
      urlElicitation.checked = value.urlElicitation === true; origins.value = (value.urlOrigins || []).join(', ');
      rpm.value = String(value.requestsPerMinute); cap.value = String(value.tokenCap);
      for (const option of allowed.options) option.selected = value.models.includes(option.value);
    } catch (error) { toast(error.message); }
  };
  const save = document.createElement('button'); save.type = 'submit'; save.textContent = 'Save choices'; form.append(load, save);
  form.onsubmit = async event => {
    event.preventDefault();
    try { await api('mcp/owner-requests/settings', { server: server.value, settings: {
      sampling: sampling.checked, elicitation: elicitation.checked, requestsPerMinute: Number(rpm.value),
      roots: roots.checked,
      urlElicitation: urlElicitation.checked, urlOrigins: origins.value.split(',').map(s => s.trim()).filter(Boolean),
      tokenCap: Number(cap.value), models: [...allowed.selectedOptions].map(o => o.value) } }); toast('Saved. Reconnect this server to advertise the enabled features.'); }
    catch (error) { toast(error.message); }
  };
}
function browserQuestion(request) {
  const card = document.createElement('section'), title = document.createElement('h3'), message = document.createElement('p');
  card.dataset.request = request.id; card.dataset.stage = request.stage;
  title.textContent = `${request.server}: A browser step for you`;
  message.textContent = `${request.message}\nApproved origin: ${request.origin}\n${request.stage === 'approval'
    ? request.flow?.mode === 'modern' ? 'Opening uses your external browser. Return here to approve continuing the original request; login details stay outside the conversation.'
      : 'Opening this page uses your external browser. Login details stay outside the conversation.'
    : request.stage === 'completed' ? 'Review the current request before proceeding; normal tool approval still applies.'
      : 'Waiting for this server to confirm completion. You can stop waiting at any time.'}`;
  card.append(title, message);
  if (request.flow?.tool) {
    const original = document.createElement('pre');
    original.textContent = `Original task: ${request.flow.runId}\nTool: ${request.flow.tool}${request.flow.args ? `\n${JSON.stringify(request.flow.args, null, 2)}` : ''}`;
    card.append(original);
  }
  if (request.stage === 'completed') return card;
  if (request.stage === 'resume' || request.stage === 'completion' && request.flow?.mode === 'error') {
    message.textContent = `${request.message}\nOrigin: ${request.origin}\nBrowser consent does not prove login success. Continue only after finishing the browser step; the server will check its own authorization.${request.flow.mode === 'modern' ? '\nContinuing sends this original tool again and may repeat effects; the server controls request-state idempotency.' : ''}`;
    const resume = document.createElement('button'); resume.type = 'button';
    resume.textContent = request.flow.mode === 'error' ? 'I finished; review the original retry' : 'Continue this exact request';
    resume.onclick = async () => {
      resume.disabled = true;
      try { await api('mcp/owner-requests/url-resume', { id: request.id }); card.remove(); }
      catch (error) { toast(error.message); }
    };
    card.append(resume);
  }
  if (request.stage === 'approval') {
    const open = document.createElement('button'); open.type = 'button'; open.textContent = `Open ${request.origin}`;
    open.onclick = async () => {
      open.disabled = true;
      try {
        if (!window.branchDesktop?.openMcpElicitation) throw new Error('Use the local desktop app to open this page.');
        const { ticket } = await api('mcp/owner-requests/url-prepare', { id: request.id });
        await window.branchDesktop.openMcpElicitation(ticket);
        message.textContent = request.flow?.mode === 'modern' ? 'Finish the browser step, then return here to review continuing.'
          : `Waiting for ${request.server} to confirm completion at ${request.origin}.`;
      } catch (error) { toast(error.message); }
    };
    card.append(open);
  }
  for (const action of ['decline', 'cancel']) {
    const button = document.createElement('button'); button.type = 'button'; button.textContent = action === 'decline' ? 'Decline' : 'Cancel';
    button.onclick = async () => {
      try { await api('mcp/owner-requests/url-cancel', { id: request.id, action }); card.remove(); }
      catch (error) { toast(error.message); }
    };
    card.append(button);
  }
  return card;
}
function question(request) {
  const form = document.createElement('form'), title = document.createElement('h3'), body = document.createElement('pre');
  form.dataset.request = request.id;
  title.textContent = `${request.server}: ${request.kind === 'sampling' ? 'Permission to ask a model'
    : request.kind === 'urlRetry' ? 'Review an original tool retry' : 'A question for you'}`;
  const inputs = new Map();
  if (request.kind === 'sampling') body.textContent = `${request.details.notice}\nModel: ${request.details.modelName}\nOutput limit: ${request.details.maxTokens}\n${request.details.messages.map(m => `${m.role}: ${m.content}`).join('\n\n')}`;
  else if (request.kind === 'roots') body.textContent = `${request.details.message}\n${request.details.uri}\nTask: ${request.details.runId}`;
  else body.textContent = `${request.details.message}\n${request.kind === 'urlRetry'
    ? `Tool: ${request.details.tool}\nTask: ${request.details.runId}\nExact arguments:\n${JSON.stringify(request.details.args, null, 2)}`
    : `Your answers will be sent to ${request.server}.`}`;
  form.append(title, body);
  if (request.kind === 'elicitation') for (const [name, spec] of Object.entries(request.details.requestedSchema.properties)) {
    const input = field(form, spec.title || name, spec.type === 'boolean' ? 'checkbox' : spec.type === 'number' || spec.type === 'integer' ? 'number' : 'text');
    if (spec.type === 'number') input.step = 'any';
    if (spec.type === 'array') input.placeholder = 'List the chosen values as a JSON array';
    if (spec.description || spec.enum) { const hint = document.createElement('p'); hint.textContent = spec.description || `Choose one: ${spec.enum.join(', ')}`; form.append(hint); }
    input.required = spec.type !== 'boolean' && (request.details.requestedSchema.required || []).includes(name);
    inputs.set(name, { input, spec });
  }
  for (const [action, label] of [['accept', request.kind === 'urlRetry' ? 'Retry this exact tool once' : 'Allow this request'], ['decline', 'Decline'], ['cancel', 'Cancel']]) {
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
