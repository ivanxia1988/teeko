import assert from 'node:assert/strict';
import test from 'node:test';
import {ClassroomToolScheduler} from '../lib/domain/classroom-tool-scheduler';
import type {ClassroomStateSnapshot} from '../lib/domain/classroom-context';

const state:ClassroomStateSnapshot={status:'active',context:{logicalSessionId:'lesson',courseVersion:'picnic:1',connectionEpoch:1,stateRevision:3,pageId:'page',activityId:'find-apple'}};
const request=(n=1)=>({type:'tool.requested',id:`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`,receivedAtMs:100,source:'teacher',callId:`call-${n}`,context:{...state.context},command:{name:'highlight_objects',arguments:{contextKey:'lesson:1:0',objectIds:['apple']}}});
function fixture(maxPending=3,maxSeen=5){let now=100;return {queue:new ClassroomToolScheduler({maxPending,maxSeen,now:()=>now}),at:(time:number)=>{now=time;}};}

test('queued work is copied, frozen and claimed in admission order',()=>{
 const {queue}=fixture();const first=request();assert.deepEqual(queue.enqueue(state,first,200),{accepted:true});
 first.command.arguments.objectIds[0]='banana';assert.deepEqual(queue.enqueue(state,request(2),200),{accepted:true});
 const taken=queue.take(state);assert.equal(taken.kind,'ready');if(taken.kind!=='ready')return;
 assert.deepEqual(taken.request.command.arguments,{contextKey:'lesson:1:0',objectIds:['apple']});assert(Object.isFrozen(taken.request));
 assert(Object.isFrozen(taken.request.context));assert(Object.isFrozen(taken.request.command.arguments));
 const next=queue.take(state);assert.equal(next.kind,'ready');if(next.kind==='ready')assert.equal(next.request.callId,'call-2');
 assert.equal(queue.size,0);assert.deepEqual(queue.take(state),{kind:'empty'});
});

test('pending capacity rejects new work without displacing admitted work',()=>{
 const {queue}=fixture(1);queue.enqueue(state,request(),200);
 assert.deepEqual(queue.enqueue(state,request(2),200),{accepted:false,reason:'queue_full'});assert.equal(queue.size,1);
 queue.take(state);assert.deepEqual(queue.enqueue(state,request(2),200),{accepted:true});
});

test('deduplication covers both call ID and request ID before and after dispatch',()=>{
 const {queue}=fixture();const original=request();queue.enqueue(state,original,200);
 assert.deepEqual(queue.enqueue(state,{...request(2),callId:original.callId},200),{accepted:false,reason:'duplicate'});
 queue.take(state);assert.deepEqual(queue.enqueue(state,{...request(2),id:original.id},200),{accepted:false,reason:'duplicate'});
});

test('deduplication memory is bounded without evicting old request tombstones',()=>{
 const {queue}=fixture(1,2);for(const n of [1,2]){assert(queue.enqueue(state,request(n),200).accepted);queue.take(state);}
 assert.deepEqual(queue.enqueue(state,request(3),200),{accepted:false,reason:'seen_limit'});
 assert.deepEqual(queue.enqueue(state,request(),200),{accepted:false,reason:'duplicate'});
});

test('deadline is exclusive and expired work is discarded without dispatch',()=>{
 const {queue,at}=fixture();queue.enqueue(state,request(),200);queue.enqueue(state,request(2),201);at(200);
 const expired=queue.take(state);assert.equal(expired.kind,'discarded');if(expired.kind==='discarded')assert.equal(expired.reason,'expired');
 assert.equal(queue.take(state).kind,'ready');assert.deepEqual(queue.enqueue(state,request(),300),{accepted:false,reason:'duplicate'});
});

test('invalid deadlines and future receipts cannot reserve queue space',()=>{
 const {queue}=fixture();
 for(const deadline of [NaN,Infinity,-1,100,100.5,Number.MAX_SAFE_INTEGER+1])assert.deepEqual(queue.enqueue(state,request(),deadline),{accepted:false,reason:'invalid_deadline'});
 assert.deepEqual(queue.enqueue(state,{...request(),receivedAtMs:101},200),{accepted:false,reason:'invalid_deadline'});
 assert.equal(queue.size,0);
});

test('a request already expired on admission is rejected',()=>{
 const {queue,at}=fixture();at(201);assert.deepEqual(queue.enqueue(state,request(),200),{accepted:false,reason:'expired'});assert.equal(queue.size,0);
});

for(const [key,value,reason] of [
 ['logicalSessionId','other','session_mismatch'],['courseVersion','picnic:2','course_version_mismatch'],
 ['connectionEpoch',2,'connection_epoch_mismatch'],['stateRevision',4,'stale_revision'],['stateRevision',2,'future_revision'],
 ['pageId','other','page_mismatch'],['activityId','other','activity_mismatch'],
] as const)test(`dispatch checks current ${key} (${reason})`,()=>{
 const {queue}=fixture();queue.enqueue(state,request(),200);
 const taken=queue.take({...state,context:{...state.context,[key]:value}});assert.equal(taken.kind,'discarded');
 if(taken.kind==='discarded')assert.equal(taken.reason,reason);
});

test('paused, ending and ended states refuse dispatch and admission',()=>{
 for(const status of ['paused','ending','ended'] as const){const {queue}=fixture();queue.enqueue(state,request(),200);
  const taken=queue.take({...state,status});assert.equal(taken.kind,'discarded');if(taken.kind==='discarded')assert.equal(taken.reason,'not_active');
  assert.deepEqual(queue.enqueue({...state,status},request(2),200),{accepted:false,reason:'not_active'});
 }
});

test('malformed state or request never reaches the queue',()=>{
 const {queue}=fixture();assert.deepEqual(queue.enqueue(null,request(),200),{accepted:false,reason:'invalid_state'});
 assert.deepEqual(queue.enqueue(state,{...request(),priority:99},200),{accepted:false,reason:'invalid_request'});
 assert.equal(queue.size,0);
});

test('cancellation releases pending payloads and retains duplicate protection',()=>{
 const {queue}=fixture();queue.enqueue(state,request(),200);queue.enqueue(state,request(2),200);
 assert.deepEqual(queue.cancelPending().map(item=>item.callId),['call-1','call-2']);assert.equal(queue.size,0);
 assert.deepEqual(queue.enqueue(state,request(),200),{accepted:false,reason:'duplicate'});
 assert.deepEqual(queue.enqueue(state,request(3),200),{accepted:true});
});

test('close is irreversible, idempotent and discards queued work',()=>{
 const {queue}=fixture();queue.enqueue(state,request(),200);assert.equal(queue.close().length,1);assert.equal(queue.close().length,0);
 assert.equal(queue.size,0);assert.deepEqual(queue.take(state),{kind:'empty'});
 assert.deepEqual(queue.enqueue(state,request(2),200),{accepted:false,reason:'closed'});
});

test('invalid or backwards clocks fail closed',()=>{
 for(const time of [NaN,Infinity,-1,99,100.5]){const {queue,at}=fixture();queue.enqueue(state,request(),200);at(time);
  const taken=queue.take(state);assert.equal(taken.kind,'discarded');if(taken.kind==='discarded')assert.equal(taken.reason,'invalid_time');
 }
 const {queue,at}=fixture();at(NaN);assert.deepEqual(queue.enqueue(state,request(),200),{accepted:false,reason:'invalid_time'});
});

test('invalid capacity configuration is rejected',()=>{
 for(const [maxPending,maxSeen] of [[0,5],[1.5,5],[3,2],[1,Infinity]])assert.throws(()=>new ClassroomToolScheduler({maxPending,maxSeen,now:()=>100}),RangeError);
});
