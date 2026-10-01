import test from "node:test";
import assert from "node:assert/strict";
import { fixture, on } from "./trunks-helpers.mjs";

test("UI-032 chosen conversation keeps the explicitly supplied project while canonical Trunk chat stays default", async t => {
  const {app}=await fixture(t);on(app,"conversations");
  const owner=app.runtime.owner;
  app.store.projects.save(owner,{id:"composer-project",name:"Composer project"});
  app.store.projects.save(owner,{id:"unrelated-project",name:"Unrelated project"});
  app.store.projects.setActive(owner,{active:"unrelated-project"});
  const trunk=app.trunks.create({name:"Fixture"});
  await app.trunks.introduced();
  const chosen=app.trunks.startConversation({trunkId:trunk.id,project:"composer-project"});
  assert.equal(app.store.sessionProject(chosen.sessionId),"composer-project");
  assert.equal(app.store.sessionProject(trunk.chatSessionId),"default");
  const defaultChoice=app.trunks.startConversation({trunkId:trunk.id});
  assert.equal(app.store.sessionProject(defaultChoice.sessionId),"default");
  const count=app.store.sqlite.prepare("SELECT count(*) AS n FROM tasks").get().n;
  assert.throws(()=>app.trunks.startConversation({trunkId:trunk.id,project:"deleted-project"}),/no longer exists/);
  assert.throws(()=>app.trunks.startConversation({trunkId:trunk.id,project:"../outside"}));
  assert.equal(app.store.sqlite.prepare("SELECT count(*) AS n FROM tasks").get().n,count,"invalid project writes no bootstrap task");
});
