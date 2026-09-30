/** Fixed read-only app observations executed only inside the Test copy container. */
export const dogfoodProbe = `const {spawn}=require('node:child_process');
const child=spawn(process.execPath,['dist/cli.js','start'],{cwd:'/work/source',env:{PATH:process.env.PATH,HOME:'/tmp',TMPDIR:'/tmp',BRANCH_DATA_DIR:'/work/data/dogfood-'+Date.now(),BRANCH_WORKSPACE:'/work/workspace/dogfood-'+Date.now(),BRANCH_PORT:'38127',BRANCH_GATEWAY:'off'},stdio:['ignore','pipe','pipe']});
let log='',token='',ended=false;child.once('exit',()=>{ended=true});
child.stdout.on('data',d=>{log=(log+d.toString()).slice(-32768);token=/Local session token \\(paste into browser\\): ([A-Za-z0-9_-]+)/.exec(log)?.[1]||token;});child.stderr.on('data',()=>{});
(async()=>{let browser;try{
for(let i=0;i<60&&!token;i++){if(ended)throw Error('Isolated engine exited');await new Promise(r=>setTimeout(r,500));}
if(!token)throw Error('Isolated engine did not provide a session');
let chromium;try{chromium=require('playwright').chromium;}catch{console.error('Held: prepare Playwright in this isolated copy. Nothing was installed.');process.exitCode=75;return;}
try{browser=await chromium.launch({headless:true,args:['--no-sandbox']});}catch{console.error('Held: this image needs prepared Chromium. Nothing was downloaded.');process.exitCode=75;return;}
const page=await browser.newPage({serviceWorkers:'block'}),errors=[];
await page.addInitScript(value=>sessionStorage.setItem('branch-token',value),token);
await page.routeWebSocket('**/*',socket=>socket.close());
const reads=new Set(['state','profiles','projects','sessions','trunks','deployment','never-break','comfort','self-rules','settings-kit','settings-kit/history','policy','usage','usage/glance','usage/limits/settings','usage/by-trunk','evaluation/suites','evaluation/history','retention','history/snapshots','reply-flags','continuous-qa','self-development/merge']);
await page.route('**/*',route=>{const r=route.request(),u=new URL(r.url()),allowed=!u.pathname.startsWith('/api/')||reads.has(u.pathname.slice(5));return allowed&&u.origin==='http://127.0.0.1:38127'&&['GET','HEAD'].includes(r.method())&&!u.searchParams.has('fix')?route.continue():route.abort();});
page.on('pageerror',e=>{if(errors.length<20)errors.push(e.message.slice(0,200));});
for(const home of ['settings:general','settings:self','settings:usage']){
await page.goto('http://127.0.0.1:38127/#open='+encodeURIComponent(home));await page.locator('#app #side').waitFor({timeout:20000});
await page.locator('[data-act="setpage"][data-v="'+home.split(':')[1]+'"][aria-current="true"]').waitFor({timeout:20000});
await page.locator('.set-col').waitFor({state:'attached',timeout:20000});if((await page.locator('.set-col').innerText()).trim().length<20)throw Error(home+' has no readable settings');
console.log('Observed '+home+' without clicks or writes.');}
if(errors.length)throw Error('UI errors: '+errors.join('; '));console.log('Read-only UI observations passed; native desktop/providers/installed updates untested.');
}catch(e){console.error(String(e.message).slice(0,2000));process.exitCode=1;}finally{await browser?.close();child.kill('SIGTERM');setTimeout(()=>child.kill('SIGKILL'),2000).unref();}})();`;
