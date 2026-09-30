import { api } from './core/api.js';
import { toast } from './core/ui.js';

const deniedPermissions = "camera 'none'; microphone 'none'; geolocation 'none'; clipboard-write 'none'; fullscreen 'none'; payment 'none'";
export function initScriptedMcpApps() {
  const button = document.createElement('button'); button.type = 'button'; button.className = 'btn sm'; button.textContent = 'Server pages';
  button.onclick = () => void listPages(); document.body.append(button);
}
async function listPages() {
  try {
    const { apps } = await api('mcp/apps');
    const dialog = document.createElement('dialog'), title = document.createElement('h2'); title.textContent = 'Server pages'; dialog.append(title);
    const settings = document.createElement('form'), server = document.createElement('input');
    server.placeholder = 'Server ID'; server.required = true; server.pattern = '[a-z][a-z0-9-]{0,29}';
    const enabled = document.createElement('input'); enabled.type = 'checkbox';
    const label = document.createElement('label'); label.textContent = 'Enable interactive pages for this server'; label.append(enabled);
    const save = document.createElement('button'); save.textContent = 'Save'; settings.append(server, label, save);
    settings.onsubmit = async event => {
      event.preventDefault();
      if (!confirm(`Save interactive-page support for ${server.value}? Each scripted page and tool request still requires your separate approval.`)) return;
      try { await api('mcp/scripted-app/enable', { server: server.value, enabled: enabled.checked, confirmed: true }); toast('Saved. Reconnect the server to negotiate its app resources.'); }
      catch (error) { toast(error.message); }
    }; dialog.append(settings);
    for (const app of apps) {
      const row = document.createElement('section'), name = document.createElement('p'); name.textContent = `${app.server}: ${app.uri}`;
      const preview = document.createElement('button'); preview.textContent = 'Read page';
      preview.onclick = async () => {
        try {
          const page = await api('mcp/app', { server: app.server, uri: app.uri, html: app.html });
          const frame = document.createElement('iframe'); frame.setAttribute('sandbox', ''); frame.referrerPolicy = 'no-referrer'; frame.title = name.textContent; frame.src = page.url; row.append(frame);
        } catch (error) { toast(error.message); }
      };
      row.append(name, preview);
      if (app.uri.startsWith('ui://') && app.tool) {
        const interactive = document.createElement('button'); interactive.textContent = 'Open interactive page';
        interactive.onclick = () => {
          if (confirm(`Run this page's scripts in an isolated frame? ${app.server} cannot access Branch or the network. Each tool request will ask you separately.`)) void openInteractive(app);
        }; row.append(interactive);
      }
      dialog.append(row);
    }
    if (!apps.length) { const empty = document.createElement('p'); empty.textContent = 'No server pages have been received yet.'; dialog.append(empty); }
    const close = document.createElement('button'); close.textContent = 'Close'; close.onclick = () => dialog.close(); dialog.append(close);
    dialog.addEventListener('close', () => dialog.remove(), { once: true }); document.body.append(dialog); dialog.showModal();
  } catch (error) { toast(error.message); }
}
async function openInteractive(app) {
  try {
    const held = await api('mcp/scripted-app/open', { runId: app.runId, uri: app.uri, tool: app.tool, confirmed: true });
    const dialog = document.createElement('dialog'), frame = document.createElement('iframe'), close = document.createElement('button');
    const nonce = held.nonce; frame.title = `${app.server}: interactive page`;
    // The response's CSP sandbox forces a distinct opaque origin independent of this attribute.
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin'); frame.setAttribute('allow', deniedPermissions);
    frame.referrerPolicy = 'no-referrer'; frame.width = '700'; frame.height = '550';
    frame.src = held.proxyUrl;
    const send = rpc => frame.contentWindow?.postMessage({ nonce, rpc }, '*');
    const bridge = createBridge(frame, nonce, held, send);
    window.addEventListener('message', bridge);
    close.textContent = 'Close'; close.onclick = () => dialog.close(); dialog.append(frame, close);
    dialog.addEventListener('close', () => {
      window.removeEventListener('message', bridge); dialog.remove(); void api('mcp/scripted-app/close', { capability: held.capability }).catch(() => {});
    }, { once: true });
    document.body.append(dialog); dialog.showModal();
  } catch (error) { toast(error.message); }
}
function createBridge(frame, nonce, held, send) {
  let initialized = false, handshake = false, busy = false;
  let messages = [];
  return async event => {
    if (event.source !== frame.contentWindow || event.data?.nonce !== nonce) return;
    const rpc = event.data.rpc;
    try { if (!rpc || rpc.jsonrpc !== '2.0' || JSON.stringify(rpc).length > 32768) return; } catch { return; }
    if (rpc.id !== undefined && typeof rpc.id !== 'string' && typeof rpc.id !== 'number') return;
    messages = messages.filter(time => time > Date.now() - 60000);
    if (messages.length >= 60) return;
    messages.push(Date.now());
    const reply = result => send({ jsonrpc: '2.0', id: rpc.id, result });
    const refuse = message => send({ jsonrpc: '2.0', id: rpc.id, error: { code: -32603, message } });
    if (rpc.method === 'ui/notifications/sandbox-proxy-ready') { send({ jsonrpc: '2.0', method: 'ui/notifications/sandbox-resource-ready', params: { html: held.html } }); return; }
    if (rpc.method === 'ui/initialize') {
      if (rpc.params?.protocolVersion !== '2026-01-26' || !rpc.params?.appCapabilities) { refuse('Unsupported app initialization.'); return; }
      handshake = true; reply({ protocolVersion: '2026-01-26', hostInfo: { name: 'branch', version: '1.0.0' }, hostCapabilities: { serverTools: {} },
        hostContext: { displayMode: 'inline', theme: document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light', containerDimensions: { width: 700, maxHeight: 550 } } }); return;
    }
    if (rpc.method === 'ui/notifications/initialized') {
      if (initialized || !handshake) return; initialized = true;
      send({ jsonrpc: '2.0', method: 'ui/notifications/tool-input', params: { arguments: held.input } });
      send({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: held.result }); return;
    }
    if (rpc.method === 'ping') { reply({}); return; }
    if (rpc.id === undefined) return;
    if (!initialized || rpc.method !== 'tools/call' || busy) { refuse('This app request is not available.'); return; }
    busy = true;
    try {
      const proposed = await api('mcp/scripted-app/propose', { capability: held.capability, name: rpc.params?.name, arguments: rpc.params?.arguments ?? {} });
      if (!frame.isConnected) return;
      if (!confirm(`Allow ${proposed.name} with these exact inputs?\n${JSON.stringify(proposed.arguments, null, 2)}`)) {
        await api('mcp/scripted-app/decline', { capability: held.capability, ticket: proposed.ticket });
        refuse('The owner declined this tool request.'); return;
      }
      const result = await api('mcp/scripted-app/call', { capability: held.capability, ticket: proposed.ticket, confirmed: true }); reply(result);
    } catch { refuse('The app tool request was refused or failed.'); }
    finally { busy = false; }
  };
}
