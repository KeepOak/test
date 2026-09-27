"""Generates public/app/settings/pages/<page>.js from the prototype's rendered Settings pages (design/redesign/dom),
so each page's markup is 1:1 at every level. The data inside is still the prototype's example data: each page is then
bound to the engine by hand (the markers below show where), and example rows are removed where the engine has none."""
import re

PAGES = ['general', 'people', 'appearance', 'notifications', 'instructions', 'models', 'local', 'accounts', 'voice',
         'permissions', 'computer', 'secrets', 'usage', 'gateway', 'self', 'updates', 'achievements', 'advanced', 'developer']
LEVELS = ['regular', 'advanced', 'technical']


def column(page, level):
    try:
        html = open(f'design/redesign/dom/settings-{level}-{page}.html', encoding='utf8').read()
    except FileNotFoundError:
        return ''
    start = html.find('<div class="set-col">')
    if start < 0:
        return ''
    body_start = start + len('<div class="set-col">')
    depth, i = 1, body_start
    while depth and i < len(html):
        nxt_open = html.find('<div', i)
        nxt_close = html.find('</div>', i)
        if nxt_open != -1 and nxt_open < nxt_close:
            depth += 1
            i = nxt_open + 4
        else:
            depth -= 1
            i = nxt_close + 6
    inner = html[body_start:i - 6]
    inner = re.sub(r' data-note="[^"]*"', '', inner)
    inner = inner.replace(' style="', ' data-css="')
    return inner.replace('\\', '\\\\').replace('`', '\\`').replace('${', '\\${')


for page in PAGES:
    parts = {lv: column(page, lv) for lv in LEVELS}
    out = [f"/* Settings › {page}: markup generated 1:1 from the prototype (design/redesign/tools/convert-settings.py).",
           "   Bind real engine data and wire controls in place; never add text that is not here. */",
           'import { level } from "../../core/state.js";', '',
           'const MARKUP = {']
    for lv in LEVELS:
        out.append(f'  {lv}: `{parts[lv]}`,')
    out += ['};', '', 'export function draw() {', '  return MARKUP[["regular", "advanced", "technical"][level()]];', '}', '']
    open(f'public/app/settings/pages/{page}.js', 'w', encoding='utf8').write('\n'.join(out))
print('generated', len(PAGES), 'pages')
