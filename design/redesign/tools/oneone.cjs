// oneone.cjs: for each prototype dump (design/redesign/dom/place-*, settings-*), opens the same view in the live window
// and compares its controls (data-act) and structural labels (headings, setting names, tabs, buttons), numbers stripped.
// LOG=<engine log> PORT=<port> [VIEW=<prefix>] node design/redesign/tools/oneone.cjs [out.json]. Missing labels include the
// prototype's example data (Trunk and people names, example tools, pets), which the window must NOT draw; everything else missing
// is a row or control still to draw 1:1 (greyed if no route).
// compare controls (data-act) and structural labels. LOG=<engine log> PORT=<port> node oneone.cjs [out.json]
const { chromium } = require('C:/Users/bishi/AppData/Local/Programs/Branch Agent/resources/app/node_modules/playwright');
const fs = require('fs'), path = require('path');
const DOM = path.join(__dirname, '..', 'dom');
const tok = (fs.readFileSync(process.env.LOG, 'utf8').match(/browser\): ([a-f0-9]+)/) || [])[1];
const PORT = process.env.PORT || 3299;
const extract = (root) => {
  const norm = (s) => s.replace(/\s+/g, ' ').replace(/\d+([.,:]\d+)*/g, '#').trim().toLowerCase();
  root.querySelectorAll('.lock-banner, .recbar, script, style').forEach((n) => n.remove());
  const acts = [...new Set([...root.querySelectorAll('[data-act]')].map((e) => e.dataset.act).filter((a) => !['toast', 'lock'].includes(a)))];
  const sel = 'h1,h2,h3,.ph,.pt,.ctl > b,.tab,.ptab,.th > b,label > span,button';
  const labels = [...new Set([...root.querySelectorAll(sel)].map((e) => { const c = e.cloneNode(true); c.querySelectorAll('svg,small,kbd').forEach((x) => x.remove()); return norm(c.textContent || ''); }).filter((t) => t.length > 1 && t.length < 70 && t !== '#'))];
  return { acts, labels };
};
(async () => {
  const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1366, height: 900 } });
  const scratch = await b.newPage();
  await p.goto(`http://127.0.0.1:${PORT}/`); await p.waitForTimeout(800);
  await p.getByLabel('Session token').fill(tok); await p.getByRole('button', { name: 'Connect' }).click(); await p.waitForTimeout(1500);
  const files = fs.readdirSync(DOM).filter((f) => /^(place|settings)-/.test(f) && f.startsWith(process.env.VIEW || ''));
  const out = []; let lastLevel = null;
  for (const f of files) {
    const html = fs.readFileSync(path.join(DOM, f), 'utf8');
    await scratch.setContent(`<div id="root">${html.replace(/<script[\s\S]*?<\/script>/g, '')}</div>`);
    const proto = await scratch.evaluate(`(${extract})(document.getElementById('root'))`);
    const m = f.replace('.html', '').split('-');
    if (m[0] === 'place') {
      const [place, tab] = [m[1], m[2]];
      await p.evaluate(([v, t]) => { const x = document.createElement('button'); if (t) { x.dataset.act = 'ptab'; x.dataset.place = v; x.dataset.v = t; } else { x.dataset.act = 'view'; x.dataset.v = v; } document.querySelector('#app').appendChild(x); x.click(); x.remove(); }, [place, tab]);
      if (tab) await p.evaluate(([v, t]) => { const x = document.createElement('button'); x.dataset.act = 'ptab'; x.dataset.place = v; x.dataset.v = t; document.querySelector('#app').appendChild(x); x.click(); x.remove(); }, [place, tab]);
    } else {
      const [level, page] = [m[1], m.slice(2).join('-')];
      if (!(await p.locator('[data-act="setpage"]').count())) { await p.getByRole('button', { name: 'Settings', exact: true }).first().click().catch(() => {}); await p.waitForTimeout(500); }
      if (level !== lastLevel) { await p.locator(`[data-act="setlevel"][data-v="${level}"]`).first().click().catch(() => {}); lastLevel = level; await p.waitForTimeout(300); }
      await p.locator(`[data-act="setpage"][data-v="${page}"]`).first().click().catch(() => {});
    }
    await p.waitForTimeout(1100);
    const live = await p.evaluate(`(() => { const m = document.querySelector('#main'); return m ? (${extract})(m.cloneNode(true)) : {acts:[],labels:[]}; })()`);
    const has = (arr, x) => arr.includes(x);
    const actsHit = proto.acts.filter((a) => has(live.acts, a)), labHit = proto.labels.filter((l) => has(live.labels, l));
    out.push({ view: f.replace('.html', ''), acts: [actsHit.length, proto.acts.length], labels: [labHit.length, proto.labels.length],
      missingActs: proto.acts.filter((a) => !has(live.acts, a)), missingLabels: proto.labels.filter((l) => !has(live.labels, l)), extraActs: live.acts.filter((a) => !has(proto.acts, a)) });
    if (m[0] === 'place' || true) { /* keep going */ }
  }
  if (process.argv[2]) fs.writeFileSync(process.argv[2], JSON.stringify(out, null, 1));
  let A = [0, 0], L = [0, 0];
  for (const r of out) { A[0] += r.acts[0]; A[1] += r.acts[1]; L[0] += r.labels[0]; L[1] += r.labels[1];
    console.log(r.view.padEnd(34), 'controls', `${r.acts[0]}/${r.acts[1]}`.padStart(7), 'labels', `${r.labels[0]}/${r.labels[1]}`.padStart(7)); }
  console.log('TOTAL controls', `${A[0]}/${A[1]} = ${(100 * A[0] / A[1]).toFixed(1)}%`, ' labels', `${L[0]}/${L[1]} = ${(100 * L[0] / L[1]).toFixed(1)}%`);
  await b.close();
})();
