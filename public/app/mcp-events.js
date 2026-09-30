import { api } from './core/api.js';
import { toast } from './core/ui.js';

export function initMcpEvents() {
  const button = document.createElement('button');
  button.type = 'button'; button.className = 'btn sm'; button.textContent = 'Event automations';
  button.addEventListener('click', open); document.body.append(button);
}
const node = (tag, text) => { const element = document.createElement(tag); if (text) element.textContent = text; return element; };
const field = (label, input) => { const row = node('label', label); row.append(input); return row; };
async function open() {
  const dialog = node('dialog'), heading = node('h2', 'MCP event automations');
  const notice = node('p', 'Choose a reviewed HTTP server and an existing automation. Signed events can start it while you are away. Tool permissions still apply. Subscriptions expire within one hour; refresh explicitly before expiry.');
  const content = node('section'), close = node('button', 'Close'); close.type = 'button';
  close.addEventListener('click', () => dialog.close());
  dialog.append(heading, notice, content, close); document.body.append(dialog); dialog.showModal();
  dialog.addEventListener('close', () => dialog.remove(), { once: true });
  const reload = async () => {
    try { content.replaceChildren(); draw(content, await api('mcp/events/state'), reload); }
    catch (error) { toast(error.message); dialog.close(); }
  };
  await reload();
}
function operation(parent, label, action) {
  const button = node('button', label); button.type = 'button';
  button.addEventListener('click', async () => {
    button.disabled = true;
    try { await action(); } catch (error) { toast(error.message); }
    finally { button.disabled = false; }
  }); parent.append(button); return button;
}
function draw(parent, state, reload) {
  drawSource(parent, reload);
  const origin = node('input'); origin.type = 'url'; origin.value = state.callbackOrigin; origin.placeholder = 'https://your-relay-or-tunnel.example';
  parent.append(field('Callback origin (owner-configured relay or tunnel)', origin));
  operation(parent, 'Use this callback origin', async () => {
    await api('mcp/events/configure', { origin: origin.value, confirmation: 'Use this HTTPS callback origin' }); await reload();
  });
  parent.append(node('p', 'The relay must forward /webhooks/mcp-events/* with the exact body and signing headers. This form does not create or start a tunnel.'));
  drawSubscription(parent, state, reload);
  for (const saved of state.subscriptions) {
    const card = node('section'); card.append(node('p', `${saved.server}: ${saved.name} — ${saved.phase}; expires ${saved.expires}${saved.truncated ? '; upstream history truncated' : ''}`));
    if (saved.phase === 'active') operation(card, 'Refresh subscription', async () => { await api('mcp/events/refresh', { id: saved.id }); await reload(); });
    operation(card, 'Stop subscription', async () => {
      const result = await api('mcp/events/stop', { id: saved.id });
      if (!result.upstreamStopped) toast(result.message); await reload();
    });
    if (saved.phase === 'stopped') operation(card, 'Forget stopped subscription', async () => {
      await api('mcp/events/forget', { id: saved.id }); await reload();
    }); parent.append(card);
  }
}
function drawSource(parent, reload) {
  const details = node('details'), summary = node('summary', 'Add a modern HTTP MCP source');
  const name = node('input'), url = node('input'), credential = node('input');
  name.maxLength = 60; url.type = 'url'; url.maxLength = 2000; credential.maxLength = 64;
  details.append(summary, field('Source name', name), field('MCP endpoint URL', url),
    field('Credential environment variable name (optional; never enter the secret)', credential));
  operation(details, 'Connect and review this source', async () => {
    const bearerEnv = credential.value.trim();
    const added = await api('mcp/servers', { name: name.value.trim(), server: {
      transport: 'http', url: url.value.trim(), protocol: 'stateless-preview', ...(bearerEnv ? { bearerEnv } : {}),
    } }); toast(added.said); await reload();
  }); parent.append(details);
}
function drawSubscription(parent, state, reload) {
  const server = node('select'), event = node('select'), trigger = node('select'), args = node('textarea'), description = node('pre');
  args.value = '{}'; args.maxLength = 8192;
  for (const item of state.servers) server.append(new Option(item.name, item.id));
  for (const item of state.triggers.filter(item => item.enabled)) trigger.append(new Option(item.name, item.id));
  parent.append(field('Reviewed server', server), field('Event', event), description,
    field('Event filter arguments (JSON)', args), field('Automation to start', trigger));
  let definitions = [];
  operation(parent, 'Load available events', async () => {
    definitions = await api('mcp/events/catalog', { server: server.value }); event.replaceChildren();
    for (const item of definitions) event.append(new Option(item.name, item.name)); show();
  });
  const show = () => { const item = definitions.find(item => item.name === event.value); description.textContent = item
    ? `${item.description ?? item.name}\nFilters:\n${JSON.stringify(item.inputSchema, null, 2)}\nDelivered data:\n${JSON.stringify(item.payloadSchema, null, 2)}` : ''; };
  event.addEventListener('change', show);
  server.addEventListener('change', () => { event.replaceChildren(); definitions = []; show(); });
  const consent = node('input'); consent.type = 'checkbox';
  parent.append(field('Start this automation for these events while I am away', consent));
  operation(parent, 'Subscribe', async () => {
    if (!consent.checked || !event.value || !trigger.value) throw new Error('Choose an event and automation, then confirm it may start.');
    await api('mcp/events/subscribe', { server: server.value, name: event.value, arguments: JSON.parse(args.value),
      definitionFingerprint: definitions.find(item => item.name === event.value).fingerprint,
      triggerFingerprint: state.triggers.find(item => item.id === trigger.value).fingerprint,
      triggerId: trigger.value, confirmation: 'Start this automation for these events' }); await reload();
  });
}
