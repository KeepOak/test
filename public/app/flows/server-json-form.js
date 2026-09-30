import { esc, $ } from '../core/dom.js';
import { markLive } from '../core/features.js';

let chosen, fields = [];
const envName = /^[A-Za-z_][A-Za-z0-9_]*$/;
function inputField(input, label, key, forceReference = false) {
  markLive([`sw:${key}`]);
  const reference = input.isSecret || forceReference;
  fields.push({ input, key, reference });
  const fixed = input.value !== undefined && !reference;
  const value = reference ? '' : input.value ?? input.default ?? '';
  const hint = reference ? 'Environment variable name; enter no credential value' : input.placeholder ?? input.description ?? '';
  const control = input.choices?.length && !reference
    ? `<select class="inp" id="${key}">${['', ...input.choices].map(v => `<option value="${esc(v)}" ${v === value ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select>`
    : `<input class="inp" id="${key}" value="${esc(value)}" autocomplete="off" placeholder="${esc(hint)}" ${fixed ? 'readonly' : ''}>`;
  return `<label class="fld"><span>${esc(label)}${input.isRequired ? ' (required)' : ''}${reference ? ' · private environment reference' : ''}</span>${control}</label>`;
}
function declaration(input, label, key, forceReference = false) {
  let html = inputField(forceReference && input.value !== undefined ? { ...input, isRequired: true } : input, label, key, forceReference);
  for (const [name, variable] of Object.entries(input.variables ?? {})) html += inputField(variable, `${label}: ${name}`, `${key}-var-${name}`);
  return html;
}
export function serverJsonForm(entry) {
  const server = entry?.server;
  if (!server) { chosen = null; fields = []; return ''; }
  const options = [...(server.remotes ?? []).map((value, index) => ({ kind: 'remote', value, label: `${value.type}: ${value.url}`, key: `r${index}` })),
    ...(server.packages ?? []).map((value, index) => ({ kind: 'package', value, label: `${value.registryType}: ${value.identifier} @ ${value.version ?? 'version unavailable'}`, key: `p${index}` }))];
  chosen = { server, options, selected: options[0] }; fields = [];
  return `<p class="hint">Publisher metadata. Review the selected transport and inputs; adding saves this connector off.</p><label class="fld"><span>Published transport</span><select class="inp" id="mcp-published-option">${options.map(o => `<option value="${o.key}">${esc(o.label)}</option>`).join('')}</select></label><div id="mcp-declared-inputs">${renderInputs()}</div>`;
}
function renderInputs() {
  fields = [];
  const option = chosen?.selected;
  if (!option) return '<p class="hint">No published connection. Type its address or command manually.</p>';
  const value = option.value;
  if (option.kind === 'remote') markLive(value.headers.map((_, i) => `sw:header-prefix-${i}`));
  if (option.kind === 'remote') return Object.entries(value.variables ?? {}).map(([name, input]) => inputField(input, `Address: ${name}`, `url-${name}`)).join('')
    + value.headers.map((input, i) => declaration(input, `Header ${input.name}`, `header-${i}`, true)
      + `<label class="fld"><span>${esc(input.name)} prefix</span><select class="inp" id="header-prefix-${i}"><option value="">None</option><option value="Bearer ">Bearer</option><option value="Basic ">Basic</option></select></label>`).join('');
  return [...value.runtimeArguments.map((input, i) => declaration(input, input.name ?? input.valueHint ?? 'Runtime argument', `runtime-${i}`)),
    ...value.packageArguments.map((input, i) => declaration(input, input.name ?? input.valueHint ?? 'Package argument', `argument-${i}`)),
    ...value.environmentVariables.map((input, i) => declaration(input, `Environment ${input.name}`, `env-${i}`))].join('');
}
export function changePublishedOption(key) {
  if (!chosen) return;
  chosen.selected = chosen.options.find(option => option.key === key);
  const box = $('#mcp-declared-inputs'); if (box) box.innerHTML = renderInputs();
}
function readInput(input, key) {
  const field = fields.find(item => item.key === key), value = $(`#${key}`)?.value ?? '';
  if ((input.isRequired || field?.input.isRequired) && !value) throw new Error('Fill every required declared input.');
  if (field?.reference) {
    if (value && !envName.test(value)) throw new Error('Private inputs accept an environment variable name, never its value.');
    return { value: '', ref: value, refs: {} };
  }
  if (input.choices?.length && value && !input.choices.includes(value)) throw new Error('Choose a declared input value.');
  if (input.format === 'number' && value && !Number.isFinite(Number(value))) throw new Error('A declared number is invalid.');
  if (input.format === 'boolean' && value && !['true', 'false'].includes(value)) throw new Error('Use true or false for a declared boolean.');
  let resolved = value;
  const refs = {};
  for (const [name, variable] of Object.entries(input.variables ?? {})) {
    const bound = readInput(variable, `${key}-var-${name}`);
    if (bound.ref) refs[name] = bound.ref; else resolved = resolved.replaceAll(`{${name}}`, bound.value);
  }
  if ([...resolved.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].some(match => !refs[match[1]])) throw new Error('Resolve every declared variable before adding.');
  return { value: resolved, ref: '', refs };
}
function argumentsFor(inputs, prefix, args, argEnv) {
  for (const [index, input] of inputs.entries()) {
    const bound = readInput(input, `${prefix}-${index}`);
    if (!bound.value && !bound.ref) continue;
    if (input.type === 'named') { if (!input.name) throw new Error('A named argument has no name.'); args.push(input.name); }
    if (bound.ref || Object.keys(bound.refs).length) argEnv[String(args.length)] = bound.ref || { template: bound.value, refs: bound.refs };
    args.push(bound.ref || Object.keys(bound.refs).length ? '' : bound.value);
  }
}
export function publishedServer() {
  const option = chosen?.selected;
  if (!option) return null;
  const value = option.value;
  if (option.kind === 'remote') {
    if (value.type !== 'streamable-http') throw new Error('This published transport needs manual configuration; SSE import is unavailable.');
    let url = value.url;
    for (const [name, input] of Object.entries(value.variables ?? {})) {
      const bound = readInput(input, `url-${name}`);
      if (bound.ref || Object.keys(bound.refs).length) throw new Error('Private values cannot be embedded in an endpoint address.');
      url = url.replaceAll(`{${name}}`, encodeURIComponent(bound.value));
    }
    const headerEnv = {};
    value.headers.forEach((input, i) => {
      const bound = readInput(input, `header-${i}`);
      if (bound.ref) headerEnv[input.name] = { env: bound.ref, prefix: $(`#header-prefix-${i}`)?.value ?? '' };
    });
    return { transport: 'http', url, headerEnv };
  }
  if (value.transport.type !== 'stdio' || !['npm', 'pypi'].includes(value.registryType) || !value.version || value.fileSha256 || value.registryBaseUrl)
    throw new Error('This package needs manual configuration; import supports versioned standard npm/PyPI stdio packages.');
  const identifierPattern = value.registryType === 'npm' ? /^(?:@[A-Za-z0-9_.-]+\/)?[A-Za-z0-9][A-Za-z0-9_.-]*$/ : /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
  if (!identifierPattern.test(value.identifier) || !/^[A-Za-z0-9][A-Za-z0-9.+_-]*$/.test(value.version)) throw new Error('Unsupported package identifier or version.');
  const args = [], argEnv = {}, envValues = {}, envRefs = {};
  argumentsFor(value.runtimeArguments, 'runtime', args, argEnv);
  args.push(value.registryType === 'npm' ? `${value.identifier}@${value.version}` : `${value.identifier}==${value.version}`);
  argumentsFor(value.packageArguments, 'argument', args, argEnv);
  value.environmentVariables.forEach((input, i) => {
    if (!envName.test(input.name)) throw new Error('A declared environment name is invalid.');
    const bound = readInput(input, `env-${i}`);
    if (bound.ref || Object.keys(bound.refs).length) envRefs[input.name] = bound.ref || { template: bound.value, refs: bound.refs }; else if (bound.value) envValues[input.name] = bound.value;
  });
  return { transport: 'stdio', command: value.registryType === 'npm' ? 'npx' : 'uvx', args, envKeys: [], envValues, envRefs, argEnv };
}
