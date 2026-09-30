import type { TestCopyReceipt } from "./self-development-test-copy.js";

export type DogfoodTarget = "web" | "desktop-copy";
/** Fixed bounded read-only navigation; never model-generated actions or arbitrary selectors. */
export const dogfoodPlan = ["general", "appearance", "usage", "self", "general"] as const;

const setup = `const fs=require('node:fs'),fsp=require('node:fs/promises'),path=require('node:path'),{spawn}=require('node:child_process'),{createHash}=require('node:crypto');
const id='dogfood-'+Date.now(),home='/work/data/'+id,workspace='/work/workspace/'+id,artifacts='/work/'+id;
const env={PATH:process.env.PATH,HOME:home,TMPDIR:'/tmp',XDG_CONFIG_HOME:home+'/config',XDG_CACHE_HOME:home+'/cache',BRANCH_DESKTOP_HOME:home+'/desktop',BRANCH_DATA_DIR:home+'/data',BRANCH_WORKSPACE:workspace,BRANCH_GATEWAY:'off',BRANCH_PORT:'38127'};
let browser,desktop,child,display,page,token='',log='',ended=false,origin='http://127.0.0.1:38127';
const identity={sourceSha:SOURCE_SHA,target:TARGET,nativeOwnerInstallUsed:false,observed:false};
async function digest(file){const h=createHash('sha256');for await(const chunk of fs.createReadStream(file))h.update(chunk);return h.digest('hex');}
async function startWeb(pw){child=spawn(process.execPath,['dist/cli.js','start'],{cwd:'/work/source',env,stdio:['ignore','pipe','pipe']});
child.once('exit',()=>{ended=true});child.stdout.on('data',d=>{log=(log+d.toString()).slice(-32768);token=/Local session token \\(paste into browser\\): ([A-Za-z0-9_-]+)/.exec(log)?.[1]||token;});child.stderr.on('data',()=>{});
for(let i=0;i<60&&!token;i++){if(ended)throw Error('Isolated engine exited');await new Promise(r=>setTimeout(r,500));}if(!token)throw Error('Isolated engine did not provide a session');
browser=await pw.chromium.launch({headless:true,args:['--no-sandbox']});page=await browser.newPage({serviceWorkers:'block'});await page.addInitScript(value=>sessionStorage.setItem('branch-token',value),token);}
async function startDesktop(pw){const executable='/work/source/release/Branch-Agent-linux-x64/branch-agent';
if(await fsp.realpath(executable)!==executable)throw Object.assign(Error('Held: prepare a plain isolated Linux packaged executable.'),{held:true});
identity.executableSha256=await digest(executable);
display=spawn('/usr/bin/Xvfb',[':99','-screen','0','1280x900x24','-nolisten','tcp'],{env,stdio:'ignore'});let displayError;display.on('error',e=>{displayError=e;});await new Promise(r=>setTimeout(r,500));if(displayError||display.exitCode!==null)throw Object.assign(Error('Held: prepare Xvfb in the isolated image.'),{held:true});
desktop=await pw._electron.launch({executablePath:executable,args:['--no-sandbox','--disable-gpu'],env:{...env,DISPLAY:':99'},timeout:30000});
const reported=await desktop.evaluate(async({app})=>{const fs=require('node:fs'),path=require('node:path');return {packaged:app.isPackaged,version:app.getVersion(),executable:process.execPath,platform:process.platform,build:JSON.parse(fs.readFileSync(path.join(app.getAppPath(),'dist/build-info.json'),'utf8')),appPath:app.getAppPath()};});
if(!reported.packaged||reported.platform!=='linux'||reported.executable!==executable||reported.build.commit!==SOURCE_SHA)throw Object.assign(Error('Held: packaged app identity does not match the isolated source commit'),{held:true});
if(reported.appPath!=='/work/source/release/Branch-Agent-linux-x64/resources/app.asar')throw Error('Packaged app resources escaped the isolated copy');
identity.package={version:reported.version,build:reported.build,executable:reported.executable,asarSha256:await digest(reported.appPath)};
page=await desktop.firstWindow({timeout:30000});await page.waitForURL(/^http:\\/\\/(localhost|127\\.0\\.0\\.1):[0-9]+\\//,{timeout:30000});origin=new URL(page.url()).origin;}
async function guard(){const reads=new Set(['state','profiles','projects','sessions','trunks','deployment','never-break','comfort','self-rules','settings-kit','settings-kit/history','policy','usage','usage/glance','usage/limits/settings','usage/by-trunk','evaluation/suites','evaluation/history','retention','history/snapshots','reply-flags','continuous-qa','self-development/merge','appearance']);
await page.routeWebSocket('**/*',socket=>socket.close());await page.route('**/*',route=>{const r=route.request(),u=new URL(r.url()),allowed=!u.pathname.startsWith('/api/')||reads.has(u.pathname.slice(5));return allowed&&u.origin===origin&&['GET','HEAD'].includes(r.method())&&!u.searchParams.has('fix')?route.continue():route.abort();});}
async function inspect(){const errors=[],steps=[];page.setDefaultTimeout(10000);page.setDefaultNavigationTimeout(20000);page.on('pageerror',e=>{if(errors.length<20)errors.push(e.message.slice(0,200));});
if(TARGET==='web')await page.goto(origin);await page.locator('#app #side').waitFor({timeout:20000});
await page.locator('#side [data-act="view"][data-v="settings"]').first().click();
for(const [index,name]of PLAN.entries()){await page.locator('.set-nav [data-act="setpage"][data-v="'+name+'"]').click();
await page.locator('.set-nav [data-act="setpage"][data-v="'+name+'"][aria-current="true"]').waitFor({timeout:20000});
const column=page.locator('.set-col');await column.waitFor({state:'visible',timeout:20000});const text=await column.innerText(),headings=await column.locator('h1,h2,h3').allTextContents();
if(text.trim().length<40||!headings.some(h=>h.trim()))throw Error(name+' did not render readable headings and content');
const state={index,page:name,headings:headings.slice(0,20),text:text.slice(0,12000),selected:true,visible:true};steps.push(state);
await fsp.writeFile(path.join(artifacts,'step-'+index+'.json'),JSON.stringify(state,null,2));
const screenshot=await page.screenshot({type:'jpeg',quality:60,fullPage:false,timeout:10000});if(screenshot.length>2000000)throw Error('Screenshot exceeds 2 MB artifact limit');await fsp.writeFile(path.join(artifacts,'step-'+index+'.jpg'),screenshot);
if(errors.length)throw Error('UI page errors: '+errors.join('; '));}
await fsp.writeFile(path.join(artifacts,'steps.json'),JSON.stringify({planned:PLAN,performed:steps.length,errors},null,2));identity.observed=true;}
`;

/** A desktop executable must already be provisioned inside this exact isolated copy. */
export function dogfoodProbe(copy: Pick<TestCopyReceipt, "sha">, target: DogfoodTarget = "web"): string {
  return `const SOURCE_SHA=${JSON.stringify(copy.sha)},TARGET=${JSON.stringify(target)},PLAN=${JSON.stringify(dogfoodPlan)};${setup}
(async()=>{try{await fsp.mkdir(home,{recursive:true});await fsp.mkdir(workspace,{recursive:true});await fsp.mkdir(artifacts,{recursive:true});
identity.sourcePackageVersion=JSON.parse(await fsp.readFile('/work/source/package.json','utf8')).version;
let pw;try{pw=require('playwright');}catch{throw Object.assign(Error('Held: prepare Playwright dependencies in the isolated copy.'),{held:true});}
try{if(TARGET==='desktop-copy')await startDesktop(pw);else await startWeb(pw);}catch(e){if(/executable|ENOENT|browserType.launch/i.test(String(e)))e.held=true;throw e;}
await guard();await inspect();console.log('QA completed '+PLAN.length+' bounded rendered-state navigation steps on '+TARGET+'; owner installation untouched.');
}catch(e){identity.problem=String(e.message).slice(0,2000);console.error(identity.problem);process.exitCode=e.held?75:1;}
finally{if(fs.existsSync(artifacts)){await fsp.writeFile(path.join(artifacts,'identity.json'),JSON.stringify(identity,null,2));console.log('QA identity/render artifacts: '+id);}await browser?.close();await desktop?.close();child?.kill('SIGTERM');display?.kill('SIGTERM');setTimeout(()=>{child?.kill('SIGKILL');display?.kill('SIGKILL');},2000).unref();}})();`;
}
