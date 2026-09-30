import { api } from './core/api.js';
import { on } from './core/actions.js';
import { markLive } from './core/features.js';
import { toast } from './core/ui.js';
import { addFiles } from './chat/attach.js';
const node = (tag, text) => { const element = document.createElement(tag); if (text) element.textContent = text; return element; };
const field = (title, control) => { const label = node('label', title); label.append(control); return label; };
function button(parent, title, action) {
  const control = node('button', title); control.type = 'button';
  control.addEventListener('click', async () => {
    control.disabled = true;
    try { await action(); } catch (error) { toast(error.message); } finally { control.disabled = false; }
  }); parent.append(control); return control;
}
function dialog(title) {
  const modal = node('dialog'); modal.append(node('h2', title)); document.body.append(modal);
  button(modal, 'Close', () => modal.close()); modal.addEventListener('close', () => modal.remove(), { once: true }); modal.showModal(); return modal;
}
export function initMcpNative() {
  markLive(['mcp-native-settings', 'mcp-mention-open']);
  on('mcp-native-settings', () => openSettings()); on('mcp-mention-open', () => openMentions());
}
export const mcpMentionRows = () => '<div class="ph">MCP resources</div><button class="mi" type="button" data-act="mcp-mention-open">Search a reviewed MCP server…</button>';
async function sources(modal, mentions = false) {
  const state = await api('mcp/native/list'), select = node('select');
  for (const source of state.servers.filter(item => mentions ? item.mentions : item.settings || item.mentions)) select.append(new Option(source.server, source.server));
  if (!select.options.length) modal.append(node('p', 'No live reviewed server advertises this extension. On-demand servers appear after a task connects them.'));
  modal.append(field('Server', select)); return { select, state };
}
async function openSettings() {
  const modal = dialog('MCP server settings');
  modal.append(node('p', 'Server labels are untrusted. Read and save use reviewed same-server tools and your current permissions.'));
  try {
    const { select, state } = await sources(modal), content = node('section'), consent = node('input'); consent.type = 'checkbox';
    const show = () => { consent.checked = state.servers.find(item => item.server === select.value)?.mentionsEnabled === true; content.replaceChildren(); };
    show(); select.addEventListener('change', show); modal.append(field('Allow composer search queries to be sent to this server', consent));
    button(modal, 'Save composer search preference', async () => { await api('mcp/native/configure', { server: select.value, enabled: consent.checked, confirmed: true }); toast('Search preference saved.'); });
    button(modal, 'Read server settings', async () => drawSettings(content, await api('mcp/native/read', { server: select.value, confirmed: true }))); modal.append(content);
  } catch (error) { toast(error.message); modal.close(); }
}
function control(property, value) {
  const input = node(property.enum ? 'select' : 'input');
  if (property.enum) { for (const item of property.enum) input.append(new Option(item, item)); input.value = value; }
  else if (property.type === 'boolean') { input.type = 'checkbox'; input.checked = value; }
  else {
    input.type = property.type === 'string' ? 'text' : 'number'; input.value = String(value);
    if (property.type === 'string') { input.maxLength = Math.min(property.maxLength ?? 16000, 16000); if (property.minLength !== undefined) input.minLength = property.minLength; }
    else { input.step = String(property.multipleOf ?? (property.type === 'integer' ? 1 : 'any')); if (property.minimum !== undefined) input.min = property.minimum; if (property.maximum !== undefined) input.max = property.maximum; }
  }
  return input;
}
function drawSettings(parent, settings) {
  parent.replaceChildren(); const controls = new Map(), seen = new Set();
  const add = (target, key) => {
    const property = settings.schema.properties[key], input = control(property, settings.values[key]); controls.set(key, input); seen.add(key);
    target.append(field(property.title, input)); if (property.description) target.append(node('p', property.description));
  };
  for (const group of settings.layout ?? []) {
    const section = node('section'); section.append(node('h3', group.title));
    for (const item of group.items) if (item.kind === 'property') add(section, item.property);
    else button(section, item.title, async () => {
      if (!window.confirm(`Run same-server tool ${item.tool}?\n${item.description ?? ''}`)) return;
      const result = await api('mcp/native/action', { ticket: settings.ticket, tool: item.tool, confirmed: true });
      parent.replaceChildren(node('p', 'Action finished. Read settings again for current values.'), node('pre', JSON.stringify(result, null, 2).slice(0, 60000)));
    }); parent.append(section);
  }
  const omitted = Object.keys(settings.schema.properties).filter(key => !seen.has(key));
  if (omitted.length) { const section = node('section'); section.append(node('h3', 'Other settings')); for (const key of omitted) add(section, key); parent.append(section); }
  button(parent, 'Save changed settings', async () => {
    const set = {};
    for (const [key, input] of controls) {
      if (!input.checkValidity()) throw new Error(`Check ${settings.schema.properties[key].title}.`);
      const type = settings.schema.properties[key].type, value = type === 'boolean' ? input.checked : type === 'string' ? input.value : Number(input.value);
      if ((type === 'number' || type === 'integer') && !input.value.trim()) throw new Error('A numeric setting cannot be empty.');
      if (value !== settings.values[key]) set[key] = value;
    }
    if (!Object.keys(set).length || !window.confirm('Save these changed values to this MCP server?')) return;
    drawSettings(parent, await api('mcp/native/update', { ticket: settings.ticket, set, confirmed: true }));
  });
}
async function openMentions() {
  const composer = document.querySelector('#prompt'), token = /(?:^|\s)@(\w*)$/.exec(composer?.value ?? '');
  const modal = dialog('Mention an MCP resource'), query = node('input'), results = node('section'); query.maxLength = 200; query.value = token?.[1] ?? '';
  modal.append(node('p', 'Search sends your query after enabling this server in MCP settings. Selecting an item reads text on the same connection and attaches it to the next message as untrusted source content.'));
  try {
    const { select } = await sources(modal, true); modal.append(field('Search query', query));
    button(modal, 'Search', async () => {
      results.replaceChildren(); const server = select.value, response = await api('mcp/native/search', { server, query: query.value });
      if (select.value !== server || !modal.isConnected) return;
      for (const item of response.items) button(results, `${item.title}${item.subtitle ? ` — ${item.subtitle}` : ''}`, async () => {
        if (!window.confirm(`Read and attach ${item.title} from ${server}?`)) return;
        const file = await api('mcp/native/pick', { ticket: item.ticket, confirmed: true });
        addFiles([new File([file.text], file.name, { type: 'text/plain' })]);
        if (composer?.isConnected && token && composer.value.endsWith(token[0])) { composer.value = composer.value.replace(/@\w*$/, ''); composer.dispatchEvent(new Event('input', { bubbles: true })); }
        modal.close();
      }); if (!response.items.length) results.append(node('p', 'No matching resources.'));
    }); select.addEventListener('change', () => results.replaceChildren()); modal.append(results);
  } catch (error) { toast(error.message); modal.close(); }
}
