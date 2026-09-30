/** Runs only inside the dedicated Windows Sandbox or deny-default macOS sandbox. */
export const nativeQaWorker = String.raw`
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const input=JSON.parse(require('node:fs').readFileSync(process.argv[2],'utf8'));
let app,pid,sandboxAuthorized=false;const deadline=setTimeout(()=>{Promise.resolve(app?.close()).finally(()=>process.exit(1));},150000);const identity={worker:input.worker,workerPid:process.pid,platform:process.platform,ownerInstallUsed:false,observed:false};
const inside=(root,file)=>{const r=path.relative(root,file);return r&&!r.startsWith('..')&&!path.isAbsolute(r);};
async function hash(file){return crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');}
(async()=>{try{
if(!['win32','darwin'].includes(process.platform)||process.platform!==input.platform)throw Error('Native worker platform mismatch');
if(process.platform==='win32'&&(os.userInfo().username!=='WDAGUtilityAccount'||input.root!=='C:\\qa-source'||input.home!=='C:\\qa-work'))throw Error('Windows QA requires the dedicated Sandbox account and mapped roots');
if(process.platform==='win32'){sandboxAuthorized=true;require('node:child_process').spawn('C:\\Windows\\System32\\shutdown.exe',['/s','/t','180'],{stdio:'ignore'});}
for(const p of [input.root,input.home,input.executable])if(await fs.realpath(p)!==p)throw Error('Native QA path replaced by a link');
if(!inside(input.root,input.executable)||!input.worker||input.journeys.length<1||input.journeys.length>3)throw Error('Invalid worker scope');
const pw=require(path.join(input.root,'node_modules','playwright'));
const env={PATH:process.env.PATH,HOME:input.home,USERPROFILE:input.home,APPDATA:path.join(input.home,'roaming'),LOCALAPPDATA:path.join(input.home,'local'),TMPDIR:input.home,TEMP:input.home,TMP:input.home,XDG_CONFIG_HOME:input.home,BRANCH_DESKTOP_HOME:path.join(input.home,'desktop'),BRANCH_DATA_DIR:path.join(input.home,'data'),BRANCH_WORKSPACE:path.join(input.home,'workspace'),BRANCH_GATEWAY:'off',BRANCH_QA_WORKER:input.worker};
app=await pw._electron.launch({executablePath:input.executable,env,timeout:30000});pid=app.process().pid;identity.appPid=pid;
if(!pid||pid===process.pid)throw Error('Missing distinct worker child PID');
const reported=await app.evaluate(({app})=>({packaged:app.isPackaged,executable:process.execPath,home:app.getPath('userData'),worker:process.env.BRANCH_QA_WORKER,version:app.getVersion(),build:require(require('node:path').join(app.getAppPath(),'dist/build-info.json'))}));
if(!reported.packaged||reported.executable!==input.executable||reported.home!==env.BRANCH_DESKTOP_HOME||reported.worker!==input.worker||reported.build.commit!==input.sha)throw Error('Packaged child identity or dedicated data home mismatch');
identity.package=reported;identity.executableSha256=await hash(input.executable);
const page=await app.firstWindow({timeout:30000});await page.waitForURL(/^http:\/\/(localhost|127\.0\.0\.1):[0-9]+\//,{timeout:30000});const origin=new URL(page.url()).origin;
const reads=new Set(['state','profiles','projects','sessions','trunks','deployment','never-break','comfort','self-rules','settings-kit','settings-kit/history','policy','usage','usage/glance','usage/limits/settings','usage/by-trunk','evaluation/suites','evaluation/history','retention','history/snapshots','reply-flags','continuous-qa','self-development/merge','appearance']);
await page.routeWebSocket('**/*',s=>s.close());await page.route('**/*',r=>{const q=r.request(),u=new URL(q.url());return u.origin===origin&&['GET','HEAD'].includes(q.method())&&!u.searchParams.has('fix')&&(!u.pathname.startsWith('/api/')||reads.has(u.pathname.slice(5)))?r.continue():r.abort();});
page.setDefaultTimeout(10000);const errors=[];page.on('pageerror',e=>{if(errors.length<10)errors.push(e.message.slice(0,200));});
await page.locator('#side [data-act="view"][data-v="settings"]').first().click();let count=0;
const plans={'settings-reading':['general','appearance','general'],'usage-reading':['usage','general'],'self-reading':['self','general']};
for(const journey of input.journeys){if(!plans[journey])throw Error('Journey is outside the owner-approved catalog');for(const section of plans[journey]){
if(app.process().pid!==pid||app.process().exitCode!==null)throw Error('Child process fence lost');
await page.locator('.set-nav [data-act="setpage"][data-v="'+section+'"]').click();await page.locator('.set-nav [data-v="'+section+'"][aria-current="true"]').waitFor();const column=page.locator('.set-col');await column.waitFor({state:'visible'});
const text=await column.innerText(),headings=await column.locator('h1,h2,h3').allTextContents();if(text.trim().length<40||!headings.some(x=>x.trim())||errors.length)throw Error('Rendered journey assertion failed');
await fs.writeFile(path.join(input.home,'step-'+count+'.json'),JSON.stringify({worker:input.worker,pid,journey,section,text:text.slice(0,12000),headings:headings.slice(0,20)}));const image=await page.screenshot({type:'jpeg',quality:60,fullPage:false,timeout:10000});if(image.length>2000000)throw Error('Screenshot size bound exceeded');await fs.writeFile(path.join(input.home,'step-'+count+++'.jpg'),image);
}}
identity.observed=true;identity.steps=count;
}catch(e){identity.problem=String(e.message).slice(0,2000);process.exitCode=1;}finally{clearTimeout(deadline);await app?.close();await fs.writeFile(path.join(input.home,'result.json'),JSON.stringify(identity));if(sandboxAuthorized)require('node:child_process').spawn('C:\\Windows\\System32\\shutdown.exe',['/s','/t','3'],{stdio:'ignore'});}})();
`;
