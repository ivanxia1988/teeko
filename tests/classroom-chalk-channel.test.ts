import test from 'node:test';
import assert from 'node:assert/strict';
import {ClassroomChalkServerChannel,ClassroomChalkClientChannel} from '../lib/classroom-chalk-channel';
import type {ClassroomChalkWriting} from '../lib/domain/classroom-chalk';
const state=()=>({status:'active',context:{logicalSessionId:'lesson',courseVersion:'picnic:2',connectionEpoch:1,stateRevision:3,pageId:'page',activityId:'speak'}});
const writing=(n=1):ClassroomChalkWriting=>({type:'chalk.write',id:`0000000${n}-0000-4000-8000-000000000001`,context:state().context,receivedAtMs:10000,expiresAtMs:18000,text:'I like apples.'});
function setup(){
 let serverNow=10000,clientNow=1000000,current=state();const toBrowser:unknown[]=[],toServer:unknown[]=[],shown:(ClassroomChalkWriting|null)[]=[];
 const server=new ClassroomChalkServerChannel({current:()=>current,now:()=>serverNow,send:message=>{toBrowser.push(message);return true;}});
 const client=new ClassroomChalkClientChannel({current:()=>current,now:()=>clientNow,send:message=>{toServer.push(message);return true;},onWriting:value=>shown.push(value)});
 return {server,client,toBrowser,toServer,shown,setServer:(n:number)=>serverNow=n,setClient:(n:number)=>clientNow=n,setCurrent:(s:typeof current)=>current=s};
}
test('chalk handshake projects a conservative deadline without sharing absolute clocks',async()=>{
 const h=setup();try{
  const result=h.server.offer(writing());assert.equal(h.client.receive(h.toBrowser.shift()),true);assert.equal(h.shown.length,0);
  h.setServer(10100);h.setClient(1000100);assert.equal(h.server.receive(h.toServer.shift()),true);assert.equal(h.client.receive(h.toBrowser.shift()),true);
  const shown=h.shown.at(-1)!;assert.equal(shown.expiresAtMs,1007900);assert.equal(shown.expiresAtMs-shown.receivedAtMs,8000);
  assert.equal(h.client.displayed(shown.id),true);assert.equal(h.server.receive(h.toServer.shift()),true);assert.equal(await result,'displayed');assert.equal(h.client.displayed(shown.id),false);
 }finally{h.server.close();h.client.close();}
});
test('server ignores a displayed receipt before commit, wrong IDs and duplicate ready',async()=>{
 const h=setup();try{const result=h.server.offer(writing());assert.equal(h.server.receive({type:'chalk.displayed',id:writing().id}),false);assert.equal(h.server.receive({type:'chalk.ready',id:writing(2).id}),false);
  assert(h.client.receive(h.toBrowser.shift()));const ready=h.toServer.shift();assert(h.server.receive(ready));assert.equal(h.server.receive(ready),false);h.server.cancel();assert.equal(await result,'unavailable');
 }finally{h.server.close();h.client.close();}
});
test('handshake timeout clears the proposal and rejects late receipts',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const h=setup();try{const result=h.server.offer(writing());h.setServer(11000);t.mock.timers.tick(1000);assert.equal(await result,'unavailable');assert.equal(h.server.receive({type:'chalk.ready',id:writing().id}),false);assert.equal((h.toBrowser.at(-1) as {type:string}).type,'chalk.clear');}
 finally{h.server.close();h.client.close();t.mock.timers.reset();}
});
test('server rejects an overdue ready even when the timeout callback has not run',async()=>{
 const h=setup();try{const result=h.server.offer(writing());h.setServer(11000);assert.equal(h.server.receive({type:'chalk.ready',id:writing().id}),false);assert.equal(await result,'unavailable');}
 finally{h.server.close();h.client.close();}
});
test('server keeps the original expiry after both ready and display receipts',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const h=setup();try{const result=h.server.offer(writing());h.client.receive(h.toBrowser.shift());h.server.receive(h.toServer.shift());h.client.receive(h.toBrowser.shift());h.client.displayed(writing().id);h.server.receive(h.toServer.shift());assert.equal(await result,'displayed');h.setServer(18000);t.mock.timers.tick(8000);assert.equal((h.toBrowser.at(-1) as {type:string}).type,'chalk.clear');assert.equal(h.server.receive({type:'chalk.displayed',id:writing().id}),false);}
 finally{h.server.close();h.client.close();t.mock.timers.reset();}
});
for(const key of ['logicalSessionId','courseVersion','connectionEpoch','stateRevision','pageId','activityId'] as const)test(`chalk cannot finish after changing ${key}`,async()=>{
 const h=setup();try{const result=h.server.offer(writing());h.client.receive(h.toBrowser.shift());const current=state();h.setCurrent({...current,context:{...current.context,[key]:typeof current.context[key]==='number'?99:'other'}});h.server.contextChanged();h.client.contextChanged();assert.equal(await result,'unavailable');assert.equal(h.server.receive(h.toServer.shift()),false);assert.equal(h.shown.at(-1)??null,null);}
 finally{h.server.close();h.client.close();}
});
test('client rejects malformed, obsolete, replayed and overlong commits without rendering',async()=>{
 const h=setup();try{const result=h.server.offer(writing());const offer=h.toBrowser.shift();assert.equal(h.client.receive({...offer as object,score:100}),false);assert(h.client.receive(offer));assert.equal(h.client.receive(offer),false);h.server.receive(h.toServer.shift());const commit=h.toBrowser.shift();assert.equal(h.client.receive({...commit as object,remainingMs:20001}),false);h.setClient(1001001);assert.equal(h.client.receive(commit),false);assert.equal(h.shown.at(-1)??null,null);h.server.cancel();assert.equal(await result,'unavailable');}
 finally{h.server.close();h.client.close();}
});
test('cancel and replacement never allow an old commit or receipt to borrow a new proposal',async()=>{
 const h=setup();try{const old=h.server.offer(writing());h.client.receive(h.toBrowser.shift());h.server.receive(h.toServer.shift());const oldCommit=h.toBrowser.shift();const fresh=h.server.offer(writing(2));assert.equal(await old,'unavailable');h.client.receive(h.toBrowser.shift());h.client.receive(h.toBrowser.shift());assert.equal(h.client.receive(oldCommit),false);assert.equal(h.server.receive({type:'chalk.displayed',id:writing().id}),false);h.server.cancel();assert.equal(await fresh,'unavailable');}
 finally{h.server.close();h.client.close();}
});
test('client scope invalidation and close clear active writing irreversibly',async()=>{
 const h=setup();try{const result=h.server.offer(writing());h.client.receive(h.toBrowser.shift());h.server.receive(h.toServer.shift());h.client.receive(h.toBrowser.shift());assert(h.shown.at(-1));h.setCurrent({...state(),status:'paused'});h.client.contextChanged();assert.equal(h.shown.at(-1),null);h.setCurrent(state());assert.equal(h.client.displayed(writing().id),false);h.server.close();assert.equal(await result,'unavailable');h.client.close();assert.equal(h.client.receive({type:'chalk.commit',id:writing().id,remainingMs:8000}),false);}
 finally{h.server.close();h.client.close();}
});
