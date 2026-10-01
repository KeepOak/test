import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
const chat = await readFile(new URL("../public/app/chat/chat.js", import.meta.url), "utf8");
const openSource = chat.slice(chat.indexOf("export async function openConversation("), chat.indexOf("/* What the engine last said")).replace("export ", "");
const waitingSource = chat.slice(chat.indexOf("async function loadWaiting("), chat.indexOf("/* A line starting with /"));
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return {promise,resolve,reject}; };
for (const phase of ["session", "policy", "extras"]) for (const failure of [false, true]) {
  test(`UI-032 late ${phase} ${failure ? "error" : "success"} never restores private conversation state`, async () => {
    const gate=deferred(), entered=deferred(), C={seat:0}, S={view:"chat"}, toasts=[], renders=[];
    let current=true;
    const context={C,S,$:()=>({classList:{remove(){}}}),openLine(){},leaveHelper(){},openMark:()=>"mark",
      toast:error=>toasts.push(error),renderNow:()=>renders.push(1),
      api:async path=>{
        if ((phase === "session" && path.startsWith("sessions/")) || (phase === "policy" && path === "policy")) { entered.resolve(); return gate.promise; }
        return path === "policy" ? {waiting:[]} : {messages:[{content:"private"}],project:"source-project"};
      },
      loadExtras:async (id,fresh)=>{ if(phase === "extras"){ entered.resolve(); await gate.promise.catch(()=>{}); assert.equal(fresh(),false); } },
    };
    runInNewContext(waitingSource+openSource+"\nglobalThis.open = openConversation;",context);
    const pending=context.open("created",()=>current);
    await entered.promise;
    current=false;
    Object.assign(C,{messages:[{content:"current"}],project:"current-project",waiting:["current"]});
    const before=renders.length;
    if(failure)gate.reject(new Error("private error"));else gate.resolve({messages:[{content:"old private"}],project:"old-project",waiting:["old"]});
    assert.equal(await pending,false);
    assert.deepEqual(C.messages,[{content:"current"}]);assert.equal(C.project,"current-project");assert.deepEqual(C.waiting,["current"]);
    assert.deepEqual(toasts,[]);assert.equal(renders.length,before);
  });
}
const messages=await readFile(new URL("../public/app/chat/messages.js",import.meta.url),"utf8");
const flags=await readFile(new URL("../public/app/chat/flag.js",import.meta.url),"utf8");
function functionSource(source,name){const at=source.indexOf(`async function ${name}(`),end=source.indexOf("\n}",at)+2;return source.slice(at,end);}
for(const name of ["loadPins","loadQueue","loadRoom","loadSpend","loadFlags"])for(const failure of [false,true]){
  test(`UI-032 revoked opening ${name} ${failure?"error":"success"} cannot alter private caches or render`,async()=>{
    const gate=deferred(),entered=deferred(),M={sid:"created",pins:[],followUps:[],room:null,spend:null},F={list:[]},renders=[],errors=[];
    let current=true;
    const context={M,F,E:{profiles:{isOwner:true}},JSON,Date,dayCost:()=>1,render:()=>renders.push(1),toast:x=>errors.push(x),report:x=>errors.push(x),
      api:async()=>{entered.resolve();return gate.promise;}};
    const actual=functionSource(name==="loadFlags"?flags:messages,name);
    const fn=runInNewContext(`(${actual})`,context);
    const pending=name==="loadQueue"?fn("created",false,()=>current):["loadSpend","loadFlags"].includes(name)?fn(()=>current):fn("created",()=>current);
    await entered.promise;current=false;
    if(failure)gate.reject(new Error("old private error"));else gate.resolve({pins:["private"],followUps:["private"],flags:["private"],data:[{}]});
    await pending;
    assert.deepEqual(M,{sid:"created",pins:[],followUps:[],room:null,spend:null});assert.deepEqual(F,{list:[]});assert.deepEqual(errors,[]);assert.deepEqual(renders,[]);
  });
}
