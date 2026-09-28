// Experiment only: A/B on one idle runner.
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
const cache = mkdtempSync(join(tmpdir(), "ncc-"));
const one = (env) => {
  const t = performance.now();
  const r = spawnSync(process.execPath, ["--import", "data:text/javascript,process.on('exit',()=>{const c=process.cpuUsage();process.stderr.write('CPU '+((c.user+c.system)/1000).toFixed(0)+'\n')})", "dist/cli.js", "status", "--help"], { env: { ...process.env, ...env }, encoding: "utf8" });
  return { wall: Math.round(performance.now() - t), cpu: +(/CPU (\d+)/.exec(r.stderr)?.[1] ?? NaN) };
};
one({ NODE_COMPILE_CACHE: cache }); // warm the cache once
const plain = [], cached = [];
for (let i = 0; i < 15; i++) { plain.push(one({})); cached.push(one({ NODE_COMPILE_CACHE: cache })); }
const med = (a, k) => [...a.map((x) => x[k])].sort((x, y) => x - y)[a.length >> 1];
console.log(`CLI --help median wall: plain ${med(plain, "wall")} ms, cached ${med(cached, "wall")} ms`);
console.log(`CLI --help median CPU:  plain ${med(plain, "cpu")} ms, cached ${med(cached, "cpu")} ms`);
const launch = [], context = [];
for (let i = 0; i < 8; i++) { const t = performance.now(); const b = await chromium.launch({ headless: true }); const p = await (await b.newContext()).newPage(); await p.setContent("<p>x</p>"); await b.close(); launch.push(performance.now() - t); }
const b = await chromium.launch({ headless: true });
for (let i = 0; i < 8; i++) { const t = performance.now(); const c = await b.newContext(); const p = await c.newPage(); await p.setContent("<p>x</p>"); await c.close(); context.push(performance.now() - t); }
await b.close();
const m = (a) => Math.round([...a].sort((x, y) => x - y)[a.length >> 1]);
console.log(`Chromium: launch+context+page+close median ${m(launch)} ms; context+page+close on a shared browser median ${m(context)} ms`);
